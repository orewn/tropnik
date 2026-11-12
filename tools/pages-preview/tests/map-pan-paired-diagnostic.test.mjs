import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BASELINE_COMMIT,PAIRED_ORDER,ENGINE_PATH,ORACLE_PATH,ORACLE_SHA256,assertLabelMemoOnlySource,assertChangedPaths,assertUntracedReport,assertPairedReports,assertUnderlayReceipt,UNDERLAY_COVERS,capture,summarize} from '../map-pan-paired-diagnostic.mjs';
import {smoothnessFixture} from './smoothness-fixture.mjs';
import {browserEnvironmentFixture} from './browser-environment-fixture.mjs';

const candidateCommit='c'.repeat(40),options={candidateCommit,candidateEngineSHA256:'b'.repeat(64),builds:{baseline:{buildInfoSHA256:'a'.repeat(64)},candidate:{buildInfoSHA256:'b'.repeat(64)}}};
function report(commit,pid){
 const environment=browserEnvironmentFixture(commit);environment.commandLine=environment.commandLine.replace('/tmp/fixture','/tmp/tropnik-chrome-'+pid);
 return{schemaVersion:1,sourceCommit:commit,environment,diagnostic:'ui-smoothness',diagnosticOnly:true,verified:false,releaseEligible:false,status:'completed',performanceIssues:[],performancePassed:true,
  profiles:['android-portrait','desktop-webgl'].map(name=>smoothnessFixture(name,'tropnik-canvas'))};
}
function pair(){return PAIRED_ORDER.map((label,index)=>({label,variant:index%2?'candidate':'baseline',outcome:'success',validationErrors:[],buildInfoSHA256:(index%2?'b':'a').repeat(64),report:report(index%2?candidateCommit:BASELINE_COMMIT,100+index)}));}
function underlay(){
 return{schemaVersion:1,evidence:'production-canvas-underlay-pixel-parity',baseline:'same-production-draw-with-fixture-only-coverage-false',sourceCommit:candidateCommit,verified:true,phase:'complete',rendererSHA256:options.candidateEngineSHA256,sources:{[ENGINE_PATH]:options.candidateEngineSHA256},environment:browserEnvironmentFixture(candidateCommit),
  cases:[1,2].flatMap(dpr=>Object.entries(UNDERLAY_COVERS).map(([name,covers])=>({name,dpr,verified:true,contextAttributes:{alpha:false,willReadFrequently:false},policy:{softwareRaster:false},bitmapDimensions:[512,512],tileDeviceSpan:name==='tiny-tile'?.5:128,
   priorFrame:{kind:'distinct-opaque-checkerboards',comparison:{differentPixels:512*384*dpr*dpr,totalPixels:512*384*dpr*dpr,maxChannelDelta:255},baselinePixelSHA256:'a'.repeat(64),optimizedPixelSHA256:'b'.repeat(64)},
   negativeControls:(name==='opaque'?['remove-route','remove-selectedBoundary','remove-mask']:['missing','transparent'].includes(name)?['force-unsafe-cover']:[]).map(name=>({name,differentPixels:100})),
   frames:covers.map((cover,index)=>{const baseline={area:1,overview:4,clear:1,mask:1,selectedArea:1,detail:9,relief:9,imagery:0,proofCalls:1};return{width:512*dpr,height:384*dpr,actualCoverage:cover,expectedCoverage:cover,comparison:{differentPixels:0,maxChannelDelta:0,totalPixels:512*384*dpr*dpr},baselinePixelSHA256:'d'.repeat(64),optimizedPixelSHA256:'d'.repeat(64),operations:{baseline,optimized:{...baseline,area:cover?0:1,overview:cover?0:4,clear:cover?0:1}},captures:['baseline','optimized'].map(phase=>({phase,file:`dpr${dpr}-${name}-${index}-${phase}.png`}))};})
  })))
 };
}

test('the memo experiment pins the old method and rejects changes to raster, camera, input or other production files',async()=>{
 const oracle=await readFile(new URL('../../../'+ORACLE_PATH,import.meta.url),'utf8');
 const baseline="type TileBatch={};\nclass CustomMapEngine {\n  private additionalLabels=[];\n  private draw(){this.paint();}\n"+oracle+"  destroy(){this.labelDiagnostics=[];this.labelDiagnosticTotal=0;}\n}\n";
 const candidate=baseline.replace('type TileBatch={};','type TileBatch={};\ntype LabelCandidate={};').replace('  private additionalLabels=[];','  private additionalLabels=[];\n  private labelCandidateCache?:unknown;\n  private prepareLabelCandidates(){return [];}').replace(oracle,oracle.replace('this.labelDiagnostics=[];','this.labelDiagnostics=[];this.prepareLabelCandidates();')).replace('this.labelDiagnosticTotal=0;}','this.labelDiagnosticTotal=0;this.labelCandidateCache=undefined;}');
 assertLabelMemoOnlySource(baseline,candidate,oracle);
 for(const changed of [candidate.replace('this.paint();',''),candidate.replace('private draw(){','private draw(changed:boolean){'),candidate+'\nconst sideEffect=mutate();',candidate.replace('labelCandidateCache?:unknown','labelCandidateCache=mutate()'),candidate.replace('this.labelCandidateCache=undefined;','')])assert.throws(()=>assertLabelMemoOnlySource(baseline,changed,oracle));
 assert.throws(()=>assertLabelMemoOnlySource(baseline,candidate,oracle+'\n'));
 assertChangedPaths([ENGINE_PATH,ORACLE_PATH,'web/public/custom-map/chunks/custom-map-entry-new.js']);
 for(const path of ['web/lib/custom-map-tiles.worker.ts','web/lib/custom-map-tiles.ts','web/lib/map-resource-pool.ts','tools/pages-preview/browser-satellite-audit.mjs','tools/pages-preview/browser-smoothness.mjs','web/app/globals.css'])assert.throws(()=>assertChangedPaths([ENGINE_PATH,path]),/Unexpected experiment change/);
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

test('the unchanged underlay proof requires its exact engine, all 30 cases and 46 frames, real witnesses and zero pixel differences',()=>{
 assertUnderlayReceipt(underlay(),options);
 for(const mutate of [r=>r.rendererSHA256='e'.repeat(64),r=>r.sourceCommit=BASELINE_COMMIT,r=>r.cases.pop(),r=>r.cases[0]=r.cases[1],
  r=>r.cases[0].frames[0].comparison.differentPixels=1,r=>r.cases[2].frames.pop(),r=>r.cases[0].priorFrame.comparison.differentPixels=0,
  r=>r.cases[0].frames[0].operations.optimized.relief=0,r=>r.cases[0].negativeControls[2].differentPixels=0,r=>r.cases[0].frames[0].captures.pop(),
  r=>r.environment.commandLine+=' --disable-gpu',r=>r.verified=false]){
  const bad=underlay();mutate(bad);assert.throws(()=>assertUnderlayReceipt(bad,options));
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
 const oracle=await readFile(new URL('../../../'+ORACLE_PATH,import.meta.url),'utf8'),semanticTest='// Exact test source captured by preflight.\n';
 const provenance={...options,semanticProof:{outcome:'success',oraclePath:ORACLE_PATH,oracleSHA256:ORACLE_SHA256,baselineMethodSHA256:ORACLE_SHA256,testPath:'web/tests/custom-map-engine.test.mjs',testSHA256:digest(semanticTest)},builds:Object.fromEntries(Object.entries(builds).map(([variant,bytes])=>[variant,{buildInfoSHA256:digest(bytes)}]))};
 await save(join(root,'provenance.json'),provenance);
 await mkdir(join(root,'semantics'));await writeFile(join(root,'semantics/drawLabels-baseline.txt'),oracle);await writeFile(join(root,'semantics/custom-map-engine.test.mjs'),semanticTest);
 const pixel=JSON.stringify(underlay());await mkdir(join(root,'underlay'));await writeFile(join(root,'underlay/browser-map-underlay-verification.json'),pixel);
 await save(join(root,'underlay-gate.json'),{underlayPassed:true,receiptSHA256:digest(pixel)});
 for(const run of pair()){
  const bytes=JSON.stringify(run.report);await mkdir(join(root,run.label,'dist'),{recursive:true});
  await writeFile(join(root,run.label,'dist/browser-ui-smoothness-diagnostic.json'),bytes);await writeFile(join(root,run.label,'dist/build-info.json'),builds[run.variant]);
  const {report:unused,...receipt}=run;void unused;
  await save(join(root,run.label,'run-receipt.json'),{...receipt,reportSHA256:digest(bytes),buildInfoSHA256:provenance.builds[run.variant].buildInfoSHA256});
 }
 assert.equal((await summarize(root,'success','success','success','success')).status,'completed');
 await writeFile(join(root,'semantics/custom-map-engine.test.mjs'),semanticTest+'\n');
 await assert.rejects(summarize(root,'success','success','success','success'),/saved semantic tests/);
 await writeFile(join(root,'semantics/custom-map-engine.test.mjs'),semanticTest);
 const path=join(root,'A2/dist/browser-ui-smoothness-diagnostic.json');await writeFile(path,(await readFile(path,'utf8'))+'\n');
 await assert.rejects(summarize(root,'success','success','success','success'));
 const result=JSON.parse(await readFile(join(root,'paired-report.json'),'utf8'));assert.equal(result.status,'incomplete');
 assert.deepEqual(result.runs.map(run=>run.label),PAIRED_ORDER);assert.ok(result.runs[2].validationErrors.some(error=>error.includes('Saved report bytes differ')));
});
