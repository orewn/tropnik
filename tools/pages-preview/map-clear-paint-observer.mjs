import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {traceDesktopSelection,FIRST_ALTAI_DIAGNOSTIC_TRACE_CATEGORIES} from './browser-trace.mjs';


function installObserver(outsideColor){
 if(window.__tropnikMapClearObservation)throw new Error('A paint observer is already installed');
 const canvas=document.querySelector('.tropnik-map-canvas');
 if(!canvas)throw new Error('Production map canvas is absent');
 const snapshot=()=>{
  const host=document.querySelector('[data-map-inspection]');
  if(!host?.dataset.mapInspection)throw new Error('Actual map inspection is absent');
  const data=JSON.parse(host.dataset.mapInspection);
  return{camera:data.camera,pitch:data.pitch,viewport:data.viewport,state:data.state,coverage:data.coverage,
   rasterPolicy:data.rasterPolicy,drawRevision:data.drawRevision,
   detail:(data.tiles?.detail||[]).map(({key,kind,z,x,y,width,height,transparent})=>({key,kind,z,x,y,width,height,transparent})),
   resources:data.resources,backing:{width:canvas.width,height:canvas.height}};
 };
 const before=snapshot(),prototype=CanvasRenderingContext2D.prototype;
 const original={rotate:prototype.rotate,fillRect:prototype.fillRect,fill:prototype.fill,drawImage:prototype.drawImage};
 const frames=[],errors=[],bindings={},outside=outsideColor.toLowerCase();let pendingPaper=0,current=null,overflow=false;
 const error=value=>{if(errors.length<16)errors.push(value);};
 bindings.fillRect=function(...args){
  if(this.canvas===canvas){
   if(args.length!==4||args[0]!==0||args[1]!==0||args[2]!==canvas.width||args[3]!==canvas.height)error('Unexpected ground fillRect bounds');
   if(this.fillStyle.toLowerCase()!==outside)error('Unexpected ground fillRect color');
   pendingPaper++;
  }
  return original.fillRect.apply(this,args);
 };
 bindings.rotate=function(...args){
  if(this.canvas===canvas){
   if(frames.length>=128){overflow=true;current=null;}
   else{current={index:frames.length,angle:args[0],width:canvas.width,height:canvas.height,paperClears:pendingPaper,countryAreaFills:0,finalMaskFills:0,drawImages:0,otherFillStyles:[]};frames.push(current);}
   pendingPaper=0;
  }
  return original.rotate.apply(this,args);
 };
 bindings.fill=function(...args){
  if(this.canvas===canvas){
   if(!current)error('Ground path fill outside an observed production frame');
   else{
    const color=this.fillStyle.toLowerCase();
    if(color==='#dce5cf')current.countryAreaFills++;
    else if(color===outside)current.finalMaskFills++;
    else if(current.otherFillStyles.length<8)current.otherFillStyles.push(color);
   }
  }
  return original.fill.apply(this,args);
 };
 bindings.drawImage=function(...args){
  if(this.canvas===canvas){if(!current)error('Ground image outside an observed production frame');else current.drawImages++;}
  return original.drawImage.apply(this,args);
 };
 for(const name of Object.keys(bindings))prototype[name]=bindings[name];
 window.__tropnikMapClearObservation={finish(){
  for(const name of Object.keys(bindings)){if(prototype[name]!==bindings[name])error('Paint observer was replaced: '+name);prototype[name]=original[name];}
  delete window.__tropnikMapClearObservation;
  return{schemaVersion:1,scope:'operation-observation-only',timingsAreEvidence:false,before,after:snapshot(),frames,errors,overflow,pendingPaper};
 }};
 return true;
}
export async function startMapPaintObservation(cdp,evaluate,outsideColor){
 assert.match(outsideColor,/^#[a-fA-F0-9]{6}$/);
 assert.equal(await evaluate(cdp,'('+installObserver.toString()+')('+JSON.stringify(outsideColor)+')'),true);
}
export async function finishMapPaintObservation(cdp,evaluate){
 const result=await evaluate(cdp,'window.__tropnikMapClearObservation.finish()');
 try{
 assert.equal(result.schemaVersion,1);assert.equal(result.scope,'operation-observation-only');assert.equal(result.timingsAreEvidence,false);
 assert.deepEqual(result.errors,[]);assert.equal(result.overflow,false);assert.equal(result.pendingPaper,0);
 assert.ok(result.frames.length>0&&result.frames.length<=128);
 for(const frame of result.frames){
  assert.equal(frame.index,result.frames.indexOf(frame));
  assert.ok(Number.isInteger(frame.width)&&frame.width>0&&Number.isInteger(frame.height)&&frame.height>0);
  assert.ok(frame.paperClears===0||frame.paperClears===1);
  assert.equal(frame.countryAreaFills,frame.paperClears,'Paper and country underlay must share the same exact predicate');
  assert.equal(frame.finalMaskFills,1,'Final Russia mask must remain in every production frame');
  if(frame.paperClears===0){assert.equal(Math.abs(frame.angle),0);assert.ok(frame.drawImages>0);}
 }
 result.coveredFrames=result.frames.filter(frame=>frame.paperClears===0).length;
 result.uncoveredFrames=result.frames.length-result.coveredFrames;
 result.paperPixelsAvoided=result.frames.filter(frame=>frame.paperClears===0).reduce((sum,frame)=>sum+frame.width*frame.height,0);
 result.optimizationExercised=result.coveredFrames>0;
 // A zero count is useful diagnosis, not a reason to suppress the other profile.
 result.guardEvidence='The immutable production draw computes its strict coverage predicate once; only its true branch omits both observed paper and country fills.';
 return result;
 }catch(error){error.paintObservation=result;throw error;}
}

const PAN_OUTPUT=new URL('../../web/pages-preview/design-qa/',import.meta.url);
// Profiler.start/stop and setSamplingInterval (microseconds):
// https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/js_protocol.pdl
const PAN_PROFILE_LIMITS=Object.freeze({durationMs:8000,commandMs:3000,maxBytes:16*1024*1024,samplingIntervalUs:1000});

/** Observed sample occupancy, not wall-time or performance certification. */
export function summarizePanCpuProfile(profile,range=null){
 assert.ok(profile&&Array.isArray(profile.nodes)&&Array.isArray(profile.samples)&&Array.isArray(profile.timeDeltas));
 assert.equal(profile.samples.length,profile.timeDeltas.length);
 assert.ok(Number.isFinite(profile.startTime)&&Number.isFinite(profile.endTime)&&profile.endTime>profile.startTime);
 const nodes=new Map(),parents=new Map();
 for(const node of profile.nodes){assert.ok(Number.isInteger(node.id)&&!nodes.has(node.id));nodes.set(node.id,node);}
 for(const node of profile.nodes)for(const child of node.children||[]){assert.ok(nodes.has(child));assert.ok(!parents.has(child));parents.set(child,node.id);}
 const lower=range?.startTime??profile.startTime,upper=range?.endTime??profile.endTime;
 assert.ok(Number.isFinite(lower)&&Number.isFinite(upper)&&lower>=profile.startTime&&upper<=profile.endTime&&upper>lower);
 let time=profile.startTime,negativeDeltas=0;
 const samples=profile.samples.map((id,index)=>{const delta=profile.timeDeltas[index];assert.ok(nodes.has(id)&&Number.isFinite(delta));if(delta<0)negativeDeltas++;time+=delta;return{id,time,index};}).sort((a,b)=>a.time-b.time||a.index-b.index);
 const self=new Map(),inclusive=new Map();let observedUs=0,count=0,maxGapUs=0;
 for(let index=0;index<samples.length;index++){
  const sample=samples[index],next=index+1<samples.length?samples[index+1].time:profile.endTime;
  const duration=Math.max(0,Math.min(next,upper)-Math.max(sample.time,lower));
  if(!duration)continue;observedUs+=duration;count++;maxGapUs=Math.max(maxGapUs,duration);
  self.set(sample.id,(self.get(sample.id)||0)+duration);
  const seen=new Set();let id=sample.id;
  while(id!==undefined){assert.ok(!seen.has(id),'Cyclic CPU profile ancestry');seen.add(id);inclusive.set(id,(inclusive.get(id)||0)+duration);id=parents.get(id);}
 }
 const hotspots=values=>[...values].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,40).map(([id,us])=>({nodeId:id,observedMs:us/1000,callFrame:nodes.get(id).callFrame}));
 return{scope:range?.scope??'whole-recorded-native-gesture',attribution:'sample state from its timestamp to the next chronologically sorted sample; clipped to the stated range',isPerformanceAcceptance:false,startTime:lower,endTime:upper,durationMs:(upper-lower)/1000,observedMs:observedUs/1000,unobservedMs:(upper-lower-observedUs)/1000,samples:count,totalSamples:samples.length,negativeDeltas,maxObservedGapMs:maxGapUs/1000,self:hotspots(self),inclusive:hotspots(inclusive)};
}

export function testPanProfileSummary(){
 const profile={startTime:1000,endTime:6000,nodes:[
  {id:1,callFrame:{functionName:'(root)'},children:[2]},
  {id:2,callFrame:{functionName:'draw'},children:[3,4]},
  {id:3,callFrame:{functionName:'drawLabels'}},{id:4,callFrame:{functionName:'drawImage'}},
 ],samples:[3,4,3],timeDeltas:[1000,2000,1000]};
 const summary=summarizePanCpuProfile(profile,{startTime:2500,endTime:4500,scope:'active-pointer'});
 assert.equal(summary.observedMs,2);assert.equal(summary.self.find(x=>x.nodeId===3).observedMs,1.5);
 assert.equal(summary.self.find(x=>x.nodeId===4).observedMs,.5);
 assert.equal(summary.inclusive.find(x=>x.nodeId===2).observedMs,2);
 assert.throws(()=>summarizePanCpuProfile({...profile,samples:[99],timeDeltas:[1]}));
 assert.throws(()=>summarizePanCpuProfile(profile,{startTime:0,endTime:4500}));
 const reordered=summarizePanCpuProfile({...profile,samples:[3,4,3],timeDeltas:[1000,2000,-1000]});
 assert.equal(reordered.negativeDeltas,1);assert.equal(reordered.observedMs,4);
 return{tests:6,passed:true};
}

export async function profileNativeMapPan(cdp,evaluate,profile,report,action){
 const prefix=profile.name+'-map-pan-observed',startMark=prefix+'-native-start',endMark=prefix+'-native-end';
 const receipt={schemaVersion:1,sourceCommit:process.env.GITHUB_SHA||null,profile:profile.name,scope:'unchanged-native-map-pan-only',instrumented:true,timingsAreEvidence:false,releaseEligible:false,limits:{...PAN_PROFILE_LIMITS},status:'recording',errors:[]};
 report.panProfile=receipt;
 let cpuProfile=null,stopPromise,timer,enabled=false,started=false,value,actionError;
 const stop=reason=>{
  if(stopPromise)return stopPromise;
  receipt.stopReason=reason;if(timer!==undefined){clearTimeout(timer);timer=undefined;}
  return stopPromise=(async()=>{
   if(!started)return;
   try{cpuProfile=(await cdp.call('Profiler.stop',{},PAN_PROFILE_LIMITS.commandMs)).profile;}
   catch(error){receipt.errors.push('Profiler.stop: '+String(error.stack||error));}
  })();
 };
 const mark=async name=>evaluate(cdp,'(()=>{const marker=performance.mark('+JSON.stringify(name)+');return{markerStartTime:marker.startTime,timeOrigin:performance.timeOrigin,visibility:document.visibilityState}})()');
 try{
  const result=await traceDesktopSelection(cdp,async()=>{
   try{
    await cdp.call('Profiler.enable',{},PAN_PROFILE_LIMITS.commandMs);enabled=true;
    await cdp.call('Profiler.setSamplingInterval',{interval:PAN_PROFILE_LIMITS.samplingIntervalUs},PAN_PROFILE_LIMITS.commandMs);
    await cdp.call('Profiler.start',{},PAN_PROFILE_LIMITS.commandMs);started=true;
    timer=setTimeout(()=>{void stop('time-limit');},PAN_PROFILE_LIMITS.durationMs);
    receipt.startMarker=await mark(startMark);
   }catch(error){receipt.errors.push('Profiler.start: '+String(error.stack||error));}
   try{value=await action();return value;}
   catch(error){actionError=error;throw error;}
   finally{
    try{receipt.endMarker=await mark(endMark);}catch(error){receipt.errors.push('End marker: '+String(error));}
    await stop(actionError?'action-error':'native-input-complete');
   }
  },{
   enabled:true,sourceCommit:receipt.sourceCommit,output:PAN_OUTPUT,prefix,scope:'native-map-pan-observation/'+profile.name,
   limits:{durationMs:10000,drainMs:5000,closeMs:1000,maxBytes:32*1024*1024,bufferSizeKiB:16*1024,chunkBytes:256*1024},
   // The explicit Profiler owns CPU sampling. Do not enable a second V8 CPU
   // profiler through Tracing; retain actual Blink/cc/Viz/Skia thread work.
   categories:FIRST_ALTAI_DIAGNOSTIC_TRACE_CATEGORIES.filter(name=>!name.includes('v8.cpu_profiler')),
   captureCategoryEvidence:true,
  });
  receipt.trace=result.trace;
 }catch(error){actionError??=error;if(error.traceReceipt)receipt.trace=error.traceReceipt;}
 finally{
  await stop(actionError?'action-error':'complete');
  if(timer!==undefined)clearTimeout(timer);
  if(enabled)try{await cdp.call('Profiler.disable',{},PAN_PROFILE_LIMITS.commandMs);}catch(error){receipt.errors.push('Profiler.disable: '+String(error));}
  try{
   await mkdir(PAN_OUTPUT,{recursive:true});
   if(cpuProfile){
    const bytes=Buffer.from(JSON.stringify(cpuProfile)+'\n');
    receipt.profileBytes=bytes.length;
    assert.ok(bytes.length<=PAN_PROFILE_LIMITS.maxBytes,'CPU profile byte cap exceeded');
    receipt.profileFile=prefix+'.cpuprofile';receipt.profileSHA256=createHash('sha256').update(bytes).digest('hex');
    await writeFile(new URL(receipt.profileFile,PAN_OUTPUT),bytes);
    receipt.cpu=summarizePanCpuProfile(cpuProfile);
   }else receipt.errors.push('No actual CDP CPU profile returned');
   if(receipt.trace?.file&&receipt.trace.eof&&receipt.startMarker&&receipt.endMarker){
    const trace=JSON.parse(await readFile(new URL(receipt.trace.file,PAN_OUTPUT),'utf8')),events=trace.traceEvents;
    const marks=name=>events.filter(event=>event.name===name&&Number.isFinite(event.ts));
    const starts=marks(startMark),ends=marks(endMark);
    assert.equal(starts.length,1,'Expected one native start trace marker');assert.equal(ends.length,1,'Expected one native end trace marker');
    receipt.traceMarkers={start:starts[0].ts,end:ends[0].ts};
    const trusted=value?.events?.filter(event=>event.trusted);
    const downs=trusted?.filter(event=>event.type==='pointerdown')||[],ups=trusted?.filter(event=>event.type==='pointerup'||event.type==='pointercancel')||[];
    assert.equal(downs.length,1);assert.equal(ups.length,1);assert.equal(ups[0].type,'pointerup');
    const offset=starts[0].ts-receipt.startMarker.markerStartTime*1000;
    const range={scope:'actual-trusted-pointerdown-through-pointerup',startTime:offset+downs[0].time*1000,endTime:offset+ups[0].time*1000};
    receipt.activePointer={startPageMs:downs[0].time,endPageMs:ups[0].time,durationMs:ups[0].time-downs[0].time,traceOffsetUs:offset};
    if(cpuProfile)receipt.activePointer.cpu=summarizePanCpuProfile(cpuProfile,range);
    const threadNames=new Map(events.filter(event=>event.ph==='M'&&event.name==='thread_name').map(event=>[event.pid+':'+event.tid,event.args?.name||'unknown']));
    const aggregates=new Map();
    for(const event of events){
     if(event.ph!=='X'||!Number.isFinite(event.ts)||!Number.isFinite(event.dur))continue;
     const duration=Math.max(0,Math.min(event.ts+event.dur,range.endTime)-Math.max(event.ts,range.startTime));if(!duration)continue;
     const key=event.pid+':'+event.tid+':'+event.name;let row=aggregates.get(key);
     if(!row){row={pid:event.pid,tid:event.tid,thread:threadNames.get(event.pid+':'+event.tid)||'unknown',name:event.name,count:0,inclusiveMs:0,maxMs:0};aggregates.set(key,row);}
     row.count++;row.inclusiveMs+=duration/1000;row.maxMs=Math.max(row.maxMs,duration/1000);
    }
    receipt.activePointer.traceHotspots=[...aggregates.values()].sort((a,b)=>b.inclusiveMs-a.inclusiveMs).slice(0,60);
    receipt.activePointer.traceTimesAreNestedInclusive=true;
   }
  }catch(error){receipt.errors.push('Profile evidence: '+String(error.stack||error));}
  receipt.status=receipt.errors.length?'error':receipt.stopReason==='time-limit'||receipt.trace?.status!=='complete'?'partial':'complete';
  await writeFile(new URL(prefix+'.profile-meta.json',PAN_OUTPUT),JSON.stringify(receipt,null,2)+'\n');
 }
 if(actionError)throw actionError;
 if(receipt.status!=='complete'){const error=new Error('Native pan profile is '+receipt.status+': '+receipt.errors.join('; '));error.panProfile=receipt;throw error;}
 return value;
}
