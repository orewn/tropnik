import test from 'node:test';
import assert from 'node:assert/strict';
import {MapResourcePool} from '../lib/map-resource-pool.ts';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{deferAbort=false,...options}={}){
 const reads=[],results=[];
 const pool=new MapResourcePool({...options,fetcher:(url,{signal})=>new Promise((resolve,reject)=>{
  const read={url,signal,done:false,abortRequested:false,finish(){if(read.done)return;read.done=true;if(signal.aborted)reject(signal.reason);else resolve(new Response(url));}};
  signal.addEventListener('abort',()=>{read.abortRequested=true;if(!deferAbort)read.finish();},{once:true});reads.push(read);
 })});
 const get=(...args)=>{const result=pool.get(...args);results.push(result);return result;};
 t.after(async()=>{
  for(let step=0;(pool.stats().active||pool.stats().queued)&&step<100;step++){
   for(const read of reads)read.finish();await turn();
  }
  await Promise.allSettled(results);assert.equal(pool.stats().active,0);assert.equal(pool.stats().queued,0);
 });
 return{pool,reads,get};
}

test('visible demand parks the last preview under pressure and waits for every map owner to release',async t=>{
 const {pool,reads,get}=fixture(t,{deferAbort:true});
 const first=get('/preview/first',2),later=get('/preview/later',2);
 const releaseFirst=pool.holdForeground(),releaseSecond=pool.holdForeground();
 try{
  assert.equal(reads.length,1);assert.equal(reads[0].abortRequested,false,'an already running preview can finish while source discovery still leaves physical capacity');
  const visible=[get('/visible/a',0),get('/visible/b',1),get('/visible/c',0)];
  assert.equal(reads[0].abortRequested,true,'the last background read yields when the third visible source needs its slot');
  assert.equal(reads.filter(read=>!read.done).length,3,'abort cleanup still owns a physical slot');
  assert.equal(reads.filter(read=>read.url.startsWith('/visible/')).length,2);
  reads[0].finish();await turn();
  assert.equal(reads.filter(read=>read.url.startsWith('/visible/')).length,3);assert.equal(pool.stats().active,3);
  for(const read of reads.filter(read=>read.url.startsWith('/visible/')))read.finish();
  await Promise.all(visible);await turn();
  assert.equal(pool.stats().active,0);assert.equal(pool.stats().queued,2,'the map still owns its source/decoder gap');
  releaseFirst();releaseFirst();await turn();assert.equal(pool.stats().active,0,'idempotent release of one map cannot release another map');
  releaseSecond();await turn();assert.equal(pool.stats().active,1);
  for(let step=0;pool.stats().active||pool.stats().queued;step++){
   assert.ok(step<10);for(const read of reads)read.finish();await turn();
  }
  assert.deepEqual((await Promise.all([first,later])).map(bytes=>new TextDecoder().decode(bytes)),['/preview/first','/preview/later']);
  assert.equal(reads.filter(read=>read.url==='/preview/first').length,2,'the original parked promise resumes once after demand ends');
 }finally{releaseFirst();releaseSecond();}
});

test('holding an undiscovered map does not evict admitted previews to fit a smaller queue',async t=>{
 const {pool,reads,get}=fixture(t,{maxQueued:1}),previews=[],controllers=[];
 for(const id of ['a','b','c']){
  previews.push(get(`/preview/${id}`,2));const controller=new AbortController();controllers.push(controller);
  void get(`/preview/${id}`,0,controller.signal).catch(()=>{});
 }
 for(const controller of controllers)controller.abort();await turn();
 const later=get('/preview/later',2),release=pool.holdForeground();
 try{
  assert.equal(reads.length,3);assert.ok(reads.every(read=>!read.abortRequested),'source discovery alone is not physical foreground pressure');
  for(const read of reads)read.finish();
  assert.deepEqual((await Promise.all(previews)).map(bytes=>new TextDecoder().decode(bytes)),['/preview/a','/preview/b','/preview/c']);await turn();
  assert.equal(pool.stats().active,0);assert.equal(pool.stats().queued,1);assert.equal(reads.length,3,'the held map blocks replacement background admissions');
  release();await turn();assert.equal(reads.length,4);reads[3].finish();assert.equal(new TextDecoder().decode(await later),'/preview/later');
 }finally{release();}
});

test('a parked preview promoted during demand preserves the other foreground consumer after cancellation',async t=>{
 const {pool,reads,get}=fixture(t,{concurrency:1,deferAbort:true}),preview=get('/preview/shared',2),release=pool.holdForeground();
 try{
  const trigger=get('/visible/trigger',0);assert.equal(reads[0].abortRequested,true);
  const cancelled=new AbortController(),retained=new AbortController();
  const first=get('/preview/shared',0,cancelled.signal).catch(error=>error),second=get('/preview/shared',1,retained.signal);
  cancelled.abort();assert.equal((await first).name,'AbortError');
  assert.equal(reads.length,1);reads[0].finish();await turn();
  assert.equal(reads[1].url,'/visible/trigger');reads[1].finish();await trigger;await turn();
  assert.equal(reads.length,3,'the retained foreground consumer can resume the shared source while demand is held');
  assert.equal(reads[2].url,'/preview/shared');assert.equal(reads[2].abortRequested,false);reads[2].finish();const [before,after]=await Promise.all([preview,second]);assert.equal(before,after);
  assert.equal(new TextDecoder().decode(after),'/preview/shared');
 }finally{release();}
});

test('parking the last preview for real visible demand preserves the queue bound',async t=>{
 const {pool,reads,get}=fixture(t,{maxQueued:1,deferAbort:true}),preview=get('/preview/original',2);
 const superseded=get('/preview/later',2).catch(error=>error),release=pool.holdForeground();
 try{
  assert.equal(reads[0].abortRequested,false);
  const visible=[get('/visible/a',0),get('/visible/b',1),get('/visible/c',0)];assert.equal(reads[0].abortRequested,true);
  reads[0].finish();await turn();
  assert.equal(pool.stats().active,3);assert.equal(pool.stats().queued,1);
  assert.match((await superseded).message,/superseded/,'new visible demand can supersede an actually full lower-priority queue');
  for(const read of reads.filter(read=>read.url.startsWith('/visible/')))read.finish();await Promise.all(visible);await turn();
  assert.equal(pool.stats().active,0);assert.equal(pool.stats().queued,1);
  release();await turn();const resumed=reads.filter(read=>read.url==='/preview/original'&&!read.done);assert.equal(resumed.length,1);resumed[0].finish();
  assert.equal(new TextDecoder().decode(await preview),'/preview/original');
 }finally{release();}
});

test('a stalled speculative route preview leaves capacity for visible cartography and measured relief',async t=>{
 const {pool,reads,get}=fixture(t);
 for(let index=0;index<24;index++)get(`/preview/${index}`,2);
 const vector=get('/visible/vector',0),relief=get('/visible/relief',1);
 assert.deepEqual(reads.map(read=>read.url),['/preview/0','/visible/vector','/visible/relief'],
  'visible work starts before any old speculative response or its timeout');
 assert.equal(pool.stats().active,3,'the original physical HTTP cap remains unchanged');
 for(const read of reads.filter(read=>read.url.startsWith('/visible/')))read.finish();
 assert.equal(new TextDecoder().decode(await vector),'/visible/vector');
 assert.equal(new TextDecoder().decode(await relief),'/visible/relief');
 assert.equal(reads[0].done,false,'foreground completion cannot depend on the deliberately stalled preview');
 assert.equal(await get('/visible/vector',0),await vector,'completed bytes retain the existing shared cache identity');
 await turn();assert.equal(pool.stats().active,1,'background work cannot immediately occupy the reserved slots again');
});

test('promoting a queued preview dispatches its original shared request without waiting for an unrelated preview',async t=>{
 const {pool,reads,get}=fixture(t);
 get('/preview/stalled',2);const prefetched=get('/preview/selected',2);get('/preview/later',2);
 assert.equal(reads.length,1);
 const selected=get('/preview/selected',0);
 assert.equal(selected,prefetched,'promotion preserves the original shared promise');
 assert.deepEqual(reads.map(read=>read.url),['/preview/stalled','/preview/selected']);
 assert.equal(pool.stats().active,2);assert.equal(pool.stats().queued,1);
 reads[1].finish();assert.equal(new TextDecoder().decode(await selected),'/preview/selected');
 assert.equal(reads[0].done,false);assert.equal(reads.filter(read=>read.url==='/preview/selected').length,1);
});

test('an active preview adopted by the map no longer consumes the speculative reservation',async t=>{
 const {pool,reads,get}=fixture(t);
 const prefetched=get('/preview/selected',2);get('/preview/later',2);
 assert.equal(reads.length,1);assert.equal(get('/preview/selected',0),prefetched);
 assert.deepEqual(reads.map(read=>read.url),['/preview/selected','/preview/later']);
 get('/visible/other',0);assert.equal(pool.stats().active,3);
 assert.equal(reads[0].signal.aborted,false,'promotion does not cancel or duplicate an in-flight source');
});

test('rapidly abandoned selections return their shared preview leases to the background without blocking the next map',async t=>{
 const {pool,reads,get}=fixture(t),previews=[],selections=[],controllers=[];
 for(const id of ['a','b','c']){
  previews.push(get(`/preview/${id}`,2));const controller=new AbortController();controllers.push(controller);
  selections.push(get(`/preview/${id}`,0,controller.signal).catch(error=>error));
 }
 assert.equal(reads.length,3);for(const controller of controllers)controller.abort();
 assert.ok((await Promise.all(selections)).every(error=>error.name==='AbortError'));
 assert.ok(reads.every(read=>!read.signal.aborted),'an independent preview is retained while no foreground read is waiting');
 const visible=get('/visible/next',0),otherVisible=get('/visible/other',1);await turn();
 const current=reads.find(read=>read.url==='/visible/next');
 assert.ok(current,'abandoned promotions must not keep all three slots until the preview timeout');
 assert.equal(reads.filter(read=>read.signal.aborted).length,2,'only excess speculative reads are parked, retaining one background slot');
 assert.ok(pool.stats().active<=3);current.finish();assert.equal(new TextDecoder().decode(await visible),'/visible/next');
 reads.find(read=>read.url==='/visible/other').finish();assert.equal(new TextDecoder().decode(await otherVisible),'/visible/other');
 for(let step=0;pool.stats().active||pool.stats().queued;step++){
  assert.ok(step<10);for(const read of reads)read.finish();await turn();
 }
 assert.deepEqual((await Promise.all(previews)).map(value=>new TextDecoder().decode(value)),['/preview/a','/preview/b','/preview/c'],
  'parking a GET preserves each original shared promise and eventually returns its complete bytes');
 assert.equal(reads.filter(read=>read.url==='/preview/a').length,1);
 assert.equal(reads.filter(read=>read.url==='/preview/b').length,2);
 assert.equal(reads.filter(read=>read.url==='/preview/c').length,2);
});

test('foreground traffic can still use all three existing slots and a single-slot pool cannot deadlock previews',async t=>{
 const current=fixture(t);
 for(let index=0;index<5;index++)current.get(`/visible/${index}`,index%2);
 assert.equal(current.reads.length,3);assert.equal(current.pool.stats().active,3);assert.equal(current.pool.stats().queued,2);
 const single=fixture(t,{concurrency:1});single.get('/preview/one',2);single.get('/preview/two',2);
 assert.equal(single.reads.length,1);single.reads[0].finish();await turn();
 assert.equal(single.reads.length,2);assert.equal(single.pool.stats().active,1);
});

test('cancelling visible demand during abort cleanup keeps parked readmission within a full speculative queue',async t=>{
 const {pool,reads,get}=fixture(t,{maxQueued:1,deferAbort:true}),previews=[],controllers=[];
 for(const id of ['a','b','c']){
  previews.push(get(`/preview/${id}`,2));const controller=new AbortController();controllers.push(controller);
  void get(`/preview/${id}`,0,controller.signal).catch(()=>{});
 }
 for(const controller of controllers)controller.abort();await turn();
 const visibleController=new AbortController(),visible=get('/visible/obsolete',0,visibleController.signal).catch(error=>error);
 const parked=reads.find(read=>read.abortRequested);assert.ok(parked&&!parked.done);
 visibleController.abort();assert.equal((await visible).name,'AbortError');
 const later=get('/preview/later',2).catch(error=>error);assert.equal(pool.stats().queued,1);
 parked.finish();await turn();
 assert.equal(pool.stats().queued,1,'readmission never raises the configured queue bound, even after the waiting map is cancelled');
 assert.match((await later).message,/superseded/,'the later optional preview yields its queued slot to the already leased source');
 for(let step=0;pool.stats().active||pool.stats().queued;step++){
  assert.ok(step<10);for(const read of reads)read.finish();await turn();
 }
 assert.deepEqual((await Promise.all(previews)).map(value=>new TextDecoder().decode(value)),['/preview/a','/preview/b','/preview/c']);
 assert.equal(reads.some(read=>read.url==='/visible/obsolete'||read.url==='/preview/later'),false);
});
