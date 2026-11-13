#!/usr/bin/env python3
"""Build an attributed, dateline-safe display area and its inverse mask.

This is a cartographic display scope, not an assertion of legal jurisdiction.
Sources are pinned geoBoundaries/OSM snapshots. Network is opt-in and bounded.
Requires Python 3, numpy and Shapely >=2. No web/native component is modified.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from urllib.request import Request, urlopen

import numpy as np
import shapely
from shapely.affinity import translate
from shapely.geometry import GeometryCollection, MultiPolygon, Point, Polygon, box, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from route_catalog_inputs import load_route_catalogs

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'data/boundaries/raw'
OUT = ROOT / 'web/public/data'
QA = ROOT / 'data/boundaries'
COMMIT = '9469f09592ced973a3448cf66b6100b741b64c0d'
MERCATOR_LAT = 85.0511287798066
MASK_TILE_DEGREES = 15.0
CRIMEA_NAMES = {'Autonomous Republic of Crimea', 'Sevastopol'}
ATTRIBUTION = '© OpenStreetMap contributors · geoBoundaries (OpenStreetMap / Wambacher, 2017); display selection and simplification by Тропник'
SCOPE = 'Russia-first tourism display, including the existing Crimea destination'
SOURCE_SPEC = {
    'RUS': {'bytesLimit': 75000000, 'features': 83,
            'sha256': 'b86ab28823569a4ec881091b0c8608ae31194cb2b195943b8b34fbd56f492320'},
    'UKR': {'bytesLimit': 15000000, 'features': 27,
            'sha256': 'b2f9f4ad2e9be5888523219c0bb46a24332ead16b46305409098048fd361a2d6'},
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, obj, pretty=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, allow_nan=False,
                               indent=2 if pretty else None,
                               separators=None if pretty else (',', ':')) + '\n')


def load_source(iso: str, allow_download: bool):
    path = RAW / f'geoBoundaries-{iso}-ADM1.geojson'
    spec = SOURCE_SPEC[iso]
    record = RAW / f'{iso}-download.json'
    if not path.exists():
        if not allow_download:
            raise SystemExit(f'Missing {path}; run with --download-missing to fetch pinned public inputs.')
        url = f'https://github.com/wmgeolab/geoBoundaries/raw/{COMMIT}/releaseData/gbOpen/{iso}/ADM1/geoBoundaries-{iso}-ADM1.geojson'
        request = Request(url, headers={'User-Agent': 'Tropnik-boundary-builder/0.1 (bounded public dataset download)'})
        with urlopen(request, timeout=45) as response:
            body = response.read(spec['bytesLimit'] + 1)
            if len(body) > spec['bytesLimit']:
                raise RuntimeError('Download exceeded bounded budget; refusing source')
            parsed = json.loads(body)
            if len(parsed.get('features', [])) != spec['features']:
                raise RuntimeError('Unexpected feature count; refusing changed input')
            RAW.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            write_json(record, {'requestedUrl': url, 'resolvedUrl': response.url,
                                'retrievedAt': datetime.now(timezone.utc).isoformat(),
                                'status': response.status, 'bytes': len(body),
                                'sha256': digest(path), 'file': path.name,
                                'lastModified': response.headers.get('Last-Modified'),
                                'etag': response.headers.get('ETag')}, True)
    if 'sha256' in spec and digest(path) != spec['sha256']:
        raise RuntimeError(f'{iso} hash differs from reviewed pinned source')
    if record.exists() and digest(path) != json.loads(record.read_text())['sha256']:
        raise RuntimeError(f'{iso} raw file differs from its download record')
    data = json.loads(path.read_text())
    if len(data['features']) != spec['features']:
        raise RuntimeError(f'Unexpected {iso} feature count')
    return path, data, json.loads(record.read_text()) if record.exists() else None


def unwrap(geometry):
    return shapely.transform(geometry, lambda xy: np.column_stack(
        (np.where(xy[:, 0] < 0, xy[:, 0] + 360, xy[:, 0]), xy[:, 1])))


def polygons(geometry):
    if isinstance(geometry, Polygon):
        return [geometry] if not geometry.is_empty else []
    if isinstance(geometry, (MultiPolygon, GeometryCollection)):
        return [p for g in geometry.geoms for p in polygons(g)]
    return []


def polygonal(geometry):
    parts = [orient(p, sign=1.0) for p in polygons(geometry)]
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def canonical(geometry):
    west = geometry.intersection(box(0, -MERCATOR_LAT, 180, MERCATOR_LAT))
    east = geometry.intersection(box(180, -MERCATOR_LAT, 360, MERCATOR_LAT))
    return polygonal(unary_union([west, translate(east, xoff=-360)]))


def coordinates(geometry):
    return shapely.get_coordinates(geometry)


def rounded_mapping(geometry):
    def rounded(value):
        if isinstance(value, (tuple, list)):
            return [rounded(x) for x in value]
        return round(value, 7) if isinstance(value, float) else value
    obj = mapping(polygonal(geometry))
    obj['coordinates'] = rounded(obj['coordinates'])
    # Verify the actual serialized geometry, including rounding.
    result = shape(obj)
    if not result.is_valid:
        raise RuntimeError(f'Coordinate rounding invalidated output: {shapely.is_valid_reason(result)}')
    return obj


def feature_collection(geometries, role, longitude_domain):
    return {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'id': f'{role}-{i}',
         'properties': {'role': role, 'displayScope': SCOPE,
                        'longitudeDomain': longitude_domain,
                        'license': 'ODbL-1.0', 'legalBoundaryClaim': False,
                        'navigationReady': False},
         'geometry': rounded_mapping(g)}
        for i, g in enumerate(geometries)]}


def inverse_tiles(area, west, tile_degrees=MASK_TILE_DEGREES):
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download-missing', action='store_true')
    parser.add_argument('--simplify-degrees', type=float, default=0.008,
                        help='Topology-preserving display tolerance; Crimea/Sevastopol retain full source detail')
    args = parser.parse_args()
    if not 0 <= args.simplify_degrees <= 0.02:
        raise SystemExit('Display simplification must be between 0 and 0.02 degrees')

    inputs, features, records = [], [], []
    for iso in ['RUS', 'UKR']:
        path, data, record = load_source(iso, args.download_missing)
        chosen = data['features'] if iso == 'RUS' else [f for f in data['features']
                  if f['properties']['shapeName'] in CRIMEA_NAMES]
        if iso == 'UKR' and {f['properties']['shapeName'] for f in chosen} != CRIMEA_NAMES:
            raise RuntimeError('Missing named Crimea/Sevastopol input features')
        inputs.append({'isoOfSourceDataset': iso, 'path': str(path.relative_to(ROOT)),
                       'sha256': digest(path), 'bytes': path.stat().st_size,
                       'selectedFeatureCount': len(chosen),
                       'selectedFeatureNames': [f['properties']['shapeName'] for f in chosen],
                       'download': record})
        for f in chosen:
            g = shape(f['geometry'])
            if not g.is_valid:
                raise RuntimeError(f"Invalid input {f['properties']['shapeName']}: {shapely.is_valid_reason(g)}")
            features.append(unwrap(g))
            records.append(f['properties'])

    print('Dissolving 85 full-resolution source features...', flush=True)
    source_fingerprint = hashlib.sha256(json.dumps([i['sha256'] for i in inputs]).encode()).hexdigest()
    cache_path = QA / 'selected-area-source.wkb'
    cache_meta_path = QA / 'selected-area-source-cache.json'
    cache_meta = json.loads(cache_meta_path.read_text()) if cache_meta_path.exists() else {}
    if cache_path.exists() and cache_meta.get('sourceFingerprint') == source_fingerprint and cache_meta.get('sha256') == digest(cache_path):
        raw_area = shapely.from_wkb(cache_path.read_bytes())
    else:
        raw_area = polygonal(unary_union(features))
        QA.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(shapely.to_wkb(raw_area))
        write_json(cache_meta_path, {'sourceFingerprint': source_fingerprint, 'sha256': digest(cache_path)}, True)
    if not raw_area.is_valid:
        raise RuntimeError('Invalid dissolve result')
    # Cache a reviewable selected source, without the unrelated UKR features.
    crimea = polygonal(unary_union(features[-2:]))
    write_json(QA / 'crimea-source-selected.geojson', feature_collection([crimea], 'source-selection', '0..360'))
    # These two enclosed water holes are part of the tourism display, not a
    # legal-boundary change. Use their exact source rings; invent no coastline.
    source_holes = [Polygon(h) for p in polygons(raw_area) for h in p.interiors]
    filled_lakes, lake_records = [], []
    for name, xy in [('Lake Ladoga', (31.5, 60.8)), ('Lake Onega', (35.5, 61.8))]:
        matches = [h for h in source_holes if h.covers(Point(xy))]
        if len(matches) != 1:
            raise RuntimeError(f'Expected exactly one source water hole for {name}')
        filled_lakes.append(matches[0])
        lake_records.append({'name': name, 'sourceHoleBounds': list(matches[0].bounds),
                             'sourceRingVertices': len(coordinates(matches[0]))})
    display_source_area = polygonal(unary_union([raw_area, *filled_lakes]))

    # Protect full source boundaries near actual imported routes, so an
    # overview simplifier cannot cut coastal trails out of the application.
    catalog, catalog_input = load_route_catalogs(ROOT)
    detail_padding = 0.015
    windows = []
    for f in catalog:
        g = unwrap(shape(f['geometry']))
        x1, y1, x2, y2 = g.bounds
        if x2 - x1 >= 180:
            raise RuntimeError('Unexpected world-spanning route envelope')
        windows.append(box(x1 - detail_padding, y1 - detail_padding,
                           x2 + detail_padding, y2 + detail_padding))
    detail_windows = unary_union(windows)
    # Keep the small Crimea destination at full published source resolution;
    # simplify the much larger remainder for a bounded startup payload.
    russia_only = display_source_area.difference(crimea)
    coarse = russia_only.simplify(args.simplify_degrees, preserve_topology=True)
    area = polygonal(unary_union([coarse.difference(detail_windows),
                                  display_source_area.intersection(detail_windows), crimea]))
    area = shape(rounded_mapping(area))
    normal = canonical(area)
    display_masks = inverse_tiles(area, 0)
    normal_masks = inverse_tiles(normal, -180)
    assets = {
        'russia-display-area.geojson': feature_collection([area], 'selected-area', '0..360'),
        'russia-outside-mask.geojson': feature_collection(display_masks, 'outside-mask', '0..360'),
        'russia-canonical-area.geojson': feature_collection([normal], 'selected-area', '-180..180'),
        'russia-canonical-mask.geojson': feature_collection(normal_masks, 'outside-mask', '-180..180'),
    }
    for name, data in assets.items():
        write_json(OUT / name, data)
    # Reload serialized assets so tests cover actual shipped bytes.
    actual_area = unary_union([shape(f['geometry']) for f in assets['russia-display-area.geojson']['features']])
    actual_mask = unary_union([shape(f['geometry']) for f in assets['russia-outside-mask.geojson']['features']])
    actual_canonical = unary_union([shape(f['geometry']) for f in assets['russia-canonical-area.geojson']['features']])
    actual_canonical_mask = unary_union([shape(f['geometry']) for f in assets['russia-canonical-mask.geojson']['features']])

    shapely.prepare(display_source_area)
    shapely.prepare(actual_area)
    route_rows = []
    for f in catalog:
        points = coordinates(unwrap(shape(f['geometry'])))
        source_contains = shapely.intersects_xy(display_source_area, points[:, 0], points[:, 1])
        output_contains = shapely.intersects_xy(actual_area, points[:, 0], points[:, 1])
        outside_source = int((~source_contains).sum())
        row = {'id': f['properties']['id'], 'title': f['properties'].get('title'),
               'vertexCount': len(points), 'outsideDisplaySource': outside_source,
               'outsideRuntimeDisplay': int((~output_contains).sum()),
               'verticesIncorrectlyRemovedBySimplification': int((source_contains & ~output_contains).sum()),
               'whollyOutsideSelectedDisplaySource': outside_source == len(points)}
        if row['outsideRuntimeDisplay']:
            row['firstOutsideDisplayLngLat'] = points[np.flatnonzero(~output_contains)[0]].tolist()
        route_rows.append(row)
    excluded_ids = [r['id'] for r in route_rows if r['whollyOutsideSelectedDisplaySource']]
    removed_vertices = sum(r['verticesIncorrectlyRemovedBySimplification'] for r in route_rows)
    coverage_report = {
        'schemaVersion': 1, 'checkedAt': datetime.now(timezone.utc).isoformat(),
        'scope': 'All imported line vertices compared against selected historical source plus explicitly included inland water holes and against the runtime display mask. Not field, access or legal verification.',
        **catalog_input,
        'routeCount': len(route_rows), 'totalVertices': sum(r['vertexCount'] for r in route_rows),
        'excludedCatalogRouteIds': excluded_ids,
        'verticesIncorrectlyRemovedBySimplification': removed_vertices,
        'passed': removed_vertices == 0, 'routes': route_rows,
    }
    write_json(QA / 'catalog-mask-coverage.json', coverage_report, True)

    cases = [
        ('Kaliningrad', 20.5, 54.71, True),
        ('Moscow', 37.617, 55.755, True),
        ('Anadyr', 177.5167, 64.7333, True),
        ('Uelen west longitude', -169.8092, 66.1599, True),
        ('Wrangel west of dateline', 179.0, 71.2, True),
        ('Yalta', 34.1667, 44.5, True),
        ('Simferopol', 34.1, 44.95, True),
        ('Sevastopol', 33.53, 44.6, True),
        ('Kerch', 36.47, 45.35, True),
        ('Dzhankoi', 34.39, 45.71, True),
        ('Lake Ladoga display water', 31.5, 60.8, True),
        ('Lake Onega display water', 35.5, 61.8, True),
        ('Helsinki', 24.94, 60.17, False),
        ('Kyiv', 30.52, 50.45, False),
        ('Kherson', 32.62, 46.64, False),
        ('Tbilisi', 44.8, 41.71, False),
        ('Ulaanbaatar', 106.92, 47.92, False),
        ('Harbin', 126.63, 45.75, False),
        ('Anchorage', -149.9, 61.22, False),
    ]
    # Preserve an actual source Arctic island and both sides of Chukotka.
    for name, source in [
        ('Northernmost source island', max(polygons(raw_area), key=lambda p: p.bounds[3])),
        ('Chukotka east of dateline source interior', raw_area.intersection(box(180.1, 63, 191, 70))),
        ('Chukotka west of dateline source interior', raw_area.intersection(box(175, 63, 179.9, 70))),
    ]:
        point = source.representative_point()
        cases.append((name, point.x, point.y, True))
    tests = []
    for name, x, y, expected in cases:
        display_x = x + 360 if x < 0 else x
        normal_x = display_x - 360 if display_x > 180 else display_x
        p, q = Point(display_x, y), Point(normal_x, y)
        a, m = actual_area.covers(p), actual_mask.covers(p)
        ca, cm = actual_canonical.covers(q), actual_canonical_mask.covers(q)
        passed = a == ca == expected and m == cm == (not expected)
        tests.append({'name': name, 'inputLngLat': [x, y], 'expectedInside': expected,
                      'displayAreaContains': a, 'displayMaskContains': m,
                      'canonicalAreaContains': ca, 'canonicalMaskContains': cm, 'passed': passed})
    world = box(0, -MERCATOR_LAT, 360, MERCATOR_LAT)
    overlap = actual_area.intersection(actual_mask).area
    missing = world.symmetric_difference(unary_union([actual_area, actual_mask])).area
    normal_world = box(-180, -MERCATOR_LAT, 180, MERCATOR_LAT)
    normal_missing = normal_world.symmetric_difference(unary_union([actual_canonical, actual_canonical_mask])).area
    round_trip = actual_area.symmetric_difference(unary_union(polygons(unwrap(actual_canonical)))).area
    display_mask_bounds = [shape(f['geometry']).bounds for f in assets['russia-outside-mask.geojson']['features']]
    canonical_mask_bounds = [shape(f['geometry']).bounds for f in assets['russia-canonical-mask.geojson']['features']]
    all_mask_bounds = display_mask_bounds + canonical_mask_bounds
    max_mask_width = max(b[2] - b[0] for b in all_mask_bounds)
    max_mask_height = max(b[3] - b[1] for b in all_mask_bounds)
    validation = {
        'inputFeatures': len(features), 'sourceVertices': len(coordinates(raw_area)),
        'displayVertices': len(coordinates(actual_area)),
        'displayPolygons': len(polygons(actual_area)),
        'bounds': list(actual_area.bounds),
        'allShippedGeometriesValid': all(shape(f['geometry']).is_valid for a in assets.values() for f in a['features']),
        'areaMaskOverlapSquareDegrees': overlap, 'displayPlaneCoverageErrorSquareDegrees': missing,
        'canonicalPlaneCoverageErrorSquareDegrees': normal_missing,
        'canonicalRoundTripDifferenceSquareDegrees': round_trip,
        'maskPartitionDegrees': MASK_TILE_DEGREES,
        'displayMaskFeatures': len(display_mask_bounds), 'canonicalMaskFeatures': len(canonical_mask_bounds),
        'maxMaskFeatureWidthDegrees': max_mask_width, 'maxMaskFeatureHeightDegrees': max_mask_height,
        'simplificationSymmetricDifferenceSquareDegrees': display_source_area.symmetric_difference(area).area,
        'catalogRouteCount': len(route_rows),
        'catalogVerticesIncorrectlyRemovedBySimplification': removed_vertices,
        'pointCases': tests,
    }
    validation['passed'] = (all(t['passed'] for t in tests) and validation['allShippedGeometriesValid']
                             and max(overlap, missing, normal_missing, round_trip) < 0.0001
                             and max(max_mask_width, max_mask_height) <= MASK_TILE_DEGREES + 0.000001
                             and len(display_mask_bounds) > 100 and len(canonical_mask_bounds) > 100
                             and removed_vertices == 0)
    write_json(QA / 'russia-mask-checks.json', validation, True)
    if not validation['passed']:
        raise RuntimeError('Meaningful geographical/antimeridian checks failed; inspect data/boundaries/russia-mask-checks.json')

    built_at = datetime.now(timezone.utc).isoformat()
    minx, miny, maxx, maxy = [round(v, 7) for v in raw_area.bounds]
    provenance = {
        'schemaVersion': 1, 'builtAt': built_at, 'displayScope': SCOPE,
        'legalBoundaryClaim': False, 'navigationReady': False,
        'sourceYearRepresented': '2017', 'sourceDataUpdateDate': '2023-01-19',
        'sourceBuildDate': '2023-12-12', 'sourceCommit': COMMIT,
        'license': 'ODbL-1.0', 'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
        'additionalPublisherCredit': 'geoBoundaries (William & Mary geoLab)',
        'attribution': ATTRIBUTION,
        'sourceUrls': ['https://www.geoboundaries.org/api/current/gbOpen/RUS/ADM1/',
                       'https://www.geoboundaries.org/api/current/gbOpen/UKR/ADM1/',
                       'https://www.openstreetmap.org/copyright'],
        'sources': inputs,
        'selection': {'RUS': 'All 83 ADM1 features from pinned source',
                      'UKR': sorted(CRIMEA_NAMES), 'otherUKRFeaturesIncluded': False,
                      'rationale': 'Preserve existing Crimea tourism destination with source geometry; source ISO labels retained in provenance, not reassigned as legal status.'},
        'transformations': ['Unwrap negative longitudes by +360 for contiguous eastward display',
                            'Dissolve original full-resolution selected administrative geometries',
                            'Include the two exact source interior rings for Lake Ladoga and Lake Onega as inland display water',
                            f'Topology-preserving distant RUS display simplification: {args.simplify_degrees} degrees; Crimea/Sevastopol and areas near imported route envelopes retain full source detail',
                            'Round output coordinates to 7 decimal places',
                            'Clip at 180 degrees and shift eastern part by -360 for canonical GeoJSON',
                            f'Subtract selected area from Web Mercator plane in {MASK_TILE_DEGREES:g}-degree renderer-safe cells'],
        'simplificationToleranceDegrees': args.simplify_degrees,
        'fullSourceDetailExceptions': sorted(CRIMEA_NAMES),
        'inlandWaterDisplayInclusions': lake_records,
        'routeDetailPreservation': {**catalog_input,
                                    'policy': 'Full selected source geometry inside union of route envelopes padded by the stated angular amount',
                                    'envelopePaddingDegrees': detail_padding},
        'excludedCatalogRouteIds': excluded_ids,
        'routeCoverageReport': {'path': 'data/boundaries/catalog-mask-coverage.json',
                                'sha256': digest(QA / 'catalog-mask-coverage.json'),
                                'routeCount': len(route_rows),
                                'totalVertices': coverage_report['totalVertices'],
                                'verticesIncorrectlyRemovedBySimplification': removed_vertices},
        'nominalMaxNorthSouthSimplificationMeters': round(args.simplify_degrees * 111320, 2),
        'measurementAccuracyMeters': None,
        'fitBounds': [[minx, miny], [maxx, maxy]],
        'displayGeometryBounds': list(actual_area.bounds),
        'recommendedMaxBounds': [[minx - 2, max(-MERCATOR_LAT, miny - 2)],
                                 [maxx + 2, min(MERCATOR_LAT, maxy + 1.5)]],
        'boundsOrder': 'longitude,latitude; east may exceed180degrees',
        'displayLongitudeDomain': [0, 360], 'canonicalLongitudeDomain': [-180, 180],
        'mercatorLatitudeLimit': MERCATOR_LAT,
        'assets': {name: {'url': f'/data/{name}', 'bytes': (OUT / name).stat().st_size,
                          'sha256': digest(OUT / name), 'features': len(data['features'])}
                   for name, data in assets.items()},
        'validation': {'passed': True, 'pointCaseCount': len(tests),
                       'report': 'data/boundaries/russia-mask-checks.json',
                       'sha256': digest(QA / 'russia-mask-checks.json')},
        'limitations': [
            'Historical administrative display data, not an authoritative current legal boundary or permission to enter.',
            'Some administrative polygons include coastal water; this is not an extracted coastline.',
            'The Crimea tourism destination is a display selection; source dataset ISO attributes remain documented.',
            'Simplification tolerance is a processing parameter, not measured positional accuracy.',
            'Unwrapped GeoJSON is a renderer-specific display asset; use canonical files for interchange.',
            'maxBounds is rectangular; render the outside mask above basemap labels and ignore interactions outside the selected area.',
            'Draw mask fills without strokes; cell boundaries are technical partition edges.',
        ],
    }
    write_json(OUT / 'russia-boundaries-provenance.json', provenance, True)
    write_json(QA / 'manifest.json', provenance, True)
    (QA / 'ATTRIBUTION.txt').write_text(ATTRIBUTION + '\n'
        + 'ODbL 1.0: https://opendatacommons.org/licenses/odbl/1-0/\n'
        + 'OSM copyright: https://www.openstreetmap.org/copyright\n'
        + 'geoBoundaries: https://www.geoboundaries.org/\n'
        + 'Source representation year 2017; publisher build 2023-12-12. Modified selection/dissolve/simplification/longitude wrapping by Тропник.\n'
        + 'Display scope only. No current legal-boundary, surveyed-coastline or navigation claim.\n')
    print(json.dumps({'passed': True, 'fitBounds': provenance['fitBounds'],
                      'displayVertices': validation['displayVertices'],
                      'assets': provenance['assets']}, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
