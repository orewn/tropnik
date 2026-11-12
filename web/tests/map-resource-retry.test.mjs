import test from 'node:test';
import assert from 'node:assert/strict';
import {MapResourcePool,MapResourceHTTPError} from '../lib/map-resource-pool.ts';
import {decodeVectorTile} from '../lib/custom-map-vector.ts';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const imagery='https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/6/15/62.jpg';
const vector='https://tiles.openfreemap.org/planet/20261101_080013_pt/11/2046/495.pbf';
const elevation='https://tiles.mapterhorn.com/6/62/15.webp';
const bytes=value=>new TextDecoder().decode(value);

test('one delayed network retry shares the original tile entry, leases, request policy and completed bytes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const url of [imagery,vector,elevation]){
  const reads=[];
  const pool=new MapResourcePool({fetcher:async(target,options)=>{reads.push({target,options});if(reads.length===1)throw new TypeError('Failed to fetch');return new Response('complete');}});
  const first=new AbortController(),second=new AbortController();
  const a=pool.get(url,0,first.signal).catch(error=>error),b=pool.get(url,0,second.signal);await turn();
  assert.equal(reads.length,1);assert.equal(pool.stats().active,1);first.abort();assert.equal((await a).name,'AbortError');assert.equal(reads[0].options.signal.aborted,false);
  t.mock.timers.tick(149);await turn();assert.equal(reads.length,1,'The reset connection is not reused immediately');
  t.mock.timers.tick(1);const result=await b;await turn();assert.equal(bytes(result),'complete');assert.equal(reads.length,2);
  assert.equal(reads[1].target,url);assert.equal(reads[1].options.signal,reads[0].options.signal,'Both attempts belong to the same deadline and lease');
  assert.equal(reads[1].options.cache,'force-cache');assert.equal(reads[1].options.credentials,'omit');assert.equal(reads[1].options.method,undefined,'The existing idempotent GET method is preserved');
  assert.equal(await pool.get(url),result);assert.deepEqual(pool.stats(),{active:0,queued:0,cached:1,bytes:8});assert.equal(reads.length,2);
 }
});

test('an HTTP 200 body reset discards every partial byte before the single complete retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,pulls=0,firstBody;
 const pool=new MapResourcePool({maxResourceBytes:3,fetcher:async()=>{
  if(++calls>1)return new Response(new Uint8Array([9,8]));
  firstBody=new ReadableStream({pull(controller){if(pulls++===0)controller.enqueue(new Uint8Array([1,2,3]));else controller.error(new TypeError('network error'));}});
  return new Response(firstBody,{status:200});
 }});
 const result=pool.get(imagery);await turn();assert.equal(pulls,2);assert.equal(firstBody.locked,false,'The rejected response reader is released before retry delay');
 assert.equal(pool.stats().bytes,0);t.mock.timers.tick(150);assert.deepEqual([...new Uint8Array(await result)],[9,8]);await turn();
 assert.equal(calls,2);assert.equal(pool.stats().bytes,2,'Failed partial data never enters the shared cache or the returned tile');assert.equal(pool.stats().active,0);
});

test('a second network failure ends the entry without an automatic retry loop or poisoned cache',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const pool=new MapResourcePool({fetcher:async()=>{calls++;throw new TypeError('Connection reset');}});
 const result=pool.get(imagery).catch(error=>error);await turn();t.mock.timers.tick(150);
 assert.match((await result).message,/Connection reset/);await turn();assert.equal(calls,2);assert.deepEqual(pool.stats(),{active:0,queued:0,cached:0,bytes:0});
 t.mock.timers.tick(60_000);await turn();assert.equal(calls,2,'Only a later explicit consumer can start a new entry');
});

test('retry delays preserve the three physical request slots and the queued demand bound',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const reads=[];let active=0,maximum=0;
 const pool=new MapResourcePool({concurrency:3,maxQueued:3,fetcher:(url,{signal})=>new Promise((resolve,reject)=>{
  active++;maximum=Math.max(maximum,active);let settled=false;
  const finish=(callback,value)=>{assert.equal(settled,false);settled=true;active--;signal.removeEventListener('abort',abort);callback(value);};
  const abort=()=>finish(reject,signal.reason);signal.addEventListener('abort',abort,{once:true});
  reads.push({url,signal,resolve:()=>finish(resolve,new Response('tile')),reject:()=>finish(reject,new TypeError('Connection reset'))});
 })});
 const urls=Array.from({length:6},(_,i)=>imagery.replace('/62.jpg',`/${60+i}.jpg`)),results=urls.map(url=>pool.get(url));
 assert.equal(reads.length,3);assert.equal(pool.stats().queued,3);await assert.rejects(pool.get(imagery.replace('/62.jpg','/70.jpg')),/queue/);
 for(const read of reads.slice(0,3))read.reject();await turn();assert.equal(active,0);assert.equal(pool.stats().active,3,'Sleeping retries retain their original logical HTTP slots');
 t.mock.timers.tick(149);await turn();assert.equal(reads.length,3);t.mock.timers.tick(1);await turn();assert.equal(reads.length,6);assert.equal(active,3);
 for(let index=3;index<9;index++){assert.ok(reads[index]);reads[index].resolve();await turn();assert.ok(active<=3);assert.ok(pool.stats().active<=3);}
 assert.equal((await Promise.all(results)).length,6);await turn();assert.equal(maximum,3);assert.equal(reads.length,9);assert.equal(pool.stats().queued,0);assert.equal(pool.stats().active,0);
});

test('the last cancelled lease aborts a pending retry delay and releases queued work without a late request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const reads=[];
 const pool=new MapResourcePool({concurrency:1,fetcher:async(url,{signal})=>{reads.push({url,signal});if(url===imagery)throw new TypeError('Failed to fetch');return new Response('next');}});
 const view=new AbortController(),cancelled=pool.get(imagery,0,view.signal).catch(error=>error),next=pool.get('/maps/next.png');await turn();
 assert.equal(reads.length,1);view.abort();assert.equal((await cancelled).name,'AbortError');assert.equal(bytes(await next),'next');await turn();
 t.mock.timers.tick(15_000);await turn();assert.deepEqual(reads.map(read=>read.url),[imagery,'/maps/next.png']);assert.equal(reads[0].signal.aborted,true);assert.equal(pool.has(imagery),false);assert.equal(pool.stats().active,0);
});

test('the original resource deadline includes retry delay and the second attempt, without a fresh timeout',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const failureAt of [0,100]){
  const reads=[];
  const pool=new MapResourcePool({timeoutMs:200,fetcher:(_url,{signal})=>new Promise((resolve,reject)=>{
   reads.push(signal);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
   if(reads.length===1){if(failureAt)setTimeout(()=>reject(new TypeError('Failed to fetch')),failureAt);else reject(new TypeError('Failed to fetch'));}
  })});
  const result=pool.get(imagery).catch(error=>error);await turn();
  if(failureAt){t.mock.timers.tick(failureAt);await turn();}
  else{t.mock.timers.tick(150);await turn();assert.equal(reads.length,2);}
  t.mock.timers.tick(failureAt?99:49);await turn();assert.equal(reads[0].aborted,false);
  t.mock.timers.tick(1);assert.equal((await result).name,'AbortError');await turn();assert.equal(reads.length,failureAt?1:2);assert.ok(reads.every(signal=>signal.aborted));
  t.mock.timers.tick(1000);await turn();assert.equal(reads.length,failureAt?1:2);assert.equal(pool.stats().active,0);assert.equal(pool.has(imagery),false);
 }
});

test('HTTP errors, byte limits, semantic content errors, non-tile resources and explicit aborts never retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const status of [403,404,503]){
  let calls=0;const pool=new MapResourcePool({fetcher:async()=>{calls++;return new Response('missing',{status});}});
  await assert.rejects(pool.get(imagery),error=>error instanceof MapResourceHTTPError&&error.status===status);assert.equal(calls,1);assert.equal(pool.has(imagery),false);
 }
 for(const response of [()=>new Response('12345'),()=>new Response('short',{headers:{'content-length':'99'}})]){
  let calls=0;const pool=new MapResourcePool({maxResourceBytes:4,fetcher:async()=>{calls++;return response();}});
  await assert.rejects(pool.get(imagery),/byte budget/);assert.equal(calls,1);assert.equal(pool.stats().bytes,0);
 }
 for(const url of ['/maps/tile.png','https://tiles.openfreemap.org/planet/latest','https://untrusted.example/6/62/15.webp',imagery+'?token=private']){
  let calls=0;const pool=new MapResourcePool({fetcher:async()=>{calls++;throw new TypeError('Failed to fetch');}});
  await assert.rejects(pool.get(url),TypeError);assert.equal(calls,1,'Only the known public tile endpoints have the retry contract');
 }
 for(const error of [new DOMException('Aborted','AbortError'),new Error('Decoder or validation failure')]){
  let calls=0;const pool=new MapResourcePool({fetcher:async()=>{calls++;throw error;}});await assert.rejects(pool.get(imagery),failure=>failure===error);assert.equal(calls,1);
 }
 let calls=0;const invalid=new MapResourcePool({fetcher:async()=>{calls++;return new Response(new Uint8Array([0x1a,0x01,0xff]));}});
 assert.doesNotThrow(()=>decodeVectorTile(new Uint8Array()),'The empty protobuf format remains valid');
 const malformed=await invalid.get(vector);assert.throws(()=>decodeVectorTile(malformed),/Invalid vector tile/);assert.equal(calls,1);
 const json=new MapResourcePool({fetcher:async()=>{calls++;return new Response('{broken');}});await assert.rejects(json.json(vector),SyntaxError);assert.equal(calls,2);assert.equal(json.has(vector),false);
 t.mock.timers.tick(15_000);await turn();assert.equal(calls,2);
});
