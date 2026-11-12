export const NETWORK_DIAGNOSTIC_LIMITS=Object.freeze({active:128,completed:32,failed:32,urlLength:2048});
const LOCAL_ASSETS=['assets/','custom-map/','data/','maps/','offline-map/','terrain/','terrain-regions/','fonts/'];
const TIMING_FIELDS=['requestTime','dnsStart','dnsEnd','connectStart','connectEnd','sslStart','sslEnd','sendStart','sendEnd','receiveHeadersStart','receiveHeadersEnd','workerStart','workerReady','workerFetchStart','workerRespondWithSettled'];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const text=(value,limit=160)=>typeof value==='string'?value.slice(0,limit):'';

/** Only public map sources and this preview's static assets. Query strings,
 * credentials and fragments never enter the retained diagnostic. */
export function publicMapNetworkURL(value,baseURL){
 try{
  const base=new URL(baseURL),url=new URL(value);
  if(url.username||url.password||!['http:','https:'].includes(url.protocol)||/%2f|%5c|%00/i.test(url.pathname))return null;
  const prefix=base.pathname.endsWith('/')?base.pathname:base.pathname+'/';
  const local=url.origin===base.origin&&url.pathname.startsWith(prefix)&&LOCAL_ASSETS.some(path=>url.pathname.slice(prefix.length).startsWith(path));
  const remote=url.protocol==='https:'&&!url.port&&(
   url.hostname==='tiles.openfreemap.org'&&/^\/planet\/(?:latest|[A-Za-z0-9_-]+\/\d+\/\d+\/\d+\.pbf)$/.test(url.pathname)||
   url.hostname==='tiles.mapterhorn.com'&&/^\/\d+\/\d+\/\d+\.webp$/.test(url.pathname)||
   url.hostname==='tiles.maps.eox.at'&&/^\/wmts\/1\.0\.0\/(s2cloudless_3857|bluemarble_3857)\/default\/g\/\d+\/\d+\/\d+\.jpg$/.test(url.pathname));
  const clean=url.origin+url.pathname;
  return(local||remote)&&clean.length<=NETWORK_DIAGNOSTIC_LIMITS.urlLength?clean:null;
 }catch{return null;}
}

/** Passive CDP metadata, independent of the application's last published DOM
 * inspection. Network.enable never intercepts/replays a request, changes cache
 * policy, bypasses the service worker or requests a response/request body.
 * Protocol: https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Network.pdl
 */
export async function observePublicMapNetwork(cdp,{baseURL,clock=()=>performance.now(),epoch=()=>Date.now(),limits=NETWORK_DIAGNOSTIC_LIMITS}={}){
 for(const key of ['active','completed','failed'])if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>NETWORK_DIAGNOSTIC_LIMITS[key])throw new RangeError('Invalid network diagnostic limit: '+key);
 new URL(baseURL);
 const active=new Map(),completed=[],failed=[],unobserve=[];
 const startedAtEpochMs=epoch(),started=clock();let status='starting',enableError=null,disposed=false,stoppedAt;
 const counts={started:0,completed:0,failed:0,canceled:0,redirected:0,ignored:0,activeOverflow:0,completedDiscarded:0,failedDiscarded:0};
 const now=()=>stoppedAt??clock();
 const record=(entry,at=now())=>{
  const {observedAt,lastObservedAt,...publicFields}=entry;
  return{...publicFields,...(entry.timing?{timing:{...entry.timing}}:{}),ageMs:Math.max(0,at-observedAt),idleMs:Math.max(0,at-lastObservedAt)};
 };
 const retain=(list,entry,limit,discarded)=>{list.push(record(entry));if(list.length>limit){list.shift();counts[discarded]++;}};
 const progress=(entry,event,stage)=>{entry.stage=stage;entry.lastObservedAt=now();if(finite(event.timestamp))entry.lastEventAtMonotonicSeconds=event.timestamp;};
 const response=(entry,value)=>{
  if(!value)return;
  if(finite(value.status))entry.status=value.status;
  entry.protocol=text(value.protocol,32);entry.mimeType=text(value.mimeType,80);
  entry.fromDiskCache=!!value.fromDiskCache;entry.fromServiceWorker=!!value.fromServiceWorker;
  if(value.timing)entry.timing=Object.fromEntries(TIMING_FIELDS.filter(key=>finite(value.timing[key])).map(key=>[key,value.timing[key]]));
 };
 const finish=(entry,event,result)=>{
  progress(entry,event,result);entry.finishedAtEpochMs=epoch();
  entry.durationMs=finite(entry.startedAtMonotonicSeconds)&&finite(event.timestamp)?Math.max(0,(event.timestamp-entry.startedAtMonotonicSeconds)*1000):Math.max(0,now()-entry.observedAt);
  if(finite(event.encodedDataLength))entry.encodedBytes=event.encodedDataLength;
  active.delete(entry.requestId);
  if(result==='failed'){
   counts.failed++;entry.errorText=text(event.errorText);entry.canceled=!!event.canceled;if(entry.canceled)counts.canceled++;
   if(event.blockedReason)entry.blockedReason=text(event.blockedReason,80);
   if(event.corsErrorStatus?.corsError)entry.corsError=text(event.corsErrorStatus.corsError,80);
   retain(failed,entry,limits.failed,'failedDiscarded');
  }else{
   if(result==='redirected')counts.redirected++;else counts.completed++;
   retain(completed,entry,limits.completed,'completedDiscarded');
  }
 };
 const observe=(method,handler)=>unobserve.push(cdp.observe(method,event=>{if(!disposed)handler(event);}));
 observe('Network.requestWillBeSent',event=>{
  const previous=active.get(event.requestId);
  if(previous){response(previous,event.redirectResponse);finish(previous,event,'redirected');}
  const request=event.request,url=publicMapNetworkURL(request?.url,baseURL);
  if(!url||!['GET','HEAD'].includes(request.method)||typeof event.requestId!=='string'||event.requestId.length>80){counts.ignored++;return;}
  counts.started++;
  // Keep the oldest outstanding requests when capacity is reached: those are
  // the ones needed to explain a stalled map. Overflow remains explicit.
  if(active.size>=limits.active){counts.activeOverflow++;return;}
  const observedAt=now();
  active.set(event.requestId,{requestId:event.requestId,url,queryOmitted:new URL(request.url).search.length>0,method:request.method,resourceType:text(event.type,32),priority:text(request.initialPriority,32),stage:'request',
   startedAtEpochMs:finite(event.wallTime)?event.wallTime*1000:epoch(),startedAtMonotonicSeconds:finite(event.timestamp)?event.timestamp:null,lastEventAtMonotonicSeconds:finite(event.timestamp)?event.timestamp:null,
   observedAt,lastObservedAt:observedAt,decodedBytes:0,encodedBytes:0});
 });
 observe('Network.responseReceived',event=>{const entry=active.get(event.requestId);if(entry){progress(entry,event,'response');response(entry,event.response);}});
 observe('Network.dataReceived',event=>{
  const entry=active.get(event.requestId);if(!entry)return;progress(entry,event,'data');
  if(finite(event.dataLength)&&event.dataLength>0)entry.decodedBytes+=event.dataLength;
  if(finite(event.encodedDataLength)&&event.encodedDataLength>0)entry.encodedBytes+=event.encodedDataLength;
 });
 observe('Network.requestServedFromCache',event=>{const entry=active.get(event.requestId);if(entry)entry.servedFromCache=true;});
 observe('Network.loadingFinished',event=>{const entry=active.get(event.requestId);if(entry)finish(entry,event,'finished');});
 observe('Network.loadingFailed',event=>{const entry=active.get(event.requestId);if(entry)finish(entry,event,'failed');});
 const dispose=()=>{if(disposed)return;disposed=true;stoppedAt=clock();for(const stop of unobserve)stop();};
 const snapshot=()=>({schemaVersion:1,source:'CDP Network events',readOnly:true,status,enableError,disposed,startedAtEpochMs,capturedAtEpochMs:epoch(),elapsedMs:Math.max(0,now()-started),
  scope:'public map sources and local static assets; URL queries and bodies excluded',ageClock:'observer monotonic milliseconds',limits:{active:limits.active,completed:limits.completed,failed:limits.failed,urlLength:NETWORK_DIAGNOSTIC_LIMITS.urlLength},counts:{...counts},
  active: [...active.values()].map(entry=>record(entry)).sort((a,b)=>b.ageMs-a.ageMs),completed:completed.map(entry=>({...entry,...(entry.timing?{timing:{...entry.timing}}:{})})),failed:failed.map(entry=>({...entry,...(entry.timing?{timing:{...entry.timing}}:{})})),truncated:counts.activeOverflow>0});
 // Zero inspector payload storage; these limits do not alter the HTTP cache.
 try{await cdp.call('Network.enable',{maxTotalBufferSize:0,maxResourceBufferSize:0,maxPostDataSize:0});status='recording';}
 catch(error){status='unavailable';enableError=text(error instanceof Error?error.message:String(error));dispose();}
 return{snapshot,dispose};
}
