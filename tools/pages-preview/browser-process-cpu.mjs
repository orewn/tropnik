import assert from 'node:assert/strict';

/** Public DOM evidence, included in the existing diagnostic map-state read.
 * Reading focus/visibility never activates a target or changes its lifecycle. */
export function inspectPageActivity(doc=document,perf=performance){
 const active=doc.activeElement;
 return{timeOrigin:perf.timeOrigin,time:perf.now(),visibilityState:doc.visibilityState,hidden:doc.hidden,hasFocus:doc.hasFocus(),activeElement:active?{tag:active.tagName,label:active.getAttribute('aria-label')}:null};
}

/** SystemInfo.getProcessInfo is browser-target CDP. Its cpuTime is cumulative
 * seconds across ALL threads, including workers absent from a timeline trace:
 * https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/#type-ProcessInfo
 * Request windows stay explicit because CDP does not timestamp each counter. */
export async function captureProcessCPU(read,{clock=()=>performance.now(),epoch=()=>Date.now()}={}){
 const started=clock(),snapshot={available:false,startedAtEpochMs:epoch(),startMonotonicMs:started};
 try{
  assert.equal(typeof read,'function','No browser-level SystemInfo.getProcessInfo reader');
  const payload=await read(),seen=new Set();
  assert.ok(Array.isArray(payload?.processInfo)&&payload.processInfo.length>0,'SystemInfo.getProcessInfo returned an invalid or empty processInfo payload');
  snapshot.processes=payload.processInfo.map(process=>{
   assert.ok(Number.isInteger(process?.id)&&process.id>0&&typeof process.type==='string'&&process.type.length>0&&Number.isFinite(process.cpuTime)&&process.cpuTime>=0&&!seen.has(process.id),'SystemInfo.getProcessInfo returned an invalid or duplicate process counter');
   seen.add(process.id);return{id:process.id,type:process.type,cpuTimeSeconds:process.cpuTime};
  }).sort((a,b)=>a.id-b.id);
  snapshot.available=true;
 }catch(error){snapshot.error=error?.message||String(error);}
 finally{snapshot.endMonotonicMs=clock();snapshot.endedAtEpochMs=epoch();snapshot.durationMs=snapshot.endMonotonicMs-started;}
 return snapshot;
}

/** Compare only the same PID/type with a monotonic counter. New/exited/reset
 * processes remain visible and never acquire an invented zero CPU delta. */
export function processCPUDelta(before,after){
 if(!before?.available||!after?.available)return{available:false,reason:!before?.available?'before-snapshot-unavailable':'after-snapshot-unavailable'};
 const intervalMs={minimum:after.startMonotonicMs-before.endMonotonicMs,maximum:after.endMonotonicMs-before.startMonotonicMs};
 intervalMs.midpoint=(intervalMs.minimum+intervalMs.maximum)/2;
 const old=new Map(before.processes.map(process=>[process.id,process])),current=new Map(after.processes.map(process=>[process.id,process]));
 const processes=[...new Set([...old.keys(),...current.keys()])].sort((a,b)=>a-b).map(id=>{
  const a=old.get(id),b=current.get(id),result={id,type:b?.type??a.type,beforeCPUSeconds:a?.cpuTimeSeconds??null,afterCPUSeconds:b?.cpuTimeSeconds??null,cpuTimeDeltaSeconds:null,averageLogicalCores:null};
  if(!a)result.status='new-process';
  else if(!b)result.status='exited-process';
  else if(a.type!==b.type){result.status='process-type-changed';result.beforeType=a.type;}
  else if(b.cpuTimeSeconds<a.cpuTimeSeconds)result.status='counter-decreased';
  else{result.status='comparable';result.cpuTimeDeltaSeconds=b.cpuTimeSeconds-a.cpuTimeSeconds;result.averageLogicalCores=intervalMs.midpoint>0?result.cpuTimeDeltaSeconds/(intervalMs.midpoint/1000):null;}
  return result;
 });
 const comparable=processes.filter(process=>process.status==='comparable'),byType=new Map();
 for(const process of comparable){const total=byType.get(process.type)||{type:process.type,processCount:0,cpuTimeDeltaSeconds:0};total.processCount++;total.cpuTimeDeltaSeconds+=process.cpuTimeDeltaSeconds;byType.set(process.type,total);}
 const totalComparableCPUSeconds=comparable.reduce((total,process)=>total+process.cpuTimeDeltaSeconds,0);
 return{available:true,complete:comparable.length===processes.length,intervalMs,comparableProcessCount:comparable.length,incomparableProcessCount:processes.length-comparable.length,totalComparableCPUSeconds,averageLogicalCores:intervalMs.midpoint>0?totalComparableCPUSeconds/(intervalMs.midpoint/1000):null,byType:[...byType.values()].map(total=>({...total,averageLogicalCores:intervalMs.midpoint>0?total.cpuTimeDeltaSeconds/(intervalMs.midpoint/1000):null})),processes};
}

/** Exactly one action, unchanged failure identity, two best-effort snapshots.
 * Samples bracket the action before its normal trace cleanup; an independent
 * trace time cap may still drain during this interval. Diagnostic query failure
 * cannot suppress or repeat the native action or its settle gate. */
export async function observeProcessCPU(action,{read,receipt={},clock=()=>performance.now(),epoch=()=>Date.now()}={}){
 Object.assign(receipt,{schemaVersion:1,method:'SystemInfo.getProcessInfo',target:'browser',cpuUnit:'seconds',cpuScope:'all-threads-since-process-start',status:'running'});
 receipt.before=await captureProcessCPU(read,{clock,epoch});
 receipt.actionStartedAtEpochMs=epoch();const started=clock();let value,failure,failed=false;
 try{value=await action();receipt.status='completed';}
 catch(error){failed=true;failure=error;receipt.status='failed';receipt.actionError=error?.message||String(error);}
 finally{
  receipt.actionDurationMs=clock()-started;receipt.actionEndedAtEpochMs=epoch();
  receipt.after=await captureProcessCPU(read,{clock,epoch});receipt.delta=processCPUDelta(receipt.before,receipt.after);
 }
 if(failed)throw failure;
 return value;
}
