import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {launchBrowser,browserErrorDetails,BROWSER_STARTUP_LIMITS} from '../browser-startup.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function controlledTime(){
 let now=0,next=0;const pending=new Map(),delays=[];
 return{pending,delays,clock:()=>now,
  schedule(fn,ms){const id=++next;pending.set(id,{fn,at:now+ms});delays.push(ms);return id;},
  cancel:id=>pending.delete(id),
  advance(){assert.ok(pending.size,'Expected a bounded pending timer');const [id,timer]=[...pending].sort((a,b)=>a[1].at-b[1].at)[0];pending.delete(id);now=timer.at;timer.fn();},
 };
}
async function drive(promise,time){
 let done=false,result,failure;promise.then(value=>{done=true;result=value;},error=>{done=true;failure=error;});
 for(let count=0;!done&&count<1000;count++){await flush();if(!done)time.advance();}
 assert.equal(done,true,'The operation must finish under its own bounds');if(failure)throw failure;return result;
}
function processStub(){
 const child=new EventEmitter();child.pid=12345;child.exitCode=null;child.signalCode=null;child.unreferenced=false;
 child.stderr=new EventEmitter();child.stderr.destroy=()=>{child.stderr.destroyed=true;};
 child.unref=()=>{child.unreferenced=true;};child.kill=()=>assert.fail('POSIX cleanup must include the owned process group');
 child.finish=(code,signal)=>{child.exitCode=code;child.signalCode=signal;child.emit('exit',code,signal);};
 return child;
}
const ready=()=>({ok:true,json:async()=>({Browser:'Chrome/test','Protocol-Version':'1.3',webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/browser/test'})});

test('one healthy process may become ready after eight seconds without relaunching or changing input budgets',async()=>{
 const time=controlledTime(),child=processStub();let spawns=0,probes=0;
 const browser=launchBrowser('test-chrome',['--headless=new'],{...time,platform:'linux',
  spawn(binary,args,options){spawns++;assert.equal(binary,'test-chrome');assert.deepEqual(args,['--headless=new']);assert.equal(options.detached,true);return child;},
  fetch:async(_url,{signal})=>{probes++;assert.equal(signal.aborted,false);if(time.clock()<9000)throw new Error('ECONNREFUSED');return ready();},
 });
 const version=await drive(browser.waitUntilReady('http://127.0.0.1:9222/json/version'),time);
 assert.equal(version.Browser,'Chrome/test');assert.equal(spawns,1);assert.ok(probes>80);
 const diagnostics=browser.diagnostics();assert.equal(diagnostics.status,'ready');assert.equal(diagnostics.readyAfterMs,9000);assert.equal(diagnostics.binary,'test-chrome');
 assert.equal(BROWSER_STARTUP_LIMITS.readyMs,60000);assert.equal(BROWSER_STARTUP_LIMITS.probeMs,1000);
 assert.ok(time.delays.every(ms=>ms<=1000));assert.equal(time.pending.size,0);
});

test('a single blank browser may finish cold process startup after the old thirty-second cutoff',async()=>{
 const time=controlledTime(),child=processStub();let spawns=0,probes=0;
 const endpoint='http://127.0.0.1:9222/json/version';
 const browser=launchBrowser('test-chrome',['--headless=new','about:blank'],{...time,platform:'linux',
  spawn(_binary,args){spawns++;assert.deepEqual(args,['--headless=new','about:blank']);return child;},
  fetch:async(url,{signal})=>{probes++;assert.equal(url,endpoint,'Startup only polls CDP health; it never loads the app');assert.equal(signal.aborted,false);if(time.clock()<45000)throw new Error('ECONNREFUSED');return ready();},
 });
 const waiting=browser.waitUntilReady(endpoint);assert.equal(browser.waitUntilReady(endpoint),waiting);
 const version=await drive(waiting,time);
 assert.equal(version.Browser,'Chrome/test');assert.equal(spawns,1);assert.equal(probes,451);
 const diagnostics=browser.diagnostics();assert.equal(diagnostics.status,'ready');assert.equal(diagnostics.readyAfterMs,45000);
 assert.ok(diagnostics.readyAfterMs>30000&&diagnostics.readyAfterMs<diagnostics.limits.readyMs);
 assert.equal(diagnostics.limits.readyMs,60000);assert.equal(diagnostics.limits.probeMs,1000);assert.equal(diagnostics.limits.pollMs,100);
 assert.ok(time.delays.every(ms=>ms<=1000));assert.equal(time.pending.size,0);
});

test('a hanging health response body is aborted per probe and cannot exceed the single readiness deadline',async()=>{
 const time=controlledTime(),child=processStub(),signals=[];let spawns=0;
 const browser=launchBrowser('test-chrome',[],{...time,platform:'linux',spawn:()=>{spawns++;return child;},fetch:async(_url,{signal})=>{signals.push(signal);return{ok:true,json:()=>new Promise(()=>{})};}});
 const failure=await drive(browser.waitUntilReady('http://127.0.0.1:9222/json/version').then(()=>assert.fail('Must time out'),error=>error),time);
 assert.match(failure.message,/readiness deadline exceeded 60000 ms/);assert.equal(spawns,1);assert.ok(signals.length>1);
 assert.ok(signals.every(signal=>signal.aborted));assert.ok(time.delays.every(ms=>ms<=1000));assert.equal(time.clock(),60000);assert.equal(time.pending.size,0);
 const diagnostics=browser.diagnostics();assert.equal(diagnostics.status,'failed');assert.equal(diagnostics.elapsedMs,60000);assert.equal(diagnostics.exitCode,null);assert.equal(diagnostics.signalCode,null);
 assert.match(diagnostics.lastProbeError,/probe exceeded/);assert.equal(diagnostics.startupFailure.code,'BROWSER_STARTUP_TIMEOUT');assert.equal(diagnostics.lastProbeFailure.code,'BROWSER_PROBE_TIMEOUT');
});

test('an early process exit interrupts an in-flight health request and preserves a bounded stderr tail',async()=>{
 const time=controlledTime(),child=processStub();let requestSignal,spawns=0;
 const browser=launchBrowser('test-chrome',[],{...time,platform:'linux',limits:{...BROWSER_STARTUP_LIMITS,stderrBytes:12},spawn:()=>{spawns++;return child;},fetch:(_url,{signal})=>{requestSignal=signal;return new Promise(()=>{});}});
 const observed=browser.waitUntilReady('http://127.0.0.1:9222/json/version').then(()=>assert.fail('Must fail'),error=>error);
 await flush();child.stderr.emit('data',Buffer.from('prefix-that-must-be-discarded:'));child.stderr.emit('data',Buffer.from('fatal reason'));child.finish(7,null);
 const failure=await observed;assert.match(failure.message,/exited.*code 7/);assert.equal(spawns,1);assert.equal(time.clock(),0);assert.equal(time.pending.size,0);assert.equal(requestSignal.aborted,true);
 const diagnostics=browser.diagnostics();assert.equal(diagnostics.exitCode,7);assert.equal(diagnostics.signalCode,null);assert.equal(diagnostics.stderrTail,'fatal reason');assert.equal(diagnostics.stderrBytesCaptured,12);assert.equal(diagnostics.stderrTruncated,true);assert.equal(diagnostics.stderrBytesTotal,42);
});

test('a refused endpoint keeps the Node fetch cause in the startup failure JSON instead of only TypeError',async()=>{
 const time=controlledTime(),child=processStub(),cause=Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:33171'),{code:'ECONNREFUSED',errno:-111,syscall:'connect',address:'127.0.0.1',port:33171});
 const browser=launchBrowser('test-chrome',[],{...time,platform:'linux',spawn:()=>child,fetch:async()=>{throw new TypeError('fetch failed',{cause});}});
 const failure=await drive(browser.waitUntilReady('http://127.0.0.1:33171/json/version').then(()=>assert.fail('Must time out'),error=>error),time);
 const saved=JSON.parse(JSON.stringify({errorDetails:browserErrorDetails(failure),browserStartup:browser.diagnostics()}));
 assert.equal(saved.errorDetails.cause.name,'TypeError');assert.equal(saved.errorDetails.cause.cause.code,'ECONNREFUSED');
 assert.equal(saved.browserStartup.lastProbeFailure.cause.address,'127.0.0.1');assert.equal(saved.browserStartup.lastProbeFailure.cause.port,33171);assert.equal(saved.browserStartup.lastProbeFailure.cause.syscall,'connect');
 assert.equal(time.pending.size,0);
});

test('spawn errors fail immediately, including errors emitted before a CDP connection exists',async()=>{
 for(const synchronous of [false,true]){
  const time=controlledTime(),child=processStub(),error=Object.assign(new Error('ENOENT test-chrome'),{code:'ENOENT'});let spawns=0;
  const browser=launchBrowser('missing-chrome',[],{...time,platform:'linux',spawn:()=>{spawns++;if(synchronous)throw error;queueMicrotask(()=>child.emit('error',error));return child;},fetch:()=>new Promise(()=>{})});
  const failure=await browser.waitUntilReady('http://127.0.0.1:9222/json/version').then(()=>assert.fail('Must fail'),error=>error);
  assert.match(failure.message,/Chromium process error: ENOENT/);assert.equal(spawns,1);assert.equal(time.clock(),0);assert.equal(time.pending.size,0);
  assert.match(browser.diagnostics().spawnError,/ENOENT/);assert.equal(browser.diagnostics().binary,'missing-chrome');
 }
});

test('cleanup escalates for owned descendants even when the Chromium parent already exited',async()=>{
 const time=controlledTime(),child=processStub(),signals=[];let groupExists=true;
 const browser=launchBrowser('test-chrome',[],{...time,platform:'linux',spawn:()=>child,signalProcess:(pid,signal)=>{
  assert.equal(pid,-child.pid,'Never signal an unrelated process or the test runner group');
  if(!groupExists)throw Object.assign(new Error('No group'),{code:'ESRCH'});
  if(signal===0)return;signals.push(signal);
  if(signal==='SIGTERM')child.finish(0,null);
  if(signal==='SIGKILL')groupExists=false;
 }});
 const closing=browser.close();assert.equal(browser.close(),closing,'Cleanup is idempotent');
 const cleanup=await drive(closing,time);
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(cleanup.status,'stopped');assert.equal(cleanup.elapsedMs,BROWSER_STARTUP_LIMITS.termMs);
 assert.equal(browser.diagnostics().exitCode,0);assert.equal(browser.diagnostics().signalCode,null);assert.equal(child.stderr.destroyed,true);assert.equal(child.unreferenced,true);assert.equal(time.pending.size,0);
});

test('an unkillable process cannot leave cleanup waiting forever or hide the failed cleanup receipt',async()=>{
 const time=controlledTime(),child=processStub(),signals=[];
 const browser=launchBrowser('test-chrome',[],{...time,platform:'linux',spawn:()=>child,signalProcess:(_pid,signal)=>{if(signal)signals.push(signal);}});
 const cleanup=await drive(browser.close(),time);
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(cleanup.status,'timed-out');
 assert.equal(cleanup.elapsedMs,BROWSER_STARTUP_LIMITS.termMs+BROWSER_STARTUP_LIMITS.killMs);assert.equal(time.pending.size,0);
 assert.equal(browser.diagnostics().cleanup.status,'timed-out');assert.equal(child.stderr.destroyed,true);assert.equal(child.unreferenced,true);
});

test('real owned process cleanup reaps a child that ignores SIGTERM',{skip:process.platform==='win32'},async t=>{
 const browser=launchBrowser(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stderr.write('ready\\n');setInterval(()=>{},1000);"],{limits:{...BROWSER_STARTUP_LIMITS,termMs:50,killMs:1000}});
 t.after(()=>browser.close());
 const deadline=Date.now()+2000;
 while(!browser.diagnostics().stderrTail.includes('ready')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
 assert.match(browser.diagnostics().stderrTail,/ready/);
 const cleanup=await browser.close();assert.equal(cleanup.status,'stopped');assert.deepEqual(cleanup.signals,['SIGTERM','SIGKILL']);
 assert.equal(browser.diagnostics().signalCode,'SIGKILL');assert.equal(browser.diagnostics().exitCode,null);
});
