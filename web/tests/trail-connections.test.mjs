import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildTrailConnectionIndex, readCatalogueInputs} from '../scripts/build-trail-connections.mjs';
import {closestSegmentPoints, coordinateKey, distanceMeters, getTrailConnections, getTrailEndpoints, normalizeTrailGeometry, planTrailSequence, preparePlanGeometry, resolvePlanGeometry, resolvePreparedPlanGeometry} from '../lib/trail-connections.ts';

const line = coordinates => ({type: 'LineString', coordinates});
const multi = coordinates => ({type: 'MultiLineString', coordinates});
const route = (id, geometry, extra = {}) => ({id, geometry, geometryUrl: `/data/${id}.geojson`, checkedAt: '2026-11-09', sha256: createHash('sha256').update(JSON.stringify(geometry)).digest('hex'), ...extra});
const close = (actual, expected, tolerance = .02) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
const nodeIdAt = (index, id, point) => `${id}@${index.routes[id].nodes.findIndex(node => coordinateKey([node[0], node[1]]) === coordinateKey(point))}`;
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const real = JSON.parse(await read('../lib/trail-connections.generated.json'));

function planTwo(index, a, b, start, finish, connection = getTrailConnections(index, a).find(value => value.otherTrailId === b).connection) {
  return planTrailSequence(index, {trailIds: [a, b], connectionIds: [connection.id], start: nodeIdAt(index, a, start), finish: nodeIdAt(index, b, finish)});
}

test('normalization preserves MultiLineString and invalid-position gaps without constructing connecting lines', () => {
  const value = {type: 'FeatureCollection', features: [{type: 'Feature', geometry: multi([
    [[0, 0], [0, 0], [.001, 0]], [[1, 1], [1.001, 1]], [[2, 2], [2.001, 2], [null, 2], [3, 3], [3.001, 3]],
  ])}]};
  const normalized = normalizeTrailGeometry(value);
  assert.equal(normalized.parts.length, 4);
  assert.equal(normalized.invalidPositions, 1);
  assert.ok(normalized.parts.every(part => part.length === 2));
  assert.deepEqual(normalizeTrailGeometry(line([[180, 0], [-180, -0], [-179, 0]])).parts, [[[180, 0], [-179, 0]]], 'numeric comparison retains the exact antimeridian and signed-zero equivalence of coordinate keys');
  const index = buildTrailConnectionIndex([route('a', value)]);
  assert.equal(index.routes.a.componentCount, 4);
  assert.equal(index.routes.a.invalidPositions, 1);
});

test('segment closest points detect real interior crossings and project nearby endpoints onto the line', () => {
  const cross = closestSegmentPoints([0, 0], [.002, 0], [.001, -.001], [.001, .001]);
  assert.equal(cross.gapM, 0); close(cross.a.t, .5, 1e-9); close(cross.b.t, .5, 1e-9);
  const nearby = closestSegmentPoints([0, 0], [.002, 0], [.001, .001], [.001, .002]);
  close(nearby.a.t, .5, 1e-9); assert.equal(nearby.b.t, 0);
  close(nearby.gapM, distanceMeters([.001, 0], [.001, .001]));
  assert.ok(nearby.gapM > 100 && nearby.gapM < 112);
});

test('reversed collinear geometry reports its actual common interval', () => {
  const result = closestSegmentPoints([0, 0], [.003, 0], [.002, 0], [.001, 0]);
  assert.ok(result.overlap); close(result.overlap.aFrom, 1 / 3, 1e-8); close(result.overlap.aTo, 2 / 3, 1e-8);
  close(result.overlap.bFrom, 1, 1e-8); close(result.overlap.bTo, 0, 1e-8);
  close(result.overlap.lengthM, distanceMeters([.001, 0], [.002, 0]));
});

test('a shared corridor becomes its two actual ends, not one candidate per common vertex', () => {
  const middle = Array.from({length: 21}, (_, i) => [i / 10000, 0]);
  const index = buildTrailConnectionIndex([route('a', line(middle)), route('b', line([...middle].reverse()))]);
  assert.equal(index.connections.length, 2);
  assert.ok(index.connections.every(connection => connection.kind === 'shared' && connection.sourceVertex));
  for (const connection of index.connections) close(connection.sharedLengthM, distanceMeters(middle[0], middle.at(-1)));
});

test('a nearby candidate measures the gap but never joins it into a composite track', () => {
  const a = line([[0, 0], [.002, 0]]), b = line([[.001, .001], [.001, .002]]);
  const index = buildTrailConnectionIndex([route('a', a), route('b', b)]);
  assert.equal(index.connections.length, 1);
  const connection = index.connections[0];
  assert.equal(connection.kind, 'nearby'); assert.equal(connection.sourceVertex, false);
  close(connection.gapM, 111.195);
  assert.equal(getTrailConnections(index, 'a', {maxGapM: 100}).length, 0);
  const plan = planTwo(index, 'a', 'b', [0, 0], [.001, .002]);
  assert.equal(plan.complete, false); assert.equal(plan.geometryContinuous, false);
  assert.equal(plan.gaps.length, 1); assert.equal(plan.gaps[0].kind, 'nearby');
  assert.ok(plan.issues.some(issue => issue.code === 'unverified_transfer'));
  const resolved = resolvePlanGeometry(index, plan, {a, b});
  assert.equal(resolved.segments.length, 2);
  assert.equal(resolved.features.length, 2);
  close(plan.knownDistanceM, 222.39);
});

test('a 2D crossing without a shared source vertex stays a review break even when gapM is zero', () => {
  const a = line([[0, 0], [.002, 0]]), b = line([[.001, -.001], [.001, .001]]);
  const index = buildTrailConnectionIndex([route('a', a), route('b', b)]);
  const plan = planTwo(index, 'a', 'b', [0, 0], [.001, .001]);
  assert.equal(index.connections[0].sourceVertex, false);
  assert.equal(plan.gaps[0].distanceM, 0);
  assert.equal(plan.complete, false);
  assert.ok(plan.issues.some(issue => issue.code === 'unverified_crossing'));
  assert.equal(resolvePlanGeometry(index, plan, {a, b}).segments.length, 2);
});

test('fractional joins discovered through other routes never weld unrelated parts of the same route', () => {
  const a = multi([[[40, 45], [40.25, 45]], [[40.125, 44.875], [40.125, 45.125]]]);
  const b = line([[39.875, 45], [40.125, 45], [40.375, 45]]);
  const c = line([[40.125, 44.75], [40.125, 45], [40.125, 45.25]]);
  const index = buildTrailConnectionIndex([route('a', a), route('b', b), route('c', c)], {nearbyMeters: 0});
  assert.equal(index.routes.a.componentCount, 2);
  const plan = planTrailSequence(index, {trailIds: ['a'], connectionIds: [], start: nodeIdAt(index, 'a', [40, 45]), finish: nodeIdAt(index, 'a', [40.125, 45.125])});
  assert.equal(plan.complete, false); assert.equal(plan.stages[0].connected, false);
  assert.ok(plan.issues.some(issue => issue.code === 'disconnected_stage'));
});

test('shared source vertices give geometric continuity while leaving walkability unverified', () => {
  const a = line([[0, 0], [.001, 0], [.002, 0]]), b = line([[.001, 0], [.001, .001]]);
  const index = buildTrailConnectionIndex([route('a', a, {accessStatus: 'restricted'}), route('b', b)]);
  const plan = planTwo(index, 'a', 'b', [0, 0], [.001, .001]);
  assert.equal(plan.complete, true); assert.equal(plan.reviewRequired, true);
  assert.equal(plan.geometryContinuous, true); assert.equal(plan.gaps.length, 0);
  assert.ok(plan.issues.some(issue => issue.code === 'access_restricted'));
  assert.equal(resolvePlanGeometry(index, plan, {a, b}).segments.length, 1);
});

test('duplicate and reversed source edges are deduplicated, but deliberate repeated walking is counted twice', () => {
  const a = multi([[[0, 0], [.001, 0], [.002, 0]], [[.002, 0], [.001, 0], [0, 0]]]);
  const b = line([[.002, 0], [.002, .001]]);
  const index = buildTrailConnectionIndex([route('a', a), route('b', b)]);
  close(index.routes.a.lengthM, 222.39);
  const join = index.connections[0];
  const plan = planTrailSequence(index, {trailIds: ['a', 'b', 'a'], connectionIds: [join.id, join.id], start: nodeIdAt(index, 'a', [0, 0]), finish: nodeIdAt(index, 'a', [0, 0])});
  close(plan.knownDistanceM, 444.78);
  assert.ok(plan.issues.some(issue => issue.code === 'empty_stage' && issue.trailId === 'b'));
  assert.ok(plan.stages[2].refs.every(ref => ref.from > ref.to));
  const resolved = resolvePlanGeometry(index, plan, {a, b});
  assert.equal(resolved.features.length, 2);
  assert.deepEqual(resolved.features[1].geometry.coordinates, [[.002, 0], [.001, 0], [0, 0]]);
});

test('a tiny gap inside one route remains disconnected and is excluded from known walked distance', () => {
  const geometry = multi([[[0, 0], [.001, 0]], [[.00105, 0], [.002, 0]]]);
  const index = buildTrailConnectionIndex([route('a', geometry)]);
  assert.equal(index.routes.a.componentCount, 2);
  const plan = planTrailSequence(index, {trailIds: ['a'], connectionIds: [], start: nodeIdAt(index, 'a', [0, 0]), finish: nodeIdAt(index, 'a', [.002, 0])});
  assert.equal(plan.complete, false); assert.equal(plan.stages[0].connected, false);
  assert.equal(plan.knownDistanceM, 0);
  assert.ok(plan.issues.some(issue => issue.code === 'disconnected_stage'));
  assert.equal(plan.gaps[0].kind, 'internal');
  assert.equal(resolvePlanGeometry(index, plan, {a: geometry}).segments.length, 0);
});

test('a loop offers real points and never treats start equals finish as a completed circuit', () => {
  const index = buildTrailConnectionIndex([route('a', line([[0, 0], [.001, 0], [.001, .001], [0, 0]]))]);
  const endpoints = getTrailEndpoints(index, 'a');
  assert.equal(endpoints.length, 2); assert.ok(endpoints.every(point => point.kind === 'loop'));
  const plan = planTrailSequence(index, {trailIds: ['a'], connectionIds: [], start: endpoints[0].id, finish: endpoints[0].id});
  assert.equal(plan.complete, false); assert.equal(plan.knownDistanceM, 0);
  assert.ok(plan.issues.some(issue => issue.code === 'empty_stage'));
});

test('ordered via points make an explicit out-and-back and count the same edge on both traversals', () => {
  const geometry = line([[0, 0], [.001, 0], [.002, 0]]);
  const index = buildTrailConnectionIndex([route('a', geometry)]);
  const start = nodeIdAt(index, 'a', [0, 0]), turn = nodeIdAt(index, 'a', [.002, 0]);
  const options = {trailIds: ['a'], connectionIds: [], start, finish: start, via: {0: [turn]}};
  const plan = planTrailSequence(index, options);
  assert.equal(plan.complete, true); close(plan.knownDistanceM, 444.78);
  assert.equal(plan.stages[0].refs.length, 2);
  assert.ok(plan.stages[0].refs[0].from < plan.stages[0].refs[0].to);
  assert.ok(plan.stages[0].refs[1].from > plan.stages[0].refs[1].to);
  assert.deepEqual(resolvePlanGeometry(index, plan, {a: geometry}).segments[0], [[0, 0], [.001, 0], [.002, 0], [.001, 0], [0, 0]]);
  options.via[0][0] = start;
  options.via[0].push(turn);
  assert.deepEqual(plan.via, {0: [turn]}, 'the calculation must retain the exact independent waypoint selection used for export binding');
  const noVia = planTrailSequence(index, {trailIds: ['a'], connectionIds: [], start, finish: turn});
  assert.deepEqual(noVia.via, {0: []}, 'empty waypoint lists are normalized per stage');
  const invalid = planTrailSequence(index, {trailIds: ['a'], connectionIds: [], start, finish: start, via: {0: ['other@0']}});
  assert.equal(invalid.complete, false); assert.ok(invalid.issues.some(issue => issue.code === 'invalid_via'));
});

test('antimeridian geometry uses short longitude differences for distance, intersections and the spatial index', () => {
  const a = line([[179.999, 0], [-179.999, 0]]), b = line([[-180, -.001], [-180, .001]]);
  const index = buildTrailConnectionIndex([route('a', a), route('b', b)]);
  close(index.routes.a.lengthM, 222.39);
  assert.equal(index.connections.length, 1); assert.equal(index.connections[0].gapM, 0);
  assert.equal(index.connections[0].kind, 'intersection');
});

test('the resolver rejects stale coordinates even if their count and endpoints still match', () => {
  const a = line([[0, 0], [.001, 0], [.002, 0]]), index = buildTrailConnectionIndex([route('a', a)]);
  const plan = planTrailSequence(index, {trailIds: ['a'], connectionIds: [], start: nodeIdAt(index, 'a', [0, 0]), finish: nodeIdAt(index, 'a', [.002, 0])});
  const stale = line([[0, 0], [.001, .001], [.002, 0]]);
  const result = resolvePlanGeometry(index, plan, {a: stale});
  assert.equal(result.segments.length, 0); assert.equal(result.features.length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'geometry_mismatch'));
  assert.equal(resolvePlanGeometry(index, {...plan, sourceDigest: 'old'}, {a}).issues[0].code, 'stale_plan');
});

test('prepared geometry is an independent snapshot and retains source and fingerprint gates across path edits', () => {
  const geometry = line([[0, 0], [.001, 0], [.002, 0]]), index = buildTrailConnectionIndex([route('a', geometry)]);
  const start = nodeIdAt(index, 'a', [0, 0]), finish = nodeIdAt(index, 'a', [.002, 0]);
  const options = {trailIds: ['a'], connectionIds: [], start, finish};
  const plan = planTrailSequence(index, options), prepared = preparePlanGeometry(index, {a: geometry});
  const forward = resolvePreparedPlanGeometry(index, plan, prepared);
  assert.deepEqual(forward, resolvePlanGeometry(index, plan, {a: geometry}));
  const reverse = planTrailSequence(index, {...options, start: finish, finish: start});
  assert.deepEqual(resolvePreparedPlanGeometry(index, reverse, prepared).segments[0], [...forward.segments[0]].reverse());

  geometry.coordinates[1][1] = .001;
  forward.segments[0][1][0] = 99;
  forward.features[0].geometry.coordinates[0][0] = 88;
  assert.deepEqual(resolvePreparedPlanGeometry(index, plan, prepared).segments[0], [[0, 0], [.001, 0], [.002, 0]], 'neither raw-source mutation nor returned-output mutation can poison the owned verified snapshot');
  for (const result of [resolvePlanGeometry(index, plan, {a: geometry}), resolvePreparedPlanGeometry(index, plan, preparePlanGeometry(index, {a: geometry}))]) {
    assert.equal(result.segments.length, 0);
    assert.equal(result.issues[0].code, 'geometry_mismatch', 'a retry with changed source coordinates must revalidate, including equal-length drift');
  }
  assert.equal(resolvePreparedPlanGeometry(index, {...plan, sourceDigest: 'old'}, prepared).issues[0].code, 'stale_plan');
  assert.equal(resolvePreparedPlanGeometry({...index, sourceDigest: 'new'}, {...plan, sourceDigest: 'new'}, prepared).issues[0].code, 'stale_plan');
  const changedRoute = {...index, routes: {...index.routes, a: {...index.routes.a, geometryFingerprint: 'changed'}}};
  assert.equal(resolvePreparedPlanGeometry(changedRoute, plan, prepared).issues[0].code, 'geometry_mismatch');
  assert.equal(resolvePreparedPlanGeometry(index, plan, {sourceDigest: index.sourceDigest}).issues[0].code, 'geometry_mismatch', 'a forged snapshot cannot bypass normalization and fingerprint verification');
});

test('the generated index matches every active geometry and its provenance, with no invented reference-card coordinates', async () => {
  const {trails, inputs} = await readCatalogueInputs();
  assert.equal(real.stats.catalogueRoutes, trails.length);
  assert.equal(real.stats.geometryRoutes, inputs.length);
  assert.equal(new Set(trails.map(trail => trail.id)).size, trails.length);
  assert.equal(new Set(inputs.map(input => input.id)).size, inputs.length);
  assert.deepEqual(new Set(inputs.map(input => input.id)), new Set(trails.filter(trail => trail.geometryUrl).map(trail => trail.id)));
  assert.deepEqual(new Set(Object.keys(real.routes)), new Set(inputs.map(input => input.id)));
  for (const input of inputs) {
    const indexed = real.routes[input.id];
    assert.equal(indexed.sha256, input.sha256); assert.equal(indexed.checkedAt, input.checkedAt);
    assert.equal(indexed.accessStatus, input.accessStatus || 'unknown');
    assert.equal(indexed.quality, 'reference_geometry');
    assert.ok(indexed.edges.every(edge => edge[2] > 0));
  }
  assert.equal(trails.filter(trail => !trail.geometryUrl).length, real.stats.missingGeometryRoutes);
  for (const connection of real.connections) {
    assert.ok(real.routes[connection.trailA].nodes[connection.a.node]);
    assert.ok(real.routes[connection.trailB].nodes[connection.b.node]);
    assert.equal(connection.reviewRequired, true);
    if (connection.kind === 'nearby') assert.ok(connection.gapM <= real.parameters.nearbyMeters);
  }
});

test('real Polya–Yastrebinoye to Yellow hike clips each route at the join and resolves ordered source geometry', async () => {
  const a = 'osm-relation-4509476', b = 'osm-relation-4509477';
  const plan = planTwo(real, a, b, [29.6918809, 61.1824994], [29.7082878, 61.1767617]);
  assert.equal(plan.complete, true); assert.equal(plan.reviewRequired, true);
  close(plan.stages[0].distanceM, 1945.477); close(plan.stages[1].distanceM, 1515.485);
  close(plan.knownDistanceM, 3460.962);
  assert.ok(real.routes[a].lengthM + real.routes[b].lengthM > plan.knownDistanceM + 800);
  const loaded = Object.fromEntries(await Promise.all([a, b].map(async id => [id, JSON.parse(await read('../public' + real.routes[id].geometryUrl))])));
  const resolved = resolvePlanGeometry(real, plan, loaded);
  assert.equal(resolved.issues.length, 0); assert.equal(resolved.segments.length, 1);
  assert.deepEqual(resolved.segments[0][0], [29.6918809, 61.1824994]);
  assert.deepEqual(resolved.segments[0].at(-1), [29.7082878, 61.1767617]);
  close(resolved.segments[0].slice(1).reduce((sum, point, i) => sum + distanceMeters(resolved.segments[0][i], point), 0), plan.knownDistanceM);
});

test('real Bzerpinsky source keeps its 8.75m break, and the grove overlap remains two corridor ends', () => {
  assert.equal(real.routes['kavkaz-8a'].componentCount, 2);
  const route = real.routes['kavkaz-8a'];
  const first = route.nodes.findIndex(node => node[2] === 0), second = route.nodes.findIndex(node => node[2] === 1);
  const plan = planTrailSequence(real, {trailIds: ['kavkaz-8a'], connectionIds: [], start: `kavkaz-8a@${first}`, finish: `kavkaz-8a@${second}`});
  assert.equal(plan.complete, false); assert.ok(plan.issues.some(issue => issue.code === 'disconnected_stage'));
  const corridor = real.connections.filter(connection => connection.trailA === 'kavkaz-16a' && connection.trailB === 'kavkaz-16b');
  assert.equal(corridor.length, 2);
  for (const connection of corridor) {assert.equal(connection.kind, 'shared'); close(connection.sharedLengthM, 453.648);}
  const one = real.routes['osm-relation-13523771'], two = real.routes['osm-relation-13523772'];
  close(one.lengthM, two.lengthM); close(one.lengthM, 3146.71, .1);
});
