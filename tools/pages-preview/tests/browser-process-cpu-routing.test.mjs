import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {observeProcessCPU} from '../browser-process-cpu.mjs';
import {shouldTraceTerrainDiagnostic,shouldTraceTerrainZoom} from '../browser-zoom-audit.mjs';
import {TERRAIN_TRACE_LIMITS} from '../browser-trace.mjs';

// Execute the production single-zoom boundary with native/trace transports
// substituted. No browser, server, application callbacks or retry are started.
const source=await readFile(new URL('../browser-zoom-audit.mjs',import.meta.url),'utf8');
const start=source.indexOf(' async function zoom('),end=source.indexOf('\n async function reachBottom(',start);
assert.ok(start>=0&&end>start);const dispatch=source.slice(start,end),AsyncFunction=(async()=>{}).constructor;

async function invokeZoom({beforeZoom=15.905,diagnostic='terrain-close',failure=null,traceStopReason='action-error'}={}){
 const order=[],report={nativeZooms:[],processCPUZooms:[]},page={visibilityState:'visible',hidden:false,hasFocus:true};let settles=0,presses=0,reads=0;
 const bindings={assert,report,diagnostic,profile:{name:'desktop-webgl',engine:'maplibre',mobile:false},cdp:{},PLUS:'plus',MINUS:'minus',traceEnabled:false,TERRAIN_TRACE_LIMITS,observeProcessCPU,shouldTraceTerrainDiagnostic,shouldTraceTerrainZoom,
  helpers:{systemProcessInfo:async()=>{order.push(++reads===1?'cpu-before':'cpu-after');return{processInfo:[{id:1,type:'GPU',cpuTime:reads}]};}},
  settledMap:async()=>{if(++settles===1)return{camera:{zoom:beforeZoom},pageActivity:page};order.push('settle');if(failure)throw failure;return{camera:{zoom:beforeZoom+1},pageActivity:page};},
  elementPoint:async()=>({unobscured:true,x:1,y:2}),pointerAt:async()=>{presses++;order.push('native-input');},sleep:async duration=>{assert.equal(duration,70);},
  traceDesktopSelection:async(_cdp,action,options)=>{
   assert.equal(options.limits,TERRAIN_TRACE_LIMITS);order.push('trace-start');
   const trace={instrumented:true,stopReason:traceStopReason,startedAtEpochMs:1,recordedDurationMs:18000,status:traceStopReason==='time-limit'?'partial':'complete',errors:[]};
   try{const value=await action();order.push('trace-drain');return{value,trace};}
   catch(error){order.push('trace-drain');error.traceReceipt=trace;throw error;}
  },
 };
 let caught,value;
 try{value=await new AsyncFunction(...Object.keys(bindings),`let terrainTraceStarted=false;${dispatch}\nreturn zoom(1,{mode:${JSON.stringify(diagnostic?'terrain-diagnostic':'terrain')}});`)(...Object.values(bindings));}catch(error){caught=error;}
 return{caught,value,report,order,presses,reads};
}

for(const beforeZoom of [14.905,15.905])test(`CPU evidence brackets exactly one failing native action at zoom ${beforeZoom}`,async()=>{
 const failure=new Error('The maplibre map did not settle'),page={visibilityState:'visible',hidden:false,hasFocus:true};failure.settleDiagnostics={timeoutMs:15000,requiredIdleObservations:4,samples:[{state:{pageActivity:page}}]};
 const result=await invokeZoom({beforeZoom,failure});assert.equal(result.caught,failure);assert.equal(result.presses,1);assert.equal(result.reads,2);assert.equal(result.report.processCPUZooms.length,1);assert.equal(result.report.nativeZooms.length,0);
 const cpu=result.report.processCPUZooms[0];assert.equal(cpu.status,'failed');assert.deepEqual(cpu.pageActivityAfter,page);assert.equal(cpu.pageActivityAfterSource,'last-settle-observation');
 const expected=['cpu-before','native-input','settle','cpu-after'];assert.deepEqual(result.order,beforeZoom>=15?['trace-start',...expected,'trace-drain']:expected);
 if(beforeZoom>=15)assert.equal(cpu.trace.drainMayOverlapCounterInterval,false);
});

test('the independent trace time cap is reported as possible CPU-sample drain overlap',async()=>{
 const result=await invokeZoom({failure:new Error('The maplibre map did not settle'),traceStopReason:'time-limit'});
 assert.equal(result.report.processCPUZooms[0].trace.stopReason,'time-limit');assert.equal(result.report.processCPUZooms[0].trace.drainMayOverlapCounterInterval,true);
});

test('the normal release zoom boundary has no process sampling or added native inputs',async()=>{
 const result=await invokeZoom({diagnostic:null});assert.equal(result.caught,undefined);assert.equal(result.presses,1);assert.equal(result.reads,0);assert.equal(result.value.changed,true);assert.deepEqual(result.report.processCPUZooms,[]);assert.deepEqual(result.order,['native-input','settle']);
});
