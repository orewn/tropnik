import assert from 'node:assert/strict';
import {dispatchSourceEndPan,assertSourceEndPanInput} from './browser-source-end-pan.mjs';
import {traceDesktopSelection,FIRST_ALTAI_DIAGNOSTIC_TRACE_CATEGORIES,TERRAIN_TRACE_LIMITS} from './browser-trace.mjs';
import {sendNativeText} from './browser-native-text.mjs';

// These are controlled-browser interaction budgets, not a claim of physical
// device FPS. RAF callbacks do not prove that the GPU presented every frame.
export const SMOOTHNESS_LIMITS=Object.freeze({frameP95Ms:35,maxFrameGapMs:150,inputToFrameMs:200,eventDurationMs:200,layoutShift:.1});
export const SMOOTHNESS_SCENARIOS=Object.freeze(['panel','explore-search','explore-filters','catalog-scroll','map-pan','map-zoom','layer-switch','site-search']);
// Branch-only diagnostic opt-in. Capture caps bound evidence, never the
// original action, recorder window, native gesture or performance budgets.
const progressiveTrace=process.env.TROPNIK_PROGRESSIVE_PAINT_TRACE==='1';
export const SMOOTHNESS_TRACE_SCENARIOS=Object.freeze(progressiveTrace?['map-pan','map-zoom']:['panel','explore-search']);
const PROGRESSIVE_TRACE_LIMITS=Object.freeze({'map-pan':Object.freeze({...TERRAIN_TRACE_LIMITS,durationMs:8000}),'map-zoom':TERRAIN_TRACE_LIMITS});

export function smoothnessTraceEnabled({diagnostic=null,traceValue,cpuSlowdownRate=1}={}){
 return diagnostic==='ui-smoothness'&&traceValue==='1'&&cpuSlowdownRate===1;
}

/** Self-contained because CDP installs this function in each fresh document.
 * Record only explicitly bounded interaction windows; late observer delivery
 * is attributed by entry.startTime, never by callback delivery time. */
export function installSmoothnessRecorder(target=window){
 const perf=target.performance,doc=target.document,observers=[],supported={},errors=[];
 let active=null,raf=0;
 const cap=4096,eventCap=512;
 const append=(window,key,value,limit=eventCap)=>{if(window[key].length<limit)window[key].push(value);else window.overflow=true;};
 const consume=(type,entries)=>{
  if(!active)return;
  for(const entry of entries){
   if(entry.startTime<active.startedAt){if(type==='longtask'&&entry.startTime+entry.duration>active.startedAt)active.previousBoundaryTasks++;continue;}
   if(active.endedAt!==null&&entry.startTime>active.endedAt)continue;
   if(type==='longtask')append(active,'longTasks',{startTime:entry.startTime,duration:entry.duration});
   if(type==='event')append(active,'eventTiming',{startTime:entry.startTime,name:entry.name,duration:entry.duration,processingStart:entry.processingStart,processingEnd:entry.processingEnd,interactionId:entry.interactionId||0});
   if(type==='layout-shift')append(active,'layoutShifts',{startTime:entry.startTime,value:entry.value,hadRecentInput:entry.hadRecentInput,sources:(entry.sources||[]).slice(0,4).map(source=>({node:source.node?.nodeType===1?source.node.tagName.toLowerCase()+'['+(source.node.getAttribute('class')||'').slice(0,120)+']':'',previous:source.previousRect?{x:source.previousRect.x,y:source.previousRect.y,width:source.previousRect.width,height:source.previousRect.height}:null,current:source.currentRect?{x:source.currentRect.x,y:source.currentRect.y,width:source.currentRect.width,height:source.currentRect.height}:null}))});
  }
 };
 for(const type of ['longtask','event','layout-shift']){
  supported[type]=false;
  if(!target.PerformanceObserver?.supportedEntryTypes?.includes(type))continue;
  try{const observer=new target.PerformanceObserver(list=>consume(type,list.getEntries()));observer.observe({type,buffered:false,...(type==='event'?{durationThreshold:16}:{})});supported[type]=true;observers.push({type,observer});}
  catch(error){errors.push({type,error:String(error)});}
 }
 const drain=()=>{for(const {type,observer}of observers)consume(type,observer.takeRecords());};
 const frame=()=>{
  if(!active)return;
  append(active,'frames',perf.now(),cap);
  if(doc.visibilityState!=='visible')active.hidden=true;
  raf=target.requestAnimationFrame(frame);
 };
 const input=event=>{
  if(!active||!event.isTrusted)return;
  const current=active,receivedAt=perf.now(),startTime=event.timeStamp>perf.timeOrigin?event.timeStamp-perf.timeOrigin:event.timeStamp;
  if(startTime<current.startedAt)return;
  const record={type:event.type,trusted:true,startTime,receivedAt,nextFrameAt:null};
  append(current,'inputs',record);current.pendingInputFrames++;
  target.requestAnimationFrame(()=>target.requestAnimationFrame(()=>{
   // This is the next rendering opportunity after the event, not presented
   // pixels or field INP. Keep it separately from browser EventTiming.
   record.nextFrameAt=perf.now();current.pendingInputFrames--;
  }));
 };
 const inputTypes=['pointerdown','click','input','keydown','wheel'];
 for(const type of inputTypes)doc.addEventListener(type,input,{capture:true,passive:true});
 target.__tropnikSmoothness={
  start(name){
   if(active)throw new Error('A smoothness window is already active');
   drain();active={schemaVersion:1,name,startedAt:perf.now(),endedAt:null,supported:{...supported},errors:[...errors],frames:[],inputs:[],eventTiming:[],longTasks:[],layoutShifts:[],overflow:false,hidden:doc.visibilityState!=='visible',pendingInputFrames:0,previousBoundaryTasks:0};
   raf=target.requestAnimationFrame(frame);return active.startedAt;
  },
  stop(){
   if(!active)throw new Error('No smoothness window is active');
   active.endedAt=perf.now();drain();target.cancelAnimationFrame(raf);const result=active;active=null;return result;
  },
  dispose(){target.cancelAnimationFrame(raf);active=null;for(const {observer}of observers)observer.disconnect();for(const type of inputTypes)doc.removeEventListener(type,input,{capture:true});},
 };
 return target.__tropnikSmoothness;
}

function summary(values){
 const sorted=[...values].sort((a,b)=>a-b);
 return{count:sorted.length,max:sorted.length?sorted.at(-1):null,p95:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null};
}
export function sessionLayoutShift(entries){
 let largest=0,sum=0,start=0,last=0;
 for(const entry of [...entries].filter(entry=>!entry.hadRecentInput).sort((a,b)=>a.startTime-b.startTime)){
  if(sum&&entry.startTime-last<1000&&entry.startTime-start<5000)sum+=entry.value;
  else{sum=entry.value;start=entry.startTime;}
  last=entry.startTime;largest=Math.max(largest,sum);
 }
 return largest;
}
export function summarizeSmoothness(raw){
 assert.equal(raw?.schemaVersion,1);assert.ok(typeof raw.name==='string'&&raw.name);
 assert.ok(Number.isFinite(raw.startedAt)&&Number.isFinite(raw.endedAt)&&raw.endedAt>raw.startedAt);
 for(const key of ['frames','inputs','eventTiming','longTasks','layoutShifts'])assert.ok(Array.isArray(raw[key]));
 assert.ok(raw.frames.every((value,index)=>Number.isFinite(value)&&value>=raw.startedAt&&value<=raw.endedAt&&(!index||value>=raw.frames[index-1])));
 const gaps=raw.frames.map((value,index)=>value-(index?raw.frames[index-1]:raw.startedAt));
 if(raw.frames.length)gaps.push(raw.endedAt-raw.frames.at(-1));
 const within=value=>value.startTime>=raw.startedAt&&value.startTime<=raw.endedAt;
 assert.ok(raw.inputs.every(value=>value.trusted===true&&[value.startTime,value.receivedAt,value.nextFrameAt].every(Number.isFinite)&&within(value)&&value.receivedAt>=value.startTime&&value.nextFrameAt>=value.receivedAt&&value.nextFrameAt<=raw.endedAt));
 assert.ok(raw.eventTiming.every(value=>[value.startTime,value.duration,value.processingStart,value.processingEnd].every(Number.isFinite)&&within(value)&&value.duration>=0&&value.processingStart>=value.startTime&&value.processingEnd>=value.processingStart));
 assert.ok(raw.longTasks.every(value=>Number.isFinite(value.duration)&&value.duration>=0&&within(value)));
 assert.ok(raw.layoutShifts.every(value=>Number.isFinite(value.value)&&value.value>=0&&typeof value.hadRecentInput==='boolean'&&within(value)));
 const durationMs=raw.endedAt-raw.startedAt;
 const frame=summary(gaps),native=summary(raw.inputs.map(value=>value.nextFrameAt-value.startTime));
 return{schemaVersion:1,name:raw.name,durationMs,supported:raw.supported,errors:raw.errors,overflow:raw.overflow,hidden:raw.hidden,pendingInputFrames:raw.pendingInputFrames,previousBoundaryTasks:raw.previousBoundaryTasks,
  frames:{samples:raw.frames.length,callbackHz:raw.frames.length*1000/durationMs,isPresentedFps:false,p95Ms:frame.p95,maxGapMs:frame.max,over50ms:gaps.filter(value=>value>50).length},
  inputToNextFrame:{count:native.count,p95Ms:native.p95,maxMs:native.max,meaning:'native event to next rendering opportunity; not presented pixels or field INP'},
  eventTiming:{supported:raw.supported.event,observed:raw.eventTiming.length,durationThresholdMs:16,maxDurationMs:summary(raw.eventTiming.map(value=>value.duration)).max,p95DurationMs:summary(raw.eventTiming.map(value=>value.duration)).p95,isFieldINP:false},
  longTasks:{supported:raw.supported.longtask,count:raw.longTasks.length,totalMs:raw.longTasks.reduce((sum,value)=>sum+value.duration,0),maxMs:raw.supported.longtask?Math.max(0,...raw.longTasks.map(value=>value.duration)):null},
  layout:{supported:raw.supported['layout-shift'],sessionCLS:raw.supported['layout-shift']?sessionLayoutShift(raw.layoutShifts):null,unexpectedSum:raw.layoutShifts.filter(value=>!value.hadRecentInput).reduce((sum,value)=>sum+value.value,0),allShiftSum:raw.layoutShifts.reduce((sum,value)=>sum+value.value,0),recentInputCount:raw.layoutShifts.filter(value=>value.hadRecentInput).length},raw};
}

export function smoothnessIssues(window,profile){
 // Recompute every derived metric from the raw evidence before accepting it.
 assert.deepEqual(window,summarizeSmoothness(window.raw));
 const context={profile:profile.name,phase:`ui-smoothness/${window.name}`},issues=[];
 const issue=(metric,value,limit)=>issues.push({...context,metric,value,limit});
 if(window.overflow||window.hidden||window.pendingInputFrames||window.errors.length)issue('invalid-observation',{overflow:window.overflow,hidden:window.hidden,pending:window.pendingInputFrames,errors:window.errors},'visible, complete bounded window');
 if(window.frames.samples<3||window.durationMs<100||window.durationMs>30000)issue('insufficient-frame-window',{samples:window.frames.samples,durationMs:window.durationMs},'3+ frames in 100–30000ms');
 if(!window.inputToNextFrame.count)issue('missing-native-input',0,'at least one trusted input');
 if(!window.longTasks.supported||!window.layout.supported)issue('unsupported-required-observer',window.supported,'longtask and layout-shift support');
 for(const [metric,value,limit]of [
  ['frameP95Ms',window.frames.p95Ms,SMOOTHNESS_LIMITS.frameP95Ms],['maxFrameGapMs',window.frames.maxGapMs,SMOOTHNESS_LIMITS.maxFrameGapMs],
  ['inputToNextFrameMs',window.inputToNextFrame.maxMs,SMOOTHNESS_LIMITS.inputToFrameMs],['sessionCLS',window.layout.sessionCLS,SMOOTHNESS_LIMITS.layoutShift],
  ['longestTaskMs',window.longTasks.maxMs,profile.mobile?350:750],
 ])if(!Number.isFinite(value)||!(value<limit))issue(metric,value,limit);
 // EventTiming omits events below its16ms reporting threshold. No entries is
 // explicitly unobserved, never a fabricated zero-millisecond INP result.
 if(window.eventTiming.observed&&!(window.eventTiming.maxDurationMs<SMOOTHNESS_LIMITS.eventDurationMs))issue('eventDurationMs',window.eventTiming.maxDurationMs,SMOOTHNESS_LIMITS.eventDurationMs);
 return issues;
}
export function performanceBudgetIssues(value,profile,phase){
 const limits={layoutShift:.12,longestTaskMs:profile.mobile?350:750};
 return Object.entries(limits).filter(([key,limit])=>!Number.isFinite(value?.[key])||!(value[key]<limit)).map(([metric,limit])=>({profile:profile.name,phase,metric,value:value?.[metric]??null,limit}));
}
export function assertSmoothnessAudit(report,profile,{release=true}={}){
 assert.equal(report?.schemaVersion,1);assert.equal(report.profile,profile.name);assert.equal(report.engine,profile.engine);assert.equal(report.physicalDevice,false);assert.equal(report.input,profile.mobile?'touch':'mouse');
 assert.equal(report.passed,true);assert.deepEqual(report.scenarios?.map(value=>value.name),SMOOTHNESS_SCENARIOS);
 assert.ok(report.cpuSlowdownRate===1||report.cpuSlowdownRate===4);if(release)assert.equal(report.cpuSlowdownRate,1);
 assert.equal(report.cpuThrottleRestored,true);
 assert.equal(typeof report.instrumented,'boolean');assert.ok(Array.isArray(report.traces));
 if(report.instrumented)assert.equal(report.cpuSlowdownRate,1);
 assert.deepEqual(report.traces.map(trace=>trace.scenario),report.instrumented?SMOOTHNESS_TRACE_SCENARIOS:[]);
 for(const trace of report.traces){assert.equal(trace.instrumented,true);assert.equal(trace.scope,`ui-smoothness/${profile.name}/${trace.scenario}`);assert.ok(['complete','partial','error'].includes(trace.status));}
 if(release)assert.equal(report.instrumented,false,'Instrumented UI diagnostics cannot certify release smoothness');
 assertSourceEndPanInput(report.pan,report.input,profile.name+'/smoothness-pan');
 const issues=report.scenarios.flatMap(window=>smoothnessIssues(window,profile));assert.deepEqual(report.performanceIssues,issues);assert.equal(report.performancePassed,issues.length===0);
 if(release)assert.deepEqual(issues,[],`${profile.name}: UI smoothness budget failed`);
 return report;
}

/** CDP acknowledgements prove delivery to the protocol, while the browser's
 * recorder proves that the native pointer pair actually reached the page. */
export async function observeSmoothnessPan(cdp,start,delta,profile,{evaluate,sleep}){
 const began=await evaluate(cdp,'performance.now()');assert.ok(Number.isFinite(began));
 const receipt=await dispatchSourceEndPan(cdp,start,delta,profile,sleep);
 try{
  receipt.events=await evaluate(cdp,`(window.__tropnikInputEvents||[]).filter(event=>event.time>=${began}).map(({type,time,timestamp,pointerType,pointerId,trusted,x,y})=>({type,time,timestamp,pointerType,pointerId,trusted,x,y}))`);
  assertSourceEndPanInput(receipt,profile.mobile?'touch':'mouse',profile.name+'/smoothness-pan');
 }catch(error){error.panDiagnostics=receipt;throw error;}
 return receipt;
}

/** Read published inspection transitions only. No RAF loop, app callback,
 * prototype replacement, camera write, renderer invocation or network action.
 * An observer callback is after publication: its mark is an upper bound on
 * that paint, not a measurement of draw() duration. Coalescing is explicit. */
export function installProgressivePaintTrace(target,scenario){
 const perf=target.performance,element=target.document.querySelector('.atlas-canvas[data-map-engine]');
 if(!element)throw new Error('No published map inspection surface');
 const canvas=element.querySelector('canvas.tropnik-map-canvas');if(!canvas)throw new Error('No map raster canvas');
 if(target.__tropnikProgressivePaintTrace)throw new Error('Previous map observer was not removed');
 const limits={transitions:1024,keySets:32,tilesPerBatch:64,keyLength:256,inspectionChars:512*1024,errors:8};
 const report={schemaVersion:1,scenario,readOnly:true,source:'MutationObserver of existing data-map-inspection',limits,timeOriginMs:perf.timeOrigin,
  semantics:'Published snapshots, not live worker state. Marks follow publication. drawDelta=0 is not a new paint. Pointer/animation suppress publication, so revision gaps can be expected. Key overlap does not itself prove object identity.',
  transitions:[],canonicalKeySets:[],callbacks:0,mutationRecords:0,coalescedMutationRecords:0,identicalValuesSkipped:0,
  drawRevisionGaps:0,maxDrawRevisionDelta:0,readDurationTotalMs:0,readDurationMaxMs:0,overflow:false,errors:[],disconnected:false};
 const keySets=new Map();let stopped=false,lastText,lastDraw,observer;
 const error=problem=>{if(report.errors.length<limits.errors)report.errors.push(String(problem?.message||problem).slice(0,1000));};
 const keys=tiles=>{
  if(!Array.isArray(tiles)||tiles.length>limits.tilesPerBatch)throw new Error('Inspection tile list exceeds diagnostic bound');
  return tiles.map(tile=>{if(typeof tile.key!=='string'||!tile.key.length||tile.key.length>limits.keyLength)throw new Error('Invalid bounded tile key');return tile.key;});
 };
 const capture=(phase,force=false)=>{
  const began=perf.now();
  try{
   if(!element.isConnected)throw new Error('Observed map surface was replaced');
   const text=element.dataset.mapInspection;
   if(typeof text!=='string'||text.length>limits.inspectionChars)throw new Error('Missing or oversized published inspection');
   if(!force&&text===lastText){report.identicalValuesSkipped++;return;}lastText=text;
   if(report.transitions.length>=limits.transitions){report.overflow=true;observer?.disconnect();return;}
   const map=JSON.parse(text),canonical={overview:keys(map.tiles.overview),detail:keys(map.tiles.detail),relief:keys(map.tiles.relief),imagery:keys(map.tiles.imagery)};
   const identity=JSON.stringify(canonical);let keySet=keySets.get(identity);
   if(keySet===undefined){if(keySets.size>=limits.keySets){report.overflow=true;observer?.disconnect();return;}
    keySet=keySets.size;keySets.set(identity,keySet);report.canonicalKeySets.push({id:keySet,...canonical});}
   if(!Number.isSafeInteger(map.drawRevision)||map.drawRevision<0)throw new Error('Invalid published draw revision');
   const drawDelta=lastDraw===undefined?null:map.drawRevision-lastDraw;
   if(drawDelta!==null&&drawDelta<0)throw new Error('Published draw revision moved backwards');
   if(drawDelta>1)report.drawRevisionGaps+=drawDelta-1;
   report.maxDrawRevisionDelta=Math.max(report.maxDrawRevisionDelta,drawDelta??0);lastDraw=map.drawRevision;
   const loading=map.loadingGround,detail=loading?keys(loading.detail):[],relief=loading?keys(loading.relief):[];
   const canonicalDetail=new Set(canonical.detail),canonicalRelief=new Set(canonical.relief);
   const mark=perf.mark('tropnik:progressive-paint:'+scenario+':inspection:'+report.transitions.length);
   report.transitions.push({index:report.transitions.length,phase,callbackStartedAtMs:began,mark:{name:mark.name,startTimeMs:mark.startTime},observedAtEpochMs:Date.now(),
    drawRevision:map.drawRevision,drawDelta,labelRevision:map.labelRevision,canonicalKeySet:keySet,canvas:{width:canvas.width,height:canvas.height},
    camera:map.camera,moving:element.dataset.mapMoving==='true'||element.hasAttribute('data-map-camera'),hidden:target.document.visibilityState!=='visible',
    state:{ready:map.state.ready,loading:map.state.loading,mode:map.state.mode,committedMode:map.state.committedMode,error:map.state.error},
    coverage:{revision:map.coverage?.revision,pending:map.coverage?.pending,ready:map.coverage?.ready,error:map.coverage?.error},
    overlay:{ready:map.catalogueOverlay?.currentViewportReady,pending:map.catalogueOverlay?.pending,error:map.catalogueOverlay?.error},
    loading:loading?{generation:loading.generation,readyCells:loading.readyCells,requestedCells:loading.requestedCells,detailCount:detail.length,reliefCount:relief.length,
     detailKeysAlsoCanonical:detail.filter(key=>canonicalDetail.has(key)).length,reliefKeysAlsoCanonical:relief.filter(key=>canonicalRelief.has(key)).length}:null});
  }catch(problem){error(problem);}
  finally{const duration=perf.now()-began;report.readDurationTotalMs+=duration;report.readDurationMaxMs=Math.max(report.readDurationMaxMs,duration);}
 };
 observer=new target.MutationObserver(records=>{if(stopped)return;report.callbacks++;report.mutationRecords+=records.length;report.coalescedMutationRecords+=Math.max(0,records.length-1);capture('mutation');});
 observer.observe(element,{attributes:true,attributeFilter:['data-map-inspection']});capture('before',true);
 target.__tropnikProgressivePaintTrace={stop(){if(!stopped){stopped=true;observer.disconnect();capture('after',true);report.disconnected=true;delete target.__tropnikProgressivePaintTrace;}return report;}};
 return{installed:true,scenario,limits,timeOriginMs:perf.timeOrigin};
}

/** Previous isolated pan diagnosis: inspect existing caches outside the raw
 * window. Do not register/update a worker, open a cache, fetch or warm maps. */
async function progressiveWorkerSnapshot(cdp,evaluate,phase){
 try{return await evaluate(cdp,`(async()=>{
  const began=performance.now(),worker=value=>value?{scriptURL:value.scriptURL,state:value.state}:null;
  const registration=await navigator.serviceWorker?.getRegistration(location.href),scope=registration?.scope||new URL('.',location.href).href;
  const names=(await caches.keys()).filter(name=>name.includes('tropnik-shell-'));
  const shellCaches=await Promise.all(names.slice(0,16).map(async name=>{const markerURL=new URL('_offline/map-warm-'+name+'-canvas',scope).href,response=await caches.match(markerURL,{cacheName:name});return{name,markerURL,present:!!response,status:response?.status??null,ready:!!response&&response.ok&&await response.text()==='ready'};}));
  return{phase:${JSON.stringify(phase)},readOnly:true,startedAtMs:began,capturedAtMs:performance.now(),timeOriginMs:performance.timeOrigin,controller:worker(navigator.serviceWorker?.controller),registration:registration?{scope:registration.scope,active:worker(registration.active),waiting:worker(registration.waiting),installing:worker(registration.installing)}:null,shellCaches,truncated:names.length>16};
 })()`);}catch(error){return{phase,readOnly:true,error:String(error?.message||error)};}
}
async function progressiveClock(cdp,evaluate,scenario,phase){
 const name='tropnik:progressive-paint:'+scenario+':'+phase;
 try{return await evaluate(cdp,`(()=>{const mark=performance.mark(${JSON.stringify(name)});return{name:mark.name,startTimeMs:mark.startTime,timeOriginMs:performance.timeOrigin};})()`);}
 catch(error){return{name,error:String(error?.message||error)};}
}

/** Start tracing before the recorder window, then stop the window before trace
 * drainage. Each action still runs once, and its raw metrics survive failures. */
export async function measureSmoothnessWindow(cdp,name,action,{evaluate,report,tracing=false,sourceCommit=null,traceOptions={}}){
 const inspect=expression=>evaluate(cdp,expression);
 const focused=progressiveTrace&&tracing&&report.profile==='desktop-webgl'&&SMOOTHNESS_TRACE_SCENARIOS.includes(name);
 let context,observerStopped=false;
 if(focused){
  context={schemaVersion:1,scenario:name,diagnosticOnly:true,productionSourceCommit:'67d418dd1e187d065d2ff3bd3703c50b7436268b',errors:[],workerBefore:await progressiveWorkerSnapshot(cdp,evaluate,'before')};
  (report.progressivePaintTrace??=[]).push(context);
 }
 const stopObserver=async()=>{if(!focused||observerStopped)return;observerStopped=true;
  try{context.inspection=await inspect('window.__tropnikProgressivePaintTrace?.stop()??null');}catch(error){context.errors.push(String(error?.message||error));}};
 let releaseDrain;const windowClosed=new Promise(resolve=>{releaseDrain=resolve;});
 const measure=async()=>{
  try{
   if(focused){
    try{context.installed=await inspect('('+installProgressivePaintTrace.toString()+')(window,'+JSON.stringify(name)+')');}catch(error){context.errors.push(String(error?.message||error));}
    context.clockBefore=await progressiveClock(cdp,evaluate,name,'before');
   }
   await inspect(`window.__tropnikSmoothness.start(${JSON.stringify(name)})`);let error;
   try{await action();}catch(problem){error=problem;}
   await inspect('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   const raw=await inspect('window.__tropnikSmoothness.stop()');
   if(focused){context.clockAfter=await progressiveClock(cdp,evaluate,name,'after');await stopObserver();context.workerAfter=await progressiveWorkerSnapshot(cdp,evaluate,'after');}
   try{report.scenarios.push(summarizeSmoothness(raw));}catch(problem){error??=problem;report.invalidWindow=raw;}
   if(error)throw error;
  }finally{await stopObserver();releaseDrain();}
 };
 if(!tracing||!SMOOTHNESS_TRACE_SCENARIOS.includes(name)||(progressiveTrace&&!focused))return measure();
 const options={...traceOptions,...(focused?{limits:PROGRESSIVE_TRACE_LIMITS[name]}:{}),enabled:true,sourceCommit,prefix:`${report.profile}-ui-smoothness-${name}`,scope:`ui-smoothness/${report.profile}/${name}`,categories:FIRST_ALTAI_DIAGNOSTIC_TRACE_CATEGORIES,captureCategoryEvidence:true,beforeDrain:()=>windowClosed};
 try{
  const {trace}=await traceDesktopSelection(cdp,measure,options);report.traces.push({scenario:name,...trace});
 }catch(error){if(error.traceReceipt)report.traces.push({scenario:name,...error.traceReceipt});throw error;}
}

/** A short real-input path, independent of the long all-zoom matrix. */
export async function runSmoothnessAudit(cdp,profile,helpers,{cpuSlowdownRate=1,diagnostic=process.env.TROPNIK_BROWSER_DIAGNOSTIC??null,traceValue=process.env.TROPNIK_BROWSER_TRACE,sourceCommit=process.env.GITHUB_SHA||null}={}){
 const {loadProfile,evaluate,waitValue,sleep,settledMap,settledSheet,closeMapSheet,clearMapStories,pointerSelector,revealNative,scrollContainer,freeCanvasPoint,url}=helpers;
 const tracing=smoothnessTraceEnabled({diagnostic,traceValue,cpuSlowdownRate})&&(!progressiveTrace||profile.name==='desktop-webgl');
 const report={schemaVersion:1,profile:profile.name,engine:profile.engine,input:profile.mobile?'touch':'mouse',physicalDevice:false,cpuSlowdownRate,cpuThrottleRestored:false,instrumented:tracing,traces:[],passed:false,scenarios:[],performanceIssues:[],performancePassed:false};
 let originalFailure;
 const inspect=expression=>evaluate(cdp,expression);
 const wait=(label,expression,accept,timeout=10000)=>waitValue(label,()=>inspect(expression),accept,timeout);
 const measure=async(name,action)=>{
  try{return await measureSmoothnessWindow(cdp,name,action,{evaluate,report,tracing,sourceCommit});}
  finally{report.performanceIssues=report.scenarios.flatMap(window=>smoothnessIssues(window,profile));report.performancePassed=report.scenarios.length===SMOOTHNESS_SCENARIOS.length&&!report.performanceIssues.length;}
 };
 const type=async(selector,text)=>{
  await wait('Search input is not editable',`(()=>{const input=document.querySelector(${JSON.stringify(selector)});return !!input&&!input.disabled&&!input.readOnly})()`,Boolean);
  await pointerSelector(cdp,selector,profile);
  await wait('Native search click did not focus its input',`document.activeElement===document.querySelector(${JSON.stringify(selector)})`,Boolean);
  await sendNativeText(cdp,text,{sleep});
 };
 const searchState=()=>inspect("({value:document.querySelector('.search-field input')?.value,busy:document.querySelector('.explore-panel-content')?.getAttribute('aria-busy'),regions:[...document.querySelectorAll('.region-option strong')].map(node=>node.textContent)})");
 try{
  await cdp.call('Emulation.setCPUThrottlingRate',{rate:cpuSlowdownRate});
  await loadProfile(cdp,url,profile);await clearMapStories(cdp,profile);
  await measure('panel',async()=>{
   if(profile.mobile){await pointerSelector(cdp,'.sheet-handle',profile);await settledSheet(cdp,'open');await pointerSelector(cdp,'.sheet-handle',profile);await settledSheet(cdp,'closed');await pointerSelector(cdp,'.sheet-handle',profile);await settledSheet(cdp,'open');}
   else{await pointerSelector(cdp,'.layer-button',profile);await wait('Layers did not open',"!!document.querySelector('.layer-menu')",Boolean);await pointerSelector(cdp,'.layer-button',profile);await wait('Layers did not close',"!document.querySelector('.layer-menu')",Boolean);await sleep(150);}
  });
  await revealNative(cdp,'.search-field input','.explore-panel-content',profile);
  await measure('explore-search',async()=>{
   await type('.search-field input','Байкал');
   await waitValue('Explore search did not settle',searchState,state=>state.value==='Байкал'&&state.busy==='false'&&state.regions.some(value=>value.includes('Байкал')));
   await pointerSelector(cdp,'.search-field button[aria-label="Очистить поиск"]',profile);
   await type('.search-field input','Алтай');
   await waitValue('Altai search did not settle',searchState,state=>state.value==='Алтай'&&state.busy==='false'&&state.regions.includes('Алтай'));
  });
  const regionSelector=await inspect("(()=>{const nodes=[...document.querySelectorAll('.region-option')],index=nodes.findIndex(node=>node.querySelector('strong')?.textContent==='Алтай');return index<0?null:'.region-option:nth-child('+(index+1)+')'})()");
  assert.ok(regionSelector);await revealNative(cdp,regionSelector,'.explore-panel-content',profile);await pointerSelector(cdp,regionSelector,profile);
  await wait('Altai did not open',"new URL(location.href).searchParams.get('region')",value=>value==='altai');await settledMap(cdp,profile.engine);if(profile.mobile)await settledSheet(cdp,'open');
  await revealNative(cdp,'.filter-row button[aria-expanded]','.explore-panel-content',profile);
  await measure('explore-filters',async()=>{
   await pointerSelector(cdp,'.filter-row button[aria-expanded]',profile);await wait('Filter panel did not open',"document.querySelector('.filter-row button[aria-expanded]')?.getAttribute('aria-expanded')",value=>value==='true');
   await pointerSelector(cdp,'.filter-row button[aria-pressed]',profile);await wait('Saved filter did not activate',"document.querySelector('.filter-row button[aria-pressed]')?.getAttribute('aria-pressed')",value=>value==='true');
   await pointerSelector(cdp,'.filter-row button[aria-pressed]',profile);await pointerSelector(cdp,'.filter-row button[aria-expanded]',profile);await wait('Filter panel did not close',"document.querySelector('.filter-row button[aria-expanded]')?.getAttribute('aria-expanded')",value=>value==='false');await sleep(150);
  });
  await measure('catalog-scroll',async()=>{await scrollContainer(cdp,'.explore-panel-content',profile);});
  await closeMapSheet(cdp,profile);const before=await settledMap(cdp,profile.engine),start=await freeCanvasPoint(cdp,before);
  const delta={dx:start.x+80<before.rect.right?64:-64,dy:12};
  await measure('map-pan',async()=>{
   report.pan=await observeSmoothnessPan(cdp,start,delta,profile,{evaluate,sleep});const after=await settledMap(cdp,profile.engine);
   assert.ok(Math.abs(after.camera.longitude-before.camera.longitude)>1e-6||Math.abs(after.camera.latitude-before.camera.latitude)>1e-6,'Native pan made no progress');
  });
  await measure('map-zoom',async()=>{for(const [label,direction]of [['Увеличить масштаб',1],['Уменьшить масштаб',-1]]){const before=await settledMap(cdp,profile.engine);await pointerSelector(cdp,`.map-controls button[aria-label="${label}"]`,profile);const after=await settledMap(cdp,profile.engine);assert.ok((after.camera.zoom-before.camera.zoom)*direction>.1,`${label}: native input made no zoom progress`);}});
  await measure('layer-switch',async()=>{
   for(const [label,mode]of [['Спутник','satellite'],['Рельеф','detail']]){
    const before=await settledMap(cdp,profile.engine),selector=`.map-style-switch button[aria-label="${label}"]`;
    await pointerSelector(cdp,selector,profile);
    await wait(`${label} did not commit`,"(()=>{const d=document.querySelector('.atlas-wrap')?.dataset;return{committed:d?.mapBaseCommitted,target:d?.mapBaseTarget,state:d?.mapBaseState}})()",value=>value.target===mode&&value.state==='ready'&&value.committed===(mode==='detail'&&before.camera.zoom<5?'overview':mode),20000);
    const after=await settledMap(cdp,profile.engine);assert.deepEqual(after.camera,before.camera,'Mode switch changed the map camera');assert.equal(after.route,before.route);
    assert.equal(await inspect("document.querySelectorAll('.terrain-scene').length"),0,'Mode switch mounted the removed 3D scene');
   }
  });
  const searchURL=new URL('search/',url).href,loaded=cdp.event('Page.loadEventFired');await cdp.call('Page.navigate',{url:searchURL});await loaded;
  await wait('Site search did not mount',"!!document.querySelector('#search-query')",Boolean);await inspect('document.fonts.ready.then(()=>true)');await sleep(150);
  await measure('site-search',async()=>{
   await type('#search-query','Байкал до 15 км');
   await wait('Site search did not settle',"({value:document.querySelector('#search-query')?.value,busy:document.querySelector('#site-search-results')?.getAttribute('aria-busy'),results:document.querySelectorAll('#site-search-results li').length})",value=>value.value==='Байкал до 15 км'&&value.busy==='false'&&value.results>0);
   await pointerSelector(cdp,'button[aria-label="Очистить поиск"]',profile);await wait('Site search clear did not settle',"({value:document.querySelector('#search-query')?.value,busy:document.querySelector('#site-search-results')?.getAttribute('aria-busy')})",value=>value.value===''&&value.busy==='false');
  });
  report.performanceIssues=report.scenarios.flatMap(window=>smoothnessIssues(window,profile));report.performancePassed=!report.performanceIssues.length;report.passed=true;
 }catch(error){originalFailure=error;if(error.panDiagnostics)report.pan=error.panDiagnostics;error.smoothnessAudit=report;throw error;}
 finally{
  try{await cdp.call('Emulation.setCPUThrottlingRate',{rate:1});report.cpuThrottleRestored=true;}
  catch(error){
   report.cpuThrottleRestoreError=String(error?.message||error);
   if(originalFailure)originalFailure.cpuThrottleRestoreError=report.cpuThrottleRestoreError;
   else{error.smoothnessAudit=report;throw error;}
  }
 }
 assertSmoothnessAudit(report,profile,{release:false});return report;
}
