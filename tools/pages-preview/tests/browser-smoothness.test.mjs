import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installSmoothnessRecorder,sessionLayoutShift,summarizeSmoothness,smoothnessIssues,assertSmoothnessAudit,performanceBudgetIssues,observeSmoothnessPan,runSmoothnessAudit,measureSmoothnessWindow,smoothnessTraceEnabled,SMOOTHNESS_LIMITS,SMOOTHNESS_TRACE_SCENARIOS} from '../browser-smoothness.mjs';
import {DESKTOP_TRACE_LIMITS,FIRST_ALTAI_DIAGNOSTIC_TRACE_CATEGORIES} from '../browser-trace.mjs';
import {smoothnessFixture,smoothnessWindowFixture} from './smoothness-fixture.mjs';

const mobile={name:'android-portrait',engine:'tropnik-canvas',mobile:true};
const summarize=mutate=>{const raw=structuredClone(smoothnessWindowFixture().raw);mutate(raw);return summarizeSmoothness(raw);};

test('smoothness tracing needs the explicit normal-speed focused diagnostic opt-in',()=>{
 for(const diagnostic of [null,'ui-smoothness','ui-smoothness-cpu','map-interactions'])for(const traceValue of [undefined,'','1'])for(const cpuSlowdownRate of [1,4]){
  assert.equal(smoothnessTraceEnabled({diagnostic,traceValue,cpuSlowdownRate}),diagnostic==='ui-smoothness'&&traceValue==='1'&&cpuSlowdownRate===1);
 }
 assert.equal(smoothnessTraceEnabled(),false);
});

test('targeted pan trace selects only the existing map-pan window',()=>{assert.deepEqual(SMOOTHNESS_TRACE_SCENARIOS,['map-pan']);});

test('focused traces wrap each measured action once and drain outside its window, including a capture cap',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'tropnik-smoothness-trace-')),output=pathToFileURL(directory+'/');t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const mode of ['complete','cap','action-error','stop-error']){
  const name='map-pan',report={profile:mobile.name,scenarios:[],traces:[]},order=[],timers=new Map(),failure=new Error(mode);let active=false,actions=0,completion,now=0,nextTimer=0;
  const cdp={
   observe(event,listener){assert.equal(event,'Tracing.tracingComplete');completion=listener;return()=>{completion=null;};},
   async call(method){
    order.push(method);if(method==='Tracing.start'||method.startsWith('IO.'))assert.equal(active,false,`${method} must run outside the measurement window`);
    if(method==='Tracing.end')completion({stream:'smoothness-trace',dataLossOccurred:false});
    if(method==='IO.read')return{data:JSON.stringify({traceEvents:[{name:'RunTask',cat:'cc,viz'}]}),eof:true};
    return{};
   },
  };
  const evaluate=async(cdp,expression)=>{
   if(expression.includes('.start(')){assert.equal(active,false);active=true;order.push('window-start');return 100;}
   if(expression.includes('.stop(')){order.push('window-stop');active=false;if(mode==='stop-error')throw failure;return smoothnessWindowFixture(name).raw;}
   assert.ok(expression.includes('requestAnimationFrame'));order.push('final-frames');
  };
  const traceOptions={output,clock:()=>now,schedule:(callback,ms)=>{const id=++nextTimer;timers.set(id,{callback,ms});return id;},cancel:id=>timers.delete(id)};
  const operation=measureSmoothnessWindow(cdp,name,async()=>{
   actions++;order.push('native-action');assert.equal(active,true);
   if(mode==='action-error')throw failure;
   if(mode==='cap'){
    now=DESKTOP_TRACE_LIMITS.durationMs;[...timers.values()].find(timer=>timer.ms===DESKTOP_TRACE_LIMITS.durationMs).callback();
    await new Promise(resolve=>setImmediate(resolve));assert.ok(order.includes('Tracing.end'));assert.equal(order.some(value=>value.startsWith('IO.')),false);
    now+=DESKTOP_TRACE_LIMITS.drainMs+100;
   }
  },{evaluate,report,tracing:true,sourceCommit:'a'.repeat(40),traceOptions});
  if(mode.endsWith('error'))await assert.rejects(operation,error=>error===failure);else await operation;
  assert.equal(actions,1);assert.equal(active,false);assert.equal(completion,null);assert.equal(timers.size,0);
  assert.ok(order.indexOf('Tracing.start')<order.indexOf('window-start'));assert.ok(order.indexOf('IO.read')>order.indexOf('window-stop'));
  assert.equal(report.scenarios.length,mode==='stop-error'?0:1);
  if(report.scenarios.length)assert.deepEqual(report.scenarios[0],smoothnessWindowFixture(name));
  const receipt=report.traces[0];assert.equal(receipt.instrumented,true);assert.equal(receipt.sourceCommit,'a'.repeat(40));assert.equal(receipt.scenario,name);
  assert.equal(receipt.scope,`ui-smoothness/${mobile.name}/${name}`);assert.equal(receipt.status,mode==='cap'?'partial':'complete');assert.deepEqual(receipt.errors,[]);
  assert.deepEqual(receipt.categories,FIRST_ALTAI_DIAGNOSTIC_TRACE_CATEGORIES);assert.deepEqual(receipt.limits,DESKTOP_TRACE_LIMITS);
  const persisted=JSON.parse(await readFile(new URL(`${mobile.name}-ui-smoothness-${name}.trace-meta.json`,output),'utf8'));assert.deepEqual({...persisted,scenario:name},receipt);
 }
});

test('other scenarios and disabled tracing keep the native measurement path without trace protocol',async()=>{
 for(const [name,tracing]of [['map-pan',false],['explore-search',false],['panel',true]]){
  const report={profile:mobile.name,scenarios:[],traces:[]};let actions=0;
  await measureSmoothnessWindow({call:()=>assert.fail('No tracing for this window'),observe:()=>assert.fail('No trace observer')},name,async()=>{actions++;},{report,tracing,evaluate:async(cdp,expression)=>expression.includes('.stop(')?smoothnessWindowFixture(name).raw:undefined});
  assert.equal(actions,1);assert.deepEqual(report.traces,[]);assert.deepEqual(report.scenarios,[smoothnessWindowFixture(name)]);
 }
});

test('persisted instrumented metrics remain diagnostic and cannot certify release smoothness',()=>{
 const report=smoothnessFixture(mobile.name,mobile.engine);report.instrumented=true;
 report.traces=SMOOTHNESS_TRACE_SCENARIOS.map(scenario=>({scenario,instrumented:true,scope:`ui-smoothness/${mobile.name}/${scenario}`,status:'complete'}));
 assert.equal(assertSmoothnessAudit(report,mobile,{release:false}),report);
 assert.throws(()=>assertSmoothnessAudit(report,mobile),/Instrumented UI diagnostics/);
 for(const mutate of [r=>r.instrumented=false,r=>delete r.instrumented,r=>r.traces.pop(),r=>r.traces[0].instrumented=false,r=>r.cpuSlowdownRate=4]){
  const bad=structuredClone(report);mutate(bad);assert.throws(()=>assertSmoothnessAudit(bad,mobile,{release:false}));
 }
});

test('smoothness pan requires observed native pointer delivery, not only successful CDP commands',async t=>{
 let now=1000;t.mock.method(performance,'now',()=>now);
 const start={x:100,y:150},delta={dx:64,dy:12};
 for(const mobile of [true,false])for(const fault of [null,'missing','untrusted','wrong-position']){
  const profile={name:mobile?'android-portrait':'desktop-webgl',mobile},events=[{type:'pointerdown',time:now-1}],pointerType=mobile?'touch':'mouse';let last=start;
  const cdp={call:async(method,params)=>{
   if(params.touchPoints?.length)last=params.touchPoints[0];else if(Number.isFinite(params.x))last=params;
   const type=['touchStart','mousePressed'].includes(params.type)?'pointerdown':['touchEnd','mouseReleased'].includes(params.type)?'pointerup':null;
   if(type&&fault!=='missing')events.push({type,time:now,timestamp:now,pointerType,pointerId:4,trusted:fault!=='untrusted',x:last.x+(fault==='wrong-position'?30:0),y:last.y});
  }};
  const evaluate=async(cdp,expression)=>JSON.parse(JSON.stringify(runInNewContext(expression,{performance:{now:()=>now},window:{__tropnikInputEvents:events}})));
  const operation=()=>observeSmoothnessPan(cdp,start,delta,profile,{evaluate,sleep:async ms=>{now+=ms;}});
  if(!fault){
   const receipt=await operation();assert.deepEqual(receipt.events.map(event=>event.type),['pointerdown','pointerup']);assert.ok(receipt.events.every(event=>event.trusted));assert.equal(receipt.commands.length,mobile?14:15);
  }else await assert.rejects(operation,error=>{assert.ok(error.panDiagnostics);assert.ok(error.panDiagnostics.commands.every(command=>command.status==='fulfilled'));return error.code==='ERR_ASSERTION';});
 }
});

test('a failed CPU restore preserves the original browser failure and partial evidence',async()=>{
 const original=new Error('page crashed before mount');let calls=0;
 const cdp={call:async()=>{if(++calls===2)throw new Error('CDP disconnected during restore');}};
 await assert.rejects(runSmoothnessAudit(cdp,mobile,{loadProfile:async()=>{throw original;},url:'https://example.test/tropnik/'},{cpuSlowdownRate:4}),error=>{
  assert.equal(error,original);assert.equal(error.cpuThrottleRestoreError,'CDP disconnected during restore');
  assert.equal(error.smoothnessAudit.passed,false);assert.equal(error.smoothnessAudit.cpuThrottleRestored,false);assert.deepEqual(error.smoothnessAudit.scenarios,[]);
  return true;
 });
 assert.equal(calls,2);
});

test('bounded callback metrics distinguish rendering opportunity, EventTiming and presented FPS',()=>{
 const window=smoothnessWindowFixture();
 assert.deepEqual(smoothnessIssues(window,mobile),[]);
 assert.equal(window.frames.callbackHz,60);assert.equal(window.frames.p95Ms,16);assert.equal(window.frames.isPresentedFps,false);
 assert.equal(window.inputToNextFrame.maxMs,31);assert.equal(window.eventTiming.maxDurationMs,null);assert.equal(window.eventTiming.observed,0);assert.equal(window.eventTiming.isFieldINP,false);
});
test('unknown EventTiming is explicit and cannot turn into a zero-millisecond INP claim',()=>{
 const window=summarize(raw=>{raw.supported.event=false;});
 assert.equal(window.eventTiming.supported,false);assert.equal(window.eventTiming.maxDurationMs,null);assert.deepEqual(smoothnessIssues(window,mobile),[]);
});
test('canonical CLS sessions and excluded recent-input shifts remain separately reviewable',()=>{
 const entries=[{startTime:100,value:.04,hadRecentInput:false},{startTime:300,value:.05,hadRecentInput:false},{startTime:1400,value:.08,hadRecentInput:false},{startTime:1500,value:.4,hadRecentInput:true}];
 assert.equal(sessionLayoutShift(entries),.09);
 const window=summarize(raw=>{raw.endedAt=1800;raw.layoutShifts=entries;});
 assert.equal(window.layout.sessionCLS,.09);assert.ok(Math.abs(window.layout.unexpectedSum-.17)<1e-9);assert.ok(Math.abs(window.layout.allShiftSum-.57)<1e-9);assert.equal(window.layout.recentInputCount,1);
 const continuous=Array.from({length:8},(_,i)=>({startTime:100+i*900,value:.01,hadRecentInput:false}));
 assert.ok(Math.abs(sessionLayoutShift(continuous)-.06)<1e-9,'A session must stop at five seconds');
});
test('missing, hidden, truncated or unsupported recording cannot pass smoothness',()=>{
 for(const mutate of [raw=>raw.frames=[],raw=>raw.inputs=[],raw=>raw.hidden=true,raw=>raw.overflow=true,raw=>raw.pendingInputFrames=1,raw=>raw.supported.longtask=false,raw=>raw.supported['layout-shift']=false,raw=>raw.errors.push({type:'event',error:'failed'})]){
  assert.ok(smoothnessIssues(summarize(mutate),mobile).length>0);
 }
});
test('the exact frame, input, layout and long-task boundaries fail without changing the budgets',()=>{
 const cases=[
  ['frameP95Ms',raw=>{raw.endedAt=600;raw.frames=Array.from({length:12},(_,i)=>100+(i+1)*SMOOTHNESS_LIMITS.frameP95Ms);}],
  ['maxFrameGapMs',raw=>{raw.endedAt=600;raw.frames=[250,...Array.from({length:12},(_,i)=>266+i*16)];}],
  ['inputToNextFrameMs',raw=>{raw.endedAt=500;raw.inputs[0].nextFrameAt=raw.inputs[0].startTime+200;}],
  ['sessionCLS',raw=>{raw.layoutShifts=[{startTime:140,value:.1,hadRecentInput:false}];}],
  ['longestTaskMs',raw=>{raw.endedAt=600;raw.longTasks=[{startTime:110,duration:350}];}],
  ['eventDurationMs',raw=>{raw.eventTiming=[{startTime:110,name:'click',duration:200,processingStart:120,processingEnd:130,interactionId:1}];raw.endedAt=400;}],
 ];
 for(const [metric,mutate]of cases)assert.ok(smoothnessIssues(summarize(mutate),mobile).some(issue=>issue.metric===metric),metric);
});
test('aggregates are recomputed from raw samples, preventing a fabricated passing summary',()=>{
 const window=smoothnessWindowFixture();window.frames.maxGapMs=0;
 assert.throws(()=>smoothnessIssues(window,mobile));
 const report=smoothnessFixture(mobile.name,mobile.engine);report.scenarios[0].raw.frames[3]=250;
 assert.throws(()=>assertSmoothnessAudit(report,mobile));
});
test('all declared scenarios are required and CPU simulation cannot certify a normal release profile',()=>{
 const report=smoothnessFixture(mobile.name,mobile.engine);assert.equal(assertSmoothnessAudit(report,mobile),report);
 for(const change of [r=>r.scenarios.pop(),r=>r.physicalDevice=true,r=>r.cpuSlowdownRate=4,r=>r.cpuThrottleRestored=false,r=>r.performancePassed=false,r=>r.performanceIssues.push({metric:'invented'})]){
  const bad=structuredClone(report);change(bad);assert.throws(()=>assertSmoothnessAudit(bad,mobile));
 }
 const throttled=structuredClone(report);throttled.cpuSlowdownRate=4;assert.equal(assertSmoothnessAudit(throttled,mobile,{release:false}),throttled);
});
test('persisted smoothness reports reject missing or forged native pan delivery',()=>{
 for(const profile of [mobile,{name:'desktop-webgl',engine:'tropnik-canvas',mobile:false}]){
  const report=smoothnessFixture(profile.name,profile.engine);assert.equal(assertSmoothnessAudit(report,profile),report);
  for(const mutate of [r=>delete r.pan,r=>delete r.pan.events,r=>r.pan.events.pop(),r=>r.pan.events[0].trusted=false,r=>r.pan.events[1].pointerId++,r=>r.pan.events[1].x+=20,r=>r.pan.commands[4].status='rejected',r=>r.pan.durationMs=0]){
   const saved=JSON.parse(JSON.stringify(report));mutate(saved);assert.throws(()=>assertSmoothnessAudit(saved,profile));
  }
 }
});
test('old modes and interaction budgets reject absent, non-finite and exact-limit measurements',()=>{
 for(const profile of [mobile,{name:'desktop-webgl',mobile:false}]){
  const limit=profile.mobile?350:750;
  assert.deepEqual(performanceBudgetIssues({layoutShift:0,longestTaskMs:limit-1},profile,'modes'),[]);
  for(const value of [null,{layoutShift:0,longestTaskMs:limit},{layoutShift:.12,longestTaskMs:10},{layoutShift:NaN,longestTaskMs:10},{layoutShift:0,longestTaskMs:Infinity}])assert.ok(performanceBudgetIssues(value,profile,'modes').length);
 }
});
test('recorder filters startup and late observer tails by occurrence time and drains final entries',()=>{
 let time=100,next=1;const callbacks=new Map(),listeners=new Map(),observers=[];
 class Observer{
  static supportedEntryTypes=['longtask','event','layout-shift'];
  constructor(callback){this.callback=callback;this.entries=[];observers.push(this);}
  observe(options){this.options=options;}
  takeRecords(){return this.entries.splice(0);}
  disconnect(){}
 }
 const target={performance:{now:()=>time,timeOrigin:100000},document:{visibilityState:'visible',addEventListener:(type,listener)=>listeners.set(type,listener),removeEventListener:type=>listeners.delete(type)},PerformanceObserver:Observer,requestAnimationFrame:callback=>{const id=next++;callbacks.set(id,callback);return id;},cancelAnimationFrame:id=>callbacks.delete(id)};
 const tick=at=>{time=at;const ready=[...callbacks.values()];callbacks.clear();for(const callback of ready)callback(time);};
 const recorder=installSmoothnessRecorder(target);recorder.start('panel');
 observers.find(value=>value.options.type==='longtask').entries.push({startTime:20,duration:60},{startTime:90,duration:60},{startTime:110,duration:60});
 time=105;listeners.get('click')({type:'click',isTrusted:true,timeStamp:104});
 tick(116);tick(132);tick(148);time=180;
 const raw=recorder.stop();assert.deepEqual(raw.longTasks,[{startTime:110,duration:60}]);assert.equal(raw.previousBoundaryTasks,1);assert.equal(raw.inputs[0].nextFrameAt,132);assert.equal(raw.pendingInputFrames,0);assert.equal(callbacks.size,0);
 recorder.dispose();assert.equal(listeners.size,0);
});
