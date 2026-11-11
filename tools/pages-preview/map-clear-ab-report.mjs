import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {assertBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {assertSmoothnessAudit,SMOOTHNESS_SCENARIOS} from './browser-smoothness.mjs';

const BASELINE='f836dce11579eae0e4596ee5b73f8bbe7246128f';
const OPTIMIZED='1710b201bfeed52613659ae3e4ca7f26638cb6cb';
const HASHES={baseline:'bcb43c269a6b74b52956acd40aec48e666a4c40255c78f3e77e107210b60487a',optimized:'c25b61c97602070d746706d977d50906217e4b1258ce5a482ae64bb914ee3127'};
const sha=value=>createHash('sha256').update(value).digest('hex');
const profiles=[{name:'android-portrait',engine:'tropnik-canvas',mobile:true},{name:'desktop-webgl',engine:'tropnik-canvas',mobile:false}];

async function readVariant(directory,label,sourceCommit){
 const root=resolve(directory),bytes=await readFile(join(root,'web/pages-preview/dist/browser-ui-smoothness-diagnostic.json'));
 const report=JSON.parse(bytes),build=JSON.parse(await readFile(join(root,'web/pages-preview/dist/build-info.json'),'utf8'));
 const engine=await readFile(join(root,'web/lib/custom-map-engine.ts'));
 assert.equal(sha(engine),HASHES[label],label+' engine bytes');
 assert.equal(build.sourceCommit,sourceCommit);assert.equal(build.hasApk,true);
 assert.equal(report.sourceCommit,sourceCommit);assert.equal(report.schemaVersion,1);
 assert.equal(report.diagnostic,'ui-smoothness');assert.equal(report.diagnosticOnly,true);
 assert.equal(report.verified,false);assert.equal(report.releaseEligible,false);assert.equal(report.status,'completed');
 assert.deepEqual(report.profiles.map(item=>item.profile),profiles.map(item=>item.name));
 assertBrowserEnvironment(report.environment,sourceCommit);
 for(const profile of profiles){
  const item=report.profiles.find(value=>value.profile===profile.name);
  assert.equal(item.instrumented,false);assert.equal(item.cpuSlowdownRate,1);
  assertSmoothnessAudit(item,profile,{release:false});
 }
 const issues=report.profiles.flatMap(item=>item.performanceIssues);
 assert.deepEqual(report.performanceIssues,issues);assert.equal(report.performancePassed,issues.length===0);
 return{sourceCommit,engineSHA256:sha(engine),reportSHA256:sha(bytes),buildId:build.buildId,report,engine:engine.toString('utf8')};
}
function inputs(pan){return{input:pan.input,start:pan.start,end:pan.end,delta:pan.delta,holdBeforeReleaseMs:pan.holdBeforeReleaseMs,commands:pan.commands.map(({method,type,x,y})=>({method,type,x,y}))};}
function metrics(item){return item.scenarios.map(value=>({name:value.name,durationMs:value.durationMs,frames:value.frames,inputToNextFrame:value.inputToNextFrame,eventTiming:value.eventTiming,longTasks:value.longTasks,layout:value.layout}));}
const [baselineDirectory,optimizedDirectory,outputDirectory]=process.argv.slice(2);
assert.ok(baselineDirectory&&optimizedDirectory&&outputDirectory,'Expected baseline, optimized and output directories');
const baseline=await readVariant(baselineDirectory,'baseline',BASELINE),optimized=await readVariant(optimizedDirectory,'optimized',OPTIMIZED);
const guard=source=>source.slice(source.indexOf('  private detailCoversViewport'),source.indexOf('  private draw(){'));
assert.ok(guard(baseline.engine).length>1000);assert.equal(guard(optimized.engine),guard(baseline.engine),'Opaque coverage proof changed');
// Validate each original immutable source binding first. The shared comparator
// expects one commit; adapt only that field in a temporary comparison copy.
// Original receipts, hardware fields and persisted source identities are retained.
assertMatchingBrowserEnvironments({...baseline.report.environment,sourceCommit:OPTIMIZED},optimized.report.environment,OPTIMIZED);
const comparisons=[];
for(const profile of profiles){
 const a=baseline.report.profiles.find(value=>value.profile===profile.name),b=optimized.report.profiles.find(value=>value.profile===profile.name);
 assert.deepEqual(inputs(a.pan),inputs(b.pan),profile.name+' native pan recipe changed');
 comparisons.push({profile:profile.name,nativeInput:inputs(a.pan),baseline:metrics(a),optimized:metrics(b)});
}
const result={schemaVersion:1,diagnosticOnly:true,releaseEligible:false,evidence:'same-host-untraced-opaque-clear-comparison',verified:true,
 order:['baseline','optimized'],runId:process.env.GITHUB_RUN_ID||null,profiles:profiles.map(value=>value.name),scenarios:[...SMOOTHNESS_SCENARIOS],
 baseline:{sourceCommit:baseline.sourceCommit,engineSHA256:baseline.engineSHA256,reportSHA256:baseline.reportSHA256,buildId:baseline.buildId,environment:baseline.report.environment,performanceIssues:baseline.report.performanceIssues},
 optimized:{sourceCommit:optimized.sourceCommit,engineSHA256:optimized.engineSHA256,reportSHA256:optimized.reportSHA256,buildId:optimized.buildId,environment:optimized.report.environment,performanceIssues:optimized.report.performanceIssues},
 optimizedPerformancePassed:optimized.report.performancePassed,comparisons,
 limitations:['One predefined baseline-then-optimized pair is not a statistical hardware benchmark.','The comparison preserves all original windows, budgets, profiles, native inputs and EventTiming entries.','Opaque-guard execution requires separate operation-observation evidence; timing receipts do not contain it.','This diagnostic does not replace the full browser gate or actual Android tests on the final candidate.']};
await mkdir(resolve(outputDirectory),{recursive:true});
await writeFile(join(resolve(outputDirectory),'map-clear-ab-verification.json'),JSON.stringify(result,null,2)+'\n');
console.log('TROPNIK_MAP_CLEAR_AB='+JSON.stringify(result));
assert.equal(result.optimizedPerformancePassed,true,'Optimized normal UI audit still exceeds the unchanged budgets');
