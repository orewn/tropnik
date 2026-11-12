import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {mercatorUnproject} from '../lib/custom-map-camera.ts';
import {MapResourcePool,MapResourceHTTPError} from '../lib/map-resource-pool.ts';
import * as renderer from '../public/terrain/terrain-renderer.js';

// Node has no Vite asset compiler. Resolve only its worker-URL import to a URL;
// the loader, numeric data paths and real TerrainPreparation remain unchanged.
const viteAssets=registerHooks({resolve(specifier,context,next){
  if(specifier.endsWith('?worker&url'))return{url:'data:text/javascript,export default "/assets/terrain-preparation.test.js"',shortCircuit:true};
  return next(specifier,context);
}});
const {createCustomLandscapeLoader,decodeTerrariumPixels,planLandscapeTiles,sampleLandscapeElevation}=await import('../lib/custom-map-landscape.ts');
viteAssets.deregister();

const pilot = [40.29, 43.64, 40.49, 43.82];
const small = [40.30, 43.70, 40.31, 43.71];
const tick = () => new Promise(resolve => setImmediate(resolve));
const yieldControl = () => Promise.resolve();
const bytes = new TextEncoder().encode('A verified numeric elevation fixture.').buffer;
const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const tile = (size, value = 123.25) => ({width: size, height: size, elevations: new Float32Array(size * size).fill(value)});
const prepared = async grid => [renderer, grid, {grid}];
const deferred = () => {let resolve, reject; const promise = new Promise((success, failure) => {resolve = success; reject = failure;}); return {promise, resolve, reject};};
function dependency(overrides = {}) {
  return {online: () => true, loadBytes: async () => bytes,
    loadJSON: async () => {throw new Error('No local fixture');},
    decodeTile: async (_bytes, resource) => tile(resource.tileSize), prepare: prepared, yieldControl, ...overrides};
}
function manifestFor(bounds = pilot, maxSourceZoom = 12) {
  const plan = planLandscapeTiles(bounds, {tileSize: 256, maxSourceZoom});
  return {plan, manifest: {files: plan.tiles.map(({z, x, y}) => ({path: `terrain/tiles/${z}/${x}/${y}.png`, bytes: bytes.byteLength, sha256})),
    terrainSource: {name: 'Mapterhorn / Copernicus GLO-30', sourceNominalResolutionM: 30}}};
}
function scalarPixel(height) {
  const encoded = height + 32768, red = Math.floor(encoded / 256), green = Math.floor(encoded) % 256, blue = Math.round((encoded % 1) * 256);
  return [red, green, blue, 255];
}

test('highest complete source zoom respects the real tile budget without enumerating continental tile sets', () => {
  for (const bounds of [pilot, small, [20, 40, 190, 80], [-180, -85, 180, 85], [179.9, -1, -179.9, 1]]) {
    for (const maxTiles of [9, 16]) {
      const plan = planLandscapeTiles(bounds, {maxTiles});
      assert.ok(plan.tiles.length > 0 && plan.tiles.length <= maxTiles);
      assert.ok(plan.zoom <= 12);
      assert.equal(new Set(plan.tiles.map(({z, x, y}) => `${z}/${x}/${y}`)).size, plan.tiles.length);
      for (const {z, x, y} of plan.tiles) assert.ok(x >= 0 && x < 2 ** z && y >= 0 && y < 2 ** z);
    }
  }
  assert.equal(planLandscapeTiles(small).zoom, 12);
  assert.equal(planLandscapeTiles(small, {maxSourceZoom: 99}).zoom, 12);
  assert.equal(planLandscapeTiles([-180, -85, 180, 85]).tiles.length, 16);
  assert.throws(() => planLandscapeTiles([0, -86, 1, 1]), /bounds/);
  assert.throws(() => planLandscapeTiles([0, 0, 361, 1]), /bounds/);
  assert.throws(() => planLandscapeTiles([0, 0, 0, 1]), /bounds/);
  assert.throws(() => planLandscapeTiles(small, {maxTiles: 17}), /budget/);
  assert.throws(() => planLandscapeTiles(small, {availableTileKeys: new Set()}), /complete elevation coverage/);
});

test('numeric Terrarium decoding preserves sub-metre values across RGB carries and rejects unavailable pixels', () => {
  const expected = [-200.25, 255 + 255 / 256, 256 + 1 / 256, 3000.5];
  const source = new Uint8ClampedArray(expected.flatMap(scalarPixel));
  assert.deepEqual([...decodeTerrariumPixels(source, 2, 2).elevations], expected);
  source[3] = 0; assert.throws(() => decodeTerrariumPixels(source, 2, 2), /unavailable/);
  assert.throws(() => decodeTerrariumPixels(new Uint8Array([255, 255, 255, 255]), 1, 1), /invalid/);
  assert.throws(() => decodeTerrariumPixels(new Uint8Array(3), 1, 1), /dimensions/);
});

test('bilinear sampling uses actual neighbouring tiles at seams and across every continuous dateline world', () => {
  const plan = {bounds: [179, -1, 181, 1], zoom: 2, tileSize: 4, tiles: []}, tiles = new Map();
  for (const y of [1, 2]) {
    tiles.set(`2/3/${y}`, tile(4, 255 + 255 / 256));
    tiles.set(`2/0/${y}`, tile(4, 256 + 1 / 256));
  }
  for (const longitude of [-180, 180, 540]) assert.equal(sampleLandscapeElevation(plan, tiles, longitude, 0), 256);
  const [longitude, latitude] = mercatorUnproject({x: 15.25 / 16, y: 8.25 / 16});
  assert.equal(sampleLandscapeElevation(plan, tiles, longitude, latitude), 255 + 255 / 256);
  tiles.delete('2/0/2');
  assert.throws(() => sampleLandscapeElevation(plan, tiles, 180, 0), /Missing elevation tile/);
});

test('bilinear interpolation is exact for a scalar plane across horizontal and vertical tile seams', () => {
  const plan = {bounds: [-10, -10, 10, 10], zoom: 2, tileSize: 4, tiles: []}, tiles = new Map();
  for (const tx of [1, 2]) for (const ty of [1, 2]) {
    const elevations = new Float32Array(16);
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) elevations[row * 4 + column] = (tx * 4 + column) * 2 + (ty * 4 + row) * 3 - 100;
    tiles.set(`2/${tx}/${ty}`, {width: 4, height: 4, elevations});
  }
  for (const [x, y] of [[7.25, 7.75], [8.3, 8.6], [5.1, 6.9]]) {
    const [longitude, latitude] = mercatorUnproject({x: (x + .5) / 16, y: (y + .5) / 16});
    assert.ok(Math.abs(sampleLandscapeElevation(plan, tiles, longitude, latitude) - (x * 2 + y * 3 - 100)) < 1e-10);
  }
});

test('native DEM loading uses no more than three transfers, records true input/output spacing, and prepares the actual grid', async () => {
  let active = 0, maximum = 0, preparations = 0; const urls = [];
  const loader = createCustomLandscapeLoader(dependency({
    loadBytes: async url => {urls.push(url); active++; maximum = Math.max(maximum, active); await tick(); active--; return bytes;},
    prepare: async grid => {preparations++; renderer.validateTerrainGrid(grid); return prepared(grid);},
  }));
  const value = await loader.load(pilot);
  assert.equal(value.grid.width, 513); assert.equal(value.grid.height, 513);
  assert.equal(value.grid.elevations.length, 513 * 513);
  assert.equal(value.grid.minElevation, 123.25); assert.equal(value.grid.maxElevation, 123.25);
  assert.equal(value.prepared[1], value.grid); assert.equal(preparations, 1);
  assert.ok(maximum <= 3); assert.ok(urls.length <= 16);
  assert.ok(urls.every(url => /^https:\/\/tiles\.mapterhorn\.com\/12\/\d+\/\d+\.webp$/.test(url)));
  assert.equal(value.provenance.kind, 'remote-terrarium');
  assert.equal(value.provenance.sourceTileSize, 512); assert.equal(value.provenance.sourceNominalResolutionM, 30);
  assert.equal(value.provenance.missingDataFilled, false); assert.equal(value.provenance.measurementAccuracyClaimedM, null);
  assert.ok(value.provenance.sourcePixelSpacingApproxM > 13 && value.provenance.sourcePixelSpacingApproxM < 15);
  assert.ok(value.provenance.outputSpacingApproxM.eastWest > 31 && value.provenance.outputSpacingApproxM.eastWest < 32);
  assert.equal(await loader.load(pilot), value, 'ready preparations are reused without detaching their buffers');
  loader.dispose();
});

test('offline mode uses only complete manifest-listed PNG256 coverage and verifies exact resource bytes', async () => {
  const {manifest, plan} = manifestFor(), urls = [];
  const loader = createCustomLandscapeLoader(dependency({online: () => false,
    loadJSON: async url => {assert.equal(url, '/offline-map/manifest.json'); return manifest;},
    loadBytes: async url => {urls.push(url); assert.ok(manifest.files.some(file => `/offline-map/${file.path}` === url)); return bytes;},
  }));
  const value = await loader.load(pilot, {gridSize: 257});
  assert.equal(value.grid.width, 257); assert.equal(value.provenance.kind, 'local-terrarium');
  assert.equal(value.provenance.sourceTileSize, 256); assert.equal(value.provenance.sourceZoom, plan.zoom);
  assert.equal(urls.length, plan.tiles.length);
  assert.ok(value.provenance.sourcePixelSpacingApproxM > 27 && value.provenance.sourcePixelSpacingApproxM < 29);
  assert.equal(value.provenance.sourceGridSpacingApproxM, null);
  loader.dispose();
});

test('a corrupt offline tile is rejected before decoding and never becomes generated terrain', async () => {
  const bounds = [179.9, 50, -179.9, 50.1], {manifest} = manifestFor(bounds); let decodes = 0;
  const corrupt = bytes.slice(0); new Uint8Array(corrupt)[0] ^= 1;
  const loader = createCustomLandscapeLoader(dependency({online: () => false,
    loadJSON: async () => manifest, loadBytes: async () => corrupt,
    decodeTile: async () => {decodes++; return tile(256);},
  }));
  await assert.rejects(loader.load(bounds), /No packaged elevation grid/);
  assert.equal(decodes, 0); assert.equal(loader.snapshot().cached, 0);
  loader.dispose();
});

test('the packaged high-detail pilot grid remains a real-data fallback and retains its underlying spacing', async () => {
  const original = JSON.parse(await readFile(new URL('../public/terrain/terrain-grid.json', import.meta.url), 'utf8'));
  const loader = createCustomLandscapeLoader(dependency({online: () => false,
    loadJSON: async url => {if (url !== '/terrain/terrain-grid.json') throw new Error('Packaged tiles unavailable'); return original;},
  }));
  const value = await loader.load(pilot);
  assert.equal(value.provenance.kind, 'local-grid'); assert.deepEqual(value.provenance.sourceUrls, ['/terrain/terrain-grid.json']);
  assert.ok(value.provenance.sourceGridSpacingApproxM.eastWest > 31 && value.provenance.sourceGridSpacingApproxM.eastWest < 32);
  for (const index of [0, 512, 513 * 250 + 230, 513 * 513 - 1]) assert.ok(Math.abs(value.grid.elevations[index] - original.elevations[index]) < 1e-7);
  assert.equal(value.provenance.sourcePixelSpacingApproxM, null, 'a grid fallback does not pretend that its upstream pixels are still present');
  loader.dispose();
});

test('shared callers survive one consumer cancellation and no fetch starts for an already aborted caller', async () => {
  const gate = deferred(), cancelled = new AbortController(), premature = new AbortController(); let reads = 0;
  const loader = createCustomLandscapeLoader(dependency({loadBytes: async () => {reads++; await gate.promise; return bytes;}}));
  premature.abort(); await assert.rejects(loader.load(small, {signal: premature.signal}), {name: 'AbortError'}); assert.equal(reads, 0);
  const a = loader.load(small, {signal: cancelled.signal, gridSize: 257, maxSourceZoom: 0});
  const b = loader.load(small, {gridSize: 257, maxSourceZoom: 0});
  cancelled.abort(); await assert.rejects(a, {name: 'AbortError'});
  assert.equal(loader.snapshot().consumers, 1); assert.equal(reads, 1);
  gate.resolve(); const result = await b;
  assert.equal(await loader.load(small, {gridSize: 257, maxSourceZoom: 0}), result);
  loader.dispose();
});

test('aborting the last caller prevents stale decoding, waits for in-flight transfers, and permits a fresh same-key request', async () => {
  const gate = deferred(), cancel = new AbortController(); let reads = 0, decodes = 0;
  const loader = createCustomLandscapeLoader(dependency({loadBytes: async () => {reads++; if (reads === 1) await gate.promise; return bytes;},
    decodeTile: async (_bytes, resource) => {decodes++; return tile(resource.tileSize);}}));
  const first = loader.load(small, {signal: cancel.signal, gridSize: 257, maxSourceZoom: 0});
  cancel.abort(); await assert.rejects(first, {name: 'AbortError'});
  const fresh = loader.load(small, {gridSize: 257, maxSourceZoom: 0});
  await tick(); assert.equal(reads, 1); assert.equal(loader.snapshot().active, 1); assert.equal(loader.snapshot().queued, 1);
  gate.resolve(); await fresh;
  assert.equal(reads, 2); assert.equal(decodes, 1); assert.equal(loader.snapshot().cached, 1);
  loader.dispose();
});

test('cancellation during terrain preparation cannot overlap another worker or cache a stale model', async () => {
  const gate = deferred(), entered = deferred(), cancel = new AbortController(); let starts = 0;
  const loader = createCustomLandscapeLoader(dependency({prepare: async grid => {starts++; if (starts === 1) {entered.resolve(); await gate.promise;} return prepared(grid);}}));
  const first = loader.load(small, {signal: cancel.signal, gridSize: 257, maxSourceZoom: 0});
  await entered.promise; cancel.abort(); await assert.rejects(first, {name: 'AbortError'});
  const second = loader.load([41, 44, 41.01, 44.01], {gridSize: 257, maxSourceZoom: 0});
  await tick(); assert.equal(starts, 1); assert.equal(loader.snapshot().cached, 0);
  gate.resolve(); await second;
  assert.equal(starts, 2); assert.equal(loader.snapshot().cached, 1);
  loader.dispose();
});

test('cancelling a multi-tile view waits for every outstanding transfer before starting a replacement', async () => {
  const gates = [deferred(), deferred(), deferred()], cancel = new AbortController(); let reads = 0;
  const loader = createCustomLandscapeLoader(dependency({loadBytes: async () => {const index = reads++; if (index < 3) await gates[index].promise; return bytes;}}));
  const first = loader.load(pilot, {signal: cancel.signal, gridSize: 257});
  await tick(); assert.equal(reads, 3);
  cancel.abort(); await assert.rejects(first, {name: 'AbortError'});
  const second = loader.load(small, {gridSize: 257, maxSourceZoom: 0});
  gates[0].resolve(); await tick(); assert.equal(reads, 3, 'one rejected worker does not release the bounded pipeline');
  gates[1].resolve(); await tick(); assert.equal(reads, 3, 'the third shared download is still alive');
  gates[2].resolve(); await second;
  assert.equal(reads, 4); assert.equal(loader.snapshot().cached, 1);
  loader.dispose();
});

test('queues and prepared cache stay bounded; foreground can displace a queued prefetch', async () => {
  const gate = deferred(); let reads = 0;
  const loader = createCustomLandscapeLoader(dependency({loadBytes: async () => {if (++reads === 1) await gate.promise; return bytes;}}));
  const options = {gridSize: 257, maxSourceZoom: 0};
  const first = loader.load([10, 10, 10.01, 10.01], options);
  const stale = loader.prefetch([20, 20, 20.01, 20.01], options);
  const warm = loader.prefetch([30, 30, 30.01, 30.01], options);
  assert.equal(loader.snapshot().queued, 2);
  const foreground = loader.load([40, 40, 40.01, 40.01], options);
  assert.equal(await stale, undefined);
  assert.equal(loader.snapshot().queued, 2); assert.equal(loader.snapshot().active, 1);
  gate.resolve(); await Promise.all([first, foreground, warm]);
  assert.equal(loader.snapshot().cached, 2); assert.equal(reads, 3);
  await loader.load([10, 10, 10.01, 10.01], options);
  assert.equal(reads, 4, 'the oldest completed preparation was evicted');
  loader.dispose(); assert.equal(loader.snapshot().cached, 0);
  await assert.rejects(loader.load(small), /disposed/);
});

test('dispose rejects active and queued consumers immediately and forbids stale cache publication', async () => {
  const gate = deferred(); let reads = 0;
  const loader = createCustomLandscapeLoader(dependency({loadBytes: async () => {reads++; await gate.promise; return bytes;}}));
  const first = loader.load(small, {maxSourceZoom: 0}), second = loader.load(pilot, {maxSourceZoom: 0});
  loader.dispose();
  await assert.rejects(first, {name: 'AbortError'}); await assert.rejects(second, {name: 'AbortError'});
  gate.resolve(); await tick();
  assert.equal(reads, 1); assert.equal(loader.snapshot().cached, 0); assert.equal(loader.snapshot().queued, 0);
});

test('the default TerrainPreparation path builds validated geometry from the requested geographic bounds', async () => {
  const config = dependency(); delete config.prepare;
  const loader = createCustomLandscapeLoader(config);
  const value = await loader.load([179.95, 50, -179.95, 50.05], {gridSize: 257, maxSourceZoom: 0});
  assert.deepEqual(value.grid.bounds, [179.95, 50, 180.05, 50.05]);
  assert.equal(value.prepared[2].grid, value.grid);
  assert.equal(value.prepared[2].heights.length, 257 * 257);
  assert.equal(renderer.validatePreparedTerrainModel(value.grid, value.prepared[2]), value.prepared[2]);
  loader.dispose();
});

test('the browser preparation worker uses the compiled URL on the page origin, never the build filesystem', async () => {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker'), previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const starts = []; let terminated = 0;
  class BrowserWorker {
    onmessage = null; onerror = null; onmessageerror = null;
    constructor(url, options) {starts.push({url: url.href, options});}
    postMessage(request) {queueMicrotask(() => this.onmessage?.({data: {type: 'terrain-prepared', protocol: 1, requestId: request.requestId, model: renderer.createTerrainModel(request.grid)}}));}
    terminate() {terminated++;}
  }
  Object.defineProperty(globalThis, 'Worker', {value: BrowserWorker, configurable: true});
  Object.defineProperty(globalThis, 'location', {value: {href: 'https://tropnik.example/preview/offline-viewer.html'}, configurable: true});
  try {
    const config = dependency(); delete config.prepare;
    const loader = createCustomLandscapeLoader(config);
    const value = await loader.load(small, {gridSize: 257, maxSourceZoom: 0});
    assert.deepEqual(starts, [{url: 'https://tropnik.example/assets/terrain-preparation.test.js', options: {type: 'module', name: 'tropnik-landscape'}}]);
    assert.equal(terminated, 1); assert.equal(value.prepared[2].grid, value.grid);
    loader.dispose();
  } finally {
    if (previousWorker) Object.defineProperty(globalThis, 'Worker', previousWorker); else delete globalThis.Worker;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else delete globalThis.location;
  }
});


const countryBounds=[19.63892820000001,41.1858711,191.00266579999993,81.858721];
test('whole Russia uses complete real-source zoom 2 when the zoom 3 Arctic corner is genuinely absent',async()=>{
 const urls=[];let active=0,maximum=0;
 const pool=new MapResourcePool({fetcher:async url=>{
  urls.push(url);active++;maximum=Math.max(maximum,active);await tick();active--;
  return /\/3\/(?:7|0)\/0\.webp$/.test(url)?new Response('Tile not found',{status:404}):new Response(bytes);
 }});
 const loader=createCustomLandscapeLoader(dependency({loadJSON:async()=>({schemaVersion:1,regions:[]}),loadBytes:url=>pool.get(url),
  decodeTile:async(_bytes,resource)=>tile(resource.tileSize,resource.z===2?123.25:9000),
  prepare:async grid=>[renderer,grid,renderer.createTerrainModel(grid)],
 }));
 const result=await loader.load(countryBounds,{preferRegional:true});
 assert.deepEqual(urls.slice(0,3),['https://tiles.mapterhorn.com/3/4/0.webp','https://tiles.mapterhorn.com/3/0/0.webp','https://tiles.mapterhorn.com/3/0/2.webp']);
 assert.equal(urls.length,9);assert.ok(maximum<=3);assert.deepEqual(result.grid.bounds,countryBounds);assert.equal(result.grid.width,513);assert.equal(result.grid.height,513);
 assert.equal(result.provenance.sourceZoom,2);assert.equal(result.provenance.sourceTileSize,512);assert.equal(result.provenance.sourceUrls.length,6);
 assert.ok(result.provenance.sourceUrls.every(url=>url.includes('/2/')));assert.match(result.provenance.fallbackReason,/zoom 3 \(HTTP 404\).*complete zoom 2/);
 assert.ok(Math.abs(result.provenance.sourcePixelSpacingApproxM-9330.292421747046)<1e-8);
 assert.equal(result.provenance.missingDataFilled,false);assert.equal(result.provenance.measurementAccuracyClaimedM,null);
 assert.ok(result.grid.elevations.every(height=>Number.isFinite(height)&&Math.abs(height-123.25)<1e-9),'discarded finer tiles and missing sea corners cannot become invented or mixed elevations');
 assert.equal(renderer.validatePreparedTerrainModel(result.grid,result.prepared[2]),result.prepared[2]);loader.dispose();
});

test('late missing coverage still shares the original total tile budget with its complete coarser retry',async()=>{
 const urls=[],loader=createCustomLandscapeLoader(dependency({loadBytes:async url=>{
  urls.push(url);await tick();if(url==='https://tiles.mapterhorn.com/3/7/2.webp')throw new MapResourceHTTPError(404);return bytes;
 }}));
 const result=await loader.load(countryBounds);
 assert.equal(urls.filter(url=>url.includes('/3/')).length,15);assert.equal(urls.length,16,'all failed and successful requests together retain the original 16-tile limit');
 assert.equal(result.provenance.sourceZoom,0);assert.deepEqual(result.provenance.sourceUrls,['https://tiles.mapterhorn.com/0/0/0.webp']);assert.equal(result.provenance.missingDataFilled,false);loader.dispose();
});

test('coverage retry is limited to three plans and the caller budget; other errors never lower source zoom',async()=>{
 for(const maxTiles of[9,16]){
  const urls=[],loader=createCustomLandscapeLoader(dependency({loadBytes:async url=>{urls.push(url);throw new MapResourceHTTPError(404);}}));
  await assert.rejects(loader.load(countryBounds,{maxTiles}),/No packaged elevation grid/);
  assert.ok(urls.length<=maxTiles);assert.equal(new Set(urls.map(url=>url.split('/')[3])).size,3);assert.equal(loader.snapshot().cached,0);loader.dispose();
 }
 for(const failure of[new MapResourceHTTPError(403),new MapResourceHTTPError(503),new Error('Network timed out'),new Error('Preview resource unavailable (404)'),new Error('Terrarium tile contains unavailable or invalid elevations')]){
  const urls=[],loader=createCustomLandscapeLoader(dependency({loadBytes:async url=>{urls.push(url);throw failure;}}));
  await assert.rejects(loader.load(countryBounds),/No packaged elevation grid/);
  assert.ok(urls.length>0&&urls.length<=3);assert.ok(urls.every(url=>url.includes('/3/')),'non-404 transport/decoder failures must not become repeated coverage retries');loader.dispose();
 }
});
