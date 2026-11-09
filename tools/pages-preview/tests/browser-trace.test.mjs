import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {traceDesktopSelection,DESKTOP_TRACE_LIMITS} from '../browser-trace.mjs';

const traceJSON=JSON.stringify({traceEvents:[{name:'ProfileChunk',args:{data:{cpuProfile:{samples:[1,2,3]}}}},{name:'RunTask'},{name:'Layout'}]});
async function outputDirectory(t){const directory=await mkdtemp(join(tmpdir(),'tropnik-trace-'));t.after(()=>rm(directory,{recursive:true,force:true}));return pathToFileURL(directory+'/');}
function controlledTimers(){
 let next=0;const pending=new Map();
 return{pending,schedule:(fn,ms)=>{const id=++next;pending.set(id,{fn,ms});return id;},cancel:id=>pending.delete(id),fireDuration(){const timer=[...pending.values()].find(value=>value.ms===DESKTOP_TRACE_LIMITS.durationMs);assert.ok(timer);timer.fn();}};
}
function protocol({readError,startError,endError,endAck,oversized=false,onRead}={}){
 const calls=[],observers=new Map();let readIndex=0;
 return{calls,observers,
  observe(name,callback){assert.equal(name,'Tracing.tracingComplete');observers.set(name,callback);return()=>observers.delete(name);},
  async call(method,params,timeout){
   calls.push({method,params,timeout});assert.ok(timeout>0&&timeout<=DESKTOP_TRACE_LIMITS.drainMs);
   if(method==='Tracing.start'){
    assert.ok(observers.has('Tracing.tracingComplete'),'Listen before an early completion event');
    assert.equal(params.transferMode,'ReturnAsStream');assert.equal(params.streamFormat,'json');
    assert.equal(params.traceConfig.recordMode,'recordUntilFull');assert.equal(params.traceConfig.enableSampling,true);
    assert.equal(params.traceConfig.traceBufferSizeInKb,2048);
    assert.ok(params.traceConfig.includedCategories.includes('disabled-by-default-v8.cpu_profiler'));
    if(startError)throw startError;return{};
   }
   if(method==='Tracing.end'){
    if(!startError)observers.get('Tracing.tracingComplete')?.({stream:'trace-stream',dataLossOccurred:false});
    if(endError)throw endError;if(endAck)await endAck;return{};
   }
   if(method==='IO.read'){
    assert.equal(params.handle,'trace-stream');assert.ok(params.size>0&&params.size<=DESKTOP_TRACE_LIMITS.chunkBytes);
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
async function metadata(output){return JSON.parse(await readFile(new URL('desktop-webgl-first-altai.trace-meta.json',output),'utf8'));}

test('a failed native selection still stops, drains and closes its trace without replacing the assertion',async t=>{
 const output=await outputDirectory(t),timers=controlledTimers(),failure=new Error('Actual route selection failed');
 let acknowledgeEnd;const cdp=protocol({endAck:new Promise(resolve=>{acknowledgeEnd=resolve;})});
 const observed=traceDesktopSelection(cdp,async()=>{throw failure;},{output,sourceCommit:'a'.repeat(40),...timers}).then(()=>null,error=>error);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cdp.calls.filter(call=>call.method==='Tracing.end').length,1);
 assert.equal(cdp.calls.some(call=>call.method==='IO.read'),false,'Completion can precede its end acknowledgement');
 acknowledgeEnd();assert.equal(await observed,failure);
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
 const result=await traceDesktopSelection(cdp,async()=>17,{output,...timers,limits:{...DESKTOP_TRACE_LIMITS,maxBytes:32}});
 assert.equal(result.value,17);assert.equal(result.trace.status,'partial');assert.equal(result.trace.truncated,'byte-limit');
 assert.equal(result.trace.bytes,32);assert.equal(result.trace.eof,false);assert.match(result.trace.file,/\.partial\.json$/);
 assert.equal((await stat(new URL(result.trace.file,output))).size,32);
 assert.equal(cdp.calls.filter(call=>call.method==='IO.read').length,1);assert.equal(cdp.calls.at(-1).method,'IO.close');
 assert.equal(cdp.observers.size,0);assert.equal(timers.pending.size,0);
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
