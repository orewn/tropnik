import assert from 'node:assert/strict';

const PATTERNS = Object.freeze([
 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/*',
 'https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/*',
]);

/** Hold only genuine imagery requests long enough to inspect the old map.
 * No response, header, URL or body is replaced. The normal network resumes
 * after capture; bounds, timeout and finally cleanup prevent stranded loads.
 * https://chromedevtools.github.io/devtools-protocol/tot/Fetch/ */
export async function holdSatelliteImagery(cdp,{match,timeoutMs=8000,limit=64}={}) {
 assert.equal(typeof match,'function');
 assert.ok(Number.isInteger(limit)&&limit>=1&&limit<=64);
 assert.ok(Number.isFinite(timeoutMs)&&timeoutMs>0&&timeoutMs<=8000);
 const pending=new Map(),inFlight=new Set(),records=[],errors=[];
 let observed=0,closed=false,releasePromise=null,timer,reason=null;
 const error=value=>{if(errors.length<16)errors.push(String(value?.message||value));};
 const snapshot=()=>({schemaVersion:1,limit,timeoutMs,observed,records:structuredClone(records),pending:pending.size,reason,closed,errors:[...errors]});
 const resume=(requestId,record)=>{
  pending.delete(requestId);
  const command=cdp.call('Fetch.continueRequest',{requestId}).then(()=>{if(record)record.resumedAt=Date.now();}).catch(error).finally(()=>inFlight.delete(command));
  inFlight.add(command);return command;
 };
 const release=releaseReason=>{
  if(releasePromise)return releasePromise;
  closed=true;reason=releaseReason;clearTimeout(timer);
  releasePromise=(async()=>{
   for(const [requestId,record]of pending)resume(requestId,record);
   try{
    while(inFlight.size)await Promise.allSettled([...inFlight]);
    await cdp.call('Fetch.disable');
   }catch(problem){error(problem);}
   finally{unobserve();}
   return snapshot();
  })();
  return releasePromise;
 };
 const unobserve=cdp.observe('Fetch.requestPaused',event=>{
  const resource=match(event.request?.url);
  if(closed||!resource){void resume(event.requestId);return;}
  observed++;
  if(records.length>=limit){error('Imagery preload observation exceeded its bounded request count.');void resume(event.requestId);void release('overflow');return;}
  const record={requestId:event.requestId,networkId:event.networkId??null,url:event.request.url,source:resource.source,pausedAt:Date.now(),resumedAt:null};
  records.push(record);pending.set(event.requestId,record);
 });
 try{
  await cdp.call('Fetch.enable',{patterns:PATTERNS.map(urlPattern=>({urlPattern,requestStage:'Request'}))});
  timer=setTimeout(()=>{error('Imagery preload capture exceeded its bounded deadline.');void release('timeout');},timeoutMs);
 }catch(problem){error(problem);await release('enable-error');throw problem;}
 return{snapshot,release};
}
