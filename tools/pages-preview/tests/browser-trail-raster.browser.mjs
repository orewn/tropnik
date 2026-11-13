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

const root=resolve(import.meta.dirname,'../../..'),web=join(root,'web'),require=createRequire(join(web,'package.json'));
const buildRequire=createRequire(require.resolve('vite')),{build}=buildRequire('esbuild');
const binary=['google-chrome','google-chrome-stable','chromium','chromium-browser'].find(name=>spawnSync('which',[name],{stdio:'ignore'}).status===0);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const DPR=[1,1.5,2],PALETTES=['relief','satellite'],SCENARIOS=['disconnected','antimeridian','rotated-pitched','country'];

/** Both sides execute production code. The reference uses the original
 * combined Path2D stroke; the candidate uses the actual manager, native Worker,
 * OffscreenCanvas and transferred ImageBitmap. Nothing replaces Canvas paint. */
async function productionBundle(){
 const metadata=JSON.parse(await readFile(join(web,'lib/trail-overlay.generated.json'),'utf8'));
 const catalogue=await readFile(join(web,'public',metadata.url.split('?')[0]));
 assert.equal(digest(catalogue),metadata.sha256);
 const parsed=JSON.parse(catalogue);assert.equal(parsed.sources.length,metadata.uniqueGeometries);
 const options={absWorkingDir:web,bundle:true,write:false,format:'iife',platform:'browser',target:'chrome107',minify:false,metafile:true,logLevel:'silent',tsconfigRaw:{compilerOptions:{baseUrl:'.',paths:{'@/*':['./*']}}}};
 const worker=await build({...options,entryPoints:['lib/custom-map-trail-raster.worker.ts']});
 const main=await build({...options,
  stdin:{contents:`import {CustomMapTrailRaster} from './lib/custom-map-trail-raster.ts';import {geometryPath} from './lib/custom-map-engine.ts';import {mercatorProject,fitBounds} from './lib/custom-map-camera.ts';import {decodeOverlayLine} from './lib/map-trail-overlay.ts';import {mapCanvasPolicy} from './lib/map-canvas-policy.ts';window.runTrailRasterGate=options=>(${runProductionPixels.toString()})({CustomMapTrailRaster,geometryPath,mercatorProject,fitBounds,decodeOverlayLine,mapCanvasPolicy},options);`,resolveDir:web,sourcefile:'trail-raster-fixture-entry.js'},
  plugins:[{name:'real-trail-worker-url',setup(plugin){
   plugin.onResolve({filter:/\?worker&url$/},args=>({path:args.path,namespace:'worker-url'}));
   plugin.onLoad({filter:/.*/,namespace:'worker-url'},args=>({contents:`export default ${JSON.stringify(args.path.includes('custom-map-trail-raster.worker')?'/raster-worker.js':'data:application/javascript,')};`,loader:'js'}));
  }}],
 });
 assert.equal(main.outputFiles.length,1);assert.equal(worker.outputFiles.length,1);
 const sources={};
 for(const name of new Set([...Object.keys(main.metafile.inputs),...Object.keys(worker.metafile.inputs)])){
  if(name==='trail-raster-fixture-entry.js'||name.startsWith('worker-url:'))continue;
  const path=resolve(web,name);assert.ok(path.startsWith(web+'/'));sources['web/'+name]=digest(await readFile(path));
 }
 for(const name of ['custom-map-trail-raster.ts','custom-map-trail-raster.worker.ts','custom-map-engine.ts','map-trail-overlay.ts'])assert.ok(sources['web/lib/'+name]);
 return{main:main.outputFiles[0].text,worker:worker.outputFiles[0].text,catalogue,metadata,sources};
}

async function runProductionPixels({CustomMapTrailRaster,geometryPath,mercatorProject,fitBounds,decodeOverlayLine,mapCanvasPolicy},options){
 const check=(condition,message)=>{if(!condition)throw new Error(message);};
 const {name,palette,dpr}=options,width=768,height=512;
 check(options.previewOnly===true||devicePixelRatio===dpr,'Native emulated DPR differs from the requested pixel case');
 const basePath=options.basePath??'/';
 const policy=mapCanvasPolicy(document),surfaces=[],result={name,palette,dpr,nativeDpr:devicePixelRatio,previewOnly:options.previewOnly===true,verified:false,policy,captures:[]};
 let manager,workerCount=0;
 const wait=async(read,accept,label)=>{const deadline=performance.now()+15000;for(;;){const value=read();if(accept(value))return value;if(performance.now()>=deadline)throw new Error(label+': '+JSON.stringify(value));await new Promise(resolve=>setTimeout(resolve,16));}};
 const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
 const diff=(a,b)=>{check(a.length===b.length,'Pixel dimensions differ');let pixels=0,max=0,total=0;const histogram={};for(let i=0;i<a.length;i+=4){let changed=false;for(let c=0;c<4;c++){const delta=Math.abs(a[i+c]-b[i+c]);if(delta){changed=true;max=Math.max(max,delta);total+=delta;histogram[delta]=(histogram[delta]??0)+1;}}if(changed)pixels++;}return{differentPixels:pixels,maxChannelDelta:max,totalChannelDelta:total,totalPixels:a.length/4,deltaHistogram:histogram};};
 try{
  let lines,camera,bearing=0,pitch=0;
  if(name==='country'){
   const response=await fetch(basePath+'catalogue.json');check(response.ok,'Exact catalogue fixture failed to load');const catalogue=await response.json();
   lines=catalogue.sources.flatMap(source=>source.parts.map(part=>decodeOverlayLine(part[1])));
   camera=fitBounds([19.6389282,41.1858711,191.0026658,81.858721],{width,height},{padding:{top:24,right:24,bottom:24,left:24},minZoom:0,maxZoom:8,referenceLongitude:105});
   result.sources=catalogue.sources.length;check(result.sources===options.expectedSources,'Country source count differs from hashed metadata');
  }else if(name==='antimeridian'){
   lines=[[[179.2,64],[179.8,64.12],[-179.9,64.05],[-179.3,64.2]],[[-179.6,63.83],[-179.3,63.78]]];camera={center:[180,64],zoom:8.25};
  }else{
   lines=[[[87.05,49.85],[87.2,49.98],[87.34,49.88]],[[87.56,50.06],[87.73,50.2]],[[87.17,50.18],[87.3,50.22],[87.34,50.08]]];camera={center:[87.4,50.04],zoom:8.25};
   if(name==='rotated-pitched'){bearing=17.3;pitch=25;}
  }
  const batch=new Path2D(),parts=lines.map((line,index)=>{
   batch.addPath(geometryPath({type:'LineString',coordinates:line}).path);
   let previous=105;const points=new Float64Array(line.length*2);
   for(let i=0;i<line.length;i++){const longitude=line[i][0]+360*Math.round((previous-line[i][0])/360);previous=longitude;const point=mercatorProject([longitude,line[i][1]]);points[i*2]=point.x;points[i*2+1]=point.y;}
   return{id:index+1,points};
  });
  const center=mercatorProject(camera.center),scale=256*2**camera.zoom,lineWidth=camera.zoom<8?1.4:2;
  const matrix=new DOMMatrix().scale(dpr,dpr).translate(width/2,height/2).scale(1,Math.cos(pitch*Math.PI/180)).rotate(-bearing).scale(scale,scale).translate(-center.x,-center.y);
  const transform=[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f],physicalWidth=Math.round(width*dpr),physicalHeight=Math.round(height*dpr);
  const frame={parts,width:physicalWidth,height:physicalHeight,transform,haloWidth:(lineWidth+2)/scale,lineWidth:lineWidth/scale,haloColor:palette==='satellite'?'rgba(30,48,37,.9)':'rgba(255,254,245,.9)',lineColor:palette==='satellite'?'#f2d49b':'#618253'};
  const surface=(transparent=false)=>{const canvas=document.createElement('canvas');canvas.width=physicalWidth;canvas.height=physicalHeight;surfaces.push(canvas);const context=canvas.getContext('2d',{alpha:transparent,willReadFrequently:policy.softwareRaster});if(!transparent){context.fillStyle=palette==='satellite'?'#52624f':'#dce5cf';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle=palette==='satellite'?'#365f77':'#bcd4dc';for(let y=0;y<canvas.height;y+=71)for(let x=0;x<canvas.width;x+=97)if((Math.floor(x/97)+Math.floor(y/71))%3===0)context.fillRect(x,y,39,31);}return{canvas,context};};
  const reference=surface(),actual=surface(),empty=actual.context.getImageData(0,0,physicalWidth,physicalHeight).data;
  const referenceRaster=surface(true),actualRaster=surface(true);
  const direct=context=>{context.setTransform(...transform);context.lineCap='round';context.lineJoin='round';context.strokeStyle=frame.haloColor;context.lineWidth=frame.haloWidth;context.stroke(batch);context.strokeStyle=frame.lineColor;context.lineWidth=frame.lineWidth;context.stroke(batch);};
  direct(reference.context);direct(referenceRaster.context);
  let changes=0;manager=new CustomMapTrailRaster({softwareRaster:policy.softwareRaster,onChange:()=>{changes++;},createWorker:()=>{workerCount++;return new Worker(basePath+'raster-worker.js',{type:'module'});}});
  const first=manager.request(frame);check(first===undefined,'Cold raster request unexpectedly returned an old bitmap');
  const committed=await wait(()=>{const state=manager.getState();if(state.error)throw new Error(state.error);return manager.request(frame);},value=>!!value,'Real worker raster did not commit');
  check(workerCount===1&&changes>0&&committed.bitmap instanceof ImageBitmap,'No genuine worker ImageBitmap was committed');
  check(committed.width===physicalWidth&&committed.height===physicalHeight,'Worker raster dimensions changed');
  actual.context.setTransform(1,0,0,1,0,0);actual.context.drawImage(committed.bitmap,0,0);
  actualRaster.context.drawImage(committed.bitmap,0,0);
  const before=reference.context.getImageData(0,0,physicalWidth,physicalHeight).data,after=actual.context.getImageData(0,0,physicalWidth,physicalHeight).data;
  const rasterBefore=referenceRaster.context.getImageData(0,0,physicalWidth,physicalHeight).data,rasterAfter=actualRaster.context.getImageData(0,0,physicalWidth,physicalHeight).data;
  result.frame={width:physicalWidth,height:physicalHeight,camera,bearing,pitch,transform,parts:parts.length,vertices:parts.reduce((sum,part)=>sum+part.points.length/2,0)};
  result.nativeWorker={count:workerCount,changes,state:manager.getState(),bitmap:true};
  result.comparison=diff(before,after);result.visibleInk=diff(empty,before);check(result.visibleInk.differentPixels>0,'Reference fixture has no visible source geometry');
  result.rasterComparison=diff(rasterBefore,rasterAfter);result.referenceRasterPixelSHA256=await hash(rasterBefore);result.workerRasterPixelSHA256=await hash(rasterAfter);
  result.referencePixelSHA256=await hash(before);result.workerPixelSHA256=await hash(after);
  result.captures=[{phase:'reference',png:reference.canvas.toDataURL('image/png').split(',')[1]},{phase:'worker',png:actual.canvas.toDataURL('image/png').split(',')[1]}];
  // Geometry, antialias coverage and both source colors must match bit for bit
  // before composition. Applying that exact premultiplied 8-bit bitmap over an
  // opaque background adds one rounding boundary versus the original two direct
  // strokes. The separate opaque proof permits only its measured 1–2 LSB delta.
  check(result.rasterComparison.differentPixels===0&&result.referenceRasterPixelSHA256===result.workerRasterPixelSHA256,`${name}/${palette}/dpr${dpr}: transparent raster changed ${result.rasterComparison.differentPixels} pixels (max ${result.rasterComparison.maxChannelDelta})`);
  check(result.comparison.maxChannelDelta<=2,`${name}/${palette}/dpr${dpr}: opaque composition exceeds 2 LSB (${result.comparison.maxChannelDelta})`);
  check(manager.request(frame)?.bitmap===committed.bitmap,'Identical raster frame failed to reuse its committed bitmap');
  result.verified=true;return result;
 }catch(error){result.error=String(error.stack||error);return result;}
 finally{manager?.destroy();for(const canvas of surfaces)canvas.remove();}
}

async function writePreviewFixture(directory,basePath){
 assert.ok(directory&&basePath?.startsWith('/')&&basePath.endsWith('/'),'Preview output and scoped URL are required');
 const bundle=await productionBundle();await mkdir(directory,{recursive:true});
 await Promise.all([writeFile(join(directory,'fixture.js'),bundle.main),writeFile(join(directory,'raster-worker.js'),bundle.worker),writeFile(join(directory,'catalogue.json'),bundle.catalogue)]);
 const config={basePath,expectedSources:bundle.metadata.uniqueGeometries,dpr:DPR,palettes:PALETTES,scenarios:SCENARIOS};
 const html='<!doctype html><meta charset="utf-8"><title>Temporary trail raster pixel diagnosis</title><h1>Trail raster pixel diagnosis</h1><p>This isolated fixture is diagnostic only. Backing scales are explicit; native browser DPR is reported separately.</p><p id="progress">Loading production modules…</p><div id="comparison"></div><pre id="report"></pre><script src="'+basePath+'fixture.js"></script><script>'+`(async()=>{const config=${JSON.stringify(config)},report={verified:false,releaseEligible:false,previewOnly:true,nativeDpr:devicePixelRatio,sourceHashes:${JSON.stringify(bundle.sources)},overlaySHA256:${JSON.stringify(bundle.metadata.sha256)},cases:[]};window.trailRasterPreview=report;try{for(const dpr of config.dpr)for(const name of config.scenarios)for(const palette of config.palettes){document.getElementById('progress').textContent='Running '+name+' / '+palette+' / backing scale '+dpr;const result=await window.runTrailRasterGate({name,palette,dpr,basePath:config.basePath,expectedSources:config.expectedSources,previewOnly:true});const captures=result.captures;delete result.captures;if(result.error)result.error=result.error.slice(0,1500);report.cases.push(result);if(!result.verified&&!document.getElementById('comparison').children.length)for(const capture of captures){const image=document.createElement('img');image.src='data:image/png;base64,'+capture.png;image.alt=capture.phase;image.style.width='384px';document.getElementById('comparison').appendChild(image);}document.getElementById('report').textContent=JSON.stringify(report,null,2);}report.complete=true;report.pixelCasesPassed=report.cases.filter(result=>result.verified).length;document.getElementById('progress').textContent='Complete: '+report.pixelCasesPassed+'/'+report.cases.length+' exact pixel cases';}catch(error){report.error=String(error.stack||error);document.getElementById('progress').textContent='Failed: '+report.error;}document.getElementById('report').textContent=JSON.stringify(report,null,2);})()`+'</script>';
 await writeFile(join(directory,'index.html'),html);
 console.log(JSON.stringify({previewOnly:true,verified:false,releaseEligible:false,directory,basePath,overlaySHA256:bundle.metadata.sha256,sources:bundle.metadata.uniqueGeometries}));
}

if(process.argv.includes('--write-preview-fixture')){
 const at=process.argv.indexOf('--write-preview-fixture');await writePreviewFixture(process.argv[at+1],process.argv[at+2]);
}else{
test('trail raster fixture bundles the actual manager, worker and exact country geometry',async()=>{
 const result=await productionBundle();assert.ok(result.main.length>10000);assert.ok(result.worker.length>1000);assert.equal(JSON.parse(result.catalogue).sources.length,result.metadata.uniqueGeometries);
});

test('actual worker trail rasters preserve direct Canvas pixels at all DPRs and palettes',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+180000,
},async t=>{
 assert.ok(binary,'A real Chromium binary is required for trail worker pixel parity');
 const bundle=await productionBundle(),directory=await mkdtemp(join(tmpdir(),'tropnik-trail-raster-'));
 const output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/trail-raster');
 const buildInfo=JSON.parse(await readFile(join(output,'build-info.json'),'utf8'));
 const report={schemaVersion:1,verified:false,evidence:'production-trail-worker-pixel-parity',sourceCommit:process.env.GITHUB_SHA||null,buildId:buildInfo.buildId,phase:'browser-startup',sources:bundle.sources,overlay:{sha256:bundle.metadata.sha256,sources:bundle.metadata.uniqueGeometries},baseline:'direct-production-geometryPath-combined-stroke',matrix:{dpr:DPR,palettes:PALETTES,scenarios:SCENARIOS},cases:[]};
 const server=createHTTPServer((request,response)=>{
  const path=new URL(request.url,'http://127.0.0.1').pathname;
  const content=path==='/'?'<!doctype html><meta charset="utf-8"><script src="/fixture.js"></script>':path==='/fixture.js'?bundle.main:path==='/raster-worker.js'?bundle.worker:path==='/catalogue.json'?bundle.catalogue:null;
  response.writeHead(content===null?404:200,{'content-type':path==='/'?'text/html; charset=utf-8':path.endsWith('.json')?'application/json':'text/javascript; charset=utf-8','cache-control':'no-store'});response.end(content??'Not found');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const lease=createNetServer();await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory}));let socket;
 t.after(async()=>{socket?.close();await browser.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});await mkdir(output,{recursive:true});report.browserStartup=browser.diagnostics();await writeFile(join(output,'browser-trail-raster-verification.json'),JSON.stringify(report,null,2)+'\n');});
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  const cdp={call:(method,params={},timeout=5000)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Trail raster CDP timeout: '+method));},timeout);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));})};
  const evaluate=async(expression,timeout)=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},timeout);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);assertNativeSurfaceCoverage(report.environment.nativeSurface);await mkdir(pictures,{recursive:true});
  for(const dpr of DPR){
   await cdp.call('Emulation.setDeviceMetricsOverride',{width:768,height:512,deviceScaleFactor:dpr,mobile:false});await cdp.call('Page.navigate',{url:origin+'/'});
   let loaded=false;for(let attempt=0;attempt<60;attempt++){if(await evaluate("typeof window.runTrailRasterGate==='function'")){loaded=true;break;}await pause(50);}assert.ok(loaded,'Production trail raster fixture did not load');
   for(const name of SCENARIOS)for(const palette of PALETTES){
    report.phase=`dpr${dpr}-${name}-${palette}`;const result=await evaluate(`window.runTrailRasterGate(${JSON.stringify({name,palette,dpr,expectedSources:bundle.metadata.uniqueGeometries})})`,20000);report.cases.push(result);
    const captures=[];for(const capture of result.captures){const file=`dpr${dpr}-${name}-${palette}-${capture.phase}.png`,bytes=Buffer.from(capture.png,'base64');assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),result.frame.width);assert.equal(bytes.readUInt32BE(20),result.frame.height);await writeFile(join(pictures,file),bytes);captures.push({phase:capture.phase,file,bytes:bytes.length,sha256:digest(bytes)});}result.captures=captures;
    assert.equal(result.verified,true,result.error);assert.equal(result.rasterComparison.differentPixels,0);assert.equal(result.rasterComparison.maxChannelDelta,0);assert.equal(result.referenceRasterPixelSHA256,result.workerRasterPixelSHA256);assert.ok(result.comparison.maxChannelDelta<=2);
   }
  }
  assert.equal(report.cases.length,DPR.length*SCENARIOS.length*PALETTES.length);report.verified=true;report.phase='complete';
 }catch(error){report.error=browserErrorDetails(error);throw error;}
});
}
