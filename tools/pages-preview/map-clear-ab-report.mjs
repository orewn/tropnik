import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {assertBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {assertSmoothnessAudit,SMOOTHNESS_SCENARIOS,SMOOTHNESS_LIMITS} from './browser-smoothness.mjs';
import {verifySealedBuildSource} from './map-clear-build-source.mjs';

const BASELINE='f836dce11579eae0e4596ee5b73f8bbe7246128f';
const OPTIMIZED='1710b201bfeed52613659ae3e4ca7f26638cb6cb';
const BUILD_IDS={baseline:'5880c4c7831be10f',optimized:'1ba12be7cff233d3'};
const HASHES={baseline:'bcb43c269a6b74b52956acd40aec48e666a4c40255c78f3e77e107210b60487a',optimized:'c25b61c97602070d746706d977d50906217e4b1258ce5a482ae64bb914ee3127'};
const sha=value=>createHash('sha256').update(value).digest('hex');
const profiles=[{name:'android-portrait',engine:'tropnik-canvas',mobile:true},{name:'desktop-webgl',engine:'tropnik-canvas',mobile:false}];

async function readVariant(directory,label,sourceCommit){
 const root=resolve(directory),bytes=await readFile(join(root,'web/pages-preview/dist/browser-ui-smoothness-diagnostic.json'));
 const report=JSON.parse(bytes),buildBytes=await readFile(join(root,'web/pages-preview/dist/build-info.json')),build=JSON.parse(buildBytes);
 const engine=await readFile(join(root,'web/lib/custom-map-engine.ts'));
 assert.equal(sha(engine),HASHES[label],label+' engine bytes');
 const sourceProof=await verifySealedBuildSource(root,build,{sourceCommit,controllerCommit,expectedBuildId:BUILD_IDS[label]});
 assert.equal(report.sourceCommit,controllerCommit);assert.equal(report.schemaVersion,1);
 assert.equal(report.diagnostic,'ui-smoothness');assert.equal(report.diagnosticOnly,true);
 assert.equal(report.verified,false);assert.equal(report.releaseEligible,false);assert.equal(report.status,'completed');
 assert.deepEqual(report.profiles.map(item=>item.profile),profiles.map(item=>item.name));
 assertBrowserEnvironment(report.environment,controllerCommit);
 for(const profile of profiles){
  const item=report.profiles.find(value=>value.profile===profile.name);
  assert.equal(item.instrumented,false);assert.equal(item.cpuSlowdownRate,1);
  assertSmoothnessAudit(item,profile,{release:false});
 }
 const issues=report.profiles.flatMap(item=>item.performanceIssues);
 assert.deepEqual(report.performanceIssues,issues);assert.equal(report.performancePassed,issues.length===0);
 return{sourceCommit,engineSHA256:sha(engine),reportSHA256:sha(bytes),buildSHA256:sha(buildBytes),buildId:build.buildId,sourceProof,report,engine:engine.toString('utf8')};
}
function inputs(pan){return{input:pan.input,start:pan.start,end:pan.end,delta:pan.delta,holdBeforeReleaseMs:pan.holdBeforeReleaseMs,commands:pan.commands.map(({method,type,x,y})=>({method,type,x,y}))};}
function metrics(item){return item.scenarios.map(value=>({name:value.name,durationMs:value.durationMs,frames:value.frames,inputToNextFrame:value.inputToNextFrame,eventTiming:value.eventTiming,longTasks:value.longTasks,layout:value.layout}));}

function activePanIntervals(item){
 const windows=item.scenarios.filter(value=>value.name==='map-pan');assert.equal(windows.length,1);
 const window=windows[0],down=item.pan.events.filter(value=>value.type==='pointerdown'),up=item.pan.events.filter(value=>value.type==='pointerup');
 assert.equal(down.length,1);assert.equal(up.length,1);assert.equal(down[0].trusted,true);assert.equal(up[0].trusted,true);assert.equal(down[0].pointerId,up[0].pointerId);
 const start=down[0].time,end=up[0].time;
 assert.ok(Number.isFinite(start)&&Number.isFinite(end)&&end>start);assert.ok(start>=window.raw.startedAt&&end<=window.raw.endedAt);
 const frames=window.raw.frames;assert.ok(Array.isArray(frames)&&frames.length>=2);
 const intervals=[];
 for(let index=1;index<frames.length;index++){
  const from=frames[index-1],to=frames[index];assert.ok(Number.isFinite(from)&&Number.isFinite(to)&&to>from);
  if(from<end&&to>start)intervals.push({rawFromIndex:index-1,rawToIndex:index,from,to,durationMs:to-from,fullyContained:from>=start&&to<=end});
 }
 assert.ok(intervals.length>0);
 const summary=values=>{
  const sorted=values.map(value=>value.durationMs).sort((a,b)=>a-b);
  return{count:sorted.length,p95Ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,maxMs:sorted.length?sorted.at(-1):null,
   meanMs:sorted.length?sorted.reduce((sum,value)=>sum+value,0)/sorted.length:null,
   referenceIntervalMs:SMOOTHNESS_LIMITS.frameP95Ms,atOrAboveReferenceIntervalCount:sorted.filter(value=>value>=SMOOTHNESS_LIMITS.frameP95Ms).length};
 };
 return{derivedFromUnchangedRaw:true,isAcceptanceGate:false,isPresentedFps:false,
  definition:'Every consecutive raw RAF interval overlapping the trusted pointerdown.time..pointerup.time span (from < up && to > down), retaining its full duration without clipping; fully-contained intervals are also summarized for boundary transparency.',
  pointerdown:{...down[0]},pointerup:{...up[0]},pointerSpanMs:end-start,nativeCommandDurationMs:item.pan.durationMs,
  originalWindow:{startedAt:window.raw.startedAt,endedAt:window.raw.endedAt,durationMs:window.durationMs,frameSamples:window.frames.samples,p95Ms:window.frames.p95Ms},
  overlapping:summary(intervals),fullyContained:summary(intervals.filter(value=>value.fullyContained)),intervals};
}

const [baselineDirectory,optimizedDirectory,outputDirectory,controllerArgument]=process.argv.slice(2);
const controllerCommit=controllerArgument||process.env.GITHUB_SHA;
assert.match(controllerCommit,/^[a-f0-9]{40}$/,'Expected the sealed measurement workflow/controller commit');
assert.ok(baselineDirectory&&optimizedDirectory&&outputDirectory,'Expected baseline, optimized and output directories');
const baseline=await readVariant(baselineDirectory,'baseline',BASELINE),optimized=await readVariant(optimizedDirectory,'optimized',OPTIMIZED);
const guard=source=>source.slice(source.indexOf('  private detailCoversViewport'),source.indexOf('  private draw(){'));
assert.ok(guard(baseline.engine).length>1000);assert.equal(guard(optimized.engine),guard(baseline.engine),'Opaque coverage proof changed');
// Every original build/browser/environment header identifies the Actions
// controller because runner-owned GITHUB_SHA ignored the step-level override.
// Bind the application via its independently enumerated immutable checkout
// bytes, complete retained input records and recomputed build ID. Preserve all headers.
assertMatchingBrowserEnvironments(baseline.report.environment,optimized.report.environment,controllerCommit);
const comparisons=[];
for(const profile of profiles){
 const a=baseline.report.profiles.find(value=>value.profile===profile.name),b=optimized.report.profiles.find(value=>value.profile===profile.name);
 assert.deepEqual(inputs(a.pan),inputs(b.pan),profile.name+' native pan recipe changed');
 comparisons.push({profile:profile.name,nativeInput:inputs(a.pan),baseline:metrics(a),optimized:metrics(b),activePan:{baseline:activePanIntervals(a),optimized:activePanIntervals(b)}});
}
const result={schemaVersion:1,diagnosticOnly:true,releaseEligible:false,evidence:'same-host-untraced-opaque-clear-comparison',verified:true,
 order:['baseline','optimized'],measurementControllerCommit:controllerCommit,verificationRunId:process.env.GITHUB_RUN_ID||null,sourceBindingCorrection:'The original and first sealed binders incorrectly equated the controller SHA in build/browser/environment headers with the application checkout SHA. Every original receipt remains unchanged. Application identity is established by the complete independently enumerated immutable checkout input bytes, committed-manifest APK record, verified source custom-map outputs and recomputed original build ID. No build or browser measurements are rerun.',profiles:profiles.map(value=>value.name),scenarios:[...SMOOTHNESS_SCENARIOS],
 baseline:{applicationSourceCommit:baseline.sourceCommit,measurementControllerCommit:baseline.report.sourceCommit,engineSHA256:baseline.engineSHA256,reportSHA256:baseline.reportSHA256,buildSHA256:baseline.buildSHA256,buildId:baseline.buildId,sourceProof:baseline.sourceProof,environment:baseline.report.environment,performanceIssues:baseline.report.performanceIssues},
 optimized:{applicationSourceCommit:optimized.sourceCommit,measurementControllerCommit:optimized.report.sourceCommit,engineSHA256:optimized.engineSHA256,reportSHA256:optimized.reportSHA256,buildSHA256:optimized.buildSHA256,buildId:optimized.buildId,sourceProof:optimized.sourceProof,environment:optimized.report.environment,performanceIssues:optimized.report.performanceIssues},
 optimizedPerformancePassed:optimized.report.performancePassed,comparisons,
 limitations:['The six-file artifact contains original receipts, not deployed bundle or APK payload bytes. Checkout/runtime input verification and retained output metadata are distinguished explicitly.','One predefined baseline-then-optimized pair is not a statistical hardware benchmark.','Whole-window P95 includes settling time. A longer settling tail can lower that P95 without improving active dragging; the separate raw native-span summaries are descriptive and do not change any acceptance budget.','The comparison preserves all original windows, budgets, profiles, native inputs and EventTiming entries.','Opaque-guard execution requires separate operation-observation evidence; timing receipts do not contain it.','This diagnostic does not replace the full browser gate or actual Android tests on the final candidate.']};
await mkdir(resolve(outputDirectory),{recursive:true});
await writeFile(join(resolve(outputDirectory),'map-clear-ab-verification.json'),JSON.stringify(result,null,2)+'\n');
console.log('TROPNIK_MAP_CLEAR_AB='+JSON.stringify(result));
assert.equal(result.optimizedPerformancePassed,true,'Optimized normal UI audit still exceeds the unchanged budgets');
