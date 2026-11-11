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
const enginePath=join(web,'lib/custom-map-engine.ts');
const binary=['google-chrome','google-chrome-stable','chromium','chromium-browser'].find(name=>spawnSync('which',[name],{stdio:'ignore'}).status===0);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const matrix=[
 {name:'opaque',cover:true},
 {name:'fractional-zoom',zoom:8.25,tileZ:9,radius:2,cover:true},
 {name:'pan-sequence',frames:[{x:0,y:0,cover:true},{x:.375,y:.625,cover:true},{x:120.25,y:.125,cover:true},{x:129.125,y:.125,cover:false},{x:.375,y:.625,cover:true}]},
 {name:'missing',missing:true,cover:false},
 {name:'transparent',transparent:true,cover:false},
 {name:'rotated',bearing:17.3,cover:false},
 {name:'pitched',pitch:25,cover:false},
 {name:'satellite',mode:'satellite',transparent:true,cover:false},
 {name:'overview',mode:'overview',cover:false},
 {name:'zoom12',zoom:12,frames:[{x:0,y:0,cover:true},{x:.375,y:.625,cover:true},{x:120.25,y:.125,cover:true},{x:129.125,y:.125,cover:false},{x:.375,y:.625,cover:true}]},
 {name:'zoom13',zoom:13,cover:false},
 {name:'zoom18',zoom:18,cover:false},
 {name:'tiny-tile',tileZ:18,cover:false},
 {name:'unwrapped-world',unwrapped:true,cover:true},
 {name:'boundaries-hidden',boundaries:false,cover:true},
];

// The browser receives the real class and its exported geometryPath. Only the
// worker URL imports are inert: the fixture seeds actual ImageBitmaps and does
// not construct a network/camera session. Neither draw nor any paint method is
// copied, rewritten or replaced. The sole baseline override returns false from
// the new coverage proof, recreating the previous underlay order in that class.
async function productionBundle(){
 const source=await readFile(enginePath,'utf8');
 assert.match(source,/private detailCoversViewport\(batch:TileBatch\|undefined\):boolean/);
 assert.match(source,/if\(!this\.detailCoversViewport\(detail\)\)/);
 const result=await build({absWorkingDir:web,bundle:true,write:false,format:'iife',platform:'browser',target:'chrome107',minify:false,metafile:true,logLevel:'silent',
  tsconfigRaw:{compilerOptions:{baseUrl:'.',paths:{'@/*':['./*']}}},
  stdin:{contents:`import {CustomMapEngine,geometryPath} from './lib/custom-map-engine.ts';import {mercatorUnproject} from './lib/custom-map-camera.ts';import {MAP_OUTSIDE_COLOR} from './public/maps/russia-viewport.js';import {mapCanvasPolicy} from './lib/map-canvas-policy.ts';window.runUnderlayGate=options=>(${runProductionPixels.toString()})({CustomMapEngine,geometryPath,mercatorUnproject,MAP_OUTSIDE_COLOR,mapCanvasPolicy},options);`,resolveDir:web,sourcefile:'underlay-fixture-entry.js'},
  plugins:[{name:'production-source-and-unused-worker-urls',setup(plugin){
   plugin.onLoad({filter:/[/\\]custom-map-engine\.ts$/},async args=>{assert.equal(args.path,enginePath);return{contents:source,loader:'ts',resolveDir:join(web,'lib')};});
   plugin.onResolve({filter:/\?worker&url$/},args=>({path:args.path,namespace:'unconstructed-worker'}));
   plugin.onLoad({filter:/.*/,namespace:'unconstructed-worker'},()=>({contents:'export default "data:application/javascript,";',loader:'js'}));
  }}],
 });
 assert.equal(result.outputFiles.length,1);
 const sources={};
 for(const name of Object.keys(result.metafile.inputs).sort()){
  if(name==='underlay-fixture-entry.js'||name.startsWith('unconstructed-worker:'))continue;
  const path=resolve(web,name);assert.ok(path.startsWith(web+'/'));
  sources['web/'+name]=createHash('sha256').update(await readFile(path)).digest('hex');
 }
 assert.equal(sources['web/lib/custom-map-engine.ts'],createHash('sha256').update(source).digest('hex'));
 return{code:result.outputFiles[0].text,rendererSHA256:sources['web/lib/custom-map-engine.ts'],sources};
}

// This function executes inside Chromium. Canvas calls and image readback are
// genuine; callbacks for the separate label/DOM-marker surfaces are outside the
// ground pixel proof. Their full application audits remain mandatory.
async function runProductionPixels({CustomMapEngine,geometryPath,mercatorUnproject,MAP_OUTSIDE_COLOR,mapCanvasPolicy},options){
 const check=(condition,message)=>{if(!condition)throw new Error(message);};
 const dpr=options.dpr,width=512,height=384,zoom=options.zoom??8,z=options.tileZ??Math.ceil(zoom),n=2**z,scale=256*2**zoom;
 check(devicePixelRatio===dpr,'Actual emulated DPR differs from the requested pixel proof');
 const center={x:(options.unwrapped?n+.5:Math.floor(.626*n)+.5)/n,y:(Math.floor(.373*n)+.5)/n};
 const policy=mapCanvasPolicy(document),bitmaps=[],surfaces=[],frames=[],negativeControls=[];
 const bitmap=async(kind,index=0)=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
  const ctx=canvas.getContext('2d',{alpha:true,willReadFrequently:policy.softwareRaster});
  if(kind==='opaque'||kind==='overview'||kind==='imagery'){
   ctx.fillStyle=kind==='overview'?'#d952d6':kind==='imagery'?'#547b8a':['#e8c366','#689db0','#94bc7a'][index];ctx.fillRect(0,0,512,512);
  }
  ctx.fillStyle=kind==='relief'?'rgba(40,72,43,.22)':kind==='transparent'?'rgba(36,74,198,.3)':kind==='overview'?'#7331bc':'#294f44';
  for(let y=9;y<512;y+=43)for(let x=7;x<512;x+=53)ctx.fillRect(x,y,19+(index*3),13);
  ctx.strokeStyle=kind==='relief'?'rgba(50,70,42,.5)':'#fff4c1';ctx.lineWidth=2.25;
  ctx.beginPath();ctx.moveTo(-1,1);ctx.lineTo(513,509);ctx.moveTo(3,509);ctx.lineTo(509,2);ctx.stroke();
  const image=await createImageBitmap(canvas);bitmaps.push(image);return image;
 };
 const diff=(a,b)=>{check(a.length===b.length,'Pixel dimensions differ');let pixels=0,maxDelta=0;for(let i=0;i<a.length;i+=4){let changed=false;for(let c=0;c<4;c++){const delta=Math.abs(a[i+c]-b[i+c]);if(delta){changed=true;maxDelta=Math.max(maxDelta,delta);}}if(changed)pixels++;}return{differentPixels:pixels,maxChannelDelta:maxDelta,totalPixels:a.length/4};};
 const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
 try{
  const opaque=await Promise.all([0,1,2].map(index=>bitmap('opaque',index))),overviewBitmap=await bitmap('overview'),transparent=await bitmap('transparent'),reliefBitmap=await bitmap('relief'),imageryBitmap=await bitmap('imagery');
  const type=new Map([...opaque.map(value=>[value,'detail']),[overviewBitmap,'overview'],[transparent,'detail'],[reliefBitmap,'relief'],[imageryBitmap,'imagery']]);
  const tile=(kind,level,x,y,image,isTransparent=false)=>({key:`${kind}:${level}/${x}/${y}`,kind,z:level,x,y,bitmap:image,transparent:isTransparent,labels:[],contours:0,local:true});
  const radius=options.radius??1,cx=Math.floor(center.x*n),cy=Math.floor(center.y*n),tiles=[];
  for(let y=cy-radius;y<=cy+radius;y++)for(let x=cx-radius;x<=cx+radius;x++){
   if(options.missing&&x===cx&&y===cy)continue;
   tiles.push(tile('vector',z,x,y,options.transparent?transparent:opaque[((x+y)%3+3)%3],!!options.transparent));
  }
  const coarseZ=Math.max(0,Math.floor(zoom)-2),coarseN=2**coarseZ,overview=[],imagery=[];
  for(let y=Math.floor(center.y*coarseN)-1;y<=Math.floor(center.y*coarseN)+1;y++)for(let x=Math.floor(center.x*coarseN)-1;x<=Math.floor(center.x*coarseN)+1;x++){
   overview.push(tile('overview',coarseZ,x,y,overviewBitmap));imagery.push(tile('eox-s2',coarseZ,x,y,imageryBitmap));
  }
  const batch={kind:'vector',generation:1,tiles},overviewBatch={kind:'overview',generation:1,tiles:overview},reliefBatch={kind:'relief',generation:1,tiles:tiles.map(value=>({...value,kind:'relief',bitmap:reliefBitmap}))};
  const coordinate=([x,y])=>mercatorUnproject({x:center.x+x/scale,y:center.y+y/scale});
  const outer=[[-225,-160],[215,-150],[240,-50],[205,150],[-230,170],[-225,-160]].map(coordinate),hole=[[-55,-45],[50,-45],[50,45],[-55,45],[-55,-45]].map(coordinate);
  const area=geometryPath({type:'Polygon',coordinates:[outer,hole]}).path,mask=new Path2D();mask.rect(-3,-3,8,8);mask.addPath(area);
  const boundaries=geometryPath({type:'LineString',coordinates:outer}).path;
  const selectedRing=[[-180,-130],[-65,-130],[-65,120],[-180,120],[-180,-130]].map(coordinate);
  const selectedArea=geometryPath({type:'Polygon',coordinates:[selectedRing]}).path;
  // Only the real source edge is selectedBoundary. The remaining closed area
  // edges emulate cell clipping and must never be outlined by this draw path.
  const selectedBoundary=geometryPath({type:'LineString',coordinates:selectedRing.slice(0,2)}).path;
  const route=geometryPath({type:'LineString',coordinates:[[-260,-110],[-120,-60],[15,5],[130,75],[270,130]].map(coordinate)});
  const make=(baseline=false)=>{
   const canvas=document.createElement('canvas');canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.cssText=`width:${width}px;height:${height}px;position:absolute;left:0;top:0`;
   document.body.appendChild(canvas);surfaces.push(canvas);
   const context=canvas.getContext('2d',{alpha:false,willReadFrequently:policy.softwareRaster});
   const engine=Object.assign(Object.create(CustomMapEngine.prototype),{canvas,context,element:document.createElement('div'),size:{width,height},pixelRatio:dpr,camera:{center:mercatorUnproject(center),zoom,bearingDegrees:options.bearing??0},pitch:options.pitch??0,mode:options.mode??'detail',state:{committedMode:'detail'},active:true,disposed:false,area,mask,boundaries,selectedArea,selectedBoundary,route,routeId:'pixel-fixture-route',overview:overviewBatch,detail:batch,relief:reliefBatch,imagery:options.mode==='satellite'?{kind:'eox-s2',generation:1,tiles:imagery}:undefined,imageryOverlay:batch,boundaryVisible:options.boundaries!==false,reliefVisible:true,drawRevision:0,pointer:{activePointers:1},animation:0,options:{},drawLabels(){},drawMarkers(){}});
   const count={clear:0,area:0,mask:0,selectedArea:0,overview:0,detail:0,relief:0,imagery:0,proofCalls:0};
   const fill=context.fill.bind(context),clear=context.fillRect.bind(context),drawImage=context.drawImage.bind(context);
   context.fill=function(path,...args){if(path===area)count.area++;if(path===mask)count.mask++;if(path===selectedArea)count.selectedArea++;return fill(path,...args);};
   context.fillRect=function(...args){count.clear++;return clear(...args);};
   context.drawImage=function(image,...args){count[type.get(image)]++;return drawImage(image,...args);};
   const proof=CustomMapEngine.prototype.detailCoversViewport;
   engine.detailCoversViewport=function(value){count.proofCalls++;return baseline?false:proof.call(this,value);};
   const render=()=>{for(const key of Object.keys(count))count[key]=0;CustomMapEngine.prototype.draw.call(engine);return{pixels:context.getImageData(0,0,canvas.width,canvas.height).data,operations:{...count}};};
   return{engine,canvas,context,render};
  };
  const baseline=make(true),optimized=make();
  const movement=options.frames??[{x:0,y:0,cover:options.cover}];
  for(let index=0;index<movement.length;index++){
   const move=movement[index],next=mercatorUnproject({x:center.x+move.x/scale,y:center.y+move.y/scale});
   baseline.engine.camera.center=next;optimized.engine.camera.center=next;
   const actualCoverage=CustomMapEngine.prototype.detailCoversViewport.call(optimized.engine,optimized.engine.displayDetail());
   check(actualCoverage===move.cover,`${options.name}/${index}: coverage guard was ${actualCoverage}, expected ${move.cover}`);
   const old=baseline.render(),current=optimized.render(),comparison=diff(old.pixels,current.pixels);
   const frame={index,offset:{x:move.x,y:move.y},expectedCoverage:move.cover,actualCoverage,comparison,operations:{baseline:old.operations,optimized:current.operations},baselinePixelSHA256:await hash(old.pixels),optimizedPixelSHA256:await hash(current.pixels),width:optimized.canvas.width,height:optimized.canvas.height,
    captures:[{phase:'baseline',png:baseline.canvas.toDataURL('image/png').split(',')[1]},{phase:'optimized',png:optimized.canvas.toDataURL('image/png').split(',')[1]}]};
   frames.push(frame);
   check(comparison.differentPixels===0,`${options.name}/${index}: ${comparison.differentPixels} pixels changed (max delta ${comparison.maxChannelDelta})`);
   check(old.operations.area===1&&old.operations.overview===overview.length,'Baseline did not execute the original underlays');
   check(current.operations.area===(move.cover?0:1)&&current.operations.overview===(move.cover?0:overview.length),'The production branch did not skip exactly the hidden underlays');
   for(const key of ['clear','mask','selectedArea','detail','relief','imagery'])check(old.operations[key]===current.operations[key],`${key} changed between branches`);
   check(current.operations.clear===1&&current.operations.mask===1&&current.operations.proofCalls===1,'Every frame must clear and apply the final outside mask once');
   if(options.name==='opaque'){
    const expected=MAP_OUTSIDE_COLOR.slice(1).match(/../g).map(value=>parseInt(value,16));
    for(const point of [[0,0],[-248,0]])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
     const x=Math.floor((width/2+point[0])*dpr)+dx,y=Math.floor((height/2+point[1])*dpr)+dy,at=(y*optimized.canvas.width+x)*4;
     check(expected.every((value,c)=>current.pixels[at+c]===value)&&current.pixels[at+3]===255,'A route or tile leaked through a hole/outside mask witness');
    }
    for(const property of ['route','selectedBoundary','mask']){
     // A fresh context has exactly the baseline's initial paint state. Reusing
     // a previous frame would also inherit the route's lineCap/lineJoin and
     // could create a difference even if the removed feature painted nothing.
     const control=make(true);control.engine[property]=undefined;const changed=control.render();
     const result=diff(old.pixels,changed.pixels);check(result.differentPixels>0,`${property}: the fixture must contain visible production pixels`);negativeControls.push({name:'remove-'+property,...result});
    }
   }
   if(options.name==='missing'||options.name==='transparent'){
    const control=make();control.engine.detailCoversViewport=()=>true;const wrong=control.render();
    const result=diff(old.pixels,wrong.pixels);check(result.differentPixels>0,'The pixel comparison must detect an unsafe unconditional underlay skip');negativeControls.push({name:'force-unsafe-cover',...result});
   }
  }
  return{verified:true,name:options.name,dpr,policy,contextAttributes:optimized.context.getContextAttributes(),tileDeviceSpan:scale*dpr/n,bitmapDimensions:[512,512],separateLabelsAndDOMMarkersExcluded:true,frames,negativeControls};
 }catch(error){return{verified:false,name:options.name,dpr,error:String(error.stack||error),frames,negativeControls};}
 finally{for(const image of bitmaps)image.close();for(const canvas of surfaces)canvas.remove();}
}

test('underlay fixture bundles the actual engine, geometry and paint dependencies without replacing draw',async()=>{
 const result=await productionBundle();assert.ok(result.code.length>10000);assert.ok(/(?:class CustomMapEngine|CustomMapEngine = class)/.test(result.code));
 assert.ok(result.code.includes('detailCoversViewport'));assert.ok(result.code.includes('function geometryPath'));assert.ok(result.sources['web/lib/custom-map-camera.ts']);
 assert.ok(result.sources['web/lib/map-route-presentation.ts']);assert.ok(result.sources['web/lib/map-canvas-policy.ts']);
});

test('production map underlay omission preserves every real Canvas pixel and all fallbacks',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+120000,
},async t=>{
 assert.ok(binary,'A real Chromium binary is required for the underlay pixel parity gate');
 const bundle=await productionBundle(),directory=await mkdtemp(join(tmpdir(),'tropnik-map-underlay-'));
 const output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/map-underlay');
 const report={schemaVersion:1,verified:false,phase:'browser-startup',evidence:'production-canvas-underlay-pixel-parity',sourceCommit:process.env.GITHUB_SHA||null,rendererSHA256:bundle.rendererSHA256,sources:bundle.sources,baseline:'same-production-draw-with-fixture-only-coverage-false',cases:[]};
 const server=createHTTPServer((request,response)=>{
  const path=new URL(request.url,'http://127.0.0.1').pathname,content=path==='/'?'<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:512px;height:384px;overflow:hidden}</style><script src="/fixture.js"></script>':path==='/fixture.js'?bundle.code:null;
  response.writeHead(content===null?404:200,{'content-type':path==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store'});response.end(content??'Not found');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const lease=createNetServer();await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory}));let socket;
 t.after(async()=>{socket?.close();await browser.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});await mkdir(output,{recursive:true});report.browserStartup=browser.diagnostics();await writeFile(join(output,'browser-map-underlay-verification.json'),JSON.stringify(report,null,2)+'\n');});
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  const cdp={call:(method,params={},timeout=5000)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Underlay pixel CDP timeout: '+method));},timeout);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));})};
  const evaluate=async(expression,timeout)=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},timeout);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);assertNativeSurfaceCoverage(report.environment.nativeSurface);
  await mkdir(pictures,{recursive:true});
  for(const dpr of [1,2]){
   await cdp.call('Emulation.setDeviceMetricsOverride',{width:512,height:384,deviceScaleFactor:dpr,mobile:false});await cdp.call('Page.navigate',{url:origin+'/'});
   let loaded=false;for(let attempt=0;attempt<60;attempt++){if(await evaluate("typeof window.runUnderlayGate==='function'")){loaded=true;break;}await sleep(50);}assert.ok(loaded,'The real engine pixel fixture did not load');
   for(const scenario of matrix){
    report.phase=`dpr${dpr}-${scenario.name}`;const result=await evaluate(`window.runUnderlayGate(${JSON.stringify({...scenario,dpr})})`,15000);report.cases.push(result);
    for(const frame of result.frames){
     const captures=[];for(const capture of frame.captures){const file=`dpr${dpr}-${scenario.name}-${frame.index}-${capture.phase}.png`,bytes=Buffer.from(capture.png,'base64');assert.ok(bytes.length>=33&&bytes.length<=8*1024*1024);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),frame.width);assert.equal(bytes.readUInt32BE(20),frame.height);await writeFile(join(pictures,file),bytes);captures.push({phase:capture.phase,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}frame.captures=captures;
     assert.equal(frame.comparison.differentPixels,0);assert.equal(frame.comparison.maxChannelDelta,0);assert.equal(frame.baselinePixelSHA256,frame.optimizedPixelSHA256);assert.equal(frame.actualCoverage,frame.expectedCoverage);
    }
    assert.equal(result.verified,true,result.error);assert.equal(result.dpr,dpr);
   }
  }
  assert.equal(report.cases.length,matrix.length*2);assert.equal(report.cases.reduce((sum,item)=>sum+item.frames.length,0),46);
  report.verified=true;report.phase='complete';
 }catch(error){report.error=browserErrorDetails(error);throw error;}
});
