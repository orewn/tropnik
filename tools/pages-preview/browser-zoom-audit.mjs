import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CLOSE_TRAIL_FIXTURE,assertCloseTrailAudit,assertNativeBurstEventOrder,assertRouteEdgeFrame,assertReliefPalette} from './browser-report.mjs';
import {dispatchSourceEndPan,sourceEndPanPlans,sourceEndsAreFramed} from './browser-source-end-pan.mjs';
import {traceDesktopSelection,TERRAIN_TRACE_LIMITS} from './browser-trace.mjs';

const OUTPUT=new URL('../../web/pages-preview/design-qa/',import.meta.url);
const KEY_ZOOMS=[2,5,8,11,14,18];
const PLUS='.map-controls button[aria-label="Увеличить масштаб"]';
const MINUS='.map-controls button[aria-label="Уменьшить масштаб"]';

/** Leaflet animates its child map pane, not the outer atlas canvas. */
export function mapCameraIsMoving(element){
 return element.hasAttribute('data-map-camera')||!!element.querySelector('.leaflet-map-pane.leaflet-zoom-anim');
}

/** A dataset can stay unchanged between zoomend and the next queued RAF.
 * Advance the real compositor before every sample, then require the same
 * idle camera on four observations. No renderer callbacks are invoked. */
export async function settleMapCamera({engine,read,frame,wait,clock=()=>performance.now()}){
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
  if(!state?.visible||state.moving||state.engine!==engine||!Object.values(state.camera).every(Number.isFinite)){
   signature='';stable=0;current.idleObservations=0;current.signatureUnchanged=false;return false;
  }
  const next=JSON.stringify([state.camera,state.rect,state.route]);current.signatureUnchanged=next===signature;stable=next===signature?stable+1:0;signature=next;current.idleObservations=stable+1;return stable>=3;
 },15000);}catch(error){
  error.settleDiagnostics={schemaVersion:1,engine,timeoutMs:15000,requiredIdleObservations:4,comparison:'exact-camera-rect-route',sampleLimit:16,startedAtEpochMs,elapsedMs:clock()-started,totalSamples,discardedSamples:totalSamples-samples.length,samples};
  throw error;
 }
}

/** One existing +1 input around the terrain failure, never a diagnostic retry. */
export function shouldTraceTerrainZoom(profile,mode,direction,beforeZoom,alreadyTraced){
 return !alreadyTraced&&profile.name==='desktop-webgl'&&profile.engine==='maplibre'&&!profile.mobile&&mode==='terrain'&&direction>0&&beforeZoom>=4&&beforeZoom<5;
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
export async function runZoomDesignAudit(cdp,profile,helpers){
 const {loadProfile,evaluate,waitValue,sleep,settledMap,closeMapSheet,clearMapStories,elementPoint,pointerAt,pointerSelector,diagnosticPhase}=helpers;
 await mkdir(OUTPUT,{recursive:true});
 const report={profile:profile.name,engine:profile.engine,input:profile.mobile?'touch':'mouse',schemaVersion:5,geometryPassed:false,visualReviewRequired:true,maximumZoom:18,keyZooms:KEY_ZOOMS,detailSteps:[],screenshots:[],modes:{},startedAt:new Date().toISOString()};
 let terrainTraceStarted=false;
 const save=()=>writeFile(new URL(`${profile.name}.json`,OUTPUT),JSON.stringify(report,null,2)+'\n');
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
   return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY:window.scrollY,available,ui,targets,labels,detail:atlas.dataset.mapDetail||'',selectedRoute:atlas.dataset.mapRoute||'',imagery:atlas.dataset.mapImagery||'',routeEdgeCount:document.querySelectorAll('.route-edge-marker[role="img"]').length,status:document.querySelector('.map-message')?.textContent?.trim()||'',loadedSatelliteTiles:[...document.querySelectorAll('.leaflet-russia-satellite-pane img')].filter(image=>image.complete&&image.naturalWidth>0).length};
  })()`);
  report.lastInspection={mode,zoom:map.camera.zoom,...layout};
  assert.equal(map.route,'kavkaz-8a',`${profile.name}/${mode}: changing zoom/base map lost the selected route`);
  assertMapUIBounds(layout,`${profile.name}/${mode}/${map.camera.zoom}`);
  assert.ok(layout.routeEdgeCount<=2,`${profile.name}/${mode}: route edge annotations grew with vertex count`);
  return{mode,zoom:map.camera.zoom,camera:map.camera,routeId:map.route,...layout};
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
  const pressAndSettle=async()=>{await pointerAt(cdp,target,profile);await sleep(70);return settledMap(cdp,profile.engine);};
  let after;
  if(shouldTraceTerrainZoom(profile,mode,direction,before.camera.zoom,terrainTraceStarted)){
   terrainTraceStarted=true;
   try{
    const captured=await traceDesktopSelection(cdp,pressAndSettle,{prefix:'desktop-webgl-terrain-zoom',scope:'first-desktop-terrain-zoom-4-to-6',sourceCommit:process.env.GITHUB_SHA||null,limits:TERRAIN_TRACE_LIMITS});
    after=captured.value;report.terrainZoomTrace={...captured.trace,beforeZoom:before.camera.zoom,afterZoom:after.camera.zoom};
   }catch(error){report.terrainZoomTrace={...error.traceReceipt,beforeZoom:before.camera.zoom};throw error;}
  }else after=await pressAndSettle();
  assert.ok(direction>0?after.camera.zoom>=before.camera.zoom-.001:after.camera.zoom<=before.camera.zoom+.001,`${profile.name}: zoom moved in the wrong direction`);
  return{before:before.camera.zoom,after:after.camera.zoom,changed:Math.abs(after.camera.zoom-before.camera.zoom)>.001};
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
  const step=profile.engine==='leaflet'?.75:1,count=4;
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
  const ui=await evaluate(cdp,`(()=>({active:document.querySelector('.atlas-wrap')?.dataset.mapImagery==='satellite',status:document.querySelector('.map-message')?.textContent?.trim()||'',loadedTiles:[...document.querySelectorAll('.leaflet-russia-satellite-pane img')].filter(image=>image.complete&&image.naturalWidth>0).length}))()`);
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
   loadedReliefTiles:await evaluate(cdp,"[...document.querySelectorAll('.leaflet-russia-overview-relief-pane img')].filter(image=>image.complete&&image.naturalWidth>0).length"),
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
   const reliefPalette=await waitValue(`${profile.name}: relief tiles retained a stale palette`,()=>evaluate(cdp,`(()=>{
    const map=document.querySelector('.atlas-canvas'),bounds=map.getBoundingClientRect();
    const tiles=[...document.querySelectorAll('canvas[data-relief-job]')].map(tile=>{
     const r=tile.getBoundingClientRect();let visible=r.width>1&&r.height>1&&r.right>bounds.left&&r.left<bounds.right&&r.bottom>bounds.top&&r.top<bounds.bottom;
     for(let parent=tile;visible&&parent;parent=parent.parentElement){const s=getComputedStyle(parent);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||parent.hidden)visible=false;}
     return{visible,state:tile.dataset.reliefState||'pending',paintedMode:tile.dataset.reliefMode||'',desiredMode:tile.dataset.reliefDesiredMode||''};
    });return{engine:map.dataset.mapEngine,tiles};
   })()`),value=>value.tiles.every(tile=>!tile.visible||!tile.paintedMode||tile.paintedMode===tile.desiredMode),15000);
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
  await diagnosticPhase(cdp,'zoom-design-detail');
  const route=await waitValue(`${profile.name}: the zoom audit route did not render`,()=>helpers.mapState(cdp),state=>state?.route==='kavkaz-8a');
  report.routeId=route.route;
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
  await layerButton('Детальные тропы онлайн');
  await waitValue(`${profile.name}: leaving satellite did not restore map controls`,()=>evaluate(cdp,"document.querySelector('.atlas-wrap')?.dataset.mapImagery!=='satellite'"),Boolean);
  await settledMap(cdp,profile.engine);
  const terrainButton='.map-style-switch button[aria-label="Рельеф всей карты"]';
  const terrainAvailable=await evaluate(cdp,`!!document.querySelector(${JSON.stringify(terrainButton)})&&!document.querySelector(${JSON.stringify(terrainButton)})?.disabled`);
  if(terrainAvailable){
   await diagnosticPhase(cdp,'zoom-design-terrain');
   await reachZoom(11);
   await pointerSelector(cdp,terrainButton,profile);await settledMap(cdp,profile.engine);
   const active=await evaluate(cdp,`document.querySelector(${JSON.stringify(terrainButton)})?.classList.contains('active')===true`);
   assert.equal(active,true,`${profile.name}: the terrain control did not activate`);
   await reachBottom();const steps=await sweep('terrain',1);
   report.modes.terrain={state:'active',stepCount:steps.length,steps,visualReviewRequired:true};
   await pointerSelector(cdp,'.map-style-switch button[aria-label="Карта сверху"]',profile);await settledMap(cdp,profile.engine);
  }else report.modes.terrain={state:'not-offered',reason:profile.engine==='leaflet'?'The mobile map offers its prepared 3D scene instead of global WebGL terrain.':'The current base map did not offer global terrain.'};
  const sceneButton='.map-style-switch button[aria-label="3D ландшафт Бзерпинского района"]';
  const sceneAvailable=await elementPoint(cdp,sceneButton);
  if(sceneAvailable?.unobscured){
   await diagnosticPhase(cdp,'zoom-design-scene');await pointerSelector(cdp,sceneButton,profile);
   const sceneState=()=>evaluate(cdp,`(()=>{const scene=document.querySelector('.terrain-scene.is-visible'),canvas=scene?.querySelector('canvas'),r=canvas?.getBoundingClientRect(),data=canvas?.dataset,notice=document.querySelector('.atlas-wrap>.map-message'),noticeRect=notice?.getBoundingClientRect(),noticeStyle=notice&&getComputedStyle(notice);return{visible:!!scene,ready:scene?.classList.contains('is-ready')===true,retainedMapNoticeVisible:!!noticeRect&&noticeRect.width>0&&noticeRect.height>0&&noticeStyle.display!=='none'&&noticeStyle.visibility!=='hidden'&&Number(noticeStyle.opacity)!==0,error:scene?.querySelector('.terrain-progress')?.textContent?.trim()||'',canvas:r?{width:r.width,height:r.height,renderer:data.renderer||'',triangles:Number(data.triangles||0),sourceVertices:Number(data.sourceVertices||0),meshStride:Number(data.meshStride||0),renderMs:Number(data.renderMs||0)}:null}})()`);
   let scene;
   for(let attempt=0;attempt<60;attempt++){scene=await sceneState();if(scene.ready||scene.error)break;await sleep(250);}
   const initial=await capture('scene3d',null,'overview');
   if(scene.ready){
    assert.equal(scene.retainedMapNoticeVisible,false,`${profile.name}: a retained 2D map notice covers the ready 3D scene`);
    assert.ok(scene.canvas?.triangles>0&&['webgl2','canvas2d'].includes(scene.canvas.renderer),`${profile.name}: a ready3D scene has no recorded rendered mesh`);
    const sceneZoom=async label=>{
     const point=await elementPoint(cdp,`.terrain-controls button[aria-label="${label}"]`);
     assert.ok(point?.unobscured,`${profile.name}: ${label} is not reachable`);
     await pointerAt(cdp,point,profile);await sleep(70);
    };
    // Fourteen actual 1.2x steps reach each renderer's bounded zoom extreme
    // from its default view. Inspect both extremes, not just one small nudge.
    for(let i=0;i<14;i++)await sceneZoom('Приблизить ландшафт');
    await sleep(250);const close=await capture('scene3d',null,'close');
    for(let i=0;i<14;i++)await sceneZoom('Отдалить ландшафт');
    await sleep(250);const wide=await capture('scene3d',null,'wide');
    await pointerSelector(cdp,'.terrain-controls button[aria-label="Вернуть исходный ракурс"]',profile);await sleep(250);
    await capture('scene3d',null,'reset');
    report.modes.scene3d={state:'ready',...scene,zoomInputs:28,resetInput:true,imageChanged:initial.sha256!==close.sha256&&close.sha256!==wide.sha256,visualReviewRequired:true};
    assert.equal(report.modes.scene3d.imageChanged,true,`${profile.name}: 3D zoom produced no rendered change`);
   }else report.modes.scene3d={state:scene.error?'error':'not-ready',...scene,zoomInputs:0,visualReviewRequired:true};
   await pointerSelector(cdp,'.terrain-controls button[aria-label="Вернуться к карте"]',profile);
   await waitValue(`${profile.name}: the 3D scene did not return to the map`,()=>evaluate(cdp,"!document.querySelector('.terrain-scene.is-visible')"),Boolean);
   await settledMap(cdp,profile.engine);
  }else report.modes.scene3d={state:'not-offered',reason:'This selected source geometry does not expose the prepared scene control.'};
  // loadProfile starts a new document/performance interval. Preserve the
  // existing all-mode measurements when adding the separate source fixture.
  const modePerformance=await evaluate(cdp,'({layoutShift:window.__tropnikPerf?.cls||0,longestTaskMs:window.__tropnikPerf?.longest||0})');
  report.performance=modePerformance;
  const edges=await closeTrailEdges();
  report.geometryPassed=true;report.performance={layoutShift:Math.max(modePerformance.layoutShift,edges.performance.layoutShift),longestTaskMs:Math.max(modePerformance.longestTaskMs,edges.performance.longestTaskMs)};report.completedAt=new Date().toISOString();await save();return report;
 }catch(error){report.error=error.stack||String(error);if(error.settleDiagnostics)report.settleDiagnostics=error.settleDiagnostics;await save();throw error;}
 finally{forget();forgetFinished();forgetFailed();}
}
