import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {nativeSurfaceIdentity} from './browser-native-surface.mjs';
import {assertBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {assertSmoothnessAudit,SMOOTHNESS_SCENARIOS,SMOOTHNESS_LIMITS} from './browser-smoothness.mjs';
import {verifySealedBuildSource} from './map-clear-build-source.mjs';

const BASELINE='1710b201bfeed52613659ae3e4ca7f26638cb6cb';
const OPTIMIZED='8a12cf6e58643b9286b89e8e528afbeeaf9c2133';
const HASHES={baseline:'c25b61c97602070d746706d977d50906217e4b1258ce5a482ae64bb914ee3127',optimized:'ad1a673c50ebbb1bdb896c2643af6fdd27fe9cd6e6aa1ceea1e6660b30a1a496'};
const sha=value=>createHash('sha256').update(value).digest('hex');
const profiles=[{name:'android-portrait',engine:'tropnik-canvas',mobile:true},{name:'desktop-webgl',engine:'tropnik-canvas',mobile:false}];

async function readVariant(directory,label,sourceCommit){
 const root=resolve(directory),bytes=await readFile(join(root,'web/pages-preview/dist/browser-ui-smoothness-diagnostic.json'));
 const report=JSON.parse(bytes),buildBytes=await readFile(join(root,'web/pages-preview/dist/build-info.json')),build=JSON.parse(buildBytes);
 const engine=await readFile(join(root,'web/lib/custom-map-engine.ts'));
 assert.equal(sha(engine),HASHES[label],label+' engine bytes');
 // Each new build really carries its own immutable application SHA. The
 // existing inventory verifier independently recomputes the complete build ID.
 const sourceProof=await verifySealedBuildSource(root,build,{sourceCommit,controllerCommit:sourceCommit,expectedBuildId:build.buildId});
 const runtimeBytes=await verifyDeployedRuntime(root,build);
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
 return{sourceCommit,engineSHA256:sha(engine),reportSHA256:sha(bytes),buildSHA256:sha(buildBytes),buildId:build.buildId,sourceProof,runtimeBytes,report,engine:engine.toString('utf8')};
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


const RESET_BLOCK="    // Discard obsolete recorded operations before rebuilding this complete\n    // frame. The opaque detail proof or the original paper fill covers it.\n    ctx.clearRect(0,0,this.canvas.width,this.canvas.height);\n";
const SELECTION_POLICY=Object.freeze({purpose:'predeclared optimization selection only; not a replacement release gate',desktopP95Metric:'activePan.fullyContained.p95Ms',maximumP95Ratio:.9,meanMetric:'activePan.fullyContained.meanMs',meanMustNotRegress:true,inputMetric:'map-pan.inputToNextFrame.maxMs',inputMustNotRegress:true,requiresExactPixels:true,requiresEveryOriginalOptimizedBudget:true});
function selectOptimization({baseline,optimized,pixelVerified,optimizedPerformancePassed}){
 const finite=[baseline.p95,baseline.mean,baseline.input,optimized.p95,optimized.mean,optimized.input].every(Number.isFinite)&&baseline.p95>0&&optimized.p95>0&&baseline.mean>0&&optimized.mean>0&&baseline.input>=0&&optimized.input>=0;
 const checks={finiteMeasurements:finite,exactPixels:pixelVerified===true,unchangedOptimizedBudgets:optimizedPerformancePassed===true,
  desktopP95ImprovedByAtLeastTenPercent:finite&&optimized.p95<=baseline.p95*.9,
  desktopMeanNotRegressed:finite&&optimized.mean<=baseline.mean,desktopInputNotRegressed:finite&&optimized.input<=baseline.input};
 const retain=Object.values(checks).every(Boolean);
 return{policy:SELECTION_POLICY,retain,recommendation:retain?'retain-candidate':'discard-experiment',checks,baseline,optimized,p95ReductionFraction:finite?1-optimized.p95/baseline.p95:null,isReleaseAcceptance:false};
}
function selectionSelfTest(){
 const good={baseline:{p95:40,mean:25,input:40},optimized:{p95:36,mean:24,input:40},pixelVerified:true,optimizedPerformancePassed:true};
 assert.equal(selectOptimization(good).retain,true);
 for(const patch of [{optimized:{...good.optimized,p95:36.0001}},{optimized:{...good.optimized,mean:25.001}},{optimized:{...good.optimized,input:40.001}},{pixelVerified:false},{optimizedPerformancePassed:false},{optimized:{...good.optimized,p95:NaN}}])assert.equal(selectOptimization({...good,...patch}).retain,false);
 return{cases:7,passed:true};
}
async function verifyDeployedRuntime(root,build){
 const output=join(root,'web/pages-preview/dist'),records=[];
 for(const expected of build.customMap.deployedFiles){
  assert.match(expected.path,/^[\w./-]+$/);assert.ok(!expected.path.split('/').includes('..')&&!expected.path.startsWith('/'));
  const path='custom-map/'+expected.path,file=join(output,path),stat=await lstat(file);assert.equal(stat.isFile(),true);assert.equal(stat.isSymbolicLink(),false);
  const bytes=await readFile(file);assert.equal(bytes.length,expected.sizeBytes);assert.equal(sha(bytes),expected.sha256);
  records.push({path,bytes:bytes.length,sha256:sha(bytes)});
 }
 const assets=[];
 const visit=async(relativePath)=>{
  for(const entry of (await readdir(join(output,relativePath),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   assert.equal(entry.isSymbolicLink(),false);const path=relativePath+'/'+entry.name;
   if(entry.isDirectory())await visit(path);
   else if(/\.(?:js|mjs|css)$/.test(path)){const bytes=await readFile(join(output,path));assets.push({path,bytes:bytes.length,sha256:sha(bytes)});}
  }
 };
 await visit('assets');assert.ok(assets.some(record=>/\/CustomAtlas-[\w-]+\.js$/.test(record.path)),'Actual built CustomAtlas runtime is absent');
 return{deployedCustomMapBytesVerified:true,deployedFiles:records,siteRuntimeAssets:assets,siteRuntimeAssetsSHA256:sha(JSON.stringify(assets))};
}
async function verifyPixelBinding(root,optimized){
 const bytes=await readFile(join(resolve(root),'web/pages-preview/dist/browser-map-underlay-verification.json')),pixel=JSON.parse(bytes);
 assert.equal(pixel.schemaVersion,1);assert.equal(pixel.verified,true);assert.equal(pixel.phase,'complete');
 assert.equal(pixel.sourceCommit,OPTIMIZED);assert.equal(pixel.rendererSHA256,HASHES.optimized);
 assert.equal(pixel.baselineSourceCommit,BASELINE);assert.equal(pixel.baselineRendererSHA256,HASHES.baseline);
 assert.equal(pixel.baseline,'immutable-1710-production-draw');assert.equal(pixel.underlayControl,'immutable-1710-draw-with-fixture-only-coverage-false');
 assertMatchingBrowserEnvironments(pixel.environment,optimized.report.environment,OPTIMIZED);
 let frames=0,captures=0;
 for(const item of pixel.cases)for(const frame of item.frames){
  frames++;assert.deepEqual(frame.comparison,{differentPixels:0,maxChannelDelta:0,totalPixels:frame.width*frame.height});
  assert.deepEqual(frame.underlayComparison,frame.comparison);assert.equal(frame.baselinePixelSHA256,frame.optimizedPixelSHA256);assert.equal(frame.underlayControlPixelSHA256,frame.optimizedPixelSHA256);
  assert.equal(frame.operations.baseline.discard,0);assert.equal(frame.operations.optimized.discard,1);assert.equal(frame.operations.underlayControl.discard,0);
  assert.deepEqual(frame.captures.map(capture=>capture.phase),['baseline','optimized','underlay-control']);
  for(const capture of frame.captures){
   captures++;assert.match(capture.file,/^[a-zA-Z0-9.-]+\.png$/);
   const png=await readFile(join(resolve(root),'web/pages-preview/design-qa/map-underlay',capture.file));
   assert.equal(png.length,capture.bytes);assert.equal(sha(png),capture.sha256);
  }
 }
 assert.equal(pixel.cases.length,30);assert.equal(frames,46);assert.equal(captures,138);
 return{verified:true,sourceCommit:pixel.sourceCommit,rendererSHA256:pixel.rendererSHA256,baselineSourceCommit:pixel.baselineSourceCommit,baselineRendererSHA256:pixel.baselineRendererSHA256,reportSHA256:sha(bytes),cases:30,frames,captures,exactTriples:true,fullOriginalBinderExecutedBeforeTiming:true};
}
async function compare(baselineDirectory,optimizedDirectory,controllerCommit){
 const baseline=await readVariant(baselineDirectory,'baseline',BASELINE),optimized=await readVariant(optimizedDirectory,'optimized',OPTIMIZED);
 assert.equal(optimized.engine.split(RESET_BLOCK).length,2);assert.equal(optimized.engine.replace(RESET_BLOCK,''),baseline.engine,'The complete engine must differ only by the reviewed full-canvas discard');
 const harness=[];
 for(const path of ['browser-smoke.mjs','browser-smoothness.mjs','browser-source-end-pan.mjs','browser-environment.mjs','browser-native-surface.mjs']){
  const a=await readFile(join(resolve(baselineDirectory),'tools/pages-preview',path)),b=await readFile(join(resolve(optimizedDirectory),'tools/pages-preview',path));
  assert.equal(sha(a),sha(b),'Normal audit source changed: '+path);harness.push({path,sha256:sha(a)});
 }
 // Validate each truthful application SHA first; compare the same stable fields
 // used by the shared validator without relabelling either original receipt.
 for(const key of ['profile','requestedFlags','browser','gpu','runner'])assert.deepEqual(baseline.report.environment[key],optimized.report.environment[key],'Same-host environment differs: '+key);
 assert.deepEqual(nativeSurfaceIdentity(baseline.report.environment.nativeSurface),nativeSurfaceIdentity(optimized.report.environment.nativeSurface));
 const pixelProof=await verifyPixelBinding(optimizedDirectory,optimized),comparisons=[];
 for(const profile of profiles){
  const a=baseline.report.profiles.find(value=>value.profile===profile.name),b=optimized.report.profiles.find(value=>value.profile===profile.name);
  assert.deepEqual(inputs(a.pan),inputs(b.pan),profile.name+' native pan recipe changed');
  comparisons.push({profile:profile.name,nativeInput:inputs(a.pan),baseline:metrics(a),optimized:metrics(b),activePan:{baseline:activePanIntervals(a),optimized:activePanIntervals(b)}});
 }
 const desktop=comparisons.find(value=>value.profile==='desktop-webgl');
 const selectMetrics=(entry,variant)=>({p95:entry.activePan[variant].fullyContained.p95Ms,mean:entry.activePan[variant].fullyContained.meanMs,input:entry[variant].find(window=>window.name==='map-pan').inputToNextFrame.maxMs});
 const selection=selectOptimization({baseline:selectMetrics(desktop,'baseline'),optimized:selectMetrics(desktop,'optimized'),pixelVerified:pixelProof.verified,optimizedPerformancePassed:optimized.report.performancePassed});
 const variant=value=>({applicationSourceCommit:value.sourceCommit,rawReportSourceCommit:value.report.sourceCommit,engineSHA256:value.engineSHA256,reportSHA256:value.reportSHA256,buildSHA256:value.buildSHA256,buildId:value.buildId,sourceProof:value.sourceProof,runtimeBytes:value.runtimeBytes,environment:value.report.environment,performanceIssues:value.report.performanceIssues,performancePassed:value.report.performancePassed});
 return{schemaVersion:1,diagnosticOnly:true,releaseEligible:false,evidence:'same-host-untraced-full-canvas-discard-comparison',verified:true,
  order:['baseline','optimized'],measurementControllerCommit:controllerCommit,workflowRunId:process.env.GITHUB_RUN_ID||null,
  sourceBinding:'Build, browser and environment headers each identify their actual immutable application checkout; the execution controller is recorded separately. No raw receipt is relabelled.',
  profiles:profiles.map(value=>value.name),scenarios:[...SMOOTHNESS_SCENARIOS],normalHarness:harness,baseline:variant(baseline),optimized:variant(optimized),
  pixelProof,optimizedPerformancePassed:optimized.report.performancePassed,comparisons,selection,
  limitations:['One predefined baseline-then-optimized pair is not a statistical hardware benchmark.','Whole-window P95 includes settling time; the unchanged raw active-pointer overlap and fully-contained summaries are reported separately.','Selection uses a predeclared 10% fully-contained desktop P95 reduction, nonregressed active mean and original inputToNextFrame maximum, exact pixels and all original optimized budgets. It is not a new release acceptance budget.','RAF callbacks do not prove presented pixels or physical-device FPS.','This diagnostic does not replace final full-browser and exact Android gates.']};
}
if(process.argv[2]==='--self-test'){console.log(JSON.stringify(selectionSelfTest()));process.exit(0);}
const [baselineDirectory,optimizedDirectory,outputDirectory]=process.argv.slice(2);
assert.ok(baselineDirectory&&optimizedDirectory&&outputDirectory);
const controllerCommit=process.env.GITHUB_SHA;assert.match(controllerCommit,/^[a-f0-9]{40}$/);
let result;
try{result=await compare(baselineDirectory,optimizedDirectory,controllerCommit);}
catch(error){result={schemaVersion:1,diagnosticOnly:true,releaseEligible:false,verified:false,measurementControllerCommit:controllerCommit,expectedBaseline:BASELINE,expectedOptimized:OPTIMIZED,selectionPolicy:SELECTION_POLICY,error:String(error.stack||error)};throw error;}
finally{
 await mkdir(resolve(outputDirectory),{recursive:true});
 await writeFile(join(resolve(outputDirectory),'map-clear-ab-verification.json'),JSON.stringify(result,null,2)+'\n');
 console.log('TROPNIK_MAP_CLEAR_AB='+JSON.stringify(result));
}
assert.equal(result.optimizedPerformancePassed,true,'Optimized normal UI audit still exceeds the unchanged budgets');
// A false optimization selection is retained evidence, not a request to retry.
