import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import vm from 'node:vm';
import {browserAuditRunPolicy,captureZoomModePerformance,runZoomDesignAudit} from '../browser-zoom-audit.mjs';
import {assertBrowserReport} from '../browser-report.mjs';

test('mode attribution is saved before navigation while the original budget counters remain frozen',async()=>{
 const calls=[],cdp={},window={__tropnikPerf:{cls:.2561908518287559,longest:971}},page=vm.createContext({window});
 const observation={timeOrigin:1794409437987.8,phase:'zoom-design-scene',current:{cls:window.__tropnikPerf.cls,longest:971,peakLongTask:{duration:971,startTime:180000}},layoutShifts:[{value:.2561908518287559,sources:[{node:'div[terrain-progress]',previous:{y:10},current:{y:20}}]}]};
 const result=await captureZoomModePerformance(cdp,{
  async evaluate(target,expression){assert.equal(target,cdp);calls.push('counters');return JSON.parse(JSON.stringify(vm.runInContext(expression,page)));},
  async performanceDiagnostics(target){
   assert.equal(target,cdp);calls.push('attribution');
   // Attribution is read after the budget sample. Any later observer activity
   // must not silently replace the interval already used for release budgets.
   window.__tropnikPerf.longest=1200;
   return structuredClone(observation);
  },
 });
 calls.push('navigate');window.__tropnikPerf={cls:0,longest:0};observation.layoutShifts=[];
 assert.deepEqual(calls,['counters','attribution','navigate']);
 assert.deepEqual(result.performance,{layoutShift:.2561908518287559,longestTaskMs:971});
 assert.equal(result.diagnostics.current.peakLongTask.duration,971);assert.equal(result.diagnostics.phase,'zoom-design-scene');
 assert.equal(result.diagnostics.layoutShifts[0].sources[0].node,'div[terrain-progress]');
});

test('an unavailable attribution reader cannot erase, reset or replace a failing budget sample',async()=>{
 const performance={layoutShift:.25,longestTaskMs:971};
 const unavailable=await captureZoomModePerformance({}, {evaluate:async()=>({...performance})});
 assert.deepEqual(unavailable.performance,performance);assert.deepEqual(unavailable.diagnostics,{available:false,reason:'performance-diagnostics-helper-unavailable'});
 const failed=await captureZoomModePerformance({}, {evaluate:async()=>({...performance}),performanceDiagnostics:async()=>{throw new Error('Disconnected during diagnostic read');}});
 assert.deepEqual(failed.performance,performance);assert.deepEqual(failed.diagnostics,{available:false,error:'Disconnected during diagnostic read'});
});

test('a failed full zoom audit preserves live attribution and its original error before releasing observers',async t=>{
 const file=new URL('../../../web/pages-preview/design-qa/performance-attribution-fixture.json',import.meta.url);
 t.after(()=>rm(file,{force:true}));
 const stopped=[],cdp={observe(name){return()=>stopped.push(name);},async call(method){assert.equal(method,'Network.enable');return{};}};
 const error=new Error('Original zoom action failed'),diagnostics={phase:'zoom-design-scene',current:{cls:.25,longest:971,peakLongTask:{duration:971,startTime:180000}},layoutShifts:[{value:.25,sources:[{node:'div[terrain-heading]'}]}]};
 await assert.rejects(runZoomDesignAudit(cdp,{name:'performance-attribution-fixture',engine:'tropnik-canvas',mobile:true},{loadProfile:async()=>{throw error;},performanceDiagnostics:async()=>diagnostics,url:'http://127.0.0.1/tropnik/'}),value=>value===error);
 const report=JSON.parse(await readFile(file,'utf8'));
 assert.match(report.error,/Original zoom action failed/);assert.equal(report.geometryPassed,false);
 assert.deepEqual(report.failurePerformanceDiagnostics,diagnostics);
 assert.deepEqual(stopped,['Network.responseReceived','Network.loadingFinished','Network.loadingFailed']);
});

test('focused zoom modes use the exact Android profile and cannot produce a release receipt',async()=>{
 const policy=browserAuditRunPolicy('zoom-modes');
 assert.deepEqual(policy,{diagnostic:'zoom-modes',reportFile:'browser-zoom-modes-diagnostic.json',profiles:['android-portrait']});
 for(const profile of [{name:'desktop-webgl',mobile:false},{name:'android-portrait',mobile:false},{name:'compact-android',mobile:true}]){
  await assert.rejects(runZoomDesignAudit({},profile,{}, {diagnostic:'zoom-modes'}),/requires the Android portrait profile/);
 }
 const receipt={diagnostic:'zoom-modes',diagnosticOnly:true,verified:false,releaseEligible:false,status:'completed',diagnosticScope:'android-existing-zoom-modes',sourceCommit:'a'.repeat(40)};
 assert.throws(()=>assertBrowserReport(receipt,receipt.sourceCommit));
 assert.throws(()=>browserAuditRunPolicy(' zoom-modes '),/Unknown TROPNIK_BROWSER_DIAGNOSTIC/);
});
