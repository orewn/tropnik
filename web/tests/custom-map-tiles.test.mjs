import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {MAP_RESOURCE_LIMITS} from '../lib/map-config.ts';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const preparedPayloads=state=>(state.stages.ready||0)+(state.stages.halo||0)+state.fetching;
const source=readFileSync(new URL('../lib/custom-map-tiles.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const poolSource=readFileSync(new URL('../lib/map-resource-pool.ts',import.meta.url),'utf8');
const poolCompiled=ts.transpileModule(poolSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
function fixture({files=[],online=true,softwareRaster,sourcePool=false}={}){
  const downloads=[],workers=[],bitmaps=[];
  let pool;
  if(sourcePool){
    const poolModule={exports:{}};
    vm.runInNewContext(poolCompiled,{module:poolModule,exports:poolModule.exports,AbortController,DOMException,TextDecoder,Uint8Array,setTimeout,clearTimeout,
      require(name){if(name==='./map-config.ts')return{MAP_RESOURCE_LIMITS};throw new Error(`Unexpected pool dependency ${name}`);}});
    pool=new poolModule.exports.MapResourcePool({fetcher:(url,{signal})=>new Promise((resolve,reject)=>{
      const request={url,signal,resolve:bytes=>{request.done=true;resolve(new Response(bytes));},reject:error=>{request.done=true;reject(error);}};
      downloads.push(request);signal.addEventListener('abort',()=>{if(request.done)return;request.done=true;request.aborted=true;reject(signal.reason);},{once:true});
    })});
  }
  class Worker {
    constructor(url){this.url=String(url);this.messages=[];this.transfers=[];this.terminated=false;workers.push(this);}
    postMessage(message,transfers){this.messages.push(message);this.transfers.push(transfers);}
    terminate(){this.terminated=true;}
    complete(extra={}){const message=this.messages.shift();assert.ok(message,'a real queued worker message is required');const bitmap={width:512,height:512,closed:false,close(){this.closed=true;}};bitmaps.push(bitmap);this.onmessage({data:{id:message.id,bitmap,labels:[],...extra}});return message;}
  }
  const testModule={exports:{}};
  const navigator={onLine:online};
  vm.runInNewContext(compiled,{module:testModule,exports:testModule.exports,URL,Worker,AbortController,navigator,location:{href:'https://preview.test/app/'},setTimeout,clearTimeout,console,
    require(name){
      if(name==='./map-preload')return {loadPublicBytes:(url,priority,signal)=>pool?pool.get(url,priority,signal):new Promise((resolve,reject)=>{const request={url,resolve,reject,signal,priority};downloads.push(request);signal?.addEventListener('abort',()=>{request.done=true;request.aborted=true;reject(signal.reason);},{once:true});}),loadPublicJSON:async url=>url.includes('manifest')?{files:files.map(path=>({path}))}:{tiles:['https://tiles.openfreemap.org/snapshot/{z}/{x}/{y}.pbf']}};
      if(name==='./map-satellite')return {SATELLITE_PROVIDERS:{'eox-s2':{tiles:'https://tiles.maps.eox.at/s2/{z}/{x}/{y}.jpg'},'eox-bluemarble':{tiles:'https://tiles.maps.eox.at/bm/{z}/{x}/{y}.jpg'}}};
      if(name.endsWith('?worker&url'))return {__esModule:true,default:'/custom-map/workers/tiles.js'};
      throw new Error(`Unmocked runtime dependency ${name}`);
    }});
  const store=new testModule.exports.CustomMapTiles(softwareRaster);
  const resolveDownloads=()=>{for(const request of downloads.filter(item=>!item.done)){request.done=true;request.resolve(new Uint8Array([1,2,3,4]).buffer);}};
  return{store,downloads,workers,bitmaps,navigator,resolveDownloads,pool,createStore:()=>new testModule.exports.CustomMapTiles(softwareRaster),key:testModule.exports.customTileKey};
}
const request=(x=0)=>({kind:'overview',z:4,x,y:5});

test('a map raster policy reaches every worker job without changing source identity or bitmap caching',async t=>{
  let expectedSources;
  for(const softwareRaster of [undefined,false,true]){
    const env=fixture({softwareRaster});t.after(()=>env.store.destroy());
    const requests=[request(2),{kind:'vector',z:18,x:1605,y:3207},{kind:'relief',z:18,x:1605,y:3207}];
    env.store.pin(requests.map(env.key));const pending=requests.map(value=>env.store.load(value));await turn();
    assert.equal(env.downloads.length,3);env.resolveDownloads();await turn();
    const jobs=[];
    for(let index=0;index<requests.length;index++){jobs.push(env.workers[0].complete());await turn();}
    const tiles=await Promise.all(pending),sources=env.downloads.map(item=>item.url).sort();
    assert.ok(jobs.every(job=>job.softwareRaster===(softwareRaster===true)));
    assert.deepEqual(jobs.map(job=>job.kind).sort(),['raster','relief','vector']);
    assert.equal(jobs.find(job=>job.kind==='vector').sourceZ,14);assert.equal(jobs.find(job=>job.kind==='relief').sourceZ,12);
    if(expectedSources)assert.deepEqual(sources,expectedSources);else expectedSources=sources;
    for(let index=0;index<tiles.length;index++){
      assert.equal(tiles[index].key,env.key(requests[index]));assert.equal(tiles[index].bitmap.width,512);assert.equal(tiles[index].bitmap.height,512);
      assert.equal(await env.store.load(requests[index]),tiles[index],'Repeated consumers must keep the same cached bitmap');
    }
    assert.equal(env.downloads.length,3);assert.equal(env.workers.length,1);assert.equal(env.workers[0].messages.length,0);
    assert.equal(env.store.snapshot().pending,0);assert.equal(env.store.snapshot().resident,3);
  }
});

test('a paused map fetches nothing and resumes one actual decoder with an HTTP asset URL',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());env.store.setActive(false);
  const promise=env.store.load(request());env.store.pin([env.key(request())]);await turn();
  assert.equal(env.downloads.length,0);assert.equal(env.workers.length,0);
  env.store.setActive(true);await turn();assert.equal(env.downloads.length,1);
  env.resolveDownloads();await turn();assert.equal(env.workers.length,1);
  assert.equal(env.workers[0].url,'https://preview.test/custom-map/workers/tiles.js');
  env.workers[0].complete();const tile=await promise;assert.equal(tile.bitmap.width,512);assert.equal(env.store.snapshot().pending,0);
});

test('rapid tile demand bounds both network concurrency and decoded-source backlog',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());
  const requests=Array.from({length:40},(_,i)=>request(i));env.store.pin(requests.map(env.key));
  const outcomes=requests.map(value=>env.store.load(value).catch(error=>error));await turn();
  assert.equal(env.downloads.length,3);assert.equal(env.store.snapshot().fetching,3);
  for(let i=0;i<4;i++){env.resolveDownloads();await turn();}
  const paused=env.store.snapshot();assert.equal(paused.decoding,true);assert.ok(preparedPayloads(paused)<=6);assert.equal(env.workers[0].messages.length,1);
  assert.ok(env.downloads.length<=7,'a slow decoder must exert back pressure on downloads');
  env.store.destroy();await Promise.all(outcomes);assert.equal(env.workers[0].terminated,true);
});

test('a cold mixed viewport starts measured relief alongside vectors within the original three slots',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());env.store.setActive(false);
  const vectors=Array.from({length:32},(_,i)=>({kind:'vector',z:18,x:1605+i,y:3207}));
  const relief=Array.from({length:32},(_,i)=>({kind:'relief',z:18,x:1605+i,y:3207}));
  const requests=[...vectors,...relief],outcomes=requests.map(value=>env.store.load(value).catch(error=>error));env.store.pin(requests.map(env.key));
  env.store.setActive(true);await turn();assert.equal(env.downloads.length,3);assert.equal(env.store.snapshot().fetching,3);
  assert.ok(env.downloads.some(value=>value.url.includes('mapterhorn')),'DEM acquisition must not wait for all 32 vector sources');
  assert.ok(env.downloads.some(value=>value.url.includes('openfreemap')));
  env.resolveDownloads();await turn();const first=env.workers[0].complete();await turn();const second=env.workers[0].complete();await turn();
  assert.deepEqual([first.kind,second.kind].sort(),['relief','vector'],'the single decoder also shares capacity between demanded layers');
  assert.ok(env.store.snapshot().fetching<=3);assert.ok(preparedPayloads(env.store.snapshot())<=6);
  env.store.destroy();await Promise.all(outcomes);
});

test('a stalled DEM halo releases logical capacity for a queued primary while physical reads remain capped at three',async t=>{
  const env=fixture({sourcePool:true}),outcomes=[];
  t.after(async()=>{env.store.destroy();await Promise.all(outcomes);});
  const first={kind:'relief',z:12,x:100,y:200},second={kind:'relief',z:12,x:103,y:200},third={kind:'relief',z:12,x:106,y:200};
  const vector={kind:'vector',z:12,x:110,y:200};
  env.store.pin([first,second,third,vector].map(env.key));
  outcomes.push(env.store.load(first).catch(error=>error));await turn();
  env.downloads[0].resolve(new Uint8Array([1,2,3,4]).buffer);await turn();
  const stalled=env.downloads.find(item=>item.url==='https://tiles.mapterhorn.com/12/99/200.webp');
  assert.ok(stalled&&!stalled.done,'the scenario must hold an actual first halo response open');
  for(const tile of [second,third,vector])outcomes.push(env.store.load(tile).catch(error=>error));
  await turn();
  assert.equal(env.downloads.filter(item=>!item.done).length,3);
  const primary=env.downloads.find(item=>item.url==='https://tiles.mapterhorn.com/12/103/200.webp');
  assert.ok(primary&&!primary.done);
  primary.resolve(new Uint8Array([5,6,7,8]).buffer);await turn();
  assert.ok(env.downloads.some(item=>item.url==='https://tiles.openfreemap.org/snapshot/12/110/200.pbf'),
    'a completed DEM primary must yield its read slot to the queued vector, without awaiting its remaining eight neighbours');
  assert.equal(stalled.done,undefined,'the vector starts while the earlier real halo is still stalled');
  assert.ok(env.downloads.filter(item=>!item.done).length<=3,'logical progress must not raise physical HTTP concurrency');
  assert.ok(env.pool.stats().active<=3);
  const state=env.store.snapshot();
  assert.ok(preparedPayloads(state)<=6,'partially assembled halos consume payload backpressure');
});

test('overzoom siblings sharing a stalled DEM leave physical capacity for unrelated visible sources',async t=>{
  const env=fixture({sourcePool:true}),outcomes=[];
  t.after(async()=>{env.store.destroy();await Promise.all(outcomes);});
  const siblings=[1601,1602,1603].map(x=>({kind:'relief',z:18,x,y:3207}));
  const vectors=[110,111].map(x=>({kind:'vector',z:12,x,y:200}));
  env.store.pin([...siblings,...vectors].map(env.key));
  for(const tile of [...siblings,...vectors])outcomes.push(env.store.load(tile).catch(error=>error));
  await turn();
  assert.equal(env.downloads.filter(item=>item.url==='https://tiles.mapterhorn.com/12/25/50.webp').length,1,
    'three overzoom children share a single actual DEM read');
  assert.equal(env.downloads.filter(item=>item.url.includes('openfreemap')).length,2,
    'waiters for the same parent must not occupy the other two physical read slots');
  assert.equal(env.downloads.filter(item=>!item.done).length,3);
  assert.equal(env.pool.stats().active,3);
  assert.ok(preparedPayloads(env.store.snapshot())<=6);
});

test('cancelling parked partial halos releases their payloads without starting neighbours or interrupting retained primaries',async t=>{
  const env=fixture(),outcomes=[];
  t.after(async()=>{env.store.destroy();await Promise.all(outcomes);});
  const relief=[100,103,106].map(x=>({kind:'relief',z:12,x,y:200}));
  const overview=[request(10),request(11),request(12)];
  env.store.pin([...relief,...overview].map(env.key));
  const abandoned=relief.map(tile=>env.store.load(tile).catch(error=>error));outcomes.push(...abandoned);
  await turn();
  const retained=overview.map(tile=>env.store.load(tile));outcomes.push(...retained);
  env.resolveDownloads();await turn();
  assert.equal(env.store.snapshot().stages.halo,3,'all three real primary buffers must be parked behind new visible work');
  assert.equal(env.downloads.filter(item=>!item.done).length,3);
  const before=env.downloads.length;
  env.store.pin(overview.map(env.key));
  assert.ok((await Promise.all(abandoned)).every(error=>/view changed/.test(error.message)));
  assert.equal(env.store.snapshot().stages.halo||0,0);
  assert.ok(env.downloads.filter(item=>!item.done).every(item=>item.url.startsWith('/maps/russia-relief/')&&!item.signal.aborted),
    'retained primary requests keep their own leases');
  env.resolveDownloads();await turn();
  for(let index=0;index<overview.length;index++){env.workers[0].complete();await turn();}
  assert.equal((await Promise.all(retained)).length,3);
  assert.equal(env.downloads.length,before,'unpinning a parked DEM cannot start any of its eight halo reads');
  assert.equal(env.store.snapshot().pending,0);
  assert.equal(env.store.snapshot().errors.length,0);
});

test('cancelling one map preserves a shared primary-halo source lease and all eight real neighbours for the other map',async t=>{
  const env=fixture({sourcePool:true}),other=env.createStore(),outcomes=[];
  t.after(async()=>{env.store.destroy();other.destroy();await Promise.all(outcomes);});
  const original={kind:'relief',z:12,x:100,y:200},neighbour={kind:'relief',z:12,x:99,y:200};
  env.store.pin([env.key(original)]);other.pin([env.key(neighbour)]);
  const abandoned=env.store.load(original).catch(error=>error);outcomes.push(abandoned);await turn();
  env.downloads[0].resolve(new Uint8Array([1,2,3,4]).buffer);await turn();
  const shared=env.downloads.find(item=>item.url==='https://tiles.mapterhorn.com/12/99/200.webp');
  assert.ok(shared&&!shared.done);
  const kept=other.load(neighbour);outcomes.push(kept);await turn();
  assert.equal(env.downloads.filter(item=>item.url===shared.url).length,1,'the halo and the other map primary must share actual HTTP');
  env.store.pin([]);assert.match((await abandoned).message,/view changed/);
  assert.equal(shared.signal.aborted,false,'another consumer retains the shared request');
  let payload;
  for(let index=0;index<30&&!payload;index++){
    assert.ok(env.downloads.filter(item=>!item.done).length<=3);
    assert.ok(preparedPayloads(other.snapshot())<=6);
    env.resolveDownloads();await turn();
    if(env.workers[0]?.messages.length)payload=env.workers[0].complete();
  }
  assert.ok(payload,'the retained neighbour must complete under bounded scheduling');
  const tile=await kept;
  assert.equal(tile.key,env.key(neighbour));
  const expected=[];
  for(const dy of [-1,0,1])for(const dx of [-1,0,1])if(dx||dy)expected.push(`${dx},${dy}:https://tiles.mapterhorn.com/12/${99+dx}/${200+dy}.webp`);
  assert.deepEqual(Array.from(payload.halo.tiles,item=>`${item.dx},${item.dy}:${item.sourceKey}`).sort(),expected.sort());
  assert.equal(payload.halo.missing.length,0,'fair scheduling must not skip required measured neighbours');
  assert.equal(new Set(env.downloads.map(item=>item.url)).size,env.downloads.length,'shared cache keeps each actual source download unique');
  const buffers=new Set([payload.bytes,...payload.halo.tiles.map(item=>item.bytes)]);
  assert.ok([...buffers].reduce((sum,bytes)=>sum+bytes.byteLength,0)<=8*1024*1024);
  assert.equal(env.store.resident,0,'late shared responses cannot republish the abandoned tile');
  assert.equal(other.pending,0);
});

test('duplicate consumers share one decode and source bytes stay owned by the fetch pool',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());const r=request();env.store.pin([env.key(r)]);
  const a=env.store.load(r),b=env.store.load(r);assert.equal(a,b);await turn();
  const original=new Uint8Array([7,8,9]).buffer;env.downloads[0].done=true;env.downloads[0].resolve(original);await turn();
  const submitted=env.workers[0].messages[0];assert.notEqual(submitted.bytes,original);assert.deepEqual([...new Uint8Array(submitted.bytes)],[7,8,9]);
  env.workers[0].complete();assert.equal(await a,await b);assert.equal(env.store.resident,1);
  assert.equal((await env.store.load(r)).bitmap,env.bitmaps[0]);assert.equal(env.downloads.length,1);
});

test('view changes reject unstarted work and destruction releases images without a late restart',async()=>{
  const env=fixture();env.store.setActive(false);const abandoned=env.store.load(request(1)).catch(error=>error);
  env.store.pin([]);assert.match((await abandoned).message,/view changed/);
  env.store.setActive(true);const pending=env.store.load(request(2)).catch(error=>error);await turn();
  env.store.destroy();env.resolveDownloads();await turn();assert.match((await pending).message,/released/);assert.equal(env.workers.length,0);assert.equal(env.store.pending,0);
});

test('a new view cancels obsolete reads and reclaims all three fetch slots without waiting for network timeouts',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());
  const oldRequests=[request(1),request(2),request(3)],newRequests=[request(4),request(5),request(6)];
  env.store.pin(oldRequests.map(env.key));const old=oldRequests.map(value=>env.store.load(value).catch(error=>error));await turn();
  assert.equal(env.downloads.length,3);assert.ok(env.downloads.every(value=>!value.signal.aborted));
  env.store.pin(newRequests.map(env.key));const current=newRequests.map(value=>env.store.load(value));await turn();
  assert.ok(env.downloads.slice(0,3).every(value=>value.signal.aborted&&value.aborted));
  assert.equal(env.downloads.length,6,'new reads start before any abandoned source resolves');
  assert.equal(env.store.snapshot().fetching,3);assert.ok((await Promise.all(old)).every(error=>/view changed/.test(error.message)));
  env.resolveDownloads();await turn();for(let index=0;index<3;index++){env.workers[0].complete();await turn();}
  assert.equal((await Promise.all(current)).length,3);assert.equal(env.store.pending,0);assert.equal(env.store.snapshot().errors.length,0,'expected cancellation is not a visible map failure');
});

test('overzoomed vector and DEM children share the correct real parent, also across the dateline',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());
  const child={kind:'vector',z:18,x:262145,y:100001};env.store.pin([env.key(child)]);
  const result=env.store.load(child);await turn();
  assert.equal(env.downloads[0].url,'https://tiles.openfreemap.org/snapshot/14/0/6250.pbf');env.resolveDownloads();await turn();
  const payload=env.workers[0].complete();await result;
  assert.equal(payload.z,18);assert.equal(payload.x,262145);assert.equal(payload.sourceZ,14);assert.equal(payload.sourceKey,env.downloads[0].url);
  const dem={kind:'relief',z:18,x:-1,y:100001};env.store.pin([env.key(dem)]);
  const elevation=env.store.load(dem);await turn();assert.equal(env.downloads[1].url,'https://tiles.mapterhorn.com/12/4095/1562.webp');
  env.resolveDownloads();await turn();assert.equal(env.downloads[2].url,'https://tiles.mapterhorn.com/12/0/1562.webp');
  env.resolveDownloads();await turn();const second=env.workers[0].complete();await elevation;assert.equal(second.sourceZ,12);assert.equal(second.x,-1);
  assert.equal(second.halo.tiles.length,1);assert.equal(second.halo.tiles[0].dx,1);assert.equal(second.halo.tiles[0].dy,0);
});

test('interior overzoom children request no invisible halo while edge children use real wrapped offsets',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());const interior={kind:'relief',z:18,x:1605,y:3207};env.store.pin([env.key(interior)]);
  const result=env.store.load(interior);await turn();env.resolveDownloads();await turn();const payload=env.workers[0].complete();await result;
  assert.equal(env.downloads.length,1);assert.equal(payload.halo.tiles.length,0);assert.equal(payload.halo.missing.length,0);
  const polar={kind:'relief',z:12,x:-1,y:0};env.store.pin([env.key(polar)]);const edge=env.store.load(polar);await turn();
  for(let i=0;i<6;i++){env.resolveDownloads();await turn();}
  const halo=env.workers[0].complete().halo;await edge;
  assert.equal(halo.tiles.length,5);assert.equal(halo.missing.length,3);assert.ok(halo.missing.every(item=>item.reason==='coverage'&&item.dy===-1));
  assert.ok(env.downloads.slice(1).every(item=>!/\/-\d+\//.test(item.url)),'negative X is canonicalized and Y never wraps');
  assert.ok(halo.tiles.some(item=>item.sourceKey==='https://tiles.mapterhorn.com/12/0/1.webp'&&item.dx===1&&item.dy===1));
});

test('halo transfers preserve three active reads, six waiting jobs and one decoder under rapid demand',async()=>{
  const env=fixture(),requests=Array.from({length:20},(_,i)=>({kind:'relief',z:12,x:100+i,y:200}));env.store.pin(requests.map(env.key));
  const outcomes=requests.map(value=>env.store.load(value).catch(error=>error));await turn();
  let maximum=0;
  for(let i=0;i<40;i++){
    const active=env.downloads.filter(item=>!item.done).length;maximum=Math.max(maximum,active);assert.ok(active<=3,'halo does not bypass the original HTTP limit');
    const snapshot=env.store.snapshot();assert.ok(preparedPayloads(snapshot)<=6);
    env.resolveDownloads();await turn();
  }
  assert.equal(maximum,3);assert.equal(env.workers.length,1);assert.equal(env.workers[0].messages.length,1);
  assert.equal(env.store.snapshot().stages.ready,6);assert.equal(env.store.snapshot().fetching,0);
  assert.equal(env.downloads.length,7*9,'one decoding job plus six waiting payloads exert real source backpressure');
  env.store.destroy();await Promise.all(outcomes);
});

test('the whole primary and real halo payload has an 8 MiB bound, with explicit budget gaps',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());const tile={kind:'relief',z:12,x:100,y:200};env.store.pin([env.key(tile)]);
  const result=env.store.load(tile);await turn();
  for(const size of [4*1024*1024,2*1024*1024,2*1024*1024]){
    const download=env.downloads.find(item=>!item.done);assert.ok(download);download.done=true;download.resolve(new ArrayBuffer(size));await turn();
  }
  const message=env.workers[0].complete();await result;
  assert.equal(env.downloads.length,3);assert.equal(message.halo.tiles.length,2);assert.equal(message.halo.missing.length,6);assert.ok(message.halo.missing.every(item=>item.reason==='budget'));
  const buffers=new Set([message.bytes,...message.halo.tiles.map(item=>item.bytes)]);assert.equal([...buffers].reduce((n,buffer)=>n+buffer.byteLength,0),8*1024*1024);
});

test('z0 world copies share the primary buffer and transfer it only once',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());const tile={kind:'relief',z:0,x:-1,y:0};env.store.pin([env.key(tile)]);
  const result=env.store.load(tile);await turn();env.resolveDownloads();await turn();const message=env.workers[0].complete();await result;
  assert.equal(env.downloads.length,1);assert.equal(message.halo.tiles.length,2);assert.ok(message.halo.tiles.every(item=>item.bytes===message.bytes));assert.equal(env.workers[0].transfers[0].length,1);
});

test('offline missing neighbours keep the real primary and expose partial coverage without fake tile errors',async t=>{
  const env=fixture({files:['terrain/tiles/12/100/200.png'],online:false});t.after(()=>env.store.destroy());const tile={kind:'relief',z:12,x:100,y:200};env.store.pin([env.key(tile)]);
  const result=env.store.load(tile);await turn();assert.equal(env.downloads[0].url,'/offline-map/terrain/tiles/12/100/200.png');env.resolveDownloads();await turn();
  const payload=env.workers[0].messages[0],reliefCoverage={sourceSize:256,required:8,available:0,missing:payload.halo.missing,resampled:[],missingDataFilled:false};
  env.workers[0].complete({reliefCoverage});const ready=await result;
  assert.equal(env.downloads.length,1);assert.equal(ready.local,true);assert.equal(ready.reliefCoverage.missing.length,8);assert.ok(ready.reliefCoverage.missing.every(item=>item.reason==='unavailable'));assert.equal(env.store.snapshot().errors.length,0);
  assert.equal(ready.bitmap.closed,false);env.store.pin([]);assert.equal(ready.bitmap.closed,true);assert.equal(env.store.resident,0,'a later visit can retry unavailable real neighbours');
});

test('archive gaps use verified numeric-reduction metadata, and view cancellation stops further halo reads',async t=>{
  const env=fixture({files:['terrain/tiles/12/100/200.png']});t.after(()=>env.store.destroy());const tile={kind:'relief',z:18,x:100*64,y:200*64+5};env.store.pin([env.key(tile)]);
  const result=env.store.load(tile);await turn();env.resolveDownloads();await turn();assert.equal(env.downloads[1].url,'https://tiles.mapterhorn.com/12/99/200.webp');env.resolveDownloads();await turn();
  const payload=env.workers[0].complete();await result;assert.equal(payload.halo.tiles[0].reduceToArchive,true);
  const abandoned={kind:'relief',z:12,x:101,y:200};env.store.pin([env.key(abandoned)]);const pending=env.store.load(abandoned).catch(error=>error);await turn();env.resolveDownloads();await turn();
  const count=env.downloads.length;env.store.pin([]);assert.match((await pending).message,/view changed/);env.resolveDownloads();await turn();
  assert.equal(env.downloads.length,count,'an abandoned parent does not start the other seven neighbour requests');assert.equal(env.store.snapshot().fetching,0);assert.equal(env.workers[0].messages.length,0);
});

test('failed worker is replaced on a later tile and errors remain bounded diagnostics',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());const bad=env.store.load(request(0)).catch(error=>error);await turn();env.resolveDownloads();await turn();
  env.workers[0].onerror({message:'Decode context unavailable'});assert.match((await bad).message,/Decode context/);assert.equal(env.workers[0].terminated,true);
  const good=env.store.load(request(1));await turn();env.resolveDownloads();await turn();assert.equal(env.workers.length,2);env.workers[1].complete();await good;
  assert.equal(env.store.snapshot().errors[0].message,'Decode context unavailable');assert.equal(env.store.pending,0);
});

test('paint zoom separates output cache entries while preserving geographic XYZ and the actual source parent',async t=>{
  const env=fixture({sourcePool:true});t.after(()=>env.store.destroy());const tile={kind:'vector',z:17,x:802,y:1603},variant={...tile,paintZoom:18};
  assert.equal(env.key(tile),env.key({...tile,paintZoom:17}));assert.notEqual(env.key(tile),env.key(variant));env.store.pin([env.key(tile),env.key(variant)]);
  const original=env.store.load(tile),styled=env.store.load(variant);assert.notEqual(original,styled);await turn();
  assert.equal(env.downloads.length,1);assert.ok(env.downloads.every(item=>item.url==='https://tiles.openfreemap.org/snapshot/14/100/200.pbf'));
  env.resolveDownloads();await turn();const first=env.workers[0].complete(),second=env.workers[0].complete();
  const [a,b]=await Promise.all([original,styled]);assert.notEqual(a.bitmap,b.bitmap);assert.equal(env.store.resident,2);
  assert.equal(first.paintZoom,17);assert.equal(second.paintZoom,18);assert.equal(second.z,17);assert.equal(second.x,802);assert.equal(second.y,1603);assert.equal(second.sourceZ,14);assert.equal(second.sourceKey,first.sourceKey);
  assert.equal((await env.store.load({...tile,paintZoom:17})).bitmap,a.bitmap);assert.equal((await env.store.load(variant)).bitmap,b.bitmap);assert.equal(env.downloads.length,1,'paint variants share the real source cache while keeping separate bitmaps');
});

test('boundary visibility has distinct cached bitmaps while omitted and explicit true share one output',async t=>{
  const env=fixture({sourcePool:true});t.after(()=>env.store.destroy());const tile={kind:'vector',z:17,x:802,y:1603},hidden={...tile,boundaries:false};
  assert.equal(env.key(tile),env.key({...tile,boundaries:true}));assert.notEqual(env.key(tile),env.key(hidden));env.store.pin([env.key(tile),env.key(hidden)]);
  const enabled=env.store.load(tile),disabled=env.store.load(hidden);assert.notEqual(enabled,disabled);await turn();env.resolveDownloads();await turn();
  const first=env.workers[0].complete(),second=env.workers[0].complete();const [a,b]=await Promise.all([enabled,disabled]);
  assert.equal(first.boundaries,true);assert.equal(second.boundaries,false);assert.equal(second.sourceKey,first.sourceKey);assert.equal(second.sourceZ,first.sourceZ);
  assert.notEqual(a.bitmap,b.bitmap);assert.equal(env.store.resident,2);
  assert.equal((await env.store.load({...tile,boundaries:true})).bitmap,a.bitmap);assert.equal((await env.store.load(hidden)).bitmap,b.bitmap);assert.equal(env.downloads.length,1,'boundary styling does not duplicate the actual parent download');
});

test('invalid paint zoom cannot consume a queue slot or start a source request',async t=>{
  const env=fixture();t.after(()=>env.store.destroy());
  for(const paintZoom of [16,17.5,19,-1,NaN,Infinity,null])await assert.rejects(env.store.load({kind:'vector',z:17,x:802,y:1603,paintZoom}),/paint zoom/);
  assert.equal(env.store.pending,0);assert.equal(env.downloads.length,0);assert.equal(env.workers.length,0);
});

test('160 pending jobs fit the bounded full viewport contract and the next request is rejected',async()=>{
  const env=fixture();env.store.setActive(false);const requests=Array.from({length:160},(_,i)=>request(i));env.store.pin(requests.map(env.key));
  const outcomes=requests.map(value=>env.store.load(value).catch(error=>error));assert.equal(env.store.pending,160);
  await assert.rejects(env.store.load(request(160)),/queue is full/);assert.equal(env.store.pending,160);assert.equal(env.downloads.length,0);
  env.store.destroy();await Promise.all(outcomes);assert.equal(env.store.pending,0);
});

test('pinned old and new viewports retain at most 288 bitmaps and fall back to 96 after unpinning',async()=>{
  const env=fixture(),requests=Array.from({length:289},(_,i)=>request(i));env.store.pin(requests.map(env.key));
  const prepare=async batch=>{
    const results=batch.map(value=>env.store.load(value).catch(error=>error));let completed=0;
    for(let turnNumber=0;completed<batch.length&&turnNumber<batch.length+10;turnNumber++){
      env.resolveDownloads();await turn();const worker=env.workers[0];while(worker?.messages.length){worker.complete();completed++;}
      const state=env.store.snapshot();assert.ok(state.fetching<=3);assert.ok(preparedPayloads(state)<=6);
    }
    assert.equal(completed,batch.length);return Promise.all(results);
  };
  try{
    for(let start=0;start<288;start+=96){const results=await prepare(requests.slice(start,start+96));assert.ok(results.every(tile=>tile.bitmap));}
    assert.equal(env.store.resident,288);assert.equal(env.bitmaps.filter(bitmap=>!bitmap.closed).length,288);
    const [overflow]=await prepare(requests.slice(288));assert.match(overflow.message,/unavailable/);assert.equal(env.store.resident,288);assert.equal(env.bitmaps.at(-1).closed,true);
    env.store.pin([]);assert.equal(env.store.resident,96);assert.equal(env.bitmaps.filter(bitmap=>!bitmap.closed).length,96);
  }finally{env.store.destroy();}
  assert.ok(env.bitmaps.every(bitmap=>bitmap.closed));
});
