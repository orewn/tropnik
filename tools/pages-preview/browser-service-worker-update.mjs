import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser,browserErrorDetails} from './browser-startup.mjs';
import {browserEnvironmentArgs,collectBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {collectNativeBrowserSurface,assertNativeSurfaceCoverage} from './browser-native-surface.mjs';

const PROJECT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const rootArgument=process.argv.indexOf('--root');
const ROOT=rootArgument<0?join(PROJECT,'web/pages-preview/dist'):resolve(process.argv[rootArgument+1]);
const RECEIPT=join(ROOT,'browser-service-worker-update-verification.json');
const CAPTURES=join(PROJECT,'web/pages-preview/design-qa/service-worker-update');
const PROFILE={name:'android-portrait',width:412,height:915,mobile:true,deviceScaleFactor:2};
const SOURCE_PATHS=['web/components/ServiceWorker.tsx','web/lib/service-worker-registration.ts','web/public/sw.js','tools/pages-preview/browser-service-worker-update.mjs'];
const LEDGER='tropnik-sw-browser-audit-v1';
const BUTTON='.app-update button.primary';
const IDLE_OBSERVATION_MS=1500;
const TIMEOUT_RANGE_MS=[14900,17500];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.geojson':'application/geo+json','.coverage':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8'};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** Imported by the publication gate. The injected fault is delivery of one
 * skip-waiting message, never the application's UI, timer or worker state. */
export function assertServiceWorkerUpdateReceipt(report,{sourceCommit,buildId,environment}={}){
  assert.equal(report?.schemaVersion,1);assert.equal(report.evidence,'production-app-service-worker-update');
  assert.equal(report.verified,true);assert.match(sourceCommit||'',/^[a-f0-9]{40}$/);
  assert.equal(report.sourceCommit,sourceCommit);assert.equal(report.buildId,buildId);
  assert.deepEqual(report.profile,PROFILE);
  if(environment)assertMatchingBrowserEnvironments(report.environment,environment,sourceCommit);
  assert.equal(report.fixture.workerTransformation,'VERSION constant only; the remaining deployed worker bytes are unchanged');
  assert.equal(report.fixture.fault,'Hold one genuine skip-waiting postMessage, then deliver it after the real application timeout');
  assert.equal(report.fixture.clockOverridden,false);assert.equal(report.fixture.workerStateOverridden,false);
  assert.equal(report.fixture.uiStateOverridden,false);assert.equal(report.fixture.unregistered,false);
  assert.match(report.worker.sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(report.worker.variants),['a','b','c']);
  assert.equal(new Set(Object.values(report.worker.variants).map(value=>value.sha256)).size,3);
  for(const value of Object.values(report.worker.variants)){
    assert.match(value.sha256,/^[a-f0-9]{64}$/);assert.ok(value.version.startsWith(report.worker.version+'-sw-audit-'));
    assert.equal(value.normalizedSha256,report.worker.normalizedSha256);
  }
  for(const path of SOURCE_PATHS)assert.match(report.sources[path],/^[a-f0-9]{64}$/);
  const normal=report.normal;
  assert.equal(normal.verified,true);assert.ok(normal.waitingObservationMs>=IDLE_OBSERVATION_MS);
  assert.equal(normal.waitingDocumentPreserved,true);assert.equal(normal.waitingControllerPreserved,true);
  assert.equal(normal.nativeClick.trusted,true);assert.equal(normal.nativeClick.label,'Обновить');
  assert.equal(normal.reloads,1);assert.equal(normal.controllerChanged,true);assert.equal(normal.activeVersion,'b');
  const fault=report.timeout;
  assert.equal(fault.verified,true);assert.equal(fault.heldMessages,1);
  assert.equal(fault.nativeClick.trusted,true);assert.equal(fault.nativeClick.label,'Обновить');
  assert.equal(fault.updatingLabel,'Обновляем…');assert.equal(fault.updatingDisabled,true);
  assert.ok(fault.elapsedMs>=TIMEOUT_RANGE_MS[0]&&fault.elapsedMs<=TIMEOUT_RANGE_MS[1]);
  assert.equal(fault.errorLabel,'Повторить');assert.equal(fault.errorDisabled,false);
  assert.equal(fault.timeoutDocumentPreserved,true);assert.equal(fault.lateControllerChanged,true);
  assert.ok(fault.lateObservationMs>=IDLE_OBSERVATION_MS);assert.equal(fault.lateDocumentPreserved,true);
  assert.equal(fault.retryClick.trusted,true);assert.equal(fault.retryClick.label,'Повторить');
  assert.equal(fault.retryReloads,1);assert.equal(fault.activeVersion,'c');
  assert.equal(report.syntheticDataPreserved,true);assert.equal(report.documents,3);
  assert.equal(report.browserProcess?.status,'ready');
  assert.equal(report.browserProcess?.cleanup?.status,'stopped');
  assert.deepEqual(report.browserProcess.cleanup.errors,[]);
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.localHttpErrors,[]);
  assert.deepEqual(report.screenshots.map(item=>item.phase),['waiting','updating-held','retry','late-controller','updated']);
  for(const shot of report.screenshots){assert.match(shot.sha256,/^[a-f0-9]{64}$/);assert.ok(shot.bytes>1000);assert.match(shot.file,/^sw-update-[a-z-]+\.png$/);}
  return report;
}

class CDP{
  constructor(url){this.url=url;this.next=1;this.pending=new Map();this.observers=new Map();}
  async open(){
    this.socket=new WebSocket(this.url);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CDP connection timed out')),10000);this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connection failed'));},{once:true});});
    this.socket.addEventListener('message',event=>{
      const value=JSON.parse(event.data);
      if(value.id){const job=this.pending.get(value.id);if(!job)return;this.pending.delete(value.id);clearTimeout(job.timer);value.error?job.reject(new Error(value.error.message)):job.resolve(value.result);return;}
      for(const observer of this.observers.get(value.method)||[])observer(value.params);
    });
  }
  call(method,params={},timeout=15000){const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP ${method} timed out`));},timeout);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  observe(method,callback){const list=this.observers.get(method)||new Set();list.add(callback);this.observers.set(method,list);return()=>list.delete(callback);}
  close(){for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(new Error('CDP closed'));}this.pending.clear();this.socket?.close();}
}

async function evaluate(cdp,expression){const value=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(JSON.stringify(value.exceptionDetails));return value.result.value;}
async function waitValue(label,read,accept,timeout=25000){const deadline=performance.now()+timeout;let last;while(performance.now()<deadline){last=await read();if(accept(last))return last;await pause(80);}throw new Error(`${label}: condition did not settle: ${JSON.stringify(last)}`);}
function port(){return new Promise((resolve,reject)=>{const server=createNetServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});});}
function binary(){for(const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser'])if(spawnSync('which',[name],{stdio:'ignore'}).status===0)return name;throw new Error('Chromium is unavailable');}

function probeSource(base,versions){return `(()=>{
  if(!location.pathname.startsWith(${JSON.stringify(base)}))return;
  const key=${JSON.stringify(LEDGER)},read=()=>JSON.parse(sessionStorage.getItem(key)||'null')||{documents:0,events:[]};
  const now=()=>performance.timeOrigin+performance.now();
  const ledger=read();const documentId=++ledger.documents;sessionStorage.setItem(key,JSON.stringify(ledger));
  const record=(kind,detail={})=>{const value=read();value.events.push({kind,documentId,at:now(),...detail});if(value.events.length>64)value.events.shift();sessionStorage.setItem(key,JSON.stringify(value));};
  const identities=new WeakMap();let nextIdentity=1;
  const identity=worker=>{if(!worker)return null;if(!identities.has(worker))identities.set(worker,nextIdentity++);return identities.get(worker);};
  let previous=navigator.serviceWorker.controller;identity(previous);record('document',{controllerId:identity(previous)});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{const controller=navigator.serviceWorker.controller;record('controllerchange',{before:identity(previous),after:identity(controller),changed:!!controller&&controller!==previous});previous=controller;});
  document.addEventListener('click',event=>{const button=event.target.closest?.(${JSON.stringify(BUTTON)});if(button)record('click',{trusted:event.isTrusted,label:button.textContent.trim(),disabled:button.disabled});},true);
  const original=ServiceWorker.prototype.postMessage,held=[];
  const probe={documentId,holdSkipWaiting:false,releaseHeld(){probe.holdSkipWaiting=false;const count=held.length;for(const {worker,args}of held.splice(0))Reflect.apply(original,worker,args);record('held-released',{count});return count;}};
  ServiceWorker.prototype.postMessage=function(...args){if(probe.holdSkipWaiting&&args[0]?.type==='skip-waiting'){held.push({worker:this,args});record('skip-held',{state:this.state});return;}return Reflect.apply(original,this,args);};
  let bannerKey;
  const banner=()=>{const root=document.querySelector('.app-update'),button=root?.querySelector('button.primary');return{visible:!!root,label:button?.textContent.trim()||'',disabled:button?.disabled??false,message:root?.querySelector('[role=status]')?.textContent.trim()||''};};
  new MutationObserver(()=>{const value=banner(),next=JSON.stringify(value);if(next!==bannerKey){bannerKey=next;record('banner',value);}}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});
  probe.read=async()=>{const registration=await navigator.serviceWorker.getRegistration(${JSON.stringify(base)});return{documentId,controllerId:identity(navigator.serviceWorker.controller),active:registration?.active?.state||null,waiting:registration?.waiting?.state||null,installing:registration?.installing?.state||null,waitingIsController:!!registration?.waiting&&registration.waiting===navigator.serviceWorker.controller,banner:banner(),appMounted:document.querySelector('h1')?.textContent==='Хорошая тропа. Своя компания.',cacheVersions:(await caches.keys()).filter(name=>${JSON.stringify(Object.values(versions))}.includes(name)),ledger:read()};};
  window.__swUpdateAudit=probe;
})()`;}

async function state(cdp){
  try{return await evaluate(cdp,'window.__swUpdateAudit?.read()||null');}
  catch(error){if(/Execution context was destroyed|Cannot find context/.test(error.message))return null;throw error;}
}
async function nativeClick(cdp,label){
  let previous,stable=0;
  const point=await waitValue('Reachable update action '+label,()=>evaluate(cdp,`(()=>{const element=document.querySelector(${JSON.stringify(BUTTON)});if(!element||element.disabled||element.textContent.trim()!==${JSON.stringify(label)})return null;const rect=element.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);return rect.width>0&&rect.height>0&&(hit===element||element.contains(hit))?{x,y}:null;})()`),current=>{stable=current&&previous&&Math.hypot(current.x-previous.x,current.y-previous.y)<.25?stable+1:0;previous=current;return stable>=2;});
  await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:51,radiusX:2,radiusY:2,force:1}]});
  await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}

async function screenshot(cdp,phase){const capture=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),bytes=Buffer.from(capture.data,'base64'),file=`sw-update-${phase}.png`;await writeFile(join(CAPTURES,file),bytes);return{phase,file,bytes:bytes.length,sha256:digest(bytes)};}

async function inputs(){
  const build=JSON.parse(await readFile(join(ROOT,'build-info.json'),'utf8'));
  assert.equal(build.base,'/tropnik/');assert.match(build.buildId,/^[a-f0-9]{16}$/);
  const sources={};
  for(const path of SOURCE_PATHS){const bytes=await readFile(join(PROJECT,path)),input=build.inputs.find(item=>item.path===path);assert.ok(input,'Missing actual build input '+path);assert.equal(bytes.length,input.bytes);assert.equal(digest(bytes),input.sha256);sources[path]=input.sha256;}
  const worker=await readFile(join(ROOT,'sw.js'),'utf8'),pattern=/const VERSION='([^']+)'/g,matches=[...worker.matchAll(pattern)];
  assert.equal(matches.length,1);const version=matches[0][1],normalized=worker.replace(pattern,"const VERSION='SW_AUDIT_VERSION'");
  const variants=Object.fromEntries(['a','b','c'].map(key=>{const value=version+'-sw-audit-'+key,source=worker.replace(pattern,`const VERSION='${value}'`);assert.equal(source.replace(pattern,"const VERSION='SW_AUDIT_VERSION'"),normalized);return[key,{source,version:value,sha256:digest(source),normalizedSha256:digest(normalized)}];}));
  return{build,sources,worker:{sha256:digest(worker),version,normalizedSha256:digest(normalized),variants}};
}

async function run(){
  const input=await inputs(),{build,sources}=input;
  if(process.argv.includes('--check-inputs')){console.log(JSON.stringify({verified:false,browserLaunched:false,inputsMatch:true,buildId:build.buildId,sources,worker:input.worker.sha256,variantHashes:Object.fromEntries(Object.entries(input.worker.variants).map(([key,value])=>[key,value.sha256]))}));return;}
  assert.match(process.env.GITHUB_SHA||'',/^[a-f0-9]{40}$/);assert.equal(build.sourceCommit,process.env.GITHUB_SHA);
  const versions=Object.fromEntries(Object.entries(input.worker.variants).map(([key,value])=>[key,value.version]));
  const report={schemaVersion:1,evidence:'production-app-service-worker-update',sourceCommit:build.sourceCommit,buildId:build.buildId,profile:PROFILE,startedAt:new Date().toISOString(),verified:false,sources,worker:{...input.worker,variants:Object.fromEntries(Object.entries(input.worker.variants).map(([key,{source,...value}])=>[key,value]))},fixture:{entrypoint:build.base+'about/',workerTransformation:'VERSION constant only; the remaining deployed worker bytes are unchanged',fault:'Hold one genuine skip-waiting postMessage, then deliver it after the real application timeout',clockOverridden:false,workerStateOverridden:false,uiStateOverridden:false,unregistered:false},normal:{verified:false},timeout:{verified:false},pageErrors:[],localHttpErrors:[],workerRequests:[],screenshots:[],scope:'Actual candidate application, native touch input and real Chromium workers using three explicit cache VERSION variants. This is not an upgrade from a previously released worker, and does not qualify map warmup transport.'};
  const checkpoint=()=>writeFile(RECEIPT,JSON.stringify(report,null,2)+'\n');
  await mkdir(CAPTURES,{recursive:true});
  let serving='a',browser,cdp,userDataDir,failure;
  const server=createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith(build.base))throw new Error('Unexpected artifact prefix');
    if(url.pathname===build.base+'sw.js'){const variant=input.worker.variants[serving];report.workerRequests.push({variant:serving,sha256:variant.sha256,at:new Date().toISOString()});res.writeHead(200,{'content-type':MIME['.js'],'cache-control':'no-store','service-worker-allowed':build.base});res.end(variant.source);return;}
    let path=resolve(ROOT,decodeURIComponent(url.pathname.slice(build.base.length))||'index.html');if(!path.startsWith(ROOT+sep))throw new Error('Path leaves artifact');
    if((await stat(path)).isDirectory())path=join(path,'index.html');const bytes=await readFile(path);res.writeHead(200,{'content-type':MIME[extname(path)]||'application/octet-stream','cache-control':'no-store'});res.end(bytes);
  }catch{res.writeHead(404);res.end('Not found');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    const debugPort=await port();userDataDir=await mkdtemp(join(tmpdir(),'tropnik-sw-update-'));
    browser=launchBrowser(binary(),browserEnvironmentArgs({debugPort,userDataDir}));
    const version=await browser.waitUntilReady(`http://127.0.0.1:${debugPort}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:build.sourceCommit});
    const target=await browser.requestJSON(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'});cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();
    report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);assertNativeSurfaceCoverage(report.environment.nativeSurface,[PROFILE]);
    await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Network.enable');
    cdp.observe('Runtime.exceptionThrown',event=>report.pageErrors.push(event.exceptionDetails));
    cdp.observe('Network.responseReceived',({response})=>{if(response.status>=400&&response.url.startsWith(origin+'/'))report.localHttpErrors.push({url:response.url,status:response.status});});
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:PROFILE.width,height:PROFILE.height,deviceScaleFactor:PROFILE.deviceScaleFactor,mobile:true,screenWidth:PROFILE.width,screenHeight:PROFILE.height});
    await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:probeSource(build.base,versions)});
    await cdp.call('Page.navigate',{url:origin+build.base+'about/'});
    const first=await waitValue('Actual application and worker A',()=>state(cdp),value=>value?.appMounted&&value.controllerId&&value.active==='activated'&&!value.waiting&&value.cacheVersions.includes(versions.a),30000);
    assert.equal(first.documentId,1);assert.equal(first.banner.visible,false);
    const userCache=input.worker.version.split('shell-')[0]+'map-sw-audit-sentinel';
    await evaluate(cdp,`(async()=>{localStorage.setItem('tropnik-sw-audit-data','preserve');const cache=await caches.open(${JSON.stringify(userCache)});await cache.put(${JSON.stringify(build.base+'_offline/sw-audit-sentinel')},new Response('preserve'));})()`);
    serving='b';
    await evaluate(cdp,`(async()=>{const registration=await navigator.serviceWorker.getRegistration(${JSON.stringify(build.base)});await registration.update();})()`);
    const waiting=await waitValue('Real waiting worker B and update banner',()=>state(cdp),value=>value?.waiting==='installed'&&value.banner.visible&&value.banner.label==='Обновить'&&!value.banner.disabled&&value.cacheVersions.includes(versions.b),30000);
    const before=performance.now();await pause(IDLE_OBSERVATION_MS);const held=await state(cdp);
    report.normal.waitingObservationMs=performance.now()-before;
    report.normal.waitingDocumentPreserved=held.documentId===first.documentId;
    report.normal.waitingControllerPreserved=held.controllerId===first.controllerId&&held.waiting==='installed'&&!held.waitingIsController;
    assert.equal(waiting.documentId,first.documentId);assert.equal(report.normal.waitingDocumentPreserved,true);assert.equal(report.normal.waitingControllerPreserved,true);
    report.screenshots.push(await screenshot(cdp,'waiting'));await checkpoint();
    await nativeClick(cdp,'Обновить');
    const normal=await waitValue('Native update activates B and reloads once',()=>state(cdp),value=>value?.documentId===2&&value.appMounted&&value.active==='activated'&&!value.waiting&&value.cacheVersions.includes(versions.b)&&!value.cacheVersions.includes(versions.a),30000);
    report.normal.nativeClick=normal.ledger.events.find(event=>event.kind==='click'&&event.documentId===1);
    report.normal.reloads=normal.documentId-first.documentId;report.normal.controllerChanged=normal.ledger.events.some(event=>event.kind==='controllerchange'&&event.documentId===1&&event.before===first.controllerId&&event.changed&&event.after!==event.before);
    report.normal.activeVersion='b';report.normal.verified=true;await checkpoint();
    serving='c';
    await evaluate(cdp,`(async()=>{const registration=await navigator.serviceWorker.getRegistration(${JSON.stringify(build.base)});await registration.update();})()`);
    const waitingC=await waitValue('Real waiting worker C and update banner',()=>state(cdp),value=>value?.waiting==='installed'&&value.banner.visible&&value.banner.label==='Обновить'&&!value.banner.disabled&&value.cacheVersions.includes(versions.c),30000);
    await evaluate(cdp,'window.__swUpdateAudit.holdSkipWaiting=true');
    await nativeClick(cdp,'Обновить');
    const updating=await waitValue('Actual disabled updating UI',()=>state(cdp),value=>value?.documentId===2&&value.banner.label==='Обновляем…'&&value.banner.disabled,5000);
    report.timeout.updatingLabel=updating.banner.label;report.timeout.updatingDisabled=updating.banner.disabled;
    report.screenshots.push(await screenshot(cdp,'updating-held'));
    const timedOut=await waitValue('Actual 15 second application timeout and retry UI',()=>state(cdp),value=>value?.banner.label==='Повторить'&&!value.banner.disabled,19000);
    const clicked=timedOut.ledger.events.find(event=>event.kind==='click'&&event.documentId===2);
    const error=timedOut.ledger.events.find(event=>event.kind==='banner'&&event.documentId===2&&event.label==='Повторить');
    report.timeout.nativeClick=clicked;report.timeout.elapsedMs=error.at-clicked.at;
    report.timeout.heldMessages=timedOut.ledger.events.filter(event=>event.kind==='skip-held'&&event.documentId===2).length;
    report.timeout.errorLabel=timedOut.banner.label;report.timeout.errorDisabled=timedOut.banner.disabled;
    report.timeout.timeoutDocumentPreserved=timedOut.documentId===waitingC.documentId&&timedOut.controllerId===waitingC.controllerId&&timedOut.waiting==='installed';
    assert.equal(report.timeout.timeoutDocumentPreserved,true);assert.equal(report.timeout.heldMessages,1);
    report.screenshots.push(await screenshot(cdp,'retry'));await checkpoint();
    assert.equal(await evaluate(cdp,'window.__swUpdateAudit.releaseHeld()'),1);
    const changed=await waitValue('Late real controllerchange after expired user decision',()=>state(cdp),value=>value?.documentId===2&&value.controllerId!==waitingC.controllerId&&value.active==='activated'&&!value.waiting&&value.cacheVersions.includes(versions.c)&&!value.cacheVersions.includes(versions.b),25000);
    report.timeout.lateControllerChanged=changed.ledger.events.some(event=>event.kind==='controllerchange'&&event.documentId===2&&event.before===waitingC.controllerId&&event.changed);
    const lateStart=performance.now();await pause(IDLE_OBSERVATION_MS);const late=await state(cdp);
    report.timeout.lateObservationMs=performance.now()-lateStart;report.timeout.lateDocumentPreserved=late.documentId===waitingC.documentId&&late.banner.label==='Повторить'&&!late.banner.disabled;
    assert.equal(report.timeout.lateDocumentPreserved,true);report.screenshots.push(await screenshot(cdp,'late-controller'));await checkpoint();
    await nativeClick(cdp,'Повторить');
    const final=await waitValue('Explicit retry reloads the real new controller',()=>state(cdp),value=>value?.documentId===3&&value.appMounted&&value.active==='activated'&&!value.waiting&&value.cacheVersions.includes(versions.c),30000);
    report.timeout.retryClick=final.ledger.events.find(event=>event.kind==='click'&&event.documentId===2&&event.label==='Повторить');
    report.timeout.retryReloads=final.documentId-late.documentId;report.timeout.activeVersion='c';report.timeout.verified=true;
    report.syntheticDataPreserved=await evaluate(cdp,`(async()=>{if(localStorage.getItem('tropnik-sw-audit-data')!=='preserve'||!(await caches.keys()).includes(${JSON.stringify(userCache)}))return false;const response=await(await caches.open(${JSON.stringify(userCache)})).match(${JSON.stringify(build.base+'_offline/sw-audit-sentinel')});return!!response&&await response.text()==='preserve';})()`);
    report.documents=final.ledger.documents;report.ledger=final.ledger;report.screenshots.push(await screenshot(cdp,'updated'));
  }catch(error){failure=error;report.verified=false;report.failure=browserErrorDetails(error);report.lastState=await state(cdp).catch(()=>null);}
  finally{
    cdp?.close();if(browser){await browser.close();report.browserProcess=browser.diagnostics();}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    if(userDataDir)await rm(userDataDir,{recursive:true,force:true});
    report.finishedAt=new Date().toISOString();await checkpoint();
  }
  if(!failure){
    try{report.verified=true;assertServiceWorkerUpdateReceipt(report,{sourceCommit:build.sourceCommit,buildId:build.buildId});}
    catch(error){failure=error;report.verified=false;report.failure=browserErrorDetails(error);}
    await checkpoint();
  }
  if(failure)throw failure;
  console.log(JSON.stringify({verified:true,sourceCommit:report.sourceCommit,buildId:report.buildId,normalReloads:report.normal.reloads,timeoutMs:report.timeout.elapsedMs,retryReloads:report.timeout.retryReloads,receipt:RECEIPT}));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await run();
