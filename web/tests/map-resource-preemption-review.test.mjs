import test from 'node:test';
import assert from 'node:assert/strict';
import {MapResourcePool} from '../lib/map-resource-pool.ts';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const text=bytes=>new TextDecoder().decode(bytes);

function fixture(t,{deferAbort=false,maxQueued}={}){
 const reads=[],results=[];let active=0,peak=0;
 const pool=new MapResourcePool({...(maxQueued===undefined?{}:{maxQueued}),fetcher:(url,{signal})=>new Promise((resolve,reject)=>{
  active++;peak=Math.max(peak,active);
  const read={url,signal,done:false,abortRequested:false,
   finish(){if(read.done)return;read.done=true;active--;if(signal.aborted)reject(signal.reason);else resolve(new Response(url));},
   releaseAbort(){if(read.abortRequested)read.finish();},
  };
  signal.addEventListener('abort',()=>{if(read.done)return;read.abortRequested=true;if(!deferAbort)read.releaseAbort();},{once:true});
  reads.push(read);
 })});
 const get=(...args)=>{const result=pool.get(...args);results.push(result);void result.catch(()=>{});return result;};
 t.after(async()=>{
  for(let step=0;(pool.stats().active||pool.stats().queued)&&step<100;step++){
   for(const read of reads){read.releaseAbort();read.finish();}await turn();
  }
  await Promise.allSettled(results);
  assert.equal(pool.stats().active,0);assert.equal(pool.stats().queued,0);assert.equal(active,0);assert.ok(peak<=3);
 });
 return{pool,reads,get,get active(){return active;},get peak(){return peak;}};
}

function adoptedPreviews(env){
 const previews=new Map(),controllers=new Map(),selections=[];
 for(const id of ['a','b','c']){
  const url=`/review/${id}`;
  previews.set(id,env.get(url,2));
  const controller=new AbortController();controllers.set(id,controller);
  selections.push(env.get(url,0,controller.signal).catch(error=>error));
 }
 assert.equal(env.reads.length,3);return{previews,controllers,selections};
}

test('preemption preserves a remaining lower-priority foreground lease after its highest-priority owner cancels',async t=>{
 const env=fixture(t),{previews,controllers,selections}=adoptedPreviews(env);
 const retainedController=new AbortController(),retained=env.get('/review/a',1,retainedController.signal);
 for(const controller of controllers.values())controller.abort();
 assert.ok((await Promise.all(selections)).every(error=>error.name==='AbortError'));
 const next=env.get('/review/next',0);await turn();
 const current=env.reads.find(read=>read.url==='/review/next');assert.ok(current,'New visible work starts while old speculative responses are stalled');
 const required=env.reads.find(read=>read.url==='/review/a');
 assert.equal(required.signal.aborted,false,'A surviving priority-1 map lease is required work, even when a priority-0 owner has gone');
 assert.equal(env.reads.filter(read=>read.abortRequested).length,1,'Only the excess speculative source may be parked');
 required.finish();current.finish();
 assert.equal(text(await retained),'/review/a');assert.equal(await retained,await previews.get('a'),'The remaining consumer and independent preview still share complete bytes');
 assert.equal(text(await next),'/review/next');
 assert.equal(env.reads.filter(read=>read.url==='/review/a').length,1,'The shared required GET must not be restarted');
});

test('reattaching a foreground consumer while a parked GET drains preserves its promise and physical concurrency',async t=>{
 const env=fixture(t,{deferAbort:true}),{previews,controllers,selections}=adoptedPreviews(env);
 for(const controller of controllers.values())controller.abort();await Promise.all(selections);
 const next=env.get('/review/next',0),parked=env.reads.filter(read=>read.abortRequested);
 assert.equal(parked.length,1,'Only one queued foreground request justifies parking one source');assert.equal(env.active,3);assert.equal(env.pool.stats().active,3);
 const chosen=parked[0],id=chosen.url.split('/').at(-1),controller=new AbortController();
 const selected=env.get(chosen.url,0,controller.signal);
 assert.equal(env.reads.filter(read=>read.url===chosen.url).length,1,'An aborted but draining request still owns its physical HTTP slot');
 assert.equal(env.pool.stats().active,3);assert.equal(env.active,3);
 for(let step=0;env.reads.filter(read=>read.url===chosen.url).length<2&&step<4;step++){
  for(const read of env.reads)read.releaseAbort();await turn();
 }
 const restarted=env.reads.filter(read=>read.url===chosen.url).at(-1),current=env.reads.find(read=>read.url==='/review/next');
 assert.notEqual(restarted,chosen);assert.ok(current);assert.equal(restarted.signal.aborted,false);
 assert.equal(env.reads.filter(read=>read.url===chosen.url).length,2,'A parked read resumes once after its previous transport has released the slot');
 assert.ok(env.pool.stats().active<=3);assert.ok(env.active<=3);assert.ok(env.peak<=3);
 restarted.finish();current.finish();
 const selectedBytes=await selected;
 assert.equal(text(selectedBytes),chosen.url);assert.equal(selectedBytes,await previews.get(id),'The original preview promise survives parking and later promotion');
 assert.equal(await env.get(chosen.url,0),selectedBytes,'Only the completed restarted response enters the shared cache');
 assert.equal(text(await next),'/review/next');
});

test('parking abandoned promotions preserves a one-entry waiting budget and all original preview promises',async t=>{
 const env=fixture(t,{maxQueued:1}),{previews,controllers,selections}=adoptedPreviews(env);
 for(const controller of controllers.values())controller.abort();await Promise.all(selections);
 const next=env.get('/review/next',0);await turn();
 const current=env.reads.find(read=>read.url==='/review/next');assert.ok(current);
 assert.ok(env.pool.stats().queued<=1,'Readmission of parked GETs cannot overflow the configured queue');
 assert.equal(env.reads.filter(read=>read.abortRequested).length,1,'Reclaim only the physical slot needed by actual waiting demand');
 assert.ok(env.active<=3);current.finish();assert.equal(text(await next),'/review/next');
 for(let step=0;(env.pool.stats().active||env.pool.stats().queued)&&step<20;step++){
  for(const read of env.reads)read.finish();await turn();
  assert.ok(env.pool.stats().queued<=1);assert.ok(env.pool.stats().active<=3);
 }
 assert.deepEqual((await Promise.all(previews.values())).map(text),['/review/a','/review/b','/review/c']);
 assert.equal(env.pool.stats().active,0);assert.equal(env.pool.stats().queued,0);
});
