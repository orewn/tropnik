import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {browserGPUDrawsEnabled,installTerrainGPUDraws,observeTerrainGPUDraws,shouldObserveTerrainGPUDraws} from '../browser-gpu-draws.mjs';
import {observeProcessCPU} from '../browser-process-cpu.mjs';
import {runZoomDesignAudit,shouldTraceTerrainDiagnostic,shouldTraceTerrainZoom} from '../browser-zoom-audit.mjs';
import {TERRAIN_TRACE_LIMITS} from '../browser-trace.mjs';

const desktop={name:'desktop-webgl',engine:'maplibre',mobile:false},AsyncFunction=(async()=>{}).constructor;
const source=await readFile(new URL('../browser-zoom-audit.mjs',import.meta.url),'utf8');
const start=source.indexOf(' async function zoom('),end=source.indexOf('\n async function reachBottom(',start);
assert.ok(start>=0&&end>start);const dispatch=source.slice(start,end);

// Execute the production native-input boundary with public transports replaced.
// No browser, server, renderer callbacks, synthetic frames or retry are used.
async function invokeZooms({steps=[{beforeZoom:14.905}],diagnostic='terrain-close',gpuDrawsEnabled=true,profile=desktop,pendingQueries=0}={}){
 const order=[],report={nativeZooms:[],processCPUZooms:[]},page={visibilityState:'visible',hidden:false,hasFocus:true},controls=[],waits=[],stateReads=[];
 let activeStep,stepReads=0,presses=0,cpuReads=0;
 const controller={
  start(label){controls.push({method:'start',argument:label});order.push('gpu-start');return{recording:true,queries:{pending:0}};},
  stop(reason){controls.push({method:'stop',argument:reason});order.push('gpu-stop');return{recording:false,queries:{pending:pendingQueries}};},
  collect(options){controls.push({method:'collect',argument:options});order.push('gpu-collect');return{recording:false,queries:{pending:pendingQueries}};},
 };
 const bindings={assert,report,diagnostic,gpuDrawsEnabled,profile,cdp:{},PLUS:'plus',MINUS:'minus',traceEnabled:false,TERRAIN_TRACE_LIMITS,observeProcessCPU,observeTerrainGPUDraws,shouldObserveTerrainGPUDraws,shouldTraceTerrainDiagnostic,shouldTraceTerrainZoom,
  steps:steps.map(step=>({direction:1,mode:diagnostic?'terrain-diagnostic':'terrain',...step})),
  beginStep:step=>{activeStep=step;stepReads=0;},
  helpers:{systemProcessInfo:async()=>{order.push(++cpuReads%2?'cpu-before':'cpu-after');return{processInfo:[{id:10,type:'GPU',cpuTime:cpuReads}]};}},
  settledMap:async()=>{
   stepReads++;stateReads.push({beforeZoom:activeStep.beforeZoom,index:stepReads});
   if(stepReads===1)return{camera:{zoom:activeStep.beforeZoom},pageActivity:page};
   order.push('settle');if(activeStep.failure)throw activeStep.failure;
   return{camera:{zoom:activeStep.beforeZoom+activeStep.direction},pageActivity:page};
  },
  elementPoint:async(_cdp,selector)=>{assert.equal(selector,activeStep.direction>0?'plus':'minus');return{unobscured:true,x:10,y:20};},
  pointerAt:async(_cdp,point,receivedProfile)=>{assert.deepEqual(point,{unobscured:true,x:10,y:20});assert.equal(receivedProfile,profile);presses++;order.push('native-input');},
  sleep:async duration=>{if(duration===50){waits.push(duration);order.push('collection-wait');}else assert.equal(duration,70,'The existing native action delay is unchanged');},
  evaluate:async(_cdp,expression)=>new Function('window',`return ${expression}`)({__tropnikTerrainGPUDraws:controller}),
  traceDesktopSelection:async(_cdp,action,options)=>{
   assert.equal(options.limits,TERRAIN_TRACE_LIMITS);order.push('trace-start');
   const trace={instrumented:true,stopReason:'action-complete',startedAtEpochMs:1,recordedDurationMs:100,status:'complete',errors:[]};
   try{const value=await action();order.push('trace-drain');return{value,trace};}
   catch(error){order.push('trace-drain');error.traceReceipt={...trace,stopReason:'action-error'};throw error;}
  },
 };
 const results=await new AsyncFunction(...Object.keys(bindings),`let terrainTraceStarted=false,terrainGPUDrawsStarted=false;${dispatch}
  const results=[];
  for(const step of steps){beginStep(step);try{results.push({value:await zoom(step.direction,{mode:step.mode})});}catch(error){results.push({error});break;}}
  return results;
 `)(...Object.values(bindings));
 return{results,report,order,controls,waits,stateReads,presses,cpuReads};
}

test('GPU draws require an explicit flag and cannot be enabled for release verification',async()=>{
 for(const value of [undefined,''])for(const mode of [undefined,null,'terrain-close'])assert.equal(browserGPUDrawsEnabled(value,mode),false);
 assert.equal(browserGPUDrawsEnabled('1','terrain-close'),true);
 for(const mode of [undefined,null,'','terrain','other'])assert.throws(()=>browserGPUDrawsEnabled('1',mode),/requires the terrain-close diagnostic/);
 for(const value of ['0','true','false',' 1 ',true,1,null])assert.throws(()=>browserGPUDrawsEnabled(value,'terrain-close'),/Unknown TROPNIK_BROWSER_GPU_DRAWS/);
 // This assertion runs before mkdir/CDP/loadProfile in the actual audit.
 await assert.rejects(runZoomDesignAudit({call:()=>assert.fail('No transport before rejection')},desktop,{}, {gpuDrawsEnabled:true}),/requires diagnostic-only evidence/);
});

test('only the first upward desktop diagnostic action in [14,15) is eligible',()=>{
 const eligible=(overrides={})=>{
  const options={profile:desktop,mode:'terrain-diagnostic',direction:1,zoom:14.905,alreadyObserved:false,enabled:true,...overrides};
  return shouldObserveTerrainGPUDraws(options.profile,options.mode,options.direction,options.zoom,options.alreadyObserved,options.enabled);
 };
 for(const zoom of [14,14.905,14.9999])assert.equal(eligible({zoom}),true);
 for(const zoom of [13.9999,15,15.905,18,NaN,Infinity])assert.equal(eligible({zoom}),false);
 for(const overrides of [{enabled:false},{alreadyObserved:true},{direction:0},{direction:-1},{mode:'terrain'},{mode:'base'},{profile:{...desktop,mobile:true}},{profile:{...desktop,name:'desktop-leaflet'}},{profile:{...desktop,engine:'leaflet'}}])assert.equal(eligible(overrides),false);
});

test('the production document preload installs no GPU observer unless the diagnostic flag is enabled',async()=>{
 const smoke=await readFile(new URL('../browser-smoke.mjs',import.meta.url),'utf8');
 const begin=smoke.indexOf("  await cdp.call('Page.addScriptToEvaluateOnNewDocument'"),finish=smoke.indexOf('\n  for(const profile of profiles.filter(',begin);
 assert.ok(begin>=0&&finish>begin);const preload=smoke.slice(begin,finish);
 for(const enabled of [false,true]){
  const calls=[];await new AsyncFunction('cdp','gpuDrawsEnabled','installTerrainGPUDraws',preload)({call:async(method,params)=>calls.push({method,params})},enabled,installTerrainGPUDraws);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'Page.addScriptToEvaluateOnNewDocument');assert.equal(calls[0].params.source.includes('__tropnikTerrainGPUDraws'),enabled);
  if(enabled)assert.ok(calls[0].params.source.includes(`(${installTerrainGPUDraws.toString()})(globalThis);`));
 }
});

test('draw timing brackets one native action while CPU snapshots exclude arm and collection',async()=>{
 const result=await invokeZooms();assert.equal(result.presses,1);assert.equal(result.cpuReads,2);assert.equal(result.stateReads.length,2);assert.equal(result.results[0].error,undefined);
 assert.deepEqual(result.results[0].value,{before:14.905,after:15.905,changed:true});
 assert.deepEqual(result.order,['gpu-start','cpu-before','native-input','settle','cpu-after','gpu-stop','gpu-collect']);
 assert.deepEqual(result.controls.map(call=>call.method),['start','stop','collect']);assert.deepEqual(result.controls[0].argument,{beforeZoom:14.905,direction:1,mode:'terrain-diagnostic'});assert.equal(result.controls[1].argument,'action-complete');
 assert.equal(result.report.nativeZooms.length,1);assert.equal(result.report.processCPUZooms[0].status,'completed');assert.equal(result.report.gpuDrawZoom.status,'completed');assert.equal(result.report.gpuDrawZoom.diagnosticOnly,true);assert.equal(result.report.gpuDrawZoom.verified,false);assert.equal(result.report.gpuDrawZoom.releaseEligible,false);
 assert.equal(result.report.terrainZoomTrace,undefined,'The first GPU action does not overlap the later trace trigger');
});

test('the original failed settle survives one input and bounded collection after CPU sampling ends',async()=>{
 const failure=new Error('The maplibre map did not settle'),diagnostics={timeoutMs:15000,requiredIdleObservations:4,comparison:'exact-camera-rect-route',samples:[{frameMs:9000,state:{pageActivity:{visibilityState:'visible',hidden:false,hasFocus:true}}}]};failure.settleDiagnostics=diagnostics;
 const result=await invokeZooms({steps:[{beforeZoom:14.905,failure}],pendingQueries:1});
 assert.equal(result.results[0].error,failure);assert.equal(result.results[0].error.settleDiagnostics,diagnostics);assert.equal(result.presses,1);assert.equal(result.cpuReads,2);assert.equal(result.stateReads.length,2);
 assert.deepEqual(result.order,['gpu-start','cpu-before','native-input','settle','cpu-after','gpu-stop','gpu-collect','collection-wait','gpu-collect','collection-wait','gpu-collect']);
 assert.deepEqual(result.waits,[50,50]);assert.equal(result.controls.find(call=>call.method==='stop').argument,'action-error');assert.deepEqual(result.controls.filter(call=>call.method==='collect').map(call=>call.argument),[{final:false},{final:false},{final:true}]);
 assert.equal(result.report.nativeZooms.length,0);assert.equal(result.report.processCPUZooms[0].status,'failed');assert.equal(result.report.gpuDrawZoom.status,'failed');assert.equal(result.report.gpuDrawZoom.releaseEligible,false);
});

test('a second crossing of the eligible band cannot re-arm the single diagnostic observer',async()=>{
 const result=await invokeZooms({steps:[{beforeZoom:14.905},{beforeZoom:14.905}]});
 assert.equal(result.presses,2);assert.equal(result.cpuReads,4);assert.equal(result.stateReads.length,4);assert.equal(result.controls.filter(call=>call.method==='start').length,1);assert.equal(result.controls.filter(call=>call.method==='stop').length,1);assert.equal(result.controls.filter(call=>call.method==='collect').length,1);
 assert.deepEqual(result.order,['gpu-start','cpu-before','native-input','settle','cpu-after','gpu-stop','gpu-collect','cpu-before','native-input','settle','cpu-after']);
});

test('disabled and out-of-band actions retain their original CPU and trace boundaries',async()=>{
 for(const options of [{gpuDrawsEnabled:false},{steps:[{beforeZoom:13.905}]},{steps:[{beforeZoom:15.905}]},{steps:[{beforeZoom:14.905,direction:-1}]},{diagnostic:null,gpuDrawsEnabled:false}]){
  const result=await invokeZooms(options);assert.equal(result.controls.length,0);assert.equal(result.report.gpuDrawZoom,undefined);assert.equal(result.presses,1);assert.equal(result.stateReads.length,2);assert.equal(result.results[0].error,undefined);
  if(options.steps?.[0]?.beforeZoom===15.905){assert.equal(result.cpuReads,2);assert.deepEqual(result.order,['trace-start','cpu-before','native-input','settle','cpu-after','trace-drain']);assert.equal(result.report.processCPUZooms[0].trace.drainMayOverlapCounterInterval,false);}
  else if(options.gpuDrawsEnabled===false&&options.diagnostic!==null){assert.equal(result.cpuReads,2);assert.deepEqual(result.order,['cpu-before','native-input','settle','cpu-after']);}
  else{assert.equal(result.cpuReads,0);assert.deepEqual(result.order,['native-input','settle']);}
 }
});
