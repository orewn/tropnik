import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const OUTPUT=new URL('../../web/pages-preview/design-qa/',import.meta.url);
const KEY_ZOOMS=[2,5,8,11,14,18];
const PLUS='.map-controls button[aria-label="Увеличить масштаб"]';
const MINUS='.map-controls button[aria-label="Уменьшить масштаб"]';

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

/** Deliver distinct native presses without waiting for camera animation between
 * them. The count is deliberately small enough to fit within one animation. */
export async function dispatchZoomBurst(cdp,point,profile,count=4){
 assert.ok(Number.isFinite(point.x)&&Number.isFinite(point.y));
 assert.ok(Number.isInteger(count)&&count>0&&count<=4);
 const started=Date.now();
 if(!profile.mobile)await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,pointerType:'mouse'});
 for(let index=0;index<count;index++){
  if(profile.mobile){
   await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:81,radiusX:3,radiusY:3,force:1}]});
   await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }else{
   await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});
   await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});
  }
 }
 return{count,durationMs:Date.now()-started,input:profile.mobile?'touch':'mouse'};
}

/** Real-input zoom coverage plus reviewable images. Network/source availability
 * is reported separately from geometry checks; a fallback is never called a
 * successfully rendered satellite or 3D scene. */
export async function runZoomDesignAudit(cdp,profile,helpers){
 const {loadProfile,evaluate,waitValue,sleep,settledMap,closeMapSheet,clearMapStories,elementPoint,pointerAt,pointerSelector,diagnosticPhase}=helpers;
 await mkdir(OUTPUT,{recursive:true});
 const report={profile:profile.name,engine:profile.engine,input:profile.mobile?'touch':'mouse',schemaVersion:2,geometryPassed:false,visualReviewRequired:true,maximumZoom:18,keyZooms:KEY_ZOOMS,detailSteps:[],screenshots:[],modes:{},startedAt:new Date().toISOString()};
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
   const ui=[...document.querySelectorAll('.map-context,.map-style-switch,.map-controls,.layer-button,.map-message,.fact-closed,.map-attribution-toggle,.map-attribution-content,.map-satellite-credit,.map-legend')].filter(visible).map(element=>({kind:element.className,rect:box(element)}));
   const targets=[...document.querySelectorAll('.map-style-switch button,.map-controls button:not([disabled]),.layer-button,.map-message button,.fact-closed,.map-attribution-toggle')].filter(visible).map(element=>{
    const r=box(element),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,hit=document.elementFromPoint(x,y);return{label:element.getAttribute('aria-label')||element.textContent?.trim(),rect:r,minimumSize:44,unobscured:!!hit&&element.contains(hit)};
   });
   const labels=[...document.querySelectorAll('.region-marker-label,.route-edge-label')].filter(visible).map(element=>({label:element.textContent,rect:box(element)}));
   return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY:window.scrollY,available,ui,targets,labels,detail:atlas.dataset.mapDetail||'',selectedRoute:atlas.dataset.mapRoute||'',imagery:atlas.dataset.mapImagery||'',routeEdgeCount:document.querySelectorAll('.route-edge-marker').length,status:document.querySelector('.map-message')?.textContent?.trim()||'',loadedSatelliteTiles:[...document.querySelectorAll('.leaflet-russia-satellite-pane img')].filter(image=>image.complete&&image.naturalWidth>0).length};
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
 async function zoom(direction){
  const before=await settledMap(cdp,profile.engine),target=await elementPoint(cdp,direction>0?PLUS:MINUS);
  assert.ok(target?.unobscured,`${profile.name}: zoom control is unavailable`);
  await pointerAt(cdp,target,profile);
  await sleep(70);
  const after=await settledMap(cdp,profile.engine);
  assert.ok(direction>0?after.camera.zoom>=before.camera.zoom-.001:after.camera.zoom<=before.camera.zoom+.001,`${profile.name}: zoom moved in the wrong direction`);
  return{before:before.camera.zoom,after:after.camera.zoom,changed:Math.abs(after.camera.zoom-before.camera.zoom)>.001};
 }
 async function reachBottom(){
  for(let count=0;count<28;count++){const result=await zoom(-1);if(!result.changed)return result.after;}
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
  const start=await evaluate(cdp,'({time:performance.now(),scrollY:window.scrollY})');
  const input=await dispatchZoomBurst(cdp,point,profile,count);
  const after=await waitValue(`${profile.name}: rapid zoom did not accumulate all four presses`,()=>settledMap(cdp,profile.engine),state=>Math.abs(state.camera.zoom-expected)<.01,4000);
  const delivered=await evaluate(cdp,`(()=>{const events=(window.__tropnikInputEvents||[]).filter(event=>event.type==='click'&&event.time>=${start.time}&&event.trusted&&event.button?.label===${JSON.stringify(label)});return{clicks:events.length,eventSpanMs:events.length>1?events.at(-1).time-events[0].time:0,scrollY:window.scrollY};})()`);
  const result={...input,direction,step,beforeZoom:before.camera.zoom,expectedZoom:expected,afterZoom:after.camera.zoom,receivedClicks:delivered.clicks,eventSpanMs:delivered.eventSpanMs,pageScrollDeltaPx:Math.abs(delivered.scrollY-start.scrollY)};
  assert.equal(delivered.clicks,count,`${profile.name}: the browser did not deliver four distinct trusted zoom clicks: ${JSON.stringify(result)}`);
  assert.ok(delivered.eventSpanMs<200,`${profile.name}: the zoom clicks did not reach the UI within one animation: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(after.camera.zoom-expected)<.01,`${profile.name}: rapid zoom lost an input while the camera was animating: ${JSON.stringify(result)}`);
  assert.ok(result.pageScrollDeltaPx<=1,`${profile.name}: rapid zoom scrolled the page`);
  assert.equal(after.route,before.route,`${profile.name}: rapid zoom lost the selected route`);
  return{...result,selectionPreserved:true,passed:true};
 }
 async function rapidZoomControls(){
  const before=await settledMap(cdp,profile.engine);
  assert.ok(before.camera.zoom>=9.5&&before.camera.zoom<=11,`${profile.name}: burst zoom must start away from either clamp`);
  const increase=await fastZoomBurst(1),decrease=await fastZoomBurst(-1);
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
   previous=state.zoom;const step=await zoom(direction);
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
   const sceneState=()=>evaluate(cdp,`(()=>{const scene=document.querySelector('.terrain-scene.is-visible'),canvas=scene?.querySelector('canvas'),r=canvas?.getBoundingClientRect(),data=canvas?.dataset;return{visible:!!scene,ready:scene?.classList.contains('is-ready')===true,error:scene?.querySelector('.terrain-progress')?.textContent?.trim()||'',canvas:r?{width:r.width,height:r.height,renderer:data.renderer||'',triangles:Number(data.triangles||0),sourceVertices:Number(data.sourceVertices||0),meshStride:Number(data.meshStride||0),renderMs:Number(data.renderMs||0)}:null}})()`);
   let scene;
   for(let attempt=0;attempt<60;attempt++){scene=await sceneState();if(scene.ready||scene.error)break;await sleep(250);}
   const initial=await capture('scene3d',null,'overview');
   if(scene.ready){
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
  report.geometryPassed=true;report.performance=await evaluate(cdp,'({layoutShift:window.__tropnikPerf?.cls||0,longestTaskMs:window.__tropnikPerf?.longest||0})');report.completedAt=new Date().toISOString();await save();return report;
 }catch(error){report.error=error.stack||String(error);await save();throw error;}
 finally{forget();forgetFinished();forgetFailed();}
}
