import test from 'node:test';
import assert from 'node:assert/strict';
import {landscapeTilePlan, resampleLandscapeTiles, createLandscapeSurfaceLoader} from '../lib/custom-map-surface.ts';

const bounds = [40.29, 43.64, 40.49, 43.82];
const grid = () => ({schemaVersion: 2, bounds: [...bounds], width: 2, height: 2, elevations: [10, 20, 30, 40], minElevation: 10, maxElevation: 40,
  source: {name: 'test DEM', url: 'test:dem', license: 'test', checkedAt: '2026-11-11'}});
const imageryURL = t => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${t.z}/${t.y}/${t.x}.jpg`;
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

test('the 3D surface requests only source imagery with at most three transfers and preserves every DEM height', async () => {
  const source = grid(), original = structuredClone(source), plan = landscapeTilePlan(source.bounds);
  let active = 0, maximum = 0; const downloaded = [], json = [];
  const load = createLandscapeSurfaceLoader({
    loadJSON: async url => {json.push(url); throw new Error('Imagery does not need a vendor vector manifest');},
    loadBytes: async url => {downloaded.push(url); active++; maximum = Math.max(maximum, active); await turn(); active--; return new ArrayBuffer(1);},
    paint: async () => ({width:512,height:512,pixels:pixels(512,512,[40,90,140,255])}), yield: async () => undefined,
  });
  const result = await load(source);
  assert.equal(maximum, 3); assert.equal(downloaded.length, 12); assert.deepEqual(json, []);
  assert.deepEqual(downloaded.sort(), plan.tiles.map(imageryURL).sort());
  assert.ok(downloaded.every(url => new URL(url).hostname === 'tiles.maps.eox.at' && url.endsWith('.jpg')));
  assert.equal(downloaded.some(url => /openfreemap|openstreetmap|openmaptiles|\.pbf/.test(url)), false, 'The 3D colour pipeline must not consult vector map providers');
  assert.deepEqual(source, original); assert.equal(result.width, 1024); assert.equal(result.height, 1024);
  assert.equal(result.source.loadedTiles, 12); assert.equal(result.source.localTiles, 0); assert.equal(result.source.complete, true);
  assert.equal(result.source.kind, 'imagery'); assert.equal(result.source.provider, 'eox-s2');
  assert.match(result.source.attribution, /Copernicus Sentinel data 2016 & 2017/);
  assert.equal(result.source.sampleLayout, 'grid-nodes'); assert.deepEqual(result.source.bounds, bounds);
  assert.deepEqual(pixel(result.pixels, 1024, 500, 500), [40,90,140,255]);
});

test('one failed imagery tile prevents a checkerboard surface from replacing the current completed window', async () => {
  const plan = landscapeTilePlan(bounds), failed = imageryURL(plan.tiles[0]);
  const load = createLandscapeSurfaceLoader({
    loadJSON: async () => {throw new Error('No vector source');},
    loadBytes: async url => {if (url === failed) throw new Error('offline'); return new ArrayBuffer(1);},
    paint: async () => ({width:512,height:512,pixels:pixels(512,512,[40,90,140,255])}), yield: async () => undefined,
  });
  const result = await load(grid());
  assert.equal(result.source.loadedTiles, 0); assert.equal(result.source.complete, false);
  assert.equal(result.source.tiles.length, 11, 'Successful downloads remain observable without claiming a completed displayed surface');
  assert.equal(result.source.tiles.some(t => t.url === failed), false);
  assert.ok(result.pixels.every(value => value === 0), 'No partial image or invented colour may be committed');
});

test('offline missing imagery starts no remote requests and keeps a neutral terrain material', async () => {
  let requests = 0, paints = 0;
  const load = createLandscapeSurfaceLoader({loadJSON: async () => {throw new Error('No vector source');},
    loadBytes: async () => {requests++; return new ArrayBuffer(1);}, paint: async () => {paints++; throw new Error('must not paint');}, online: () => false, yield: async () => undefined});
  const result = await load(grid());
  assert.equal(requests, 0); assert.equal(paints, 0); assert.equal(result.source.loadedTiles, 0); assert.equal(result.source.complete, false);
  assert.ok(result.pixels.every(value => value === 0));
});

test('the documented Wrangel and dateline imagery gap uses real Blue Marble at its source zoom limit', async () => {
  for (const sourceBounds of [[178,70,179,71], [-181,70,-180,71]]) {
    const source={...grid(), bounds:sourceBounds}, urls=[];
    const load=createLandscapeSurfaceLoader({loadJSON:async()=>{throw new Error('No vector source');},
      loadBytes:async url=>{urls.push(url);return new ArrayBuffer(1);},
      paint:async()=>({width:256,height:256,pixels:pixels(256,256,[65,105,135,255])}),yield:async()=>undefined});
    const result=await load(source), plan=landscapeTilePlan(sourceBounds,8);
    assert.equal(result.source.provider,'eox-bluemarble');assert.equal(result.source.tileZoom,plan.zoom);assert.ok(plan.zoom<=8);
    assert.equal(result.source.nativeResolutionM,undefined,'An overview is never represented as ten-metre imagery');
    assert.ok(urls.every(url=>url.includes('/bluemarble_3857/')&&Number(url.split('/').at(-3))<=8));
    assert.equal(result.source.complete,true);assert.deepEqual(pixel(result.pixels,1024,500,500),[65,105,135,255]);
  }
});

test('invalid decoded dimensions or mixed image scales cannot become a completed material', async () => {
  const source=grid();let serial=0;
  const load=createLandscapeSurfaceLoader({loadJSON:async()=>{throw new Error('No vector source');},loadBytes:async()=>new ArrayBuffer(1),
    paint:async()=>{const size=serial++?512:257;return{width:size,height:size,pixels:pixels(size,size,[40,90,140,255])};},yield:async()=>undefined});
  const result=await load(source);assert.equal(result.source.complete,false);assert.equal(result.source.loadedTiles,0);assert.ok(result.pixels.every(value=>value===0));
  serial=0;
  const mixed=createLandscapeSurfaceLoader({loadJSON:async()=>{throw new Error('No vector source');},loadBytes:async()=>new ArrayBuffer(1),
    paint:async()=>{const size=serial++?512:256;return{width:size,height:size,pixels:pixels(size,size,[40,90,140,255])};},yield:async()=>undefined});
  await assert.rejects(mixed(source),/source raster/,'Incompatible source scales cannot be silently stretched into one atlas');
});

test('cancellation starts no work when pre-aborted and promptly detaches from pending shared requests', async () => {
  const pending = []; let requests = 0, paints = 0;
  const load = createLandscapeSurfaceLoader({loadJSON: async () => {throw new Error('No vector source');},
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

const localRegion=()=>({id:'measured-region',bounds:[...bounds],materialUrl:'/terrain-regions/measured-region/surface.png',
  material:{width:64,height:32,bounds:[...bounds],source:'ESA WorldCover 2021',nominalResolutionM:10,
    attribution:'EXACT CREDIT / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium'},provenance:{}});

test('checked exact-bounds WorldCover stays georeferenced, retains supplied credit and uses no remote map',async()=>{
  const region=localRegion(), source=grid(), original=structuredClone(source), urls=[];
  const materialPixels=pixels(64,32,[81,112,75,255]);let decoded=0;
  const load=createLandscapeSurfaceLoader({loadJSON:async url=>{urls.push(url);throw new Error('Unexpected network');},loadBytes:async url=>{urls.push(url);throw new Error('Unexpected network');},
    paint:async()=>{throw new Error('No imagery needed');},regional:{find:async requested=>{assert.deepEqual(requested,bounds);return region;},material:async actual=>{assert.equal(actual,region);return new ArrayBuffer(4);}},
    decodeMaterial:async(bytes,width,height)=>{decoded++;assert.equal(bytes.byteLength,4);assert.equal(width,64);assert.equal(height,32);return{width,height,pixels:materialPixels};},yield:async()=>undefined});
  const result=await load(source);assert.equal(decoded,1);assert.deepEqual(urls,[]);assert.equal(result.width,64);assert.equal(result.height,32);
  assert.equal(result.source.kind,'landcover');assert.equal(result.source.complete,true);assert.equal(result.source.localTiles,1);assert.equal(result.source.nativeResolutionM,10);
  assert.equal(result.source.attribution,region.material.attribution,'Source-supplied licence text is not replaced by an abbreviated guessed credit');
  assert.deepEqual(result.source.bounds,bounds);assert.deepEqual(pixel(result.pixels,64,31,16),[81,112,75,255]);assert.deepEqual(source,original);
});

test('a larger regional material is never stretched onto a smaller DEM and corrupt local material falls back explicitly',async()=>{
  for(const corrupt of [false,true]){
    const region=localRegion(),urls=[];if(!corrupt)region.bounds=[40,43,41,44];let materials=0,decodes=0;
    const load=createLandscapeSurfaceLoader({loadJSON:async()=>{throw new Error('No vector source');},loadBytes:async url=>{urls.push(url);return new ArrayBuffer(1);},
      paint:async()=>({width:512,height:512,pixels:pixels(512,512,[40,90,140,255])}),regional:{find:async()=>region,material:async()=>{materials++;throw new Error('Regional terrain checksum differs');}},
      decodeMaterial:async()=>{decodes++;throw new Error('Corrupt material must not reach decode');},yield:async()=>undefined});
    const result=await load(grid());assert.equal(result.source.kind,'imagery');assert.equal(result.source.complete,true);assert.equal(materials,corrupt?1:0);assert.equal(decodes,0);
    assert.ok(urls.length>0&&urls.every(url=>new URL(url).hostname==='tiles.maps.eox.at'));
  }
});

test('cancellation of a pending regional manifest cannot start material decode or fallback transfers',async()=>{
  let resolveManifest;const pending=new Promise(resolve=>{resolveManifest=resolve;});let reads=0;
  const controller=new AbortController();const load=createLandscapeSurfaceLoader({loadJSON:async()=>{throw new Error('unused');},loadBytes:async()=>{reads++;throw new Error('late');},paint:async()=>{throw new Error('late');},
    regional:{find:()=>pending,material:async()=>{reads++;throw new Error('late');}},decodeMaterial:async()=>{reads++;throw new Error('late');}});
  const result=load(grid(),{signal:controller.signal});controller.abort();await assert.rejects(result,{name:'AbortError'});
  resolveManifest(localRegion());await turn();assert.equal(reads,0);
});

test('cancellation promptly detaches from native material decode and discards its eventual pixels',async()=>{
  const region=localRegion();let finishDecode,decodes=0,remote=0;
  const decoded=new Promise(resolve=>{finishDecode=resolve;}),controller=new AbortController();
  const load=createLandscapeSurfaceLoader({loadJSON:async()=>{throw new Error('unused');},loadBytes:async()=>{remote++;throw new Error('late');},paint:async()=>{throw new Error('late');},
    regional:{find:async()=>region,material:async()=>new ArrayBuffer(4)},decodeMaterial:()=>{decodes++;return decoded;}});
  const result=load(grid(),{signal:controller.signal});let state='pending';result.then(()=>{state='resolved';},()=>{state='rejected';});
  await turn();assert.equal(decodes,1);controller.abort();await turn();const detachedBeforePixels=state==='rejected';
  finishDecode({width:64,height:32,pixels:pixels(64,32,[81,112,75,255])});await assert.rejects(result,{name:'AbortError'});
  assert.equal(detachedBeforePixels,true,'Shared native image decoding may finish, but a closed scene must detach immediately');assert.equal(remote,0);
});
