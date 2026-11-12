import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,rm,cp,readdir} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {assertSmoothnessAudit} from './browser-smoothness.mjs';
import {assertBrowserEnvironment} from './browser-environment.mjs';
import {assertNativeSurfaceCoverage,nativeSurfaceIdentity} from './browser-native-surface.mjs';

export const BASELINE_COMMIT='14d6d6753994af458209b19a09e32bc317b3b2fc';
export const PAIRED_ORDER=['A1','B1','A2','B2'];
export const ENGINE_PATH='web/lib/custom-map-engine.ts';
export const ORACLE_PATH='web/tests/fixtures/custom-map-labels-9110c5b.txt';
export const ORACLE_SHA256='39a5b7a5ca753f6ca893764b8ee7f7a3fd3acd87686d944f5ca7da5cab7ed8c9';
const ENGINE_TEST_PATH='web/tests/custom-map-engine.test.mjs';
const ts=createRequire(new URL('../../web/package.json',import.meta.url))('typescript');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(path,value)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');};
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const buildPath=root=>join(root,'web/pages-preview/dist/build-info.json');
const reportName='browser-ui-smoothness-diagnostic.json';
const flags={diagnosticOnly:true,verified:false,releaseEligible:false};

function engineShape(source,memo){
 const file=ts.createSourceFile(ENGINE_PATH,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 assert.deepEqual(file.parseDiagnostics,[],'Engine source must parse');let classes=0,addedType=0,addedField=0,addedMethod=0,cleanup=0,drawLabels;
 const shape=file.statements.flatMap(statement=>{
  if(ts.isTypeAliasDeclaration(statement)&&statement.name.text==='LabelCandidate'){assert.ok(memo);addedType++;return[];}
  if(!ts.isClassDeclaration(statement)||statement.name?.text!=='CustomMapEngine')return[statement.getText(file)];
  classes++;const members=statement.members.flatMap(member=>{
   const name=member.name?.getText(file);
   if(name==='labelCandidateCache'||name==='prepareLabelCandidates'){
    assert.ok(memo);assert.ok(member.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.PrivateKeyword));
    if(name==='labelCandidateCache'){assert.ok(ts.isPropertyDeclaration(member)&&!member.initializer);addedField++;}
    else{assert.ok(ts.isMethodDeclaration(member)&&member.body);addedMethod++;}
    return[];
   }
   if(name==='drawLabels'){
    assert.ok(ts.isMethodDeclaration(member)&&member.body);drawLabels=member.getText(file);
    return[{method:source.slice(member.getStart(file),member.body.pos),body:'label-memo-body'}];
   }
   if(name==='destroy'){
    assert.ok(ts.isMethodDeclaration(member)&&member.body);
    return[{method:source.slice(member.getStart(file),member.body.pos),statements:member.body.statements.flatMap(value=>{
     if(value.getText(file).replace(/\s+/g,'')==='this.labelCandidateCache=undefined;'){assert.ok(memo);cleanup++;return[];}
     return[value.getText(file)];
    })}];
   }
   return[member.getText(file)];
  });
  return[{header:source.slice(statement.getStart(file),statement.members.pos),members}];
 });
 assert.equal(classes,1);assert.ok(drawLabels);assert.deepEqual([addedType,addedField,addedMethod,cleanup],memo?[1,1,1,1]:[0,0,0,0]);
 return{shape,drawLabels};
}

export function assertLabelMemoOnlySource(baseline,candidate,oracle){
 assert.equal(hash(oracle),ORACLE_SHA256,'The original drawLabels oracle must retain its pinned bytes');
 const old=engineShape(baseline,false),current=engineShape(candidate,true);
 assert.equal(old.drawLabels,oracle.trim(),'The pinned oracle must be the exact immutable baseline method');
 assert.notEqual(current.drawLabels,old.drawLabels);assert.deepEqual(current.shape,old.shape,'Only label metadata preparation, its cache and cleanup may change; raster, camera, input and loading must stay exact');
}

export function assertChangedPaths(paths){
 const exact=new Set([ENGINE_PATH,ENGINE_TEST_PATH,ORACLE_PATH,'web/public/sw.js','.github/workflows/map-pan-diagnostics.yml',
  'tools/pages-preview/map-pan-paired-diagnostic.mjs','tools/pages-preview/tests/map-pan-paired-diagnostic.test.mjs']);
 assert.ok(paths.includes(ENGINE_PATH));
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

export const UNDERLAY_COVERS=Object.freeze({opaque:[true],'fractional-zoom':[true],'pan-sequence':[true,true,true,false,true],missing:[false],transparent:[false],rotated:[false],pitched:[false],satellite:[false],overview:[false],zoom12:[true,true,true,false,true],zoom13:[false],zoom18:[false],'tiny-tile':[false],'unwrapped-world':[true],'boundaries-hidden':[true]});
export function assertUnderlayReceipt(receipt,{candidateCommit,candidateEngineSHA256}){
 assert.equal(receipt.schemaVersion,1);assert.equal(receipt.evidence,'production-canvas-underlay-pixel-parity');
 assert.equal(receipt.baseline,'same-production-draw-with-fixture-only-coverage-false');assert.equal(receipt.verified,true);assert.equal(receipt.phase,'complete');
 assert.equal(receipt.sourceCommit,candidateCommit);assert.equal(receipt.rendererSHA256,candidateEngineSHA256);assert.equal(receipt.sources[ENGINE_PATH],candidateEngineSHA256);
 assertBrowserEnvironment(receipt.environment,candidateCommit);assertNativeSurfaceCoverage(receipt.environment.nativeSurface);
 assert.deepEqual(receipt.cases.map(item=>item.dpr+'/'+item.name).sort(),[1,2].flatMap(dpr=>Object.keys(UNDERLAY_COVERS).map(name=>dpr+'/'+name)).sort());
 let frames=0;
 for(const item of receipt.cases){
  assert.equal(item.verified,true);assert.equal(item.contextAttributes.alpha,false);assert.equal(item.contextAttributes.willReadFrequently,item.policy.softwareRaster);assert.deepEqual(item.bitmapDimensions,[512,512]);
  assert.equal(item.priorFrame.kind,'distinct-opaque-checkerboards');assert.equal(item.priorFrame.comparison.differentPixels,512*384*item.dpr*item.dpr);assert.equal(item.priorFrame.comparison.totalPixels,512*384*item.dpr*item.dpr);
  assert.ok(item.priorFrame.comparison.maxChannelDelta>0&&item.priorFrame.comparison.maxChannelDelta<=255);assert.match(item.priorFrame.baselinePixelSHA256,/^[a-f0-9]{64}$/);assert.match(item.priorFrame.optimizedPixelSHA256,/^[a-f0-9]{64}$/);assert.notEqual(item.priorFrame.baselinePixelSHA256,item.priorFrame.optimizedPixelSHA256);
  assert.deepEqual(item.frames.map(frame=>frame.actualCoverage),UNDERLAY_COVERS[item.name]);assert.deepEqual(item.frames.map(frame=>frame.expectedCoverage),UNDERLAY_COVERS[item.name]);
  if(item.name==='tiny-tile')assert.ok(item.tileDeviceSpan<=1);
  assert.deepEqual(item.negativeControls.map(control=>control.name),item.name==='opaque'?['remove-route','remove-selectedBoundary','remove-mask']:['missing','transparent'].includes(item.name)?['force-unsafe-cover']:[]);
  for(const control of item.negativeControls)assert.ok(control.differentPixels>0);
  for(const frame of item.frames){
   frames++;assert.deepEqual([frame.width,frame.height],[512*item.dpr,384*item.dpr]);assert.deepEqual(frame.comparison,{differentPixels:0,maxChannelDelta:0,totalPixels:frame.width*frame.height});assert.match(frame.baselinePixelSHA256,/^[a-f0-9]{64}$/);assert.equal(frame.optimizedPixelSHA256,frame.baselinePixelSHA256);
   const {baseline,optimized}=frame.operations;
   assert.equal(baseline.area,1);assert.ok(baseline.overview>0);assert.equal(optimized.area,frame.actualCoverage?0:1);assert.equal(optimized.overview,frame.actualCoverage?0:baseline.overview);
   for(const key of ['mask','selectedArea','detail','relief','imagery'])assert.equal(optimized[key],baseline[key]);
   assert.equal(baseline.clear,1);assert.equal(optimized.clear,frame.actualCoverage?0:1);assert.equal(optimized.mask,1);assert.equal(optimized.proofCalls,1);
   if(frame.actualCoverage)assert.ok(item.tileDeviceSpan>1);
   assert.deepEqual(frame.captures.map(capture=>capture.phase),['baseline','optimized']);
  }
 }
 assert.equal(frames,46);
}

async function prepare(baseline,candidate,output){
 baseline=resolve(baseline);candidate=resolve(candidate);output=resolve(output);
 const baselineCommit=git(baseline,'rev-parse','HEAD'),candidateCommit=git(candidate,'rev-parse','HEAD');
 assert.equal(baselineCommit,BASELINE_COMMIT);assert.equal(candidateCommit,process.env.GITHUB_SHA);
 assert.equal(process.env.MAP_PAN_SEMANTICS_OUTCOME,'success','The immutable label oracle and dynamic label regressions must pass before timing');
 const a=tree(baseline),b=tree(candidate),paths=[...new Set([...a.keys(),...b.keys()])].filter(path=>a.get(path)!==b.get(path)).sort();assertChangedPaths(paths);
 const old=await readFile(join(baseline,ENGINE_PATH),'utf8'),current=await readFile(join(candidate,ENGINE_PATH),'utf8'),oracle=await readFile(join(candidate,ORACLE_PATH),'utf8');assertLabelMemoOnlySource(old,current,oracle);
 const [oldBuild,newBuild]=await Promise.all([verifyBuild(baseline,baselineCommit),verifyBuild(candidate,candidateCommit)]);
 const manifests=await Promise.all([baseline,candidate].map(root=>json(join(root,'web/public/custom-map/manifest.json'))));
 const sourceChanges=manifests[0].sourceInputs.filter(item=>JSON.stringify(item)!==JSON.stringify(manifests[1].sourceInputs.find(other=>other.path===item.path))).map(item=>item.path);
 assert.equal(manifests[0].sourceInputs.length,manifests[1].sourceInputs.length);assert.deepEqual(sourceChanges,[ENGINE_PATH]);
 const receipt={schemaVersion:1,...flags,baselineCommit,candidateCommit,order:PAIRED_ORDER,changedPaths:paths,
  baselineEngineSHA256:hash(old),candidateEngineSHA256:hash(current),
  semanticProof:{outcome:'success',oraclePath:ORACLE_PATH,oracleSHA256:hash(oracle),baselineMethodSHA256:ORACLE_SHA256,testPath:ENGINE_TEST_PATH,testSHA256:hash(await readFile(join(candidate,ENGINE_TEST_PATH)))},
  builds:{baseline:{buildId:oldBuild.buildId,inputCount:oldBuild.inputs.length,sourceInputsSha256:oldBuild.customMap.sourceInputsSha256,buildInfoSHA256:hash(await readFile(buildPath(baseline)))},candidate:{buildId:newBuild.buildId,inputCount:newBuild.inputs.length,sourceInputsSha256:newBuild.customMap.sourceInputsSha256,buildInfoSHA256:hash(await readFile(buildPath(candidate)))}}};
 for(const [name,root,engine]of [['baseline',baseline,old],['candidate',candidate,current]]){
  await mkdir(join(output,'sources',name),{recursive:true});await cp(buildPath(root),join(output,'sources',name,'build-info.json'));
  await cp(join(root,'web/public/custom-map/manifest.json'),join(output,'sources',name,'runtime-manifest.json'));
  await writeFile(join(output,'sources',name,'custom-map-engine.ts'),engine);
 }
 await mkdir(join(output,'semantics'),{recursive:true});await writeFile(join(output,'semantics','drawLabels-baseline.txt'),oracle);await cp(join(candidate,ENGINE_TEST_PATH),join(output,'semantics','custom-map-engine.test.mjs'));
 await save(join(output,'provenance.json'),receipt);return receipt;
}

async function underlay(candidate,output){
 candidate=resolve(candidate);output=resolve(output);const provenance=await json(join(output,'provenance.json'));
 const input=join(candidate,'web/pages-preview/dist/browser-map-underlay-verification.json'),receipt=await json(input);
 const destination=join(output,'underlay');await mkdir(destination,{recursive:true});await cp(input,join(destination,'browser-map-underlay-verification.json'));
 await cp(join(candidate,'web/pages-preview/design-qa/map-underlay'),join(destination,'captures'),{recursive:true});
 assertUnderlayReceipt(receipt,provenance);
 for(const [path,digest]of Object.entries(receipt.sources)){assert.match(path,/^web\/(?:[\w.-]+\/)*[\w.-]+$/);assert.equal(hash(await readFile(join(candidate,path))),digest,path);}
 for(const frame of receipt.cases.flatMap(item=>item.frames))for(const capture of frame.captures){
  assert.match(capture.file,/^[\w.-]+\.png$/);const bytes=await readFile(join(destination,'captures',capture.file));assert.equal(bytes.length,capture.bytes);assert.equal(hash(bytes),capture.sha256);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[frame.width,frame.height]);
 }
 await save(join(output,'underlay-gate.json'),{...flags,underlayPassed:true,receiptSHA256:hash(await readFile(input)),cases:30,frames:46});
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
  assert.equal(errors.length,0);
  assert.equal(provenance.semanticProof.outcome,'success');assert.equal(provenance.semanticProof.oraclePath,ORACLE_PATH);assert.equal(provenance.semanticProof.testPath,ENGINE_TEST_PATH);
  assert.equal(provenance.semanticProof.oracleSHA256,ORACLE_SHA256);assert.equal(provenance.semanticProof.baselineMethodSHA256,ORACLE_SHA256);
  assert.equal(hash(await readFile(join(output,'semantics/drawLabels-baseline.txt'))),ORACLE_SHA256,'The saved semantic oracle differs from the immutable baseline');
  assert.equal(hash(await readFile(join(output,'semantics/custom-map-engine.test.mjs'))),provenance.semanticProof.testSHA256,'The saved semantic tests differ from source preflight');
  const gate=await json(join(output,'underlay-gate.json'));assert.equal(gate.underlayPassed,true);
  const receiptPath=join(output,'underlay/browser-map-underlay-verification.json');assert.equal(hash(await readFile(receiptPath)),gate.receiptSHA256);const underlayReceipt=await json(receiptPath);assertUnderlayReceipt(underlayReceipt,provenance);
  assertPairedReports(runs,provenance);
  assert.deepEqual(environmentKey(underlayReceipt.environment),environmentKey(runs[1].report.environment),'The underlay proof must use the same browser, GPU, runner and native surface as timing');
 }catch(error){errors.push(error.message);}
 const report={schemaVersion:1,...flags,physicalDevice:false,sourceCommit:provenance.candidateCommit,baselineCommit:provenance.baselineCommit,order:PAIRED_ORDER,status:errors.length?'incomplete':'completed',errors,
  runs:runs.map(run=>({label:run.label,variant:run.variant,outcome:run.outcome,validationErrors:run.validationErrors,sourceCommit:run.report?.sourceCommit??null,buildInfoSHA256:run.buildInfoSHA256??null,reportSHA256:run.reportSHA256??null,userDataDir:run.userDataDir??null,performanceIssues:run.report?.performanceIssues??null,pan:Array.isArray(run.report?.profiles)?run.report.profiles.map(describePan):[]})),
  limitations:['A diagnostic comparison does not certify a release or physical-device FPS.','The label oracle proves the bounded command/diagnostic cases; the full coast and label browser audits remain mandatory downstream release gates.','Official P95 uses its unchanged full measurement window. Press-to-release samples still include the unchanged hold and must not be treated as continuous movement.','All four scheduled outcomes are retained; no best-run selection or retry is performed.']};
 await save(join(output,'paired-report.json'),report);if(errors.length)throw new Error(errors.join('\n'));return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,...args]=process.argv.slice(2),commands={prepare,underlay,reset,capture,summarize};assert.ok(commands[command],'Unknown paired diagnostic operation');
 const result=await commands[command](...args);if(result)console.log(JSON.stringify({operation:command,...flags,status:result.status??'recorded'},null,2));
}
