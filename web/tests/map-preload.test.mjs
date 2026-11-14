import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {MapResourcePool, MapResourceHTTPError, routeTilePlan} from '../lib/map-resource-pool.ts';
import {publicMapResourceKey} from '../lib/map-transport.ts';
import {TerrainPreparation} from '../lib/terrain-preparation.ts';
import {MAP_CONFIG} from '../lib/map-config.ts';
import {loadVerifiedRouteGeometry,versionedRouteSource} from '../lib/route-source-integrity.ts';
import * as renderer from '../public/terrain/terrain-renderer.js';

const preloadSource=ts.transpileModule(readFileSync(new URL('../lib/map-preload.ts',import.meta.url),'utf8').replaceAll('import.meta.url',JSON.stringify('https://map-preview.local/lib/map-preload.ts')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const sourceFixture=geometry=>{const body=JSON.stringify(geometry),sha256=createHash('sha256').update(body).digest('hex'),url='/data/preview.geojson',sourceHashes={'preview.geojson':sha256};return{body,url,sourceHashes,versioned:versionedRouteSource(url,sourceHashes).url};};
function preloadModule(dependencies,environment={}){
  const context=vm.createContext({URL,window:{},location:{origin:'https://map-preview.local',href:'https://map-preview.local/'},navigator:{onLine:true},...environment});
  const testModule={exports:{}},require=id=>{assert.ok(Object.hasOwn(dependencies,id),`Unexpected preload dependency ${id}`);return dependencies[id];};
  vm.runInContext(`(function(require,module,exports){${preloadSource}\n})`,context)(require,testModule,testModule.exports);
  return testModule.exports;
}

test('route previews warm actual 2D geometry and relief tiles without preparing a separate 3D scene', async () => {
  const reads=[],geometry={type:'LineString',coordinates:[[40.35,43.7],[40.4,43.75]]},source=sourceFixture(geometry);let coverageReads=0,coverageDisposals=0,workers=0,coordinators=0;
  class PreviewPreparation extends TerrainPreparation {constructor(options){super(options);coordinators++;}}
  class PreviewPool extends MapResourcePool {
    constructor(){super({fetcher:async url=>{
      reads.push(url);
      if(url===source.versioned)return new Response(source.body);
      if(url==='https://tiles.openfreemap.org/planet/latest')return Response.json({tiles:['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf']});
      assert.match(url,/^https:\/\/tiles\.(openfreemap\.org\/planet\/test|mapterhorn\.com)\/\d+\/\d+\/\d+\.(pbf|webp)$/);
      return new Response(new Uint8Array([1,2,3]));
    }});}
  }
  const dependencies={
    './map-resource-pool':{MapResourcePool:PreviewPool,routeTilePlan},'./map-transport':{publicMapResourceKey},
    './terrain-preparation':{TerrainPreparation:PreviewPreparation},'./map-config':{MAP_CONFIG},
    './trail-overlay.generated.json':{sourceHashes:source.sourceHashes},'./route-source-integrity':{versionedRouteSource},
    '@/public/maps/map-coverage-lod.js':{loadMapCoverage:async()=>{coverageReads++;return{dispose(){coverageDisposals++;}};}},
  };
  const api=preloadModule(dependencies,{Worker:class{constructor(){workers++;}}}),trail={id:'caucasus',revisionId:'1',geometryUrl:'/data/preview.geojson',bbox:[40.29,43.64,40.49,43.82]};
  assert.equal(api.hasTerrainPreview(trail),true,'The regression exercises the former implicit 3D coverage branch');
  const preview=api.preloadTrail(trail);assert.equal(api.preloadTrail(trail),preview,'Two cards still share the same bounded preview');
  assert.deepEqual({...await preview},{state:'ready',completed:2,total:2});
  assert.deepEqual(await api.loadPublicJSON(source.versioned),geometry);
  assert.equal(reads.filter(url=>url===source.versioned).length,1);assert.equal(reads.includes(source.url),false);
  assert.ok(reads.some(url=>url.endsWith('.pbf')));assert.ok(reads.some(url=>url.endsWith('.webp')));
  assert.ok(reads.length<=2+MAP_CONFIG.prefetchTiles*2);
  assert.equal(coverageReads,1);assert.equal(coverageDisposals,1);
  assert.equal(api.terrainPreparationInfo().state,'idle');assert.equal(api.terrainPreparationInfo().attempts,0);assert.equal(workers,0);assert.equal(coordinators,0);
  assert.equal(reads.some(url=>url.startsWith('/terrain/')),false);
});

test('prefetch and selected-route verification share one versioned HTTP read in either start order',async t=>{
  for(const first of ['prefetch','selection'])await t.test(first,async()=>{
    const geometry={type:'LineString',coordinates:[[40.35,43.7],[40.4,43.75]]},source=sourceFixture(geometry),reads=[];
    let release,jsonReads=0;const gate=new Promise(resolve=>{release=resolve;});
    class SharedPool extends MapResourcePool {
      static instance;
      constructor(){super({fetcher:async url=>{reads.push(url);await gate;return new Response(source.body);}});SharedPool.instance=this;}
      json(...args){jsonReads++;return super.json(...args);}
    }
    const api=preloadModule({
      './map-resource-pool':{MapResourcePool:SharedPool,routeTilePlan},'./map-transport':{publicMapResourceKey},
      './terrain-preparation':{TerrainPreparation},'./map-config':{MAP_CONFIG},
      './trail-overlay.generated.json':{sourceHashes:source.sourceHashes},'./route-source-integrity':{versionedRouteSource},
      '@/public/maps/map-coverage-lod.js':{loadMapCoverage:async()=>({dispose(){}})},
    });
    const trail={id:'shared',revisionId:'1',geometryUrl:source.url},controller=new AbortController();
    const select=()=>loadVerifiedRouteGeometry(trail.geometryUrl,source.sourceHashes,{load:api.loadPublicBytes,invalidate:api.invalidatePublicMapResource,signal:controller.signal});
    let preview,selection;
    if(first==='prefetch'){preview=api.preloadTrail(trail);await new Promise(resolve=>setImmediate(resolve));selection=select();}
    else{selection=select();preview=api.preloadTrail(trail);}
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(reads,[source.versioned]);assert.equal(SharedPool.instance.stats().active,1);assert.equal(SharedPool.instance.stats().queued,0);
    release();assert.deepEqual({...await preview},{state:'ready',completed:1,total:1});assert.deepEqual(await selection,geometry);
    assert.equal(jsonReads,0,'Prefetch warms bytes without parsing a separate geometry object');
    assert.equal(SharedPool.instance.stats().cached,1);assert.equal(SharedPool.instance.stats().bytes,Buffer.byteLength(source.body));
    assert.deepEqual(await select(),geometry);assert.deepEqual(reads,[source.versioned],'A later selection reuses the same checked resource bytes');
  });
});

test('offline preview failures stay partial, skip remote tiles and can retry the same versioned source',async()=>{
  const geometry={type:'LineString',coordinates:[[40.35,43.7],[40.4,43.75]]},source=sourceFixture(geometry),reads=[];let unavailable=true;
  class OfflinePool extends MapResourcePool {constructor(){super({fetcher:async url=>{reads.push(url);assert.equal(url,source.versioned);return unavailable?new Response('offline',{status:503}):new Response(source.body);}});}}
  const api=preloadModule({
    './map-resource-pool':{MapResourcePool:OfflinePool,routeTilePlan},'./map-transport':{publicMapResourceKey},
    './terrain-preparation':{TerrainPreparation},'./map-config':{MAP_CONFIG},
    './trail-overlay.generated.json':{sourceHashes:source.sourceHashes},'./route-source-integrity':{versionedRouteSource},
    '@/public/maps/map-coverage-lod.js':{loadMapCoverage:async()=>({dispose(){}})},
  },{navigator:{onLine:false}});
  const trail={id:'offline',geometryUrl:source.url,bbox:[40.29,43.64,40.49,43.82]};
  assert.deepEqual({...await api.preloadTrail(trail)},{state:'partial',completed:0,total:1});assert.deepEqual(reads,[source.versioned]);
  unavailable=false;assert.deepEqual({...await api.preloadTrail(trail)},{state:'ready',completed:1,total:1});assert.deepEqual(reads,[source.versioned,source.versioned]);
  assert.deepEqual({...await api.preloadTrail({...trail,id:'absent',geometryUrl:'/data/absent.geojson'})},{state:'partial',completed:0,total:1});assert.equal(reads.length,2,'A missing source hash is a contained partial preview, never an unversioned fetch');
});

test('explicit legacy terrain requests lazily share one coordinator and preserve the idle snapshot and cancellation API',async()=>{
  const grid={schemaVersion:1,bounds:[40,43,40.1,43.1],width:2,height:2,elevations:[100,110,120,130]};let coordinators=0,reads=0;
  class LegacyPreparation extends TerrainPreparation {constructor(options){super(options);coordinators++;}}
  class LegacyPool extends MapResourcePool {constructor(){super({fetcher:async url=>{reads++;assert.match(url,/^\/terrain\/terrain-grid\.json\?v=/);return Response.json(grid);}});}}
  const api=preloadModule({
    './map-resource-pool':{MapResourcePool:LegacyPool,routeTilePlan},'./map-transport':{publicMapResourceKey},
    './terrain-preparation':{TerrainPreparation:LegacyPreparation},'./map-config':{MAP_CONFIG},
    './trail-overlay.generated.json':{sourceHashes:{}},'./route-source-integrity':{versionedRouteSource},
    '@/public/maps/map-coverage-lod.js':{loadMapCoverage:async()=>({dispose(){}})},
    '@/public/terrain/terrain-renderer.js':renderer,
  });
  const idle={state:'idle',method:null,attempts:0,workerStarts:0,fallbackReason:null};
  assert.deepEqual({...api.terrainPreparationInfo()},idle);assert.equal(coordinators,0);assert.equal(reads,0);
  const snapshot=api.terrainPreparationInfo();snapshot.state='failed';assert.deepEqual({...api.terrainPreparationInfo()},idle,'Inspection returns an independent snapshot');
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(api.loadTerrain(cancelled.signal),{name:'AbortError'});
  assert.equal(coordinators,1);assert.equal(reads,0);assert.deepEqual({...api.terrainPreparationInfo()},idle);
  const first=api.loadTerrain();assert.equal(api.loadTerrain(),first);const prepared=await first;
  assert.equal(coordinators,1);assert.equal(reads,1);assert.deepEqual(prepared[1],grid);assert.equal(prepared[2].grid,prepared[1]);
  assert.equal(api.terrainPreparationInfo().state,'ready');assert.equal(api.terrainPreparationInfo().attempts,1);
  assert.equal(await api.preloadTerrain(),prepared);assert.equal(coordinators,1);assert.equal(reads,1);
});

test('all preview cards share one concurrency limit and duplicate requests', async () => {
  let active=0, maximum=0, requests=0;
  const pool=new MapResourcePool({concurrency:3,fetcher:async()=>{
    requests++; active++; maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,3)); active--; return Response.json({height:42});
  }});
  const first=pool.get('/terrain/same.json');
  assert.equal(pool.get('/terrain/same.json'),first);
  await Promise.all([first,...Array.from({length:12},(_,i)=>pool.get(`/data/${i}.json`))]);
  assert.equal(maximum,3);assert.equal(requests,13);
  const a=await pool.json('/terrain/same.json'),b=await pool.json('/terrain/same.json');
  assert.equal(a,b);assert.equal(requests,13);
});

test('network and malformed JSON failures do not poison retries', async () => {
  let calls=0;
  const pool=new MapResourcePool({fetcher:async()=>{calls++;return calls===1?new Response('not found',{status:503}):calls===2?new Response('{broken'):Response.json({ok:true});}});
  await assert.rejects(pool.json('/terrain/grid.json'));
  await assert.rejects(pool.json('/terrain/grid.json'));
  assert.deepEqual(await pool.json('/terrain/grid.json'),{ok:true});assert.equal(calls,3);
});

test('a new release revalidates regional coverage and material while sharing reads within a view', async () => {
  const browserCache=new Map(),requests=[];let revision=1;
  const fetcher=async(url,options)=>{
    requests.push({url,cache:options.cache});
    if(options.cache!=='force-cache'||!browserCache.has(url))browserCache.set(url,JSON.stringify({revision}));
    return new Response(browserCache.get(url));
  };
  for(const prefix of ['', '/tropnik']){
    const paths=[`${prefix}/terrain-regions/manifest.json`,`${prefix}/terrain-regions/south-sakhalin-v1/surface.png`];
    const before=new MapResourcePool({fetcher});
    for(const path of paths)assert.equal((await before.json(path)).revision,revision);
    revision++;
    const after=new MapResourcePool({fetcher});
    for(const path of paths){
      assert.equal((await after.json(path)).revision,revision,'new pools must not reuse a stale browser response');
      const count=requests.length;await after.json(path);assert.equal(requests.length,count,'the live pool retains checked bytes');
    }
  }
  const remote=new MapResourcePool({fetcher});await remote.get('https://tiles.mapterhorn.com/12/1/1.webp');
  assert.equal(requests.at(-1).cache,'force-cache','unchanged tile sources keep their cache policy');
});

test('semantic invalidation retries settled data and preserves a shared in-flight request', async () => {
  let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
  const pool=new MapResourcePool({fetcher:async()=>{calls++;await gate;return Response.json({valid:calls>1});}});
  const first=pool.json('/terrain/grid.json');pool.invalidate('/terrain/grid.json');
  const shared=pool.json('/terrain/grid.json');release();
  assert.equal((await first).valid,false);assert.equal(await shared,await first);assert.equal(calls,1);
  pool.invalidate('/terrain/grid.json');assert.equal(pool.stats().bytes,0);
  assert.equal((await pool.json('/terrain/grid.json')).valid,true);assert.equal(calls,2);
});

test('streamed resource size and retained byte budget are bounded', async () => {
  const tooLarge=new MapResourcePool({maxResourceBytes:8,fetcher:async()=>new Response('123456789')});
  await assert.rejects(tooLarge.get('/terrain/huge'),/budget/);
  assert.equal(tooLarge.stats().cached,0);
  let calls=0;
  const pool=new MapResourcePool({maxBytes:16,maxResourceBytes:8,fetcher:async()=>{calls++;return new Response('12345678');}});
  for(const path of ['/data/a','/data/b','/data/c'])await pool.get(path);
  assert.ok(pool.stats().bytes<=16);await pool.get('/data/a');assert.equal(calls,4);
});

test('bounded queue rejects extra speculative work and still completes accepted requests', async () => {
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const pool=new MapResourcePool({concurrency:1,maxQueued:1,fetcher:async()=>{await gate;return new Response('ok');}});
  const a=pool.get('/a'),b=pool.get('/b');await assert.rejects(pool.get('/c'),/queue/);release();await Promise.all([a,b]);
});

test('one view cancellation preserves another lease and the completed shared byte cache', async () => {
  let release,requestSignal,calls=0;
  const pool=new MapResourcePool({fetcher:async(_url,{signal})=>{calls++;requestSignal=signal;await new Promise(resolve=>{release=resolve;});return new Response('shared');}});
  const first=new AbortController(),second=new AbortController();
  const a=pool.get('/data/shared',0,first.signal).catch(error=>error),b=pool.get('/data/shared',0,second.signal);
  first.abort();assert.equal((await a).name,'AbortError');assert.equal(requestSignal.aborted,false);assert.equal(calls,1);
  release();assert.equal(new TextDecoder().decode(await b),'shared');second.abort();
  assert.equal(new TextDecoder().decode(await pool.get('/data/shared')),'shared');assert.equal(calls,1);assert.equal(pool.stats().bytes,6);
});

test('the last cancelled lease releases HTTP capacity and cannot remove a newer request for the same URL', async () => {
  const reads=[];
  const pool=new MapResourcePool({concurrency:1,fetcher:(url,{signal})=>new Promise((resolve,reject)=>{
    reads.push({url,signal,resolve,reject});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })});
  const old=new AbortController(),oldResult=pool.get('/data/view',0,old.signal).catch(error=>error);
  old.abort();const replacement=pool.get('/data/view',0);
  assert.equal((await oldResult).name,'AbortError');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads.length,2);assert.equal(reads[0].signal.aborted,true);assert.equal(reads[1].signal.aborted,false);
  assert.equal(pool.has('/data/view'),true,'late cleanup from the old read must retain the replacement');
  reads[1].resolve(new Response('fresh'));assert.equal(new TextDecoder().decode(await replacement),'fresh');
  assert.equal(new TextDecoder().decode(await pool.get('/data/view')),'fresh');assert.equal(reads.length,2);assert.equal(pool.stats().bytes,5);
});

test('cancelled queued views never start and a prefetch keeps its independent shared lease', async () => {
  let release,requestSignal;const urls=[];
  const pool=new MapResourcePool({concurrency:1,fetcher:async(url,{signal})=>{urls.push(url);requestSignal=signal;await new Promise(resolve=>{release=resolve;});return new Response('ok');}});
  const prefetch=pool.get('/data/retained',2),view=new AbortController(),queued=new AbortController();
  const shared=pool.get('/data/retained',0,view.signal).catch(error=>error),waiting=pool.get('/data/obsolete',0,queued.signal).catch(error=>error);
  view.abort();queued.abort();assert.equal((await shared).name,'AbortError');assert.equal((await waiting).name,'AbortError');
  assert.equal(requestSignal.aborted,false);assert.equal(pool.stats().queued,0);assert.equal(pool.has('/data/obsolete'),false);
  release();await prefetch;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(urls,['/data/retained']);
  const already=new AbortController();already.abort();await assert.rejects(pool.get('/data/never',0,already.signal),{name:'AbortError'});assert.equal(pool.has('/data/never'),false);
});

test('route tile plan covers bounds without truncating at the centre', () => {
  const bounds=[40.29,43.64,40.49,43.82],tiles=routeTilePlan(bounds,12);
  assert.ok(tiles.length>1&&tiles.length<=12);
  const z=tiles[0].z,n=2**z;
  for(const lng of [bounds[0],bounds[2]])for(const lat of [bounds[1],bounds[3]]){
    const x=Math.floor((lng+180)/360*n),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);
    assert.ok(tiles.some(t=>t.x===x&&t.y===y));
  }
  assert.ok(routeTilePlan([0,0,150,80],12)[0].z<z);
});

test('antimeridian bounds wrap without out-of-world tiles; invalid coordinates fail closed', () => {
  const tiles=routeTilePlan([179,50,-179,51],12);
  assert.ok(tiles.length&&tiles.length<=12);
  assert.ok(tiles.some(t=>t.x===0));assert.ok(tiles.some(t=>t.x===2**t.z-1));
  assert.ok(tiles.every(t=>t.x>=0&&t.x<2**t.z&&t.y>=0&&t.y<2**t.z));
  for(const invalid of [[0,NaN,1,2],[200,0,201,1],[0,91,1,92],[0,2,1,1],[]])assert.deepEqual(routeTilePlan(invalid),[]);
});


test('HTTP status remains typed for missing-coverage decisions without changing failure cleanup',async()=>{
 for(const status of[404,403,503]){
  const pool=new MapResourcePool({fetcher:async()=>new Response('Unavailable',{status})});
  await assert.rejects(pool.get('/data/source.bin'),error=>error instanceof MapResourceHTTPError&&error.status===status&&error.message===`Preview resource unavailable (${status})`);
  assert.equal(pool.has('/data/source.bin'),false);
 }
 const pool=new MapResourcePool({fetcher:async()=>{throw new TypeError('Network error');}});
 await assert.rejects(pool.get('/data/source.bin'),error=>!(error instanceof MapResourceHTTPError)&&error.message==='Network error');
});
