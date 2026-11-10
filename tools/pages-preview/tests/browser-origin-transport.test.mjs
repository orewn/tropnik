import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,get} from 'node:http';
import {createOfflineOriginTransport,assertOfflineOriginTransport} from '../browser-origin-transport.mjs';
import {restoreOfflineSafetyEnvironment} from '../browser-offline-safety.mjs';

const read=(port,path='/tropnik/')=>new Promise((resolve,reject)=>{
 const request=get({hostname:'127.0.0.1',port,path,agent:false},response=>{
  let text='';response.setEncoding('utf8');response.on('data',value=>text+=value);response.on('end',()=>resolve({status:response.statusCode,text}));
 });request.once('error',reject);
});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});

test('origin transport cuts independent HTTP clients and restores actual responses',async()=>{
 const transport=createOfflineOriginTransport();let responses=0;
 const server=createServer((request,response)=>{if(transport.intercept(request))return;responses++;response.end('online');});
 const port=await listen(server);
 try{
  assert.deepEqual(await read(port),{status:200,text:'online'});
  const proof=await transport.start(server);assertOfflineOriginTransport(proof);assert.equal(proof.active,true);
  await assert.rejects(read(port,'/tropnik/service-worker-fetch?private=not-recorded'),{code:'ECONNRESET'});
  await assert.rejects(read(port,'/tropnik/second-client'),{code:'ECONNRESET'});
  const receipt=transport.snapshot();assert.equal(receipt.blockedRequests,3);assert.equal(responses,1);
  assert.deepEqual(receipt.requests.map(item=>item.path),['/tropnik/_offline-transport-probe','/tropnik/service-worker-fetch','/tropnik/second-client']);
  assert.equal(JSON.stringify(receipt).includes('not-recorded'),false);
  assert.equal(transport.restore().active,false);
  assert.ok(transport.snapshot().restoredAt);assert.deepEqual(await read(port),{status:200,text:'online'});
 }finally{transport.restore();await close(server);}
});

test('an unconnected origin cut cannot manufacture a valid offline receipt',async()=>{
 const transport=createOfflineOriginTransport(),server=createServer((_request,response)=>response.end('still online'));
 await listen(server);
 try{
  await assert.rejects(transport.start(server),/returned an HTTP response/);
  assert.equal(transport.snapshot().active,false);assert.equal(transport.snapshot().probe.passed,false);
  assert.throws(()=>assertOfflineOriginTransport(transport.snapshot()));
 }finally{transport.restore();await close(server);}
});

test('origin cut closes an in-flight response before any HTTP body can escape',async()=>{
 const transport=createOfflineOriginTransport();let began,release;
 const arrived=new Promise(resolve=>began=resolve),ready=new Promise(resolve=>release=resolve);
 const server=createServer(async(request,response)=>{
  if(transport.intercept(request))return;
  began();await ready;if(transport.intercept(request))return;response.end('too late');
 });
 const port=await listen(server);
 try{
  const pending=assert.rejects(read(port,'/tropnik/pending'),{code:'ECONNRESET'});await arrived;
  assertOfflineOriginTransport(await transport.start(server));release();await pending;
  assert.equal(transport.snapshot().active,true);
 }finally{release();transport.restore();await close(server);}
});

test('cleanup attempts both browser resets and cannot leave a passing receipt after failure',async()=>{
 const calls=[],report={passed:true};let saved,restored=false;
 const cdp={call:async method=>{calls.push(method);if(method==='Network.emulateNetworkConditions')throw new Error('network reset rejected');}};
 await assert.rejects(restoreOfflineSafetyEnvironment(cdp,report,{restore(){restored=true;return{active:false};}},async()=>{saved=structuredClone(report);}),AggregateError);
 assert.equal(restored,true);assert.deepEqual(calls,['Network.emulateNetworkConditions','Network.setCacheDisabled']);
 assert.equal(saved.passed,false);assert.deepEqual(saved.cleanupError,['network reset rejected']);assert.equal(saved.originTransport.active,false);
});
