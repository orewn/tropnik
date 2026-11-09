import test from 'node:test';
import assert from 'node:assert/strict';
import {readRouteGeometry,routeGeometryPositions,identifyRouteGeometry,RENDERED_TRAIL_ID} from '../lib/route-geometry.ts';

test('the rendered route ID travels with its feature batch without modifying source properties or vertices', () => {
  const line = {type:'LineString',coordinates:[[40,43],[41,44]]};
  const source = {type:'FeatureCollection',features:[{type:'Feature',geometry:line,properties:{name:'source',[RENDERED_TRAIL_ID]:'untrusted'}}]};
  const tagged = identifyRouteGeometry(source, 'route-a');
  assert.equal(tagged.features[0].properties[RENDERED_TRAIL_ID], 'route-a');
  assert.equal(tagged.features[0].geometry, line);
  assert.equal(tagged.features[0].properties.name, 'source');
  assert.equal(source.features[0].properties[RENDERED_TRAIL_ID], 'untrusted');
  assert.equal(identifyRouteGeometry(line, 'route-b').features[0].geometry, line);
  assert.equal(identifyRouteGeometry(source.features[0], 'route-c').features[0].properties[RENDERED_TRAIL_ID], 'route-c');
});

test('static and API routes share a typed geometry boundary without copying vertices', () => {
  const line = {type: 'LineString', coordinates: [[179, 65], [-179, 66]]};
  assert.equal(readRouteGeometry(line), line);
  assert.equal(readRouteGeometry({data: {geometry: line}}), line);
  const collection = {type: 'FeatureCollection', features: [{type: 'Feature', geometry: line, properties: {name: 'source'}}]};
  assert.equal(readRouteGeometry(collection), collection);
  assert.deepEqual(line.coordinates, [[179, 65], [-179, 66]]);
});

test('bounds traversal handles nullable features and geometry collections without per-vertex copies', () => {
  const start=[40, 43], finish=[41, 44];
  const data={type:'FeatureCollection',features:[{type:'Feature',properties:null,geometry:null},{type:'Feature',properties:{},geometry:{type:'GeometryCollection',geometries:[{type:'LineString',coordinates:[start,finish]}]}}]};
  const points=routeGeometryPositions(readRouteGeometry(data));
  assert.equal(points.length,2); assert.equal(points[0],start); assert.equal(points[1],finish);
});

test('malformed or cyclic geometry is rejected before reaching either renderer', () => {
  for (const value of [null, [], {}, {type: 'LineString', coordinates: [[NaN, 5], [1, 2]]}, {data: {geometry: {type: 'FeatureCollection', features: [null]}}}]) assert.throws(() => readRouteGeometry(value), /Invalid route geometry/);
  const circular = {type: 'GeometryCollection', geometries: []}; circular.geometries.push(circular);
  assert.throws(() => readRouteGeometry(circular), /Invalid route geometry/);
});
