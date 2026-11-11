import assert from 'node:assert/strict';
import {assertCustomMapInspection} from './browser-custom-map.mjs';

export const COAST_LABEL_REQUEST=Object.freeze({schemaVersion:1,
 names:['Приморск','Малые Сопки','Карасёвка','Карасевка','Выборг'],limit:100});

/** A synchronous request through the application's read-only DOM diagnostic.
 * No React/SDK object discovery, network request, synthetic map input or cache
 * warmup. Called only after the existing accepted intervals and saved PNG. */
export function requestLabelInspection(request,doc=globalThis.document){
 const custom=doc.querySelector('.atlas-canvas[data-map-engine="tropnik-canvas"]');
 if(custom){
  const start=performance.now();let before,inspection,after;
  try{
   before=JSON.parse(custom.dataset.mapInspection||'null');
   if(!before)throw new Error('Custom map inspection is missing');
   const detail={request:{...request,names:[...request.names]}},EventClass=doc.defaultView?.CustomEvent||globalThis.CustomEvent;
   custom.dispatchEvent(new EventClass('tropnik-map-label-inspection',{detail}));
   if(typeof detail.response!=='string'||detail.response.length>1000000)throw new Error('Named label inspection is missing or oversized');
   inspection=JSON.parse(detail.response);after=JSON.parse(custom.dataset.mapInspection||'null');
   if(inspection?.error||!inspection?.labelInspection||!after)throw new Error(inspection?.error||'Named label inspection is incomplete');
  }catch(error){return{snapshot:null,durationMs:performance.now()-start,error:error.message};}
  const camera=value=>({longitude:value.camera.center[0],latitude:value.camera.center[1],zoom:value.camera.zoom,bearing:value.camera.bearingDegrees||0,pitch:value.pitch||0});
  const revision=value=>({drawRevision:value.drawRevision,labelRevision:value.labelRevision});
  const canvas=custom.querySelector('canvas.tropnik-map-canvas'),rect=canvas?.getBoundingClientRect(),beforeCamera=camera(before),afterCamera=camera(after),queriedCamera=camera(inspection);
  return{durationMs:performance.now()-start,snapshot:{schemaVersion:2,engine:'tropnik-canvas',readOnly:true,
   cameraPreserved:JSON.stringify(beforeCamera)===JSON.stringify(afterCamera)&&JSON.stringify(beforeCamera)===JSON.stringify(queriedCamera),
   before:beforeCamera,after:afterCamera,revisions:{before:revision(before),queried:revision(inspection),after:revision(after)},names:[...request.names],limit:request.limit,
   truncated:inspection.labelInspection.truncated,candidates:inspection.labels,
   customMap:{...inspection,readOnly:true,canvas:canvas&&rect?{connected:canvas.isConnected,width:canvas.width,height:canvas.height,cssWidth:rect.width,cssHeight:rect.height}:null}}};
 }
 return{snapshot:null,durationMs:0,error:'Custom map DOM container is missing'};
}

export function assertCoastLabelInspection(capture,frame,screenshot){
 assert.equal(capture?.fixture,frame.fixture);assert.equal(capture.targetZoom,frame.targetZoom);
 assert.equal(capture.afterScreenshot,true);assert.equal(capture.performanceScope,'after-modes-and-source-end-intervals');
 assert.equal(capture.screenshot,screenshot.file);assert.equal(capture.screenshotSha256,screenshot.sha256);
 assert.ok(Number.isFinite(capture.durationMs)&&capture.durationMs>=0);
 const snapshot=capture.snapshot;
 if(snapshot?.engine==='tropnik-canvas'){
  assert.equal(snapshot.schemaVersion,2);assert.equal(snapshot.error,undefined);assert.equal(snapshot.readOnly,true);assert.equal(snapshot.cameraPreserved,true);assert.equal(snapshot.truncated,false);
  assert.deepEqual(snapshot.names,COAST_LABEL_REQUEST.names);assert.equal(snapshot.limit,COAST_LABEL_REQUEST.limit);assert.deepEqual(snapshot.before,snapshot.after);
  for(const key of ['longitude','latitude'])assert.ok(Math.abs(snapshot.before[key]-frame.camera[key])<1e-7);
  assert.ok(Math.abs(snapshot.before.zoom-frame.zoom)<.001);
  const map=assertCustomMapInspection(snapshot.customMap,'coast labels',{mode:'detail'});
  assert.deepEqual(map.camera.center,[snapshot.before.longitude,snapshot.before.latitude]);assert.equal(map.camera.zoom,snapshot.before.zoom);
  assert.equal(map.camera.bearingDegrees||0,snapshot.before.bearing);assert.equal(map.pitch||0,snapshot.before.pitch);
  assert.deepEqual(snapshot.revisions?.before,snapshot.revisions?.after);assert.deepEqual(snapshot.revisions?.before,snapshot.revisions?.queried);
  assert.deepEqual(snapshot.revisions?.queried,{drawRevision:map.drawRevision,labelRevision:map.labelRevision});
  for(const key of ['drawRevision','labelRevision'])assert.ok(Number.isInteger(map[key])&&map[key]>0,'A label inspection must refer to an actual unchanged frame');
  const query=map.labelInspection;
  assert.equal(query?.schemaVersion,1);assert.deepEqual(query.names,COAST_LABEL_REQUEST.names);assert.equal(query.limit,COAST_LABEL_REQUEST.limit);assert.equal(query.truncated,false);
  assert.ok(Number.isInteger(query.totalCandidates)&&query.totalCandidates>=0&&query.totalCandidates<=6400);
  assert.equal(query.retainedCandidates,query.totalCandidates,'The last-frame decisions were not completely retained');
  assert.equal(query.matchingCandidates,snapshot.candidates?.length,'The named query dropped matching decisions');
  assert.ok(Array.isArray(snapshot.candidates)&&snapshot.candidates.length<=snapshot.limit);
  assert.deepEqual(snapshot.candidates,map.labels.filter(label=>COAST_LABEL_REQUEST.names.includes(label.label)).slice(0,snapshot.limit),'Label candidates differ from the actual bitmap diagnostics');
  for(const label of snapshot.candidates){
   assert.ok(COAST_LABEL_REQUEST.names.includes(label.label));assert.ok(Array.isArray(label.coordinate)&&label.coordinate.length===2&&label.coordinate.every(Number.isFinite));
   assert.equal(typeof label.visible,'boolean');assert.ok(['drawn','outside-coverage','outside-viewport','collision','budget','duplicate'].includes(label.reason));
   if(label.visible){
    assert.equal(label.reason,'drawn');assert.ok(label.rect&&['left','right','top','bottom'].every(key=>Number.isFinite(label.rect[key])));
    assert.ok(label.rect.left>=0&&label.rect.right<=map.canvas.cssWidth&&label.rect.top>=0&&label.rect.bottom<=map.canvas.cssHeight,'A visible label was clipped by the viewport');
    assert.ok(label.rect.right-label.rect.left>=label.width,'A visible label lost part of its measured text');
   }
   if(label.reason==='outside-coverage')assert.equal(label.visible,false,'A foreign geographic anchor became a visible label');
  }
  return capture;
 }
 assert.fail('Missing actual custom label inspection');
}

export async function captureCoastLabels(cdp,evaluate,frame,screenshot){
 const inspected=await evaluate(cdp,`(${requestLabelInspection.toString()})(${JSON.stringify(COAST_LABEL_REQUEST)})`);
 const capture={fixture:frame.fixture,targetZoom:frame.targetZoom,afterScreenshot:true,performanceScope:'after-modes-and-source-end-intervals',screenshot:screenshot.file,screenshotSha256:screenshot.sha256,...inspected};
 assertCoastLabelInspection(capture,frame,screenshot);return capture;
}
