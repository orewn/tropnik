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
import {collectNativeBrowserSurface,assertNativeSurfaceCoverage} from '../browser-native-surface.mjs';
import {terrainFullMaskFixture} from './terrain-full-mask-fixture.mjs';
import {terrainPresentationSources,TERRAIN_PRESENTATION_REFERENCE} from '../terrain-presentation-sources.mjs';
import {assertTerrainPresentationReport} from '../terrain-presentation-report.mjs';

const root=resolve(import.meta.dirname,'../../..'),web=join(root,'web');
const binary=['google-chrome','google-chrome-stable','chromium','chromium-browser'].find(name=>spawnSync('which',[name],{stdio:'ignore'}).status===0);
const sha=value=>createHash('sha256').update(value).digest('hex'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('presentation reference is immutable f36 and shares the current terrain shaders',async()=>{
 const source=terrainPresentationSources(root);assert.equal(source.bindings.reference.sha256,TERRAIN_PRESENTATION_REFERENCE.sha256);assert.notEqual(source.bindings.rendererSHA256,source.bindings.reference.sha256);
 const original=await import('data:text/javascript;base64,'+Buffer.from(source.production).toString('base64'));
 const baseline=await import('data:text/javascript;base64,'+Buffer.from(source.reference).toString('base64'));
 assert.equal(typeof original.TerrainRenderer,'function');assert.equal(typeof baseline.TerrainRenderer,'function');
 const fixture=terrainFullMaskFixture();assert.ok(Math.max(...fixture.grid.elevations)-Math.min(...fixture.grid.elevations)>1000);
 const full=fixture.mask('full'),mixed=fixture.mask('known');assert.equal(full.source.allowedPixels,full.pixels.length);assert.ok(mixed.source.allowedPixels>0&&mixed.source.allowedPixels<mixed.pixels.length);
 assert.ok(fixture.geometry.coordinates.some(line=>line[0][0]<fixture.grid.bounds[0]&&line[1][0]>fixture.grid.bounds[2]));
});

test('deferred presentation preserves immutable direct-renderer pixels and real WebGL completion',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+180000,
},async t=>{
 assert.ok(binary,'A real Chromium binary is required for the presentation pixel gate');
 const source=terrainPresentationSources(root),fixture=await readFile(new URL('terrain-presentation-fixture.mjs',import.meta.url)),maskData=await readFile(new URL('terrain-mask-fixture.mjs',import.meta.url)),dataFixture=await readFile(new URL('terrain-full-mask-fixture.mjs',import.meta.url));
 const directory=await mkdtemp(join(tmpdir(),'tropnik-terrain-presentation-')),output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/terrain-presentation');
 const report={schemaVersion:1,verified:false,phase:'browser-startup',evidence:'production-terrain-presentation-pixel-parity',sourceCommit:process.env.GITHUB_SHA||null,...source.bindings,cases:[]};
 const html='<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:512px;height:384px;overflow:hidden}</style><script type="module">import {TerrainRenderer as Optimized} from "/terrain-optimized.js";import {TerrainRenderer as Baseline} from "/terrain-baseline.js";import {runTerrainPresentationCase} from "/terrain-presentation-fixture.mjs";window.runPresentationGate=options=>runTerrainPresentationCase(Optimized,Baseline,options);</script>';
 const content=new Map([['/',html],['/terrain-optimized.js',source.production],['/terrain-baseline.js',source.reference],['/terrain-presentation-fixture.mjs',fixture],['/terrain-mask-fixture.mjs',maskData],['/terrain-full-mask-fixture.mjs',dataFixture]]);
 const server=createHTTPServer((request,response)=>{const path=new URL(request.url,'http://127.0.0.1').pathname;response.writeHead(content.has(path)?200:404,{'content-type':path==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store'});response.end(content.get(path)??'Not found');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,lease=createNetServer();
 await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory}));let socket;
 t.after(async()=>{socket?.close();await browser.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});await mkdir(output,{recursive:true});report.browserStartup=browser.diagnostics();await writeFile(join(output,'browser-terrain-presentation-verification.json'),JSON.stringify(report,null,2)+'\n');});
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  const cdp={call:(method,params={},timeout=5000)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Terrain presentation CDP timeout: '+method));},timeout);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));})};
  const evaluate=async(expression,timeout)=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},timeout);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);assertNativeSurfaceCoverage(report.environment.nativeSurface);
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:512,height:384,deviceScaleFactor:1,mobile:false});await cdp.call('Page.navigate',{url:origin+'/'});
  let loaded=false;for(let attempt=0;attempt<60;attempt++){if(await evaluate("typeof window.runPresentationGate==='function'")){loaded=true;break;}await sleep(50);}assert.ok(loaded,'The actual terrain shader fixture did not load');
  await mkdir(pictures,{recursive:true});
  for(const dpr of [1,2])for(const maskKind of ['full','mixed'])for(const changedView of [false,true]){
   await cdp.call('Emulation.setDeviceMetricsOverride',{width:512,height:384,deviceScaleFactor:dpr,mobile:false});
   const name=`dpr${dpr}-${maskKind}-${changedView?'rotated-zoomed':'initial'}`;report.phase=name;
   const result=await evaluate(`window.runPresentationGate(${JSON.stringify({maskKind,rotate:changedView?.61:0,zoom:changedView?1.3:1,restore:changedView})})`,60000);
   report.cases.push({...result,name,dpr});const item=report.cases.at(-1),frames=[];
   for(const capture of result.captures){
    const file=`${name}-${capture.variant}-${capture.phase}.png`,bytes=Buffer.from(capture.png,'base64');assert.ok(bytes.length>=33&&bytes.length<=8*1024*1024);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),capture.width);assert.equal(bytes.readUInt32BE(20),capture.height);
    await writeFile(join(pictures,file),bytes);const {png,...metadata}=capture;frames.push({...metadata,file,bytes:bytes.length,sha256:sha(bytes)});
   }
   item.captures=frames;assert.equal(result.verified,true,result.error||name+' failed in '+result.phase);
  }
  report.verified=true;report.phase='complete';
  assertTerrainPresentationReport(report,{sourceCommit:report.sourceCommit,root});
 }catch(error){report.verified=false;report.error=browserErrorDetails(error);throw error;}
});
