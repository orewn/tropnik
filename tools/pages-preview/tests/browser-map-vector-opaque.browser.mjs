import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer as createHTTPServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchBrowser,BROWSER_STARTUP_LIMITS,browserErrorDetails} from '../browser-startup.mjs';
import {browserEnvironmentArgs,collectBrowserEnvironment} from '../browser-environment.mjs';
import {collectNativeBrowserSurface,assertNativeSurfaceCoverage} from '../browser-native-surface.mjs';
import {OPAQUE_VECTOR_CASES,opaqueVectorFixtureBytes} from './fixtures/map-vector-opaque.mjs';

const root=resolve(import.meta.dirname,'../../..'),web=join(root,'web'),require=createRequire(join(web,'package.json'));
const buildRequire=createRequire(require.resolve('vite')),{build}=buildRequire('esbuild');
const workerPath=join(web,'lib/custom-map-tiles.worker.ts'),fixturePath=join(root,'tools/pages-preview/tests/fixtures/map-vector-opaque.mjs');
const alphaExpression="alpha:job.kind!=='vector'||!!job.transparent";
const binary=['google-chrome','google-chrome-stable','chromium','chromium-browser'].find(name=>spawnSync('which',[name],{stdio:'ignore'}).status===0);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=value=>createHash('sha256').update(value).digest('hex');

// This observation shim leaves every context request and transfer unchanged.
// It records real context attributes at creation, before ImageBitmap transfer.
const workerObserver=`(()=>{const get=OffscreenCanvas.prototype.getContext,post=self.postMessage.bind(self);let contexts=[];
OffscreenCanvas.prototype.getContext=function(type,attributes){const context=get.call(this,type,attributes);contexts.push({width:this.width,height:this.height,type,requested:attributes??null,actual:context?.getContextAttributes?.()??null});return context;};
self.postMessage=(message,options)=>{const recorded=contexts;contexts=[];post({...message,__contexts:recorded,__transferListed:!!message.bitmap&&!!options?.transfer?.includes(message.bitmap)},options);};})();\n`;

async function productionBundle(){
 const source=await readFile(workerPath,'utf8'),parts=source.split(alphaExpression);
 assert.equal(parts.length,2,'The fixture baseline must replace exactly the output alpha expression');
 const baseline=parts.join('alpha:true'),wrong=parts.join('alpha:false');
 const outputPrefix="const canvas=new OffscreenCanvas(TILE_SIZE,TILE_SIZE),context=canvas.getContext('2d',{";
 assert.equal(sha(baseline.replace(outputPrefix+'alpha:true',outputPrefix+alphaExpression)),sha(source),'No other worker source may change in the old baseline');
 const compile=async(workerSource)=>{
  const result=await build({absWorkingDir:web,bundle:true,write:false,format:'iife',platform:'browser',target:'chrome107',minify:false,metafile:true,logLevel:'silent',entryPoints:[workerPath],
   plugins:[{name:'fixture-only-output-alpha',setup(plugin){plugin.onLoad({filter:/[/\\]custom-map-tiles\.worker\.ts$/},async args=>{assert.equal(args.path,workerPath);return{contents:workerSource,loader:'ts',resolveDir:join(web,'lib')};});}}],
  });
  assert.equal(result.outputFiles.length,1);return{code:workerObserver+result.outputFiles[0].text,inputs:Object.keys(result.metafile.inputs).sort()};
 };
 const [current,old,negative]=await Promise.all([compile(source),compile(baseline),compile(wrong)]);
 assert.deepEqual(old.inputs,current.inputs);assert.deepEqual(negative.inputs,current.inputs);
 const page=await build({absWorkingDir:web,bundle:true,write:false,format:'iife',platform:'browser',target:'chrome107',minify:false,metafile:true,logLevel:'silent',tsconfigRaw:{compilerOptions:{baseUrl:'.',paths:{'@/*':['./*']}}},
  stdin:{contents:`import {CustomMapEngine,geometryPath} from './lib/custom-map-engine.ts';import {mercatorUnproject} from './lib/custom-map-camera.ts';import {MAP_OUTSIDE_COLOR} from './public/maps/russia-viewport.js';import {runOpaqueVectorPixels} from '../tools/pages-preview/tests/fixtures/map-vector-opaque.mjs';window.runVectorAlphaGate=options=>runOpaqueVectorPixels({CustomMapEngine,geometryPath,mercatorUnproject,MAP_OUTSIDE_COLOR},options);`,resolveDir:web,sourcefile:'vector-alpha-fixture-entry.js'},
  plugins:[{name:'unconstructed-engine-worker-url',setup(plugin){plugin.onResolve({filter:/\?worker&url$/},args=>({path:args.path,namespace:'unused-worker-url'}));plugin.onLoad({filter:/.*/,namespace:'unused-worker-url'},()=>({contents:'export default "data:application/javascript,";',loader:'js'}));}}],
 });
 assert.equal(page.outputFiles.length,1);
 const sources={};
 for(const name of new Set([...current.inputs,...Object.keys(page.metafile.inputs)])){
  if(name==='vector-alpha-fixture-entry.js'||name.startsWith('unused-worker-url:'))continue;
  const path=resolve(web,name);assert.ok(path.startsWith(root+'/'));sources[path.slice(root.length+1)]=sha(await readFile(path));
 }
 const dependencySources=Object.fromEntries(current.inputs.filter(name=>resolve(web,name)!==workerPath).map(name=>['web/'+name,sources['web/'+name]]));
 assert.ok(dependencySources['web/lib/custom-map-painter.ts']);assert.ok(dependencySources['web/lib/custom-map-vector.ts']);
 return{page:page.outputFiles[0].text,workers:{production:current.code,baseline:old.code,forceOpaque:negative.code},sources,
  bindings:{workerSHA256:sha(source),painterSHA256:sources['web/lib/custom-map-painter.ts'],decoderSHA256:sources['web/lib/custom-map-vector.ts'],fixtureSHA256:sha(await readFile(fixturePath)),observerSHA256:sha(workerObserver),
   baseline:{kind:'same-production-worker-only-output-alpha-true',candidateExpression:alphaExpression,referenceExpression:'alpha:true',replacements:1,unchangedPrefixSHA256:sha(parts[0]),unchangedSuffixSHA256:sha(parts[1]),sourceSHA256:sha(baseline),unchangedDependencies:dependencySources},
   workerBundles:{productionSHA256:sha(current.code),baselineSHA256:sha(old.code),forceOpaqueSHA256:sha(negative.code)}}};
}

test('opaque vector parity fixture binds the actual worker and changes only the old alpha baseline',async()=>{
 const bundle=await productionBundle();assert.ok(bundle.page.includes('class CustomMapEngine')||bundle.page.includes('CustomMapEngine = class'));
 assert.ok(bundle.workers.production.includes('function decodeVectorTile'));assert.ok(bundle.workers.production.includes('function paintVectorTile'));
 assert.notEqual(bundle.bindings.workerBundles.productionSHA256,bundle.bindings.workerBundles.baselineSHA256);
 assert.equal(OPAQUE_VECTOR_CASES.length,8);assert.equal(new Set(OPAQUE_VECTOR_CASES.map(item=>item.name)).size,8);assert.ok(opaqueVectorFixtureBytes().length>1000);
});

test('opaque vector worker ImageBitmaps preserve every raw and composited browser pixel',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+240000,
},async t=>{
 assert.ok(binary,'A real Chromium binary is required for worker alpha pixel parity');
 const bundle=await productionBundle(),directory=await mkdtemp(join(tmpdir(),'tropnik-vector-alpha-'));
 const output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/vector-alpha');
 const report={schemaVersion:1,verified:false,diagnosticOnly:true,releaseEligible:false,parityPassed:false,phase:'browser-startup',evidence:'production-worker-transfer-and-engine-pixel-parity',sourceCommit:process.env.GITHUB_SHA||null,...bundle.bindings,sources:bundle.sources,expectedCases:32,expectedCompositeFrames:128,runs:[]};
 const content=new Map([['/','<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:512px;height:384px;overflow:hidden}</style><script src="/fixture.js"></script>'],['/fixture.js',bundle.page],['/worker-production.js',bundle.workers.production],['/worker-baseline.js',bundle.workers.baseline],['/worker-force-opaque.js',bundle.workers.forceOpaque]]);
 const server=createHTTPServer((request,response)=>{const path=new URL(request.url,'http://127.0.0.1').pathname,value=content.get(path);response.writeHead(value===undefined?404:200,{'content-type':path==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store'});response.end(value??'Not found');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const lease=createNetServer();await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory}));let socket;
 t.after(async()=>{socket?.close();await browser.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});await mkdir(output,{recursive:true});report.browserStartup=browser.diagnostics();await writeFile(join(output,'browser-vector-alpha-verification.json'),JSON.stringify(report,null,2)+'\n');});
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  const cdp={call:(method,params={},timeout=5000)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Vector alpha pixel CDP timeout: '+method));},timeout);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));})};
  const evaluate=async(expression,timeout)=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},timeout);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);assertNativeSurfaceCoverage(report.environment.nativeSurface);await mkdir(pictures,{recursive:true});
  for(const dpr of [1,2])for(const softwareRaster of [false,true]){
   report.phase=`dpr${dpr}-${softwareRaster?'software':'default'}`;
   await cdp.call('Emulation.setDeviceMetricsOverride',{width:512,height:384,deviceScaleFactor:dpr,mobile:false});await cdp.call('Page.navigate',{url:origin+'/'});
   let loaded=false;for(let attempt=0;attempt<60;attempt++){if(await evaluate("typeof window.runVectorAlphaGate==='function'")){loaded=true;break;}await sleep(50);}assert.ok(loaded,'Worker alpha pixel fixture did not load');
   const result=await evaluate(`window.runVectorAlphaGate(${JSON.stringify({dpr,softwareRaster,cases:OPAQUE_VECTOR_CASES,vectorBytes:opaqueVectorFixtureBytes()})})`,90000);report.runs.push(result);
   for(const item of result.cases){
    const captures=[];for(const capture of item.captures){for(const phase of ['baseline','candidate']){const file=`dpr${dpr}-${softwareRaster?'software':'default'}-${item.name}-${capture.name}-${phase}.png`,bytes=Buffer.from(capture[phase],'base64');assert.ok(bytes.length>=33&&bytes.length<=8*1024*1024);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),512*dpr);assert.equal(bytes.readUInt32BE(20),384*dpr);await writeFile(join(pictures,file),bytes);captures.push({phase,file,bytes:bytes.length,sha256:sha(bytes)});}}item.captures=captures;
    assert.equal(item.raw.differentPixels,0,`${item.name}: worker output pixels differ`);assert.equal(item.raw.maxChannelDelta,0);assert.equal(item.raw.baselinePixelSHA256,item.raw.candidatePixelSHA256);
    for(const frame of item.frames){assert.equal(frame.comparison.differentPixels,0,`${item.name}/${frame.name}: composited pixels differ`);assert.equal(frame.comparison.maxChannelDelta,0);assert.equal(frame.comparison.baselinePixelSHA256,frame.comparison.candidatePixelSHA256);}
    assert.equal(item.verified,true,item.error);
   }
   assert.equal(result.verified,true);assert.equal(result.cases.length,8);assert.equal(result.negativeControls.length,4);
  }
  assert.equal(report.runs.flatMap(run=>run.cases).length,report.expectedCases);assert.equal(report.runs.flatMap(run=>run.cases).flatMap(item=>item.frames).length,report.expectedCompositeFrames);
  report.verified=true;report.parityPassed=true;report.phase='complete';
 }catch(error){report.error=browserErrorDetails(error);throw error;}
});
