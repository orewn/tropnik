import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser,browserErrorDetails} from './browser-startup.mjs';
import {browserEnvironmentArgs,collectBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {collectNativeBrowserSurface,assertNativeSurfaceCoverage} from './browser-native-surface.mjs';
import {inspectCustomMapDOM,assertCustomMapInspection} from './browser-custom-map.mjs';

const PROJECT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const rootArgument=process.argv.indexOf('--root');
const ROOT=rootArgument<0?join(PROJECT,'web/pages-preview/dist'):resolve(process.argv[rootArgument+1]);
const RECEIPT=join(ROOT,'browser-map-loading-verification.json');
const CAPTURES=join(PROJECT,'web/pages-preview/design-qa/map-loading');
export const MAP_LOADING_PROFILE=Object.freeze({name:'desktop-webgl',width:1440,height:1000,mobile:false,deviceScaleFactor:1});
export const MAP_LOADING_ROUTE=Object.freeze({id:'osm-relation-17013428',regionId:'territory-28173009B90469334921421',title:'Лубяной тракт'});
export const MAP_LOADING_LIMITS=Object.freeze({acquireMs:15000,holdMs:8000,progressMs:6000,settleMs:15000,networkRecords:256,maxCells:64,maxSetupZooms:4});
export const MAP_LOADING_PIXEL_LIMITS=Object.freeze({size:64,inset:4,maxROIs:24,minReferenceColors:16,minChannelRange:8,minNonModalFraction:.25,minCells:2});
const SOURCE_PATHS=[
  'web/lib/custom-map-engine.ts','web/lib/custom-map-tiles.ts','web/lib/custom-map-camera.ts',
  'web/lib/custom-map-painter.ts','web/lib/custom-map-tiles.worker.ts','web/lib/map-resource-pool.ts',
  'web/lib/map-preload.ts','web/lib/catalog.generated.json','tools/pages-preview/browser-map-loading.mjs',
];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.geojson':'application/geo+json','.coverage':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8'};
const ZOOM_OUT='.map-controls button[aria-label="Уменьшить масштаб"]';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cellKey=tile=>[tile.z,tile.x,tile.y].join('/');
const project=([longitude,latitude])=>({x:(longitude+180)/360,y:(1-Math.asinh(Math.tan(latitude*Math.PI/180))/Math.PI)/2});
const unproject=({x,y})=>[x*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI];
const box=(left,top,right,bottom)=>({left,top,right,bottom});
const area=rect=>Math.max(0,rect.right-rect.left)*Math.max(0,rect.bottom-rect.top);
const intersection=(a,b)=>box(Math.max(a.left,b.left),Math.max(a.top,b.top),Math.min(a.right,b.right),Math.min(a.bottom,b.bottom));

/** Independent flat-camera geometry from the published DOM inspection.
 * This predicts the ordinary -1 control; it never writes a camera or calls
 * the application's planner. The last native action must match this plan. */
export function planLoadingZoom(frame){
  const map=frame.map??frame,{camera,viewport}=map;
  assert.equal(map.pitch,0);assert.equal(camera.bearingDegrees??0,0);
  for(const key of ['width','height'])assert.ok(Number.isFinite(viewport[key])&&viewport[key]>0);
  const padding=viewport.padding;
  for(const key of ['left','right','top','bottom'])assert.ok(Number.isFinite(padding[key])&&padding[key]>=0);
  assert.ok(padding.left+padding.right<viewport.width&&padding.top+padding.bottom<viewport.height);
  const zoom=camera.zoom-1,level=Math.ceil(zoom),center=project(camera.center);
  assert.equal(level,11,'The measured slow-loading view must use actual z11 cells');
  const oldScale=256*2**camera.zoom,newScale=256*2**zoom;
  const anchor={x:(padding.left-padding.right)/2,y:(padding.top-padding.bottom)/2};
  const target={center:unproject({x:center.x+anchor.x*(1/oldScale-1/newScale),y:center.y+anchor.y*(1/oldScale-1/newScale)}),zoom,bearingDegrees:0};
  const middle=project(target.center),n=2**level;
  const x0=Math.floor((middle.x-viewport.width/(2*newScale))*n),x1=Math.floor((middle.x+viewport.width/(2*newScale))*n);
  const y0=Math.max(0,Math.floor((middle.y-viewport.height/(2*newScale))*n)),y1=Math.min(n-1,Math.floor((middle.y+viewport.height/(2*newScale))*n));
  const cells=[];
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)cells.push({z:level,x,y});
  assert.ok(cells.length>=4&&cells.length<=MAP_LOADING_LIMITS.maxCells,'The ordinary viewport exceeds this focused gate');
  assert.ok(x0>=0&&x1<n,'This route must not require dateline wrapping');
  const requested=new Set(cells.map(cellKey)),halo=new Map();
  for(const cell of cells)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const candidate={z:level,x:cell.x+dx,y:cell.y+dy},key=cellKey(candidate);
    if((dx||dy)&&candidate.y>=0&&candidate.y<n&&!requested.has(key))halo.set(key,candidate);
  }
  return{method:'independent-flat-DOM-camera-and-visible-viewport',camera:target,viewport:structuredClone(viewport),level,cells,haloCandidates:[...halo.values()]};
}

export function mapLoadingResource(value){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash)return null;
    let match,kind;
    if(url.hostname==='tiles.mapterhorn.com'){match=url.pathname.match(/^\/(\d+)\/(\d+)\/(\d+)\.webp$/);kind='dem';}
    else if(url.hostname==='tiles.openfreemap.org'){match=url.pathname.match(/^\/planet\/[A-Za-z0-9_-]+\/(\d+)\/(\d+)\/(\d+)\.pbf$/);kind='vector';}
    if(!match)return null;
    const [z,x,y]=match.slice(1).map(Number);
    if(![z,x,y].every(Number.isSafeInteger)||z<0||z>18||x<0||x>=2**z||y<0||y>=2**z)return null;
    return{kind,z,x,y,url:url.href};
  }catch{return null;}
}

/** Exactly one genuine external halo request is delayed. All other requests
 * continue unmodified, including their URLs, headers and response bytes.
 * The timer bounds the fixture; it never substitutes an application clock. */
export async function holdMapLoadingHalo(cdp,plan,{timeoutMs=MAP_LOADING_LIMITS.holdMs,acquireTimeoutMs=MAP_LOADING_LIMITS.acquireMs}={}){
  assert.ok(Number.isFinite(timeoutMs)&&timeoutMs>0&&timeoutMs<=MAP_LOADING_LIMITS.holdMs);
  assert.ok(Number.isFinite(acquireTimeoutMs)&&acquireTimeoutMs>0&&acquireTimeoutMs<=MAP_LOADING_LIMITS.acquireMs);
  const halo=new Set(plan.haloCandidates.map(cellKey)),pending=new Map(),inFlight=new Set(),errors=[];
  let held=null,closed=false,reason=null,releasePromise,timer,observed=0,enabledAtEpochMs,enabledAtMonotonicMs;
  const error=value=>{if(errors.length<16)errors.push(String(value?.message||value));};
  const snapshot=()=>({schemaVersion:1,kind:'one-real-external-dem-halo',timeoutMs,acquireTimeoutMs,enabledAtEpochMs,enabledAtMonotonicMs,observed,held:held&&structuredClone(held),pending:pending.size,closed,reason,errors:[...errors]});
  const resume=(requestId,record)=>{
    pending.delete(requestId);
    const command=cdp.call('Fetch.continueRequest',{requestId}).then(()=>{if(record){record.resumedAtEpochMs=Date.now();record.resumedAtMonotonicMs=performance.now();}}).catch(error).finally(()=>inFlight.delete(command));
    inFlight.add(command);return command;
  };
  const release=releaseReason=>{
    if(releasePromise)return releasePromise;
    closed=true;reason=releaseReason;clearTimeout(timer);
    releasePromise=(async()=>{
      for(const [requestId,record]of pending)resume(requestId,record);
      try{while(inFlight.size)await Promise.allSettled([...inFlight]);await cdp.call('Fetch.disable');}
      catch(problem){error(problem);}
      finally{unobserve();}
      return snapshot();
    })();
    return releasePromise;
  };
  const unobserve=cdp.observe('Fetch.requestPaused',event=>{
    observed++;
    const resource=mapLoadingResource(event.request?.url);
    if(!closed&&!held&&resource?.kind==='dem'&&halo.has(cellKey(resource))){
      held={requestId:event.requestId,networkId:event.networkId??null,url:resource.url,cell:{z:resource.z,x:resource.x,y:resource.y},
        pausedAtEpochMs:Date.now(),pausedAtMonotonicMs:performance.now(),resumedAtEpochMs:null,resumedAtMonotonicMs:null};
      pending.set(event.requestId,held);clearTimeout(timer);
      timer=setTimeout(()=>{error('Real halo pause exceeded its bounded deadline');void release('timeout');},timeoutMs);return;
    }
    void resume(event.requestId);
  });
  try{
    enabledAtEpochMs=Date.now();enabledAtMonotonicMs=performance.now();
    await cdp.call('Fetch.enable',{patterns:[{urlPattern:'https://tiles.mapterhorn.com/'+plan.level+'/*',requestStage:'Request'}]},acquireTimeoutMs);
    // Acquisition has its own bound. The eight-second pause starts only when
    // a real matching fetch is held, not while a native button settles.
    if(!held&&!closed)timer=setTimeout(()=>{error('No real halo was acquired within the bounded setup interval');void release('acquire-timeout');},Math.max(0,acquireTimeoutMs-(performance.now()-enabledAtMonotonicMs)));
  }catch(problem){error(problem);await release('enable-error');throw problem;}
  return{snapshot,release};
}

/** Exact union area of bounded axis-aligned rectangles, not sparse samples. */
export function rectangleUnionArea(rectangles){
  const valid=rectangles.filter(rect=>area(rect)>0);
  const xs=[...new Set(valid.flatMap(rect=>[rect.left,rect.right]))].sort((a,b)=>a-b);
  let result=0;
  for(let index=1;index<xs.length;index++){
    const left=xs[index-1],right=xs[index];
    const spans=valid.filter(rect=>rect.left<right&&rect.right>left).map(rect=>[rect.top,rect.bottom]).sort((a,b)=>a[0]-b[0]);
    let low=null,high=null,height=0;
    for(const [top,bottom]of spans){if(low===null){low=top;high=bottom;}else if(top<=high)high=Math.max(high,bottom);else{height+=high-low;low=top;high=bottom;}}
    if(low!==null)height+=high-low;
    result+=(right-left)*height;
  }
  return result;
}

function tileRectangle(tile,map){
  const middle=project(map.camera.center),scale=256*2**map.camera.zoom,n=2**tile.z;
  return box(map.viewport.width/2+(tile.x/n-middle.x)*scale,map.viewport.height/2+(tile.y/n-middle.y)*scale,
    map.viewport.width/2+((tile.x+1)/n-middle.x)*scale,map.viewport.height/2+((tile.y+1)/n-middle.y)*scale);
}
function validTile(tile,kind){
  assert.equal(tile.kind,kind);assert.match(tile.key,new RegExp('^'+kind+':'));
  assert.ok([tile.z,tile.x,tile.y].every(Number.isSafeInteger));assert.ok(tile.z>=0&&tile.z<=18);
  assert.ok(tile.y>=0&&tile.y<2**tile.z);
  for(const key of ['width','height'])assert.ok(Number.isInteger(tile[key])&&tile[key]>1&&tile[key]<=1024);
  assert.equal(tile.transparent,false);
  const sw=unproject({x:tile.x/2**tile.z,y:(tile.y+1)/2**tile.z}),ne=unproject({x:(tile.x+1)/2**tile.z,y:tile.y/2**tile.z});
  assert.equal(tile.bounds.length,4);
  [sw[0],sw[1],ne[0],ne[1]].forEach((value,index)=>assert.ok(Math.abs(value-tile.bounds[index])<1e-7,'Actual tile bounds disagree with its source cell'));
}
export function loadingCoverage(frame){
  const map=frame.map,{width,height,padding}=map.viewport;
  const visible=box(Math.max(padding.left,-frame.rect.left),Math.max(padding.top,-frame.rect.top),
    Math.min(width-padding.right,frame.viewport.width-frame.rect.left),Math.min(height-padding.bottom,frame.viewport.height-frame.rect.top));
  assert.ok(area(visible)>0);
  const clip=tiles=>tiles.map(tile=>intersection(tileRectangle(tile,map),visible)).filter(rect=>area(rect)>0);
  const canonical=clip(map.tiles.detail),progress=clip(map.loadingGround?.detail??[]),overview=clip(map.tiles.overview);
  const canonicalArea=rectangleUnionArea(canonical),progressArea=rectangleUnionArea(progress);
  const combined=rectangleUnionArea([...canonical,...progress]);
  return{visible,visibleCssPixels:area(visible),canonicalCssPixels:canonicalArea,progressCssPixels:progressArea,
    expandedCssPixels:combined-canonicalArea,coveredCssPixels:rectangleUnionArea([...overview,...canonical,...progress]),
    progressRects:progress};
}

function subtractRectangle(rect,cut){
  const overlap=intersection(rect,cut);if(area(overlap)<=0)return[rect];
  return[box(rect.left,rect.top,rect.right,overlap.top),box(rect.left,overlap.bottom,rect.right,rect.bottom),
    box(rect.left,overlap.top,overlap.left,overlap.bottom),box(overlap.right,overlap.top,rect.right,overlap.bottom)].filter(value=>area(value)>0);
}
function pixelObstacles(frame){
  const labels=frame.map.labels.filter(label=>label.visible&&label.rect).map(label=>label.rect);
  return[...(frame.occlusions??[]),...labels];
}
/** Candidate coordinates are fixed from pending geometry before final pixels
 * exist. Entire ROIs lie inside paired cells, beyond old ground and away from
 * map labels/controls. Round-robin cells prevent one patch owning all samples. */
export function loadingPixelROIs(frame){
  const {size,inset,maxROIs}=MAP_LOADING_PIXEL_LIMITS,map=frame.map,visible=loadingCoverage(frame).visible;
  assert.equal(map.canvas.width,Math.round(map.viewport.width));assert.equal(map.canvas.height,Math.round(map.viewport.height));
  const expand=rect=>box(rect.left-inset,rect.top-inset,rect.right+inset,rect.bottom+inset);
  const obstacles=[...map.tiles.detail.map(tile=>expand(tileRectangle(tile,map))),...pixelObstacles(frame).map(expand)];
  const cells=[...(map.loadingGround?.detail??[])].sort((a,b)=>a.y-b.y||a.x-b.x);
  const byCell=[];
  for(const tile of cells){
    const cell=tileRectangle(tile,map),inside=intersection(box(cell.left+inset,cell.top+inset,cell.right-inset,cell.bottom-inset),visible);
    let pieces=area(inside)>0?[inside]:[];
    for(const obstacle of obstacles)pieces=pieces.flatMap(piece=>subtractRectangle(piece,obstacle));
    const candidates=[],seen=new Set();
    for(const piece of pieces.sort((a,b)=>area(b)-area(a)||a.top-b.top||a.left-b.left)){
      const left=Math.ceil(piece.left),top=Math.ceil(piece.top),right=Math.floor(piece.right),bottom=Math.floor(piece.bottom);
      if(right-left<size||bottom-top<size)continue;
      const xs=[Math.floor((left+right-size)/2),left,right-size],ys=[Math.floor((top+bottom-size)/2),top,bottom-size];
      for(const y of ys)for(const x of xs){const key=x+'/'+y;if(seen.has(key))continue;seen.add(key);
        candidates.push({cell:{z:tile.z,x:tile.x,y:tile.y},x,y,width:size,height:size});}
    }
    if(candidates.length)byCell.push(candidates);
  }
  const result=[];
  for(let index=0;result.length<maxROIs;index++){
    let added=false;
    for(const candidates of byCell)if(candidates[index]){result.push(candidates[index]);added=true;if(result.length===maxROIs)break;}
    if(!added)break;
  }
  return result;
}
function rawPixels(sample){
  assert.equal(typeof sample.rgbaBase64,'string');
  const bytes=Buffer.from(sample.rgbaBase64,'base64');assert.equal(bytes.toString('base64'),sample.rgbaBase64);
  assert.equal(bytes.length,sample.roi.width*sample.roi.height*4);return bytes;
}
export function loadingPixelStatistics(bytes){
  assert.ok(bytes.length>0&&bytes.length%4===0);
  const colors=new Map(),minimum=[255,255,255],maximum=[0,0,0];let opaquePixels=0,modalPixels=0;
  for(let offset=0;offset<bytes.length;offset+=4){
    const color=(bytes[offset]<<16)|(bytes[offset+1]<<8)|bytes[offset+2],count=(colors.get(color)||0)+1;colors.set(color,count);modalPixels=Math.max(modalPixels,count);
    if(bytes[offset+3]===255)opaquePixels++;
    for(let channel=0;channel<3;channel++){minimum[channel]=Math.min(minimum[channel],bytes[offset+channel]);maximum[channel]=Math.max(maximum[channel],bytes[offset+channel]);}
  }
  const pixels=bytes.length/4,channelRanges=maximum.map((value,index)=>value-minimum[index]);
  return{bytes:bytes.length,sha256:digest(bytes),pixels,opaquePixels,distinctRGB:colors.size,channelRanges,modalPixels,nonModalPixels:pixels-modalPixels};
}
const texturedReference=stats=>stats.distinctRGB>=MAP_LOADING_PIXEL_LIMITS.minReferenceColors&&Math.max(...stats.channelRanges)>=MAP_LOADING_PIXEL_LIMITS.minChannelRange&&stats.nonModalPixels>=stats.pixels*MAP_LOADING_PIXEL_LIMITS.minNonModalFraction;
function loadingError(code,message){const error=new Error(message);error.code=code;return error;}

/** The complete frame is the reference. Eligibility uses ONLY its texture and
 * geometry, never whether the two images match. Every eligible ROI is compared
 * byte-for-byte; two distinct cells are mandatory. Flat/retained pending data
 * cannot pass merely by reporting ready metadata or opaque hashes. */
export function compareMapLoadingPixels(pendingFrame,completeFrame,pending,complete){
  assertCamera(completeFrame.map.camera,pendingFrame.map.camera);
  assert.deepEqual(completeFrame.map.viewport,pendingFrame.map.viewport);assert.deepEqual(completeFrame.rect,pendingFrame.rect);
  assert.deepEqual(completeFrame.map.coverage,pendingFrame.map.coverage,'The geographic mask changed during the pixel comparison');
  assert.deepEqual(completeFrame.map.catalogueOverlay,pendingFrame.map.catalogueOverlay,'The independent trail overlay changed during the pixel comparison');
  const rois=loadingPixelROIs(pendingFrame);assert.deepEqual(pending.map(sample=>sample.roi),rois);assert.deepEqual(complete.map(sample=>sample.roi),rois);
  assert.ok(rois.length>0&&rois.length<=MAP_LOADING_PIXEL_LIMITS.maxROIs);
  const comparisons=[],eligibleCells=new Set(),completeObstacles=pixelObstacles(completeFrame);
  for(let index=0;index<rois.length;index++){
    assert.equal(typeof pending[index].unobscured,'boolean');assert.equal(typeof complete[index].unobscured,'boolean');
    assertCamera(pending[index].camera,pendingFrame.map.camera);assertCamera(complete[index].camera,completeFrame.map.camera);
    assert.ok(pending[index].drawRevision>=pendingFrame.map.drawRevision);assert.ok(complete[index].drawRevision>=completeFrame.map.drawRevision);
    assert.equal(pending[index].generation,pendingFrame.map.loadingGround.generation);assert.equal(complete[index].generation,null);
    const roi=rois[index],a=rawPixels(pending[index]),b=rawPixels(complete[index]),pendingStats=loadingPixelStatistics(a),completeStats=loadingPixelStatistics(b);
    assert.equal(pendingStats.opaquePixels,pendingStats.pixels);assert.equal(completeStats.opaquePixels,completeStats.pixels);
    const rect=box(roi.x,roi.y,roi.x+roi.width,roi.y+roi.height),clear=!!pending[index].unobscured&&!!complete[index].unobscured&&!completeObstacles.some(obstacle=>area(intersection(rect,obstacle))>0);
    const textured=texturedReference(completeStats),eligible=clear&&textured;
    let differentPixels=0,maxChannelDelta=0;
    for(let offset=0;offset<a.length;offset+=4){let different=false;
      for(let channel=0;channel<4;channel++){const delta=Math.abs(a[offset+channel]-b[offset+channel]);maxChannelDelta=Math.max(maxChannelDelta,delta);different||=delta!==0;}
      if(different)differentPixels++;
    }
    comparisons.push({roi,pending:pendingStats,complete:completeStats,unobscured:clear,texturedReference:textured,eligible,differentPixels,maxChannelDelta});
    if(eligible)eligibleCells.add(cellKey(roi.cell));
  }
  if(eligibleCells.size<MAP_LOADING_PIXEL_LIMITS.minCells)throw loadingError('MAP_LOADING_NO_TEXTURED_REFERENCE','Fewer than two unobscured completed cells contain the required real texture outside the old footprint');
  const wrong=comparisons.filter(item=>item.eligible&&item.differentPixels!==0);
  if(wrong.length)throw loadingError('MAP_LOADING_PIXELS_DIFFER','Pending painted pixels differ from the same-camera complete ground in '+wrong.length+' eligible ROIs');
  return{schemaVersion:1,surface:'canvas.tropnik-map-canvas',coordinates:'actual DPR1 backing pixels',limits:MAP_LOADING_PIXEL_LIMITS,
    eligibility:'fixed pending geometry; complete-only texture; no selection by pixel agreement',pending,complete,comparisons,eligibleCells:[...eligibleCells].sort(),differentEligiblePixels:0};
}

function assertCamera(actual,expected){
  assert.ok(Math.abs(actual.zoom-expected.zoom)<1e-8);
  for(let index=0;index<2;index++)assert.ok(Math.abs(actual.center[index]-expected.center[index])<1e-8,'Native zoom used another geographic focus');
  assert.ok(Math.abs((actual.bearingDegrees??0)-(expected.bearingDegrees??0))<1e-8);
}
function assertFrame(frame,{settled=true}={}){
  assertCustomMapInspection(frame.map,'map-loading',{mode:'detail',routeId:MAP_LOADING_ROUTE.id,settled});
  assert.equal(frame.moving,false);assert.equal(frame.map.pitch,0);assert.equal(frame.map.camera.bearingDegrees??0,0);
  assert.equal(frame.selection.route,MAP_LOADING_ROUTE.id);assert.equal(frame.selection.region,MAP_LOADING_ROUTE.regionId);
  assert.equal(frame.selection.title,MAP_LOADING_ROUTE.title);
  assert.equal(frame.viewport.width,MAP_LOADING_PROFILE.width);assert.equal(frame.viewport.height,MAP_LOADING_PROFILE.height);
  assert.equal(frame.viewport.dpr,MAP_LOADING_PROFILE.deviceScaleFactor);
}
function assertLoadingObservation(frame,plan,held,network){
  assertFrame(frame,{settled:false});assertCamera(frame.map.camera,plan.camera);
  assert.deepEqual(frame.map.viewport,plan.viewport);assert.equal(frame.map.state.loading,true);assert.equal(frame.map.state.error,'');
  assert.equal(frame.map.coverage.pending,0);assert.equal(frame.map.coverage.error,'');
  assert.equal(frame.map.catalogueOverlay.currentViewportReady,true);assert.equal(frame.map.catalogueOverlay.pending,false);assert.equal(frame.map.catalogueOverlay.error,'');
  assert.equal(held.pending,1);assert.equal(held.closed,false);assert.equal(held.held.resumedAtEpochMs,null);
  const request=network.records.find(item=>item.requestId===held.held.networkId);
  assert.ok(request&&request.url===held.held.url);assert.equal(request.finishedAtEpochMs,null);assert.equal(request.failed,null);
  assert.ok(network.records.every(item=>!item.failed),'Another target source failed during the deliberate hold');
  for(const kind of ['vector','dem'])assert.ok(network.records.some(item=>item.kind===kind&&item.finishedAtEpochMs&&item.status===200),'No independent completed '+kind+' source before the progress observation');
}
export function assertMapLoadingProgress(before,pending,plan,held,network){
  assertFrame(before);assertLoadingObservation(pending,plan,held,network);
  assert.deepEqual(pending.map.viewport,plan.viewport);assert.deepEqual(pending.rect,before.rect);
  assert.equal(pending.map.state.loading,true);assert.equal(pending.map.state.error,'');
  assert.ok(pending.map.drawRevision>before.map.drawRevision,'No actual frame was painted after native zoom');
  for(const kind of ['detail','relief'])assert.deepEqual(pending.map.tiles[kind],before.map.tiles[kind],'Pending cells replaced the complete canonical '+kind+' batch');
  const loading=pending.map.loadingGround;
  assert.ok(loading,'No independently painted loading ground before the held halo completed');
  assert.ok(Number.isSafeInteger(loading.generation)&&loading.generation>0);
  assert.equal(loading.requestedCells,plan.cells.length);
  assert.ok(loading.readyCells>=2&&loading.readyCells<loading.requestedCells,'A partial current batch with at least two real pairs is required');
  assert.equal(loading.detail.length,loading.readyCells);assert.equal(loading.relief.length,loading.readyCells);
  const expected=new Set(plan.cells.map(cellKey)),details=loading.detail.map(cellKey),reliefs=loading.relief.map(cellKey);
  assert.equal(new Set(details).size,details.length);assert.deepEqual([...details].sort(),[...reliefs].sort());
  for(const tile of loading.detail){validTile(tile,'vector');assert.ok(expected.has(cellKey(tile)),'A stale cell counted as current progress');}
  for(const tile of loading.relief)validTile(tile,'relief');
  const coverage=loadingCoverage(pending);
  assert.ok(coverage.expandedCssPixels>1,'Prepared pairs did not extend beyond the old small patch');
  assert.ok(coverage.coveredCssPixels>=coverage.visibleCssPixels-.01,'A hole in the actual fallback/progress bitmap coverage');
  assert.equal(held.schemaVersion,1);assert.equal(held.kind,'one-real-external-dem-halo');assert.equal(held.timeoutMs,MAP_LOADING_LIMITS.holdMs);
  assert.equal(held.acquireTimeoutMs,MAP_LOADING_LIMITS.acquireMs);
  assert.equal(held.pending,1);assert.equal(held.closed,false);assert.equal(held.reason,null);assert.deepEqual(held.errors,[]);
  assert.equal(held.held.resumedAtEpochMs,null);assert.ok(plan.haloCandidates.some(tile=>cellKey(tile)===cellKey(held.held.cell)));
  assert.ok(!expected.has(cellKey(held.held.cell)),'The delayed DEM is a primary cell, not an external halo');
  assert.equal(network.overflow,0);
  const request=network.records.find(item=>item.requestId===held.held.networkId);
  assert.ok(request&&request.url===held.held.url,'No independent Network event for the actual held fetch');
  assert.equal(request.finishedAtEpochMs,null);assert.equal(request.failed,null);
  assert.equal(network.records.filter(item=>item.url===held.held.url).length,1,'A duplicate physical fetch bypassed the held source');
  return coverage;
}

export function assertMapLoadingReceipt(report,{sourceCommit,buildId,environment}={}){
  assert.equal(report?.schemaVersion,1);assert.equal(report.evidence,'production-app-map-loading');assert.equal(report.verified,true);
  assert.match(sourceCommit||'',/^[a-f0-9]{40}$/);assert.equal(report.sourceCommit,sourceCommit);assert.equal(report.buildId,buildId);
  assert.deepEqual(report.profile,MAP_LOADING_PROFILE);assert.deepEqual(report.route,MAP_LOADING_ROUTE);assert.deepEqual(report.limits,MAP_LOADING_LIMITS);
  if(environment)assertMatchingBrowserEnvironments(report.environment,environment,sourceCommit);
  assert.deepEqual(Object.keys(report.sources).sort(),[...SOURCE_PATHS].sort());
  for(const hash of Object.values(report.sources))assert.match(hash,/^[a-f0-9]{64}$/);
  assert.deepEqual(report.fixture,{fault:'Pause one genuine external DEM halo request until paired viewport progress is painted',responseBytesReplaced:false,clockOverridden:false,workerStateOverridden:false,appStateOverridden:false,cacheDisabled:false,serviceWorkerBypassed:false});
  assert.ok(report.actions.length>=1&&report.actions.length<=MAP_LOADING_LIMITS.maxSetupZooms+1);
  for(const action of report.actions){
    assert.equal(action.selector,ZOOM_OUT);assert.equal(action.point.unobscured,true);
    assert.deepEqual(action.events.map(event=>event.type),['pointerdown','pointerup','click']);
    for(const event of action.events){assert.equal(event.trusted,true);assert.equal(event.pointerType,'mouse');assert.ok(Number.isInteger(event.pointerId));}
    assert.equal(new Set(action.events.map(event=>event.pointerId)).size,1);
  }
  assert.deepEqual(report.plan,planLoadingZoom(report.before));
  assert.equal(report.observation.stableTargetObserved,true);
  assert.ok(report.observation.stableAtMonotonicMs>=report.held.held.pausedAtMonotonicMs);
  assert.ok(report.observation.progressAtMonotonicMs-report.held.held.pausedAtMonotonicMs<=MAP_LOADING_LIMITS.progressMs);
  assert.deepEqual(report.coverage,assertMapLoadingProgress(report.before,report.pending,report.plan,report.held,report.networkAtProgress));
  assertFrame(report.complete);assertCamera(report.complete.map.camera,report.plan.camera);
  assert.deepEqual(report.complete.rect,report.pending.rect);assert.deepEqual(report.complete.map.viewport,report.plan.viewport);
  assert.equal(report.complete.map.loadingGround,null,'The staging batch survived canonical completion');
  const cells=report.plan.cells.map(cellKey).sort();
  for(const kind of ['detail','relief']){
    const tiles=report.complete.map.tiles[kind];assert.deepEqual(tiles.map(cellKey).sort(),cells);
    for(const tile of tiles)validTile(tile,kind==='detail'?'vector':'relief');
  }
  assert.ok(report.complete.map.drawRevision>report.pending.map.drawRevision);
  assert.equal(report.released.timeoutMs,MAP_LOADING_LIMITS.holdMs);assert.equal(report.released.acquireTimeoutMs,MAP_LOADING_LIMITS.acquireMs);
  assert.equal(report.released.reason,'progress-captured');assert.equal(report.released.closed,true);assert.equal(report.released.pending,0);assert.deepEqual(report.released.errors,[]);
  assert.ok(report.released.held.resumedAtEpochMs>=report.held.held.pausedAtEpochMs);
  assert.ok(report.released.held.resumedAtMonotonicMs-report.held.held.pausedAtMonotonicMs<MAP_LOADING_LIMITS.holdMs);
  assert.ok(report.held.held.pausedAtMonotonicMs-report.held.enabledAtMonotonicMs<=MAP_LOADING_LIMITS.acquireMs);
  assert.equal(report.networkComplete.overflow,0);
  const request=report.networkComplete.records.find(item=>item.requestId===report.held.held.networkId);
  assert.ok(request&&request.finishedAtEpochMs>=report.released.held.resumedAtEpochMs);
  assert.equal(request.status,200);assert.equal(request.failed,null);assert.equal(request.fromServiceWorker,false);assert.equal(request.fromDiskCache,false);assert.equal(request.servedFromCache,false);assert.ok(request.encodedBytes>0);
  assert.equal(report.networkComplete.records.filter(item=>item.url===report.held.held.url).length,1);
  assert.ok(report.networkComplete.records.every(item=>item.finishedAtEpochMs&&item.status===200&&!item.failed),'A target-view source did not complete');
  assert.deepEqual(report.screenshots.map(item=>item.phase),['route','before','pending-progress','complete']);
  for(const shot of report.screenshots){assert.match(shot.file,/^map-loading-[a-z-]+\.png$/);assert.match(shot.sha256,/^[a-f0-9]{64}$/);assert.ok(shot.bytes>1000);assert.deepEqual([shot.width,shot.height],[MAP_LOADING_PROFILE.width,MAP_LOADING_PROFILE.height]);}
  assert.deepEqual(report.pixelWitness,compareMapLoadingPixels(report.pending,report.complete,report.pixelWitness.pending,report.pixelWitness.complete));
  assert.ok(Buffer.byteLength(JSON.stringify(report))<=4*1024*1024,'The source-bound receipt exceeds the public verifier body bound');
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.localHttpErrors,[]);
  assert.equal(report.browserProcess?.status,'ready');assert.equal(report.browserProcess.cleanup?.status,'stopped');assert.deepEqual(report.browserProcess.cleanup.errors,[]);
  return report;
}

class CDP{
  constructor(url){this.url=url;this.next=1;this.pending=new Map();this.observers=new Map();}
  async open(){
    this.socket=new WebSocket(this.url);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('CDP connection timed out')),10000);
      this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connection failed'));},{once:true});
    });
    this.socket.addEventListener('message',event=>{
      const value=JSON.parse(event.data);
      if(value.id){const job=this.pending.get(value.id);if(!job)return;this.pending.delete(value.id);clearTimeout(job.timer);value.error?job.reject(new Error(value.error.message)):job.resolve(value.result);return;}
      for(const observer of this.observers.get(value.method)||[])observer(value.params);
    });
  }
  call(method,params={},timeout=15000){
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP '+method+' timed out'));},timeout);
      this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));
    });
  }
  observe(method,callback){const list=this.observers.get(method)||new Set();list.add(callback);this.observers.set(method,list);return()=>list.delete(callback);}
  close(){for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(new Error('CDP closed'));}this.pending.clear();this.socket?.close();}
}
async function evaluate(cdp,expression){
  const value=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(value.exceptionDetails)throw new Error(JSON.stringify(value.exceptionDetails));return value.result.value;
}
async function waitValue(label,read,accept,timeout=MAP_LOADING_LIMITS.settleMs){
  const deadline=performance.now()+timeout;let last;
  while(performance.now()<deadline){last=await read();if(accept(last))return last;await pause(50);}
  const error=new Error(label+' did not complete within '+timeout+' ms');error.lastValue=last;throw error;
}
function inspectLoadingFrame(inspect){
  const map=inspect();if(!map)return null;
  const element=document.querySelector('.atlas-canvas[data-map-engine]'),r=element.getBoundingClientRect(),params=new URLSearchParams(location.search);
  const occlusions=[...document.querySelectorAll('.atlas-wrap button,.atlas-wrap a,.atlas-wrap [role="dialog"],.atlas-wrap .map-message')].flatMap(node=>{
    const box=node.getBoundingClientRect(),style=getComputedStyle(node);
    if(!box.width||!box.height||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return[];
    return[{left:box.left-r.left,top:box.top-r.top,right:box.right-r.left,bottom:box.bottom-r.top}];
  });
  return{atEpochMs:Date.now(),map,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
    viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},occlusions,moving:element.dataset.mapMoving==='true'||element.hasAttribute('data-map-camera'),
    tilesState:element.dataset.mapTilesState,selection:{route:params.get('route')||'',region:params.get('region')||'',title:document.querySelector('.explore-panel h1')?.textContent?.trim()||''},
    serviceWorkerController:navigator.serviceWorker.controller?.scriptURL||null};
}
const frameSource='('+inspectLoadingFrame.toString()+')('+inspectCustomMapDOM.toString()+')';
const readFrame=cdp=>evaluate(cdp,frameSource);
async function stableFrame(cdp,{loading=false}={}){
  let signature='',observations=0;
  return waitValue('The actual route camera/ground',()=>readFrame(cdp),frame=>{
    if(!frame||frame.moving||frame.map.routeId!==MAP_LOADING_ROUTE.id||frame.map.drawnRoute!==MAP_LOADING_ROUTE.id||!frame.map.coverage?.ready||!frame.map.state.ready||(!loading&&frame.tilesState!=='ready')){
      signature='';observations=0;return false;
    }
    const next=JSON.stringify([frame.map.camera,frame.map.viewport,frame.rect,frame.selection]);
    observations=next===signature?observations+1:1;signature=next;return observations>=4;
  });
}
const inputProbe='(()=>{window.__tropnikMapLoadingInput=[];for(const type of ["pointerdown","pointerup","click"])document.addEventListener(type,event=>{window.__tropnikMapLoadingInput.push({type:event.type,trusted:event.isTrusted,pointerType:event.pointerType||"",pointerId:event.pointerId,time:performance.now(),label:event.target.closest?.("button")?.getAttribute("aria-label")||""});if(window.__tropnikMapLoadingInput.length>16)window.__tropnikMapLoadingInput.shift();},true);})()';
async function nativeClick(cdp,selector){
  let prior,stable=0;
  const point=await waitValue('Reachable native control '+selector,()=>evaluate(cdp,
    '(()=>{const element=document.querySelector('+JSON.stringify(selector)+');if(!element||element.disabled)return null;const r=element.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{left:r.left,top:r.top,width:r.width,height:r.height,x,y,unobscured:!!hit&&element.contains(hit),animating:element.getAnimations().some(a=>a.pending||a.playState==="running")};})()'),value=>{
      const stopped=value?.unobscured&&!value.animating&&prior?.unobscured&&!prior.animating&&['x','y','width','height'].every(key=>Math.abs(value[key]-prior[key])<.25);
      stable=stopped?stable+1:0;prior=value;return stable>=2;
    });
  await evaluate(cdp,'window.__tropnikMapLoadingInput=[]');
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none',buttons:0,pointerType:'mouse'});
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});
  const events=await waitValue('Trusted click delivery',()=>evaluate(cdp,'window.__tropnikMapLoadingInput'),value=>value.some(event=>event.type==='click'),2000);
  return{selector,point,events};
}

/** Bounded passive source metadata for the final z11 view. Setup requests are
 * deliberately outside this interval; bodies and query strings are not read. */
export function observeMapLoadingNetwork(cdp,plan){
  const records=new Map(),stops=[];let overflow=0,disposed=false;
  const observe=(name,callback)=>stops.push(cdp.observe(name,event=>{if(!disposed)callback(event);}));
  observe('Network.requestWillBeSent',event=>{
    const resource=mapLoadingResource(event.request?.url);if(!resource||resource.z!==plan.level)return;
    if(records.size>=MAP_LOADING_LIMITS.networkRecords){overflow++;return;}
    if(records.has(event.requestId)){overflow++;return;}
    records.set(event.requestId,{requestId:event.requestId,url:resource.url,kind:resource.kind,cell:{z:resource.z,x:resource.x,y:resource.y},
      startedAtEpochMs:Date.now(),startedAtMonotonicSeconds:event.timestamp,finishedAtEpochMs:null,failed:null,status:null,
      fromDiskCache:false,fromServiceWorker:false,servedFromCache:false,encodedBytes:0});
  });
  observe('Network.responseReceived',event=>{
    const record=records.get(event.requestId);if(record)Object.assign(record,{status:event.response.status,fromDiskCache:!!event.response.fromDiskCache,fromServiceWorker:!!event.response.fromServiceWorker});
  });
  observe('Network.requestServedFromCache',event=>{const record=records.get(event.requestId);if(record)record.servedFromCache=true;});
  observe('Network.loadingFinished',event=>{const record=records.get(event.requestId);if(record)Object.assign(record,{finishedAtEpochMs:Date.now(),finishedAtMonotonicSeconds:event.timestamp,encodedBytes:event.encodedDataLength});});
  observe('Network.loadingFailed',event=>{const record=records.get(event.requestId);if(record)record.failed={errorText:event.errorText,canceled:!!event.canceled,atEpochMs:Date.now()};});
  return{snapshot:()=>({source:'page-target CDP Network events',limit:MAP_LOADING_LIMITS.networkRecords,overflow,disposed,records:structuredClone([...records.values()])}),
    dispose(){if(disposed)return;disposed=true;for(const stop of stops)stop();}};
}
async function screenshot(cdp,phase){
  const capture=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),bytes=Buffer.from(capture.data,'base64'),file='map-loading-'+phase+'.png';
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  assert.deepEqual([width,height],[MAP_LOADING_PROFILE.width,MAP_LOADING_PROFILE.height]);
  await writeFile(join(CAPTURES,file),bytes);return{phase,file,bytes:bytes.length,sha256:digest(bytes),width,height};
}
async function readPaintedROIs(cdp,rois){
  return evaluate(cdp,'(()=>{const element=document.querySelector(".atlas-canvas[data-map-engine]"),canvas=element.querySelector("canvas.tropnik-map-canvas"),r=canvas.getBoundingClientRect(),ctx=canvas.getContext("2d"),inspection=JSON.parse(element.dataset.mapInspection);return '+JSON.stringify(rois)+'.map(roi=>{let unobscured=true;for(const fx of [0,.5,1])for(const fy of [0,.5,1]){const x=r.left+roi.x+.5+(roi.width-1)*fx,y=r.top+roi.y+.5+(roi.height-1)*fy;if(document.elementFromPoint(x,y)!==canvas)unobscured=false;}const pixels=ctx.getImageData(roi.x,roi.y,roi.width,roi.height).data;return{roi,unobscured,rgbaBase64:btoa(String.fromCharCode(...pixels)),atEpochMs:Date.now(),camera:inspection.camera,drawRevision:inspection.drawRevision,generation:inspection.loadingGround?.generation??null};});})()');
}
function port(){return new Promise((resolve,reject)=>{const server=createNetServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});});}
function binary(){for(const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser'])if(spawnSync('which',[name],{stdio:'ignore'}).status===0)return name;throw new Error('Chromium is unavailable');}
async function inputs(){
  const build=JSON.parse(await readFile(join(ROOT,'build-info.json'),'utf8'));assert.equal(build.base,'/tropnik/');assert.match(build.buildId,/^[a-f0-9]{16}$/);
  const sources={};
  for(const path of SOURCE_PATHS){
    const bytes=await readFile(join(PROJECT,path)),input=build.inputs.find(item=>item.path===path);
    assert.ok(input,'Missing exact build input '+path);assert.equal(input.bytes,bytes.length);assert.equal(input.sha256,digest(bytes));sources[path]=input.sha256;
  }
  const catalogue=JSON.parse(await readFile(join(PROJECT,'web/lib/catalog.generated.json'),'utf8'));
  const find=value=>Array.isArray(value)?value.map(find).find(Boolean):value&&typeof value==='object'?(value.id===MAP_LOADING_ROUTE.id?value:Object.values(value).map(find).find(Boolean)):undefined;
  const route=find(catalogue);assert.ok(route);assert.equal(route.title,MAP_LOADING_ROUTE.title);assert.equal(route.regionId,MAP_LOADING_ROUTE.regionId);
  return{build,sources};
}

async function run(){
  const {build,sources}=await inputs();
  if(process.argv.includes('--check-inputs')){console.log(JSON.stringify({verified:false,browserLaunched:false,inputsMatch:true,buildId:build.buildId,sources}));return;}
  assert.match(process.env.GITHUB_SHA||'',/^[a-f0-9]{40}$/);assert.equal(build.sourceCommit,process.env.GITHUB_SHA);
  const report={schemaVersion:1,evidence:'production-app-map-loading',verified:false,sourceCommit:build.sourceCommit,buildId:build.buildId,sources,
    profile:MAP_LOADING_PROFILE,route:MAP_LOADING_ROUTE,limits:MAP_LOADING_LIMITS,startedAt:new Date().toISOString(),phase:'setup',
    fixture:{fault:'Pause one genuine external DEM halo request until paired viewport progress is painted',responseBytesReplaced:false,clockOverridden:false,workerStateOverridden:false,appStateOverridden:false,cacheDisabled:false,serviceWorkerBypassed:false},
    actions:[],screenshots:[],pageErrors:[],localHttpErrors:[],
    scope:'Actual built route, native mouse zoom and real map fetch/decoder/painter. One external halo fetch is delayed. Pending pixels outside old ground must exactly match textured complete pixels at the same camera. ROI eligibility never uses image agreement. This is not a provider-speed benchmark.'};
  const checkpoint=()=>writeFile(RECEIPT,JSON.stringify(report,null,2)+'\n');
  await mkdir(CAPTURES,{recursive:true});
  let browser,cdp,userDataDir,gate,network,failure;
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith(build.base))throw new Error('Unexpected artifact prefix');
      let path=resolve(ROOT,decodeURIComponent(url.pathname.slice(build.base.length))||'index.html');if(!path.startsWith(ROOT+sep))throw new Error('Path leaves artifact');
      if((await stat(path)).isDirectory())path=join(path,'index.html');const bytes=await readFile(path);
      res.writeHead(200,{'content-type':MIME[extname(path)]||'application/octet-stream'});res.end(bytes);
    }catch{res.writeHead(404);res.end('Not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  try{
    const debugPort=await port();userDataDir=await mkdtemp(join(tmpdir(),'tropnik-map-loading-'));
    browser=launchBrowser(binary(),browserEnvironmentArgs({debugPort,userDataDir}));
    const version=await browser.waitUntilReady('http://127.0.0.1:'+debugPort+'/json/version');
    report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:build.sourceCommit});
    const target=await browser.requestJSON('http://127.0.0.1:'+debugPort+'/json/new?about:blank',{method:'PUT'});cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();
    report.target={id:target.id,type:target.type};assert.equal(target.type,'page');
    report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);assertNativeSurfaceCoverage(report.environment.nativeSurface,[MAP_LOADING_PROFILE]);
    await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Network.enable');
    cdp.observe('Runtime.exceptionThrown',event=>report.pageErrors.push(event.exceptionDetails));
    cdp.observe('Network.responseReceived',({response})=>{if(response.status>=400&&response.url.startsWith(origin+'/'))report.localHttpErrors.push({url:response.url,status:response.status});});
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:MAP_LOADING_PROFILE.width,height:MAP_LOADING_PROFILE.height,deviceScaleFactor:1,mobile:false,screenWidth:MAP_LOADING_PROFILE.width,screenHeight:MAP_LOADING_PROFILE.height});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:inputProbe});
    const entry=new URL(origin+build.base);entry.searchParams.set('region',MAP_LOADING_ROUTE.regionId);entry.searchParams.set('route',MAP_LOADING_ROUTE.id);
    report.entrypoint=entry.pathname+entry.search;await cdp.call('Page.navigate',{url:entry.href});
    report.routeFrame=await stableFrame(cdp);assertFrame(report.routeFrame);
    if(await evaluate(cdp,'!!document.querySelector(".fact-dismiss")')){await nativeClick(cdp,'.fact-dismiss');report.routeFrame=await stableFrame(cdp);}
    report.screenshots.push(await screenshot(cdp,'route'));let before=report.routeFrame;
    for(let count=0;Math.ceil(before.map.camera.zoom)>12;count++){
      assert.ok(count<MAP_LOADING_LIMITS.maxSetupZooms,'Route framing required too many native setup zooms');
      report.actions.push(await nativeClick(cdp,ZOOM_OUT));before=await stableFrame(cdp);
    }
    assert.equal(Math.ceil(before.map.camera.zoom),12,'The real route must start above the target detail level');
    report.before=before;report.plan=planLoadingZoom(before);report.screenshots.push(await screenshot(cdp,'before'));await checkpoint();
    network=observeMapLoadingNetwork(cdp,report.plan);
    gate=await holdMapLoadingHalo(cdp,report.plan);report.phase='fixture-acquisition';
    report.actions.push(await nativeClick(cdp,ZOOM_OUT));
    report.faultAcquired=await waitValue('One real external halo request',()=>{
      const state=gate.snapshot();if(state.closed)throw loadingError('MAP_LOADING_FIXTURE_ACQUISITION_FAILED','Halo acquisition ended: '+state.reason);return state;
    },state=>!!state.held&&!state.closed,MAP_LOADING_LIMITS.acquireMs);
    report.phase='paired-progress-before-halo-release';report.observation={stableTargetObserved:false};
    let signature='',stable=0;
    const progressDeadline=report.faultAcquired.held.pausedAtMonotonicMs+MAP_LOADING_LIMITS.progressMs;
    try{
      const remaining=progressDeadline-performance.now();
      if(remaining<=0)throw loadingError('MAP_LOADING_FIXTURE_NOT_READY','The real held interval elapsed before target-view observation began');
      await waitValue('Actual paired cells before the held halo completes',async()=>{
        const frame=await readFrame(cdp),held=gate.snapshot(),events=network.snapshot();report.lastPending={frame,held,network:events};
        if(held.closed)throw loadingError('MAP_LOADING_FIXTURE_HOLD_ENDED','The actual halo pause ended before progress: '+held.reason);
        try{
          assertLoadingObservation(frame,report.plan,held,events);
          const next=JSON.stringify([frame.map.camera,frame.map.viewport,frame.rect,frame.map.coverage,frame.map.catalogueOverlay]);
          stable=next===signature?stable+1:1;signature=next;
          if(stable<4)return null;
          if(!report.observation.stableTargetObserved)report.observation={stableTargetObserved:true,stableAtEpochMs:Date.now(),stableAtMonotonicMs:performance.now()};
        }catch(error){signature='';stable=0;report.lastReadinessAssertion=error.message;return null;}
        let coverage;
        try{
          coverage=assertMapLoadingProgress(before,frame,report.plan,held,events);
          const rois=loadingPixelROIs(frame);assert.ok(new Set(rois.map(roi=>cellKey(roi.cell))).size>=MAP_LOADING_PIXEL_LIMITS.minCells,'Fewer than two fully visible ready-cell ROIs outside old ground');
        }catch(error){report.lastProgressAssertion=error.message;return null;}
        return{frame,held,network:events,coverage};
      },value=>!!value,remaining);
    }catch(error){
      if(error.code)throw error;
      const held=gate.snapshot();
      if(!report.observation.stableTargetObserved||stable<4)throw loadingError('MAP_LOADING_FIXTURE_NOT_READY','A real halo was held, but the intended stable camera/mask/overlay was not observed');
      try{assertLoadingObservation(report.lastPending.frame,report.plan,held,network.snapshot());}
      catch{throw loadingError('MAP_LOADING_FIXTURE_NOT_READY','The target-view/transport readiness was no longer valid at the progress deadline');}
      if(held.closed||held.pending!==1)throw loadingError('MAP_LOADING_FIXTURE_HOLD_ENDED','The actual delay ended before the progress verdict');
      if(report.lastProgressAssertion?.startsWith('No independently painted loading ground'))throw loadingError('MAP_LOADING_NO_PAINTED_PROGRESS','The stable target had no independently painted loading ground while its real external halo remained held');
      throw loadingError('MAP_LOADING_PROGRESS_REJECTED','Stable target progress failed its existing oracle: '+report.lastProgressAssertion);
    }
    report.observation.progressAtEpochMs=Date.now();report.observation.progressAtMonotonicMs=performance.now();
    if(report.observation.progressAtMonotonicMs>progressDeadline)throw loadingError('MAP_LOADING_FIXTURE_PROGRESS_DEADLINE','Observation completed after its bounded progress interval');
    // Advance real animation frames before binding the pixels to published
    // ready cells. This invokes no renderer/app callback and changes no clock.
    await evaluate(cdp,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    report.pending=await readFrame(cdp);report.held=gate.snapshot();report.networkAtProgress=network.snapshot();
    report.coverage=assertMapLoadingProgress(before,report.pending,report.plan,report.held,report.networkAtProgress);
    delete report.lastPending;delete report.lastProgressAssertion;delete report.lastReadinessAssertion;
    const rois=loadingPixelROIs(report.pending);
    assert.ok(new Set(rois.map(roi=>cellKey(roi.cell))).size>=MAP_LOADING_PIXEL_LIMITS.minCells);
    report.pixelReadback={pending:await readPaintedROIs(cdp,rois)};
    report.observation.pixelsCapturedAtMonotonicMs=performance.now();report.screenshots.push(await screenshot(cdp,'pending-progress'));
    const stillHeld=gate.snapshot();assert.equal(stillHeld.closed,false,'The pending screenshot was captured after the hold ended');assert.equal(stillHeld.pending,1);
    report.released=await gate.release('progress-captured');await checkpoint();
    report.phase='complete-canonical-ground';report.complete=await stableFrame(cdp);
    await waitValue('Target view network completion',()=>network.snapshot(),state=>state.records.length>0&&state.records.every(item=>item.finishedAtEpochMs&&!item.failed));
    await waitValue('Completed mask and trail overlay',()=>readFrame(cdp),frame=>frame?.map.coverage.pending===0&&frame.map.coverage.error===''&&frame.map.catalogueOverlay.currentViewportReady&&!frame.map.catalogueOverlay.pending&&frame.map.catalogueOverlay.error==='');
    await evaluate(cdp,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    report.complete=await readFrame(cdp);report.networkComplete=network.snapshot();
    report.pixelReadback.complete=await readPaintedROIs(cdp,rois);report.phase='painted-pixel-comparison';
    report.pixelWitness=compareMapLoadingPixels(report.pending,report.complete,report.pixelReadback.pending,report.pixelReadback.complete);delete report.pixelReadback;
    report.screenshots.push(await screenshot(cdp,'complete'));
  }catch(error){
    failure=error;report.failure={phase:report.phase,...browserErrorDetails(error),code:error.code||null,lastValue:error.lastValue};
    // Keep the acquired/last-held snapshots as the causal failure evidence.
    // Failure screenshots are explicitly after release, so diagnostics cannot
    // accidentally spend the remaining hold lease or be mistaken for its ROI.
    if(gate)report.released??=await gate.release('failure');
    if(cdp){report.lastFrame=await readFrame(cdp).catch(()=>null);try{report.failureScreenshot=await screenshot(cdp,'failure');report.failureScreenshotAfterRelease=true;}catch{}}
  }finally{
    if(gate){const released=await gate.release('finally');report.released??=released;}
    if(network){report.networkFinal=network.snapshot();network.dispose();}
    cdp?.close();if(browser){await browser.close();report.browserProcess=browser.diagnostics();}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    if(userDataDir)await rm(userDataDir,{recursive:true,force:true});report.finishedAt=new Date().toISOString();await checkpoint();
  }
  if(!failure){
    try{report.verified=true;assertMapLoadingReceipt(report,{sourceCommit:build.sourceCommit,buildId:build.buildId});}
    catch(error){failure=error;report.verified=false;report.failure={phase:'receipt-validation',...browserErrorDetails(error)};}
    await checkpoint();
  }
  if(failure)throw failure;
  console.log(JSON.stringify({verified:true,sourceCommit:report.sourceCommit,buildId:report.buildId,readyCells:report.pending.map.loadingGround.readyCells,requestedCells:report.plan.cells.length,expandedCssPixels:report.coverage.expandedCssPixels,heldUrl:report.held.held.url,receipt:RECEIPT}));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await run();
