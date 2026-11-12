import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,rm,cp,readdir} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertSmoothnessAudit} from './browser-smoothness.mjs';
import {assertBrowserEnvironment} from './browser-environment.mjs';
import {assertNativeSurfaceCoverage,nativeSurfaceIdentity} from './browser-native-surface.mjs';
import {OPAQUE_VECTOR_CASES} from './tests/fixtures/map-vector-opaque.mjs';

export const BASELINE_COMMIT='14d6d6753994af458209b19a09e32bc317b3b2fc';
export const PAIRED_ORDER=['A1','B1','A2','B2'];
export const WORKER_PATH='web/lib/custom-map-tiles.worker.ts';
const alpha='alpha:job.kind!==\'vector\'||!!job.transparent';
const outputContext="const canvas=new OffscreenCanvas(TILE_SIZE,TILE_SIZE),context=canvas.getContext('2d',{alpha:true,willReadFrequently:!!job.softwareRaster});";
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(path,value)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');};
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const buildPath=root=>join(root,'web/pages-preview/dist/build-info.json');
const reportName='browser-ui-smoothness-diagnostic.json';
const flags={diagnosticOnly:true,verified:false,releaseEligible:false};

export function assertAlphaOnlySource(baseline,candidate){
 assert.equal(baseline.split(outputContext).length,2,'The baseline output context must be unique');
 assert.equal(candidate,baseline.replace(outputContext,outputContext.replace('alpha:true',alpha)),'Only the opaque vector output alpha may differ');
}

export function assertChangedPaths(paths){
 const exact=new Set([WORKER_PATH,'web/tests/custom-map-tiles-worker.test.mjs','web/public/sw.js','.github/workflows/map-pan-diagnostics.yml',
  'tools/pages-preview/map-pan-paired-diagnostic.mjs','tools/pages-preview/tests/map-pan-paired-diagnostic.test.mjs',
  'tools/pages-preview/tests/browser-map-vector-opaque.browser.mjs','tools/pages-preview/tests/fixtures/map-vector-opaque.mjs']);
 assert.ok(paths.includes(WORKER_PATH));
 for(const path of paths)assert.ok(exact.has(path)||/^(?:web\/public|android\/app\/src\/main\/assets)\/custom-map\//.test(path),'Unexpected experiment change: '+path);
}

const tree=root=>new Map(execFileSync('git',['-C',root,'ls-tree','-rz','HEAD'],{encoding:'utf8'}).split('\0').filter(Boolean).map(line=>{const [metadata,path]=line.split('\t');return[path,metadata.split(' ').at(-1)];}));
async function verifyBuild(root,expected){
 const build=await json(buildPath(root));assert.equal(build.sourceCommit,expected);
 for(const item of build.inputs){const bytes=await readFile(join(root,item.path));assert.equal(bytes.length,item.bytes,item.path);assert.equal(hash(bytes),item.sha256,item.path);}
 return build;
}

export function assertUntracedReport(report,expected){
 assert.equal(report.sourceCommit,expected);assert.equal(report.environment.sourceCommit,expected);
 assertBrowserEnvironment(report.environment,expected);assertNativeSurfaceCoverage(report.environment.nativeSurface);
 assert.equal(report.diagnostic,'ui-smoothness');assert.equal(report.status,'completed');
 for(const [name,value]of Object.entries(flags))assert.equal(report[name],value);
 assert.deepEqual(report.profiles.map(p=>p.profile),['android-portrait','desktop-webgl']);
 for(const profile of report.profiles){
  assert.equal(profile.instrumented,false);assert.deepEqual(profile.traces,[]);assert.equal(profile.cpuSlowdownRate,1);
  assertSmoothnessAudit(profile,{name:profile.profile,engine:'tropnik-canvas',mobile:profile.profile==='android-portrait'},{release:false});
 }
 assert.deepEqual(report.performanceIssues,report.profiles.flatMap(profile=>profile.performanceIssues));
 assert.equal(report.performancePassed,report.performanceIssues.length===0);
 const match=report.environment.commandLine.match(/(?:^|\s)--user-data-dir=(\S+)/);
 assert.ok(match&&/^\/tmp\/tropnik-chrome-\d+$/.test(match[1]),'The production audit must use its fresh process-specific browser profile');
 return match[1];
}

function environmentKey(environment){
 const {profile,requestedFlags,browser,gpu,runner,nativeSurface}=environment;
 return{profile,requestedFlags,browser,gpu,runner,nativeSurface:nativeSurfaceIdentity(nativeSurface)};
}
export function assertPairedReports(runs,{candidateCommit,builds}){
 assert.deepEqual(runs.map(run=>run.label),PAIRED_ORDER,'Preserve the scheduled A/B/A/B order');
 const profiles=[];
 for(const [index,run]of runs.entries()){
  const variant=index%2?'candidate':'baseline',commit=variant==='baseline'?BASELINE_COMMIT:candidateCommit;
  assert.equal(run.variant,variant);assert.equal(run.outcome,'success');assert.deepEqual(run.validationErrors,[]);
  assert.equal(run.buildInfoSHA256,builds[variant].buildInfoSHA256,'Each audit must retain the exact preflight build');
  profiles.push(assertUntracedReport(run.report,commit));
  if(index)assert.deepEqual(environmentKey(run.report.environment),environmentKey(runs[0].report.environment),'The browser, flags, GPU, runner and native surface must match across all four audits');
 }
 assert.equal(new Set(profiles).size,4,'Every audit must launch a fresh Chrome profile');
 for(const [a,b]of [[0,2],[1,3]])assert.equal(runs[a].buildInfoSHA256,runs[b].buildInfoSHA256,'A repeated variant must retain its exact build');
 return profiles;
}

export function assertPixelParity(receipt,{candidateCommit,baselineWorkerSHA256,candidateWorkerSHA256}){
 assert.equal(receipt.schemaVersion,1);assert.equal(receipt.evidence,'production-worker-transfer-and-engine-pixel-parity');
 assert.equal(receipt.sourceCommit,candidateCommit);assert.equal(receipt.verified,true);assert.equal(receipt.parityPassed,true);
 assert.equal(receipt.diagnosticOnly,true);assert.equal(receipt.releaseEligible,false);assert.equal(receipt.phase,'complete');
 assert.equal(receipt.workerSHA256,candidateWorkerSHA256);assert.equal(receipt.baseline.sourceSHA256,baselineWorkerSHA256);
 assert.equal(receipt.baseline.kind,'same-production-worker-only-output-alpha-true');assert.equal(receipt.baseline.replacements,1);
 assert.equal(receipt.baseline.candidateExpression,alpha);assert.equal(receipt.baseline.referenceExpression,'alpha:true');
 assert.equal(receipt.expectedCases,32);assert.equal(receipt.expectedCompositeFrames,128);
 assert.deepEqual(receipt.runs.map(run=>[run.dpr,run.softwareRaster]),[[1,false],[1,true],[2,false],[2,true]]);
 let frames=0;
 const equal=diff=>{assert.equal(diff.differentPixels,0);assert.equal(diff.maxChannelDelta,0);assert.match(diff.baselinePixelSHA256,/^[a-f0-9]{64}$/);assert.equal(diff.baselinePixelSHA256,diff.candidatePixelSHA256);};
 for(const run of receipt.runs){
  assert.equal(run.verified,true);assert.deepEqual(run.cases.map(item=>item.name),OPAQUE_VECTOR_CASES.map(item=>item.name));
  assert.deepEqual(run.negativeControls.map(item=>item.name),['relief','raster','satellite-overlay','composite-witnesses']);
  for(const control of run.negativeControls.slice(0,3)){equal(control.comparison);assert.equal(control.outputContext.actual.alpha,true);assert.ok(control.forceOpaque.differentPixels>0);}
  for(const name of ['reliefDifference','maskDifference'])assert.ok(run.negativeControls[3][name].differentPixels>0);
  for(const item of run.cases){
   assert.equal(item.verified,true);assert.deepEqual(item.outputDimensions,[512,512]);assert.equal(item.contexts.baseline.actual.alpha,true);assert.equal(item.contexts.candidate.actual.alpha,false);
   equal(item.raw);assert.equal(item.raw.totalPixels,512*512);assert.deepEqual(item.frames.map(frame=>frame.name),['altai','fractional-pan','rotated-pan','enlarged']);
   for(const frame of item.frames){equal(frame.comparison);assert.equal(frame.comparison.totalPixels,512*384*run.dpr*run.dpr);frames++;}
  }
 }
 assert.equal(frames,128);
}

async function prepare(baseline,candidate,output){
 baseline=resolve(baseline);candidate=resolve(candidate);output=resolve(output);
 const baselineCommit=git(baseline,'rev-parse','HEAD'),candidateCommit=git(candidate,'rev-parse','HEAD');
 assert.equal(baselineCommit,BASELINE_COMMIT);assert.equal(candidateCommit,process.env.GITHUB_SHA);
 const a=tree(baseline),b=tree(candidate),paths=[...new Set([...a.keys(),...b.keys()])].filter(path=>a.get(path)!==b.get(path)).sort();assertChangedPaths(paths);
 const old=await readFile(join(baseline,WORKER_PATH),'utf8'),current=await readFile(join(candidate,WORKER_PATH),'utf8');assertAlphaOnlySource(old,current);
 const [oldBuild,newBuild]=await Promise.all([verifyBuild(baseline,baselineCommit),verifyBuild(candidate,candidateCommit)]);
 const manifests=await Promise.all([baseline,candidate].map(root=>json(join(root,'web/public/custom-map/manifest.json'))));
 const sourceChanges=manifests[0].sourceInputs.filter(item=>JSON.stringify(item)!==JSON.stringify(manifests[1].sourceInputs.find(other=>other.path===item.path))).map(item=>item.path);
 assert.equal(manifests[0].sourceInputs.length,manifests[1].sourceInputs.length);assert.deepEqual(sourceChanges,[WORKER_PATH]);
 const receipt={schemaVersion:1,...flags,baselineCommit,candidateCommit,order:PAIRED_ORDER,changedPaths:paths,
  baselineWorkerSHA256:hash(old),candidateWorkerSHA256:hash(current),
  builds:{baseline:{buildId:oldBuild.buildId,inputCount:oldBuild.inputs.length,sourceInputsSha256:oldBuild.customMap.sourceInputsSha256,buildInfoSHA256:hash(await readFile(buildPath(baseline)))},candidate:{buildId:newBuild.buildId,inputCount:newBuild.inputs.length,sourceInputsSha256:newBuild.customMap.sourceInputsSha256,buildInfoSHA256:hash(await readFile(buildPath(candidate)))}}};
 for(const [name,root,worker]of [['baseline',baseline,old],['candidate',candidate,current]]){
  await mkdir(join(output,'sources',name),{recursive:true});await cp(buildPath(root),join(output,'sources',name,'build-info.json'));
  await cp(join(root,'web/public/custom-map/manifest.json'),join(output,'sources',name,'runtime-manifest.json'));
  await writeFile(join(output,'sources',name,'custom-map-tiles.worker.ts'),worker);
 }
 await save(join(output,'provenance.json'),receipt);return receipt;
}

async function parity(candidate,output){
 candidate=resolve(candidate);output=resolve(output);const provenance=await json(join(output,'provenance.json'));
 const input=join(candidate,'web/pages-preview/dist/browser-vector-alpha-verification.json'),receipt=await json(input);
 const destination=join(output,'parity');await mkdir(destination,{recursive:true});await cp(input,join(destination,'browser-vector-alpha-verification.json'));
 await cp(join(candidate,'web/pages-preview/design-qa/vector-alpha'),join(destination,'captures'),{recursive:true});
 assertPixelParity(receipt,provenance);
 for(const [path,digest]of Object.entries(receipt.sources))assert.equal(hash(await readFile(join(candidate,path))),digest,path);
 for(const capture of receipt.runs.flatMap(run=>run.cases).flatMap(item=>item.captures)){
  assert.match(capture.file,/^[\w.-]+\.png$/);const bytes=await readFile(join(destination,'captures',capture.file));assert.equal(bytes.length,capture.bytes);assert.equal(hash(bytes),capture.sha256);
 }
 await save(join(output,'parity-gate.json'),{...flags,parityPassed:true,receiptSHA256:hash(await readFile(input)),cases:32,frames:128});
}

async function reset(root,output,label,variant,commit){
 root=resolve(root);output=resolve(output);assert.ok(PAIRED_ORDER.includes(label));assert.equal(variant,label[0]==='A'?'baseline':'candidate');assert.equal(git(root,'rev-parse','HEAD'),commit);
 const dist=join(root,'web/pages-preview/dist');
 await rm(join(root,'web/pages-preview/design-qa'),{recursive:true,force:true});
 for(const file of [reportName,'browser-network.json','browser-failure.json','browser-failure.png'])await rm(join(dist,file),{force:true});
 await mkdir(output,{recursive:true});await save(join(output,'start.json'),{...flags,label,variant,expectedSourceCommit:commit,startedAt:new Date().toISOString(),buildInfoSHA256:hash(await readFile(buildPath(root)))});
}

export async function capture(root,output,outcome){
 root=resolve(root);output=resolve(output);const label=basename(output),variant=label[0]==='A'?'baseline':'candidate',dist=join(root,'web/pages-preview/dist');
 assert.ok(PAIRED_ORDER.includes(label));
 const receipt={...flags,label,variant,outcome,validationErrors:[]};let start;
 try{start=await json(join(output,'start.json'));Object.assign(receipt,{expectedSourceCommit:start.expectedSourceCommit,startedAt:start.startedAt,buildInfoSHA256:start.buildInfoSHA256});assert.equal(start.label,label);assert.equal(start.variant,variant);}catch(error){receipt.validationErrors.push('Reset receipt: '+error.message);}
 await mkdir(join(output,'dist'),{recursive:true});
 try{for(const name of await readdir(dist))if(name==='build-info.json'||name===reportName||name==='browser-network.json'||name.startsWith('browser-failure.'))await cp(join(dist,name),join(output,'dist',name));}catch(error){receipt.validationErrors.push('Evidence copy: '+error.message);}
 try{await cp(join(root,'web/pages-preview/design-qa'),join(output,'design-qa'),{recursive:true});}catch(error){if(error.code!=='ENOENT')receipt.validationErrors.push('Design evidence copy: '+error.message);}
 try{
  assert.equal(outcome,'success');assert.ok(start,'The reset receipt is missing');assert.equal(hash(await readFile(buildPath(root))),start.buildInfoSHA256);
  const report=await json(join(output,'dist',reportName));receipt.userDataDir=assertUntracedReport(report,start.expectedSourceCommit);
  assert.ok(Date.parse(report.updatedAt)>=Date.parse(start.startedAt),'The result predates this audit');
  receipt.reportSHA256=hash(await readFile(join(output,'dist',reportName)));
 }catch(error){receipt.validationErrors.push(error.message);}
 await save(join(output,'run-receipt.json'),receipt);return receipt;
}

function describePan(profile){
 try{
 assert.ok(Array.isArray(profile?.pan?.events)&&Array.isArray(profile?.scenarios),'Missing pan/events/scenarios');
 const window=profile.scenarios.find(window=>window.name==='map-pan'),down=profile.pan.events.find(event=>event.type==='pointerdown'),up=profile.pan.events.find(event=>event.type==='pointerup');
 assert.ok(Array.isArray(window?.raw?.frames)&&Number.isFinite(down?.time)&&Number.isFinite(up?.time),'Missing raw frames or delivered pointer pair');
 const gaps=window.raw.frames.slice(1).map((time,index)=>({from:window.raw.frames[index],to:time,gapMs:time-window.raw.frames[index]})).filter(gap=>gap.from>=down.time&&gap.to<=up.time);
 return{profile:profile.profile,officialFrames:window.frames,windowDurationMs:window.raw.endedAt-window.raw.startedAt,panDurationMs:profile.pan.durationMs,
  deliveredInputWindow:{fromMs:down.time,toMs:up.time,callbackGapsMs:gaps.map(gap=>gap.gapMs),notASeparateAcceptanceGate:true},
  nativeCommands:profile.pan.commands,rawWindow:window.raw};
 }catch(error){return{profile:profile?.profile??null,incomplete:true,diagnosticError:error.message};}
}
export async function summarize(output,...outcomes){
 output=resolve(output);const provenance=await json(join(output,'provenance.json')),runs=[],errors=[];
 assert.equal(outcomes.length,4,'Every scheduled workflow outcome must be supplied');
 for(const [index,label]of PAIRED_ORDER.entries()){
  const variant=label[0]==='A'?'baseline':'candidate',run={label,variant,outcome:outcomes[index],report:null,validationErrors:[]};runs.push(run);
  try{
   const receipt=await json(join(output,label,'run-receipt.json'));assert.equal(receipt.label,label);assert.equal(receipt.variant,variant);assert.equal(receipt.outcome,run.outcome);
   assert.ok(Array.isArray(receipt.validationErrors));Object.assign(run,receipt);
  }catch(error){run.validationErrors.push('Run receipt: '+error.message);}
  try{
   const bytes=await readFile(join(output,label,'dist',reportName));run.report=JSON.parse(bytes);assert.equal(hash(bytes),run.reportSHA256,'Saved report bytes differ from the captured receipt');
   const build=await readFile(join(output,label,'dist/build-info.json'));assert.equal(hash(build),run.buildInfoSHA256,'Saved build bytes differ from the reset receipt');
   assert.equal(hash(build),provenance.builds[variant].buildInfoSHA256,'Saved build bytes differ from source preflight');
   assert.equal(JSON.parse(build).sourceCommit,variant==='baseline'?BASELINE_COMMIT:provenance.candidateCommit);
  }catch(error){run.validationErrors.push('Saved evidence: '+error.message);}
  for(const error of run.validationErrors)errors.push(label+': '+error);
 }
 try{
  assert.equal(errors.length,0);const gate=await json(join(output,'parity-gate.json'));assert.equal(gate.parityPassed,true);
  const receiptPath=join(output,'parity/browser-vector-alpha-verification.json');assert.equal(hash(await readFile(receiptPath)),gate.receiptSHA256);assertPixelParity(await json(receiptPath),provenance);
  assertPairedReports(runs,provenance);
 }catch(error){errors.push(error.message);}
 const report={schemaVersion:1,...flags,physicalDevice:false,sourceCommit:provenance.candidateCommit,baselineCommit:provenance.baselineCommit,order:PAIRED_ORDER,status:errors.length?'incomplete':'completed',errors,
  runs:runs.map(run=>({label:run.label,variant:run.variant,outcome:run.outcome,validationErrors:run.validationErrors,sourceCommit:run.report?.sourceCommit??null,buildInfoSHA256:run.buildInfoSHA256??null,reportSHA256:run.reportSHA256??null,userDataDir:run.userDataDir??null,performanceIssues:run.report?.performanceIssues??null,pan:Array.isArray(run.report?.profiles)?run.report.profiles.map(describePan):[]})),
  limitations:['A diagnostic comparison does not certify a release or physical-device FPS.','Official P95 uses its unchanged full measurement window. The separate delivered-input samples preserve the gesture timing when settle tails differ.','All four scheduled outcomes are retained; no best-run selection or retry is performed.']};
 await save(join(output,'paired-report.json'),report);if(errors.length)throw new Error(errors.join('\n'));return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,...args]=process.argv.slice(2),commands={prepare,parity,reset,capture,summarize};assert.ok(commands[command],'Unknown paired diagnostic operation');
 const result=await commands[command](...args);if(result)console.log(JSON.stringify({operation:command,...flags,status:result.status??'recorded'},null,2));
}
