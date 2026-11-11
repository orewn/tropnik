import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SatelliteTileBatch,satelliteTileInView} from '../lib/map-satellite-tiles.ts';
import {satelliteWarmupPlan,SatelliteViewWarmup} from '../lib/map-satellite-warmup.ts';
import {satelliteStyle,attachSatelliteLayers,satelliteGroundPresentation,SATELLITE_PROVIDERS} from '../lib/map-satellite.ts';

const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('the whole current image grid commits together while a slower tile remains hidden',async()=>{
 const commits=[],batch=new SatelliteTileBatch({current:()=>true,settled:()=>true});
 for(const tile of ['a','b','c'])batch.add(tile,error=>commits.push([tile,error]));
 batch.loaded('a');batch.loaded('b');await turn();assert.deepEqual(commits,[]);
 batch.loaded('c');await turn();assert.deepEqual(commits.map(([tile])=>tile),['a','b','c']);
 assert.ok(commits.every(([,error])=>error===undefined));batch.dispose();
});

test('ready images remain pending during camera movement and commit only at the settled current view',async()=>{
 let settled=false;const commits=[],batch=new SatelliteTileBatch({current:()=>true,settled:()=>settled});
 batch.add('a',error=>commits.push(error));batch.loaded('a');await turn();assert.equal(commits.length,0);
 settled=true;batch.schedule();await turn();assert.deepEqual(commits,[undefined]);batch.dispose();
});

test('an obsolete offscreen request cannot block the new complete viewport',async()=>{
 let current=new Set(['old','new']);const commits=[],batch=new SatelliteTileBatch({current:token=>current.has(token),settled:()=>true});
 batch.add('old',error=>commits.push(['old',error]));batch.add('new',error=>commits.push(['new',error]));
 batch.loaded('new');await turn();assert.equal(commits.length,0);
 current=new Set(['new']);batch.schedule();await turn();assert.deepEqual(commits,[['new',undefined]]);
 batch.remove('old');batch.loaded('old');await turn();assert.deepEqual(commits,[['new',undefined]]);batch.dispose();
});

test('tile failure is sent to the SDK immediately and never converted into ready pixels',async()=>{
 const commits=[],batch=new SatelliteTileBatch({current:()=>true,settled:()=>false});
 batch.add('a',error=>commits.push(['a',error]));batch.add('b',error=>commits.push(['b',error]));
 const error=new Error('network failure');batch.loaded('a',error);
 assert.deepEqual(commits,[['a',error]]);batch.loaded('a');await turn();assert.equal(commits.length,1);batch.dispose();
});

test('stalled current imagery times out, while removal and disposal cancel pending work',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0;
 const commits=[],batch=new SatelliteTileBatch({current:()=>true,settled:()=>true,timeoutMs:100,now:()=>now});
 batch.add('a',error=>commits.push(['a',error]));batch.add('removed',()=>assert.fail('removed tile committed'));
 batch.remove('removed');await Promise.resolve();now=100;t.mock.timers.tick(100);await Promise.resolve();
 assert.equal(commits.length,1);assert.match(commits[0][1].message,/timed out/);
 batch.add('disposed',()=>assert.fail('disposed tile committed'));batch.loaded('disposed');batch.dispose();await Promise.resolve();
 t.mock.timers.tick(1000);assert.equal(commits.length,1);
});

test('pending tile memory is bounded and overflow is an explicit asynchronous error',async()=>{
 const results=[],batch=new SatelliteTileBatch({current:()=>true,settled:()=>true,maxPending:2});
 batch.add('a',error=>results.push(error));batch.add('b',error=>results.push(error));batch.add('c',error=>results.push(error));
 assert.equal(results.length,0,'createTile must return before an admission error can remove its SDK layer');
 await turn();
 assert.equal(results.length,1);assert.match(results[0].message,/limit/);batch.dispose();
});

test('native raster membership handles antimeridian copies and excludes obsolete zoom levels',()=>{
 const view={left:7*256,top:2*256,right:9*256,bottom:4*256,zoom:3};
 for(const x of [7,0])for(const y of [2,3])assert.equal(satelliteTileInView({x,y,z:3},view),true);
 for(const coords of [{x:1,y:2,z:3},{x:7,y:1,z:3},{x:7,y:4,z:3},{x:7,y:2,z:2}])assert.equal(satelliteTileInView(coords,view),false);
});

test('intent warmup has a bounded actual-zoom plan, provider policy and canonical wrapped URLs',()=>{
 const west={west:178,south:64,east:182,north:69};
 const plan=satelliteWarmupPlan(west,18);
 assert.ok(plan.length>0&&plan.length<=8);assert.equal(new Set(plan).size,plan.length);
 assert.ok(plan.every(url=>url.includes('/bluemarble_3857/default/g/8/')));
 assert.deepEqual(satelliteWarmupPlan({west:-182,south:64,east:-178,north:69},18),plan);
 assert.ok(satelliteWarmupPlan({west:30,south:59,east:31,north:60},11).every(url=>url.includes('/s2cloudless_3857/default/g/11/')));
 for(const bad of [{...west,west:NaN},{...west,west:1e30},{...west,south:80,north:70}])assert.deepEqual(satelliteWarmupPlan(bad,10),[]);
 assert.deepEqual(satelliteWarmupPlan(west,10,100),[]);
});

test('intent warmup starts two requests, replaces stale intent, reuses successful URLs and disposes',async()=>{
 const calls=[],load=(url,signal)=>new Promise((resolve,reject)=>{calls.push({url,signal,resolve});signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
 const warm=new SatelliteViewWarmup(load),first={west:178,south:64,east:182,north:69},next={west:30,south:59,east:31,north:60};
 warm.warm(first,8);assert.equal(calls.length,2);warm.warm(first,8);assert.equal(calls.length,2);
 warm.warm(next,11);assert.equal(calls.length,4);assert.ok(calls.slice(0,2).every(call=>call.signal.aborted));
 for(let step=0;step<8;step++){calls.filter(call=>!call.signal.aborted).forEach(call=>call.resolve());await turn();}
 const count=calls.length;assert.ok(count<=10);warm.warm(next,11);await turn();assert.equal(calls.length,count);
 warm.dispose();warm.warm(first,8);assert.equal(calls.length,count);
});

test('staging retains the complete ordinary basemap and does not mutate its definition',()=>{
 const base=JSON.parse(readFileSync(new URL('../public/maps/tropa-style.json',import.meta.url),'utf8')),original=structuredClone(base);
 const staged=satelliteStyle(base,{preserveGround:true});assert.deepEqual(base,original);
 for(const layer of base.layers)assert.deepEqual(staged.layers.find(item=>item.id===layer.id),layer);
 for(const {source} of Object.values(SATELLITE_PROVIDERS)){const layer=staged.layers.find(item=>item.id===source);assert.equal(layer.layout.visibility,'none');assert.equal(layer.paint['raster-opacity'],0);}
});

test('live source staging is idempotent and ground visibility restores only its own layer objects',()=>{
 const layers=new Map([['land',{id:'land',type:'fill'}],['water',{id:'water',type:'fill'}],['hill',{id:'hill',type:'hillshade',layout:{visibility:'none'}}],['russia-outside-mask',{id:'russia-outside-mask',type:'fill'}],['selected-trail',{id:'selected-trail',type:'line'}]]),sources=new Map(),writes=[];
 const map={getStyle:()=>({version:8,layers:[...layers.values()],sources:Object.fromEntries(sources)}),getLayer:id=>layers.get(id),getSource:id=>sources.get(id),
  addSource:(id,value)=>{sources.set(id,value);writes.push(['source',id]);},addLayer:(layer,before)=>{layers.set(layer.id,layer);writes.push(['layer',layer.id,before]);},
  setLayoutProperty:(id,key,value)=>{layers.get(id).layout={...layers.get(id).layout,[key]:value};writes.push(['visibility',id,value]);}};
 attachSatelliteLayers(map);const count=writes.length;attachSatelliteLayers(map);assert.equal(writes.length,count);
 assert.equal(count,4);assert.ok(writes.every(write=>write[0]!=='visibility'));
 const presentation=satelliteGroundPresentation(map);presentation.show();assert.equal(layers.get('water').layout.visibility,'none');
 assert.equal(layers.get('land').layout,undefined);assert.equal(layers.get('russia-outside-mask').layout,undefined);assert.equal(layers.get('selected-trail').layout,undefined);
 presentation.restore();assert.equal(layers.get('water').layout.visibility,'visible');assert.equal(layers.get('hill').layout.visibility,'none');
 presentation.show();layers.set('water',{id:'water',type:'fill',layout:{visibility:'none'}});presentation.restore();assert.equal(layers.get('water').layout.visibility,'none','obsolete cleanup cannot mutate a newer style');
});
