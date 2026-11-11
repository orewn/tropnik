import test from 'node:test';
import assert from 'node:assert/strict';
import {observePublicMapNetwork,publicMapNetworkURL} from '../browser-network.mjs';

const baseURL='http://127.0.0.1:4200/tropnik/';
const tile='https://tiles.mapterhorn.com/9/379/171.webp';
async function fixture(options={}){
 let time=0;const listeners=new Map(),calls=[];
 const cdp={
  observe(method,handler){listeners.set(method,handler);return()=>listeners.delete(method);},
  async call(method,parameters){calls.push({method,parameters});if(options.failEnable)throw new Error('Network domain unavailable');},
 };
 const observer=await observePublicMapNetwork(cdp,{baseURL,clock:()=>time,epoch:()=>1_700_000_000_000+time,...(options.limits?{limits:options.limits}:{})});
 const emit=(method,event)=>listeners.get('Network.'+method)?.({timestamp:1000+time/1000,...event});
 const request=(requestId,url=tile,extra={})=>emit('requestWillBeSent',{requestId,type:'Fetch',wallTime:1_700_000_000+time/1000,request:{url,method:'GET',initialPriority:'High'},...extra});
 return{...observer,calls,listeners,emit,request,advance:value=>{time+=value;}};
}

test('a stalled source is distinguished from headers/body progress using live event ages',async t=>{
 const env=await fixture();t.after(env.dispose);
 env.request('waiting');env.advance(100);env.request('streaming',baseURL+'maps/russia-relief/4/11/5.png');
 env.advance(100);env.emit('responseReceived',{requestId:'streaming',response:{status:200,protocol:'h2',mimeType:'image/png',timing:{requestTime:1000.1,dnsStart:0,dnsEnd:20,receiveHeadersEnd:100}}});
 env.advance(200);env.emit('dataReceived',{requestId:'streaming',dataLength:500,encodedDataLength:300,data:'BODY-MUST-NOT-BE-RETAINED'});
 env.advance(14600);const state=env.snapshot();
 assert.equal(state.elapsedMs,15000);assert.equal(state.source,'CDP Network events');assert.equal(state.readOnly,true);
 assert.equal(state.active[0].requestId,'waiting');assert.equal(state.active[0].stage,'request');assert.equal(state.active[0].ageMs,15000);assert.equal(state.active[0].idleMs,15000);
 const stream=state.active.find(entry=>entry.requestId==='streaming');
 assert.equal(stream.stage,'data');assert.equal(stream.ageMs,14900);assert.equal(stream.idleMs,14600);assert.equal(stream.decodedBytes,500);assert.equal(stream.encodedBytes,300);assert.equal(stream.status,200);
 assert.equal(stream.startedAtEpochMs,1_700_000_000_100);assert.equal(stream.lastEventAtMonotonicSeconds,1000.4);
 assert.equal(JSON.stringify(state).includes('BODY-MUST-NOT-BE-RETAINED'),false);
 stream.timing.dnsEnd=999;assert.equal(env.snapshot().active.find(entry=>entry.requestId==='streaming').timing.dnsEnd,20);
 env.emit('loadingFinished',{requestId:'streaming',encodedDataLength:450});
 const finished=env.snapshot();assert.equal(finished.active.length,1);assert.ok(Math.abs(finished.completed[0].durationMs-14900)<1e-6);assert.equal(finished.completed[0].encodedBytes,450);
});

test('DNS failure, consumer cancellation, HTTP failure and cache completion remain different evidence',async t=>{
 const env=await fixture();t.after(env.dispose);
 env.request('dns');env.advance(15000);env.emit('loadingFailed',{requestId:'dns',errorText:'net::ERR_NAME_NOT_RESOLVED',canceled:false});
 env.request('cancel');env.advance(20);env.emit('loadingFailed',{requestId:'cancel',errorText:'net::ERR_ABORTED',canceled:true});
 env.request('http');env.emit('responseReceived',{requestId:'http',response:{status:503}});env.emit('loadingFinished',{requestId:'http',encodedDataLength:50});
 env.request('cached');env.emit('requestServedFromCache',{requestId:'cached'});env.emit('responseReceived',{requestId:'cached',response:{status:200,fromDiskCache:true,fromServiceWorker:true}});env.emit('loadingFinished',{requestId:'cached',encodedDataLength:0});
 const state=env.snapshot();assert.equal(state.active.length,0);assert.equal(state.counts.failed,2);assert.equal(state.counts.canceled,1);assert.equal(state.counts.completed,2);
 assert.equal(state.failed[0].durationMs,15000);assert.equal(state.failed[0].errorText,'net::ERR_NAME_NOT_RESOLVED');assert.equal(state.failed[0].canceled,false);assert.equal(state.failed[1].canceled,true);
 assert.equal(state.completed[0].status,503);assert.equal(state.completed[1].servedFromCache,true);assert.equal(state.completed[1].fromDiskCache,true);assert.equal(state.completed[1].fromServiceWorker,true);
});

test('only public map/static GETs are retained; bodies, headers and query values are never copied',async t=>{
 const env=await fixture();t.after(env.dispose);
 for(const url of [baseURL+'api/private.json',baseURL+'?search=private',baseURL+'assets/../api/private',baseURL+'assets/%2fapi',tile.replace('https://','https://name:secret@'),'https://unrelated.test/maps/tile.png','https://tiles.mapterhorn.com/private'])assert.equal(publicMapNetworkURL(url,baseURL),null,url);
 for(const url of [tile,baseURL+'data/imported/route.geojson','https://tiles.openfreemap.org/planet/latest','https://tiles.openfreemap.org/planet/20261101_080013_pt/9/379/171.pbf','https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/8/190/85.jpg'])assert.equal(publicMapNetworkURL(url,baseURL),url);
 env.request('public',baseURL+'data/route.geojson?token=PRIVATE-QUERY',{request:{url:baseURL+'data/route.geojson?token=PRIVATE-QUERY',method:'GET',headers:{Authorization:'PRIVATE-HEADER'},postData:'PRIVATE-BODY'}});
 env.emit('responseReceived',{requestId:'public',response:{status:200,headers:{'set-cookie':'PRIVATE-COOKIE'},securityDetails:{secret:'PRIVATE-SECURITY'},timing:{dnsEnd:5,secret:'PRIVATE-TIMING'}}});
 env.request('post',tile,{request:{url:tile,method:'POST',postData:'PRIVATE-POST'}});env.request('api',baseURL+'api/private.json');
 const state=env.snapshot();assert.equal(state.active.length,1);assert.equal(state.active[0].queryOmitted,true);assert.equal(state.active[0].url,baseURL+'data/route.geojson');assert.equal(state.counts.ignored,2);
 assert.equal(JSON.stringify(state).includes('PRIVATE-'),false);
 assert.deepEqual(env.calls,[{method:'Network.enable',parameters:{maxTotalBufferSize:0,maxResourceBufferSize:0,maxPostDataSize:0}}]);
});

test('redirect IDs close the previous public hop, including a redirect outside the allowlist',async t=>{
 const env=await fixture();t.after(env.dispose);
 env.request('redirect');env.advance(100);
 env.request('redirect',tile.replace('/379/','/380/'),{redirectResponse:{status:302,headers:{location:'not retained'}}});
 let state=env.snapshot();assert.equal(state.active.length,1);assert.equal(state.active[0].ageMs,0);assert.equal(state.completed[0].stage,'redirected');assert.ok(Math.abs(state.completed[0].durationMs-100)<1e-6);assert.equal(state.completed[0].status,302);
 env.advance(50);env.request('redirect','https://unrelated.test/private',{redirectResponse:{status:307}});
 state=env.snapshot();assert.equal(state.active.length,0);assert.equal(state.counts.redirected,2);assert.equal(state.counts.ignored,1);assert.equal(JSON.stringify(state).includes('unrelated.test'),false);
});

test('overflow preserves the oldest pending sources and bounds both terminal rings',async t=>{
 const env=await fixture({limits:{active:2,completed:2,failed:2}});t.after(env.dispose);
 env.request('oldest');env.advance(10);env.request('second');env.request('omitted');
 let state=env.snapshot();assert.deepEqual(state.active.map(entry=>entry.requestId),['oldest','second']);assert.equal(state.counts.activeOverflow,1);assert.equal(state.truncated,true);
 env.emit('loadingFinished',{requestId:'second'});
 for(let index=0;index<5;index++){const requestId='success'+index;env.request(requestId);env.emit('loadingFinished',{requestId});}
 for(let index=0;index<5;index++){const requestId='error'+index;env.request(requestId);env.emit('loadingFailed',{requestId,errorText:'net::ERR_TIMED_OUT'});}
 state=env.snapshot();assert.deepEqual(state.active.map(entry=>entry.requestId),['oldest']);assert.deepEqual(state.completed.map(entry=>entry.requestId),['success3','success4']);assert.deepEqual(state.failed.map(entry=>entry.requestId),['error3','error4']);assert.equal(state.counts.completedDiscarded,4);assert.equal(state.counts.failedDiscarded,3);
});

test('cleanup is idempotent and cannot disable another audit, replay requests or retain future events',async()=>{
 const env=await fixture();env.request('pending');env.advance(80);env.dispose();env.dispose();
 const before=env.snapshot();env.advance(100);env.request('late');env.emit('loadingFailed',{requestId:'pending',errorText:'late'});
 const after=env.snapshot();assert.equal(env.listeners.size,0);assert.equal(after.disposed,true);assert.equal(after.elapsedMs,80);assert.deepEqual(after.active,before.active);assert.deepEqual(after.counts,before.counts);
 assert.deepEqual(env.calls,[{method:'Network.enable',parameters:{maxTotalBufferSize:0,maxResourceBufferSize:0,maxPostDataSize:0}}]);
});

test('an unavailable Network domain stays explicit and releases all observers without replacing the browser gate',async()=>{
 const env=await fixture({failEnable:true}),state=env.snapshot();assert.equal(state.status,'unavailable');assert.equal(state.enableError,'Network domain unavailable');assert.equal(state.disposed,true);assert.equal(env.listeners.size,0);assert.equal(state.active.length,0);env.dispose();
});
