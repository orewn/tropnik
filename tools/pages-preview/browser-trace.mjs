import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const OUTPUT=new URL('../../web/pages-preview/design-qa/',import.meta.url);
export const DESKTOP_TRACE_LIMITS=Object.freeze({durationMs:8000,drainMs:5000,closeMs:1000,maxBytes:32*1024*1024,bufferSizeKiB:16*1024,chunkBytes:256*1024});
export const TERRAIN_TRACE_LIMITS=Object.freeze({...DESKTOP_TRACE_LIMITS,durationMs:20000,maxBytes:96*1024*1024,bufferSizeKiB:64*1024});
// The previous 2MiB buffer filled before the observed long task. Broad toplevel
// events duplicated RunTask and consumed half the evidence. Keep renderer task,
// layout, CPU stack and GPU evidence without the redundant scheduler stream.
export const DESKTOP_TRACE_CATEGORIES=Object.freeze(['devtools.timeline','blink.user_timing','gpu','disabled-by-default-devtools.timeline','disabled-by-default-devtools.timeline.stack','disabled-by-default-v8.cpu_profiler']);

/** Validate before browser startup. Recording is optional evidence; the full
 * native-input and performance gates run regardless of this setting. */
export function browserTraceEnabled(value,diagnostic=null){
 assert.ok(value===undefined||value===''||value==='1','Unknown TROPNIK_BROWSER_TRACE value; use 1 to record diagnostic traces');
 return diagnostic==='terrain-close'||value==='1';
}

export function traceCategoryEvidence(events){
 const counts=new Map(),limit=128;
 for(const event of events)if(typeof event.cat==='string')for(const name of new Set(event.cat.split(',').map(value=>value.trim()).filter(Boolean)))counts.set(name,(counts.get(name)||0)+1);
 const sorted=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 return{available:true,source:'traceEvents[].cat',categoryCount:counts.size,limit,truncated:counts.size>limit,counts:sorted.slice(0,limit).map(([name,events])=>({name,events}))};
}

/** Diagnostic only: one desktop action, with native input unchanged.
 * CDP Tracing.start/end and IO.read/close are documented in the upstream PDL:
 * https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Tracing.pdl
 * https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/IO.pdl
 * A time/buffer cap never cancels or repeats the action. Partial/error receipts
 * stay explicit; they cannot replace the existing interaction/performance gates. */
export async function traceDesktopSelection(cdp,action,{
 enabled=true,
 output=OUTPUT,sourceCommit=null,limits=DESKTOP_TRACE_LIMITS,
 prefix='desktop-webgl-first-altai',scope='first-desktop-altai-selection',
 categories=DESKTOP_TRACE_CATEGORIES,
 captureCategoryEvidence=false,
 clock=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout,
}={}){
 if(!enabled)return{value:await action(),trace:null};
 const started=clock(),chunks=[];
 const receipt={schemaVersion:1,scope,sourceCommit,instrumented:true,startedAtEpochMs:Date.now(),limits:{...limits},categories:[...categories],status:'recording',stopReason:null,bytes:0,eof:false,dataLossOccurred:false,errors:[]};
 let completion,resolveCompletion,startRequested=false,stopPromise,timer,value,actionError;
 const completed=new Promise(resolve=>{resolveCompletion=resolve;});
 // The completion event is allowed to arrive before Tracing.end is acknowledged.
 const unobserve=cdp.observe('Tracing.tracingComplete',event=>{completion=event;resolveCompletion(event);});
 const errorText=error=>error?.stack||String(error);
 const remaining=deadline=>{
  const time=Math.ceil(deadline-clock());if(time<=0)throw new Error('Trace drain time limit reached');return time;
 };
 async function awaitCompletion(deadline){
  if(completion)return completion;
  let timeout;
  try{return await Promise.race([completed,new Promise((_,reject)=>{timeout=schedule(()=>reject(new Error('Tracing.tracingComplete timed out')),remaining(deadline));})]);}
  finally{if(timeout!==undefined)cancel(timeout);}
 }
 function stop(reason){
  if(stopPromise)return stopPromise;
  receipt.stopReason=reason;receipt.recordedDurationMs=clock()-started;
  if(timer!==undefined){cancel(timer);timer=undefined;}
  stopPromise=(async()=>{
   if(!startRequested)return;
   const deadline=clock()+limits.drainMs;let handle;
   try{
    try{await cdp.call('Tracing.end',{},remaining(deadline));}
    catch(error){if(!completion)throw error;receipt.errors.push(errorText(error));}
    const event=await awaitCompletion(deadline);
    receipt.dataLossOccurred=!!event.dataLossOccurred;handle=event.stream;
    if(!handle)throw new Error('Tracing completed without its requested stream');
    while(!receipt.eof&&receipt.bytes<limits.maxBytes){
     const chunk=await cdp.call('IO.read',{handle,size:Math.min(limits.chunkBytes,limits.maxBytes-receipt.bytes)},remaining(deadline));
     const bytes=Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8');
     const kept=bytes.subarray(0,limits.maxBytes-receipt.bytes);chunks.push(kept);receipt.bytes+=kept.length;
     receipt.eof=!!chunk.eof&&kept.length===bytes.length;
     if(kept.length!==bytes.length)break;
    }
    if(!receipt.eof)receipt.truncated='byte-limit';
   }catch(error){receipt.errors.push(errorText(error));}
   finally{
    // IO.close also discards unread backing storage after a size/time cap.
    handle??=completion?.stream;
    if(handle)try{await cdp.call('IO.close',{handle},limits.closeMs);}catch(error){receipt.errors.push(errorText(error));}
   }
  })();
  return stopPromise;
 }
 try{
  try{
   startRequested=true;
   timer=schedule(()=>{void stop('time-limit');},limits.durationMs);
   await cdp.call('Tracing.start',{
    transferMode:'ReturnAsStream',streamFormat:'json',streamCompression:'none',
    traceConfig:{recordMode:'recordUntilFull',traceBufferSizeInKb:limits.bufferSizeKiB,enableSampling:true,includedCategories:categories,excludedCategories:['*']},
   },limits.drainMs);
  }catch(error){receipt.errors.push(errorText(error));}
  try{value=await action();}catch(error){actionError=error;receipt.actionError=errorText(error);}
 }finally{
  await stop(actionError?'action-error':'action-complete');unobserve();
  if(timer!==undefined)cancel(timer);
  const bytes=Buffer.concat(chunks,receipt.bytes);
  if(receipt.eof){
   try{
    const trace=JSON.parse(bytes.toString('utf8')),events=trace.traceEvents;
    if(!Array.isArray(events))throw new Error('Trace stream has no traceEvents array');
    receipt.eventCount=events.length;
    receipt.cpuProfileChunks=events.filter(event=>event.name==='ProfileChunk').length;
    receipt.cpuSamples=events.reduce((total,event)=>total+(event.args?.data?.cpuProfile?.samples?.length||0),0);
    receipt.timelineEvents=events.filter(event=>['RunTask','FunctionCall','Layout','UpdateLayoutTree','EventDispatch','FireAnimationFrame'].includes(event.name)).length;
    if(captureCategoryEvidence)receipt.capturedCategories=traceCategoryEvidence(events);
   }catch(error){receipt.errors.push(errorText(error));}
  }
  receipt.status=receipt.errors.length?'error':!receipt.eof||receipt.dataLossOccurred||receipt.stopReason==='time-limit'?'partial':'complete';
  if(captureCategoryEvidence&&!receipt.capturedCategories)receipt.capturedCategories={available:false,source:'traceEvents[].cat',reason:receipt.eof?'invalid-trace-json':'incomplete-trace-stream'};
  if(bytes.length){receipt.file=`${prefix}.trace${receipt.eof?'':'.partial'}.json`;receipt.sha256=createHash('sha256').update(bytes).digest('hex');}
  try{
   await mkdir(output,{recursive:true});
   if(receipt.file)await writeFile(new URL(receipt.file,output),bytes);
   await writeFile(new URL(`${prefix}.trace-meta.json`,output),JSON.stringify(receipt,null,2)+'\n');
  }catch(error){receipt.errors.push(errorText(error));receipt.status='error';}
  if(receipt.status!=='complete')process.stderr.write(`Bounded desktop trace ${receipt.status}: ${JSON.stringify(receipt)}\n`);
 }
 // Diagnostics must not replace a genuine input/assertion failure.
 if(actionError){actionError.traceReceipt=receipt;throw actionError;}
 return{value,trace:receipt};
}
