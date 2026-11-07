#!/usr/bin/env python3
"""Apply the final reviewed Tropnik map/Android fixes before regenerating assets.

The script is intentionally strict and idempotent: every edit has a known source
anchor and fails loudly when the branch no longer matches the reviewed state.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str, label: str) -> bool:
    target = ROOT / path
    text = target.read_text()
    if new in text:
        return False
    if old not in text:
        raise RuntimeError(f"{path}: missing patch anchor: {label}")
    target.write_text(text.replace(old, new, 1))
    return True


def append_once(path: str, marker: str, addition: str) -> bool:
    target = ROOT / path
    text = target.read_text()
    if marker in text:
        return False
    target.write_text(text.rstrip() + "\n\n" + addition.strip() + "\n")
    return True


changed = []

def patch(path, old, new, label):
    if replace_once(path, old, new, label):
        changed.append(path)


# ---------------------------------------------------------------------------
# Russia mask: split the inverse plane into small renderer-safe cells. Giant
# polygons with a 46k-vertex Russia hole can produce long Earcut triangles on
# some GPUs. 15-degree cells preserve the same exact union while bounding every
# triangulation problem to a small rectangle.
# ---------------------------------------------------------------------------
mask = "tools/map-package/build-russia-mask.py"
patch(mask,
"MERCATOR_LAT = 85.0511287798066\n",
"MERCATOR_LAT = 85.0511287798066\nMASK_TILE_DEGREES = 15.0\n",
"mask tile constant")
patch(mask,
'''def inverse_strips(area, west):
    # <=90-degree strips avoid a single world-spanning exterior ring.
    # Fill without strokes: strip edges are technical partitions, not borders.
    return [polygonal(box(x, -MERCATOR_LAT, x + 90, MERCATOR_LAT).difference(area))
            for x in range(west, west + 360, 90)]
''',
'''def inverse_tiles(area, west, tile_degrees=MASK_TILE_DEGREES):
    """Partition the inverse mask into small, renderer-safe cells.

    The union remains the complete Web-Mercator plane minus the selected area,
    but no feature has a world-spanning exterior with a complex country hole.
    This prevents long triangulation wedges without changing geographic scope.
    """
    if not 5 <= tile_degrees <= 30 or 360 % tile_degrees:
        raise ValueError('Mask tile size must evenly divide 360 and stay between 5 and 30 degrees')
    result = []
    east_limit = west + 360
    x = float(west)
    while x < east_limit - 1e-9:
        east = min(x + tile_degrees, east_limit)
        y = -MERCATOR_LAT
        while y < MERCATOR_LAT - 1e-9:
            north = min(y + tile_degrees, MERCATOR_LAT)
            outside = polygonal(box(x, y, east, north).difference(area))
            if not outside.is_empty:
                result.append(outside)
            y = north
        x = east
    return result
''',
"renderer-safe inverse mask")
patch(mask,
"    display_masks = inverse_strips(area, 0)\n    normal_masks = inverse_strips(normal, -180)\n",
"    display_masks = inverse_tiles(area, 0)\n    normal_masks = inverse_tiles(normal, -180)\n",
"tiled mask calls")
patch(mask,
"    round_trip = actual_area.symmetric_difference(unary_union(polygons(unwrap(actual_canonical)))).area\n    validation = {\n",
'''    round_trip = actual_area.symmetric_difference(unary_union(polygons(unwrap(actual_canonical)))).area
    display_mask_bounds = [shape(f['geometry']).bounds for f in assets['russia-outside-mask.geojson']['features']]
    canonical_mask_bounds = [shape(f['geometry']).bounds for f in assets['russia-canonical-mask.geojson']['features']]
    all_mask_bounds = display_mask_bounds + canonical_mask_bounds
    max_mask_width = max(b[2] - b[0] for b in all_mask_bounds)
    max_mask_height = max(b[3] - b[1] for b in all_mask_bounds)
    validation = {
''',
"mask partition validation measurements")
patch(mask,
"        'canonicalRoundTripDifferenceSquareDegrees': round_trip,\n        'simplificationSymmetricDifferenceSquareDegrees': display_source_area.symmetric_difference(area).area,\n",
"        'canonicalRoundTripDifferenceSquareDegrees': round_trip,\n        'maskPartitionDegrees': MASK_TILE_DEGREES,\n        'displayMaskFeatures': len(display_mask_bounds), 'canonicalMaskFeatures': len(canonical_mask_bounds),\n        'maxMaskFeatureWidthDegrees': max_mask_width, 'maxMaskFeatureHeightDegrees': max_mask_height,\n        'simplificationSymmetricDifferenceSquareDegrees': display_source_area.symmetric_difference(area).area,\n",
"mask validation report fields")
patch(mask,
"                             and max(overlap, missing, normal_missing, round_trip) < 0.0001\n                             and removed_vertices == 0)\n",
"                             and max(overlap, missing, normal_missing, round_trip) < 0.0001\n                             and max(max_mask_width, max_mask_height) <= MASK_TILE_DEGREES + 0.000001\n                             and len(display_mask_bounds) > 100 and len(canonical_mask_bounds) > 100\n                             and removed_vertices == 0)\n",
"mask partition validation gate")
patch(mask,
"                            'Subtract selected area from Web Mercator plane in 90 degree strips'],\n",
"                            f'Subtract selected area from Web Mercator plane in {MASK_TILE_DEGREES:g}-degree renderer-safe cells'],\n",
"mask provenance")
patch(mask,
"            'Draw mask fills without strokes; strip boundaries are technical partition edges.',\n",
"            'Draw mask fills without strokes; cell boundaries are technical partition edges.',\n",
"mask limitation wording")

# ---------------------------------------------------------------------------
# Web map: transient vector/DEM tile errors must not cover a usable map with a
# persistent banner. Critical Russia geometry still fails visibly.
# ---------------------------------------------------------------------------
patch("web/components/Atlas.tsx",
"     else setStatus('Не все детали карты загрузились. Сохранённый обзор доступен.');\n",
"     else { console.warn('Non-critical map detail failed; keeping the rendered overview.'); setTilesLoading(false); }\n",
"non-critical WebGL tile errors")
patch("web/components/Atlas2D.tsx",
"   detail.on('tileerror',()=>{if(attached()){setTilesLoading(false);setStatus('Часть карты не загрузилась. Проверьте подключение.');}});\n",
"   detail.on('tileerror',()=>{if(attached())setTilesLoading(false);});\n",
"non-critical canvas tile errors")

# Force fresh mask/style bytes for existing installations and keep the
# canonical WebGL mask available offline as well.
patch("web/public/sw.js", "const VERSION='tropnik-shell-v11';", "const VERSION='tropnik-shell-v12';", "service worker cache generation")
patch("web/public/sw.js",
"'/data/russia-outside-mask.geojson','/data/russia-boundaries-provenance.json'",
"'/data/russia-outside-mask.geojson','/data/russia-canonical-mask.geojson','/data/russia-boundaries-provenance.json'",
"canonical mask offline shell")

# ---------------------------------------------------------------------------
# Android MapLibre: Compose effects can execute under a test dispatcher. Every
# native map interaction is explicitly returned to the Android UI looper.
# ---------------------------------------------------------------------------
android = "android/app/src/main/java/ru/tropa/app/ui/TropaMap.kt"
patch(android,
'''        nativeMap.setStyle(Style.Builder().fromJson(prepared)) {
            if (styleGeneration == generation) {
                styleLoading = false
                error = null
                styleRevision = generation
            }
        }''',
'''        withContext(Dispatchers.Main.immediate) {
            nativeMap.setStyle(Style.Builder().fromJson(prepared)) {
                if (styleGeneration == generation) {
                    styleLoading = false
                    error = null
                    styleRevision = generation
                }
            }
        }''',
"Android style on UI looper")
patch(android,
'''    LaunchedEffect(eco, mapView) { mapView.setMaximumFps(if (eco) 30 else 60) }
    LaunchedEffect(relief, map, styleRevision) {
        for (layer in listOf("pilot-hillshade", "russia-overview-relief", "online-hillshade")) {
            map?.style?.getLayer(layer)?.setProperties(PropertyFactory.visibility(if (relief) Property.VISIBLE else Property.NONE))
        }
    }''',
'''    LaunchedEffect(eco, mapView) {
        withContext(Dispatchers.Main.immediate) { mapView.setMaximumFps(if (eco) 30 else 60) }
    }
    LaunchedEffect(relief, map, styleRevision) {
        withContext(Dispatchers.Main.immediate) {
            for (layer in listOf("pilot-hillshade", "russia-overview-relief", "online-hillshade")) {
                map?.style?.getLayer(layer)?.setProperties(PropertyFactory.visibility(if (relief) Property.VISIBLE else Property.NONE))
            }
        }
    }''',
"Android FPS and relief on UI looper")
patch(android,
'''        val area = displayArea ?: return@LaunchedEffect
        nativeMap.setLatLngBoundsForCameraTarget(area.cameraBounds)
        scopeNotice = null''',
'''        val area = displayArea ?: return@LaunchedEffect
        withContext(Dispatchers.Main.immediate) {
        nativeMap.setLatLngBoundsForCameraTarget(area.cameraBounds)
        scopeNotice = null''',
"open Android focus UI section")
patch(android,
'''        } else nativeMap.animateCamera(CameraUpdateFactory.newLatLngBounds(area.fitBounds, 24), 500)
    }

    LaunchedEffect(map, styleRevision, displayArea, position) {''',
'''        } else nativeMap.animateCamera(CameraUpdateFactory.newLatLngBounds(area.fitBounds, 24), 500)
        }
    }

    LaunchedEffect(map, styleRevision, displayArea, position) {''',
"close Android focus UI section")
patch(android,
'''        val area = displayArea ?: return@LaunchedEffect
        val ready = position as? PositionState.Ready''',
'''        val area = displayArea ?: return@LaunchedEffect
        withContext(Dispatchers.Main.immediate) {
        val ready = position as? PositionState.Ready''',
"open Android position UI section")
patch(android,
'''            nativeMap.animateCamera(CameraUpdateFactory.newLatLngZoom(LatLng(ready.fix.latitude, area.cameraLongitude(ready.fix.longitude)), 11.0), 500)
        }
    }

    Box(modifier.background(Palette.Water)) {''',
'''            nativeMap.animateCamera(CameraUpdateFactory.newLatLngZoom(LatLng(ready.fix.latitude, area.cameraLongitude(ready.fix.longitude)), 11.0), 500)
        }
        }
    }

    Box(modifier.background(Palette.Water)) {''',
"close Android position UI section")
patch(android,
"TrailIconButton(onClick = { map?.animateCamera(CameraUpdateFactory.zoomIn(), 180) })",
"TrailIconButton(onClick = { mapView.post { map?.animateCamera(CameraUpdateFactory.zoomIn(), 180) } })",
"Android zoom in UI callback")
patch(android,
"TrailIconButton(onClick = { map?.animateCamera(CameraUpdateFactory.zoomOut(), 180) })",
"TrailIconButton(onClick = { mapView.post { map?.animateCamera(CameraUpdateFactory.zoomOut(), 180) } })",
"Android zoom out UI callback")
patch(android,
'''                    map?.let { current -> current.animateCamera(CameraUpdateFactory.newCameraPosition(CameraPosition.Builder(current.cameraPosition).tilt(if (tilted) 0.0 else 40.0).build()), 300) }''',
'''                    mapView.post { map?.let { current -> current.animateCamera(CameraUpdateFactory.newCameraPosition(CameraPosition.Builder(current.cameraPosition).tilt(if (tilted) 0.0 else 40.0).build()), 300) } }''',
"Android tilt UI callback")

# Run real device scenarios on PRs, not only after a broken change reaches main.
patch(".github/workflows/android.yml",
"    if: ${{ (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && inputs.run_instrumentation) }}\n",
"    if: ${{ github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && inputs.run_instrumentation) }}\n",
"Android PR instrumentation gate")

# ---------------------------------------------------------------------------
# Regression tests for the exact defects reported in review.
# ---------------------------------------------------------------------------
patch("web/tests/map-direction-layout.test.mjs",
"import {groupMapDirections,directionGroupsOverlap,directionMarkerContent,directionCountLabel,updateDirectionButtons} from '../lib/map-direction-layout.ts';",
"import {groupMapDirections,directionGroupsOverlap,directionMarkerContent,directionCountLabel,directionLabelShift,directionLabelWidth,updateDirectionButtons} from '../lib/map-direction-layout.ts';",
"direction layout test imports")
if append_once("web/tests/map-direction-layout.test.mjs", "edge clamp keeps every map label inside the visible atlas", r'''
test('edge clamp keeps every map label inside the visible atlas',()=>{
  assert.equal(directionLabelShift(-30,110,0,1000,18),48);
  assert.equal(directionLabelShift(920,1040,0,1000,18),-58);
  assert.equal(directionLabelShift(200,320,0,1000,18),0);
  assert.ok(directionLabelWidth('Петропавловск-Камчатский')<=168);
  assert.ok(directionLabelWidth('Алтай')>=84);
});
'''):
    changed.append("web/tests/map-direction-layout.test.mjs")

if append_once("web/tests/map-polish.test.mjs", "reported map wedges, clipped labels and false detail banner stay fixed", r'''
test('reported map wedges, clipped labels and false detail banner stay fixed',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const css=read('app/map-polish.css');
  const generator=read('scripts/create-map-style.mjs');
  const style=JSON.parse(read('public/maps/tropa-style.json'));
  const sw=read('public/sw.js');
  assert.match(atlas,/constrainDirectionLabels/);
  assert.match(canvas,/constrainDirectionLabels/);
  assert.doesNotMatch(atlas,/Не все детали карты загрузились/);
  assert.match(css,/white-space:normal/);
  assert.match(css,/--map-label-shift/);
  assert.match(generator,/russia-priority-city-label/);
  const maskIndex=style.layers.findIndex(layer=>layer.id==='russia-outside-mask');
  const priorityIndex=style.layers.findIndex(layer=>layer.id==='russia-priority-city-label');
  assert.ok(maskIndex>=0&&priorityIndex>maskIndex,'priority Russian labels redraw after the outside mask');
  assert.match(sw,/tropnik-shell-v12/);
  assert.match(sw,/russia-canonical-mask\.geojson/);
});
'''):
    changed.append("web/tests/map-polish.test.mjs")

partition_test = ROOT / "tools/map-package/test_russia_mask_partition.py"
partition_source = '''#!/usr/bin/env python3
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


def points(value):
    if isinstance(value, list):
        if len(value) >= 2 and isinstance(value[0], (int, float)) and isinstance(value[1], (int, float)):
            yield value[0], value[1]
        else:
            for item in value:
                yield from points(item)


class RussiaMaskPartitionTest(unittest.TestCase):
    def check_mask(self, name):
        data = json.loads((ROOT / 'web/public/data' / name).read_text())
        self.assertGreater(len(data['features']), 100)
        for feature in data['features']:
            coordinates = list(points(feature['geometry']['coordinates']))
            self.assertTrue(coordinates)
            xs = [point[0] for point in coordinates]
            ys = [point[1] for point in coordinates]
            self.assertLessEqual(max(xs) - min(xs), 15.000001, feature['id'])
            self.assertLessEqual(max(ys) - min(ys), 15.000001, feature['id'])

    def test_display_and_canonical_masks_are_renderer_safe(self):
        self.check_mask('russia-outside-mask.geojson')
        self.check_mask('russia-canonical-mask.geojson')
        report = json.loads((ROOT / 'data/boundaries/russia-mask-checks.json').read_text())
        self.assertTrue(report['passed'])
        self.assertEqual(report['maskPartitionDegrees'], 15.0)
        self.assertLessEqual(report['maxMaskFeatureWidthDegrees'], 15.000001)
        self.assertLessEqual(report['maxMaskFeatureHeightDegrees'], 15.000001)


if __name__ == '__main__':
    unittest.main()
'''
if not partition_test.exists() or partition_test.read_text() != partition_source:
    partition_test.write_text(partition_source)
    changed.append(str(partition_test.relative_to(ROOT)))

print({"changed": sorted(set(changed))})
