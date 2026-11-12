import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer as createHTTPServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchBrowser,BROWSER_STARTUP_LIMITS,browserErrorDetails} from '../browser-startup.mjs';
import {browserEnvironmentArgs,collectBrowserEnvironment} from '../browser-environment.mjs';
import {collectNativeBrowserSurface} from '../browser-native-surface.mjs';
import {assertTerrainMaskReport} from '../terrain-mask-report.mjs';

const binary=['google-chrome','google-chrome-stable','chromium','chromium-browser'].find(name=>spawnSync('which',[name],{stdio:'ignore'}).status===0);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// A real Chromium correctness gate, not a performance measurement. Every frame
// comes from the production terrain renderer, including actual WebGL stencil
// behaviour, software rasterization and browser-generated context restoration.
test('RF display mask clips actual terrain and thick route pixels in WebGL2 and Canvas2D',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+120000,
},async t=>{
 assert.ok(binary,'A Chromium binary is required for the terrain mask pixel gate');
 const root=resolve(import.meta.dirname,'../../..'),output=join(root,'web/pages-preview/dist'),pictures=join(root,'web/pages-preview/design-qa/terrain-mask');
 const renderer=await readFile(join(root,'web/public/terrain/terrain-renderer.js')),fixture=await readFile(new URL('terrain-mask-fixture.mjs',import.meta.url)),windowFixture=await readFile(new URL('terrain-window-fixture.mjs',import.meta.url));
 const directory=await mkdtemp(join(tmpdir(),'tropnik-terrain-mask-'));
 const report={schemaVersion:1,verified:false,phase:'browser-startup',evidence:'production-renderer-browser-pixels',sourceCommit:process.env.GITHUB_SHA||null,rendererSHA256:createHash('sha256').update(renderer).digest('hex'),cases:[],mapWindows:[]};
 const html='<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:512px;height:384px;overflow:hidden;background:#dfe6da}</style><script type="module">import {TerrainRenderer} from "/terrain-renderer.js";import {runTerrainMaskCase} from "/fixture.mjs";window.runMaskGate=options=>runTerrainMaskCase(TerrainRenderer,options);import {runTerrainWindowCase} from "/window-fixture.mjs";window.runMeshWindowGate=options=>runTerrainWindowCase(TerrainRenderer,options);</script>';
 const server=createHTTPServer((request,response)=>{
  const path=new URL(request.url,'http://127.0.0.1').pathname,content=path==='/'?html:path==='/terrain-renderer.js'?renderer:path==='/fixture.mjs'?fixture:path==='/window-fixture.mjs'?windowFixture:null;
  response.writeHead(content===null?404:200,{'content-type':path==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store'});response.end(content??'Not found');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`,lease=createNetServer();
 await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory}));
 let socket;
 t.after(async()=>{
  socket?.close();await browser.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
  await mkdir(output,{recursive:true});report.browserStartup=browser.diagnostics();await writeFile(join(output,'browser-terrain-mask-verification.json'),JSON.stringify(report,null,2)+'\n');
 });
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);
  report.phase='browser-environment';report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  const cdp={call:(method,params={},timeout=5000)=>new Promise((resolve,reject)=>{
   const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Terrain mask CDP timeout: '+method));},timeout);
   pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));
  })};
  const evaluate=async(expression,timeout)=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},timeout);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:512,height:384,deviceScaleFactor:1,mobile:false});
  await cdp.call('Page.navigate',{url:origin+'/'});
  let loaded=false;for(let attempt=0;attempt<60;attempt++){if(await evaluate("typeof window.runMaskGate==='function'")){loaded=true;break;}await sleep(50);}assert.ok(loaded,'The real renderer fixture did not load');
  await mkdir(pictures,{recursive:true});
  for(const forceCanvas of [false,true])for(const changedView of [false,true]){
   const name=`${forceCanvas?'canvas2d':'webgl2'}-${changedView?'rotated-zoomed':'initial'}`;report.phase=name;
   const options={forceCanvas,rotate:changedView?0.61:0,zoom:changedView?1.3:1,restore:!forceCanvas&&changedView};
   const result=await evaluate(`window.runMaskGate(${JSON.stringify(options)})`,45000);
   const frames=[];
   for(const capture of result.captures){
    const file=`${name}-${capture.phase}.png`,bytes=Buffer.from(capture.png,'base64');assert.ok(bytes.length>=33&&bytes.length<=8*1024*1024,'Invalid or oversized rendered PNG');
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.subarray(12,16).toString(),'IHDR');assert.equal(bytes.readUInt32BE(16),capture.width);assert.equal(bytes.readUInt32BE(20),capture.height);
    await writeFile(join(pictures,file),bytes);const {png,...metadata}=capture;frames.push({...metadata,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
   }
   const {captures,...summary}=result;report.cases.push({...summary,name,frames});
   assert.equal(result.verified,true,result.error||`${name} failed in ${result.phase}`);assert.equal(result.renderer,forceCanvas?'canvas2d':'webgl2');
  }
  // Keep all four legacy cases above intact. These additional cases compare
  // actual map pixels with complete-grid references at the same source stride.
  for(const forceCanvas of[false,true]){
   const name=`map-window-${forceCanvas?'canvas2d':'webgl2'}`;report.phase=name;
   const result=await evaluate(`window.runMeshWindowGate(${JSON.stringify({forceCanvas})})`,45000),frames=[];
   for(const capture of result.captures){
    const file=`${name}-${capture.phase}.png`,bytes=Buffer.from(capture.png,'base64');assert.ok(bytes.length>=33&&bytes.length<=8*1024*1024,'Invalid map-window PNG');
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.subarray(12,16).toString(),'IHDR');assert.equal(bytes.readUInt32BE(16),capture.width);assert.equal(bytes.readUInt32BE(20),capture.height);
    await writeFile(join(pictures,file),bytes);const {png,...metadata}=capture;frames.push({...metadata,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
   }
   const {captures,...summary}=result;report.mapWindows.push({...summary,name,frames});
   assert.equal(result.verified,true,result.error||`${name} failed in ${result.phase}`);
  }
  assert.equal(report.cases.length,4);assert.ok(report.cases.some(item=>item.recovery?.restored===1));report.verified=true;report.phase='complete';
  assertTerrainMaskReport(report,{sourceCommit:report.sourceCommit,rendererSHA256:createHash('sha256').update(renderer).digest('hex')});
 }catch(error){report.verified=false;report.error=browserErrorDetails(error);throw error;}
});
