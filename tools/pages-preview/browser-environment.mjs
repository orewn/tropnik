import assert from 'node:assert/strict';
import {arch,availableParallelism,cpus,platform,release,totalmem,version} from 'node:os';
import {assertNativeSurfaceReceipt,nativeSurfaceIdentity} from './browser-native-surface.mjs';

// One rendering profile for correctness fixtures and the production audit.
// SwiftShader serves WebGL; ordinary page compositing uses Chromium software
// output. Never retry with another compositor or disable WebGL after failure.
export const BROWSER_ENVIRONMENT_PROFILE='chromium-headless-software-swiftshader-webgl-v1';
export const BROWSER_ENVIRONMENT_LIMITS=Object.freeze({timeoutMs:5000,messageBytes:128*1024,receiptBytes:32*1024});
export const BROWSER_ENVIRONMENT_FLAGS=Object.freeze([
 '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update',
 '--disable-default-apps','--disable-extensions','--disable-features=Translate,MediaRouter','--mute-audio','--no-first-run',
 '--use-gl=angle','--use-angle=swiftshader-webgl','--enable-unsafe-swiftshader',
 '--window-size=1920,1920','--ozone-override-screen-size=1920,1920',
]);
export function browserEnvironmentArgs({debugPort,userDataDir}){
 assert.ok(Number.isInteger(debugPort)&&debugPort>0&&debugPort<65536,'A real CDP port is required');
 assert.ok(typeof userDataDir==='string'&&userDataDir.length>0,'A dedicated Chromium data directory is required');
 return [...BROWSER_ENVIRONMENT_FLAGS,`--remote-debugging-port=${debugPort}`,`--user-data-dir=${userDataDir}`,'about:blank'];
}

function runnerEnvironment(){
 const processors=cpus();
 return{os:{platform:platform(),release:release(),version:version(),arch:arch()},
  cpu:{models:[...new Set(processors.map(cpu=>cpu.model))].sort(),logicalCount:processors.length,availableParallelism:availableParallelism()},
  totalMemoryBytes:totalmem(),image:{os:process.env.ImageOS||null,version:process.env.ImageVersion||null}};
}
const GPU_ATTRIBUTES=['displayType','glImplementationParts','glRenderer','glVendor','glVersion','skiaBackendType','targetCpuBits'];
function stableGPU(gpu){
 assert.ok(gpu&&Array.isArray(gpu.devices)&&gpu.devices.length>0&&gpu.devices.length<=16,'Missing actual GPU devices');
 return{devices:gpu.devices.map(device=>Object.fromEntries(['vendorId','deviceId','vendorString','deviceString','driverVendor','driverVersion'].map(key=>[key,device[key]??null]))),
  auxAttributes:Object.fromEntries(GPU_ATTRIBUTES.map(key=>[key,gpu.auxAttributes?.[key]??null])),featureStatus:gpu.featureStatus};
}
function commandSwitches(commandLine){
 assert.ok(typeof commandLine==='string'&&commandLine.length>0&&commandLine.length<=16384,'Missing or oversized actual Chromium command line');
 return [...commandLine.matchAll(/(?:^|\s)(--[\w-]+(?:=[^\s]+)?)/g)].map(match=>match[1]);
}
export function assertBrowserEnvironment(receipt,expectedCommit){
 assert.equal(receipt?.schemaVersion,1,'Missing browser environment receipt');
 assert.equal(receipt.profile,BROWSER_ENVIRONMENT_PROFILE,'A different Chromium rendering profile was used');
 assert.equal(receipt.collection,'browser-target-cdp-before-measurement','Browser environment must be observed before measurement');
 assert.equal(receipt.sourceCommit,expectedCommit,'Browser environment belongs to another source commit');
 assert.ok(expectedCommit===null||typeof expectedCommit==='string'&&/^[a-f0-9]{40}$/.test(expectedCommit),'An exact source commit is required');
 assert.ok(Number.isFinite(Date.parse(receipt.capturedAt)),'Browser environment capture time is missing');
 assert.deepEqual(receipt.requestedFlags,BROWSER_ENVIRONMENT_FLAGS);
 assert.ok(Buffer.byteLength(JSON.stringify(receipt))<=BROWSER_ENVIRONMENT_LIMITS.receiptBytes,'Oversized browser environment receipt');
 const switches=commandSwitches(receipt.commandLine);
 for(const expected of BROWSER_ENVIRONMENT_FLAGS){
  const key=expected.split('=')[0],observed=switches.filter(value=>value===key||value.startsWith(key+'='));
  assert.ok(observed.length>0&&observed.every(value=>value===expected),`Actual Chromium switch differs: ${key}`);
 }
 for(const key of ['--disable-gpu','--disable-webgl','--disable-webgl2','--disable-software-rasterizer','--enable-gpu','--use-vulkan']){
  assert.ok(!switches.some(value=>value===key||value.startsWith(key+'=')),`Incompatible Chromium switch: ${key}`);
 }
 assert.match(receipt.browser?.product||'',/^(?:HeadlessChrome|Chrome|Chromium)\/\d+\.\d+\.\d+\.\d+$/);
 for(const key of ['revision','protocolVersion','jsVersion','userAgent'])assert.ok(typeof receipt.browser[key]==='string'&&receipt.browser[key].length>0,`Missing actual browser ${key}`);
 assert.match(receipt.gpu?.auxAttributes?.glRenderer||'',/SwiftShader/,'WebGL must use the actual SwiftShader driver');
 assert.equal(receipt.gpu?.featureStatus?.gpu_compositing,'disabled_software','Full GPU compositing cannot pass as software output');
 assert.equal(receipt.gpu?.featureStatus?.rasterization,'disabled_software','Page rasterization must use the fixed software profile');
 assert.equal(receipt.gpu?.auxAttributes?.skiaBackendType,'None','Full SwiftShader GL compositing is not this profile');
 assert.ok(Array.isArray(receipt.gpu.devices)&&receipt.gpu.devices.length>0,'Missing actual GPU device identity');
 assert.equal(receipt.runner?.os?.platform,'linux');
 for(const key of ['release','version','arch'])assert.ok(typeof receipt.runner.os[key]==='string'&&receipt.runner.os[key].length>0,`Missing runner OS ${key}`);
 assert.ok(Array.isArray(receipt.runner.cpu?.models)&&receipt.runner.cpu.models.length>0&&receipt.runner.cpu.models.every(model=>typeof model==='string'&&model.length>0),'Missing runner CPU model');
 for(const key of ['logicalCount','availableParallelism'])assert.ok(Number.isInteger(receipt.runner.cpu[key])&&receipt.runner.cpu[key]>0,`Missing runner CPU ${key}`);
 assert.ok(Number.isSafeInteger(receipt.runner.totalMemoryBytes)&&receipt.runner.totalMemoryBytes>0,'Missing runner memory capacity');
 if(receipt.nativeSurface!==undefined)assertNativeSurfaceReceipt(receipt.nativeSurface);
 return receipt;
}
export function assertMatchingBrowserEnvironments(actual,expected,sourceCommit){
 assertBrowserEnvironment(actual,sourceCommit);assertBrowserEnvironment(expected,sourceCommit);
 // Ports, temporary directories, timestamps, PIDs, CPU clock and free memory
 // cannot identify a rendering environment. Compare only stable observations.
 for(const key of ['profile','requestedFlags','browser','gpu','runner'])assert.deepEqual(actual[key],expected[key],`Graphics proof has another browser environment: ${key}`);
 assert.deepEqual(nativeSurfaceIdentity(actual.nativeSurface),nativeSurfaceIdentity(expected.nativeSurface),'Graphics proof has another native browser surface');
 return actual;
}

// Collect once on the browser target, before any application navigation or
// measurement recorder. The single deadline covers connecting and both CDP
// responses; a missing/error/oversized response fails rather than falling back.
export async function collectBrowserEnvironment(browserURL,{sourceCommit=process.env.GITHUB_SHA||null,WebSocketClass=WebSocket,runner=runnerEnvironment(),timeoutMs=BROWSER_ENVIRONMENT_LIMITS.timeoutMs}={}){
 assert.ok(typeof browserURL==='string'&&/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//.test(browserURL),'The actual browser CDP target is required');
 assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=BROWSER_ENVIRONMENT_LIMITS.timeoutMs,'Browser environment collection must remain bounded');
 return new Promise((resolve,reject)=>{
  let socket,finished=false;const replies=new Map();
  const finish=(error,value)=>{
   if(finished)return;finished=true;clearTimeout(timer);
   try{socket?.close();}catch{}
   error?reject(error):resolve(value);
  };
  const timer=setTimeout(()=>finish(new Error('Timed out collecting the actual Chromium environment')),timeoutMs);
  try{
   socket=new WebSocketClass(browserURL);
   socket.addEventListener('error',()=>finish(new Error('Browser environment CDP connection failed')),{once:true});
   socket.addEventListener('close',()=>{if(!finished)finish(new Error('Browser environment CDP closed before both responses'));},{once:true});
   socket.addEventListener('open',()=>{
    try{for(const [id,method]of [[1,'Browser.getVersion'],[2,'SystemInfo.getInfo']])socket.send(JSON.stringify({id,method,params:{}}));}catch(error){finish(error);}
   },{once:true});
   socket.addEventListener('message',event=>{
    try{
     assert.ok(typeof event.data==='string'&&Buffer.byteLength(event.data)<=BROWSER_ENVIRONMENT_LIMITS.messageBytes,'Oversized browser environment CDP response');
     const message=JSON.parse(event.data);if(![1,2].includes(message.id))return;
     if(message.error)throw new Error(`Browser environment CDP failed: ${message.error.message}`);
     assert.ok(message.result&&typeof message.result==='object','Missing browser environment CDP result');replies.set(message.id,message.result);
     if(replies.size!==2)return;
     const browser=replies.get(1),info=replies.get(2),receipt={schemaVersion:1,profile:BROWSER_ENVIRONMENT_PROFILE,collection:'browser-target-cdp-before-measurement',
      sourceCommit,capturedAt:new Date().toISOString(),requestedFlags:[...BROWSER_ENVIRONMENT_FLAGS],commandLine:info.commandLine,
      browser:{product:browser.product,revision:browser.revision,protocolVersion:browser.protocolVersion,jsVersion:browser.jsVersion,userAgent:browser.userAgent},gpu:stableGPU(info.gpu),runner};
     assertBrowserEnvironment(receipt,sourceCommit);finish(null,receipt);
    }catch(error){finish(error);}
   });
  }catch(error){finish(error);}
 });
}
