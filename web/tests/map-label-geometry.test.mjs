import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {labelGeometryInCoverage} from '../public/maps/map-label-geometry.js';

const point = coordinates => ({type: 'Point', coordinates});
const line = coordinates => ({type: 'LineString', coordinates});
const rectangle = {type: 'Polygon', coordinates: [[[10, 50], [20, 50], [20, 60], [10, 60], [10, 50]]]};
const withHole = {type: 'Polygon', coordinates: [...rectangle.coordinates, [[14, 54], [16, 54], [16, 56], [14, 56], [14, 54]]]};
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const area = read('../public/data/russia-display-area.geojson');

test('source point labels follow the complete pinned RF fixtures and repeated worlds', () => {
  for (const fixture of read('./fixtures/russia-checks.json').pointCases) {
    for (const copy of [-720, -360, 0, 360, 720]) {
      const [longitude, latitude] = fixture.inputLngLat;
      assert.equal(labelGeometryInCoverage(point([longitude + copy, latitude]), area), fixture.expectedInside, `${fixture.name}, copy ${copy}`);
    }
  }
});

test('every component must be covered, preserving exact outer and hole boundary conventions', () => {
  assert.equal(labelGeometryInCoverage(point([10, 55]), withHole), true);
  assert.equal(labelGeometryInCoverage(point([14, 55]), withHole), false);
  assert.equal(labelGeometryInCoverage({type: 'MultiPoint', coordinates: [[11, 55], [19, 55]]}, withHole), true);
  assert.equal(labelGeometryInCoverage({type: 'MultiPoint', coordinates: [[11, 55], [15, 55]]}, withHole), false);
  assert.equal(labelGeometryInCoverage(line([[10, 51], [10, 59]]), withHole), true, 'complete outer boundary is covered');
  assert.equal(labelGeometryInCoverage(line([[11, 55], [19, 55]]), withHole), false, 'two covered endpoints do not make a hole crossing eligible');
  const tangentEnd = Math.atan(Math.sinh(2 * Math.asinh(Math.tan(56 * Math.PI / 180)) - Math.asinh(Math.tan(54 * Math.PI / 180)))) * 180 / Math.PI;
  assert.equal(labelGeometryInCoverage(line([[12, 54], [16, tangentEnd]]), withHole), false, 'touching one hole corner in the rendered plane also fails');
  assert.equal(labelGeometryInCoverage(line([[11, 55], [11, 57], [19, 57], [19, 55]]), withHole), true);
  assert.equal(labelGeometryInCoverage({type: 'MultiLineString', coordinates: [[[11, 51], [19, 51]], [[11, 55], [19, 55]]]}, withHole), false);
});

test('long segments cannot skip a narrow off-centre hole or a concave coastal bay', () => {
  const narrowHole = {type: 'Polygon', coordinates: [...rectangle.coordinates, [[11.5, 54], [11.500001, 54], [11.500001, 56], [11.5, 56], [11.5, 54]]]};
  const bay = {type: 'Polygon', coordinates: [[[10, 50], [20, 50], [20, 60], [11.6, 60], [11.6, 54], [11.5, 54], [11.5, 60], [10, 60], [10, 50]]]};
  for (const coverage of [narrowHole, bay]) {
    assert.equal(labelGeometryInCoverage(point([11, 55]), coverage), true);
    assert.equal(labelGeometryInCoverage(point([15, 55]), coverage), true, 'a single overall midpoint would miss the gap');
    assert.equal(labelGeometryInCoverage(point([19, 55]), coverage), true);
    assert.equal(labelGeometryInCoverage(line([[11, 55], [19, 55]]), coverage), false);
    assert.equal(labelGeometryInCoverage(line([[19, 55], [11, 55]]), coverage), false, 'direction cannot change eligibility');
  }
  assert.equal(labelGeometryInCoverage(line([[11, 53], [19, 53]]), bay), true);
});

test('long lines and sloped country edges use the renderer Mercator plane, not a latitude midpoint', () => {
  const midpointLatitude = 61.56829417944769;
  const coverage = {type: 'Polygon', coordinates: [
    [[10, 40], [50, 40], [50, 80], [10, 80], [10, 40]],
    [[29.9, midpointLatitude - .1], [30.1, midpointLatitude - .1], [30.1, midpointLatitude + .1], [29.9, midpointLatitude + .1], [29.9, midpointLatitude - .1]],
  ]};
  assert.equal(labelGeometryInCoverage(point([30, 60]), coverage), true, 'the linear-latitude midpoint misses the rendered crossing');
  assert.equal(labelGeometryInCoverage(point([30, midpointLatitude]), coverage), false);
  assert.equal(labelGeometryInCoverage(line([[20, 50], [40, 70]]), coverage), false, 'the actual straight Mercator segment crosses the hole');
  const sloped = {type: 'Polygon', coordinates: [[[20, 50], [40, 70], [40, 80], [20, 80], [20, 50]]]};
  assert.equal(labelGeometryInCoverage(point([30, 60.8]), sloped), false, 'an anchor above the latitude edge but below the rendered edge is still outside');
  assert.equal(labelGeometryInCoverage(point([30, 62]), sloped), true);
});

test('line coverage follows polygon union rather than a bounding box or one component', () => {
  const first = rectangle.coordinates;
  const overlap = [[[19, 50], [25, 50], [25, 60], [19, 60], [19, 50]]];
  const disjoint = [[[21, 50], [25, 50], [25, 60], [21, 60], [21, 50]]];
  assert.equal(labelGeometryInCoverage(line([[11, 55], [24, 55]]), {type: 'MultiPolygon', coordinates: [first, overlap]}), true);
  assert.equal(labelGeometryInCoverage(line([[11, 55], [24, 55]]), {type: 'MultiPolygon', coordinates: [first, disjoint]}), false);
  const collection = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: rectangle}]};
  assert.equal(labelGeometryInCoverage(line([[11, 51], [19, 59]]), collection), true);
});

test('antimeridian source segments stay continuous in the RF display world and respect holes', () => {
  const coverage = {type: 'Polygon', coordinates: [
    [[170, 40], [190, 40], [190, 60], [170, 60], [170, 40]],
    [[178, 47], [182, 47], [182, 53], [178, 53], [178, 47]],
  ]};
  for (const copy of [-360, 0, 360]) {
    assert.equal(labelGeometryInCoverage(line([[175 + copy, 45], [-175 + copy, 45]]), coverage), true);
    assert.equal(labelGeometryInCoverage(line([[175 + copy, 50], [-175 + copy, 50]]), coverage), false);
    assert.equal(labelGeometryInCoverage(point([-179 + copy, 45]), coverage), true);
  }
  assert.equal(labelGeometryInCoverage(line([[175, 45], [185, 45]]), coverage), true);
});

test('malformed/unknown geometry fails closed and coverage caches remain isolated and non-mutating', () => {
  for (const geometry of [null, {}, {type: 'Polygon', coordinates: rectangle.coordinates}, {type: 'GeometryCollection', geometries: [point([15, 55])]}, point([]), point([NaN, 55]), point([15, Infinity]), point([15, 95]), line([]), line([[15, 55]]), line([[15, 55], null]), line(Array(2)), {type: 'MultiPoint', coordinates: []}, {type: 'MultiPoint', coordinates: Array(2)}, {type: 'MultiLineString', coordinates: []}]) {
    assert.equal(labelGeometryInCoverage(geometry, rectangle), false);
  }
  assert.equal(labelGeometryInCoverage(point([15, 55]), null), false);
  const geometry = line([[11, 55], [19, 55]]);
  const original = JSON.stringify({geometry, rectangle, withHole});
  for (let repeat = 0; repeat < 4; repeat++) {
    assert.equal(labelGeometryInCoverage(geometry, rectangle), true);
    assert.equal(labelGeometryInCoverage(geometry, withHole), false);
  }
  assert.equal(JSON.stringify({geometry, rectangle, withHole}), original);
});

test('malformed coverage fails closed once instead of throwing from an index constructor', () => {
  const invalidAreas = [
    {}, {type: 'FeatureCollection'}, {type: 'FeatureCollection', features: null}, {type: 'FeatureCollection', features: [null]},
    {type: 'Polygon'}, {type: 'Polygon', coordinates: null}, {type: 'Polygon', coordinates: [...rectangle.coordinates, null]},
    {type: 'Polygon', coordinates: [[[10, 50], [20, 50], [20, 60], [10, 60]]]},
    {type: 'Polygon', coordinates: [[[10, 50], [20, 50], [20, NaN], [10, 50]]]},
    {type: 'MultiPolygon', coordinates: [null]}, {type: 'GeometryCollection', geometries: null},
  ];
  const cycle = {type: 'Feature'}; cycle.geometry = cycle; invalidAreas.push(cycle);
  for (const invalid of invalidAreas) for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal(labelGeometryInCoverage(point([15, 55]), invalid), false);
    assert.equal(labelGeometryInCoverage(line([[11, 51], [19, 59]]), invalid), false);
  }
});
