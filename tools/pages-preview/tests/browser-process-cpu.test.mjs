import test from 'node:test';
import assert from 'node:assert/strict';
import {captureProcessCPU,processCPUDelta,observeProcessCPU,inspectPageActivity} from '../browser-process-cpu.mjs';

test('process CPU snapshots use the unwrapped public payload and retain request timing',async()=>{
 let time=100,reads=0;
 const sample=await captureProcessCPU(async()=>{reads++;time=110;return{processInfo:[{id:9,type:'GPU',cpuTime:17.25},{id:2,type:'browser',cpuTime:.5}]};},{clock:()=>time,epoch:()=>1000+time});
 assert.equal(reads,1);assert.equal(sample.available,true);assert.equal(sample.durationMs,10);assert.equal(sample.startedAtEpochMs,1100);assert.equal(sample.endedAtEpochMs,1110);
 assert.deepEqual(sample.processes,[{id:2,type:'browser',cpuTimeSeconds:.5},{id:9,type:'GPU',cpuTimeSeconds:17.25}]);
 for(const payload of [{result:{processInfo:[]}},{},null,{processInfo:[]},{processInfo:[{id:1,type:'GPU',cpuTime:-1}]},{processInfo:[{id:1,type:'GPU',cpuTime:1},{id:1,type:'GPU',cpuTime:2}]}]){
  const invalid=await captureProcessCPU(async()=>payload);assert.equal(invalid.available,false);assert.match(invalid.error,/invalid|duplicate|empty/);
 }
 const failure=await captureProcessCPU(async()=>{throw new Error('Browser CDP unavailable');});assert.equal(failure.available,false);assert.match(failure.error,/Browser CDP unavailable/);
});

const sample=(start,end,processes)=>({available:true,startMonotonicMs:start,endMonotonicMs:end,processes:processes.map(([id,type,cpuTimeSeconds])=>({id,type,cpuTimeSeconds}))});
test('all-thread CPU can exceed wall time and is grouped without claiming exact sample timestamps',()=>{
 const before=sample(100,110,[[1,'browser',1],[2,'GPU',10],[3,'renderer',2],[4,'renderer',1]]);
 const after=sample(2110,2120,[[1,'browser',1.5],[2,'GPU',14],[3,'renderer',3],[4,'renderer',1.5]]);
 const delta=processCPUDelta(before,after);
 assert.equal(delta.available,true);assert.equal(delta.complete,true);assert.deepEqual(delta.intervalMs,{minimum:2000,maximum:2020,midpoint:2010});
 assert.equal(delta.totalComparableCPUSeconds,6);assert.equal(delta.comparableProcessCount,4);assert.equal(delta.incomparableProcessCount,0);
 assert.equal(delta.processes.find(process=>process.type==='GPU').cpuTimeDeltaSeconds,4);assert.ok(delta.processes.find(process=>process.type==='GPU').averageLogicalCores>1.9);
 assert.deepEqual(delta.byType.find(process=>process.type==='renderer'),{type:'renderer',processCount:2,cpuTimeDeltaSeconds:1.5,averageLogicalCores:1.5/2.01});
});

test('process exit, creation, changed type and counter reset make the CPU total explicitly incomplete',()=>{
 const before=sample(0,2,[[1,'GPU',10],[2,'renderer',2],[3,'renderer',5],[4,'utility',1],[6,'browser',1]]);
 const after=sample(1002,1004,[[1,'GPU',.2],[3,'renderer',6],[4,'renderer',2],[5,'utility',.3],[6,'browser',1.5]]);
 const delta=processCPUDelta(before,after);
 assert.equal(delta.available,true);assert.equal(delta.complete,false);assert.equal(delta.totalComparableCPUSeconds,1.5);assert.equal(delta.incomparableProcessCount,4);
 assert.deepEqual(delta.processes.map(process=>[process.id,process.status]),[[1,'counter-decreased'],[2,'exited-process'],[3,'comparable'],[4,'process-type-changed'],[5,'new-process'],[6,'comparable']]);
 for(const process of delta.processes.filter(process=>process.status!=='comparable'))assert.equal(process.cpuTimeDeltaSeconds,null);
 assert.deepEqual(processCPUDelta({available:false},after),{available:false,reason:'before-snapshot-unavailable'});
 assert.deepEqual(processCPUDelta(before,{available:false}),{available:false,reason:'after-snapshot-unavailable'});
});

test('a failing native action runs exactly once and retains its exact settle failure after CPU sampling',async()=>{
 const failure=new Error('The maplibre map did not settle');failure.settleDiagnostics={timeoutMs:15000,requiredIdleObservations:4};
 const order=[],receipt={beforeZoom:15.905};let time=0,reads=0,actions=0;
 const observed=await observeProcessCPU(async()=>{order.push('native-action');actions++;time+=18000;throw failure;},{receipt,clock:()=>time,epoch:()=>1000+time,read:async()=>{
  order.push(++reads===1?'cpu-before':'cpu-after');time+=2;return{processInfo:[{id:10,type:'GPU',cpuTime:reads===1?10:40}]};
 }}).then(()=>null,error=>error);
 assert.equal(observed,failure);assert.equal(actions,1);assert.equal(reads,2);assert.deepEqual(order,['cpu-before','native-action','cpu-after']);
 assert.equal(receipt.status,'failed');assert.equal(receipt.actionDurationMs,18000);assert.equal(receipt.beforeZoom,15.905);assert.equal(receipt.delta.totalComparableCPUSeconds,30);
 assert.equal(receipt.target,'browser');assert.equal(receipt.cpuScope,'all-threads-since-process-start');assert.equal(failure.settleDiagnostics.requiredIdleObservations,4);
});

test('either failed CPU read stays evidence-only and never retries or replaces the action error',async()=>{
 for(const failedRead of [1,2,'both']){
  const failure=new Error('Native input failed'),receipt={};let reads=0,actions=0;
  const observed=await observeProcessCPU(async()=>{actions++;throw failure;},{receipt,read:async()=>{
   reads++;if(failedRead==='both'||failedRead===reads)throw new Error('CPU query timed out');return{processInfo:[{id:1,type:'browser',cpuTime:reads}]};
  }}).then(()=>null,error=>error);
  assert.equal(observed,failure);assert.equal(actions,1);assert.equal(reads,2);assert.equal(receipt.status,'failed');assert.equal(receipt.delta.available,false);
 }
 const value={camera:{zoom:17}},receipt={};let actions=0;
 assert.equal(await observeProcessCPU(async()=>{actions++;return value;},{receipt}),value);
 assert.equal(actions,1);assert.equal(receipt.status,'completed');assert.equal(receipt.delta.available,false);
});

test('page activity is a serializable read-only snapshot and cannot focus a document',()=>{
 const snapshot=(0,eval)(`(${inspectPageActivity.toString()})`);
 const doc={visibilityState:'hidden',hidden:true,hasFocus:()=>false,activeElement:{tagName:'BUTTON',getAttribute:name=>{assert.equal(name,'aria-label');return'Увеличить масштаб';}},focus:()=>assert.fail('Do not alter focus')};
 assert.deepEqual(snapshot(doc,{timeOrigin:1000,now:()=>25}),{timeOrigin:1000,time:25,visibilityState:'hidden',hidden:true,hasFocus:false,activeElement:{tag:'BUTTON',label:'Увеличить масштаб'}});
});
