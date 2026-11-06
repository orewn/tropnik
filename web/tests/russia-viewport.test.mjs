import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {
  RUSSIA_BOUNDS, RUSSIA_AREA_URL, RUSSIA_MASK_URL,
  russiaLongitude, russiaPadding, russiaCamera, constrainRussiaCamera,
  displayGeoJSON, inRussiaCoverage, leafletRussiaMask,
} from '../public/maps/russia-viewport.js';

const read = relative => readFileSync(new URL(relative, import.meta.url));
const json = relative => JSON.parse(read(relative));
const area = json('../public/data/russia-display-area.geojson');
const mask = json('../public/data/russia-outside-mask.geojson');
const canonicalArea = json('../public/data/russia-canonical-area.geojson');
const provenance = json('../public/data/russia-boundaries-provenance.json');
const geographicalChecks = json('./fixtures/russia-checks.json');
const routeCoverage = json('./fixtures/russia-route-coverage.json');
const fixtures = geographicalChecks.pointCases;
const areaFromCanonical = displayGeoJSON(canonicalArea);
const repeatedMask = leafletRussiaMask(mask);

const close = (actual, expected, tolerance = 1e-8, message = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, received ${actual}`);

function* positions(value) {
  if (value.type === 'FeatureCollection') {
    for (const feature of value.features) yield* positions(feature);
  } else if (value.type === 'Feature') yield* positions(value.geometry);
  else if (value.type === 'GeometryCollection') {
    for (const geometry of value.geometries) yield* positions(geometry);
  } else {
    function* visit(coordinates) {
      if (typeof coordinates[0] === 'number') yield coordinates;
      else for (const child of coordinates) yield* visit(child);
    }
    yield* visit(value.coordinates);
  }
}
const actualPositions = [...positions(area)];

test('the viewport and tests use the exact pinned runtime coverage, including the Arctic', () => {
  assert.deepEqual(RUSSIA_BOUNDS, provenance.fitBounds);
  assert.equal(RUSSIA_AREA_URL, '/data/russia-display-area.geojson');
  assert.equal(RUSSIA_MASK_URL, '/data/russia-outside-mask.geojson');
  assert.equal(fixtures.length, 22, 'keep the independently generated geographical fixture set');
  assert.equal(createHash('sha256').update(read('./fixtures/russia-checks.json')).digest('hex'),
    provenance.validation.sha256, 'the standalone fixture must be the exact reviewed geographical report');
  for (const name of ['russia-display-area.geojson', 'russia-outside-mask.geojson', 'russia-canonical-area.geojson']) {
    const bytes = read(`../public/data/${name}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.assets[name].sha256, name);
  }
  assert.ok(RUSSIA_BOUNDS[0][0] < 20, 'the former 24° overview cut off Kaliningrad');
  assert.ok(RUSSIA_BOUNDS[1][1] > 81.85, 'the former 77° overview cut off the Arctic islands');
  assert.ok(RUSSIA_BOUNDS[1][0] > 191, 'include the eastern source extent beyond the antimeridian');
});

for (const fixture of fixtures) {
  test(`real geographical fixture: ${fixture.name}`, () => {
    const [lng, lat] = fixture.inputLngLat;
    assert.equal(inRussiaCoverage(lng, lat, area), fixture.expectedInside, 'display area');
    assert.equal(inRussiaCoverage(lng, lat, areaFromCanonical), fixture.expectedInside,
      'the canonical area remains equivalent when prepared for display');
    assert.equal(inRussiaCoverage(lng, lat, mask), !fixture.expectedInside, 'inverse mask');
    assert.equal(inRussiaCoverage(lng, lat, repeatedMask), !fixture.expectedInside,
      'Leaflet world copies must preserve the same transparent interior');
  });
}

test('Chukotka uses one continuous longitude interval and survives wrapped camera/GeoJSON inputs', () => {
  close(russiaLongitude(-169), 191);
  close(russiaLongitude(191), 191);
  close(russiaLongitude(-180), 180);
  close(russiaLongitude(180), 180);
  for (const [lng, lat] of [[-169.8092, 66.1599], [-169, 65.8], [182.6018457244424, 66.59362445]]) {
    const expected = inRussiaCoverage(lng, lat, area);
    for (const copy of [-720, -360, 0, 360, 720]) {
      assert.equal(inRussiaCoverage(lng + copy, lat, area), expected,
        `same geographical point in world copy ${copy}`);
    }
  }
  // Nearest 105° is deliberately not a general 0…360 normalizer. It is valid
  // for this selected 19…191° scope; adjacent Leaflet masks cover western water.
  close(russiaLongitude(-20), -20);
  assert.equal(inRussiaCoverage(-20, 50, area), false);
  assert.equal(inRussiaCoverage(-20, 50, repeatedMask), true, 'Atlantic outside the selected scope is masked');
  for (const [lng] of actualPositions) {
    assert.ok(lng >= 0 && lng <= 360, 'the display asset has its declared longitude convention');
    close(russiaLongitude(lng), lng, 1e-8, 'all actual selected longitudes are stable around 105°');
  }
  assert.ok([...positions(canonicalArea)].some(([lng]) => lng < -169), 'real negative-longitude Chukotka exists');
  assert.ok([...positions(areaFromCanonical)].every(([lng]) => lng >= 19 && lng <= 192),
    'canonical-to-display conversion must not put Chukotka on the opposite side');
});

// Independent EPSG:3857 metre projection, not a copy of the helper's
// normalized asinh-based fit calculation. These are mathematical viewport
// tests, not claims about a physical device or a WebGL/native implementation.
const radius = 6378137;
function mercatorMetres([lng, lat]) {
  return [radius * lng * Math.PI / 180,
    radius * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
}
function screenPosition(coordinate, camera, width, height, tileSize) {
  const point = mercatorMetres(coordinate), center = mercatorMetres(camera.center);
  const pixelsPerMetre = tileSize * 2 ** camera.zoom / (2 * Math.PI * radius);
  return [width / 2 + (point[0] - center[0]) * pixelsPerMetre,
    height / 2 - (point[1] - center[1]) * pixelsPerMetre];
}

const views = [
  {name: 'portrait 390×844, 420px panel', width: 390, height: 844, covered: 420},
  {name: 'desktop 1100×780', width: 1100, height: 780, covered: 0},
  {name: 'compact 320×640, 320px panel', width: 320, height: 640, covered: 320},
  {name: 'compact 320×640, 420px panel', width: 320, height: 640, covered: 420},
];
const [[west, south], [east, north]] = provenance.fitBounds;
const sourceCorners = [[west, south], [west, north], [east, south], [east, north]];
for (const view of views) for (const tileSize of [256, 512]) {
  test(`all source bounds and runtime geometry fit above the panel: ${view.name}, ${tileSize}px world tile`, () => {
    const padding = russiaPadding(view.width, view.height, view.covered);
    const camera = russiaCamera(view.width, view.height, padding, tileSize);
    assert.equal(camera.bearing, 0);
    assert.equal(camera.pitch, 0);
    assert.ok([...camera.center, camera.zoom].every(Number.isFinite));
    const rectangle = {left: padding.left, top: padding.top,
      right: view.width - padding.right, bottom: view.height - padding.bottom};
    assert.ok(rectangle.bottom <= view.height - view.covered - 24,
      'the fitted country must finish above the actual bottom panel and its gutter');
    const projected = [...actualPositions, ...sourceCorners].map(p => screenPosition(p, camera, view.width, view.height, tileSize));
    const xs = projected.map(p => p[0]), ys = projected.map(p => p[1]);
    assert.ok(Math.min(...xs) >= rectangle.left - 1e-6, 'western extent, including Kaliningrad');
    assert.ok(Math.max(...xs) <= rectangle.right + 1e-6, 'eastern extent, including Chukotka');
    assert.ok(Math.min(...ys) >= rectangle.top - 1e-6, 'northern Arctic extent');
    assert.ok(Math.max(...ys) <= rectangle.bottom + 1e-6, 'southern extent stays above the panel');
    const constrained = constrainRussiaCamera(...camera.center, camera.zoom, camera);
    close(constrained.center[0], camera.center[0]);
    close(constrained.center[1], camera.center[1]);
    close(constrained.zoom, camera.zoom, 1e-10, 'padding-aware overview must not be clamped away');
  });
}

test('camera constraints preserve eastern Chukotka, bound drags and keep the current overview floor', () => {
  const overview = russiaCamera(390, 844, russiaPadding(390, 844, 420));
  const eastward = constrainRussiaCamera(-169.8092, 66.1599, 12, overview);
  close(eastward.center[0], 190.1908);
  close(eastward.center[1], 66.1599);
  assert.equal(eastward.zoom, 12);
  const low = constrainRussiaCamera(-60, -89, -30, overview);
  const high = constrainRussiaCamera(250, 89, 40, overview);
  assert.ok(low.center[0] >= west && high.center[0] <= east);
  assert.ok(low.center[1] >= Math.min(south, overview.center[1]) - 1e-9);
  assert.ok(high.center[1] <= Math.max(north, overview.center[1]) + 1e-9);
  close(low.zoom, overview.zoom);
  assert.equal(high.zoom, 18);
  const detailDrag = constrainRussiaCamera(100, -89, overview.zoom + 3, overview);
  assert.ok(detailDrag.center[1] >= south - 1e-9,
    'the offset allowed by the covered overview must not allow distant blank panning when zoomed in');
  for (const input of [[NaN, 60], [40, NaN], [Infinity, 60]])
    assert.equal(inRussiaCoverage(...input, area), false, 'invalid location must not qualify as coverage');
});

test('the public excluded route and committed coverage report match the runtime provenance', () => {
  assert.deepEqual(provenance.excludedCatalogRouteIds, ['osm-relation-14407325']);
  // The full catalogue lives outside the standalone web repository. Its actual
  // bytes are checked by tools/map-package/russia-catalog-integration.test.mjs.
  assert.equal(routeCoverage.catalogSha256, provenance.routeDetailPreservation.catalogSha256,
    'the committed report and protected-detail provenance refer to the same catalogue');
  assert.equal(createHash('sha256').update(read('./fixtures/russia-route-coverage.json')).digest('hex'),
    provenance.routeCoverageReport.sha256, 'provenance must bind the reviewed coverage report');
  assert.equal(routeCoverage.routeCount, 278);
  assert.equal(routeCoverage.totalVertices, 223073);
  assert.equal(routeCoverage.verticesIncorrectlyRemovedBySimplification, 0);
  assert.ok(routeCoverage.routes.every(row => row.verticesIncorrectlyRemovedBySimplification === 0));
  const imported = json('../public/data/imported/osm-relation-14407325.geojson');
  const coordinates = [...positions(imported)];
  assert.equal(coordinates.length, 92);
  assert.ok(coordinates.every(([lng, lat]) => !inRussiaCoverage(lng, lat, area)),
    'every actual vertex of the excluded relation lies outside the selected display area');
  const reported = routeCoverage.routes.find(row => row.id === 'osm-relation-14407325');
  assert.equal(reported.whollyOutsideSelectedDisplaySource, true);
  assert.equal(reported.outsideDisplaySource, coordinates.length);
});
