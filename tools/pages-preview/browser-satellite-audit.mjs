import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {projectMapPoint,unprojectMapPoint} from './map-projection.mjs';
import {coastPanPlan,assertCoastPanInput,inspectCoastPanSelection} from './browser-coast-audit.mjs';
import {dispatchSourceEndPan} from './browser-source-end-pan.mjs';
import {holdSatelliteImagery} from './browser-satellite-preload.mjs';
import {inspectCustomMapDOM,assertCustomMapInspection} from './browser-custom-map.mjs';
import {inspectProductMapModes,assertProductMapMode} from './browser-map-modes.mjs';

const OUTPUT=new URL('../../web/pages-preview/design-qa/',import.meta.url);
export const SATELLITE_REGION='territory-28173009B11091203162490';
export const SATELLITE_DATELINE=Object.freeze([180,67.5]);
export const SATELLITE_WEST=Object.freeze([140,67.5]);
const SOURCES=Object.freeze({
 'eox-s2':{host:'tiles.maps.eox.at',path:'/wmts/1.0.0/s2cloudless_3857/default/g/',extension:'jpg',maxZoom:14},
 'eox-bluemarble':{host:'tiles.maps.eox.at',path:'/wmts/1.0.0/bluemarble_3857/default/g/',extension:'jpg',maxZoom:8},
});
const STAGES=['dateline-overview','dateline-native8','dateline-overzoom','west-eox','dateline-return','detail-restored'];

/** Only the exact public imagery layers count as independent loading proof. */
export function satelliteResource(value){
 let url;try{url=new URL(value);}catch{return null;}
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash)return null;
 for(const [source,provider] of Object.entries(SOURCES)){
  if(url.hostname!==provider.host||!url.pathname.startsWith(provider.path))continue;
  const match=url.pathname.slice(provider.path.length).match(new RegExp(`^(\\d+)/(\\d+)/(\\d+)\\.${provider.extension}$`));
  if(!match)continue;const [z,y,x]=match.slice(1).map(Number),size=2**z;
  if(z>provider.maxZoom||![z,x,y].every(Number.isSafeInteger)||x<0||y<0||x>=size||y>=size)return null;
  return{url:url.href,source,tile:{z,x,y}};
 }
 return null;
}

export function observeSatelliteResources(cdp,phase=()=>null){
 const requests=new Map(),limit=512;let observedRequests=0,sequence=0;
 const remember=(requestId,url)=>{
  const resource=satelliteResource(url);if(!resource)return null;
  let item=requests.get(requestId);
  if(!item){item={requestId,...resource,phase:phase(),firstSequence:sequence+1,finished:false};requests.set(requestId,item);observedRequests++;if(requests.size>limit)requests.delete(requests.keys().next().value);}
  return item;
 };
 const stops=[
  cdp.observe('Network.requestWillBeSent',({requestId,request,timestamp})=>{const item=remember(requestId,request?.url);if(item)Object.assign(item,{requestedAt:timestamp,requestedSequence:++sequence});}),
  cdp.observe('Network.responseReceived',({requestId,response,timestamp})=>{const item=remember(requestId,response?.url);if(item)Object.assign(item,{status:response.status,mimeType:response.mimeType,fromDiskCache:response.fromDiskCache===true,fromServiceWorker:response.fromServiceWorker===true,responseAt:timestamp,responseSequence:++sequence,responsePhase:phase()});}),
  cdp.observe('Network.loadingFinished',({requestId,encodedDataLength,timestamp})=>{const item=requests.get(requestId);if(item)Object.assign(item,{finished:true,bytes:encodedDataLength,finishedAt:timestamp,finishedSequence:++sequence});}),
  cdp.observe('Network.loadingFailed',({requestId,errorText,canceled,timestamp})=>{const item=requests.get(requestId);if(item)Object.assign(item,{error:errorText,canceled:canceled===true,failedAt:timestamp,failedSequence:++sequence,failedPhase:phase()});}),
 ];
 return{snapshot:()=>({limit,sequence,observedRequests,discardedRequests:observedRequests-requests.size,requests:structuredClone([...requests.values()])}),dispose:()=>stops.forEach(stop=>stop())};
}

/** Reconstruct only events already delivered when a frame was captured. Future
 * requests/failures must neither certify nor invalidate an earlier frame. */
export function satelliteResourcesAt(network,sequence){
 assert.ok(Number.isInteger(network?.sequence)&&Number.isInteger(sequence)&&sequence>=0&&sequence<=network.sequence,'Invalid satellite capture sequence');
 return{...network,sequence,requests:network.requests.filter(item=>item.firstSequence<=sequence).map(item=>{
  const received=Number.isInteger(item.responseSequence)&&item.responseSequence<=sequence,finished=Number.isInteger(item.finishedSequence)&&item.finishedSequence<=sequence,failed=Number.isInteger(item.failedSequence)&&item.failedSequence<=sequence;
  return{...item,status:received?item.status:undefined,mimeType:received?item.mimeType:undefined,responsePhase:received?item.responsePhase:undefined,finished,bytes:finished?item.bytes:undefined,error:failed?item.error:undefined,canceled:failed?item.canceled:false,failedPhase:failed?item.failedPhase:undefined};
 })};
}

function sourceRequestsAt(network,source,sequence,phase){
 const current=satelliteResourcesAt(network,sequence),requests=current.requests.filter(item=>item.source===source);
 return{current,pending:requests.filter(item=>!item.finished&&!item.error).map(item=>item.requestId),failed:requests.filter(item=>[item.phase,item.responsePhase,item.failedPhase].includes(phase)&&!item.canceled&&(item.error||item.status>=400)).map(item=>item.requestId)};
}

function bothSeamColumnsLoaded(resources,latitude){
 return[-180+1e-7,180-1e-7].every(longitude=>resources.some(item=>item.tile.z===8&&satelliteTileContains(item.tile,[longitude,latitude])));
}

export function successfulSatelliteResources(network,source){
 return(network?.requests||[]).filter(item=>{
  const parsed=satelliteResource(item.url);
  return item.source===source&&parsed?.source===source&&['z','x','y'].every(key=>parsed.tile[key]===item.tile?.[key])&&item.finished===true&&item.status===200&&!item.error&&['image/jpeg','image/jpg','image/png'].includes(item.mimeType)&&Number.isFinite(item.bytes)&&item.bytes>=0;
 });
}

export function satelliteTileContains(tile,[longitude,latitude]){
 const size=2**tile.z,x=(((longitude+180)%360+360)%360)/360*size,radians=Math.max(-85.0511287798,Math.min(85.0511287798,latitude))*Math.PI/180,y=(1-Math.log(Math.tan(radians)+1/Math.cos(radians))/Math.PI)/2*size;
 return x>=tile.x&&x<tile.x+1&&y>=tile.y&&y<tile.y+1;
}

/** The diagnostic reads only the DOM contract, never an application/SDK object. */
export function inspectSatelliteDOM(doc=document){
 const wrap=doc.querySelector('.atlas-wrap'),data=wrap?.dataset||{},credit=wrap?.querySelector('.map-satellite-credit'),r=credit?.getBoundingClientRect(),style=credit&&getComputedStyle(credit);
 return{imagery:data.mapImagery||'',source:data.mapImagerySource||'',target:data.mapImageryTarget||'',state:data.mapImageryState||'',
  base:{committed:data.mapBaseCommitted||'',target:data.mapBaseTarget||'',state:data.mapBaseState||''},
  credit:{visible:!!r&&r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0,text:credit?.textContent?.trim()||''},
  viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},scrollY,region:new URL(location.href).searchParams.get('region'),status:wrap?.querySelector('.map-message')?.textContent?.trim()||''};
}

export function assertSatelliteCameraUnchanged(before,after,context){
 assert.deepEqual(after.camera,before.camera,`${context}: changing imagery moved the camera`);
 assert.deepEqual(after.rect,before.rect,`${context}: changing imagery resized the map`);
 assert.deepEqual(after.viewport,before.viewport,`${context}: changing imagery changed the viewport/DPR`);
 assert.ok(Math.abs(after.scrollY-before.scrollY)<=1,`${context}: changing imagery scrolled the page`);
}

export function assertSatellitePreload(preload,network,context){
 assert.equal(preload?.kind,'held-real-imagery-requests',`${context}: cold preload proof is missing`);
 const {before,pending,after,held,released,screenshots}=preload;
 assert.ok(['detail','overview'].includes(before?.base?.committed));
 assert.equal(before.base.state,'ready');
 if(before.engine==='tropnik-canvas'){
  assertCustomMapInspection(before.customMap,context+'/before',{mode:before.base.committed});
  assert.equal(before.base.target,before.customMap.state.mode,`${context}: base target differs from the actual selected mode`);
  if(before.base.target!==before.base.committed){
   // The detail mode deliberately uses the geographic overview below z5.
   // Accept that concrete rendered batch, not a claim that vector detail loaded.
   assert.equal(before.base.target,'detail');assert.equal(before.base.committed,'overview');
   assert.equal(before.customMap.camera.zoom,before.camera.zoom);
   assert.ok(before.camera.zoom<5,`${context}: detail fallback cannot certify a close view`);
   assert.ok(before.customMap.tiles.overview.length>0,`${context}: no committed overview ground`);
   for(const kind of ['detail','relief','imagery'])assert.equal(before.customMap.tiles[kind].length,0,`${context}: low-zoom overview contains an unexpected ${kind} batch`);
  }
 }else assert.equal(before.base.target,before.base.committed);
 assertSatelliteCameraUnchanged(before,pending,context+'/pending');assertSatelliteCameraUnchanged(before,after,context+'/committed');
 assert.equal(pending.base.committed,before.base.committed,`${context}: old ground was removed before imagery was ready`);
 assert.equal(pending.base.target,'satellite');assert.equal(pending.base.state,'loading');
 assert.equal(pending.imagery,'satellite');assert.equal(pending.target,'eox-bluemarble');assert.equal(pending.state,'loading');assert.equal(pending.source,'');
 assert.equal(after.base.committed,'satellite');assert.equal(after.base.target,'satellite');assert.equal(after.base.state,'ready');assert.equal(after.source,'eox-bluemarble');assert.equal(after.state,'ready');
 assert.equal(held?.limit,64);assert.equal(held.timeoutMs,8000);assert.equal(held.closed,false);assert.equal(held.reason,null);assert.deepEqual(held.errors,[]);
 assert.ok(held.pending>0&&held.pending<=64);assert.equal(held.records.length,held.pending);assert.equal(held.observed,held.records.length);
 const captured=satelliteResourcesAt(network,pending.resourceSequence),requests=new Map(captured.requests.map(item=>[item.requestId,item]));
 for(const record of held.records){
  assert.equal(record.source,'eox-bluemarble');assert.equal(record.resumedAt,null);
  const actual=requests.get(record.networkId);assert.ok(actual&&actual.url===record.url&&!actual.finished&&!actual.error,`${context}: paused imagery is not independently observed as pending`);
 }
 assert.equal(released?.reason,'capture');assert.equal(released.closed,true);assert.equal(released.pending,0);assert.deepEqual(released.errors,[]);
 for(const record of held.records){const resumed=released.records.find(item=>item.requestId===record.requestId);assert.ok(resumed&&resumed.resumedAt>=record.pausedAt);}
 assert.deepEqual(screenshots?.map(item=>item.stage),['preload-before','preload-pending','preload-committed']);
 for(const shot of screenshots){assert.ok(shot.bytes>1000);assert.match(shot.sha256,/^[a-f0-9]{64}$/);assert.match(shot.file,/^[a-z0-9_.-]+\.png$/);}
 if(before.engine==='tropnik-canvas'){
  assertCustomMapInspection(pending.customMap,context+'/pending',{mode:before.base.committed,settled:false});
  assert.equal(pending.customMap.state.imageryLoading,true);
  for(const kind of ['overview','detail','relief'])assert.deepEqual(pending.customMap.tiles[kind].map(t=>t.key),before.customMap.tiles[kind].map(t=>t.key),`${context}: retained bitmap ground changed while imagery was held`);
  assertCustomMapInspection(after.customMap,context+'/committed',{mode:'satellite'});assert.ok(after.customMap.tiles.imagery.length>0);
 }
 return preload;
}

function assertClick(click,input,context){
 assert.equal(click.input,input);assert.ok(click.point?.unobscured,`${context}: control was obscured`);
 assert.deepEqual(click.events?.map(event=>event.type),['pointerdown','pointerup','click'],`${context}: one native click is required`);
 for(const event of click.events){assert.equal(event.trusted,true);assert.equal(event.pointerType,input);assert.ok(Number.isInteger(event.pointerId));assert.ok(Number.isFinite(event.time));}
 assert.equal(click.events[0].pointerId,click.events[1].pointerId);assert.equal(click.events[1].pointerId,click.events[2].pointerId);
 assert.ok(click.events[0].time<=click.events[1].time&&click.events[1].time<=click.events[2].time);
}

function viewIntersectsOverview(frame){
 const {camera,rect}=frame,[west,north]=unprojectMapPoint({x:rect.left,y:rect.top},camera,rect),[east,south]=unprojectMapPoint({x:rect.left+rect.width,y:rect.top+rect.height},camera,rect);
 if(north<61||south>72.5)return false;if(east-west>=360)return true;
 return 176+Math.ceil((west-183)/360)*360<=east;
}

function assertReady(frame,source,network,context){
 assert.equal(frame.imagery,'satellite',`${context}: ordinary map fallback is not satellite proof`);
 assert.equal(frame.state,'ready',`${context}: imagery is not ready`);assert.equal(frame.source,source);assert.equal(frame.target,source);
 assert.equal(frame.credit?.visible,true,`${context}: source credit is not persistent`);
 assert.match(frame.credit.text,/EOX/i);
 assert.equal(frame.resolution,source==='eox-bluemarble'?'overview':'detail',`${context}: overview imagery cannot count as full detail`);
 if(source==='eox-bluemarble'){assert.match(frame.credit.text,/NASA.*Blue Marble/i);assert.match(frame.credit.text,/обзорный снимок\s*·\s*детализация ниже/i);}
 assert.equal(viewIntersectsOverview(frame),source==='eox-bluemarble',`${context}: the actual viewport does not match its expected imagery region`);
 const captured=sourceRequestsAt(network,source,frame.resourceSequence,frame.resourcePhase),loaded=new Map(successfulSatelliteResources(captured.current,source).map(item=>[item.requestId,item]));
 assert.ok(frame.successfulRequestIds?.length>0,`${context}: no finished imagery responses`);
 assert.ok(frame.successfulRequestIds.every(id=>loaded.has(id)),`${context}: unfinished/failed/wrong-provider responses cannot certify imagery`);
 assert.ok(frame.successfulRequestIds.some(id=>satelliteTileContains(loaded.get(id).tile,frame.coordinate||[frame.camera.longitude,frame.camera.latitude])),`${context}: loaded imagery does not cover the inspected geography`);
 assert.deepEqual(frame.pendingRequestIds,captured.pending,`${context}: pending summary differs from raw capture events`);assert.deepEqual(frame.failedRequestIds,captured.failed,`${context}: error summary differs from raw capture events`);
 assert.deepEqual(captured.pending,[],`${context}: imagery requests are still loading`);assert.deepEqual(captured.failed,[],`${context}: imagery requests failed in this phase`);
 if(frame.engine==='tropnik-canvas'){
  const map=assertCustomMapInspection(frame.customMap,context,{mode:'satellite'}),tiles=map.tiles.imagery;
  assert.equal(map.state.imagerySource,source);assert.ok(tiles.length>0,`${context}: no committed imagery bitmaps`);
  for(const tile of tiles){
   assert.equal(tile.kind,source);const x=((tile.x%2**tile.z)+2**tile.z)%2**tile.z;
   assert.ok([...loaded.values()].some(item=>item.tile.z===tile.z&&item.tile.x===x&&item.tile.y===tile.y),`${context}: a committed bitmap has no completed public imagery response`);
  }
 }
}

export function satellitePerformanceIssues(report,profile){
 const value=report?.performance;assert.ok(value&&[value.layoutShift,value.longestTaskMs].every(Number.isFinite),'Satellite performance evidence is missing');
 const limits={layoutShift:.12,longestTaskMs:profile.mobile?350:750};
 return Object.entries(limits).filter(([key,limit])=>!(value[key]<limit)).map(([metric,limit])=>({profile:profile.name,phase:'satellite-continuity',metric,value:value[metric],limit}));
}

export function assertSatelliteContinuityAudit(report,profile,engine){
 const input=profile!=='desktop-webgl'?'touch':'mouse',context=profile+'/satellite';
 assert.equal(report?.schemaVersion,4,`${context}: satellite preload/continuity evidence is missing`);assert.equal(report.passed,true);assert.equal(report.profile,profile);assert.equal(report.engine,engine);assert.equal(report.input,input);
 assert.equal(report.region,SATELLITE_REGION);assert.equal(report.visualReviewRequired,true);assert.deepEqual(report.steps?.map(frame=>frame.stage),STAGES);
 assert.ok(report.resources?.requests.length<=512);assert.equal(report.resources.discardedRequests,0,'Satellite resource proof overflowed its bounded recorder');
 assert.ok(Number.isInteger(report.resources.sequence)&&report.resources.sequence>0);
 assert.equal(new Set(report.resources.requests.map(item=>item.requestId)).size,report.resources.requests.length);
 for(const item of report.resources.requests){
  const events=['requestedSequence','responseSequence','finishedSequence','failedSequence'].flatMap(key=>item[key]===undefined?[]:[item[key]]);
  assert.ok(events.length>0&&events.every(value=>Number.isInteger(value)&&value>0&&value<=report.resources.sequence));
  assert.equal(item.firstSequence,Math.min(...events));assert.equal(typeof item.phase,'string');
  assert.equal(item.finished,Number.isInteger(item.finishedSequence),'Raw imagery completion disagrees with its event sequence');
  assert.equal(typeof item.error==='string',Number.isInteger(item.failedSequence),'Raw imagery failure disagrees with its event sequence');
 }
 assert.equal(report.toggles?.length,2);
 if(engine==='tropnik-canvas'){
  assert.ok(Array.isArray(report.setupZooms)&&report.setupZooms.length<=4,`${context}: native viewport preparation is missing or unbounded`);
  for(const [index,zoom]of report.setupZooms.entries()){
   assert.equal(zoom.direction,1);assertClick(zoom.click,input,context+'/setup-zoom');
   assert.ok(Math.abs(zoom.after.camera.zoom-zoom.before.camera.zoom-1)<.01);
   assert.deepEqual(zoom.after.rect,zoom.before.rect);assert.deepEqual(zoom.after.viewport,zoom.before.viewport);
   if(index)assert.ok(Math.abs(zoom.before.camera.zoom-report.setupZooms[index-1].after.camera.zoom)<.01);
  }
  if(report.setupZooms.length)assert.ok(Math.abs(report.setupZooms.at(-1).after.camera.zoom-report.toggles[0].before.camera.zoom)<.01);
  const frame=report.toggles[0].before;
  assert.equal(viewIntersectsOverview({...frame,camera:{...frame.camera,longitude:SATELLITE_WEST[0],latitude:SATELLITE_WEST[1]}}),false,`${context}: prepared viewport cannot separate the two imagery providers`);
 }
 for(const [index,toggle] of report.toggles.entries()){
  assert.equal(toggle.label,index?'Рельеф':'Спутник');assertSatelliteCameraUnchanged(toggle.before,toggle.after,context);
  assertClick(toggle.select,input,context+'/'+toggle.label);assert.equal(toggle.select.selector,`.map-style-switch button[aria-label="${toggle.label}"]`);
  assert.equal(toggle.canvasRetained,true);assertProductMapMode(toggle.modeState,toggle.label,context+'/'+toggle.label);
  assert.deepEqual(toggle.modeState.camera.center,[toggle.after.camera.longitude,toggle.after.camera.latitude]);assert.equal(toggle.modeState.camera.zoom,toggle.after.camera.zoom);
 }
 assertReady(report.toggles[0].after,'eox-bluemarble',report.resources,context+'/initial');
 assertSatellitePreload(report.preload,report.resources,context+'/preload');
 assert.deepEqual(report.preload.before,report.toggles[0].before);assert.deepEqual(report.preload.after,report.toggles[0].after);
 assert.equal(report.toggles[0].after.resourcePhase,'enable-satellite');
 const expected=[SATELLITE_DATELINE,SATELLITE_DATELINE,SATELLITE_DATELINE,SATELLITE_WEST,SATELLITE_DATELINE];
 for(const [index,frame] of report.steps.entries()){
  assert.equal(frame.region,SATELLITE_REGION);assert.equal(frame.engine,engine);
  for(const key of ['longitude','latitude','zoom','tileSize'])assert.ok(Number.isFinite(frame.camera?.[key]));
  const shot=report.screenshots.find(item=>item.stage===frame.stage);assert.ok(shot?.bytes>1000);assert.match(shot.sha256,/^[a-f0-9]{64}$/);assert.match(shot.file,/^[a-z0-9_.-]+\.png$/);
  if(index<5){
   assert.equal(frame.resourcePhase,frame.stage);
   assert.deepEqual(frame.coordinate,expected[index]);assert.ok(frame.centerErrorPx<=6,`${context}: expected geography is not centered`);
   assertReady(frame,index===3?'eox-s2':'eox-bluemarble',report.resources,context+'/'+frame.stage);
   if(index===1||index===2){
    const captured=satelliteResourcesAt(report.resources,frame.resourceSequence),loaded=successfulSatelliteResources(captured,'eox-bluemarble').filter(item=>frame.successfulRequestIds.includes(item.requestId));
    assert.ok(bothSeamColumnsLoaded(loaded,frame.coordinate[1]),`${context}: native8 imagery must load both dateline columns x0/x255 at the inspected latitude`);
    if(index===2)assert.match(frame.credit.text,/Увеличен обзорный снимок/i);
   }
  }else{
   assert.equal(frame.imagery,'');assert.equal(frame.source,'');assert.equal(frame.target,'');assert.equal(frame.state,'');assert.equal(frame.credit.visible,false);
   assertSatelliteCameraUnchanged(report.steps[4],frame,context+'/detail');
  }
 }
 assert.ok(report.zooms?.length>=6&&report.zooms.length<=28&&report.zooms.length%2===0,`${context}: native zoom sweep is missing or unbounded`);
 const upwardCount=report.zooms.length/2;
 for(const [index,zoom] of report.zooms.entries()){
  const direction=index<upwardCount?1:-1,step=1;
  assert.equal(zoom.direction,direction);assertClick(zoom.click,input,context+'/zoom');
  assert.ok(Math.abs(zoom.after.camera.zoom-zoom.before.camera.zoom-direction*step)<.01,`${context}: native zoom input was lost or clamped`);
  assert.deepEqual(zoom.after.rect,zoom.before.rect);assert.deepEqual(zoom.after.viewport,zoom.before.viewport);
  if(index)assert.ok(Math.abs(zoom.before.camera.zoom-report.zooms[index-1].after.camera.zoom)<.01);
 }
 assert.ok(report.steps[0].camera.zoom<8&&report.steps[1].camera.zoom>=8-.01&&report.steps[1].camera.zoom<8+(1)+.01);
 assert.ok(Math.abs(report.steps[2].camera.zoom-report.steps[1].camera.zoom-(2))<.01);
 assert.ok(Math.abs(report.steps[3].camera.zoom-report.steps[0].camera.zoom)<.01);
 assert.ok(Math.abs(report.zooms[0].before.camera.zoom-report.steps[0].camera.zoom)<.01&&Math.abs(report.zooms.at(-1).after.camera.zoom-report.steps[0].camera.zoom)<.01);
 for(const stage of STAGES.slice(0,5)){
  const pans=report.pans.filter(pan=>pan.stage===stage);assert.ok((['dateline-native8','dateline-overzoom'].includes(stage)||pans.length>0)&&pans.length<=12,`${context}: missing/beyond-bound native ${stage} pan`);
  for(const pan of pans)assertCoastPanInput(pan,input,context+'/'+stage);
 }
 assert.ok(report.pans.every(pan=>STAGES.slice(0,5).includes(pan.stage)));
 assert.ok(report.performance&&[report.performance.layoutShift,report.performance.longestTaskMs].every(Number.isFinite));
 return report;
}

/** One fresh region load, then only trusted controls and bounded native pans.
 * Its performance interval is never reset between providers or image captures. */
export async function runSatelliteContinuityAudit(cdp,profile,helpers,{output=OUTPUT}={}){
 const {loadProfile,evaluate,waitValue,sleep,settledMap,closeMapSheet,clearMapStories,pointerSelector,elementPoint,diagnosticPhase}=helpers;
 const report={schemaVersion:4,profile:profile.name,engine:profile.engine,input:profile.mobile?'touch':'mouse',region:SATELLITE_REGION,passed:false,visualReviewRequired:true,steps:[],pans:[],zooms:[],setupZooms:[],toggles:[],screenshots:[],startedAt:new Date().toISOString()};
 let currentStage='loading-region';const observer=observeSatelliteResources(cdp,()=>currentStage);
 const save=async()=>{report.resources=observer.snapshot();await mkdir(output,{recursive:true});await writeFile(new URL(`${profile.name}-satellite-continuity.json`,output),JSON.stringify(report,null,2)+'\n');};
 const phase=async name=>{currentStage=name;report.stage=name;await diagnosticPhase(cdp,'satellite-continuity/'+name);};
 const snapshot=async({allowLoading=false}={})=>{const map=await settledMap(cdp,profile.engine,{allowLoading}),state=await evaluate(cdp,`(${inspectSatelliteDOM.toString()})()`),customMap=profile.engine==='tropnik-canvas'?await evaluate(cdp,`(${inspectCustomMapDOM.toString()})()`):undefined;return{...state,...(customMap?{customMap}:{}),engine:map.engine,camera:map.camera,rect:map.rect};};
 async function click(target){
  await evaluate(cdp,'window.__tropnikInputEvents=[]');
  const point=await pointerSelector(cdp,target,profile);
  const events=await waitValue(`${profile.name}: native satellite click was not delivered`,()=>evaluate(cdp,'window.__tropnikInputEvents.map(({type,time,trusted,pointerType,pointerId})=>({type,time,trusted,pointerType,pointerId}))'),events=>events.some(event=>event.type==='click'),2000);
  const result={input:report.input,point,events};assertClick(result,report.input,profile.name+'/satellite');return result;
 }
 async function ready(source){
  return waitValue(`${profile.name}: ${source} did not load finished imagery`,async()=>{
   const frame=await snapshot(),network=observer.snapshot(),requests=sourceRequestsAt(network,source,network.sequence,currentStage);
   const loaded=successfulSatelliteResources(network,source),needNative8=['dateline-native8','dateline-overzoom'].includes(currentStage);
   const result={...frame,resolution:source==='eox-bluemarble'?'overview':'detail',successfulRequestIds:loaded.map(item=>item.requestId),resourceSequence:network.sequence,resourcePhase:currentStage,
    centerTileLoaded:loaded.some(item=>(!needNative8||item.tile.z===8)&&satelliteTileContains(item.tile,[frame.camera.longitude,frame.camera.latitude]))&&(!needNative8||bothSeamColumnsLoaded(loaded,SATELLITE_DATELINE[1])),
    pendingRequestIds:requests.pending,failedRequestIds:requests.failed};
   report.lastState=result;return result;
  },frame=>frame.imagery==='satellite'&&frame.source===source&&frame.target===source&&frame.state==='ready'&&frame.centerTileLoaded&&frame.successfulRequestIds.length>0&&frame.pendingRequestIds.length===0&&frame.failedRequestIds.length===0,20000);
 }
 async function toggle(label){
  const before=await waitValue(`${profile.name}: current base did not settle before a layer transition`,snapshot,value=>value.base.state==='ready');let gate;
  if(label==='Спутник'){
   report.preload={kind:'held-real-imagery-requests',before,screenshots:[await screenshot('preload-before')]};
  }
  try{
  await evaluate(cdp,"window.__tropnikSatelliteModeCanvas=document.querySelector('.atlas-canvas canvas.tropnik-map-canvas')");
  const point=await waitValue(`${profile.name}: ${label} layer is unavailable`,()=>evaluate(cdp,`(()=>{const selector='.map-style-switch button[aria-label="${label}"]',element=document.querySelector(selector);if(!element||element.disabled)return null;const r=element.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{selector,unobscured:!!hit&&element.contains(hit)};})()`),value=>value?.unobscured);
  // The unchanged eight-second network hold starts immediately before the
  // action that requests imagery, preserving the bounded pending-frame capture interval.
  if(label==='Спутник')gate=await holdSatelliteImagery(cdp,{match:satelliteResource});
  const select={...await click(point.selector),selector:point.selector};
  if(gate){
   await waitValue(`${profile.name}: preload did not issue bounded real imagery requests`,()=>gate.snapshot(),value=>value.pending>0&&!value.closed,4000);
   const pending=await snapshot({allowLoading:true});report.preload.held=gate.snapshot();pending.resourceSequence=observer.snapshot().sequence;report.preload.pending=pending;
   report.preload.screenshots.push(await screenshot('preload-pending'));
   report.preload.released=await gate.release('capture');
   assert.equal(report.preload.released.reason,'capture',`${profile.name}: imagery preload gate exceeded its bounds`);
   assert.deepEqual(report.preload.released.errors,[]);
  }
  const after=label==='Спутник'?await ready('eox-bluemarble'):await waitValue(`${profile.name}: satellite mode did not exit`,snapshot,state=>state.imagery===''&&state.source===''&&state.target===''&&state.state==='');
  if(gate){report.preload.after=after;report.preload.screenshots.push(await screenshot('preload-committed'));}
  const modeState=await evaluate(cdp,`(${inspectProductMapModes.toString()})()`),canvasRetained=await evaluate(cdp,"window.__tropnikSatelliteModeCanvas===document.querySelector('.atlas-canvas canvas.tropnik-map-canvas')");
  assertSatelliteCameraUnchanged(before,after,profile.name+'/satellite/'+label);assertProductMapMode(modeState,label,profile.name+'/satellite/'+label);assert.equal(canvasRetained,true);report.toggles.push({label,select,before,after,modeState,canvasRetained});return after;
  }finally{if(gate){const released=await gate.release('error');report.preload.released??=released;}}
 }
 async function panTo(coordinate,stage){
  let gestures=0;
  while(gestures<12){
   const map=await settledMap(cdp,profile.engine),point=projectMapPoint(coordinate,map.camera,map.rect),cx=map.rect.left+(map.camera.centerX??map.rect.width/2),cy=map.rect.top+(map.camera.centerY??map.rect.height/2),distance=Math.hypot(cx-point.x,cy-point.y);
   if(distance<=6)return{centerErrorPx:distance};
   for(const [leg,planned]of coastPanPlan(cx-point.x,cy-point.y,map.rect,profile.mobile).entries()){
    assert.ok(gestures<12,`${profile.name}: satellite native pan exceeded12 gestures`);const before=await settledMap(cdp,profile.engine),beforeSelection=await evaluate(cdp,`(${inspectCoastPanSelection.toString()})()`);let delta=planned;
    if(leg){const actual=projectMapPoint(coordinate,before.camera,before.rect);[delta]=coastPanPlan(before.rect.left+(before.camera.centerX??before.rect.width/2)-actual.x,before.rect.top+(before.camera.centerY??before.rect.height/2)-actual.y,before.rect,false);assert.ok(Math.hypot(delta.dx,delta.dy)>=24,'Satellite return drag did not cross native touch slop');}
    const start=await evaluate(cdp,`(()=>{const map=document.querySelector('.atlas-canvas[data-map-engine]'),r=map.getBoundingClientRect(),delta=${JSON.stringify(delta)};for(const fy of [.45,.6,.3,.75])for(const fx of [.5,.65,.35,.8,.2]){const point={x:r.left+r.width*fx,y:r.top+r.height*fy};let clear=true;for(let index=0;index<=12;index++){const hit=document.elementFromPoint(point.x+delta.dx*index/12,point.y+delta.dy*index/12);if(!hit||hit.tagName!=='CANVAS'||!map.contains(hit)){clear=false;break;}}if(clear)return point;}return null;})()`);
    assert.ok(start,`${profile.name}: no clear native pan path to ${stage}`);await evaluate(cdp,'window.__tropnikInputEvents=[]');
    const pan=await dispatchSourceEndPan(cdp,start,delta,profile,sleep),after=await settledMap(cdp,profile.engine);
    Object.assign(pan,{stage,coordinate,gesture:++gestures,leg,before:{camera:before.camera,rect:before.rect,selection:beforeSelection},after:{camera:after.camera,rect:after.rect,selection:await evaluate(cdp,`(${inspectCoastPanSelection.toString()})()`)},events:await evaluate(cdp,'window.__tropnikInputEvents')});report.pans.push(pan);assertCoastPanInput(pan,report.input,profile.name+'/satellite/'+stage);
   }
  }
  const map=await settledMap(cdp,profile.engine),point=projectMapPoint(coordinate,map.camera,map.rect),distance=Math.hypot(map.rect.left+(map.camera.centerX??map.rect.width/2)-point.x,map.rect.top+(map.camera.centerY??map.rect.height/2)-point.y);
  assert.ok(distance<=6,`${profile.name}: native pan did not center ${stage} after12 gestures`);return{centerErrorPx:distance};
 }
 async function zoom(direction,{setup=false}={}){
  const before=await snapshot(),label=direction>0?'Увеличить масштаб':'Уменьшить масштаб',press=await click(`.map-controls button[aria-label="${label}"]`),after=await snapshot();report[setup?'setupZooms':'zooms'].push({direction,click:press,before,after});
 }
 async function screenshot(stage){
  const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),bytes=Buffer.from(image.data,'base64'),file=`${profile.name}-satellite-${stage}.png`;
  await mkdir(output,{recursive:true});await writeFile(new URL(file,output),bytes);return{stage,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }
 async function capture(stage,coordinate,source){
  const frame=source?await ready(source):await snapshot();
  if(coordinate){const point=projectMapPoint(coordinate,frame.camera,frame.rect);Object.assign(frame,{coordinate,centerErrorPx:Math.hypot(frame.rect.left+(frame.camera.centerX??frame.rect.width/2)-point.x,frame.rect.top+(frame.camera.centerY??frame.rect.height/2)-point.y)});}
  report.steps.push({stage,...frame});report.screenshots.push(await screenshot(stage));await save();
 }
 try{
  await cdp.call('Network.enable');const url=new URL(helpers.url);url.searchParams.set('region',SATELLITE_REGION);
  await loadProfile(cdp,url.href,profile);await closeMapSheet(cdp,profile);await clearMapStories(cdp,profile);
  // A 256-pixel world at the old desktop zoom includes both provider regions
  // even when centered at140E. Prepare an actually separable viewport using
  // bounded trusted zoom clicks, then keep that scale for the full roundtrip.
  if(profile.engine==='tropnik-canvas'){
   await phase('setup-viewport');
   for(let count=0;;count++){
    const frame=await snapshot();
    if(!viewIntersectsOverview({...frame,camera:{...frame.camera,longitude:SATELLITE_WEST[0],latitude:SATELLITE_WEST[1]}}))break;
    assert.ok(count<4,'Satellite viewport preparation exceeded4 native inputs');await zoom(1,{setup:true});
   }
  }
  await phase('enable-satellite');await toggle('Спутник');
  await phase('dateline-overview');await panTo(SATELLITE_DATELINE,currentStage);await capture(currentStage,SATELLITE_DATELINE,'eox-bluemarble');
  const initialZoom=report.steps[0].camera.zoom;assert.ok(initialZoom<8,'The satellite overview must start below native8');
  await phase('dateline-native8');
  for(let count=0;(await settledMap(cdp,profile.engine)).camera.zoom<8-.01;count++){assert.ok(count<12,'Satellite native8 zoom exceeded12 inputs');await zoom(1);}
  await panTo(SATELLITE_DATELINE,currentStage);await capture(currentStage,SATELLITE_DATELINE,'eox-bluemarble');
  await phase('dateline-overzoom');await zoom(1);await zoom(1);await panTo(SATELLITE_DATELINE,currentStage);await capture(currentStage,SATELLITE_DATELINE,'eox-bluemarble');
  await phase('west-eox');
  const upwardCount=report.zooms.length;for(let count=0;count<upwardCount;count++)await zoom(-1);
  assert.ok(Math.abs((await settledMap(cdp,profile.engine)).camera.zoom-initialZoom)<.01,'The native zoom sweep did not restore the original scale');
  await panTo(SATELLITE_WEST,currentStage);await capture(currentStage,SATELLITE_WEST,'eox-s2');
  await phase('dateline-return');await panTo(SATELLITE_DATELINE,currentStage);await capture(currentStage,SATELLITE_DATELINE,'eox-bluemarble');
  await phase('detail-restored');await toggle('Рельеф');await capture(currentStage,null,null);
  report.performance=await evaluate(cdp,'({layoutShift:window.__tropnikPerf?.cls||0,longestTaskMs:window.__tropnikPerf?.longest||0})');
  report.resources=observer.snapshot();report.passed=true;assertSatelliteContinuityAudit(report,profile.name,profile.engine);report.completedAt=new Date().toISOString();report.durationMs=Date.parse(report.completedAt)-Date.parse(report.startedAt);await save();return report;
 }catch(error){report.passed=false;report.error=error.stack||String(error);await save();throw error;}
 finally{observer.dispose();}
}
