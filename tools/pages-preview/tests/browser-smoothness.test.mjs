import test from 'node:test';
import assert from 'node:assert/strict';
import {installSmoothnessRecorder,sessionLayoutShift,summarizeSmoothness,smoothnessIssues,assertSmoothnessAudit,performanceBudgetIssues,runSmoothnessAudit,SMOOTHNESS_LIMITS} from '../browser-smoothness.mjs';
import {smoothnessFixture,smoothnessWindowFixture} from './smoothness-fixture.mjs';

const mobile={name:'android-portrait',engine:'leaflet',mobile:true};
const summarize=mutate=>{const raw=structuredClone(smoothnessWindowFixture().raw);mutate(raw);return summarizeSmoothness(raw);};

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
