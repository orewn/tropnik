import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {inRussiaCoverage, coveredRussiaBounds, russiaLongitude, displayGeoJSON} from '../public/maps/russia-viewport.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const area = read('../public/data/russia-display-area.geojson');
function* positions(value) {
  if (value.type === 'FeatureCollection') {for (const feature of value.features) yield* positions(feature);}
  else if (value.type === 'Feature') yield* positions(value.geometry);
  else if (value.type === 'GeometryCollection') {for (const geometry of value.geometries) yield* positions(geometry);}
  else {
    function* coordinates(values) {
      if (typeof values[0] === 'number') yield values;
      else for (const child of values) yield* coordinates(child);
    }
    yield* coordinates(value.coordinates);
  }
}

// Deliberately unindexed reference for differential checks of the optimization.
function referenceContains(lng, lat, value) {
  const x = russiaLongitude(lng);
  const ringContains = ring => {
    let crossing = false;
    for (let i = 0, previous = ring.length - 1; i < ring.length; previous = i++) {
      const a = ring[i], b = ring[previous];
      const cross = (x - a[0]) * (b[1] - a[1]) - (lat - a[1]) * (b[0] - a[0]);
      if (Math.abs(cross) < 1e-10 && x >= Math.min(a[0], b[0]) - 1e-10 && x <= Math.max(a[0], b[0]) + 1e-10
        && lat >= Math.min(a[1], b[1]) - 1e-10 && lat <= Math.max(a[1], b[1]) + 1e-10) return true;
      if ((a[1] > lat) !== (b[1] > lat) && x < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) crossing = !crossing;
    }
    return crossing;
  };
  const inside = geometry => {
    if (!geometry) return false;
    if (geometry.type === 'FeatureCollection') return geometry.features.some(inside);
    if (geometry.type === 'Feature') return inside(geometry.geometry);
    if (geometry.type === 'GeometryCollection') return geometry.geometries.some(inside);
    return (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [])
      .some(rings => ringContains(rings[0]) && !rings.slice(1).some(ringContains));
  };
  return inside(value);
}

test('latitude indexing preserves outer edges, hole edges and dateline world copies', () => {
  const area = {type: 'Polygon', coordinates: [
    [[170, 40], [190, 40], [190, 60], [170, 60], [170, 40]],
    [[175, 45], [185, 45], [185, 55], [175, 55], [175, 45]],
  ]};
  for (const [point, expected] of [
    [[170, 50], true], [[190, 60], true], [[180, 42], true], [[-180, 42], true],
    [[175, 50], false], [[180, 45], false], [[180, 50], false], [[191, 50], false], [[180, 61], false],
  ]) {
    for (const copy of [-360, 0, 360]) assert.equal(inRussiaCoverage(point[0] + copy, point[1], area), expected, `${point} + ${copy}`);
  }
});

test('indexed coverage agrees with the pinned fixtures and an unindexed edge reference', () => {
  for (const fixture of read('./fixtures/russia-checks.json').pointCases) {
    assert.equal(inRussiaCoverage(...fixture.inputLngLat, area), fixture.expectedInside, fixture.name);
  }
  const vertices = [...positions(area)], samples = [];
  for (let index = 0; index < vertices.length; index += 293) {
    const [x, y] = vertices[index];
    samples.push([x, y], [x + 1e-8, y - 1e-8], [x - 1e-8, y + 1e-8]);
  }
  let seed = 1729;
  const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32;};
  for (let index = 0; index < 200; index++) samples.push([18 + random() * 176, 40 + random() * 43]);
  for (const point of samples) assert.equal(inRussiaCoverage(...point, area), referenceContains(...point, area), String(point));
});

const extentOf = points => points.reduce((bounds, [x, y]) => bounds
  ? [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)] : [x, y, x, y], null);

test('camera bounds stay exact when outside extrema hide covered interior points and holes', () => {
  const area = {type: 'Polygon', coordinates: [
    [[170, 40], [190, 40], [190, 60], [170, 60], [170, 40]],
    [[175, 45], [185, 45], [185, 55], [175, 55], [175, 45]],
  ]};
  const points = [[160, 50], [180, 42], [180, 50], [180, 58], [200, 50], [170, 60], [-180, 40]];
  assert.deepEqual(coveredRussiaBounds(points, area), [170, 40, 180, 60]);
  assert.deepEqual(coveredRussiaBounds([...points].reverse(), area), [170, 40, 180, 60], 'input ordering cannot change the frame');
  assert.equal(coveredRussiaBounds([[180, 50], [180, 45], [160, 50]], area), null);
  assert.equal(coveredRussiaBounds([], area), null);
  assert.equal(coveredRussiaBounds([[NaN, 50], [180, Infinity]], area), null);
});

test('fast frames equal full covered-vertex bounds for every shipped source route', () => {
  let count = 0;
  for (const folder of ['routes', 'imported']) {
    for (const name of readdirSync(new URL(`../public/data/${folder}/`, import.meta.url)).filter(name => name.endsWith('.geojson'))) {
      const points = [...positions(displayGeoJSON(read(`../public/data/${folder}/${name}`)))];
      const complete = extentOf(points.filter(([lng, lat]) => inRussiaCoverage(lng, lat, area)));
      assert.deepEqual(coveredRussiaBounds(points, area), complete, `${folder}/${name}`);
      count++;
    }
  }
  assert.equal(count, 280, 'check the complete source geometry set, including the excluded route');
});

test('the densest shipped route retains every covered vertex when fitted', t => {
  const route = displayGeoJSON(read('../public/data/imported/osm-relation-18162201.geojson'));
  const points = [...positions(route)];
  assert.equal(points.length, 61185, 'the real route that previously blocked the UI is the regression input');
  const started = performance.now();
  const kept = points.filter(([lng, lat]) => inRussiaCoverage(lng, lat, area));
  assert.equal(kept.length, 61185, 'the original exact coverage pass retained all of these vertices');
  t.diagnostic(`Exact coverage of ${points.length} route vertices: ${(performance.now() - started).toFixed(1)} ms in Node; not a browser FPS measurement.`);
  const frameStarted = performance.now();
  const bounds = coveredRussiaBounds(points, area);
  const frameMs = performance.now() - frameStarted;
  assert.deepEqual(bounds, extentOf(kept));
  t.diagnostic(`Exact camera bounds for the same route: ${frameMs.toFixed(1)} ms in Node; rendered geometry is unchanged.`);
});
