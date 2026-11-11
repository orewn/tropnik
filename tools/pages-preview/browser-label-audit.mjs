import assert from 'node:assert/strict';

export const COAST_LABEL_REQUEST=Object.freeze({schemaVersion:1,
 layerIds:['city-label','town-label','village-label','russia-priority-city-label'],
 names:['Приморск','Малые Сопки','Карасёвка','Карасевка','Выборг'],limit:100});

/** A synchronous request through the application's read-only DOM diagnostic.
 * No React/SDK object discovery, network request, synthetic map input or cache
 * warmup. Called only after the existing accepted intervals and saved PNG. */
export function requestLabelInspection(request,doc=globalThis.document){
 const container=doc.querySelector('.atlas-canvas[data-map-engine="maplibre"]');
 if(!container)return{snapshot:null,durationMs:0,error:'MapLibre DOM container is missing'};
 const detail={request},start=performance.now();
 container.dispatchEvent(new CustomEvent('tropnik:inspect-map-labels',{detail}));
 return{snapshot:detail.result??null,durationMs:performance.now()-start};
}

export function assertCoastLabelInspection(capture,frame,screenshot){
 assert.equal(capture?.fixture,frame.fixture);assert.equal(capture.targetZoom,frame.targetZoom);
 assert.equal(capture.afterScreenshot,true);assert.equal(capture.performanceScope,'after-modes-and-source-end-intervals');
 assert.equal(capture.screenshot,screenshot.file);assert.equal(capture.screenshotSha256,screenshot.sha256);
 assert.ok(Number.isFinite(capture.durationMs)&&capture.durationMs>=0);
 const snapshot=capture.snapshot;assert.equal(snapshot?.schemaVersion,1,'Missing actual label-source inspection');
 assert.equal(snapshot.error,undefined);assert.equal(snapshot.readOnly,true);assert.equal(snapshot.cameraPreserved,true);
 assert.equal(snapshot.idScope,'not-established');assert.equal(snapshot.tileMetadata,'observed-optional');
 assert.equal(snapshot.limit,COAST_LABEL_REQUEST.limit);
 assert.deepEqual(snapshot.names,COAST_LABEL_REQUEST.names);assert.deepEqual(snapshot.layerIds,COAST_LABEL_REQUEST.layerIds);
 assert.deepEqual(snapshot.before,snapshot.after,'Inspection moved the map');
 for(const key of ['longitude','latitude','zoom','bearing','pitch'])assert.ok(Number.isFinite(snapshot.before[key]));
 assert.ok(Math.abs(snapshot.before.zoom-frame.zoom)<.001,'Inspection belongs to a different map frame');
 for(const key of ['longitude','latitude'])assert.ok(Number.isFinite(frame.camera?.[key])&&Math.abs(snapshot.before[key]-frame.camera[key])<1e-7,'Inspection belongs to a different map center');
 assert.equal(snapshot.layers.length,COAST_LABEL_REQUEST.layerIds.length);
 for(const layer of snapshot.layers){assert.ok(COAST_LABEL_REQUEST.layerIds.includes(layer.id));assert.equal(layer.origin?.source,'openmaptiles');assert.equal(layer.origin?.sourceLayer,'place');}
 assert.equal(snapshot.sources.length,1);assert.equal(snapshot.sources[0].source,'openmaptiles');assert.equal(snapshot.sources[0].sourceLayer,'place');
 assert.equal(snapshot.overlay.source,'tropnik-covered-labels');
 assert.deepEqual(snapshot.rendered.layerIds,COAST_LABEL_REQUEST.layerIds);
 for(const group of [...snapshot.sources,snapshot.overlay,snapshot.rendered]){
  assert.ok(Number.isInteger(group.total)&&group.total>=0);assert.ok(Number.isInteger(group.pointCount)&&group.pointCount>=0&&group.pointCount<=group.total);
  assert.equal(group.truncated,false,'The bounded label capture discarded source copies');
  assert.equal(group.features.length,group.pointCount);assert.ok(group.features.length<=snapshot.limit);
  for(const feature of group.features){
   assert.ok(Array.isArray(feature.coordinates)&&feature.coordinates.length===2&&feature.coordinates.every(Number.isFinite));
   assert.ok(Number.isFinite(feature.screen?.x)&&Number.isFinite(feature.screen?.y));
   assert.ok(feature.id===null||typeof feature.id==='string'||typeof feature.id==='number');
   assert.equal(feature.idTruncated,false,'A truncated ID cannot support source identity analysis');
   if(feature.observedTile){const {z,x,y}=feature.observedTile;assert.ok([z,x,y].every(Number.isInteger)&&z>=0&&z<=24&&x>=0&&y>=0&&x<2**z&&y<2**z);}
   const name=feature.properties?.['name:ru']??feature.properties?.name??feature.properties?.['name:latin'];
   assert.ok(COAST_LABEL_REQUEST.names.includes(name),'Unexpected name outside the bounded inspection');
  }
 }
 return capture;
}

export async function captureCoastLabels(cdp,evaluate,frame,screenshot){
 const inspected=await evaluate(cdp,`(${requestLabelInspection.toString()})(${JSON.stringify(COAST_LABEL_REQUEST)})`);
 const capture={fixture:frame.fixture,targetZoom:frame.targetZoom,afterScreenshot:true,performanceScope:'after-modes-and-source-end-intervals',screenshot:screenshot.file,screenshotSha256:screenshot.sha256,...inspected};
 assertCoastLabelInspection(capture,frame,screenshot);return capture;
}
