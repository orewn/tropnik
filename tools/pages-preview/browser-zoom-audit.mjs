import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CLOSE_TRAIL_FIXTURE,assertCloseTrailAudit,assertNativeBurstEventOrder,assertRouteEdgeFrame,assertReliefPalette} from './browser-report.mjs';
import {dispatchSourceEndPan,sourceEndPanPlans,sourceEndsAreFramed} from './browser-source-end-pan.mjs';
import {traceDesktopSelection,TERRAIN_TRACE_LIMITS,DESKTOP_TRACE_CATEGORIES} from './browser-trace.mjs';
import {runCoastAudit} from './browser-coast-audit.mjs';
import {runSatelliteContinuityAudit} from './browser-satellite-audit.mjs';
import {performanceBudgetIssues} from './browser-smoothness.mjs';
import {inspectCustomMapDOM,assertCustomMapInspection,assertCustomSceneInspection} from './browser-custom-map.mjs';

const OUTPUT=new URL('../../web/pages-preview/design-qa/',import.meta.url);
const KEY_ZOOMS=[2,5,8,11,14,18];
const PLUS='.map-controls button[aria-label="Увеличить масштаб"]';
const MINUS='.map-controls button[aria-label="Уменьшить масштаб"]';

/** A diagnostic receipt is deliberately incompatible with release verification. */
export function browserAuditRunPolicy(value){
 if(value===undefined||value==='')return{diagnostic:null,reportFile:'browser-verification.json',profiles:null};
 if(value==='offline-safety')return{diagnostic:value,reportFile:'browser-offline-safety-diagnostic.json',profiles:[]};
 if(value==='satellite-continuity')return{diagnostic:value,reportFile:'browser-satellite-continuity-diagnostic.json',profiles:['android-portrait','desktop-webgl']};
 if(value==='ui-smoothness'||value==='ui-smoothness-cpu')return{diagnostic:value,reportFile:`browser-${value}-diagnostic.json`,profiles:value==='ui-smoothness-cpu'?['android-portrait']:['android-portrait','desktop-webgl']};
 assert.ok(value==='terrain-close'||value==='map-interactions','Unknown TROPNIK_BROWSER_DIAGNOSTIC mode');
 return{diagnostic:value,reportFile:value==='terrain-close'?'browser-terrain-diagnostic.json':'browser-map-interactions-diagnostic.json',profiles:['desktop-webgl']};
}
export function terrainDiagnosticTraceCategories(available=[]){
 const candidates=['cc','viz','disabled-by-default-gpu.service','disabled-by-default-gpu.device'];
 const enumerated=Array.isArray(available)&&available.length>0;
 const supported=enumerated?candidates.filter(category=>available.includes(category)):[];
 // An empty enumeration is not proof that no categories exist: the CI traces
 // contain GPU events while getCategories returns[]. Request only this fixed
 // small allowlist when availability is unknown; the trace reports real events.
 return{availability:enumerated?'enumerated':Array.isArray(available)?'unknown-empty-enumeration':'unknown-query-failed',availableCount:Array.isArray(available)?available.length:null,requested:candidates,supported,unverified:enumerated?[]:candidates,selected:[...DESKTOP_TRACE_CATEGORIES,...(enumerated?supported:candidates)]};
}
export async function queryTerrainTraceCategories(cdp){
 try{
  // CDP.call already resolves message.result, so this is the method payload.
  const payload=await cdp.call('Tracing.getCategories',{},3000);
  assert.ok(Array.isArray(payload?.categories)&&payload.categories.every(category=>typeof category==='string'),'Tracing.getCategories returned an invalid categories payload');
  return terrainDiagnosticTraceCategories(payload.categories);
 }catch(error){return{...terrainDiagnosticTraceCategories(null),error:error.message};}
}
export function terrainResource(url){
 let parsed;try{parsed=new URL(url);}catch{return null;}
 if(parsed.hostname!=='tiles.mapterhorn.com')return null;
 const match=parsed.pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.[a-z0-9]+$/i);
 return{url:parsed.href,kind:match?'dem-tile':parsed.pathname.endsWith('.json')?'dem-metadata':'dem-resource',tile:match?{z:Number(match[1]),x:Number(match[2]),y:Number(match[3])}:null};
}
/** Request/response evidence only; no source internals, payload rewriting or retries. */
export function observeTerrainResources(cdp,phase=()=>null){
 const requests=new Map(),limit=256;let observedRequests=0;
 const remember=(requestId,url)=>{
  const resource=terrainResource(url);if(!resource)return null;
  let entry=requests.get(requestId);
  if(!entry){entry={requestId,...resource,phase:phase(),finished:false};requests.set(requestId,entry);observedRequests++;if(requests.size>limit)requests.delete(requests.keys().next().value);}
  return entry;
 };
 const unobserve=[
  cdp.observe('Network.requestWillBeSent',({requestId,request,timestamp,wallTime})=>{const entry=remember(requestId,request?.url);if(entry)Object.assign(entry,{requestedAt:timestamp,wallTime});}),
  cdp.observe('Network.responseReceived',({requestId,response,timestamp})=>{const entry=remember(requestId,response?.url);if(entry)Object.assign(entry,{status:response.status,mimeType:response.mimeType,protocol:response.protocol,fromDiskCache:response.fromDiskCache===true,fromServiceWorker:response.fromServiceWorker===true,responseAt:timestamp});}),
  cdp.observe('Network.loadingFinished',({requestId,encodedDataLength,timestamp})=>{const entry=requests.get(requestId);if(entry)Object.assign(entry,{finished:true,bytes:encodedDataLength,finishedAt:timestamp});}),
  cdp.observe('Network.loadingFailed',({requestId,errorText,canceled,blockedReason,timestamp})=>{const entry=requests.get(requestId);if(entry)Object.assign(entry,{error:errorText,canceled:canceled===true,blockedReason:blockedReason||null,failedAt:timestamp});}),
 ];
 return{snapshot:()=>({sampleLimit:limit,observedRequests,discardedRequests:observedRequests-requests.size,tileLevels:[...new Set([...requests.values()].flatMap(entry=>entry.tile?[entry.tile.z]:[]))].sort((a,b)=>a-b),requests:structuredClone([...requests.values()])}),dispose:()=>unobserve.forEach(stop=>stop())};
}
/** Standard WebGL reads on the renderer's existing canvas. Never bind an FBO
 * or obtain an application/React/SDK instance through private fields. */
export function inspectTerrainWebGL(doc=document){
 const canvas=doc.querySelector('.terrain-scene.is-visible .terrain-canvas');if(!canvas)return{available:false,reason:'map-canvas-missing'};
 let type='webgl2',gl=canvas.getContext(type);if(!gl){type='webgl';gl=canvas.getContext(type);}
 if(!gl)return{available:false,reason:'context-unavailable'};
 const debug=gl.getExtension('WEBGL_debug_renderer_info');
 return{available:true,type,contextLost:gl.isContextLost(),attributes:gl.getContextAttributes(),renderer:gl.getParameter(gl.RENDERER),vendor:gl.getParameter(gl.VENDOR),version:gl.getParameter(gl.VERSION),unmaskedRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,unmaskedVendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,samples:gl.getParameter(gl.SAMPLES),sampleBuffers:gl.getParameter(gl.SAMPLE_BUFFERS),sampleScope:'currently-bound-framebuffer',defaultFramebufferBound:gl.getParameter(gl.FRAMEBUFFER_BINDING)===null,drawingBuffer:{width:gl.drawingBufferWidth,height:gl.drawingBufferHeight}};
}
/** Camera animation is exposed by the own renderer through the DOM only. */
export function mapCameraIsMoving(element){
 return element.dataset?.mapMoving==='true'||element.hasAttribute('data-map-camera');
}

/** A dataset can stay unchanged between zoomend and the next queued RAF.
 * Advance the real compositor before every sample, then require the same
 * idle camera on four observations. No renderer callbacks are invoked. */
export async function settleMapCamera({engine,read,frame,wait,clock=()=>performance.now(),allowLoading=false}){
 const started=clock(),startedAtEpochMs=Date.now(),samples=[];
 let signature='',stable=0,totalSamples=0,current,previous;
 try{return await wait(`The ${engine} map did not settle`,async()=>{
  const began=clock();current={index:++totalSamples,startedAtEpochMs:Date.now(),startOffsetMs:began-started,phase:'frame',frameMs:null,readMs:null};
  samples.push(current);if(samples.length>16)samples.shift();
  let readStarted;
  try{
   await frame();current.frameMs=clock()-began;current.phase='read';readStarted=clock();
   const state=await read();current.readMs=clock()-readStarted;current.phase='observed';current.state=structuredClone(state);
   current.changedFields=[];
   if(previous){
    for(const key of ['engine','route','moving','visible','width','height','scrollWidth'])if(!Object.is(previous[key],state?.[key]))current.changedFields.push(key);
    for(const group of ['camera','rect'])for(const key of new Set([...Object.keys(previous[group]||{}),...Object.keys(state?.[group]||{})]))if(!Object.is(previous[group]?.[key],state?.[group]?.[key]))current.changedFields.push(`${group}.${key}`);
   }
   previous=current.state;return state;
  }catch(error){
   if(current.phase==='frame')current.frameMs=clock()-began;else if(readStarted!==undefined)current.readMs=clock()-readStarted;
   current.error=error?.message||String(error);throw error;
  }finally{current.durationMs=clock()-began;current.endOffsetMs=clock()-started;}
 },state=>{
  if(!state?.visible||state.moving||state.engine!==engine||!Object.values(state.camera).every(Number.isFinite)||
    (engine==='tropnik-canvas'&&(!state.rendering?.painted||!state.rendering.coverageReady||!['ready',...(allowLoading?['loading']:[])].includes(state.rendering.tilesState)||state.rendering.drawnRoute!==state.route))){
   signature='';stable=0;current.idleObservations=0;current.signatureUnchanged=false;return false;
  }
  const next=JSON.stringify([state.camera,state.rect,state.route]);current.signatureUnchanged=next===signature;stable=next===signature?stable+1:0;signature=next;current.idleObservations=stable+1;return stable>=3;
 },15000);}catch(error){
  error.settleDiagnostics={schemaVersion:1,engine,timeoutMs:15000,requiredIdleObservations:4,comparison:'exact-camera-rect-route',sampleLimit:16,startedAtEpochMs,elapsedMs:clock()-started,totalSamples,discardedSamples:totalSamples-samples.length,samples};
  throw error;
 }
}

/** Opt-in recording around one existing +1 input, never a diagnostic retry. */
export function shouldTraceTerrainZoom(profile,mode,direction,beforeZoom,alreadyTraced,traceEnabled=false){
 return traceEnabled&&!alreadyTraced&&profile.name==='desktop-webgl'&&profile.engine==='tropnik-canvas'&&!profile.mobile&&mode==='scene3d'&&direction>0&&beforeZoom>=4&&beforeZoom<5;
}

/** Bounds of independent overlays. Parents and children must not both enter
 * ui: credit text, the credit toggle and its popover are separate surfaces. */
export function assertMapUIBounds(layout,context){
 assert.ok(layout.scrollWidth<=layout.width+1,`${context}: horizontal overflow`);
 assert.ok(Math.abs(layout.scrollY)<=1,`${context}: map navigation scrolled the page`);
 const inside=(r,b)=>r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1;
 for(const item of layout.ui)assert.ok(inside(item.rect,layout.available),`${context}: ${item.kind} leaves the usable map: ${JSON.stringify({rect:item.rect,available:layout.available})}`);
 for(let i=0;i<layout.ui.length;i++)for(let j=i+1;j<layout.ui.length;j++){
  const a=layout.ui[i],b=layout.ui[j],width=Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left),height=Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top);
  assert.ok(width<=1||height<=1,`${context}: ${a.kind} overlaps ${b.kind} (${width}×${height}px)`);
 }
 for(const target of layout.targets){
  const minimumSize=target.minimumSize??44;
  assert.ok(target.rect.width>=minimumSize-.5&&target.rect.height>=minimumSize-.5,`${context}: ${target.label} is smaller than ${minimumSize}px`);
  assert.equal(target.unobscured,true,`${context}: ${target.label} is covered`);
 }
}

/** Send native events in wire order without stretching a touch hold while
 * Chromium acknowledges/paints the preceding event. CDP.call sends on the
 * single socket synchronously. Drain every ACK before returning or throwing. */
export async function dispatchZoomBurst(cdp,point,profile,count=4){
 assert.ok(Number.isFinite(point.x)&&Number.isFinite(point.y));
 assert.ok(Number.isInteger(count)&&count>0&&count<=4);
 const started=performance.now(),startedAtEpochMs=Date.now(),commands=[],acknowledgements=[];
 const enqueue=(method,params)=>{
  const sent=performance.now(),command={index:commands.length,method,type:params.type,sentAtEpochMs:Date.now(),sentOffsetMs:sent-started};commands.push(command);
  let acknowledgement;
  try{acknowledgement=cdp.call(method,params);}catch(error){acknowledgement=Promise.reject(error);}
  acknowledgements.push(Promise.resolve(acknowledgement).then(()=>{
   command.ackAtEpochMs=Date.now();command.ackOffsetMs=performance.now()-started;command.ackDurationMs=performance.now()-sent;command.status='fulfilled';
  },error=>{
   command.ackAtEpochMs=Date.now();command.ackOffsetMs=performance.now()-started;command.ackDurationMs=performance.now()-sent;command.status='rejected';command.error=error?.message||String(error);throw error;
  }));
 };
 if(!profile.mobile)enqueue('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,pointerType:'mouse'});
 for(let index=0;index<count;index++){
  if(profile.mobile){
   enqueue('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:81,radiusX:3,radiusY:3,force:1}]});
   enqueue('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }else{
   enqueue('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});
   enqueue('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});
  }
 }
 const producerDurationMs=performance.now()-started,results=await Promise.allSettled(acknowledgements);
 const receipt={count,dispatchMode:'ordered-native',startedAtEpochMs,producerDurationMs,durationMs:performance.now()-started,input:profile.mobile?'touch':'mouse',commands};
 const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason);
 if(failures.length){const error=new AggregateError(failures,`Native zoom input failed: ${failures[0]?.message||String(failures[0])}`);error.inputDiagnostics=receipt;throw error;}
 return receipt;
}

/** Real-input zoom coverage plus reviewable images. Network/source availability
 * is reported separately from geometry checks; a fallback is never called a
 * successfully rendered satellite or 3D scene. */
export async function runZoomDesignAudit(cdp,profile,helpers,{diagnostic=null,traceEnabled=false}={}){
 const {loadProfile,evaluate,waitValue,sleep,settledMap,closeMapSheet,clearMapStories,elementPoint,pointerAt,pointerSelector,diagnosticPhase}=helpers;
 assert.ok(diagnostic===null||diagnostic==='terrain-close','Unknown zoom diagnostic mode');
 if(diagnostic)assert.ok(profile.name==='desktop-webgl'&&!profile.mobile,'The terrain diagnostic requires the desktop profile');
 await mkdir(OUTPUT,{recursive:true});
 const report={profile:profile.name,engine:profile.engine,input:profile.mobile?'touch':'mouse',schemaVersion:8,geometryPassed:false,visualReviewRequired:true,maximumZoom:18,keyZooms:KEY_ZOOMS,detailSteps:[],screenshots:[],modes:{},startedAt:new Date().toISOString()};
 if(diagnostic)Object.assign(report,{schemaVersion:1,diagnosticOnly:true,verified:false,releaseEligible:false,diagnostic,sourceCommit:process.env.GITHUB_SHA||null,status:'starting',diagnosticStage:'loading-route',nativeZooms:[]});
 let terrainTraceStarted=false;
 const terrainResources=diagnostic?observeTerrainResources(cdp,()=>report.diagnosticStage):null;
 const save=()=>{if(terrainResources)report.dem=terrainResources.snapshot();return writeFile(new URL(diagnostic?'desktop-webgl-terrain-diagnostic.json':`${profile.name}.json`,OUTPUT),JSON.stringify(report,null,2)+'\n');};
 const network=new Map();
 const forget=cdp.observe('Network.responseReceived',({requestId,response})=>{
  if(!response?.url)return;
  const path=new URL(response.url).pathname;
  const source=response.url.startsWith('https://tiles.maps.eox.at/')?'satellite':/\/(?:data\/(?:russia-(?:display-area|outside-mask|canonical-mask)|territories)\.geojson|maps\/russia-relief\/)/.test(path)?'overview':null;
  if(!source)return;
  network.set(requestId,{source,path,status:response.status,mimeType:response.mimeType,fromDiskCache:response.fromDiskCache===true,finished:false});
  if(network.size>512)network.delete(network.keys().next().value);
 });
 const forgetFinished=cdp.observe('Network.loadingFinished',({requestId,encodedDataLength})=>{const tile=network.get(requestId);if(tile){tile.finished=true;tile.bytes=encodedDataLength;}});
 const forgetFailed=cdp.observe('Network.loadingFailed',({requestId,errorText})=>{const tile=network.get(requestId);if(tile)tile.error=errorText;});
 await cdp.call('Network.enable');
 async function geometry(mode){
  const map=await settledMap(cdp,profile.engine);
  const layout=await evaluate(cdp,`(()=>{
   const visible=element=>{if(!element)return false;const s=getComputedStyle(element),r=element.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>1&&r.height>1};
   const box=element=>{const r=element.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
   const atlas=document.querySelector('.atlas-wrap'),map=box(atlas),panel=document.querySelector('.explore-panel'),sheet=panel&&box(panel),root=document.querySelector('.explore-layout');
   const mobile=matchMedia('(max-width:700px),(min-width:701px) and (max-width:900px) and (max-height:620px) and (orientation:landscape) and (pointer:coarse)').matches;
   const available={left:Math.max(0,map.left),right:Math.min(innerWidth,map.right),top:Math.max(0,map.top),bottom:Math.min(innerHeight,map.bottom,mobile&&sheet&&root?.dataset.sheetState==='closed'?sheet.top:Infinity)};
   // An expanded story is a separate scrollable panel. Inspect its collapsed
   // launcher here; the existing story suite exercises the expanded surface.
   const ui=[...document.querySelectorAll('.map-context,.map-style-switch,.map-controls,.layer-button,.map-message,.map-preload-status,.fact-closed,.map-attribution-toggle,.map-attribution-content,.map-satellite-credit,.map-legend')].filter(visible).map(element=>({kind:element.className,rect:box(element)}));
   const targets=[...document.querySelectorAll('.map-style-switch button,.map-controls button:not([disabled]),.layer-button,.map-message button,.fact-closed,.map-attribution-toggle')].filter(visible).map(element=>{
    const r=box(element),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,hit=document.elementFromPoint(x,y);return{label:element.getAttribute('aria-label')||element.textContent?.trim(),rect:r,minimumSize:44,unobscured:!!hit&&element.contains(hit)};
   });
   const labels=[...document.querySelectorAll('.region-marker-label,.route-edge-label')].filter(visible).map(element=>({label:element.textContent,rect:box(element)}));
   return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY:window.scrollY,available,ui,targets,labels,detail:atlas.dataset.mapDetail||'',selectedRoute:atlas.dataset.mapRoute||'',imagery:atlas.dataset.mapImagery||'',routeEdgeCount:document.querySelectorAll('.route-edge-marker[role="img"]').length,status:document.querySelector('.map-message')?.textContent?.trim()||'',loadedSatelliteTiles:(JSON.parse(document.querySelector('.atlas-canvas')?.dataset.mapInspection||'null')?.tiles?.imagery?.length||0)};
  })()`);
  const bitmapInspection=profile.engine==='tropnik-canvas'?await evaluate(cdp,`(${inspectCustomMapDOM.toString()})()`):undefined;
  if(bitmapInspection)assertCustomMapInspection(bitmapInspection,`${profile.name}/${mode}`,{routeId:'kavkaz-8a'});
  report.lastInspection={mode,zoom:map.camera.zoom,...layout,...(bitmapInspection?{bitmapInspection}:{})};
  assert.equal(map.route,'kavkaz-8a',`${profile.name}/${mode}: changing zoom/base map lost the selected route`);
  assertMapUIBounds(layout,`${profile.name}/${mode}/${map.camera.zoom}`);
  assert.ok(layout.routeEdgeCount<=2,`${profile.name}/${mode}: route edge annotations grew with vertex count`);
  return{mode,zoom:map.camera.zoom,camera:map.camera,routeId:map.route,...layout,...(bitmapInspection?{bitmapInspection}:{}),...(diagnostic?{terrainCamera:map.terrainCamera??null}:{})};
 }
 async function capture(mode,state,label=''){
  const zoom=Number.isFinite(state?.zoom)?`z${state.zoom.toFixed(2).replace('.','_')}`:label||'scene';
  const name=`${profile.name}-${mode}-${zoom}${label&&Number.isFinite(state?.zoom)?`-${label}`:''}.png`;
  const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  const bytes=Buffer.from(image.data,'base64');await writeFile(new URL(name,OUTPUT),bytes);
  const evidence={file:name,mode,...(Number.isFinite(state?.zoom)?{zoom:state.zoom}:{}),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  report.screenshots.push(evidence);await save();return evidence;
 }
 async function zoom(direction,{mode}={}){
  const before=await settledMap(cdp,profile.engine),target=await elementPoint(cdp,direction>0?PLUS:MINUS);
  assert.ok(target?.unobscured,`${profile.name}: zoom control is unavailable`);
  if(diagnostic)report.lastNativeZoom={direction,beforeZoom:before.camera.zoom,point:{x:target.x,y:target.y},startedAtEpochMs:Date.now()};
  const pressAndSettle=async()=>{await pointerAt(cdp,target,profile);await sleep(70);return settledMap(cdp,profile.engine);};
  const after=await pressAndSettle();
  assert.ok(direction>0?after.camera.zoom>=before.camera.zoom-.001:after.camera.zoom<=before.camera.zoom+.001,`${profile.name}: zoom moved in the wrong direction`);
  const movement={before:before.camera.zoom,after:after.camera.zoom,changed:Math.abs(after.camera.zoom-before.camera.zoom)>.001};
  if(diagnostic)report.nativeZooms.push({...report.lastNativeZoom,...movement});
  return movement;
 }
 async function reachBottom(){
  for(let count=0;count<28;count++){
   const result=await zoom(-1);
   if(!result.changed){
    // Confirm without another press: a delayed queued movement must not be
    // mistaken for the lower bound or hidden by an extra zoom input.
    const confirmed=await settledMap(cdp,profile.engine);
    assert.ok(confirmed.camera.zoom<=result.before+.001,`${profile.name}: the lower-bound confirmation moved upwards`);
    if(Math.abs(confirmed.camera.zoom-result.before)<.001)return confirmed.camera.zoom;
   }
  }
  throw new Error(`${profile.name}: zoom did not reach its lower bound`);
 }
 async function reachZoom(target){
  for(let count=0;count<28;count++){
   const state=await settledMap(cdp,profile.engine);
   if(state.camera.zoom>=target-.01)return state.camera.zoom;
   const result=await zoom(1);if(!result.changed)break;
  }
  throw new Error(`${profile.name}: zoom did not reach ${target}`);
 }
 async function fastZoomBurst(direction){
  const before=await settledMap(cdp,profile.engine),label=direction>0?'Увеличить масштаб':'Уменьшить масштаб';
  const point=await elementPoint(cdp,direction>0?PLUS:MINUS);
  assert.ok(point?.unobscured,`${profile.name}: the burst zoom control is unavailable`);
  const step=1,count=4;
  const expected=Math.min(18,Math.max(report.minimumZoom,before.camera.zoom+direction*step*count));
  const start=await evaluate(cdp,'({time:performance.now(),timeOrigin:performance.timeOrigin,scrollY:window.scrollY})');
  report.lastZoomBurst={direction,step,beforeZoom:before.camera.zoom,expectedZoom:expected,domSampleStartedAtMs:start.time};
  let input;
  try{input=await dispatchZoomBurst(cdp,point,profile,count);}catch(error){Object.assign(report.lastZoomBurst,error.inputDiagnostics||{});throw error;}
  Object.assign(report.lastZoomBurst,input);
  const after=await waitValue(`${profile.name}: rapid zoom did not accumulate all four presses`,()=>settledMap(cdp,profile.engine),state=>Math.abs(state.camera.zoom-expected)<.01,4000);
  const delivered=await evaluate(cdp,`(()=>{const events=(window.__tropnikInputEvents||[]).filter(event=>event.time>=${start.time}&&event.button?.label===${JSON.stringify(label)}).map(({type,time,timestamp,pointerType,pointerId,trusted})=>({type,time,timestamp,pointerType,pointerId,trusted})),clicks=events.filter(event=>event.type==='click'&&event.trusted);return{events,clicks:clicks.length,eventSpanMs:clicks.length>1?clicks.at(-1).time-clicks[0].time:0,scrollY:window.scrollY,recentLongTasks:(window.__tropnikLongTasks||[]).slice(-32),performance:{...window.__tropnikPerf}};})()`);
  const firstPress=input.commands.find(command=>command.type==='touchStart'||command.type==='mousePressed');
  const result={...input,direction,step,beforeZoom:before.camera.zoom,expectedZoom:expected,afterZoom:after.camera.zoom,receivedClicks:delivered.clicks,eventSpanMs:delivered.eventSpanMs,eventOrderVerified:false,events:delivered.events,domSampleStartedAtMs:start.time,domTimeOrigin:start.timeOrigin,firstInputLagMs:delivered.events.length?start.timeOrigin+delivered.events[0].time-firstPress.sentAtEpochMs:null,recentLongTasks:delivered.recentLongTasks,performance:delivered.performance,pageScrollDeltaPx:Math.abs(delivered.scrollY-start.scrollY)};
  report.lastZoomBurst=result;
  assert.equal(delivered.clicks,count,`${profile.name}: the browser did not deliver four distinct trusted zoom clicks: ${JSON.stringify(result)}`);
  result.eventOrderVerified=assertNativeBurstEventOrder(delivered.events,input.input,count);
  assert.ok(delivered.eventSpanMs<200,`${profile.name}: the zoom clicks did not reach the UI within one animation: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(after.camera.zoom-expected)<.01,`${profile.name}: rapid zoom lost an input while the camera was animating: ${JSON.stringify(result)}`);
  assert.ok(result.pageScrollDeltaPx<=1,`${profile.name}: rapid zoom scrolled the page`);
  assert.equal(after.route,before.route,`${profile.name}: rapid zoom lost the selected route`);
  return{...result,selectionPreserved:true,passed:true};
 }
 async function rapidZoomControls(){
  const before=await settledMap(cdp,profile.engine);
  assert.ok(before.camera.zoom>=9.5&&before.camera.zoom<=11,`${profile.name}: burst zoom must start away from either clamp`);
  const increase=await fastZoomBurst(1);
  report.zoomBurst={passed:false,input:profile.mobile?'touch':'mouse',increase};
  const decrease=await fastZoomBurst(-1);
  assert.ok(Math.abs(decrease.afterZoom-before.camera.zoom)<.01,`${profile.name}: opposite zoom bursts did not return to their starting scale`);
  const result={passed:true,input:profile.mobile?'touch':'mouse',increase,decrease,returnedToStart:true};
  report.zoomBurst=result;await save();return result;
 }
 async function sweep(mode,direction,{allSteps=false}={}){
  const steps=[],captured=new Set();
  let previous;
  for(let count=0;count<29;count++){
   const state=await geometry(mode);steps.push(state);
   if(allSteps)report.detailSteps.push(state);
   if(allSteps&&!report.zoomBurst&&state.zoom>=9.5&&state.zoom<=11)await rapidZoomControls();
   for(const threshold of KEY_ZOOMS){
    const crossed=direction>0?state.zoom>=threshold-.01&&(previous===undefined||previous<threshold):state.zoom<=threshold+.01&&(previous===undefined||previous>threshold);
    if(crossed&&!captured.has(threshold)){await capture(mode,state,`key${threshold}`);captured.add(threshold);}
   }
   if(direction>0&&state.zoom>=17.999)break;
   previous=state.zoom;const step=await zoom(direction,{mode});
   if(!step.changed){if(direction>0)assert.ok(state.zoom>=17.999,`${profile.name}: zoom stopped below18`);break;}
   if(count===28)throw new Error(`${profile.name}: zoom sweep exceeded its bounded range`);
  }
  return steps;
 }
 async function layerButton(label,{confirmSelected=false}={}){
  await pointerSelector(cdp,'.layer-button',profile);
  const target=await waitValue(`${profile.name}: ${label} layer is unavailable`,()=>evaluate(cdp,`(()=>{const button=[...document.querySelectorAll('.layer-menu button')].find(item=>item.textContent?.trim()===${JSON.stringify(label)});if(!button||button.disabled)return null;const r=button.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,unobscured:!!hit&&button.contains(hit)};})()`),value=>value?.unobscured);
  await pointerAt(cdp,target,profile);
  let selected=false;
  if(confirmSelected)selected=await waitValue(`${profile.name}: ${label} did not become the selected layer`,()=>evaluate(cdp,`(()=>{const button=[...document.querySelectorAll('.layer-menu button')].find(item=>item.textContent?.trim()===${JSON.stringify(label)});return!!button?.querySelector('svg');})()`),Boolean);
  if(await elementPoint(cdp,'.layer-menu'))await pointerSelector(cdp,'.layer-button',profile);
  return{selectedControl:selected};
 }
 async function satelliteEvidence(){
  const ui=await evaluate(cdp,`(()=>({active:document.querySelector('.atlas-wrap')?.dataset.mapImagery==='satellite',status:document.querySelector('.map-message')?.textContent?.trim()||'',loadedTiles:(JSON.parse(document.querySelector('.atlas-canvas')?.dataset.mapInspection||'null')?.tiles?.imagery?.length||0)}))()`);
  const responses=[...network.values()].filter(item=>item.source==='satellite');
  return{...ui,finishedImageResponses:responses.filter(item=>item.finished&&item.status===200&&item.mimeType?.startsWith('image/')).length,failedResponses:responses.filter(item=>item.error||item.status>=400).length};
 }
 async function savedOverview(){
  await diagnosticPhase(cdp,'zoom-design-saved-overview');
  const selection=await layerButton('Сохранённый обзор',{confirmSelected:true});
  await settledMap(cdp,profile.engine);await reachBottom();
  const keySteps=[];
  for(const targetZoom of KEY_ZOOMS){
   await reachZoom(targetZoom);
   const state={...await geometry('saved-overview'),targetZoom};keySteps.push(state);
   await capture('saved-overview',state,`key${targetZoom}`);
  }
  const responses=[...network.values()].filter(item=>item.source==='overview');
  const sourceEvidence={
   geoJSON:responses.filter(item=>item.path.endsWith('.geojson')),
   finishedReliefImageResponses:responses.filter(item=>item.finished&&item.status===200&&item.mimeType?.startsWith('image/')).length,
   failedResponses:responses.filter(item=>item.error||item.status>=400).length,
   loadedReliefTiles:await evaluate(cdp,"(JSON.parse(document.querySelector('.atlas-canvas')?.dataset.mapInspection||'null')?.tiles?.overview?.length||0)"),
  };
  // The checkmark confirms the selected UI mode. Source responses only prove
  // data availability; the screenshots still require a visual review.
  report.modes.overview={state:'active',...selection,keySteps,sourceEvidence,visualReviewRequired:true};
  await save();
 }
 async function closeTrailEdges(){
  // This canonical short route has one continuous, twelve-vertex source
  // line. The main audit deliberately keeps its multipart Bzerpin fixture.
  const bytes=await readFile(new URL(`../../web/public${CLOSE_TRAIL_FIXTURE.geometryURL}`,import.meta.url)),source=JSON.parse(bytes.toString());
  const lines=source.features?.[0]?.geometry?.coordinates;
  assert.equal(source.type,'FeatureCollection');assert.equal(source.features?.length,1);assert.equal(source.features[0].geometry.type,'MultiLineString');
  assert.equal(lines?.length,1);assert.equal(lines[0].length,12);
  const endpoints=[lines[0][0],lines[0].at(-1)];assert.deepEqual(endpoints,CLOSE_TRAIL_FIXTURE.endpoints);
  const audit={passed:false,input:report.input,region:CLOSE_TRAIL_FIXTURE.region,routeId:CLOSE_TRAIL_FIXTURE.routeId,geometryURL:CLOSE_TRAIL_FIXTURE.geometryURL,
   source:{featureCount:source.features.length,partCount:lines.length,vertexCount:lines[0].length,endpoints,sha256:createHash('sha256').update(bytes).digest('hex')},
   setupClicks:0,nativeZoomClicks:0,inputs:[],frames:[],visualReviewRequired:true};
  report.closeTrail=audit;await save();
  await loadProfile(cdp,`${helpers.url}?region=${audit.region}&route=${audit.routeId}`,profile);
  const setupStart=await evaluate(cdp,'performance.now()');
  await clearMapStories(cdp,profile);await closeMapSheet(cdp,profile);
  audit.setupClicks=await evaluate(cdp,`(window.__tropnikInputEvents||[]).filter(event=>event.time>=${setupStart}&&event.type==='click'&&event.trusted).length`);
  assert.ok(audit.setupClicks<=3,`${profile.name}: unexpected native setup input in the source-end audit`);
  await diagnosticPhase(cdp,'zoom-design-source-ends');
  await waitValue(`${profile.name}: the single-line source did not render`,()=>helpers.mapState(cdp),state=>state?.route===audit.routeId);
  audit.initialZoom=(await settledMap(cdp,profile.engine)).camera.zoom;
  assert.ok(Math.abs(audit.initialZoom-14)<.01,`${profile.name}: the short source route did not fit at zoom14`);
  async function inspectSourceEnds(targetZoom){
   const map=await settledMap(cdp,profile.engine);
   const layout=await evaluate(cdp,`(()=>{
    const box=element=>{const r=element.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const visible=element=>{if(!element)return false;const s=getComputedStyle(element),r=element.getBoundingClientRect();if(s.visibility==='hidden'||s.visibility==='collapse'||r.width<=1||r.height<=1)return false;for(let parent=element;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||Number(style.opacity)===0||parent.hidden)return false;}return true;};
    const part=element=>({text:element?.textContent?.trim()||'',visible:visible(element),pointerEvents:element?getComputedStyle(element).pointerEvents:'',rect:element?box(element):null});
    const atlas=document.querySelector('.atlas-wrap'),r=box(atlas),panel=document.querySelector('.explore-panel'),root=document.querySelector('.explore-layout');
    const mobile=matchMedia('(max-width:700px),(min-width:701px) and (max-width:900px) and (max-height:620px) and (orientation:landscape) and (pointer:coarse)').matches;
    const available={left:Math.max(0,r.left),right:Math.min(innerWidth,r.right),top:Math.max(0,r.top),bottom:Math.min(innerHeight,r.bottom,mobile&&panel&&root?.dataset.sheetState==='closed'?panel.getBoundingClientRect().top:Infinity)};available.width=available.right-available.left;available.height=available.bottom-available.top;
    const params=new URLSearchParams(location.search);
    return{available,scrollY:window.scrollY,region:params.get('region')||'',queryRoute:params.get('route')||'',selectedRoute:atlas.dataset.mapRoute||'',imagery:atlas.dataset.mapImagery||'',sceneVisible:visible(document.querySelector('.terrain-scene.is-visible')),
     overlays:[...document.querySelectorAll('.map-context,.map-style-switch,.map-controls,.layer-button,.map-message,.map-preload-status,.fact-closed,.map-attribution-toggle,.map-attribution-content,.map-satellite-credit,.map-legend')].filter(visible).map(element=>({kind:element.className,rect:box(element)})),
     markers:[...document.querySelectorAll('.route-edge-marker[role="img"]')].map(element=>({role:element.getAttribute('role'),ariaLabel:element.getAttribute('aria-label'),density:element.dataset.routeEdgeDensity||'',pointerEvents:getComputedStyle(element).pointerEvents,rect:box(element),badge:part(element.querySelector('.route-edge-badge')),caption:part(element.querySelector('.route-edge-label'))}))};
   })()`);
   const bitmapInspection=await waitValue(`${profile.name}: relief did not commit its actual current bitmap batch`,()=>evaluate(cdp,`(${inspectCustomMapDOM.toString()})()`),value=>value?.state?.loading===false&&value.state.reliefReady===true&&value.tiles?.relief?.length>0,15000);
   const reliefPalette={engine:profile.engine,bitmapInspection};
   assertReliefPalette(reliefPalette,`${profile.name}/source-ends/${map.camera.zoom}`,profile.engine);
   return{targetZoom,zoom:map.camera.zoom,camera:map.camera,mapRect:map.rect,routeId:map.route,inputCount:audit.inputs.length,reliefPalette,...layout};
  }
  async function frameCloseSourceEnds(before){
   const framing={required:!sourceEndsAreFramed(before),passed:false,before,gestures:[]};audit.closeFraming=framing;
   let frame=before;
   // A second gesture is permitted only from freshly observed post-pan bounds.
   for(let attempt=0;attempt<2&&!sourceEndsAreFramed(frame);attempt++){
    const plans=sourceEndPanPlans(frame);
    const target=await evaluate(cdp,`(()=>{
     for(const plan of ${JSON.stringify(plans)})for(const start of plan.starts){
      let clear=true;
      for(let step=0;step<=12;step++){
       const x=start.x+plan.dx*step/12,y=start.y+plan.dy*step/12,hit=document.elementFromPoint(x,y);
       if(!hit||hit.tagName!=='CANVAS'||!hit.closest('.atlas-canvas')){clear=false;break;}
      }
      if(clear)return{start,delta:{dx:plan.dx,dy:plan.dy}};
     }
     return null;
    })()`);
    assert.ok(target,`${profile.name}: no exposed Canvas path can frame both source ends`);
    const started=await evaluate(cdp,'performance.now()'),prior=frame;
    const pan=await dispatchSourceEndPan(cdp,target.start,target.delta,profile,sleep);
    frame=await inspectSourceEnds(17);
    pan.events=await evaluate(cdp,`(window.__tropnikInputEvents||[]).filter(event=>event.time>=${started}).map(({type,time,timestamp,pointerType,pointerId,trusted,x,y})=>({type,time,timestamp,pointerType,pointerId,trusted,x,y}))`);
    Object.assign(pan,{canvasPathVerified:true,before:prior,after:frame});framing.gestures.push(pan);await save();
    assert.ok(Math.abs(frame.zoom-prior.zoom)<.01,`${profile.name}: source-end pan changed the zoom`);
    assertRouteEdgeFrame(frame,`${profile.name}/source-ends/after-pan`);
   }
   assertRouteEdgeFrame(frame,`${profile.name}/source-ends/full-close`,{requireFullCaptions:true});
   framing.passed=true;return frame;
  }
  for(const [index,targetZoom] of [11,14,17].entries()){
   let current=(await settledMap(cdp,profile.engine)).camera.zoom;
   while(Math.abs(current-targetZoom)>.01){
    assert.ok(audit.nativeZoomClicks+audit.setupClicks<15,`${profile.name}: source-end coverage exceeded15 native inputs`);
    const direction=targetZoom>current?1:-1,label=direction>0?'Увеличить масштаб':'Уменьшить масштаб',start=await evaluate(cdp,'performance.now()');
    const movement=await zoom(direction);
    const events=await evaluate(cdp,`(window.__tropnikInputEvents||[]).filter(event=>event.time>=${start}&&event.button?.label===${JSON.stringify(label)}).map(({type,time,timestamp,pointerType,pointerId,trusted})=>({type,time,timestamp,pointerType,pointerId,trusted}))`);
    const input={direction,input:report.input,before:movement.before,after:movement.after,events};audit.inputs.push(input);audit.nativeZoomClicks++;
    assertNativeBurstEventOrder(events,report.input,1);assert.equal(movement.changed,true,`${profile.name}: a source-end zoom control stopped responding`);
    current=movement.after;
   }
   let frame=await inspectSourceEnds(targetZoom);
   if(index===2)frame=await frameCloseSourceEnds(frame);
   audit.frames.push(frame);report.lastInspection={mode:'source-ends',...frame};
   frame.screenshot=(await capture('source-ends',frame,['crowded','separated','close'][index])).file;
   assertRouteEdgeFrame(frame,`${profile.name}/source-ends/${frame.zoom}`,{requireBothVisible:index===1,requireFullCaptions:index===2});await save();
  }
  audit.performance=await evaluate(cdp,'({layoutShift:window.__tropnikPerf?.cls||0,longestTaskMs:window.__tropnikPerf?.longest||0})');
  assertCloseTrailAudit({...audit,passed:true},profile.name,profile.engine,profile.mobile,report.screenshots);
  audit.passed=true;await save();return audit;
 }
 try{
  // A real public deep link selects a known source geometry in the prepared
  // Bzerpin area. The earlier map suite separately proves pointer selection.
  await loadProfile(cdp,`${helpers.url}?region=krasnodar&route=kavkaz-8a`,profile);
  await clearMapStories(cdp,profile);await closeMapSheet(cdp,profile);
  await diagnosticPhase(cdp,diagnostic?'terrain-diagnostic-loading':'zoom-design-detail');
  const route=await waitValue(`${profile.name}: the zoom audit route did not render`,()=>helpers.mapState(cdp),state=>state?.route==='kavkaz-8a');
  report.routeId=route.route;
  if(!diagnostic){
  await capture('route-fit',await geometry('detail'));
  report.minimumZoom=await reachBottom();
  await capture('overview',await geometry('detail'));
  await sweep('detail',1,{allSteps:true});
  report.modes.detail={state:'checked',stepCount:report.detailSteps.length,firstZoom:report.detailSteps[0].zoom,lastZoom:report.detailSteps.at(-1).zoom};
  await diagnosticPhase(cdp,'zoom-design-satellite');
  await layerButton('Спутник');
  let satellite;
  for(let attempt=0;attempt<30;attempt++){
   satellite=await satelliteEvidence();
   if(satellite.active&&(satellite.loadedTiles>0||satellite.finishedImageResponses>0)||satellite.status.includes('Спутниковые снимки не загрузились'))break;
   await sleep(200);
  }
  if(satellite.active){
   await reachZoom(18);
   const steps=await sweep('satellite',-1);
   const after=await satelliteEvidence();
   report.modes.satellite={state:after.active?'active':'fallback',...after,stepCount:steps.length,steps,visualReviewRequired:true};
  }else{
   report.modes.satellite={state:satellite.status?'fallback':'unavailable',...satellite,stepCount:0,visualReviewRequired:true};
   await capture('satellite-unavailable',await geometry('fallback'));
  }
  await savedOverview();
  await layerButton('Тропы и ландшафт');
  await waitValue(`${profile.name}: leaving satellite did not restore map controls`,()=>evaluate(cdp,"document.querySelector('.atlas-wrap')?.dataset.mapImagery!=='satellite'"),Boolean);
  await settledMap(cdp,profile.engine);
  }
  const terrainButton='.map-style-switch button[aria-label="Рельеф всей карты"]';
  report.modes.terrain={state:'scene',kind:'georeferenced-current-viewport'};
  const sceneButton=terrainButton;
  const sceneAvailable=await elementPoint(cdp,sceneButton);
  if(sceneAvailable?.unobscured){
   await diagnosticPhase(cdp,'zoom-design-scene');await reachZoom(14);const beforeScene=await settledMap(cdp,profile.engine);
   beforeScene.bitmapInspection=await evaluate(cdp,`(${inspectCustomMapDOM.toString()})()`);
   beforeScene.viewportLayout=await evaluate(cdp,`(()=>{const element=document.querySelector('.atlas-canvas'),panel=element?.closest('.explore-layout')?.querySelector('.explore-panel'),r=panel?.getBoundingClientRect();return{width:innerWidth,height:innerHeight,panel:r?{left:r.left,right:r.right,top:r.top,bottom:r.bottom}:null};})()`);
   await pointerSelector(cdp,sceneButton,profile);
   const sceneState=()=>evaluate(cdp,`(()=>{const scene=document.querySelector('.terrain-scene.is-visible'),canvas=scene?.querySelector('canvas'),r=canvas?.getBoundingClientRect(),data=canvas?.dataset,notice=document.querySelector('.atlas-wrap>.map-message'),noticeRect=notice?.getBoundingClientRect(),noticeStyle=notice&&getComputedStyle(notice);return{inspection:JSON.parse(scene?.dataset.terrainInspection||'null'),visible:!!scene,ready:scene?.classList.contains('is-ready')===true,retainedMapNoticeVisible:!!noticeRect&&noticeRect.width>0&&noticeRect.height>0&&noticeStyle.display!=='none'&&noticeStyle.visibility!=='hidden'&&Number(noticeStyle.opacity)!==0,error:scene?.querySelector('.terrain-progress')?.textContent?.trim()||'',canvas:r?{width:r.width,height:r.height,renderer:data.renderer||'',triangles:Number(data.triangles||0),sourceVertices:Number(data.sourceVertices||0),meshStride:Number(data.meshStride||0),renderMs:Number(data.renderMs||0)}:null}})()`);
   let scene;
   for(let attempt=0;attempt<60;attempt++){scene=await sceneState();if(scene.error||scene.ready&&(scene.inspection?.cartography?.state!=='loading'&&scene.inspection?.frame?.cartography?.loadedTiles===scene.inspection?.cartography?.source?.loadedTiles))break;await sleep(250);}
   assert.equal(scene.ready,true,'Custom terrain never rendered its actual source grid');assertCustomSceneInspection(scene.inspection,profile.name+'/terrain');assert.equal(scene.inspection.cartography?.state,'ready','The known mapped area lost its real land-cover texture');
   if(diagnostic){
    report.gpu={traceCategories:await queryTerrainTraceCategories(cdp)};
    try{assert.ok(helpers.systemInfo,'No browser-level SystemInfo target');const info=await helpers.systemInfo();report.gpu.systemInfo={available:true,gpu:info.gpu,modelName:info.modelName,modelVersion:info.modelVersion};}catch(error){report.gpu.systemInfo={available:false,error:error.message};}
    try{report.gpu.webgl=await evaluate(cdp,`(${inspectTerrainWebGL.toString()})()`);}catch(error){report.gpu.webgl={available:false,error:error.message};}
   }
   const initial=await capture('scene3d',null,'overview');
   if(scene.ready){
    assert.equal(scene.retainedMapNoticeVisible,false,`${profile.name}: a retained 2D map notice covers the ready 3D scene`);
    assert.ok(scene.canvas?.triangles>0&&['webgl2','canvas2d'].includes(scene.canvas.renderer),`${profile.name}: a ready3D scene has no recorded rendered mesh`);
    const nativeInputs=[];const sceneZoom=async label=>{
     await evaluate(cdp,'window.__tropnikInputEvents=[]');
     const point=await elementPoint(cdp,`.terrain-controls button[aria-label="${label}"]`);
     assert.ok(point?.unobscured,`${profile.name}: ${label} is not reachable`);
     const press=async()=>{await pointerAt(cdp,point,profile);await sleep(70);const events=await evaluate(cdp,'window.__tropnikInputEvents');assertNativeBurstEventOrder(events,profile.mobile?'touch':'mouse',1);nativeInputs.push({label,input:profile.mobile?'touch':'mouse',point,events});};
     const beforeZoom=traceEnabled?(await sceneState()).inspection?.frame?.view?.zoom:NaN;
     if(shouldTraceTerrainZoom(profile,'scene3d',label==='Приблизить ландшафт'?1:-1,beforeZoom,terrainTraceStarted,traceEnabled)){
      terrainTraceStarted=true;
      try{const recorded=await traceDesktopSelection(cdp,press,{prefix:'desktop-webgl-landscape-close',scope:'own-landscape-close-view',sourceCommit:process.env.GITHUB_SHA||null,limits:TERRAIN_TRACE_LIMITS,...(diagnostic?{categories:report.gpu?.traceCategories?.selected,captureCategoryEvidence:true}:{})});report.terrainZoomTrace={...recorded.trace,beforeZoom,afterZoom:(await sceneState()).inspection?.frame?.view?.zoom};}
      catch(error){report.terrainZoomTrace={...error.traceReceipt,beforeZoom};throw error;}
     }else await press();
    };
    // Fourteen actual 1.2x steps reach each renderer's bounded zoom extreme
    // from its default view. Inspect both extremes, not just one small nudge.
    for(let i=0;i<14;i++)await sceneZoom('Приблизить ландшафт');
    await sleep(250);const close=await capture('scene3d',null,'close'),closeState=await sceneState();
    for(let i=0;i<14;i++)await sceneZoom('Отдалить ландшафт');
    await sleep(250);const wide=await capture('scene3d',null,'wide'),wideState=await sceneState();
    await sceneZoom('Повернуть ландшафт');await sleep(250);const rotatedState=await sceneState();await capture('scene3d',null,'rotated');
    await sceneZoom('Вернуть исходный ракурс');await sleep(250);const resetState=await sceneState();
    await capture('scene3d',null,'reset');
    report.modes.scene3d={state:'ready',...scene,beforeMap:beforeScene,nativeInputs,states:{initial:scene.inspection,close:closeState.inspection,wide:wideState.inspection,rotated:rotatedState.inspection,reset:resetState.inspection},zoomInputs:28,rotateInput:true,resetInput:true,imageChanged:initial.sha256!==close.sha256&&close.sha256!==wide.sha256,visualReviewRequired:true};
    assert.equal(report.modes.scene3d.imageChanged,true,`${profile.name}: 3D zoom produced no rendered change`);
   }else report.modes.scene3d={state:scene.error?'error':'not-ready',...scene,zoomInputs:0,visualReviewRequired:true};
   await pointerSelector(cdp,'.terrain-controls button[aria-label="Вернуться к карте"]',profile);
   await waitValue(`${profile.name}: the 3D scene did not return to the map`,()=>evaluate(cdp,"!document.querySelector('.terrain-scene.is-visible')"),Boolean);
   await settledMap(cdp,profile.engine);
  }else assert.fail('The own 3D control was unavailable');
  if(diagnostic){report.status='completed';report.diagnosticScope='current-visible-map-terrain';report.completedAt=new Date().toISOString();if(helpers.performanceDiagnostics)report.performanceDiagnostics=await helpers.performanceDiagnostics(cdp);await save();return report;}
  // loadProfile starts a new document/performance interval. Preserve the
  // existing all-mode measurements when adding the separate source fixture.
  const modePerformance=await evaluate(cdp,'({layoutShift:window.__tropnikPerf?.cls||0,longestTaskMs:window.__tropnikPerf?.longest||0})');
  report.performance=modePerformance;
  const edges=await closeTrailEdges();
  report.coast=await runCoastAudit(cdp,profile,helpers);
  report.satelliteContinuity=await runSatelliteContinuityAudit(cdp,profile,helpers);
  // Preserve both existing intervals before the satellite document load. Its
  // own counter covers every source switch/pan; never substitute only the last
  // frame or the last coast fixture for a whole audit's performance interval.
  report.performanceIntervals={modes:modePerformance,sourceEnds:edges.performance,satellite:report.satelliteContinuity.performance};
  const intervals=Object.values(report.performanceIntervals);
  report.performance={layoutShift:Math.max(...intervals.map(value=>value.layoutShift)),longestTaskMs:Math.max(...intervals.map(value=>value.longestTaskMs))};
  for(const [phase,value]of Object.entries(report.performanceIntervals))helpers.performanceIssues?.push(...performanceBudgetIssues(value,profile,`zoom-${phase}`));
  report.geometryPassed=true;report.completedAt=new Date().toISOString();await save();return report;
 }catch(error){report.error=error.stack||String(error);if(error.settleDiagnostics)report.settleDiagnostics=error.settleDiagnostics;if(diagnostic){report.status='failed';if(helpers.performanceDiagnostics)try{report.performanceDiagnostics=await helpers.performanceDiagnostics(cdp);}catch{} }await save();throw error;}
 finally{forget();forgetFinished();forgetFailed();terrainResources?.dispose();}
}
