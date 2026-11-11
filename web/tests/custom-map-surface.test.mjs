import test from 'node:test';
import assert from 'node:assert/strict';
import {landscapeTilePlan, resampleLandscapeTiles, createLandscapeSurfaceLoader} from '../lib/custom-map-surface.ts';

const bounds = [40.29, 43.64, 40.49, 43.82];
const grid = () => ({schemaVersion: 2, bounds: [...bounds], width: 2, height: 2, elevations: [10, 20, 30, 40], minElevation: 10, maxElevation: 40,
  source: {name: 'test DEM', url: 'test:dem', license: 'test', checkedAt: '2026-11-11'}});
const path = t => `localtiles/${t.z}/${t.x}/${t.y}.pbf`;
const turn = () => new Promise(resolve => setImmediate(resolve));
const pixels = (width, height, color) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return data;
};
const raster = (tile, size = 8, color = [80, 140, 100, 255]) => ({tile, width: size, height: size, pixels: pixels(size, size, color)});
const pixel = (data, width, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test('tile plans use the highest bounded zoom, cover all latitude rows and wrap only URL x', () => {
  const pilot = landscapeTilePlan(bounds);
  assert.equal(pilot.zoom, 12); assert.equal(pilot.tiles.length, 12);
  assert.deepEqual(pilot.tiles[0], {z: 12, x: 2506, y: 1492, worldX: 2506});
  assert.deepEqual(pilot.tiles.at(-1), {z: 12, x: 2508, y: 1495, worldX: 2508});
  for (const b of [[170,50,190,60], [-180,-85,180,85], [-181,-15,-179,15], [179,50,181,60], [40,43,40.001,43.001]]) {
    const plan = landscapeTilePlan(b);
    assert.ok(plan.tiles.length > 0 && plan.tiles.length <= 16);
    assert.ok(plan.zoom >= 0 && plan.zoom <= 14);
    for (const t of plan.tiles) assert.ok(t.x >= 0 && t.x < 2 ** t.z && t.y >= 0 && t.y < 2 ** t.z);
  }
  const east = landscapeTilePlan([170,50,190,60]);
  assert.equal(east.zoom, 6); assert.equal(east.tiles.length, 16);
  assert.deepEqual([...new Set(east.tiles.map(t => t.worldX))], [62,63,64,65]);
  assert.deepEqual([...new Set(east.tiles.map(t => t.x))], [62,63,0,1]);
  for (const b of [[170,40,-170,50], [0,0,361,50], [0,-90,1,0], [0,0,1,90], [0,0,0,1], [NaN,0,1,1]]) assert.throws(() => landscapeTilePlan(b), /bounds/);
});

test('resampling uses Web Mercator for each regular-latitude row, not a stretched tile image', () => {
  const plan = landscapeTilePlan([0,0,90,66]), n = 2 ** plan.zoom, size = 32;
  const rasters = plan.tiles.map(tile => {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      data[at] = (tile.worldX + (x + .5) / size) / n * 255;
      data[at + 1] = (tile.y + (y + .5) / size) / n * 255;
      data[at + 3] = 255;
    }
    return {tile, width: size, height: size, pixels: data};
  });
  const data = resampleLandscapeTiles(plan, rasters, 17, 17);
  for (const y of [0,4,8,12,16]) for (const x of [0,8,16]) {
    const latitude = 66 - y / 16 * 66, longitude = x / 16 * 90;
    const expectedY = (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 255;
    const actual = pixel(data, 17, x, y);
    assert.ok(Math.abs(actual[0] - (longitude + 180) / 360 * 255) <= 1);
    assert.ok(Math.abs(actual[1] - expectedY) <= 1, `latitude ${latitude}: ${actual[1]} vs ${expectedY}`);
    assert.equal(actual[3], 255);
  }
  const stretchedMiddle = (pixel(data, 17, 8, 0)[1] + pixel(data, 17, 8, 16)[1]) / 2;
  assert.ok(Math.abs(pixel(data, 17, 8, 8)[1] - stretchedMiddle) > 6, 'the nonlinear correction must be observable');
});

test('dateline samples join canonical last/first tiles without moving features to the other world', () => {
  const plan = landscapeTilePlan([170,50,190,60]);
  const rasters = plan.tiles.map(t => raster(t, 64, t.worldX < 64 ? [240,0,0,255] : [0,0,240,255]));
  const data = resampleLandscapeTiles(plan, rasters, 257, 33);
  assert.deepEqual(pixel(data, 257, 126, 16), [240,0,0,255]);
  assert.deepEqual(pixel(data, 257, 130, 16), [0,0,240,255]);
  assert.deepEqual(pixel(data, 257, 128, 16), [120,0,120,255], 'bilinear samples cross the real adjacent tile edge');
});

test('unavailable tiles remain transparent and edge interpolation retains available colour', () => {
  const plan = landscapeTilePlan([170,50,190,60]);
  const rasters = plan.tiles.filter(t => t.worldX < 64).map(t => raster(t, 64, [180,90,45,255]));
  const data = resampleLandscapeTiles(plan, rasters, 257, 33);
  assert.deepEqual(pixel(data, 257, 126, 16), [180,90,45,255]);
  assert.deepEqual(pixel(data, 257, 130, 16), [0,0,0,0]);
  const edge = pixel(data, 257, 128, 16);
  assert.deepEqual(edge.slice(0,3), [180,90,45]); assert.equal(edge[3], 128);
  assert.ok(resampleLandscapeTiles(plan, [], 8, 8).every(value => value === 0));
});

test('raster dimensions, atlas coordinates, duplicate tiles and output allocation are bounded', () => {
  const plan = landscapeTilePlan(bounds), tile = plan.tiles[0];
  for (const [width, height] of [[0,1], [1,2], [2048,1024], [1024,1025], [NaN,1]]) assert.throws(() => resampleLandscapeTiles(plan, [], width, height));
  for (const bad of [{...raster(tile), width: 1024}, {...raster(tile), pixels: new Uint8ClampedArray(3)}, {...raster(tile), tile: {...tile, x: -1}}]) assert.throws(() => resampleLandscapeTiles(plan, [bad]));
  assert.throws(() => resampleLandscapeTiles(plan, [raster(tile), raster(tile)]));
  assert.throws(() => resampleLandscapeTiles({...plan, tiles: [tile]}, [raster(tile)]), /cover/);
  assert.throws(() => resampleLandscapeTiles({...plan, zoom: 100}, []));
  assert.throws(() => resampleLandscapeTiles({...plan, tiles: [{...tile, worldX: Infinity}]}, []));
});

test('loader uses the packaged pilot with at most three requests and preserves all DEM heights', async () => {
  const source = grid(), original = structuredClone(source), plan = landscapeTilePlan(source.bounds);
  let active = 0, maximum = 0, downloaded = 0; const json = [];
  const load = createLandscapeSurfaceLoader({
    loadJSON: async url => {json.push(url); return {files: plan.tiles.map(t => ({path: path(t)}))};},
    loadBytes: async url => {assert.ok(url.startsWith('/offline-map/')); active++; maximum = Math.max(maximum, active); downloaded++; await turn(); active--; return new ArrayBuffer(1);},
    paint: async () => ({width:512,height:512,pixels:pixels(512,512,[40,90,140,255])}), yield: async () => undefined,
  });
  const result = await load(source);
  assert.equal(maximum, 3); assert.equal(downloaded, 12); assert.deepEqual(json, ['/offline-map/manifest.json']);
  assert.deepEqual(source, original); assert.equal(result.width, 1024); assert.equal(result.height, 1024);
  assert.equal(result.source.loadedTiles, 12); assert.equal(result.source.localTiles, 12); assert.equal(result.source.complete, true);
  assert.equal(result.source.sampleLayout, 'grid-nodes'); assert.deepEqual(result.source.bounds, bounds);
  assert.deepEqual(pixel(result.pixels, 1024, 500, 500), [40,90,140,255]);
});

test('a missing source tile reports partial coverage and never substitutes fabricated terrain features', async () => {
  const plan = landscapeTilePlan(bounds), failed = '/offline-map/' + path(plan.tiles[0]);
  const load = createLandscapeSurfaceLoader({
    loadJSON: async () => ({files: plan.tiles.map(t => ({path: path(t)}))}),
    loadBytes: async url => {if (url === failed) throw new Error('offline'); return new ArrayBuffer(1);},
    paint: async () => ({width:512,height:512,pixels:pixels(512,512,[40,90,140,255])}), yield: async () => undefined,
  });
  const result = await load(grid());
  assert.equal(result.source.loadedTiles, 11); assert.equal(result.source.complete, false);
  assert.equal(result.source.tiles.some(t => t.url === failed), false);
  assert.equal(pixel(result.pixels, 1024, 0, 0)[3], 0);
  assert.equal(pixel(result.pixels, 1024, 1023, 1023)[3], 255);
});

test('offline missing data and unrecognized remote hosts produce a transparent neutral fallback', async () => {
  for (const online of [false, true]) {
    let calls = 0;
    const load = createLandscapeSurfaceLoader({loadJSON: async url => url.startsWith('/') ? {files: []} : {tiles: ['https://example.invalid/{z}/{x}/{y}.pbf']},
      loadBytes: async () => {calls++; return new ArrayBuffer(1);}, paint: async () => {throw new Error('must not paint');}, online: () => online, yield: async () => undefined});
    const result = await load(grid());
    assert.equal(calls, 0); assert.equal(result.source.loadedTiles, 0); assert.equal(result.source.complete, false);
    assert.ok(result.pixels.every(value => value === 0));
  }
});

test('cancellation starts no work when pre-aborted and promptly detaches from pending shared requests', async () => {
  const plan = landscapeTilePlan(bounds), pending = []; let requests = 0, paints = 0;
  const load = createLandscapeSurfaceLoader({loadJSON: async () => ({files: plan.tiles.map(t => ({path: path(t)}))}),
    loadBytes: () => {requests++; return new Promise(resolve => pending.push(resolve));},
    paint: async () => {paints++; throw new Error('late paint');}, yield: async () => undefined});
  const before = new AbortController(); before.abort();
  await assert.rejects(load(grid(), {signal: before.signal}), {name:'AbortError'}); assert.equal(requests, 0);
  const cancel = new AbortController(), job = load(grid(), {signal: cancel.signal});
  await turn(); assert.equal(requests, 3); cancel.abort();
  await assert.rejects(job, {name:'AbortError'});
  for (const resolve of pending) resolve(new ArrayBuffer(1)); await turn();
  assert.equal(paints, 0); assert.equal(requests, 3, 'no later queued tile may start after consumer cancellation');
});
