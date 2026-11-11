import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_ENVIRONMENT_FLAGS,BROWSER_ENVIRONMENT_LIMITS,browserEnvironmentArgs,collectBrowserEnvironment,assertBrowserEnvironment,assertMatchingBrowserEnvironments} from '../browser-environment.mjs';
import {assertTerrainMaskReport} from '../terrain-mask-report.mjs';
import {browserEnvironmentFixture,terrainMaskReportFixture} from './browser-environment-fixture.mjs';

const commit='a'.repeat(40),browserURL='ws://127.0.0.1:9222/devtools/browser/test-browser';
function transport({missing,fail,oversized=false,disconnect=false,mutate=()=>{}}={}){
 const instances=[],calls=[],fixture=browserEnvironmentFixture(commit);
 const info={commandLine:fixture.commandLine,gpu:{...fixture.gpu,auxAttributes:{...fixture.gpu.auxAttributes,initializationTime:3,processCrashCount:0},videoEncoding:[]}};mutate(info);
 class Socket extends EventTarget{
  constructor(url){super();this.url=url;this.closed=false;instances.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(text){
   const {id,method}=JSON.parse(text);calls.push(method);
   if(disconnect){queueMicrotask(()=>this.close());return;}if(method===missing)return;
   const message=oversized?'x'.repeat(BROWSER_ENVIRONMENT_LIMITS.messageBytes+1):JSON.stringify(method===fail?{id,error:{message:'fixture CDP failure'}}:{id,result:method==='Browser.getVersion'?fixture.browser:info});
   queueMicrotask(()=>{if(!this.closed)this.dispatchEvent(new MessageEvent('message',{data:message}));});
  }
  close(){if(this.closed)return;this.closed=true;this.dispatchEvent(new Event('close'));}
 }
 return{WebSocketClass:Socket,runner:fixture.runner,instances,calls};
}

test('one fixed profile retains WebGL and offers no fallback or profile override',()=>{
 const args=browserEnvironmentArgs({debugPort:12345,userDataDir:'/tmp/test-browser'});
 assert.deepEqual(args.slice(0,-3),BROWSER_ENVIRONMENT_FLAGS);
 assert.ok(args.includes('--use-angle=swiftshader-webgl'));assert.ok(!args.includes('--use-angle=swiftshader'));assert.ok(!args.includes('--disable-gpu'));
 assert.ok(args.includes('--window-size=1920,1920'));assert.ok(args.includes('--ozone-override-screen-size=1920,1920'));
 args[0]='changed';assert.equal(browserEnvironmentArgs({debugPort:12345,userDataDir:'/tmp/test-browser'})[0],'--headless=new');
 assert.throws(()=>browserEnvironmentArgs({debugPort:0,userDataDir:'/tmp/test-browser'}));
});
test('receipt uses both real CDP responses and captures stable runner data before measurement',async()=>{
 const connection=transport(),receipt=await collectBrowserEnvironment(browserURL,{...connection,sourceCommit:commit});
 assert.deepEqual(connection.calls,['Browser.getVersion','SystemInfo.getInfo']);assert.equal(connection.instances.length,1);assert.equal(connection.instances[0].closed,true);
 assert.equal(receipt.commandLine,browserEnvironmentFixture().commandLine);assert.equal(receipt.browser.revision,'@'+'b'.repeat(40));
 assert.equal(receipt.gpu.auxAttributes.initializationTime,undefined);assert.equal(receipt.gpu.auxAttributes.processCrashCount,undefined);
 assert.equal(receipt.runner.cpu.models[0],'Unit test CPU');assert.equal(assertBrowserEnvironment(receipt,commit),receipt);
});
for(const [name,options,expected]of [
 ['missing SystemInfo',{missing:'SystemInfo.getInfo'},/Timed out/],
 ['CDP failure',{fail:'SystemInfo.getInfo'},/fixture CDP failure/],
 ['oversized reply',{oversized:true},/Oversized/],
 ['closed browser target',{disconnect:true},/closed before/],
 ['full GPU observation',{mutate:info=>{info.gpu.featureStatus={...info.gpu.featureStatus,gpu_compositing:'enabled'};}},/Full GPU/],
])test(`${name} fails boundedly and closes its sole connection without fallback`,async()=>{
 const connection=transport(options);
 await assert.rejects(collectBrowserEnvironment(browserURL,{...connection,sourceCommit:commit,timeoutMs:20}),expected);
 assert.equal(connection.instances.length,1);assert.equal(connection.instances[0].closed,true);
});
test('actual flags and GPU state cannot be replaced by a requested software-profile label',()=>{
 const changes=[
  value=>delete value.commandLine,
  value=>value.commandLine=value.commandLine.replace('--use-angle=swiftshader-webgl','--use-angle=swiftshader'),
  value=>value.commandLine+=' --use-angle=swiftshader',
  value=>value.commandLine+=' --disable-gpu',
  value=>value.commandLine+=' --disable-webgl2',
  value=>value.commandLine=value.commandLine.replace('--window-size=1920,1920','--window-size=800,600'),
  value=>value.commandLine=value.commandLine.replace('--ozone-override-screen-size=1920,1920','--ozone-override-screen-size=800,600'),
  value=>value.gpu.featureStatus.gpu_compositing='enabled',
  value=>value.gpu.auxAttributes.skiaBackendType='GaneshGL',
  value=>value.gpu.auxAttributes.glRenderer='hardware renderer',
  value=>delete value.browser.revision,
  value=>value.collection='during-measurement',
  value=>value.sourceCommit='b'.repeat(40),
 ];
 for(const change of changes){const bad=browserEnvironmentFixture();change(bad);assert.throws(()=>assertBrowserEnvironment(bad,commit));}
});
test('mask and full audit match stable observations while independent process identity may differ',()=>{
 const first=browserEnvironmentFixture(),second=browserEnvironmentFixture();
 second.commandLine=second.commandLine.replace('9222','12345').replace('/tmp/fixture','/tmp/other-browser');second.capturedAt='2026-11-11T14:05:00.000Z';
 assert.equal(assertMatchingBrowserEnvironments(second,first,commit),second);
 for(const change of [value=>value.browser.revision='another-revision',value=>value.runner.cpu.models=['another CPU'],value=>value.gpu.devices[0].driverVersion='another-driver',value=>value.profile='another-profile']){
  const bad=structuredClone(second);change(bad);assert.throws(()=>assertMatchingBrowserEnvironments(bad,first,commit));
 }
});
test('four pixel cases require genuine WebGL capture and restored WebGL pixels in the same environment',()=>{
 const options={sourceCommit:commit,environment:browserEnvironmentFixture(),rendererSHA256:'c'.repeat(64)},good=terrainMaskReportFixture();
 assert.equal(assertTerrainMaskReport(good,options),good);
 for(const change of [
  value=>value.evidence='synthetic-pixels',value=>delete value.environment,value=>value.environment.browser.revision='another-revision',
  value=>value.rendererSHA256='e'.repeat(64),value=>value.cases.pop(),value=>value.cases[1].name=value.cases[0].name,
  value=>value.cases[0].renderer='canvas2d',value=>value.cases[0].frames[0].renderer='canvas2d',
  value=>value.cases[1].recovery.trusted=false,value=>value.cases[1].recovery.restored=0,value=>value.cases[1].frames.pop(),
  value=>value.cases[0].callerMaskMutationChecked=false,value=>value.cases[0].metrics.terrainLeaks=1,
  value=>delete value.cases[0].metrics.insideVisibleRatio,value=>value.cases[0].metrics.routeCorePixels=0,
 ]){const bad=terrainMaskReportFixture();change(bad);assert.throws(()=>assertTerrainMaskReport(bad,options));}
});
