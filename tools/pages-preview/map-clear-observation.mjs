import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rm,copyFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {assertBrowserEnvironment} from './browser-environment.mjs';
import {assertSmoothnessAudit} from './browser-smoothness.mjs';

const SOURCE='1710b201bfeed52613659ae3e4ca7f26638cb6cb',ENGINE='c25b61c97602070d746706d977d50906217e4b1258ce5a482ae64bb914ee3127';
const sha=value=>createHash('sha256').update(value).digest('hex');
const [directory,outputDirectory]=process.argv.slice(2),root=resolve(directory),output=resolve(outputDirectory);
const tools=join(root,'tools/pages-preview'),own=dirname(fileURLToPath(import.meta.url));
const smoothPath=join(tools,'map-clear-observed-smoothness.generated.mjs'),smokePath=join(tools,'map-clear-observed-smoke.generated.mjs'),helperPath=join(tools,'map-clear-paint-observer.generated.mjs');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),SOURCE);
const engine=await readFile(join(root,'web/lib/custom-map-engine.ts'));
assert.equal(sha(engine),ENGINE);
const buildInfoBytes=await readFile(join(root,'web/pages-preview/dist/build-info.json'));
const buildInfo=JSON.parse(buildInfoBytes);assert.equal(buildInfo.sourceCommit,SOURCE,'Built application source must equal its actual checkout');
const originalSmooth=await readFile(join(tools,'browser-smoothness.mjs'),'utf8'),originalSmoke=await readFile(join(tools,'browser-smoke.mjs'),'utf8');
const {MAP_OUTSIDE_COLOR}=await import(pathToFileURL(join(root,'web/public/maps/russia-viewport.js')).href);
const begin=originalSmooth.indexOf("await measure('map-pan',async()=>{"),end=originalSmooth.indexOf("await measure('map-zoom'",begin);
assert.ok(begin>0&&end>begin);
const block=originalSmooth.slice(begin,end),opening="await measure('map-pan',async()=>{";
const close=block.lastIndexOf('});');assert.ok(close>opening.length);
assert.equal((block.match(/observeSmoothnessPan/g)||[]).length,1);
const inner=block.slice(opening.length,close);
const originalPanCall='report.pan=await observeSmoothnessPan(cdp,start,delta,profile,{evaluate,sleep});';
assert.equal(inner.split(originalPanCall).length,2);
const profiledInner=inner.replace(originalPanCall,'report.pan=await profileNativeMapPan(cdp,evaluate,profile,report,()=>observeSmoothnessPan(cdp,start,delta,profile,{evaluate,sleep}));');
const observedBlock=opening+'\n   await startMapPaintObservation(cdp,evaluate,'+JSON.stringify(MAP_OUTSIDE_COLOR)+');\n   try{'+profiledInner+'\n   }finally{try{report.paintObservation=await finishMapPaintObservation(cdp,evaluate);}catch(error){report.paintObservation=error.paintObservation;throw error;}}\n  '+block.slice(close);
const observedSmooth="import {startMapPaintObservation,finishMapPaintObservation,profileNativeMapPan} from './map-clear-paint-observer.generated.mjs';\n"+originalSmooth.slice(0,begin)+observedBlock+originalSmooth.slice(end);
const importOld="from './browser-smoothness.mjs'",importNew="from './map-clear-observed-smoothness.generated.mjs'";
assert.equal(originalSmoke.split(importOld).length,2);
const observedSmoke=originalSmoke.replace(importOld,importNew);
const report={schemaVersion:1,diagnosticOnly:true,releaseEligible:false,verified:false,evidence:'actual-production-native-pan-cpu-and-paint-observation',
 sourceCommit:SOURCE,rendererSHA256:ENGINE,timingsAreEvidence:false,sourceCommitIdentifiesApplication:true,
 applicationBuild:{sourceCommit:buildInfo.sourceCommit,buildId:buildInfo.buildId,buildInfoSHA256:sha(buildInfoBytes)},
 harness:{kind:'temporary-observation-only-copies',originalSmoothnessSHA256:sha(originalSmooth),observedSmoothnessSHA256:sha(observedSmooth),originalSmokeSHA256:sha(originalSmoke),observedSmokeSHA256:sha(observedSmoke)},
 profiles:[],limitations:['No operation-observer, trace or sampled profile timing is accepted as a performance result.','A separate immutable baseline/new normal UI run supplies unchanged untraced timings.','Branch execution is inferred from mutually exclusive actual paint calls in the exact immutable production engine; no renderer API or graphics state is patched.','CPU self/inclusive times are sampled occupancy; trace event durations are nested inclusive wall intervals and cannot be summed across event kinds.','The active-pointer CPU range uses actual trusted pointerdown/up timestamps aligned to one page performance.mark in the same Chromium trace.']};
await mkdir(output,{recursive:true});
try{
 await writeFile(smoothPath,observedSmooth);await writeFile(smokePath,observedSmoke);
 await copyFile(join(own,'map-clear-paint-observer.mjs'),helperPath);
 report.harness.observerSHA256=sha(await readFile(helperPath));
 const observerModule=await import(pathToFileURL(helperPath).href);
 report.profileSummaryTests=observerModule.testPanProfileSummary();
 await copyFile(smoothPath,join(output,'observed-smoothness.mjs'));await copyFile(smokePath,join(output,'observed-smoke.mjs'));
 await copyFile(helperPath,join(output,'paint-observer.mjs'));
 // The existing trace mode labels every retained profile instrumented and
 // excludes it from release performance certification. It still preserves the
 // original eight scenarios and all native inputs, windows and validators.
 const child=spawnSync(process.execPath,[smokePath],{cwd:root,env:{...process.env,GITHUB_SHA:SOURCE,TROPNIK_BROWSER_DIAGNOSTIC:'ui-smoothness',TROPNIK_BROWSER_TRACE:'1'},stdio:'inherit',timeout:8*60*1000});
 const raw=await readFile(join(root,'web/pages-preview/dist/browser-ui-smoothness-diagnostic.json'));
 const actual=JSON.parse(raw);report.rawReportSHA256=sha(raw);
 assert.equal(actual.sourceCommit,SOURCE);assert.equal(actual.diagnosticOnly,true);assert.equal(actual.releaseEligible,false);assert.equal(actual.status,'completed');
 assertBrowserEnvironment(actual.environment,SOURCE);report.environment=actual.environment;
 assert.deepEqual(actual.profiles.map(value=>value.profile),['android-portrait','desktop-webgl']);
 for(const profile of [{name:'android-portrait',engine:'tropnik-canvas',mobile:true},{name:'desktop-webgl',engine:'tropnik-canvas',mobile:false}]){
  const entry=actual.profiles.find(value=>value.profile===profile.name);
  assert.equal(entry.instrumented,true);assertSmoothnessAudit(entry,profile,{release:false});
  const observation=entry.paintObservation;
  assert.ok(observation&&Number.isInteger(observation.coveredFrames)&&observation.coveredFrames>=0);
  assert.equal(observation.coveredFrames+observation.uncoveredFrames,observation.frames.length);
  assert.equal(observation.optimizationExercised,observation.coveredFrames>0);assert.equal(observation.timingsAreEvidence,false);
  assert.equal(entry.panProfile?.status,'complete');assert.equal(entry.panProfile.sourceCommit,SOURCE);
  assert.equal(entry.panProfile.timingsAreEvidence,false);assert.equal(entry.panProfile.releaseEligible,false);
  assert.ok(entry.panProfile.cpu?.samples>0&&entry.panProfile.activePointer?.cpu?.samples>0);
  assert.equal(entry.panProfile.trace?.status,'complete');
  report.profiles.push({profile:profile.name,nativePan:entry.pan,observation,cpuProfile:entry.panProfile});
 }
 assert.equal(child.error,undefined);assert.equal(child.status,0);
 assert.equal(sha(await readFile(join(root,'web/lib/custom-map-engine.ts'))),ENGINE);
 assert.equal(await readFile(join(tools,'browser-smoothness.mjs'),'utf8'),originalSmooth);
 assert.equal(await readFile(join(tools,'browser-smoke.mjs'),'utf8'),originalSmoke);
 report.verified=true;
}catch(error){report.error=String(error.stack||error);throw error;}
finally{
 await Promise.all([smoothPath,smokePath,helperPath].map(path=>rm(path,{force:true})));
 await writeFile(join(output,'map-clear-observation.json'),JSON.stringify(report,null,2)+'\n');
 console.log('TROPNIK_MAP_CLEAR_OBSERVATION='+JSON.stringify(report));
}
