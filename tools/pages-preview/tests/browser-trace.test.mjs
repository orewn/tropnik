import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {browserTraceEnabled,traceDesktopSelection,DESKTOP_TRACE_LIMITS,TERRAIN_TRACE_LIMITS,DESKTOP_TRACE_CATEGORIES,traceCategoryEvidence,recordBrowserLongTask} from '../browser-trace.mjs';

const traceJSON=JSON.stringify({traceEvents:[{name:'ProfileChunk',cat:'disabled-by-default-v8.cpu_profiler',args:{data:{cpuProfile:{samples:[1,2,3]}}}},{name:'RunTask',cat:'gpu'},{name:'Layout',cat:'cc,viz'}]});
async function outputDirectory(t){const directory=await mkdtemp(join(tmpdir(),'tropnik-trace-'));t.after(()=>rm(directory,{recursive:true,force:true}));return pathToFileURL(directory+'/');}
function controlledTimers(){
 let next=0;const pending=new Map();
 return{pending,schedule:(fn,ms)=>{const id=++next;pending.set(id,{fn,ms});return id;},cancel:id=>pending.delete(id),fireDuration(duration=DESKTOP_TRACE_LIMITS.durationMs){const timer=[...pending.values()].find(value=>value.ms===duration);assert.ok(timer);timer.fn();}};
}
function protocol({readError,startError,endError,endAck,oversized=false,dataLossOccurred=false,onRead,limits=DESKTOP_TRACE_LIMITS}={}){
 const calls=[],observers=new Map();let readIndex=0;
 return{calls,observers,
  observe(name,callback){assert.equal(name,'Tracing.tracingComplete');observers.set(name,callback);return()=>observers.delete(name);},
  async call(method,params,timeout){
   calls.push({method,params,timeout});assert.ok(timeout>0&&timeout<=limits.drainMs);
   if(method==='Tracing.start'){
    assert.ok(observers.has('Tracing.tracingComplete'),'Listen before an early completion event');
    assert.equal(params.transferMode,'ReturnAsStream');assert.equal(params.streamFormat,'json');
    assert.equal(params.traceConfig.recordMode,'recordUntilFull');assert.equal(params.traceConfig.enableSampling,true);
    assert.equal(params.traceConfig.traceBufferSizeInKb,limits.bufferSizeKiB);
    assert.ok(params.traceConfig.includedCategories.includes('disabled-by-default-v8.cpu_profiler'));
    if(startError)throw startError;return{};
   }
   if(method==='Tracing.end'){
    if(!startError)observers.get('Tracing.tracingComplete')?.({stream:'trace-stream',dataLossOccurred});
    if(endError)throw endError;if(endAck)await endAck;return{};
   }
   if(method==='IO.read'){
    assert.equal(params.handle,'trace-stream');assert.ok(params.size>0&&params.size<=limits.chunkBytes);
    if(readError)throw readError;
    onRead?.();
    if(oversized)return{data:'x'.repeat(128),eof:false};
    return readIndex++===0?{data:Buffer.from(traceJSON.slice(0,20)).toString('base64'),base64Encoded:true,eof:false}:{data:traceJSON.slice(20),eof:true};
   }
   if(method==='IO.close'){assert.equal(params.handle,'trace-stream');return{};}
   assert.fail(`Unexpected protocol call ${method}`);
  },
 };
}
async function metadata(output,prefix='desktop-webgl-first-altai'){return JSON.parse(await readFile(new URL(`${prefix}.trace-meta.json`,output),'utf8'));}

test('full-matrix tracing requires an explicit flag while dedicated terrain diagnostics keep recording',()=>{
 for(const value of [undefined,''])assert.equal(browserTraceEnabled(value),false);
 assert.equal(browserTraceEnabled('1'),true);
 for(const value of [undefined,'','1'])assert.equal(browserTraceEnabled(value,'terrain-close'),true);
 for(const value of [undefined,'','1'])assert.equal(browserTraceEnabled(value,'map-interactions'),true);
 for(const value of ['0','true','false','all',' 1 ','2',true,1,null]){
  assert.throws(()=>browserTraceEnabled(value),/Unknown TROPNIK_BROWSER_TRACE/);
  assert.throws(()=>browserTraceEnabled(value,'terrain-close'),/Unknown TROPNIK_BROWSER_TRACE/);
 }
});

test('the actual maximum long task survives the32-entry recent ring without changing audit counter resets',()=>{
 const state={__tropnikPerf:{cls:0,longest:0},__tropnikLongTasks:[]};
 const worst={startTime:8100,duration:851,phase:'map-interactions/first-altai'};recordBrowserLongTask(state,worst);
 for(let i=0;i<40;i++)recordBrowserLongTask(state,{startTime:10000+i*100,duration:55,phase:'map-interactions/sibling-polygon'});
 assert.equal(state.__tropnikLongTasks.length,32);assert.equal(state.__tropnikLongTasks.includes(worst),false);
 assert.equal(state.__tropnikPerf.longest,851);assert.equal(state.__tropnikPerf.peakLongTask,worst);
 state.__tropnikPerf={cls:0,longest:0};const next={startTime:20000,duration:79,phase:'next-audit'};recordBrowserLongTask(state,next);
 assert.equal(state.__tropnikPerf.longest,79);assert.equal(state.__tropnikPerf.peakLongTask,next);
});

test('default full-matrix action runs once without tracer calls, timers or evidence files',async t=>{
 const output=await outputDirectory(t),value={selected:'altai'};let actions=0;
 const forbidden=()=>assert.fail('Disabled tracing must not start diagnostics');
 const result=await traceDesktopSelection({observe:forbidden,call:forbidden},async()=>{actions++;return value;},
  {enabled:browserTraceEnabled(undefined),output,clock:forbidden,schedule:forbidden,cancel:forbidden});
 assert.equal(actions,1);assert.equal(result.value,value);assert.equal(result.trace,null);
 assert.deepEqual(await readdir(output),[]);
});

test('disabled tracing preserves the original action failure and settle evidence without retrying',async t=>{
 const output=await outputDirectory(t),failure=new Error('The maplibre map did not settle');let actions=0;
 failure.settleDiagnostics={timeoutMs:15000,requiredIdleObservations:4,samples:[{frameMs:6026}]};
 const forbidden=()=>assert.fail('Disabled tracing must not touch the protocol');
 const observed=await traceDesktopSelection({observe:forbidden,call:forbidden},async()=>{actions++;throw failure;},
  {enabled:browserTraceEnabled(''),output}).then(()=>null,error=>error);
 assert.equal(observed,failure);assert.equal(actions,1);assert.equal('traceReceipt' in failure,false);
 assert.equal(observed.settleDiagnostics.samples[0].frameMs,6026);assert.deepEqual(await readdir(output),[]);
});

test('explicit full-matrix and dedicated diagnostic tracing each wrap the same action exactly once',async t=>{
 for(const [label,value,diagnostic] of [['full-opt-in','1',null],['dedicated',undefined,'terrain-close']]){
  const output=await outputDirectory(t),cdp=protocol(),nativeResult={label};let actions=0;
  const result=await traceDesktopSelection(cdp,async()=>{actions++;return nativeResult;},
   {enabled:browserTraceEnabled(value,diagnostic),output,...controlledTimers()});
  assert.equal(actions,1);assert.equal(result.value,nativeResult);assert.equal(result.trace.status,'complete');
  assert.equal(cdp.calls.filter(call=>call.method==='Tracing.start').length,1);
  assert.equal(cdp.calls.filter(call=>call.method==='Tracing.end').length,1);
  assert.deepEqual(await metadata(output),result.trace);
 }
});

test('a failed native selection still stops, drains and closes its trace without replacing the assertion',async t=>{
 const output=await outputDirectory(t),timers=controlledTimers(),failure=new Error('Actual route selection failed');
 let acknowledgeEnd,actions=0;const cdp=protocol({endAck:new Promise(resolve=>{acknowledgeEnd=resolve;})});
 const observed=traceDesktopSelection(cdp,async()=>{actions++;throw failure;},{enabled:browserTraceEnabled('1'),output,sourceCommit:'a'.repeat(40),...timers}).then(()=>null,error=>error);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cdp.calls.filter(call=>call.method==='Tracing.end').length,1);
 assert.equal(cdp.calls.some(call=>call.method==='IO.read'),false,'Completion can precede its end acknowledgement');
 acknowledgeEnd();assert.equal(await observed,failure);assert.equal(actions,1);
 assert.deepEqual(cdp.calls.map(call=>call.method),['Tracing.start','Tracing.end','IO.read','IO.read','IO.close']);
 assert.equal(cdp.observers.size,0);assert.equal(timers.pending.size,0);
 const receipt=await metadata(output),bytes=await readFile(new URL(receipt.file,output));
 assert.equal(receipt.status,'complete');assert.equal(receipt.stopReason,'action-error');assert.match(receipt.actionError,/Actual route selection failed/);
 assert.equal(receipt.cpuProfileChunks,1);assert.equal(receipt.cpuSamples,3);assert.equal(receipt.timelineEvents,2);
 assert.equal(receipt.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(bytes.toString(),traceJSON);
});

test('the capture time cap stops and drains before a still-pending selection completes',async t=>{
 const output=await outputDirectory(t),timers=controlledTimers(),cdp=protocol();let finishAction,now=0;
 const pending=traceDesktopSelection(cdp,()=>new Promise(resolve=>{finishAction=resolve;}),{output,...timers,clock:()=>now});
 await new Promise(resolve=>setImmediate(resolve));now=DESKTOP_TRACE_LIMITS.durationMs;timers.fireDuration();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cdp.calls.at(-1).method,'IO.close','Recording must end while the action is still pending');
 finishAction('selected-altai');const result=await pending;
 assert.equal(result.value,'selected-altai');assert.equal(result.trace.status,'partial');assert.equal(result.trace.stopReason,'time-limit');
 assert.equal(result.trace.recordedDurationMs,DESKTOP_TRACE_LIMITS.durationMs);
 assert.equal(cdp.calls.filter(call=>call.method==='Tracing.end').length,1,'Finally must reuse the completed stop');
 assert.equal(cdp.observers.size,0);assert.equal(timers.pending.size,0);
});

test('the stream drain deadline stops further reads but still closes the protocol handle',async t=>{
 const output=await outputDirectory(t),timers=controlledTimers();let now=0;
 const cdp=protocol({onRead:()=>{now=DESKTOP_TRACE_LIMITS.drainMs+1;}});
 const result=await traceDesktopSelection(cdp,async()=>31,{output,...timers,clock:()=>now});
 assert.equal(result.value,31);assert.equal(result.trace.status,'error');assert.match(result.trace.errors[0],/drain time limit/);
 assert.equal(cdp.calls.filter(call=>call.method==='IO.read').length,1);assert.equal(cdp.calls.at(-1).method,'IO.close');
 assert.equal(cdp.observers.size,0);assert.equal(timers.pending.size,0);
});

test('the trace byte cap discards unread backing storage and marks partial evidence',async t=>{
 const output=await outputDirectory(t),timers=controlledTimers(),cdp=protocol({oversized:true});
 const result=await traceDesktopSelection(cdp,async()=>17,{output,...timers,limits:{...DESKTOP_TRACE_LIMITS,maxBytes:32},captureCategoryEvidence:true});
 assert.equal(result.value,17);assert.equal(result.trace.status,'partial');assert.equal(result.trace.truncated,'byte-limit');
 assert.equal(result.trace.bytes,32);assert.equal(result.trace.eof,false);assert.match(result.trace.file,/\.partial\.json$/);
 assert.equal((await stat(new URL(result.trace.file,output))).size,32);
 assert.equal(cdp.calls.filter(call=>call.method==='IO.read').length,1);assert.equal(cdp.calls.at(-1).method,'IO.close');
 assert.equal(cdp.observers.size,0);assert.equal(timers.pending.size,0);
 assert.deepEqual(result.trace.capturedCategories,{available:false,source:'traceEvents[].cat',reason:'incomplete-trace-stream'});
});

test('a complete JSON export cannot hide a browser buffer overflow',async t=>{
 const output=await outputDirectory(t),timers=controlledTimers(),cdp=protocol({dataLossOccurred:true});
 const result=await traceDesktopSelection(cdp,async()=>29,{output,...timers});
 assert.equal(result.value,29);assert.equal(result.trace.eof,true);
 assert.equal(result.trace.status,'partial');assert.equal(result.trace.dataLossOccurred,true);
 assert.equal(result.trace.cpuSamples,3);assert.equal(result.trace.errors.length,0);
 assert.equal((await metadata(output)).dataLossOccurred,true);
});

test('a failed trace read still closes its stream and leaves the original action result intact',async t=>{
 const output=await outputDirectory(t),timers=controlledTimers(),cdp=protocol({readError:new Error('Read failed')});
 const result=await traceDesktopSelection(cdp,async()=>23,{output,...timers});
 assert.equal(result.value,23);assert.equal(result.trace.status,'error');assert.match(result.trace.errors[0],/Read failed/);
 assert.equal(cdp.calls.at(-1).method,'IO.close');assert.equal(cdp.observers.size,0);assert.equal(timers.pending.size,0);
 assert.equal((await metadata(output)).status,'error');
});

test('an ambiguous start failure receives bounded end cleanup without skipping or repeating input',async t=>{
 const output=await outputDirectory(t),timers=controlledTimers(),cdp=protocol({startError:new Error('Start ACK timed out'),endError:new Error('Tracing not started')});let actions=0;
 const result=await traceDesktopSelection(cdp,async()=>++actions,{output,...timers});
 assert.equal(actions,1);assert.equal(result.value,1);assert.equal(result.trace.status,'error');
 assert.deepEqual(cdp.calls.map(call=>call.method),['Tracing.start','Tracing.end']);
 assert.equal(cdp.observers.size,0);assert.equal(timers.pending.size,0);
});

test('the terrain scope has isolated files and explicit larger caps without changing Altai defaults',async t=>{
 const output=await outputDirectory(t),prefix='desktop-webgl-terrain-zoom',scope='first-desktop-terrain-zoom-4-to-6';let actions=0;
 const altai=await traceDesktopSelection(protocol(),async()=>++actions,{output,...controlledTimers()});
 const terrain=await traceDesktopSelection(protocol({limits:TERRAIN_TRACE_LIMITS}),async()=>++actions,{output,prefix,scope,limits:TERRAIN_TRACE_LIMITS,...controlledTimers()});
 assert.equal(actions,2);assert.equal(altai.value,1);assert.equal(terrain.value,2);
 assert.equal(altai.trace.scope,'first-desktop-altai-selection');assert.equal(altai.trace.file,'desktop-webgl-first-altai.trace.json');
 assert.deepEqual(altai.trace.limits,{durationMs:8000,drainMs:5000,closeMs:1000,maxBytes:32*1024*1024,bufferSizeKiB:16*1024,chunkBytes:256*1024});
 assert.equal('capturedCategories' in altai.trace,false,'The release trace keeps its default evidence fields');
 assert.equal(terrain.trace.scope,scope);assert.equal(terrain.trace.file,`${prefix}.trace.json`);
 assert.equal(terrain.trace.limits.durationMs,20000);assert.equal(terrain.trace.limits.bufferSizeKiB,64*1024);assert.equal(terrain.trace.limits.maxBytes,96*1024*1024);
 assert.deepEqual(await metadata(output),altai.trace);assert.deepEqual(await metadata(output,prefix),terrain.trace);
 assert.equal(await readFile(new URL(altai.trace.file,output),'utf8'),traceJSON);assert.equal(await readFile(new URL(terrain.trace.file,output),'utf8'),traceJSON);
});

test('the terrain time cap drains while settle is pending and preserves its later original failure',async t=>{
 const output=await outputDirectory(t),timers=controlledTimers(),cdp=protocol({limits:TERRAIN_TRACE_LIMITS}),prefix='desktop-webgl-terrain-zoom';
 const failure=new Error('The maplibre map did not settle');failure.settleDiagnostics={sampleLimit:16,samples:[{phase:'observed',frameMs:6026,state:{camera:{zoom:5.905}}}]};
 let rejectAction,actions=0,now=0;
 const observed=traceDesktopSelection(cdp,()=>{actions++;return new Promise((_,reject)=>{rejectAction=reject;});},{output,prefix,scope:'first-desktop-terrain-zoom-4-to-6',limits:TERRAIN_TRACE_LIMITS,...timers,clock:()=>now}).then(()=>null,error=>error);
 await new Promise(resolve=>setImmediate(resolve));now=20000;timers.fireDuration(20000);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cdp.calls.at(-1).method,'IO.close');assert.equal(actions,1);
 rejectAction(failure);assert.equal(await observed,failure);
 const receipt=await metadata(output,prefix);
 assert.equal(receipt.stopReason,'time-limit');assert.equal(receipt.status,'partial');assert.equal(receipt.recordedDurationMs,20000);assert.match(receipt.actionError,/did not settle/);
 assert.deepEqual(failure.traceReceipt,receipt);assert.equal(failure.settleDiagnostics.samples[0].frameMs,6026);
 assert.equal(cdp.calls.filter(call=>call.method==='Tracing.end').length,1);assert.equal(cdp.observers.size,0);assert.equal(timers.pending.size,0);
});

test('a failed terrain capture cannot replace the settle failure or discard its diagnostic samples',async t=>{
 const output=await outputDirectory(t),prefix='desktop-webgl-terrain-zoom',cdp=protocol({limits:TERRAIN_TRACE_LIMITS,readError:new Error('Trace stream failed')});
 const failure=new Error('Exact camera never settled'),diagnostics={sampleLimit:16,samples:[{index:1,state:{camera:{centerX:520.5000000000027}}}]};failure.settleDiagnostics=diagnostics;
 const observed=await traceDesktopSelection(cdp,async()=>{throw failure;},{output,prefix,scope:'first-desktop-terrain-zoom-4-to-6',limits:TERRAIN_TRACE_LIMITS,...controlledTimers()}).then(()=>null,error=>error);
 assert.equal(observed,failure);assert.equal(observed.settleDiagnostics,diagnostics);
 assert.equal(observed.traceReceipt.status,'error');assert.match(observed.traceReceipt.errors[0],/Trace stream failed/);
 assert.equal(cdp.calls.at(-1).method,'IO.close');assert.deepEqual(await metadata(output,prefix),observed.traceReceipt);
});

test('explicit diagnostic compositor categories reach CDP and the receipt without mutating defaults',async t=>{
 const output=await outputDirectory(t),cdp=protocol({limits:TERRAIN_TRACE_LIMITS}),categories=[...DESKTOP_TRACE_CATEGORIES,'cc','viz','disabled-by-default-gpu.service'];
 const result=await traceDesktopSelection(cdp,async()=>5,{output,prefix:'desktop-webgl-terrain-high-zoom',scope:'diagnostic-desktop-terrain-15-to-17',limits:TERRAIN_TRACE_LIMITS,categories,captureCategoryEvidence:true,...controlledTimers()});
 assert.deepEqual(cdp.calls[0].params.traceConfig.includedCategories,categories);assert.deepEqual(result.trace.categories,categories);
 assert.equal(result.trace.limits.durationMs,20000);assert.equal(DESKTOP_TRACE_CATEGORIES.includes('cc'),false);assert.equal(DESKTOP_TRACE_CATEGORIES.includes('viz'),false);
 assert.deepEqual((await metadata(output,'desktop-webgl-terrain-high-zoom')).categories,categories);
 assert.deepEqual(result.trace.capturedCategories.counts.map(item=>item.name),['cc','disabled-by-default-v8.cpu_profiler','gpu','viz']);
 assert.equal(result.trace.capturedCategories.counts.some(item=>item.name==='disabled-by-default-gpu.service'),false,'Requested categories are not claimed as observed');
});

test('observed category evidence is bounded and remains available when the traced action fails',async t=>{
 const events=Array.from({length:140},(_,index)=>({cat:`category-${index}`}));events.push({cat:'gpu, viz, gpu'},{cat:'gpu'});
 const bounded=traceCategoryEvidence(events);assert.equal(bounded.categoryCount,142);assert.equal(bounded.counts.length,128);assert.equal(bounded.truncated,true);assert.deepEqual(bounded.counts[0],{name:'gpu',events:2});
 const output=await outputDirectory(t),failure=new Error('Native terrain settle failed'),categories=[...DESKTOP_TRACE_CATEGORIES,'cc','viz'];
 const observed=await traceDesktopSelection(protocol(),async()=>{throw failure;},{output,prefix:'failed-terrain',categories,captureCategoryEvidence:true,...controlledTimers()}).then(()=>null,error=>error);
 assert.equal(observed,failure);assert.equal(observed.traceReceipt.stopReason,'action-error');assert.equal(observed.traceReceipt.capturedCategories.available,true);
 assert.deepEqual(observed.traceReceipt.capturedCategories.counts,traceCategoryEvidence(JSON.parse(traceJSON).traceEvents).counts);
 assert.deepEqual((await metadata(output,'failed-terrain')).capturedCategories,observed.traceReceipt.capturedCategories);
});
