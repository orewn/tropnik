import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BASELINE_COMMIT,PAIRED_ORDER,WORKER_PATH,assertAlphaOnlySource,assertChangedPaths,assertUntracedReport,assertPairedReports,assertPixelParity,capture,summarize} from '../map-pan-paired-diagnostic.mjs';
import {smoothnessFixture} from './smoothness-fixture.mjs';
import {browserEnvironmentFixture} from './browser-environment-fixture.mjs';
import {OPAQUE_VECTOR_CASES} from './fixtures/map-vector-opaque.mjs';

const candidateCommit='c'.repeat(40),options={candidateCommit,baselineWorkerSHA256:'a'.repeat(64),candidateWorkerSHA256:'b'.repeat(64),builds:{baseline:{buildInfoSHA256:'a'.repeat(64)},candidate:{buildInfoSHA256:'b'.repeat(64)}}};
function report(commit,pid){
 const environment=browserEnvironmentFixture(commit);environment.commandLine=environment.commandLine.replace('/tmp/fixture','/tmp/tropnik-chrome-'+pid);
 return{schemaVersion:1,sourceCommit:commit,environment,diagnostic:'ui-smoothness',diagnosticOnly:true,verified:false,releaseEligible:false,status:'completed',performanceIssues:[],performancePassed:true,
  profiles:['android-portrait','desktop-webgl'].map(name=>smoothnessFixture(name,'tropnik-canvas'))};
}
function pair(){return PAIRED_ORDER.map((label,index)=>({label,variant:index%2?'candidate':'baseline',outcome:'success',validationErrors:[],buildInfoSHA256:(index%2?'b':'a').repeat(64),report:report(index%2?candidateCommit:BASELINE_COMMIT,100+index)}));}
function parity(){
 const equal=totalPixels=>({differentPixels:0,maxChannelDelta:0,totalPixels,baselinePixelSHA256:'d'.repeat(64),candidatePixelSHA256:'d'.repeat(64)});
 return{schemaVersion:1,evidence:'production-worker-transfer-and-engine-pixel-parity',sourceCommit:candidateCommit,verified:true,parityPassed:true,diagnosticOnly:true,releaseEligible:false,phase:'complete',workerSHA256:options.candidateWorkerSHA256,
  baseline:{sourceSHA256:options.baselineWorkerSHA256,kind:'same-production-worker-only-output-alpha-true',replacements:1,candidateExpression:"alpha:job.kind!=='vector'||!!job.transparent",referenceExpression:'alpha:true'},expectedCases:32,expectedCompositeFrames:128,
  runs:[1,2].flatMap(dpr=>[false,true].map(softwareRaster=>({dpr,softwareRaster,verified:true,
   negativeControls:[...['relief','raster','satellite-overlay'].map(name=>({name,outputContext:{actual:{alpha:true}},comparison:equal(512*512),forceOpaque:{differentPixels:12}})),{name:'composite-witnesses',reliefDifference:{differentPixels:10},maskDifference:{differentPixels:20}}],
   cases:OPAQUE_VECTOR_CASES.map(({name})=>({name,verified:true,outputDimensions:[512,512],contexts:{baseline:{actual:{alpha:true}},candidate:{actual:{alpha:false}}},raw:equal(512*512),frames:['altai','fractional-pan','rotated-pan','enlarged'].map(name=>({name,comparison:equal(512*384*dpr*dpr)}))}))})))
 };
}

test('the alpha experiment rejects any additional production edit or a second replacement',async()=>{
 const candidate=await readFile(new URL('../../../web/lib/custom-map-tiles.worker.ts',import.meta.url),'utf8');
 const baseline=candidate.replace("alpha:job.kind!=='vector'||!!job.transparent,willReadFrequently:!!job.softwareRaster",'alpha:true,willReadFrequently:!!job.softwareRaster');
 assertAlphaOnlySource(baseline,candidate);
 assert.throws(()=>assertAlphaOnlySource(baseline,candidate+'\n'));
 assert.throws(()=>assertAlphaOnlySource(baseline,candidate.replace("job.kind!=='vector'||!!job.transparent",'false')));
 assertChangedPaths([WORKER_PATH,'web/public/custom-map/workers/custom-map-tiles.worker-new.js']);
 for(const path of ['web/lib/map-resource-pool.ts','tools/pages-preview/browser-satellite-audit.mjs','tools/pages-preview/browser-smoothness.mjs','web/app/globals.css'])assert.throws(()=>assertChangedPaths([WORKER_PATH,path]),/Unexpected experiment change/);
});

test('all four normal-speed untraced audits must retain their source, order, build and fresh browser profiles',()=>{
 assert.equal(assertPairedReports(pair(),options).length,4);
 const relocated=pair();relocated[3].report.environment.nativeSurface.window.left+=20;relocated[3].report.environment.nativeSurface.window.top+=20;assert.equal(assertPairedReports(relocated,options).length,4);
 for(const mutate of [runs=>runs.pop(),runs=>runs.reverse(),runs=>runs[1].report.sourceCommit=BASELINE_COMMIT,runs=>runs[2].report.environment.commandLine=runs[0].report.environment.commandLine,
  runs=>runs[1].report.environment.runner.cpu.models=['Different runner'],runs=>runs[3].buildInfoSHA256='e'.repeat(64),runs=>{runs[0].buildInfoSHA256=runs[2].buildInfoSHA256='f'.repeat(64);},runs=>runs[0].outcome='failure',runs=>runs[0].validationErrors.push('failed validation')]){
  const runs=pair();mutate(runs);assert.throws(()=>assertPairedReports(runs,options));
 }
});

test('diagnostic receipts cannot masquerade as releases or rewrite native input, tracing or raw metric summaries',()=>{
 const good=report(candidateCommit,123);assert.equal(assertUntracedReport(good,candidateCommit),'/tmp/tropnik-chrome-123');
 for(const mutate of [r=>r.verified=true,r=>r.releaseEligible=true,r=>r.diagnosticOnly=false,r=>r.profiles[0].instrumented=true,r=>r.profiles[0].cpuSlowdownRate=4,
  r=>r.profiles[1].pan.commands.splice(3,1),r=>r.profiles[1].pan.holdBeforeReleaseMs=100,r=>r.profiles[1].scenarios[4].frames.p95Ms=0,
  r=>r.environment.commandLine+=' --disable-gpu',r=>r.environment.nativeSurface.viewport.innerHeight=400]){
  const bad=structuredClone(good);mutate(bad);assert.throws(()=>assertUntracedReport(bad,candidateCommit));
 }
});

test('the pixel gate binds the real old worker and requires all 32 raw transfers, 128 composites and transparency negative controls',()=>{
 assertPixelParity(parity(),options);
 for(const mutate of [r=>r.baseline.sourceSHA256='e'.repeat(64),r=>r.workerSHA256='e'.repeat(64),r=>r.runs.pop(),r=>r.runs[0].cases[0]=r.runs[0].cases[1],
  r=>r.runs[0].cases[0].raw.differentPixels=1,r=>r.runs[3].cases[7].frames[3].comparison.maxChannelDelta=1,r=>r.runs[0].cases[0].frames[1].name='altai',
  r=>r.runs[1].cases[0].contexts.candidate.actual.alpha=true,r=>r.runs[0].negativeControls[1].forceOpaque.differentPixels=0,r=>r.runs[0].negativeControls[3].maskDifference.differentPixels=0,
  r=>r.releaseEligible=true,r=>r.parityPassed=false]){
  const bad=parity();mutate(bad);assert.throws(()=>assertPixelParity(bad,options));
 }
});

const digest=value=>createHash('sha256').update(value).digest('hex');
const save=async(path,value)=>{await mkdir(join(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value)+'\n');};
test('capture and summary retain all scheduled outcomes when reset, report or pointer evidence is missing',async t=>{
 const root=await mkdtemp(join(tmpdir(),'tropnik-paired-incomplete-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const receipt=await capture(join(root,'missing-checkout'),join(root,'A1'),'failure');
 assert.equal(receipt.label,'A1');assert.equal(receipt.outcome,'failure');assert.ok(receipt.validationErrors.some(error=>error.startsWith('Reset receipt:')));
 await save(join(root,'provenance.json'),options);
 await save(join(root,'A1/dist/browser-ui-smoothness-diagnostic.json'),{profiles:[{profile:'desktop-webgl',pan:{events:[]},scenarios:[{name:'map-pan',raw:{}}]}]});
 await assert.rejects(summarize(root,'failure','skipped','skipped','skipped'));
 const result=JSON.parse(await readFile(join(root,'paired-report.json'),'utf8'));
 assert.equal(result.status,'incomplete');assert.deepEqual(result.runs.map(run=>run.label),PAIRED_ORDER);
 assert.deepEqual(result.runs.map(run=>run.outcome),['failure','skipped','skipped','skipped']);
 assert.equal(result.runs[0].pan[0].incomplete,true);assert.ok(result.runs.slice(1).every(run=>run.sourceCommit===null&&run.validationErrors.length));
 assert.equal(result.verified,false);assert.equal(result.releaseEligible,false);
});

test('summary binds saved report bytes and each variant build to the preflight receipt',async t=>{
 const root=await mkdtemp(join(tmpdir(),'tropnik-paired-digests-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const builds={baseline:JSON.stringify({sourceCommit:BASELINE_COMMIT}),candidate:JSON.stringify({sourceCommit:candidateCommit})};
 const provenance={...options,builds:Object.fromEntries(Object.entries(builds).map(([variant,bytes])=>[variant,{buildInfoSHA256:digest(bytes)}]))};
 await save(join(root,'provenance.json'),provenance);
 const pixel=JSON.stringify(parity());await mkdir(join(root,'parity'));await writeFile(join(root,'parity/browser-vector-alpha-verification.json'),pixel);
 await save(join(root,'parity-gate.json'),{parityPassed:true,receiptSHA256:digest(pixel)});
 for(const run of pair()){
  const bytes=JSON.stringify(run.report);await mkdir(join(root,run.label,'dist'),{recursive:true});
  await writeFile(join(root,run.label,'dist/browser-ui-smoothness-diagnostic.json'),bytes);await writeFile(join(root,run.label,'dist/build-info.json'),builds[run.variant]);
  const {report:unused,...receipt}=run;void unused;
  await save(join(root,run.label,'run-receipt.json'),{...receipt,reportSHA256:digest(bytes),buildInfoSHA256:provenance.builds[run.variant].buildInfoSHA256});
 }
 assert.equal((await summarize(root,'success','success','success','success')).status,'completed');
 const path=join(root,'A2/dist/browser-ui-smoothness-diagnostic.json');await writeFile(path,(await readFile(path,'utf8'))+'\n');
 await assert.rejects(summarize(root,'success','success','success','success'));
 const result=JSON.parse(await readFile(join(root,'paired-report.json'),'utf8'));assert.equal(result.status,'incomplete');
 assert.deepEqual(result.runs.map(run=>run.label),PAIRED_ORDER);assert.ok(result.runs[2].validationErrors.some(error=>error.includes('Saved report bytes differ')));
});
