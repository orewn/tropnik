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
const groundMatrix=[
 {name:'opaque',cover:true},
 {name:'missing',missing:true,cover:false},
 {name:'satellite',mode:'satellite',transparent:true,cover:false},
 {name:'overview',mode:'overview',cover:false},
 {name:'rotated-pitched',bearing:17.3,pitch:25,cover:false},
 {name:'unwrapped-world',unwrapped:true,cover:true},
];
const groundPhases=['cold','stroke-history','warm','overlay-changed','overlay-empty','route-changed','route-empty'];
const streamingMatrix=[
 {name:'trace-grid',width:1041,height:928,zoom:6.1,center:[85.97995147228215,50.65622536454623],canonicalZ:7,canonicalBounds:[91,39,98,46],loadingZ:6,loadingBounds:[45,19,49,23]},
 {name:'small-lifecycle',width:512,height:384,zoom:8.25},
];
const streamingLifecycle=['cold','stroke-history','pair-01','pair-02','repeat','overlay-changed','route-changed','mask-changed','selected-area-changed','boundary-changed','line-caps-changed','overview-changed','canonical-replaced','new-generation','new-generation-pair','prefix-inserted','prefix-replaced','cohort-shrunk','loading-reset','restart','fractional-camera','resize','pointer-active','pointer-released','animation-active','animation-ended','rotated','pitched','flat-restored','relief-hidden','relief-restored','failure-overlay','failure-warm','satellite-retained','detail-restored','complete','complete-warm'];
const streamingPhases=name=>name==='trace-grid'?['cold','stroke-history',...Array.from({length:25},(_,index)=>'pair-'+String(index+1).padStart(2,'0')),'complete','complete-warm']:[...streamingLifecycle];

// The browser receives the real class and its exported geometryPath. Only the
// worker URL imports are inert: the fixture seeds actual ImageBitmaps and does
// not construct a network/camera session. Neither draw nor any paint method is
// copied, rewritten or replaced. The sole baseline override returns false from
// the new coverage proof, recreating the previous underlay order in that class.
async function productionBundle(){
 const source=await readFile(enginePath,'utf8');
 assert.match(source,/private detailCoversViewport\(batch:TileBatch\|undefined\):boolean/);
 assert.match(source,/const detail=this\.displayDetail\(\),covered=this\.detailCoversViewport\(detail\);/);
 assert.match(source,/if\(!covered\)\{ctx\.fillStyle=MAP_OUTSIDE_COLOR;ctx\.fillRect\(0,0,this\.canvas\.width,this\.canvas\.height\);\}/);
 const result=await build({absWorkingDir:web,bundle:true,write:false,format:'iife',platform:'browser',target:'chrome107',minify:false,metafile:true,logLevel:'silent',
  tsconfigRaw:{compilerOptions:{baseUrl:'.',paths:{'@/*':['./*']}}},
  stdin:{contents:`import {CustomMapEngine,geometryPath} from './lib/custom-map-engine.ts';import {mercatorProject,mercatorUnproject} from './lib/custom-map-camera.ts';import {MAP_OUTSIDE_COLOR} from './public/maps/russia-viewport.js';import {mapCanvasPolicy} from './lib/map-canvas-policy.ts';window.runUnderlayGate=options=>(${runProductionPixels.toString()})({CustomMapEngine,geometryPath,mercatorUnproject,MAP_OUTSIDE_COLOR,mapCanvasPolicy},options);window.runStreamingGroundGate=options=>(${runStreamingPixels.toString()})({CustomMapEngine,geometryPath,mercatorProject,mercatorUnproject,mapCanvasPolicy},options);`,resolveDir:web,sourcefile:'underlay-fixture-entry.js'},
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
 check(options.previewOnly===true||devicePixelRatio===dpr,'Actual emulated DPR differs from the requested pixel proof');
 const center={x:(options.unwrapped?n+.5:Math.floor(.626*n)+.5)/n,y:(Math.floor(.373*n)+.5)/n};
 const policy=mapCanvasPolicy(document),bitmaps=[],surfaces=[],engines=[],frames=[],negativeControls=[];
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
   // Opposite opaque histories must be completely replaced by the real draw.
   // Subsequent pan frames retain their actual previous output without reseeding.
   context.fillStyle=baseline?'#ff00ff':'#00ffb0';context.fillRect(0,0,canvas.width,canvas.height);
   context.fillStyle=baseline?'#1a2bff':'#fff300';
   for(let y=0;y<canvas.height;y+=29)for(let x=0;x<canvas.width;x+=31)if(((x/31)+(y/29))%2===0)context.fillRect(x,y,19,17);
   const engine=Object.assign(Object.create(CustomMapEngine.prototype),{canvas,context,element:document.createElement('div'),size:{width,height},pixelRatio:dpr,rasterPolicy:policy,camera:{center:mercatorUnproject(center),zoom,bearingDegrees:options.bearing??0},pitch:options.pitch??0,mode:options.mode??'detail',state:{committedMode:options.mode??'detail'},active:true,disposed:false,area,mask,boundaries,selectedArea,selectedBoundary,route,routeId:'pixel-fixture-route',overview:overviewBatch,detail:batch,relief:reliefBatch,imagery:options.mode==='satellite'?{kind:'eox-s2',generation:1,tiles:imagery}:undefined,imageryOverlay:batch,boundaryVisible:options.boundaries!==false,reliefVisible:true,drawRevision:0,pointer:{activePointers:options.cacheProof?0:1},animation:0,options:{},paths:!!options.cacheProof,trailOverlay:[],trailOverlayPaths:new WeakMap(),reviewedCoastalPaths:new WeakMap(),trailRasterPartCache:new WeakMap(),trailRasterPartSerial:0,trailOverlayCandidateCounts:{sources:0,parts:0,details:0},trailOverlayPaintedEntries:[],trailOverlaySources:0,trailOverlayParts:0,trailOverlayDetails:0,reviewedCoastalOverlaySources:0,trailRasterError:'',trailOverlayViewportReady:true,drawLabels(){},drawMarkers(){},publishInspection(){},schedule(){}});engines.push(engine);
   const count={clear:0,area:0,mask:0,selectedArea:0,overview:0,detail:0,relief:0,imagery:0,proofCalls:0,groundRestore:0};
   const fill=context.fill.bind(context),clear=context.fillRect.bind(context),drawImage=context.drawImage.bind(context);
   context.fill=function(path,...args){if(path===area)count.area++;if(path===mask)count.mask++;if(path===selectedArea)count.selectedArea++;return fill(path,...args);};
   context.fillRect=function(...args){count.clear++;return clear(...args);};
   context.drawImage=function(image,...args){const kind=type.get(image);if(kind)count[kind]++;return drawImage(image,...args);};
   const proof=CustomMapEngine.prototype.detailCoversViewport;
   engine.detailCoversViewport=function(value){count.proofCalls++;return baseline&&!options.cacheProof?false:proof.call(this,value);};
   const restore=CustomMapEngine.prototype.restoreGround;
   engine.restoreGround=function(signature){const restored=baseline&&options.cacheProof?false:restore.call(this,signature);if(restored)count.groundRestore++;return restored;};
   if(baseline&&options.cacheProof)engine.retainGround=()=>{};
   const render=()=>{for(const key of Object.keys(count))count[key]=0;CustomMapEngine.prototype.draw.call(engine);return{pixels:context.getImageData(0,0,canvas.width,canvas.height).data,operations:{...count}};};
   return{engine,canvas,context,render};
  };
  const baseline=make(true),optimized=make();
   const baselinePrior=baseline.context.getImageData(0,0,baseline.canvas.width,baseline.canvas.height).data,optimizedPrior=optimized.context.getImageData(0,0,optimized.canvas.width,optimized.canvas.height).data;
   const priorFrame={kind:'distinct-opaque-checkerboards',comparison:diff(baselinePrior,optimizedPrior),baselinePixelSHA256:await hash(baselinePrior),optimizedPixelSHA256:await hash(optimizedPrior)};
   check(priorFrame.comparison.differentPixels===width*height*dpr*dpr&&priorFrame.baselinePixelSHA256!==priorFrame.optimizedPixelSHA256,'Adversarial prior pixels must differ across the whole backing store');
  if(options.cacheProof){
   const phases=['cold','stroke-history','warm','overlay-changed','overlay-empty','route-changed','route-empty'];
   const cacheEligible=(options.bearing??0)===0&&(options.pitch??0)===0;
   const entry=(key,points)=>{const coordinates=points.map(coordinate);return{key,ids:[key],parts:[{bounds:[Math.min(...coordinates.map(point=>point[0])),Math.min(...coordinates.map(point=>point[1])),Math.max(...coordinates.map(point=>point[0])),Math.max(...coordinates.map(point=>point[1]))],lines:[coordinates]}]};};
   const first=entry('first',[[-170,70],[-110,100],[-70,65]]),second=entry('second',[[70,100],[130,40],[180,80]]);
   baseline.engine.setTrailOverlay([first]);optimized.engine.setTrailOverlay([first]);let previous;
   for(let index=0;index<phases.length;index++){
    const phase=phases[index];
    if(phase==='overlay-changed')for(const item of [baseline,optimized])item.engine.setTrailOverlay([second]);
    if(phase==='overlay-empty')for(const item of [baseline,optimized])item.engine.setTrailOverlay([]);
    if(phase==='route-changed')for(const item of [baseline,optimized])item.engine.route=geometryPath({type:'LineString',coordinates:[[-180,-75],[-100,-20],[-130,80]].map(coordinate)});
    if(phase==='route-empty')for(const item of [baseline,optimized]){item.engine.route=undefined;item.engine.routeId='';}
    const old=baseline.render(),current=optimized.render(),comparison=diff(old.pixels,current.pixels),expectedHit=cacheEligible&&index>=2;
    const frame={index,phase,expectedHit,comparison,operations:{baseline:old.operations,optimized:current.operations},baselinePixelSHA256:await hash(old.pixels),optimizedPixelSHA256:await hash(current.pixels),width:optimized.canvas.width,height:optimized.canvas.height,
     captures:[{phase:'baseline',png:baseline.canvas.toDataURL('image/png').split(',')[1]},{phase:'optimized',png:optimized.canvas.toDataURL('image/png').split(',')[1]}]};frames.push(frame);
    check(comparison.differentPixels===0,`${options.name}/${phase}: retained ground changed ${comparison.differentPixels} pixels (max ${comparison.maxChannelDelta})`);
    check(old.operations.groundRestore===0&&current.operations.groundRestore===Number(expectedHit),`${options.name}/${phase}: the actual native ground cache did not follow its expected cold/warm lifecycle`);
    check(old.operations.mask===1&&current.operations.mask===1,'Every cached frame must repaint the current outside and hole mask');
    check(old.operations.proofCalls===1&&current.operations.proofCalls===1,'Every frame rechecks the live opaque coverage guard');
    if(expectedHit){
     for(const key of ['clear','area','overview','detail','relief','imagery','selectedArea'])check(current.operations[key]===0,`${phase}: retained ground replayed ${key}`);
     check(old.operations.selectedArea===1&&old.operations.overview+old.operations.detail+old.operations.imagery>0,'The uncached production baseline must paint actual source ground');
    }
    if(!cacheEligible)for(const key of ['clear','area','overview','detail','relief','imagery','selectedArea'])check(current.operations[key]===old.operations[key],`${phase}: transformed fallback changed original ${key} operations`);
    if(index>=3){frame.changedFromPrevious=diff(previous,current.pixels);check(frame.changedFromPrevious.differentPixels>0,`${phase}: a stale cached route/overlay would be invisible to this fixture`);}
    previous=current.pixels;
   }
   const retained=optimized.engine.groundSnapshot;
   check(cacheEligible?retained?.surface instanceof OffscreenCanvas:!retained,'Eligible frames require actual native ground; transformed views must retain the original direct painter');
   const retainedBacking=retained?{width:retained.surface.width,height:retained.surface.height,bytes:retained.surface.width*retained.surface.height*4}:null;
   check(!retainedBacking||retainedBacking.bytes<=32*1024*1024,'Retained ground exceeded its allocation budget');
   return{verified:true,cacheProof:true,cacheEligible,name:options.name,dpr,nativeDpr:devicePixelRatio,previewOnly:options.previewOnly===true,policy,contextAttributes:optimized.context.getContextAttributes(),groundContextAttributes:retained?.context.getContextAttributes()??null,retainedBacking,phases,priorFrame,frames,negativeControls};
  }
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
   for(const key of ['mask','selectedArea','detail','relief','imagery'])check(old.operations[key]===current.operations[key],`${key} changed between branches`);
   if(options.mode==='satellite')check(current.operations.imagery===imagery.length&&current.operations.relief===0,'The satellite case must draw its complete imagery rather than retained relief');
   if(options.mode==='overview')check(current.operations.detail===0&&current.operations.relief===0&&current.operations.imagery===0,'The overview case must not draw retained detail, relief or imagery');
   check(old.operations.clear===1&&current.operations.clear===(move.cover?0:1),'Only proven full opaque coverage may omit the paper clear');
    check(current.operations.mask===1&&current.operations.proofCalls===1,'Every frame must retain the final outside mask and evaluate coverage once');
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
  return{verified:true,name:options.name,dpr,policy,contextAttributes:optimized.context.getContextAttributes(),tileDeviceSpan:scale*dpr/n,bitmapDimensions:[512,512],separateLabelsAndDOMMarkersExcluded:true,priorFrame,frames,negativeControls};
 }catch(error){return{verified:false,name:options.name,dpr,error:String(error.stack||error),frames,negativeControls};}
 finally{for(const engine of engines)engine.releaseGround();for(const image of bitmaps)image.close();for(const canvas of surfaces)canvas.remove();}
}

// A separate renderer fixture: the observed trace grid/camera use genuine
// patterned ImageBitmaps with deterministic delivery, not recorded network
// responses. The real application loading gate remains an independent check.
// Both sides call the same production draw/drawGround. Only baseline cache
// decisions are disabled; context wrappers observe and forward native calls.
async function runStreamingPixels({CustomMapEngine,geometryPath,mercatorProject,mercatorUnproject,mapCanvasPolicy},options){
 const check=(value,message)=>{if(!value)throw new Error(message);};
 const dpr=options.dpr,width=options.width,height=options.height,zoom=options.zoom,scale=256*2**zoom;
 check(devicePixelRatio===dpr,'Streaming pixel proof requires the actual native DPR');
 check(typeof CustomMapEngine.prototype.drawGround==='function'&&typeof CustomMapEngine.prototype.updateLoadingGround==='function','The actual streaming renderer API is missing');
 const cameraCenter=options.center??mercatorUnproject({x:.626+0.375/scale,y:.373+0.625/scale}),center=mercatorProject(cameraCenter);
 const policy=mapCanvasPolicy(document),bitmaps=[],surfaces=[],engines=[],frames=[],negativeControls=[];
 const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
 const diff=(a,b)=>{check(a.length===b.length,'Streaming frame dimensions differ');let differentPixels=0,maxChannelDelta=0;for(let i=0;i<a.length;i+=4){let different=false;for(let c=0;c<4;c++){const delta=Math.abs(a[i+c]-b[i+c]);different||=delta!==0;maxChannelDelta=Math.max(maxChannelDelta,delta);}if(different)differentPixels++;}return{differentPixels,maxChannelDelta,totalPixels:a.length/4};};
 const image=async(kind,index=0)=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const context=canvas.getContext('2d',{alpha:true,willReadFrequently:policy.softwareRaster});
  if(kind!=='relief'){context.fillStyle=kind==='overview'?['#a6bd81','#c58aac'][index]:kind==='imagery'?'#386f91':['#e5bf72','#71a79b','#9b89bf','#98bd72'][index];context.fillRect(0,0,512,512);}
  context.fillStyle=kind==='relief'?'rgba(37,71,48,.27)':'rgba(27,66,47,.52)';
  for(let y=5;y<512;y+=37)for(let x=3;x<512;x+=47)context.fillRect(x,y,11+index*3,17);
  context.lineWidth=3.25;context.strokeStyle=kind==='relief'?'rgba(48,65,30,.6)':'#f8e9bc';context.beginPath();context.moveTo(-2,7);context.lineTo(514,503);context.moveTo(1,511);context.lineTo(509,-1);context.stroke();
  const bitmap=await createImageBitmap(canvas);bitmaps.push(bitmap);return bitmap;
 };
 try{
  const opaque=await Promise.all([0,1,2,3].map(index=>image('vector',index))),reliefBitmap=await image('relief'),overviewImages=await Promise.all([0,1].map(index=>image('overview',index))),imageryBitmap=await image('imagery');
  const imageKind=new Map([...opaque.map(bitmap=>[bitmap,'detail']),[reliefBitmap,'relief'],...overviewImages.map(bitmap=>[bitmap,'overview']),[imageryBitmap,'imagery']]);
  const tile=(kind,z,x,y,bitmap,extra={})=>({key:`${kind}:${z}/${x}/${y}`,kind,z,x,y,bitmap,transparent:false,labels:[],contours:0,local:true,...extra});
  const grid=(z,bounds,kind='vector',variant=0)=>{const result=[];for(let y=bounds[1];y<=bounds[3];y++)for(let x=bounds[0];x<=bounds[2];x++)result.push(tile(kind,z,x,y,kind==='vector'?opaque[((x+y+variant)%4+4)%4]:kind==='relief'?reliefBitmap:kind==='overview'?overviewImages[variant]:imageryBitmap));return result;};
  const canonicalZ=options.canonicalZ??9,canonicalN=2**canonicalZ,cx=Math.floor(center.x*canonicalN),cy=Math.floor(center.y*canonicalN),canonicalBounds=options.canonicalBounds??[cx-1,cy-1,cx,cy];
  const loadingZ=options.loadingZ??8,loadingN=2**loadingZ,lx=Math.floor(center.x*loadingN),ly=Math.floor(center.y*loadingN),loadingBounds=options.loadingBounds??[lx-1,ly-1,lx+1,ly+1];
  const canonical=grid(canonicalZ,canonicalBounds),canonicalRelief=canonical.map(value=>({...value,kind:'relief',key:value.key.replace('vector:','relief:'),bitmap:reliefBitmap}));
  const loadingTiles=grid(loadingZ,loadingBounds,'vector',1);
  const traceOrder=[[47,21],[46,21],[47,22],[47,20],[48,21],[46,22],[46,20],[48,22],[48,20],[45,21],[47,23],[47,19],[45,22],[45,20],[46,23],[46,19],[49,21],[48,23],[48,19],[49,22],[49,20],[45,23],[45,19],[49,23],[49,19]];
  loadingTiles.sort(options.name==='trace-grid'?(a,b)=>traceOrder.findIndex(([x,y])=>x===a.x&&y===a.y)-traceOrder.findIndex(([x,y])=>x===b.x&&y===b.y):(a,b)=>(a.x+.5-center.x*loadingN)**2+(a.y+.5-center.y*loadingN)**2-((b.x+.5-center.x*loadingN)**2+(b.y+.5-center.y*loadingN)**2)||a.y-b.y||a.x-b.x);
  const pair=detail=>({detail,relief:{...detail,key:detail.key.replace('vector:','relief:'),kind:'relief',bitmap:reliefBitmap}}),pairs=loadingTiles.map(pair);
  const overviewZ=Math.max(0,Math.floor(zoom)-2),on=2**overviewZ,ox=Math.floor(center.x*on),oy=Math.floor(center.y*on),overviewBounds=[ox-1,oy-1,ox+1,oy+1];
  const overview={kind:'overview',generation:1,tiles:grid(overviewZ,overviewBounds,'overview')},detail={kind:'vector',generation:1,tiles:canonical},relief={kind:'relief',generation:1,tiles:canonicalRelief};
  const coordinate=([x,y])=>mercatorUnproject({x:center.x+x/scale,y:center.y+y/scale});
  const polygon=points=>geometryPath({type:'Polygon',coordinates:[points.map(coordinate)]}).path;
  const line=points=>geometryPath({type:'LineString',coordinates:points.map(coordinate)});
  const outer=[[-width*.46,-height*.43],[width*.44,-height*.41],[width*.47,height*.1],[width*.42,height*.44],[-width*.45,height*.43],[-width*.46,-height*.43]];
  const area=polygon(outer),boundaries=line(outer).path,selectedArea=polygon([[-width*.34,-height*.3],[width*.18,-height*.29],[width*.2,height*.3],[-width*.3,height*.28],[-width*.34,-height*.3]]),selectedBoundary=line([[-width*.34,-height*.3],[width*.18,-height*.29],[width*.2,height*.3]]).path;
  const makeMask=changed=>{const mask=new Path2D();mask.rect(-3,-3,8,8);mask.addPath(area);mask.addPath(polygon(changed?[[30,30],[85,20],[95,75],[35,80],[30,30]]:[[-40,-35],[30,-35],[30,25],[-40,25],[-40,-35]]));return mask;};
  const route=line([[-width*.48,-height*.2],[-width*.2,-height*.11],[13,7],[width*.22,height*.17],[width*.49,height*.31]]);
  const entry=(key,points)=>{const coordinates=points.map(coordinate);return{key,ids:[key],parts:[{bounds:[Math.min(...coordinates.map(point=>point[0])),Math.min(...coordinates.map(point=>point[1])),Math.max(...coordinates.map(point=>point[0])),Math.max(...coordinates.map(point=>point[1]))],lines:[coordinates]}]};};
  const firstOverlay=entry('stream-first',[[-170,70],[-110,100],[-70,65]]),secondOverlay=entry('stream-second',[[70,100],[130,40],[180,80]]);
  const counters=()=>({clear:0,area:0,mask:0,selectedArea:0,images:0,overview:0,detail:0,relief:0,imagery:0,snapshotCopies:0,visibleCopies:0});
  const make=baseline=>{
   const canvas=document.createElement('canvas');canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);canvas.style.cssText=`position:absolute;left:0;top:0;width:${width}px;height:${height}px`;document.body.appendChild(canvas);surfaces.push(canvas);
   const context=canvas.getContext('2d',{alpha:false,willReadFrequently:policy.softwareRaster});context.fillStyle=baseline?'#ff00ff':'#00ffb0';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle=baseline?'#1a2bff':'#fff300';for(let y=0;y<canvas.height;y+=29)for(let x=0;x<canvas.width;x+=31)if(((x/31)+(y/29))%2===0)context.fillRect(x,y,19,17);
   const engine=Object.assign(Object.create(CustomMapEngine.prototype),{canvas,context,element:document.createElement('div'),size:{width,height},pixelRatio:dpr,rasterPolicy:policy,camera:{center:[...cameraCenter],zoom,bearingDegrees:0},pitch:0,mode:'detail',state:{ready:true,loading:false,committedMode:'detail',error:''},generation:1,active:true,disposed:false,area,mask:makeMask(false),boundaries,selectedArea,selectedBoundary,route,routeId:'stream-pixel-route',overview,detail,relief,boundaryVisible:true,reliefVisible:true,drawRevision:0,pointer:{activePointers:0},animation:0,options:{},paths:true,trailOverlay:[],trailOverlayPaths:new WeakMap(),reviewedCoastalPaths:new WeakMap(),trailRasterPartCache:new WeakMap(),trailRasterPartSerial:0,trailOverlayCandidateCounts:{sources:0,parts:0,details:0},trailOverlayPaintedEntries:[],trailOverlaySources:0,trailOverlayParts:0,trailOverlayDetails:0,reviewedCoastalOverlaySources:0,trailRasterError:'',trailOverlayViewportReady:true,drawLabels(){},drawMarkers(){},publishInspection(){},schedule(){}});engines.push(engine);
   let count;const watched=new Map(),retainedSurfaces=new Set();let maxLiveRetained=0,maxRetainedBytes=0;
   const matrix=target=>{const value=target.getTransform();return[value.a,value.b,value.c,value.d,value.e,value.f];},copy=value=>JSON.parse(JSON.stringify(value));
   const watch=target=>{if(!target||watched.has(target))return;const state={clips:[],stack:[],rects:[],restoreUnderflows:0};watched.set(target,state);if(target.canvas instanceof OffscreenCanvas)retainedSurfaces.add(target.canvas);const side=target===context?'main':'retained',fill=target.fill.bind(target),fillRect=target.fillRect.bind(target),drawImage=target.drawImage.bind(target),save=target.save.bind(target),restore=target.restore.bind(target),beginPath=target.beginPath.bind(target),rect=target.rect.bind(target),clip=target.clip.bind(target);
    // Observe native scopes and transfers; every operation still reaches the
    // original context. No replacement canvas or pixel synthesis is involved.
    target.save=function(){save();state.stack.push([...state.clips]);};
    target.restore=function(){restore();if(state.stack.length)state.clips=state.stack.pop();else state.restoreUnderflows++;};
    target.beginPath=function(){beginPath();state.rects=[];};
    target.rect=function(...args){rect(...args);state.rects.push({args:[...args],transform:matrix(target)});};
    target.clip=function(...args){clip(...args);const observed={rects:copy(state.rects),argumentsCount:args.length,transform:matrix(target)};state.clips.push(observed);if(count)count.clipCalls.push({surface:side,...copy(observed)});};
    target.fill=function(path,...args){if(count){if(path===engine.area)count[side].area++;if(path===engine.mask)count[side].mask++;if(path===engine.selectedArea)count[side].selectedArea++;}return fill(path,...args);};
    target.fillRect=function(...args){if(count)count[side].clear++;return fillRect(...args);};
    target.drawImage=function(source,...args){if(count){count[side].images++;const kind=imageKind.get(source);if(kind)count[side][kind]++;if(source instanceof OffscreenCanvas)count[side].snapshotCopies++;if(source===canvas)count[side].visibleCopies++;if(source===canvas||source===engine.groundSnapshot?.surface)count.transfers.push({surface:side,source:source===canvas?'main':'retained',args:[...args],transform:matrix(target),alpha:target.globalAlpha,compositeOperation:target.globalCompositeOperation,clips:copy(state.clips)});}return drawImage(source,...args);};
   };watch(context);
   const drawGround=CustomMapEngine.prototype.drawGround;engine.drawGround=function(...args){const target=args[3]??this.context;watch(target);const dirty=args[4]??null;count.groundCalls.push({surface:target===context?'main':'retained',dirty:dirty?copy(dirty):null,clipDepth:watched.get(target).clips.length});return drawGround.apply(this,args);};
   if(baseline){engine.updateLoadingGround=()=>false;engine.retainGround=()=>{};engine.restoreGround=()=>false;}
   else{
    const update=CustomMapEngine.prototype.updateLoadingGround,restore=CustomMapEngine.prototype.restoreGround,retain=CustomMapEngine.prototype.retainGround;
    engine.updateLoadingGround=function(...args){count.updateAttempts++;const used=update.apply(this,args);if(used)count.updateHits++;watch(this.groundSnapshot?.context);return used;};
    engine.restoreGround=function(...args){const used=restore.apply(this,args);if(used)count.restoreHits++;return used;};
    engine.retainGround=function(...args){const result=retain.apply(this,args);watch(this.groundSnapshot?.context);return result;};
   }
   const render=()=>{count={main:counters(),retained:counters(),groundCalls:[],clipCalls:[],transfers:[],updateAttempts:0,updateHits:0,restoreHits:0};CustomMapEngine.prototype.draw.call(engine);watch(engine.groundSnapshot?.context);count.contextStates=[...watched].map(([target,state])=>({surface:target===context?'main':'retained',saveDepth:state.stack.length,clipDepth:state.clips.length,restoreUnderflows:state.restoreUnderflows}));const live=[...retainedSurfaces].filter(surface=>surface.width>0&&surface.height>0);maxLiveRetained=Math.max(maxLiveRetained,live.length);maxRetainedBytes=Math.max(maxRetainedBytes,live.reduce((sum,surface)=>sum+surface.width*surface.height*4,0));check(live.length<=1,'Streaming cache retained more than one native backing surface');check(maxRetainedBytes<=32*1024*1024,'Streaming cache exceeded the original ground memory budget');return{pixels:context.getImageData(0,0,canvas.width,canvas.height).data,operations:copy(count),maxLiveRetained,maxRetainedBytes};};
   engine.setTrailOverlay([firstOverlay]);return{engine,canvas,context,render};
  };
  const baseline=make(true),optimized=make(false),both=[baseline,optimized];
  const a=baseline.context.getImageData(0,0,baseline.canvas.width,baseline.canvas.height).data,b=optimized.context.getImageData(0,0,optimized.canvas.width,optimized.canvas.height).data;
  const priorFrame={kind:'distinct-opaque-checkerboards',comparison:diff(a,b),baselinePixelSHA256:await hash(a),optimizedPixelSHA256:await hash(b)};check(priorFrame.comparison.differentPixels===a.length/4,'Streaming comparison requires adversarial prior pixels');
  let cohort=[],generation=2,previous,incrementalFrames=0;const setLoading=()=>{for(const item of both){item.engine.generation=generation;item.engine.loadingGround=cohort.length?{generation,requestedCells:pairs.length,z:loadingZ,cells:new Set(cohort.map(pair=>`${pair.detail.x}/${pair.detail.y}`)),detail:{kind:'vector',generation,tiles:cohort.map(pair=>pair.detail)},relief:{kind:'relief',generation,tiles:cohort.map(pair=>pair.relief)}}:undefined;item.engine.state={...item.engine.state,loading:cohort.length>0,error:''};}};
  for(const [index,phase] of options.phases.entries()){
   if(/^pair-\d+$/.test(phase)){cohort=pairs.slice(0,Number(phase.slice(5)));setLoading();}
   if(phase==='overlay-changed'||phase==='failure-overlay')for(const item of both)item.engine.setTrailOverlay([secondOverlay]);
   if(phase==='route-changed')for(const item of both)item.engine.route=line([[-width*.34,-height*.27],[-30,50],[width*.25,-height*.18]]);
   if(phase==='mask-changed')for(const item of both)item.engine.mask=makeMask(true);
   if(phase==='selected-area-changed')for(const item of both)item.engine.selectedArea=polygon([[-190,-120],[40,-120],[25,130],[-180,110],[-190,-120]]);
   if(phase==='boundary-changed')for(const item of both){item.engine.boundaries=line([[-210,-130],[-80,90],[160,-100],[200,120]]).path;item.engine.selectedBoundary=line([[-170,-110],[75,-100],[90,110]]).path;}
   if(phase==='line-caps-changed')for(const item of both){item.context.lineCap='square';item.context.lineJoin='bevel';item.context.miterLimit=3;}
   if(phase==='overview-changed')for(const item of both)item.engine.overview={...overview,tiles:grid(overviewZ,overviewBounds,'overview',1)};
   if(phase==='canonical-replaced')for(const item of both)item.engine.detail={...detail,tiles:canonical.map(value=>({...value,bitmap:opaque[3]}))};
   if(phase==='new-generation'){generation++;cohort=[pair({...pairs[0].detail,bitmap:opaque[3]})];setLoading();}
   if(phase==='new-generation-pair'){cohort=[...cohort,pairs[1]];setLoading();}
   if(phase==='prefix-inserted'){cohort=[pairs[2],...cohort];setLoading();}
   if(phase==='prefix-replaced'){cohort=[pair({...cohort[0].detail,bitmap:opaque[2]}),...cohort.slice(1)];setLoading();}
   if(phase==='cohort-shrunk'){cohort=cohort.slice(1);setLoading();}
   if(phase==='loading-reset'){cohort=[];setLoading();}
   if(phase==='restart'){generation++;cohort=[pairs[0],pairs[1]];setLoading();}
   if(phase==='fractional-camera')for(const item of both)item.engine.camera={...item.engine.camera,center:mercatorUnproject({x:center.x+0.375/scale,y:center.y+0.625/scale})};
   if(phase==='resize')for(const item of both){item.engine.size={width:width+17,height:height+11};item.canvas.width=Math.round((width+17)*dpr);item.canvas.height=Math.round((height+11)*dpr);}
   if(phase==='pointer-active'||phase==='pointer-released')for(const item of both)item.engine.pointer.activePointers=Number(phase==='pointer-active');
   if(phase==='animation-active'||phase==='animation-ended')for(const item of both)item.engine.animation=Number(phase==='animation-active');
   if(phase==='rotated')for(const item of both)item.engine.camera.bearingDegrees=17.3;
   if(phase==='pitched')for(const item of both){item.engine.camera.bearingDegrees=0;item.engine.pitch=25;}
   if(phase==='flat-restored')for(const item of both){item.engine.camera.bearingDegrees=0;item.engine.pitch=0;}
   if(phase==='relief-hidden'||phase==='relief-restored')for(const item of both)item.engine.reliefVisible=phase==='relief-restored';
   if(phase==='failure-overlay')for(const item of both){item.engine.state={...item.engine.state,loading:false,error:'Deliberate final-neighbour fixture rejection'};item.engine.setTrailOverlay([firstOverlay]);}
   if(phase==='satellite-retained')for(const item of both){item.engine.mode='satellite';item.engine.state={...item.engine.state,committedMode:'satellite'};item.engine.imagery={kind:'eox-s2',generation,tiles:grid(overviewZ,overviewBounds,'eox-s2')};item.engine.imageryOverlay={...detail,tiles:[]};}
   if(phase==='detail-restored')for(const item of both){item.engine.mode='detail';item.engine.state={...item.engine.state,committedMode:'detail',loading:true,error:''};}
   if(phase==='complete')for(const item of both){item.engine.detail={kind:'vector',generation,tiles:cohort.map(value=>value.detail)};item.engine.relief={kind:'relief',generation,tiles:cohort.map(value=>value.relief)};item.engine.loadingGround=undefined;item.engine.state={...item.engine.state,loading:false,error:''};}
   const old=baseline.render(),current=optimized.render(),comparison=diff(old.pixels,current.pixels),dirtyCalls=current.operations.groundCalls.filter(call=>call.dirty);
   const fallback=['pointer-active','animation-active','rotated','pitched','satellite-retained'].includes(phase);
   const mustIncrement=options.name==='trace-grid'&&/^pair-\d+$/.test(phase)&&Number(phase.slice(5))>=2;
   const frame={index,phase,comparison,operations:{baseline:old.operations,optimized:current.operations},mustIncrement,fallback,loadingGeneration:optimized.engine.loadingGround?.generation??null,loadingCells:optimized.engine.loadingGround?.detail.tiles.length??0,loadingSnapshotIdentity:!!optimized.engine.loadingGround&&optimized.engine.groundSnapshot?.loading===optimized.engine.loadingGround,camera:{...optimized.engine.camera,center:[...optimized.engine.camera.center]},pitch:optimized.engine.pitch,viewport:{...optimized.engine.size},width:optimized.canvas.width,height:optimized.canvas.height,
    baselinePixelSHA256:await hash(old.pixels),optimizedPixelSHA256:await hash(current.pixels),retained:{maxLiveSurfaces:current.maxLiveRetained,maxBytes:current.maxRetainedBytes},captures:[{phase:'baseline',png:baseline.canvas.toDataURL('image/png').split(',')[1]},{phase:'optimized',png:optimized.canvas.toDataURL('image/png').split(',')[1]}]};
   if(previous&&previous.length===current.pixels.length)frame.changedFromPrevious=diff(previous,current.pixels);frames.push(frame);
   check(comparison.differentPixels===0&&comparison.maxChannelDelta===0,`${options.name}/${phase}: streaming ground changed ${comparison.differentPixels} pixels (max ${comparison.maxChannelDelta})`);
   check(old.operations.updateHits===0&&old.operations.restoreHits===0&&old.operations.groundCalls.every(call=>call.surface==='main'&&!call.dirty&&call.clipDepth===0),'Baseline must execute the unretained production painter');
   for(const operations of [old.operations,current.operations])check(operations.contextStates.every(state=>state.saveDepth===0&&state.clipDepth===0&&state.restoreUnderflows===0),'Native context scopes must finish balanced without leaking a clip into the next frame');
   check(old.operations.main.mask===1&&current.operations.main.mask===1,'Every streaming frame must redraw the current outside mask');
   if(mustIncrement){
    check(current.operations.updateHits===1&&dirtyCalls.length===1&&current.operations.groundCalls.length===1&&dirtyCalls[0].surface==='main'&&dirtyCalls[0].clipDepth===0,'A monotonic pair addition must paint unclipped native paths on main with bounded tile culling');
    check(current.operations.main.snapshotCopies===1&&current.operations.retained.visibleCopies===1&&current.operations.restoreHits===1&&frame.loadingSnapshotIdentity,'Streaming patch must capture one partial region and restore one current native surface');
    for(const call of dirtyCalls){const rect=call.dirty.rect;check(rect&&Object.values(rect).every(Number.isInteger)&&rect.left>=0&&rect.top>=0&&rect.right<=frame.width&&rect.bottom<=frame.height&&rect.right>rect.left&&rect.bottom>rect.top,'Dirty clips must be bounded integer backing-pixel rectangles');check((rect.right-rect.left)*(rect.bottom-rect.top)<frame.width*frame.height,'A single-cell patch cannot be a disguised full-backing repaint');}
    const rect=dirtyCalls[0].dirty.rect,identity=[1,0,0,1,0,0],args=[rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top],same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),expectedClip={rects:[{args,transform:identity}],argumentsCount:0,transform:identity};
    check(current.operations.clipCalls.length===1&&same(current.operations.clipCalls[0],{surface:'retained',...expectedClip}),'Only the integer destination transfer may clip; native main paths must stay unclipped');
    check(current.operations.transfers.length===2,'Incremental ground requires exactly one partial capture followed by one full restore');
    const [capture,present]=current.operations.transfers;
    check(capture.surface==='retained'&&capture.source==='main'&&same(capture.args,[...args,...args])&&same(capture.transform,identity)&&capture.alpha===1&&capture.compositeOperation==='copy'&&same(capture.clips,[expectedClip]),'Partial capture must be a clipped integer 1:1 native copy of precisely the dirty rectangle');
    check(present.surface==='main'&&present.source==='retained'&&same(present.args,[0,0])&&same(present.transform,identity)&&present.alpha===1&&present.compositeOperation==='copy'&&present.clips.length===0,'The full native retained surface must restore main without a clip before foreground paint');
    const tileCalls=counts=>['overview','detail','relief','imagery'].reduce((sum,key)=>sum+counts[key],0);check(tileCalls(current.operations.retained)+tileCalls(current.operations.main)<tileCalls(old.operations.main),'An incremental patch must issue fewer native tile draws than the full direct painter');incrementalFrames++;
   }
   if(fallback)check(current.operations.updateHits===0&&dirtyCalls.length===0,'A transformed, active-input or satellite frame must skip incremental patching');
   if(options.name==='trace-grid'&&phase==='pair-02'){
    const control=make(true);control.engine.camera={...baseline.engine.camera,center:[...baseline.engine.camera.center]};control.context.lineCap=baseline.context.lineCap;control.context.lineJoin=baseline.context.lineJoin;control.context.miterLimit=baseline.context.miterLimit;control.engine.loadingGround={...baseline.engine.loadingGround,detail:{...baseline.engine.loadingGround.detail,tiles:cohort.slice(0,1).map(value=>value.detail)},relief:{...baseline.engine.loadingGround.relief,tiles:cohort.slice(0,1).map(value=>value.relief)}};
    const stale=control.render(),result=diff(old.pixels,stale.pixels);check(result.differentPixels>0,'The fixture must detect a missing genuinely painted pair');negativeControls.push({name:'omit-second-loading-pair',...result});
   }
   previous=current.pixels;
  }
  check(options.name!=='trace-grid'||incrementalFrames===24,'The real25-cell sequence did not execute all24 incremental additions');
  return{verified:true,streamingProof:true,name:options.name,dpr,nativeDpr:devicePixelRatio,policy,contextAttributes:optimized.context.getContextAttributes(),separateLabelsAndDOMMarkersExcluded:true,fixture:'production-painter-with-seeded-native-512px-ImageBitmaps; deterministic delivery; no application or network simulation',canonicalGrid:{z:canonicalZ,bounds:canonicalBounds,cells:canonical.length},loadingGrid:{z:loadingZ,bounds:loadingBounds,cells:pairs.length},initialViewport:{width,height},initialCamera:{center:cameraCenter,zoom,bearingDegrees:0},phases:options.phases,priorFrame,frames,negativeControls,incrementalFrames};
 }catch(error){return{verified:false,streamingProof:true,name:options.name,dpr,error:String(error.stack||error),frames,negativeControls};}
 finally{for(const engine of engines)engine.releaseGround();for(const bitmap of bitmaps)bitmap.close();for(const canvas of surfaces)canvas.remove();}
}

async function writePreviewFixture(directory,basePath){
 const bundle=await productionBundle();await mkdir(directory,{recursive:true});await writeFile(join(directory,'fixture.js'),bundle.code);
 const config={basePath,dpr:[1,1.5,2],scenarios:groundMatrix};
 const html='<!doctype html><meta charset="utf-8"><title>Temporary retained ground pixel diagnosis</title><h1>Retained ground pixel diagnosis</h1><p>Diagnostic only. Backing scales are explicit; native browser DPR is reported separately.</p><p id="progress">Loading production painter…</p><div id="comparison"></div><pre id="report"></pre><script src="'+basePath+'fixture.js"></script><script>'+`(async()=>{const config=${JSON.stringify(config)},report={verified:false,releaseEligible:false,previewOnly:true,nativeDpr:devicePixelRatio,sourceHashes:${JSON.stringify(bundle.sources)},cases:[]};try{for(const dpr of config.dpr)for(const scenario of config.scenarios){document.getElementById('progress').textContent='Running '+scenario.name+' / backing scale '+dpr;const result=await window.runUnderlayGate({...scenario,dpr,cacheProof:true,previewOnly:true});if(!result.verified&&!document.getElementById('comparison').children.length)for(const capture of result.frames.at(-1)?.captures??[]){const image=document.createElement('img');image.src='data:image/png;base64,'+capture.png;image.alt=capture.phase;image.style.width='512px';document.getElementById('comparison').appendChild(image);}for(const frame of result.frames)delete frame.captures;report.cases.push(result);document.getElementById('report').textContent=JSON.stringify(report,null,2);}report.complete=true;report.pixelCasesPassed=report.cases.filter(result=>result.verified).length;document.getElementById('progress').textContent='Complete: '+report.pixelCasesPassed+'/'+report.cases.length+' exact pixel cases';}catch(error){report.error=String(error.stack||error);document.getElementById('progress').textContent='Failed: '+report.error;}document.getElementById('report').textContent=JSON.stringify(report,null,2);})()`+'</script>';
 await writeFile(join(directory,'index.html'),html);console.log(JSON.stringify({directory,basePath,previewOnly:true,verified:false,releaseEligible:false,rendererSHA256:bundle.rendererSHA256,cases:groundMatrix.length*3}));
}

if(process.argv.includes('--write-preview-fixture')){
 const index=process.argv.indexOf('--write-preview-fixture'),directory=process.argv[index+1],basePath=process.argv[index+2];assert.ok(directory&&basePath?.startsWith('/')&&basePath.endsWith('/'));
 await writePreviewFixture(resolve(directory),basePath);
}else{
test('underlay fixture bundles the actual engine, geometry and paint dependencies without replacing draw',async()=>{
 const result=await productionBundle();assert.ok(result.code.length>10000);assert.ok(/(?:class CustomMapEngine|CustomMapEngine = class)/.test(result.code));
 assert.ok(result.code.includes('detailCoversViewport'));assert.ok(result.code.includes('function geometryPath'));assert.ok(result.sources['web/lib/custom-map-camera.ts']);
 assert.ok(result.sources['web/lib/map-route-presentation.ts']);assert.ok(result.sources['web/lib/map-canvas-policy.ts']);
  assert.ok(result.code.includes('runStreamingGroundGate'));assert.ok(result.code.includes('updateLoadingGround'));assert.ok(result.code.includes('drawGround'));
});

test('production map underlay omission preserves every real Canvas pixel and all fallbacks',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+120000,
},async t=>{
 assert.ok(binary,'A real Chromium binary is required for the underlay pixel parity gate');
 const bundle=await productionBundle(),directory=await mkdtemp(join(tmpdir(),'tropnik-map-underlay-'));
 const output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/map-underlay');
 const fixtureBytes=await readFile(new URL(import.meta.url));
 const report={schemaVersion:1,verified:false,phase:'browser-startup',evidence:'production-canvas-underlay-pixel-parity',sourceCommit:process.env.GITHUB_SHA||null,rendererSHA256:bundle.rendererSHA256,sources:bundle.sources,fixture:{path:'tools/pages-preview/tests/browser-map-underlay.browser.mjs',bytes:fixtureBytes.length,sha256:createHash('sha256').update(fixtureBytes).digest('hex')},baseline:'same-production-draw-with-fixture-only-coverage-false',cases:[],groundCache:{verified:false,baseline:'same-production-draw-with-ground-cache-disabled',dpr:[1,1.5,2],scenarios:groundMatrix.map(item=>item.name),phases:groundPhases,cases:[]},streamingGround:{verified:false,baseline:'same-production-draw-with-update-retain-restore-disabled',dpr:[1,1.5,2],scenarios:streamingMatrix.map(item=>item.name),phases:Object.fromEntries(streamingMatrix.map(item=>[item.name,streamingPhases(item.name)])),cases:[]}};
 const server=createHTTPServer((request,response)=>{
  const path=new URL(request.url,'http://127.0.0.1').pathname,content=path==='/'?'<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100vw;height:100vh;overflow:hidden}</style><script src="/fixture.js"></script>':path==='/fixture.js'?bundle.code:null;
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
  for(const dpr of report.groundCache.dpr){
   await cdp.call('Emulation.setDeviceMetricsOverride',{width:512,height:384,deviceScaleFactor:dpr,mobile:false});await cdp.call('Page.navigate',{url:origin+'/'});
   let loaded=false;for(let attempt=0;attempt<60;attempt++){if(await evaluate("typeof window.runUnderlayGate==='function'")){loaded=true;break;}await sleep(50);}assert.ok(loaded,'The ground-cache production fixture did not load');
   for(const scenario of groundMatrix){
    report.phase=`ground-dpr${dpr}-${scenario.name}`;const result=await evaluate(`window.runUnderlayGate(${JSON.stringify({...scenario,dpr,cacheProof:true})})`,20000);report.groundCache.cases.push(result);
    for(const frame of result.frames){
     const captures=[];for(const capture of frame.captures){const file=`ground-dpr${dpr}-${scenario.name}-${frame.phase}-${capture.phase}.png`,bytes=Buffer.from(capture.png,'base64');assert.ok(bytes.length>=33&&bytes.length<=8*1024*1024);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),frame.width);assert.equal(bytes.readUInt32BE(20),frame.height);await writeFile(join(pictures,file),bytes);captures.push({phase:capture.phase,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}frame.captures=captures;
     assert.equal(frame.comparison.differentPixels,0);assert.equal(frame.comparison.maxChannelDelta,0);assert.equal(frame.baselinePixelSHA256,frame.optimizedPixelSHA256);assert.equal(frame.operations.optimized.groundRestore,Number(frame.expectedHit));
    }
    assert.equal(result.verified,true,result.error);assert.equal(result.cacheProof,true);assert.equal(result.previewOnly,false);assert.equal(result.nativeDpr,dpr);assert.deepEqual(result.phases,groundPhases);assert.equal(result.frames.length,groundPhases.length);
   }
  }
  assert.equal(report.groundCache.cases.length,18);assert.equal(report.groundCache.cases.reduce((sum,item)=>sum+item.frames.length,0),126);report.groundCache.verified=true;
   for(const dpr of report.streamingGround.dpr)for(const scenario of streamingMatrix){
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:scenario.width,height:scenario.height,deviceScaleFactor:dpr,mobile:false});await cdp.call('Page.navigate',{url:origin+'/'});
    let loaded=false;for(let attempt=0;attempt<60;attempt++){if(await evaluate("typeof window.runStreamingGroundGate==='function'")){loaded=true;break;}await sleep(50);}assert.ok(loaded,'The streaming production pixel fixture did not load');
    report.phase=`streaming-dpr${dpr}-${scenario.name}`;const phases=streamingPhases(scenario.name),result=await evaluate(`window.runStreamingGroundGate(${JSON.stringify({...scenario,dpr,phases})})`,20000);report.streamingGround.cases.push(result);
    for(const frame of result.frames){
     const captures=[];for(const capture of frame.captures){const file=`streaming-dpr${dpr}-${scenario.name}-${frame.phase}-${capture.phase}.png`,bytes=Buffer.from(capture.png,'base64');assert.ok(bytes.length>=33&&bytes.length<=8*1024*1024);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),frame.width);assert.equal(bytes.readUInt32BE(20),frame.height);await writeFile(join(pictures,file),bytes);captures.push({phase:capture.phase,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}frame.captures=captures;
     assert.deepEqual(frame.comparison,{differentPixels:0,maxChannelDelta:0,totalPixels:frame.width*frame.height});assert.equal(frame.baselinePixelSHA256,frame.optimizedPixelSHA256);
    }
    assert.equal(result.verified,true,result.error);assert.equal(result.streamingProof,true);assert.equal(result.nativeDpr,dpr);assert.deepEqual(result.phases,phases);assert.deepEqual(result.frames.map(frame=>frame.phase),phases);
   }
   assert.equal(report.streamingGround.cases.length,6);assert.equal(report.streamingGround.cases.reduce((sum,item)=>sum+item.frames.length,0),198);report.streamingGround.verified=true;
  report.verified=true;report.phase='complete';
 }catch(error){report.error=browserErrorDetails(error);throw error;}
});
}
