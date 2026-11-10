import assert from 'node:assert/strict';
import {get} from 'node:http';

const PROBE='/tropnik/_offline-transport-probe';
const CAPTURE_LIMIT=32;

/** Page-target CDP offline emulation does not cover a service worker's target.
 * Cut the test origin's sockets as well, so every worker receives a real fetch
 * failure. This is confined to the local audit server, never application code.
 * https://github.com/ChromeDevTools/devtools-protocol/issues/102 */
export function createOfflineOriginTransport(){
 let active=false,receipt=null,seen=new WeakSet();
 const snapshot=()=>receipt?{...receipt,active,probe:{...receipt.probe},requests:receipt.requests.map(item=>({...item}))}:null;
 const intercept=request=>{
  if(!active)return false;
  if(!seen.has(request)){
   seen.add(request);receipt.blockedRequests++;
   if(receipt.requests.length<CAPTURE_LIMIT)receipt.requests.push({path:new URL(request.url||'/', 'http://127.0.0.1').pathname,method:request.method||'GET',at:new Date().toISOString()});
  }
  // An HTTP error response would resolve fetch(), bypassing the real offline
  // fallback. Destroying the connection must reject the network operation.
  request.socket.destroy();return true;
 };
 const restore=()=>{active=false;if(receipt&&!receipt.restoredAt)receipt.restoredAt=new Date().toISOString();return snapshot();};
 return{intercept,snapshot,restore,async start(server){
  assert.equal(active,false,'The offline origin cut is already active');
  const address=server.address();assert.ok(address&&typeof address==='object'&&address.port,'The audit origin is not listening');
  receipt={method:'origin-socket-destroy',startedAt:new Date().toISOString(),restoredAt:null,blockedRequests:0,requests:[],probe:{passed:false}};seen=new WeakSet();active=true;
  server.closeAllConnections();
  try{
   const code=await new Promise((resolve,reject)=>{
    const request=get({hostname:'127.0.0.1',port:address.port,path:PROBE,agent:false},response=>{response.destroy();reject(new Error('The offline origin returned an HTTP response'));});
    request.setTimeout(2000,()=>request.destroy(new Error('The offline origin probe timed out')));
    request.once('error',error=>error.code==='ECONNRESET'?resolve(error.code):reject(error));
   });
   assert.ok(receipt.requests.some(item=>item.path===PROBE),'The origin cut did not observe its transport probe');
   receipt.probe={passed:true,errorCode:code,path:PROBE};return snapshot();
  }catch(error){restore();throw error;}
 }};
}

export function assertOfflineOriginTransport(receipt){
 assert.equal(receipt?.method,'origin-socket-destroy','Missing origin-wide offline transport cut');
 assert.equal(receipt.probe?.passed,true,'The origin transport was not proven unavailable');
 assert.equal(receipt.probe.errorCode,'ECONNRESET');assert.equal(receipt.probe.path,PROBE);
 assert.ok(Number.isFinite(Date.parse(receipt.startedAt)));
 assert.ok(Number.isSafeInteger(receipt.blockedRequests)&&receipt.blockedRequests>=1);
 assert.ok(Array.isArray(receipt.requests)&&receipt.requests.length<=CAPTURE_LIMIT);
 assert.ok(receipt.requests.some(item=>item.path===PROBE));
 return receipt;
}
