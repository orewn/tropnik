import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer as createHTTPServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,extname,join,relative,resolve} from 'node:path';
import {launchBrowser,BROWSER_STARTUP_LIMITS,browserErrorDetails} from '../browser-startup.mjs';
import {browserEnvironmentArgs,collectBrowserEnvironment} from '../browser-environment.mjs';
import {collectNativeBrowserSurface,assertNativeSurfaceCoverage} from '../browser-native-surface.mjs';
import {TILE_OPACITY_BASELINE,TILE_OPACITY_CANDIDATE_SHA256,TILE_OPACITY_BASELINE_ROOT,TILE_OPACITY_BASELINE_DEPENDENCIES,TILE_OPACITY_BASELINE_FILES,TILE_OPACITY_WORKER_DEPENDENCIES,TILE_OPACITY_WORKER_FILES,TILE_OPACITY_ASSETS,TILE_OPACITY_CASES,TILE_OPACITY_MATRIX,TILE_OPACITY_FIXTURE,TILE_OPACITY_HELPER,assertTileOpacityWorkerInputs,assertTileOpacityReceipt,assertTileOpacityFiles,tileOpacityCaseKey,tileOpacityPNGName} from '../browser-map-tile-opacity-receipt.mjs';

const root=resolve(import.meta.dirname,'../../..'),web=join(root,'web'),require=createRequire(join(web,'package.json'));
const {build}=createRequire(require.resolve('vite'))('esbuild');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const binary=['google-chrome','google-chrome-stable','chromium','chromium-browser'].find(name=>spawnSync('which',[name],{stdio:'ignore'}).status===0);

/** Both workers execute their actual production handler. These two observers
 * forward the original native calls unchanged. An additional message records
 * getContextAttributes and the genuine ImageBitmap detachment after transfer;
 * no painting, decoded bytes or returned pixels are replaced. */
function observeNativeWorker(){
 const contexts=[],nativeContext=OffscreenCanvas.prototype.getContext,nativePost=self.postMessage;
 OffscreenCanvas.prototype.getContext=function(...args){
  const result=Reflect.apply(nativeContext,this,args);
  if(args[0]==='2d')contexts.push({type:args[0],width:this.width,height:this.height,requested:args[1]??{},native:result instanceof OffscreenCanvasRenderingContext2D,actual:result?.getContextAttributes()});
  return result;
 };
 self.postMessage=function(...args){
  const message=args[0];
  if(!(message?.bitmap instanceof ImageBitmap))return Reflect.apply(nativePost,self,args);
  const bitmap=message.bitmap,list=Array.isArray(args[1])?args[1]:args[1]?.transfer;
  const transfer={nativeBitmap:true,count:list?.length??0,includesBitmap:list?.includes(bitmap)??false,beforeDimensions:[bitmap.width,bitmap.height]};
  const returned=Reflect.apply(nativePost,self,args);transfer.afterDimensions=[bitmap.width,bitmap.height];
  Reflect.apply(nativePost,self,[{tileOpacityObservation:true,id:message.id,contexts,transfer}]);return returned;
 };
}

async function productionBundle(readSource=readFile){
 const options={absWorkingDir:web,bundle:true,write:false,format:'iife',platform:'browser',target:'chrome107',minify:false,metafile:true,logLevel:'silent',tsconfigRaw:{compilerOptions:{baseUrl:'.',paths:{'@/*':['./*']}}}};
 const inputPaths=result=>Object.keys(result.metafile.inputs).filter(path=>path!=='tile-opacity-fixture-entry.js').map(path=>relative(root,resolve(web,path)).split('\\').join('/')).sort();
 const worker=async side=>{
  const expected=side==='baseline'?TILE_OPACITY_BASELINE_FILES:TILE_OPACITY_WORKER_FILES;
  const entry=side==='baseline'?`${TILE_OPACITY_BASELINE_ROOT}/web/lib/custom-map-tiles.worker.ts`:'web/lib/custom-map-tiles.worker.ts';
  const result=await build({...options,entryPoints:[join(root,entry)],banner:{js:`(${observeNativeWorker.toString()})();`},plugins:[{name:'complete-reviewed-worker-sources',setup(plugin){
   plugin.onLoad({filter:/.*/},async args=>{
    const path=relative(root,args.path).split('\\').join('/');assert.ok(Object.hasOwn(expected,path),'Unreviewed '+side+' worker dependency: '+path);
    const bytes=await readSource(args.path);assert.equal(digest(bytes),expected[path],'Reviewed '+side+' worker source changed: '+path);
    return{contents:bytes.toString('utf8'),loader:extname(args.path)==='.ts'?'ts':'js',resolveDir:dirname(args.path)};
   });
  }}]});
  assertTileOpacityWorkerInputs(inputPaths(result),side);return result;
 };
 // The old worker resolves only beneath its frozen snapshot. Current painter
 // or decoder edits can never be silently shared by the reference side.
 const [before,after]=await Promise.all([worker('baseline'),worker('candidate')]);
 // Real pixel workers are bundled above; engine constructors are not run by this IIFE fixture.
 const main=await build({...options,define:{'import.meta.url':'location.href'},stdin:{contents:`import {CustomMapEngine} from './lib/custom-map-engine.ts';import {mercatorUnproject} from './lib/custom-map-camera.ts';window.runTileOpacityGate=options=>(${runProductionPixels.toString()})({CustomMapEngine,mercatorUnproject},options);`,resolveDir:web,sourcefile:'tile-opacity-fixture-entry.js'}});
 for(const result of [before,after,main])assert.equal(result.outputFiles.length,1);
 const workerInputs={baseline:inputPaths(before),candidate:inputPaths(after)};
 const paths=new Set([...inputPaths(main),...workerInputs.baseline,...workerInputs.candidate]);
 for(const path of [TILE_OPACITY_FIXTURE,TILE_OPACITY_HELPER,'tools/pages-preview/browser-startup.mjs','tools/pages-preview/browser-environment.mjs','tools/pages-preview/browser-native-surface.mjs'])paths.add(path);
 const assets=[];
 for(const asset of TILE_OPACITY_ASSETS){const bytes=await readFile(join(root,asset.path));assert.equal(digest(bytes),asset.sha256);assets.push({...asset,bytes:bytes.length,content:bytes});paths.add(asset.path);}
 const sources=[];for(const path of [...paths].sort()){const bytes=await readFile(join(root,path));sources.push({path,bytes:bytes.length,sha256:digest(bytes)});}
 return{main:main.outputFiles[0].text,baseline:before.outputFiles[0].text,candidate:after.outputFiles[0].text,workerInputs,sources,assets};
}

// This function runs in Chromium. Output images come from real production
// Workers, not synthetic substitute bitmaps. The only fixture paint is an
// adversarial opaque background under the production worldTransform/drawTiles.
async function runProductionPixels({CustomMapEngine,mercatorUnproject},options){
 const {definition,dpr,softwareRaster}=options;
 const result={name:definition.name,definition,dpr,nativeDpr:devicePixelRatio,softwareRaster,verified:false,captures:[],workers:{},cleanup:{workersCreated:0,workersTerminated:0,bitmapsReceived:0,bitmapsClosed:0,closedDimensions:[],pendingJobs:0}};
 const check=(value,message)=>{if(!value)throw new Error(message);},workers=[],bitmaps=[],surfaces=[],pending=new Set();
 const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
 const diff=(a,b)=>{check(a.length===b.length,'RGBA dimensions changed');let differentPixels=0,maxChannelDelta=0;for(let i=0;i<a.length;i+=4){let changed=false;for(let c=0;c<4;c++){const delta=Math.abs(a[i+c]-b[i+c]);if(delta){changed=true;maxChannelDelta=Math.max(maxChannelDelta,delta);}}if(changed)differentPixels++;}return{differentPixels,maxChannelDelta,totalPixels:a.length/4};};
 const alpha=bytes=>{const counts={opaquePixels:0,transparentPixels:0,translucentPixels:0};for(let i=3;i<bytes.length;i+=4)counts[bytes[i]===255?'opaquePixels':bytes[i]===0?'transparentPixels':'translucentPixels']++;return counts;};
 const surface=(width,height,transparent)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;surfaces.push(canvas);const context=canvas.getContext('2d',{alpha:transparent,willReadFrequently:softwareRaster});check(context,'Native canvas context unavailable');return{canvas,context};};
 try{
  check(devicePixelRatio===dpr,'Actual native DPR differs');
  const source=definition.asset?await fetch('/asset/'+definition.asset,{cache:'no-store'}).then(response=>{check(response.ok,'Pinned asset request failed');return response.arrayBuffer();}):new ArrayBuffer(0);
  result.input={bytes:source.byteLength,sha256:await hash(source)};check(result.input.sha256===options.assetSHA256,'Browser asset bytes differ from the pinned source');
  const job={id:1,kind:definition.kind,z:definition.z,x:definition.x,y:definition.y,sourceZ:definition.sourceZ??definition.z,paintZoom:definition.z,paths:true,transparent:definition.transparent,boundaries:true,softwareRaster,sourceKey:options.sourceKey,...(definition.mime?{mime:definition.mime}:{})};
  const render=async side=>{
   const worker=new Worker('/'+side+'-worker.js');workers.push(worker);result.cleanup.workersCreated++;
   const bytes=source.slice(0),inputTransfer={beforeBytes:bytes.byteLength,afterBytes:null};let timer,finished=false,payload,observation;
   const output=await new Promise((resolve,reject)=>{
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);pending.delete(cancel);worker.onmessage=null;worker.onerror=null;error?reject(error):resolve(value);};
    const cancel=()=>finish(new Error('Worker cleanup interrupted pending tile'));pending.add(cancel);
    timer=setTimeout(()=>finish(new Error('Native worker tile/transfer acknowledgement timed out')),15000);
    worker.onerror=event=>finish(new Error(event.message||'Native worker failed'));
    worker.onmessage=event=>{
     try{
      const data=event.data;check(data.id===job.id,'Worker returned another job');if(data.error)throw new Error(data.error);
      if(data.tileOpacityObservation){check(!observation,'Duplicate native observation');observation=data;}
      else{check(!payload&&data.bitmap instanceof ImageBitmap,'Worker did not transfer one native ImageBitmap');payload=data;bitmaps.push(data.bitmap);result.cleanup.bitmapsReceived++;}
      if(payload&&observation)finish(null,{payload,observation});
     }catch(error){finish(error);}
    };
    worker.postMessage({...job,bytes},{transfer:[bytes]});inputTransfer.afterBytes=bytes.byteLength;
   });
   const {payload:message,observation:observed}=output;
   result.workers[side]={receivedBitmap:message.bitmap instanceof ImageBitmap,receivedDimensions:[message.bitmap.width,message.bitmap.height],inputTransfer,contexts:observed.contexts,transfer:observed.transfer};
   return message;
  };
  const baseline=await render('baseline'),candidate=await render('candidate');
  const metadata=value=>({labels:value.labels,contours:value.contours,reliefCoverage:value.reliefCoverage??null});
  result.metadata={baseline:metadata(baseline),candidate:metadata(candidate),equal:JSON.stringify(metadata(baseline))===JSON.stringify(metadata(candidate))};
  const tileBefore=surface(512,512,true),tileAfter=surface(512,512,true);
  tileBefore.context.drawImage(baseline.bitmap,0,0);tileAfter.context.drawImage(candidate.bitmap,0,0);
  const tileA=tileBefore.context.getImageData(0,0,512,512).data,tileB=tileAfter.context.getImageData(0,0,512,512).data;
  result.tile={width:512,height:512,comparison:diff(tileA,tileB),baselinePixelSHA256:await hash(tileA),candidatePixelSHA256:await hash(tileB),baselineAlpha:alpha(tileA),candidateAlpha:alpha(tileB)};
  const width=Math.round(512*dpr),height=Math.round(384*dpr),zoom=definition.z-.37,scale=256*2**zoom,n=2**definition.z;
  const center={x:(definition.x+.5)/n+.375/scale,y:(definition.y+.5)/n+.625/scale};
  const background=context=>{context.fillStyle='#537e94';context.fillRect(0,0,width,height);context.fillStyle='#d5a46d';for(let y=0;y<height;y+=47)for(let x=0;x<width;x+=61)if((Math.floor(x/61)+Math.floor(y/47))%2===0)context.fillRect(x,y,31,23);};
  const capture=(phase,target,rgbaSHA256)=>result.captures.push({phase,width:target.canvas.width,height:target.canvas.height,rgbaSHA256,png:target.canvas.toDataURL('image/png').split(',')[1]});
  capture('baseline-tile',tileBefore,result.tile.baselinePixelSHA256);capture('candidate-tile',tileAfter,result.tile.candidatePixelSHA256);
  for(const [key,bearing,pitch]of [['world',0,0],['affine',17.3,25]]){
   const camera={center:mercatorUnproject(center),zoom,bearingDegrees:bearing},before=surface(width,height,false),after=surface(width,height,false);
   background(before.context);background(after.context);const empty=before.context.getImageData(0,0,width,height).data,drawCalls={baseline:0,candidate:0};let transform;
   const paint=(side,target,bitmap)=>{
    const context=target.context,engine=Object.create(CustomMapEngine.prototype);
    Object.assign(engine,{canvas:target.canvas,context,pixelRatio:dpr,size:{width:512,height:384},camera,pitch});
    const native=context.drawImage;context.drawImage=function(...args){drawCalls[side]++;return Reflect.apply(native,this,args);};
    try{engine.worldTransform();const matrix=context.getTransform();transform=[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f];engine.drawTiles({kind:definition.kind,tiles:[{kind:definition.kind,z:definition.z,x:definition.x,y:definition.y,bitmap}]},definition.kind==='relief'?.82:1);}
    finally{context.drawImage=native;}
   };
   paint('baseline',before,baseline.bitmap);paint('candidate',after,candidate.bitmap);
   const a=before.context.getImageData(0,0,width,height).data,b=after.context.getImageData(0,0,width,height).data;
   result[key]={width,height,camera,pitch,transform,alpha:definition.kind==='relief'?.82:1,productionWorldTransform:true,productionDrawTiles:true,drawCalls,comparison:diff(a,b),baselinePixelSHA256:await hash(a),candidatePixelSHA256:await hash(b),visiblePixels:diff(empty,a).differentPixels};
   capture('baseline-'+key,before,result[key].baselinePixelSHA256);capture('candidate-'+key,after,result[key].candidatePixelSHA256);
  }
  check(result.metadata.equal,'Worker label/contour/relief metadata changed');
  for(const [label,frame]of [['tile',result.tile],['world',result.world],['affine',result.affine]])check(frame.comparison.differentPixels===0&&frame.comparison.maxChannelDelta===0,definition.name+'/'+label+': '+frame.comparison.differentPixels+' pixels differ; max channel delta '+frame.comparison.maxChannelDelta);
  result.verified=true;return result;
 }catch(error){result.error=String(error.stack||error);return result;}
 finally{
  for(const cancel of [...pending])cancel();for(const worker of workers){worker.terminate();result.cleanup.workersTerminated++;}
  for(const bitmap of bitmaps){bitmap.close();result.cleanup.bitmapsClosed++;result.cleanup.closedDimensions.push([bitmap.width,bitmap.height]);}
  result.cleanup.pendingJobs=pending.size;for(const canvas of surfaces){canvas.width=1;canvas.height=1;canvas.remove();}
 }
}

test('tile opacity fixture bundles the complete exact old worker separately from current production sources',async()=>{
 const bundle=await productionBundle();assert.ok(bundle.main.length>10000);assert.ok(bundle.baseline.length>10000);assert.notEqual(bundle.baseline,bundle.candidate);
 assert.equal(bundle.assets.length,4);assert.ok(bundle.sources.some(source=>source.path==='web/lib/custom-map-engine.ts'));
 assert.deepEqual(bundle.workerInputs.baseline,Object.keys(TILE_OPACITY_BASELINE_FILES).sort());assert.deepEqual(bundle.workerInputs.candidate,Object.keys(TILE_OPACITY_WORKER_FILES).sort());
 for(const [path,sha256]of Object.entries(TILE_OPACITY_BASELINE_FILES))assert.equal(bundle.sources.find(source=>source.path===path)?.sha256,sha256);
});

test('tile opacity bundles reject edited sources on both sides instead of sharing a changed painter',async()=>{
 for(const path of [...Object.keys(TILE_OPACITY_BASELINE_FILES),...Object.keys(TILE_OPACITY_WORKER_FILES)]){
  const changed=join(root,path);
  await assert.rejects(productionBundle(async filename=>{const bytes=await readFile(filename);return filename===changed?Buffer.concat([bytes,Buffer.from('\n// unreviewed edit\n')]):bytes;}),/Reviewed (baseline|candidate) worker source changed/);
 }
});

test('real worker opaque tiles preserve every native RGBA pixel and fractional world composition',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+150000,
},async()=>{
 assert.ok(binary,'A real Chromium binary is required for tile opacity parity');
 const bundle=await productionBundle(),directory=await mkdtemp(join(tmpdir(),'tropnik-tile-opacity-'));
 const output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/map-tile-opacity');
 const buildInfo=JSON.parse(await readFile(join(output,'build-info.json'),'utf8'));
 const fileRecord=async path=>{const bytes=await readFile(join(root,path));return{path,bytes:bytes.length,sha256:digest(bytes)};};
 const runtimeWeb=await fileRecord('web/public/custom-map/manifest.json'),runtimeNative=await fileRecord('android/app/src/main/assets/custom-map/manifest.json');
 const manifest=JSON.parse(await readFile(join(root,runtimeWeb.path),'utf8'));bundle.sources.push(runtimeWeb);bundle.sources.sort((a,b)=>a.path.localeCompare(b.path));
 const report={schemaVersion:1,evidence:'production-native-worker-tile-opacity-pixel-parity',verified:false,phase:'browser-startup',sourceCommit:process.env.GITHUB_SHA||null,buildId:buildInfo.buildId,
  baseline:TILE_OPACITY_BASELINE,baselineWorkerDependencies:TILE_OPACITY_BASELINE_DEPENDENCIES,workerSHA256:TILE_OPACITY_CANDIDATE_SHA256,workerDependencies:TILE_OPACITY_WORKER_DEPENDENCIES,workerInputs:bundle.workerInputs,
  fixture:bundle.sources.find(source=>source.path===TILE_OPACITY_FIXTURE),helper:bundle.sources.find(source=>source.path===TILE_OPACITY_HELPER),sources:bundle.sources,
  runtime:{web:runtimeWeb,native:runtimeNative,sourceInputsSha256:manifest.sourceInputsSha256},assets:bundle.assets.map(({content,...asset})=>asset),matrix:TILE_OPACITY_MATRIX,cases:[],totals:{cases:0,comparisons:0,pngs:0,workers:0}};
 assert.equal(buildInfo.sourceCommit,report.sourceCommit,'The browser gate must run on the exact built source');
 const server=createHTTPServer((request,response)=>{
  const path=new URL(request.url,'http://127.0.0.1').pathname;
  const content=path==='/'?'<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100vw;height:100vh;overflow:hidden}</style><script src="/fixture.js"></script>':path==='/fixture.js'?bundle.main:path==='/baseline-worker.js'?bundle.baseline:path==='/candidate-worker.js'?bundle.candidate:path.startsWith('/asset/')?bundle.assets.find(asset=>path==='/asset/'+asset.id)?.content:null;
  response.writeHead(content==null?404:200,{'content-type':path==='/'?'text/html; charset=utf-8':path.startsWith('/asset/')?'application/octet-stream':'text/javascript; charset=utf-8','cache-control':'no-store'});response.end(content??'Not found');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const lease=createNetServer();await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory}));let socket,failure;
 const pending=new Map();
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  const cdp={call:(method,params={},timeout=5000)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Tile opacity CDP timeout: '+method));},timeout);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));})};
  const evaluate=async(expression,timeout)=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},timeout);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);assertNativeSurfaceCoverage(report.environment.nativeSurface);
  await mkdir(pictures,{recursive:true});
  for(const dpr of TILE_OPACITY_MATRIX.dpr){
   await cdp.call('Emulation.setDeviceMetricsOverride',{width:512,height:384,deviceScaleFactor:dpr,mobile:false});await cdp.call('Page.navigate',{url:origin+'/'});
   let loaded=false;for(let attempt=0;attempt<60;attempt++){if(await evaluate("typeof window.runTileOpacityGate==='function'")){loaded=true;break;}await pause(50);}assert.ok(loaded,'The real worker opacity fixture did not load');
   for(const softwareRaster of TILE_OPACITY_MATRIX.softwareRaster)for(const definition of TILE_OPACITY_CASES){
    report.phase=tileOpacityCaseKey({...definition,dpr,softwareRaster});const asset=bundle.assets.find(value=>value.id===definition.asset);
    const result=await evaluate(`window.runTileOpacityGate(${JSON.stringify({definition,dpr,softwareRaster,assetSHA256:asset?.sha256??digest(new Uint8Array()),sourceKey:asset?asset.path.slice('web/public'.length):'empty-vector-fixture'})})`,40000);report.cases.push(result);
    const captures=[];for(const capture of result.captures){const bytes=Buffer.from(capture.png,'base64'),file=tileOpacityPNGName(result,capture.phase);assert.ok(bytes.length>=33&&bytes.length<=8*1024*1024);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[capture.width,capture.height]);await writeFile(join(pictures,file),bytes);const {png,...metadata}=capture;captures.push({...metadata,file,bytes:bytes.length,sha256:digest(bytes)});}result.captures=captures;
    report.totals={cases:report.cases.length,comparisons:report.cases.reduce((sum,item)=>sum+Number(!!item.tile)+Number(!!item.world)+Number(!!item.affine),0),pngs:report.cases.reduce((sum,item)=>sum+item.captures.length,0),workers:report.cases.reduce((sum,item)=>sum+item.cleanup.workersCreated,0)};
    assert.equal(result.verified,true,result.error);
   }
  }
  report.phase='complete';
 }catch(error){failure=error;report.error=browserErrorDetails(error);}
 finally{
  for(const waiter of pending.values())waiter.reject(new Error('Browser cleanup'));pending.clear();socket?.close();await browser.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
  report.browserStartup=browser.diagnostics();
  if(!failure){try{report.verified=true;assertTileOpacityReceipt(report,{sourceCommit:report.sourceCommit,buildId:buildInfo.buildId});assertTileOpacityFiles(report,{root,build:buildInfo});}catch(error){report.verified=false;failure=error;report.error=browserErrorDetails(error);}}
  await mkdir(output,{recursive:true});await writeFile(join(output,'browser-map-tile-opacity-verification.json'),JSON.stringify(report,null,2)+'\n');
 }
 if(failure)throw failure;
});
