import test from 'node:test';
import assert from 'node:assert/strict';
import {coalesceMapFrame, publishMapCamera, resolveRenderedTrail} from '../lib/map-interaction.ts';
import {identifyRouteGeometry, RENDERED_TRAIL_ID} from '../lib/route-geometry.ts';
import {MAP_CONFIG, viewportRegionId, directionExpansionZoom} from '../lib/map-config.ts';
import {MapResourcePool} from '../lib/map-resource-pool.ts';

test('line clicks follow the visible geometry while a newer card fetches and while setData is pending', () => {
  const a = {id:'route-a'}, b = {id:'route-b'};
  const line = {type:'LineString',coordinates:[[40,43],[41,44]]};
  const batchA = identifyRouteGeometry(line, a.id), batchB = identifyRouteGeometry(line, b.id);
  const visibleId = batchA.features[0].properties[RENDERED_TRAIL_ID];
  assert.equal(resolveRenderedTrail(visibleId, a, [a,b]), a, 'B is selected but still fetching; A remains rendered');
  assert.equal(resolveRenderedTrail(visibleId, b, [a,b]), a, 'B was applied but the map worker still draws A');
  assert.equal(resolveRenderedTrail(batchB.features[0].properties[RENDERED_TRAIL_ID], b, [a,b]), b);
  assert.equal(resolveRenderedTrail(visibleId, b, [b]), undefined, 'an unavailable old card is never replaced with B');
  assert.equal(resolveRenderedTrail(undefined, b, [a,b]), undefined);
  assert.equal(resolveRenderedTrail('', undefined, []), undefined, 'clear/style disposal leaves no selectable route');
});

test('a resize or pointer burst performs one frame and can schedule the next', () => {
  const jobs = new Map(); let next = 0, calls = 0;
  const work = coalesceMapFrame(() => calls++, {request: fn => {jobs.set(++next, fn); return next;}, cancel: id => jobs.delete(id)});
  for (let i = 0; i < 100; i++) work.schedule();
  assert.equal(jobs.size, 1); assert.equal(calls, 0);
  const fn = [...jobs.values()][0]; jobs.clear(); fn();
  assert.equal(calls, 1); work.schedule(); assert.equal(jobs.size, 1);
  const pending = [...jobs.values()][0]; work.dispose(); pending(); work.schedule();
  assert.equal(jobs.size, 0); assert.equal(calls, 1);
});

test('settled camera diagnostics cannot publish nonfinite coordinates', () => {
  const element = {dataset: {}};
  publishMapCamera(element, {longitude: 108, latitude: 53.3, zoom: 6, tileSize: 256, engine: 'tropnik-canvas'});
  const before = {...element.dataset};
  publishMapCamera(element, {longitude: NaN, latitude: 53.3, zoom: 6, tileSize: 256, engine: 'tropnik-canvas'});
  assert.deepEqual(element.dataset, before);
  assert.equal(element.dataset.mapLongitude, '108');
  assert.equal(element.dataset.mapEngine, 'tropnik-canvas');
});

test('custom map story areas retain the 44px route target size', () => {
  assert.equal(MAP_CONFIG.trailHitRadiusPx * 2, 44);
  assert.equal(viewportRegionId(108, 53.3, 6), 'baikal');
  assert.equal(viewportRegionId(108, 53.3, 3), undefined);
  assert.equal(viewportRegionId(Infinity, 53.3, 6), undefined);
  assert.equal(viewportRegionId(10, 10, 10), undefined);
});

test('invalid resource configuration fails immediately instead of hanging the queue', () => {
  for (const key of ['concurrency', 'maxBytes', 'maxResourceBytes', 'maxQueued', 'timeoutMs']) {
    for (const value of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new MapResourcePool({[key]: value}), RangeError);
  }
});

test('a direction cluster always zooms in on a narrow screen and keeps the upper limit', () => {
  assert.equal(directionExpansionZoom(2, 2), 3);
  assert.equal(directionExpansionZoom(2, 1), 3);
  assert.equal(directionExpansionZoom(2, 5), 5);
  assert.equal(directionExpansionZoom(10.8, 11), 11);
});
