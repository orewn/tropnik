import assert from 'node:assert/strict';
import {projectMapPoint,unprojectMapPoint} from './map-projection.mjs';
import {assertSourceEndPanInput,sourceEndsAreFramed} from './browser-source-end-pan.mjs';
import {directionHitGrid} from './browser-direction-hitareas.mjs';
import {assertCoastAudit} from './browser-coast-audit.mjs';
import {assertSatelliteContinuityAudit,satellitePerformanceIssues} from './browser-satellite-audit.mjs';
import {assertOfflineSafetyAudit} from './browser-offline-safety.mjs';
import {assertRequestMapLayout} from './browser-request-layout.mjs';
import {assertCatalogueExpectations} from './catalogue-expectations.mjs';
import {assertSmoothnessAudit,performanceBudgetIssues} from './browser-smoothness.mjs';
import {assertCustomMapInspection,assertCustomDetailInspection} from './browser-custom-map.mjs';
import {assertProductMapMode,assertProductMapModeTransition} from './browser-map-modes.mjs';
import {assertBrowserEnvironment} from './browser-environment.mjs';
import {assertNativeSurfaceCoverage} from './browser-native-surface.mjs';
import {assertTerrainMaskReport} from './terrain-mask-report.mjs';
import {assertMapWheelAudit} from './browser-map-wheel.mjs';

const MOBILE_PROFILES=['compact-android','iphone-portrait','android-portrait','phone-landscape'];

export const CLOSE_TRAIL_FIXTURE=Object.freeze({
 region:'krasnodar',routeId:'osm-relation-2244794',geometryURL:'/data/imported/osm-relation-2244794.geojson',
 endpoints:[[40.6882934,45.5459288],[40.6891574,45.5427913]],
});

/** Chromium may deliver later pointer pairs before the earlier click events.
 * Correlate each ordinal click with its completed pair, not with the adjacent
 * delivery. Blink derives click from the source up event (including its
 * timestamp); that timestamp can be equal/rounded and is not a unique ID. */
export function assertNativeBurstEventOrder(events,input,count=4){
 assert.ok(input==='touch'||input==='mouse');
 assert.ok(Number.isInteger(count)&&count>0&&count<=4);
 assert.ok(Array.isArray(events));assert.equal(events.length,count*3,'Native burst events are missing or duplicated');
 const pointers=[],clicks=[];
 for(const [index,event] of events.entries()){
  assert.ok(['pointerdown','pointerup','click'].includes(event.type),'Unexpected native burst event');
  assert.equal(event.trusted,true,'Native burst contains an untrusted event');
  assert.ok(Number.isFinite(event.time)&&Number.isFinite(event.timestamp)&&event.timestamp>=0);
  assert.equal(event.pointerType,input);assert.ok(Number.isInteger(event.pointerId)&&event.pointerId>=0,'Missing native pointer ID');
  if(index)assert.ok(event.time>=events[index-1].time,'Native event delivery time moved backwards');
  (event.type==='click'?clicks:pointers).push({...event,index});
 }
 assert.deepEqual(pointers.map(event=>event.type),Array.from({length:count},()=>['pointerdown','pointerup']).flat(),'Native pointer pairs are missing, orphaned or reordered');
 assert.equal(clicks.length,count,'Native burst clicks are missing or duplicated');
 for(let index=0;index<count;index++){
  const down=pointers[index*2],up=pointers[index*2+1],click=clicks[index];
  assert.ok(down.index<up.index&&up.index<click.index,'Native click arrived before its own pointer pair completed');
  assert.equal(up.pointerId,down.pointerId,'Native pointer pair has mismatched IDs');
  assert.equal(click.pointerId,up.pointerId,'Native click belongs to another pointer pair');
  assert.ok(down.timestamp<=up.timestamp,'Native pointer source timestamps are reversed');
  assert.equal(click.timestamp,up.timestamp,'Chromium click does not match its source pointer-up timestamp');
  if(index){
   assert.ok(down.timestamp>=pointers[index*2-1].timestamp,'Native pointer pairs have reversed source timestamps');
   assert.ok(click.timestamp>=clicks[index-1].timestamp,'Native clicks have reversed source timestamps');
  }
 }
 return true;
}

function assertSheetDrag(drag,name){
 assert.equal(drag?.passed,true,`${name}: the sheet drag did not pass`);
 assert.equal(drag.input,'touch',`${name}: the sheet was not dragged by touch input`);
 assert.equal(drag.draggingCleared,true,`${name}: pointer capture/drag state was not released`);
 assert.ok(Number.isFinite(drag.maxTrackingErrorPx)&&drag.maxTrackingErrorPx<=3,`${name}: the sheet did not follow the finger`);
 assert.ok(Number.isFinite(drag.pageScrollDeltaPx)&&drag.pageScrollDeltaPx<=1,`${name}: the handle scrolled the page`);
 assert.ok(Number.isFinite(drag.heightDelta)&&drag.heightDelta<1.1,`${name}: dragging resized the sheet layout`);
 assert.ok(Array.isArray(drag.samples)&&drag.samples.length>=2,`${name}: mid-gesture measurements are missing`);
 for(const sample of drag.samples){
  assert.ok([sample.fingerY,sample.panelTop,sample.expectedTop,sample.trackingErrorPx,sample.pageScrollDeltaPx].every(Number.isFinite),`${name}: non-finite drag sample`);
  assert.ok(sample.trackingErrorPx<=3&&Math.abs(sample.panelTop-sample.expectedTop)<=3,`${name}: the displayed panel lagged behind the pointer`);
  assert.ok(sample.pageScrollDeltaPx<=1,`${name}: a mid-gesture page scroll was hidden by the final position`);
 }
}

function assertSheetGestures(gestures,name){
 assert.equal(gestures?.passed,true,`${name}: missing real sheet gesture evidence`);
 assert.equal(gestures.input,'touch');
 assert.ok(Number.isFinite(gestures.maxTrackingErrorPx)&&gestures.maxTrackingErrorPx<=3);
 assert.ok(Number.isFinite(gestures.maxPageScrollDeltaPx)&&gestures.maxPageScrollDeltaPx<=1);
 const expected=[['open','closed','open'],['close','open','closed'],['open-again','closed','open'],['close-again','open','closed']];
 assert.equal(gestures.drags?.length,expected.length,`${name}: repeated sheet drags were not tested`);
 expected.forEach(([label,from,to],index)=>{
  const drag=gestures.drags[index];assertSheetDrag(drag,`${name}/${label}`);
  assert.equal(drag.name,label);assert.equal(drag.from,from);assert.equal(drag.to,to);
  assert.ok(Math.abs(drag.samples.at(-1).panelTop-drag.samples[0].panelTop)>=40,`${name}: the handle never travelled far enough`);
 });
 assertSheetDrag(gestures.reversal,`${name}/reverse`);
 assert.equal(gestures.reversal.from,'closed');assert.equal(gestures.reversal.to,'closed');
 const reversalSamples=gestures.reversal.samples;
 assert.ok(reversalSamples.some((sample,index)=>index&&sample.panelTop<reversalSamples[index-1].panelTop-10)&&reversalSamples.some((sample,index)=>index&&sample.panelTop>reversalSamples[index-1].panelTop+10),`${name}: input did not reverse during the drag`);
 assertSheetDrag(gestures.cancelled,`${name}/cancel`);
 assert.equal(gestures.cancelled.cancelled,true);assert.equal(gestures.cancelled.from,'closed');assert.equal(gestures.cancelled.to,'closed');
 const scroll=gestures.scroll;
 assert.equal(scroll?.passed,true,`${name}: native catalogue scrolling was not tested`);
 assert.equal(scroll.input,'touch');
 assert.ok(Number.isFinite(scroll.deltaPx)&&scroll.deltaPx>=24,`${name}: swiping the list did not scroll it`);
 assert.ok(Number.isFinite(scroll.pageScrollDeltaPx)&&scroll.pageScrollDeltaPx<=1,`${name}: the list scrolled the page`);
 assert.ok(Number.isFinite(scroll.sheetDisplacementPx)&&scroll.sheetDisplacementPx<=1,`${name}: the list swipe moved the handle`);
 for(const flag of ['tapAfterCancel','tapAfterDrag','listPositionRetained','selectionPreserved'])assert.equal(gestures[flag],true,`${name}: missing ${flag}`);
 assert.equal(scroll.selectionPreserved,true);assert.equal(gestures.finalState,'closed');
}

/** Inspect the painted DOM footprints, independently of the application's
 * density thresholds. Hidden markers still retain their real source ends. */
export function assertRouteEdgeFrame(frame,context,{requireBothVisible=false,requireFullCaptions=false}={}){
 assert.ok(Number.isFinite(frame.zoom)&&Math.abs(frame.camera?.zoom-frame.zoom)<.01,`${context}: the camera scale differs from the source-end frame`);
 assert.equal(frame.routeId,CLOSE_TRAIL_FIXTURE.routeId,`${context}: the source route was lost`);
 assert.equal(frame.region,CLOSE_TRAIL_FIXTURE.region);assert.equal(frame.queryRoute,CLOSE_TRAIL_FIXTURE.routeId);
 assert.equal(frame.selectedRoute,'selected');assert.equal(frame.imagery,'');assert.equal(frame.sceneVisible,false);
 assert.ok(Number.isFinite(frame.scrollY)&&Math.abs(frame.scrollY)<=1,`${context}: zooming the source ends scrolled the page`);
 assert.equal(frame.markers?.length,2,`${context}: expected two semantic source ends, without SDK wrappers`);
 const rect=value=>{
  assert.ok(value&&['left','right','top','bottom','width','height'].every(key=>Number.isFinite(value[key])),`${context}: missing rendered rectangle`);
  assert.ok(value.width>=0&&value.height>=0&&Math.abs(value.right-value.left-value.width)<.01&&Math.abs(value.bottom-value.top-value.height)<.01);
 };
 rect(frame.available);rect(frame.mapRect);
 assert.ok(frame.available.width>0&&frame.available.height>0);
 const clipped=value=>({left:Math.max(value.left,frame.available.left),right:Math.min(value.right,frame.available.right),top:Math.max(value.top,frame.available.top),bottom:Math.min(value.bottom,frame.available.bottom)});
 const parts=[];
 for(const [index,letter] of ['А','Б'].entries()){
  const marker=frame.markers.find(item=>item.ariaLabel===`Край ${letter} исходной линии`);
  assert.ok(marker,`${context}: source end ${letter} has no semantic annotation`);
  assert.equal(marker.role,'img');assert.equal(marker.pointerEvents,'none',`${context}: a source end intercepts map input`);rect(marker.rect);
  const projected=projectMapPoint(CLOSE_TRAIL_FIXTURE.endpoints[index],frame.camera,frame.mapRect);
  assert.ok(Math.hypot(marker.rect.left+marker.rect.width/2-projected.x,marker.rect.top+marker.rect.height/2-projected.y)<=2,`${context}: source end ${letter} moved away from its original coordinates`);
  assert.equal(marker.badge?.text,letter);assert.equal(marker.caption?.text,`Точка ${letter}`);
  for(const [kind,part] of [['badge',marker.badge],['caption',marker.caption]]){
   rect(part.rect);assert.equal(typeof part.visible,'boolean');assert.equal(part.pointerEvents,'none',`${context}: ${letter} ${kind} intercepts map input`);
   if(part.visible){
    assert.ok(part.rect.width>1&&part.rect.height>1,`${context}: a visible annotation has no painted area`);
    const area=clipped(part.rect);if(area.right>area.left&&area.bottom>area.top)parts.push({letter,kind,rect:area});
   }
  }
  if(requireBothVisible||requireFullCaptions){
   const badge=marker.badge;
   assert.equal(badge.visible,true,`${context}: separated source end ${letter} did not reappear`);
   assert.ok(badge.rect.left>=frame.available.left-1&&badge.rect.right<=frame.available.right+1&&badge.rect.top>=frame.available.top-1&&badge.rect.bottom<=frame.available.bottom+1,`${context}: separated source end ${letter} is clipped`);
  }
 }
 for(let first=0;first<parts.length;first++)for(let second=first+1;second<parts.length;second++){
  const a=parts[first],b=parts[second];if(a.letter===b.letter)continue;
  const width=Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left),height=Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top);
  assert.ok(width<=1||height<=1,`${context}: visible ${a.letter} ${a.kind} overlaps ${b.letter} ${b.kind} (${width}×${height}px)`);
 }
 if(requireFullCaptions){
  assert.ok(Array.isArray(frame.overlays),`${context}: map overlay footprints are missing`);
  for(const overlay of frame.overlays)rect(overlay.rect);
  assert.equal(sourceEndsAreFramed(frame),true,`${context}: both full source-end annotations must fit without UI overlap`);
 }
 return true;
}

export function assertReliefPalette(frame,context,engine){
 assert.equal(engine,'tropnik-canvas');assert.equal(frame?.engine,engine,`${context}: missing relief cartography evidence`);
 const map=assertCustomMapInspection(frame.bitmapInspection,context,{mode:'detail'});
 assert.equal(map.state.reliefReady,true);assert.ok(map.tiles.relief.length>0,`${context}: no real relief bitmap was committed`);
 return true;
}

export function assertCloseTrailAudit(audit,name,engine,mobile,screenshots){
 assert.equal(audit?.passed,true,`${name}: missing real single-line source-end coverage`);
 assert.equal(audit.input,mobile?'touch':'mouse');assert.equal(audit.routeId,CLOSE_TRAIL_FIXTURE.routeId);assert.equal(audit.region,CLOSE_TRAIL_FIXTURE.region);
 assert.equal(audit.geometryURL,CLOSE_TRAIL_FIXTURE.geometryURL);assert.equal(audit.visualReviewRequired,true);
 assert.equal(audit.source?.featureCount,1);assert.equal(audit.source.partCount,1);assert.equal(audit.source.vertexCount,12);
 assert.deepEqual(audit.source.endpoints,CLOSE_TRAIL_FIXTURE.endpoints);assert.match(audit.source.sha256,/^[a-f0-9]{64}$/);
 assert.ok(Number.isFinite(audit.initialZoom)&&Math.abs(audit.initialZoom-14)<.01,`${name}: the short source route did not fit at zoom14`);
 assert.ok(Number.isInteger(audit.setupClicks)&&audit.setupClicks>=0&&audit.setupClicks<=3);
 assert.ok(Array.isArray(audit.inputs)&&audit.inputs.length>0&&audit.inputs.length+audit.setupClicks<=15,`${name}: the bounded source-end audit exceeded15 native clicks`);
 const step=1;let previous=audit.initialZoom;
 for(const input of audit.inputs){
  assert.ok(input.direction===1||input.direction===-1);assert.equal(input.input,audit.input);
  assert.ok(Number.isFinite(input.before)&&Number.isFinite(input.after));
  assert.ok(Math.abs(input.before-previous)<.01&&Math.abs(input.after-input.before-input.direction*step)<.01,`${name}: a source-end zoom input was lost or reordered`);
  assertNativeBurstEventOrder(input.events,audit.input,1);previous=input.after;
 }
 assert.equal(audit.nativeZoomClicks,audit.inputs.length);
 assert.equal(audit.frames?.length,3,`${name}: three source-end visual frames are required`);
 for(const [index,targetZoom] of [11,14,17].entries()){
  const frame=audit.frames[index];assert.equal(frame.targetZoom,targetZoom);
  assert.ok(Number.isFinite(frame.zoom)&&Math.abs(frame.zoom-targetZoom)<.01);
  assert.ok(Number.isInteger(frame.inputCount)&&frame.inputCount>0&&frame.inputCount<=audit.inputs.length);
  assert.ok(Math.abs(audit.inputs[frame.inputCount-1].after-frame.zoom)<.01);
  if(index)assert.ok(frame.inputCount>audit.frames[index-1].inputCount);
  const direction=index===0?-1:1,from=index?audit.frames[index-1].inputCount:0;
  assert.ok(audit.inputs.slice(from,frame.inputCount).every(input=>input.direction===direction));
  assertRouteEdgeFrame(frame,`${name}/source-ends/${frame.zoom}`,{requireBothVisible:index===1,requireFullCaptions:index===2});
  assertReliefPalette(frame.reliefPalette,`${name}/source-ends/${frame.zoom}`,engine);
  const screenshot=screenshots.find(item=>item.file===frame.screenshot);
  assert.ok(screenshot&&screenshot.mode==='source-ends'&&Math.abs(screenshot.zoom-frame.zoom)<.01,`${name}: a source-end frame has no reviewable image`);
 }
 assert.equal(audit.frames.at(-1).inputCount,audit.inputs.length);
 assert.equal(new Set(audit.frames.map(frame=>frame.screenshot)).size,3);
 const framing=audit.closeFraming;
 assert.equal(framing?.passed,true,`${name}: missing native close-frame placement evidence`);
 assertRouteEdgeFrame(framing.before,`${name}/source-ends/before-framing`);
 assert.equal(framing.required,!sourceEndsAreFramed(framing.before));
 assert.ok(Array.isArray(framing.gestures)&&framing.gestures.length<=2);
 assert.ok(framing.required?framing.gestures.length>=1:framing.gestures.length===0);
 let previousFrame=framing.before;
 for(const pan of framing.gestures){
  assertSourceEndPanInput(pan,audit.input,`${name}/source-ends/pan`);
  assert.equal(pan.canvasPathVerified,true);
  assertRouteEdgeFrame(pan.before,`${name}/source-ends/pan-before`);assertRouteEdgeFrame(pan.after,`${name}/source-ends/pan-after`);
  assert.equal(sourceEndsAreFramed(pan.before),false,`${name}: an extra framing gesture was sent after both annotations already fitted`);
  assert.deepEqual(pan.before.camera,previousFrame.camera);
  assert.ok(Math.abs(pan.before.zoom-17)<.01&&Math.abs(pan.after.zoom-pan.before.zoom)<.01,`${name}: framing changed the zoom`);
  assert.ok(Math.abs(pan.after.camera.longitude-pan.before.camera.longitude)>1e-7||Math.abs(pan.after.camera.latitude-pan.before.camera.latitude)>1e-7,`${name}: native pan did not move the map`);
  previousFrame=pan.after;
 }
 assert.deepEqual(previousFrame.camera,audit.frames.at(-1).camera);
 return true;
}

function assertZoomDesign(design,name,engine,mobile){
 assert.equal(design?.geometryPassed,true,`${name}: missing zoom-level design geometry evidence`);
 assert.equal(design.schemaVersion,9,'The design report predates the two map modes');assert.equal(design.engine,engine);assert.equal(design.input,mobile?'touch':'mouse');
 assertCoastAudit(design.coast,name,engine);
 assertSatelliteContinuityAudit(design.satelliteContinuity,name,engine);
 assert.deepEqual(satellitePerformanceIssues(design.satelliteContinuity,{name,mobile}),[],`${name}: satellite rendering exceeded the unchanged performance budget`);
 assert.equal(design.visualReviewRequired,true,'DOM bounds must not be reported as human visual review');
 assert.equal(design.maximumZoom,18);assert.equal(design.routeId,'kavkaz-8a');
 assert.ok(Number.isFinite(design.minimumZoom)&&design.minimumZoom<4,`${name}: zoom coverage omitted the overview`);
 const steps=design.detailSteps;
 assert.ok(Array.isArray(steps)&&steps.length>=15,`${name}: the available zoom steps were not exercised`);
 assert.ok(Math.abs(steps[0].zoom-design.minimumZoom)<.01);
 assert.ok(Math.abs(steps.at(-1).zoom-18)<.01,`${name}: close zoom18 was not inspected`);
 for(let index=0;index<steps.length;index++){
  assert.ok(Number.isFinite(steps[index].zoom));
  assertProductMapMode(steps[index].modeState,'Рельеф',`${name}/detail/${steps[index].zoom}`,{routeId:design.routeId});
  if(engine==='tropnik-canvas'){
   const bitmap=assertCustomDetailInspection(steps[index].bitmapInspection,`${name}/detail/${steps[index].zoom}`,{routeId:design.routeId});
   assert.ok(Math.abs(bitmap.camera.zoom-steps[index].zoom)<.01,`${name}: bitmap inspection has a stale zoom`);
  }
  if(index){const increment=steps[index].zoom-steps[index-1].zoom;assert.ok(increment>0&&increment<=1.01,`${name}: zoom coverage skipped an available increment`);}
 }
 const bursts=design.zoomBurst,step=1;
 assert.equal(bursts?.passed,true,`${name}: rapid zoom input was not tested`);
 assert.equal(bursts.input,mobile?'touch':'mouse');assert.equal(bursts.returnedToStart,true);
 for(const [key,direction] of [['increase',1],['decrease',-1]]){
  const burst=bursts[key];assert.equal(burst?.passed,true);assert.equal(burst.input,mobile?'touch':'mouse');
  assert.equal(burst.count,4);assert.equal(burst.receivedClicks,4);assert.equal(burst.direction,direction);assert.equal(burst.step,step);
  assert.equal(burst.dispatchMode,'ordered-native');assert.equal(burst.eventOrderVerified,true);
  assertNativeBurstEventOrder(burst.events,burst.input,burst.count);
  const clicks=burst.events.filter(event=>event.type==='click');
  assert.ok(Math.abs(burst.eventSpanMs-(clicks.at(-1).time-clicks[0].time))<.01,`${name}: click-span receipt differs from actual DOM events`);
  const commandTypes=[...(mobile?[]:['mouseMoved']),...Array.from({length:4},()=>mobile?['touchStart','touchEnd']:['mousePressed','mouseReleased']).flat()];
  assert.deepEqual(burst.commands?.map(command=>command.type),commandTypes,`${name}: native input wire order was not recorded`);
  for(const [index,command] of burst.commands.entries()){
   assert.equal(command.index,index);assert.equal(command.status,'fulfilled');
   assert.equal(command.method,mobile?'Input.dispatchTouchEvent':'Input.dispatchMouseEvent');
   assert.ok([command.sentAtEpochMs,command.ackAtEpochMs,command.sentOffsetMs,command.ackOffsetMs,command.ackDurationMs].every(Number.isFinite));
   assert.ok(command.sentOffsetMs>=0&&command.ackOffsetMs>=command.sentOffsetMs&&command.ackDurationMs>=0);
   if(index)assert.ok(command.sentOffsetMs>=burst.commands[index-1].sentOffsetMs);
  }
  assert.ok([burst.producerDurationMs,burst.firstInputLagMs,burst.domTimeOrigin,burst.domSampleStartedAtMs].every(Number.isFinite));
  assert.ok(Array.isArray(burst.recentLongTasks)&&burst.recentLongTasks.length<=32);
  assert.ok([burst.beforeZoom,burst.afterZoom,burst.expectedZoom,burst.eventSpanMs,burst.durationMs].every(Number.isFinite));
  assert.ok(burst.eventSpanMs>=0&&burst.eventSpanMs<200,`${name}: zoom presses were slower than one animation`);
  const expected=Math.min(18,Math.max(design.minimumZoom,burst.beforeZoom+direction*step*4));
  assert.ok(Math.abs(burst.expectedZoom-expected)<.01&&Math.abs(burst.afterZoom-expected)<.01,`${name}: a rapid zoom input was lost`);
  assert.ok(burst.pageScrollDeltaPx<=1);assert.equal(burst.selectionPreserved,true);
 }
 assert.ok(bursts.increase.beforeZoom>=9.5&&bursts.increase.beforeZoom<=11,`${name}: clamping hid a lost zoom input`);
 assert.ok(Math.abs(bursts.decrease.beforeZoom-bursts.increase.afterZoom)<.01&&Math.abs(bursts.decrease.afterZoom-bursts.increase.beforeZoom)<.01);
 assert.equal(design.modes?.detail?.state,'checked');
 assert.deepEqual(Object.keys(design.modes).sort(),['detail','relief','satellite'],`${name}: the report includes a removed product mode`);
 const relief=design.modes.relief,keys=[2,5,8,11,14,18];
 assert.equal(relief?.state,'active',`${name}: Relief was not exercised`);
 assert.equal(relief.selectedControl,true);assert.equal(relief.visualReviewRequired,true);
 assert.equal(relief.keySteps?.length,keys.length,`${name}: Relief key scales are incomplete`);
 for(const [index,key] of keys.entries()){
  const sample=relief.keySteps[index],minimum=Math.max(key,design.minimumZoom);
  assert.equal(sample.targetZoom,key);assert.equal(sample.mode,'relief');
  assert.ok(Number.isFinite(sample.zoom)&&sample.zoom>=minimum-.01&&sample.zoom<minimum+step+.01,`${name}: Relief scale ${key} was skipped`);
  assertProductMapMode(sample.modeState,'Рельеф',`${name}/relief/${key}`,{routeId:design.routeId});
  if(engine==='tropnik-canvas')assertCustomDetailInspection(sample.bitmapInspection,`${name}/relief/${key}`,{routeId:design.routeId});
 }
 assert.ok(Array.isArray(relief.sourceEvidence?.geoJSON),`${name}: Relief source availability was not recorded`);
 for(const source of relief.sourceEvidence.geoJSON){assert.match(source.path,/\/data\/[^/]+\.geojson$/);assert.ok(Number.isFinite(source.status));assert.equal(typeof source.finished,'boolean');}
 for(const field of ['finishedReliefImageResponses','failedResponses','loadedReliefTiles'])assert.ok(Number.isInteger(relief.sourceEvidence[field])&&relief.sourceEvidence[field]>=0);
 assert.equal(design.modes.satellite.state,'active',`${name}: Satellite did not load actual imagery`);
 assert.deepEqual(design.modeSwitches?.map(value=>value.label),['Спутник','Рельеф'],`${name}: both real mode transitions are required`);
 for(const transition of design.modeSwitches){
  assert.equal(transition.input,mobile?'touch':'mouse');assert.equal(transition.selector,`.map-style-switch button[aria-label="${transition.label}"]`);assert.equal(transition.point?.unobscured,true);
  assertNativeBurstEventOrder(transition.events,transition.input,1);assertProductMapModeTransition(transition,`${name}/${transition.label}`,{routeId:design.routeId});
 }
 assert.ok(Array.isArray(design.screenshots)&&design.screenshots.filter(item=>item.mode==='detail').length>=6,`${name}: key-scale review images are missing`);
 assert.ok(design.screenshots.filter(item=>item.mode==='relief').length>=6,`${name}: Relief review images are missing`);
 for(const screenshot of design.screenshots){assert.match(screenshot.file,/^[a-z0-9_.-]+\.png$/);assert.match(screenshot.sha256,/^[a-f0-9]{64}$/);assert.ok(screenshot.bytes>1000);}
 assertCloseTrailAudit(design.closeTrail,name,engine,mobile,design.screenshots);
 const intervals=design.performanceIntervals;
 assert.deepEqual(Object.keys(intervals||{}).sort(),['modes','satellite','sourceEnds']);
 assert.deepEqual(intervals.satellite,design.satelliteContinuity.performance);assert.deepEqual(intervals.sourceEnds,design.closeTrail.performance);
 for(const key of ['layoutShift','longestTaskMs']){
  assert.ok(Object.values(intervals).every(value=>Number.isFinite(value[key])));
  assert.equal(design.performance?.[key],Math.max(...Object.values(intervals).map(value=>value[key])),`${name}: a prior performance interval was lost`);
 }
 for(const [phase,value]of Object.entries(intervals))assert.deepEqual(performanceBudgetIssues(value,{name,mobile},`zoom-${phase}`),[],`${name}: ${phase} exceeded the unchanged performance budget`);
}

/** Validate actual painted hit samples rather than trusting an overall pass
 * flag. Hidden labels are not targets; hidden SDK wrappers must not capture. */
export function assertDirectionHitGrid(grid, context, engine) {
 const rect=(value,name)=>{
  assert.ok(value&&['left','right','top','bottom'].every(key=>Number.isFinite(value[key])),`${context}: missing ${name} rectangle`);
  assert.ok(value.right>=value.left&&value.bottom>=value.top,`${context}: invalid ${name} rectangle`);
  if(value.width!==undefined)assert.ok(Number.isFinite(value.width)&&Math.abs(value.right-value.left-value.width)<.01);
  if(value.height!==undefined)assert.ok(Number.isFinite(value.height)&&Math.abs(value.bottom-value.top-value.height)<.01);
 };
 assert.equal(grid?.schemaVersion,1,`${context}: missing direction hit-area grid`);
 assert.equal(grid.engine,engine);
 assert.ok(typeof grid.anchorId==='string'&&grid.anchorId&&typeof grid.regionId==='string'&&grid.regionId);
 const members=typeof grid.groupKey==='string'?grid.groupKey.split('|'):[];
 assert.ok(members.includes(grid.anchorId)&&members.includes(grid.regionId),`${context}: grid targets another direction`);
 assert.equal(grid.cluster,members.length>1);
 rect(grid.anchorRect,'anchor');rect(grid.available,'viewport');
 assert.ok(grid.anchorRect.width>=43.5&&grid.anchorRect.height>=43.5,`${context}: direction anchor is smaller than44px`);
 const inside=point=>point.x>=grid.available.left&&point.x<grid.available.right&&point.y>=grid.available.top&&point.y<grid.available.bottom;
 const sampleGrid=(samples,expected,validate)=>{
  assert.equal(samples?.length,expected.length,`${context}: incomplete inner-corner/edge grid`);
  expected.forEach((point,index)=>{
   const sample=samples[index];assert.equal(sample.name,point.name);
   assert.ok(Number.isFinite(sample.x)&&Number.isFinite(sample.y)&&Math.abs(sample.x-point.x)<.01&&Math.abs(sample.y-point.y)<.01,`${context}: hit sample differs from the painted rectangle`);
   assert.equal(sample.outsideAnchor,point.outsideAnchor);
   assert.equal(sample.withinViewport,inside(point));
   if(sample.withinViewport)validate(sample);
  });
 };
 assert.deepEqual(grid.surfaces?.map(surface=>surface.kind),['label','count']);
 for(const surface of grid.surfaces){
  assert.equal(surface.present,true,`${context}: direction ${surface.kind} is absent`);
  assert.equal(typeof surface.visible,'boolean');
  if(!surface.visible){assert.deepEqual(surface.samples,[]);continue;}
  rect(surface.rect,surface.kind);assert.ok(surface.rect.width>1&&surface.rect.height>1);
  assert.ok(surface.text?.trim());assert.equal(surface.pointerEvents,'auto',`${context}: visible ${surface.kind} passes clicks through`);
  sampleGrid(surface.samples,directionHitGrid(surface.rect,grid.anchorRect,surface.kind==='count'?4:8),sample=>{
   assert.equal(sample.owned,true,`${context}: ${surface.kind}/${sample.name} is intercepted by ${sample.hitTag||'nothing'}`);
   assert.equal(sample.hitRegionId,grid.anchorId,`${context}: ${surface.kind}/${sample.name} hits another region`);
   assert.equal(sample.hitHidden,false,`${context}: ${surface.kind}/${sample.name} hits a hidden control`);
  });
 }
 assert.ok(Array.isArray(grid.hiddenControls),`${context}: hidden controls were not inspected`);
 for(const hidden of grid.hiddenControls){
  assert.ok(hidden.regionId&&hidden.regionId!==grid.anchorId);assert.equal(hidden.hidden,true);assert.equal(hidden.display,'none');rect(hidden.rect,'hidden control');
  assert.ok(hidden.rect.width===0&&hidden.rect.height===0,`${context}: hidden direction still has a hit box`);
  assert.equal(hidden.wrapper,null);
 }
 return grid;
}

function assertDirectionAction(action,context,engine,input){
  const grid=assertDirectionHitGrid(action.grid,context,engine);
  assert.ok(['label','count'].includes(action.kind));assert.equal(action.input,input);
  const surface=grid.surfaces.find(item=>item.kind===action.kind);
  assert.equal(surface.visible,true,`${context}: clicked surface was hidden`);
  const sample=surface.samples.find(item=>item.name===action.point?.name);
  assert.ok(sample?.withinViewport&&sample.outsideAnchor&&sample.owned,`${context}: native input missed the external painted area`);
  assert.ok(Math.abs(sample.x-action.point.x)<.01&&Math.abs(sample.y-action.point.y)<.01);
  assert.equal(action.point.kind,action.kind);assert.equal(action.point.anchorId,grid.anchorId);assert.equal(action.point.groupKey,grid.groupKey);
  assertNativeBurstEventOrder(action.events,input,1);
  for(const event of action.events){
   assert.ok(Number.isFinite(event.x)&&Number.isFinite(event.y)&&Math.abs(event.x-action.point.x)<=1&&Math.abs(event.y-action.point.y)<=1,`${context}: native event was delivered somewhere else`);
   assert.equal(event.button?.regionId,grid.anchorId,`${context}: native event reached another region`);
   assert.equal(event.button?.groupKey,grid.groupKey,`${context}: native input used a stale group`);
  }
  assert.ok(action.before&&action.after&&Number.isFinite(action.before.zoom)&&Number.isFinite(action.after.zoom));
  assert.equal(typeof action.before.region,'string');assert.equal(typeof action.after.region,'string');
  assert.equal(action.before.route,'');assert.equal(action.after.route,'');
  if(grid.cluster){
   assert.equal(action.after.region,action.before.region);
   assert.ok(action.after.zoom>=action.before.zoom+.7,`${context}: external cluster input did not expand directions`);
  }else{
   assert.notEqual(action.before.region,grid.regionId,`${context}: clicking an already selected direction proves no change`);
   assert.equal(action.after.region,grid.regionId,`${context}: external input did not select its direction`);
  }
  return grid;
}

export function assertDirectionHitAreas(receipt,name,engine,mobile){
 const input=mobile?'touch':'mouse';
 assert.equal(receipt?.schemaVersion,1,`${name}: missing external direction hit-area evidence`);
 assert.equal(receipt.passed,true);assert.equal(receipt.engine,engine);assert.equal(receipt.input,input);
 assert.ok(Array.isArray(receipt.actions)&&receipt.actions.length>=2&&receipt.actions.length<=14,`${name}: bounded direction input evidence is missing`);
 let ordinaryLabel=false,count=false,hiddenControls=0;
 for(const [index,action] of receipt.actions.entries()){
  const grid=assertDirectionAction(action,`${name}/directions/${index}`,engine,input);
  if(!grid.cluster&&action.kind==='label')ordinaryLabel=true;
  if(action.kind==='count')count=true;
  hiddenControls+=grid.hiddenControls.length;
 }
 assert.equal(ordinaryLabel,true,`${name}: no ordinary label was selected through its external edge`);
 assert.equal(count,true,`${name}: no external count/cluster input was verified`);
 assert.ok(hiddenControls>0,`${name}: no inactive directions were inspected`);
 return receipt;
}

const experienceInside=(rect,bounds)=>rect.left>=bounds.left-1&&rect.right<=bounds.right+1&&rect.top>=bounds.top-1&&rect.bottom<=bounds.bottom+1;
function assertExperienceRect(rect,context){
 assert.ok(rect&&['left','right','top','bottom','width','height'].every(key=>Number.isFinite(rect[key])),`${context}: missing measured rectangle`);
 assert.ok(rect.width>0&&rect.height>0&&Math.abs(rect.right-rect.left-rect.width)<.01&&Math.abs(rect.bottom-rect.top-rect.height)<.01,`${context}: inconsistent measured rectangle`);
}
function assertExperienceClick(click,input,context,selector){
 assert.equal(click?.input,input,`${context}: wrong native input`);
 assert.ok(Number.isFinite(click.point?.x)&&Number.isFinite(click.point?.y),`${context}: missing click coordinates`);
 if(selector!==false){
  assert.equal(typeof click.selector,'string');assert.ok(click.selector.length>0);
  if(selector)assert.equal(click.selector,selector,`${context}: another control was clicked`);
  assert.equal(click.point.selector,click.selector);assert.equal(click.point.unobscured,true,`${context}: target was obscured`);
 }
 assertNativeBurstEventOrder(click.events,input,1);
 for(const event of click.events)assert.ok(Number.isFinite(event.x)&&Number.isFinite(event.y)&&Math.abs(event.x-click.point.x)<=1&&Math.abs(event.y-click.point.y)<=1,`${context}: delivered click differs from its target`);
}
function assertExperienceScroll(scroll,input,context,selector){
 assert.equal(scroll?.input,input);assert.equal(scroll.selector,selector);assert.ok(scroll.direction===1||scroll.direction===-1);
 assert.ok(Number.isFinite(scroll.distance)&&scroll.distance>=12&&scroll.distance<=240);
 assert.ok([scroll.start?.x,scroll.start?.y,scroll.end?.x,scroll.end?.y].every(Number.isFinite));
 assert.ok(Math.abs(scroll.start.x-scroll.end.x)<.01&&Math.abs(scroll.end.y-scroll.start.y+scroll.direction*scroll.distance)<.01,`${context}: scroll path differs from its distance`);
 for(const state of [scroll.before,scroll.after]){
  assertExperienceRect(state?.rect,context);
  assert.ok([state.scrollTop,state.scrollHeight,state.clientHeight,state.scrollY].every(Number.isFinite));
  assert.ok(state.clientHeight>0&&state.scrollHeight>=state.clientHeight&&state.scrollTop>=-1&&state.scrollTop<=state.scrollHeight-state.clientHeight+1);
  assert.ok(['closed','open'].includes(state.sheet));
 }
 assert.ok(scroll.direction*(scroll.after.scrollTop-scroll.before.scrollTop)>1,`${context}: native scrolling made no progress`);
 assert.ok(Math.abs(scroll.after.scrollY-scroll.before.scrollY)<=1,`${context}: scrolling moved the page`);
 assert.equal(scroll.after.sheet,scroll.before.sheet,`${context}: scrolling changed the sheet`);
 const types=input==='touch'?['touchStart',...Array(8).fill('touchMove'),'touchEnd']:['mouseWheel'];
 assert.deepEqual(scroll.commands?.map(command=>command.type),types,`${context}: native scroll commands are missing`);
 for(const command of scroll.commands){assert.equal(command.method,input==='touch'?'Input.dispatchTouchEvent':'Input.dispatchMouseEvent');assert.equal(command.status,'fulfilled');}
 assert.ok(Array.isArray(scroll.events)&&scroll.events.length>0&&scroll.events.length<=64,`${context}: delivered scroll events are missing`);
 for(const [index,event] of scroll.events.entries()){
  assert.equal(event.trusted,true);assert.ok([event.time,event.x,event.y].every(Number.isFinite));
  if(index)assert.ok(event.time>=scroll.events[index-1].time);
 }
 if(input==='touch'){
  assert.equal(scroll.events[0].type,'touchstart');assert.equal(scroll.events.at(-1).type,'touchend');
  assert.ok(scroll.events.length>=3&&scroll.events.slice(1,-1).every(event=>event.type==='touchmove'),`${context}: no delivered touch scroll`);
  assert.ok(Math.hypot(scroll.events.at(-1).x-scroll.end.x,scroll.events.at(-1).y-scroll.end.y)<=3);
 }else assert.deepEqual(scroll.events.map(event=>event.type),['wheel']);
 assert.ok(Math.hypot(scroll.events[0].x-scroll.start.x,scroll.events[0].y-scroll.start.y)<=3,`${context}: native scroll started elsewhere`);
}
function assertExperienceScrolls(scrolls,input,context,selector='.explore-panel-content'){
 assert.ok(Array.isArray(scrolls)&&scrolls.length<=12,`${context}: missing or unbounded native scroll history`);
 for(const [index,scroll] of scrolls.entries())assertExperienceScroll(scroll,input,`${context}/${index}`,selector);
}
function assertExperienceSelection(selection,context){
 assert.ok(selection&&['region','route','title'].every(key=>typeof selection[key]==='string'),`${context}: missing selection`);
 assert.ok(['closed','open'].includes(selection.sheet));
 assert.equal(selection.history?.explore,true);assert.equal(selection.history.level,selection.route?2:selection.region?1:0);
 assert.ok(Number.isInteger(selection.history.length)&&selection.history.length>0);assert.equal(typeof selection.history.pushed,'boolean');
}
function assertExperienceBack(back,expected,context,from){
 assert.equal(back?.method,'Page.navigateToHistoryEntry',`${context}: history was not restored by the browser`);
 for(const entry of [back.from,back.target])assert.ok(Number.isInteger(entry?.id)&&typeof entry.url==='string');
 assert.notEqual(back.from.id,back.target.id);assert.equal(back.url,back.target.url);
 const previous=new URL(back.from.url),target=new URL(back.target.url);
 assert.equal(target.origin,previous.origin);assert.equal(target.pathname,previous.pathname);
 for(const [key,param] of [['region','region'],['route','route']]){
  assert.equal(target.searchParams.get(param)||'',expected[key],`${context}: wrong history target ${key}`);
  if(from)assert.equal(previous.searchParams.get(param)||'',from[key],`${context}: wrong history source ${key}`);
 }
 assertExperienceSelection(back.after,context);
 for(const key of ['region','route','title'])assert.equal(back.after[key],expected[key],`${context}: browser history restored another selection`);
}

/** Recompute the menu geometry and reachability from every measured scroll
 * frame. An overall pass flag cannot substitute for native input evidence. */
export function assertLayerMenuAudit(receipt,name){
 assert.equal(receipt?.schemaVersion,2);assert.equal(receipt.passed,true);assert.equal(receipt.input,'touch');
 assert.deepEqual(receipt.states?.map(state=>state.sheet),['closed','open'],`${name}: both portrait sheet states need Layers coverage`);
 const controls=[['INPUT','Тропы и грунтовые дороги'],['INPUT','Рельеф и линии высот'],['INPUT','Границы территорий'],['A','Подробная офлайн-карта'],['A','Источники карты']];
 for(const state of receipt.states){
  const context=`${name}/layers/${state.sheet}`;
  assertExperienceClick(state.opened,'touch',`${context}/open`,'.layer-button');assertExperienceClick(state.closed,'touch',`${context}/close`,'.layer-button');
  assert.ok(Array.isArray(state.frames)&&state.frames.length>=1&&state.frames.length<=9);
  assert.ok(Array.isArray(state.scrolls)&&state.scrolls.length===state.frames.length-1&&state.scrolls.length<=8);
  const reached=new Set();
  for(const [index,frame] of state.frames.entries()){
   assert.equal(frame.sheet,state.sheet);
   for(const key of ['map','usable','menu','button'])assertExperienceRect(frame[key],`${context}/${key}`);
   assert.ok(experienceInside(frame.usable,frame.map)&&experienceInside(frame.menu,frame.usable)&&experienceInside(frame.button,frame.usable),`${context}: Layers menu or button extends outside the usable map`);
   assert.ok(frame.usable.left>=0&&frame.usable.top>=0);
   assert.ok([frame.scrollTop,frame.scrollHeight,frame.clientHeight,frame.scrollY].every(Number.isFinite));
   assert.ok(frame.clientHeight>0&&frame.scrollHeight>=frame.clientHeight&&frame.scrollTop>=-1&&frame.scrollTop<=frame.scrollHeight-frame.clientHeight+1);
   assert.deepEqual(frame.controls?.map(control=>[control.tag,control.label]),controls,`${context}: actionable Layers controls changed or are missing`);
   for(const [controlIndex,control] of frame.controls.entries()){
    assert.equal(control.index,controlIndex);assertExperienceRect(control.rect,`${context}/${control.label}`);
    assert.equal(control.inside,experienceInside(control.rect,frame.menu),`${context}: reported control containment differs from its bounds`);
    assert.equal(typeof control.unobscured,'boolean');
    assert.ok(Number.isFinite(control.point?.x)&&Number.isFinite(control.point?.y)&&Math.abs(control.point.x-control.rect.left-control.rect.width/2)<.01&&Math.abs(control.point.y-control.rect.top-control.rect.height/2)<.01);
    if(control.inside&&control.unobscured){assert.ok(experienceInside(control.rect,frame.usable));reached.add(control.index);}
   }
   for(const click of [state.opened,state.closed])assert.ok(Math.abs(click.point.x-frame.button.left-frame.button.width/2)<=1&&Math.abs(click.point.y-frame.button.top-frame.button.height/2)<=1,`${context}: Layers input did not reach its measured button`);
   if(index){
    const scroll=state.scrolls[index-1],before=state.frames[index-1];
    assertExperienceScroll(scroll,'touch',`${context}/scroll-${index}`,'.layer-menu');assert.equal(scroll.direction,1);
    assert.equal(scroll.before.sheet,state.sheet);assert.equal(scroll.after.sheet,state.sheet);
    assert.ok(Math.abs(scroll.before.scrollTop-before.scrollTop)<=1&&Math.abs(scroll.after.scrollTop-frame.scrollTop)<=1,`${context}: scroll receipt does not connect the measured frames`);
    assert.ok(Math.abs(frame.scrollY-before.scrollY)<=1);
    for(const key of ['menu','button','usable'])for(const field of ['left','right','top','bottom'])assert.ok(Math.abs(frame[key][field]-before[key][field])<=1,`${context}: native menu scrolling displaced the layout`);
   }
  }
  assert.equal(reached.size,controls.length,`${context}: an actionable Layers control never became fully visible and reachable`);
 }
 return receipt;
}

export function assertOverviewCounts(frame,context,expectedCatalogue){
 assert.equal(frame?.region,'');assert.ok(Number.isInteger(frame.total)&&frame.total>0);assert.equal(frame.mapTotal,frame.total,`${context}: country map and catalogue totals differ`);
 assert.ok(Array.isArray(frame.catalog)&&frame.catalog.length>0,`${context}: catalogue directions are missing`);
 assert.ok(Array.isArray(frame.markers)&&frame.markers.length>0,`${context}: visible direction controls are missing`);
 const catalog=new Map(),names=new Set();
 for(const item of frame.catalog){
  assert.ok(typeof item.id==='string'&&item.id.length>0&&!catalog.has(item.id),`${context}: missing or duplicate catalogue ID`);
  assert.ok(typeof item.name==='string'&&item.name.length>0&&!names.has(item.name));names.add(item.name);
  assert.ok(Number.isInteger(item.count)&&item.count>=0&&item.count<=frame.total);catalog.set(item.id,{name:item.name,count:item.count});
 }
 if(expectedCatalogue){
  assertCatalogueExpectations(expectedCatalogue);
  assert.equal(frame.total,expectedCatalogue.total,`${context}: the country total differs from the source catalogue`);
  const expected=new Map(expectedCatalogue.directions.map(({id,...value})=>[id,value]));
  const ordered=value=>[...value].sort(([a],[b])=>a.localeCompare(b));
  assert.deepEqual(ordered(catalog),ordered(expected),`${context}: direction counts differ from the source catalogue`);
 }
 const ids=new Set(),grouped=new Set();let positive=false;
 for(const marker of frame.markers){
  assert.ok(typeof marker.id==='string'&&marker.id.length>0&&!ids.has(marker.id));ids.add(marker.id);
  assert.ok(typeof marker.groupKey==='string'&&marker.groupKey.length>0,`${context}: direction membership is missing`);
  const members=marker.groupKey.split('|');
  assert.equal(new Set(members).size,members.length,`${context}: duplicate group member`);
  assert.deepEqual(members,[...members].sort((a,b)=>a.localeCompare(b)),`${context}: direction group key is not canonical`);
  assert.ok(members.includes(marker.id),`${context}: anchor is not a member of its group`);
  for(const id of members){assert.ok(catalog.has(id),`${context}: group has an unknown catalogue direction`);assert.ok(!grouped.has(id),`${context}: direction appears in multiple visible controls`);grouped.add(id);}
  assert.equal(marker.cluster,members.length>1);
  assert.ok(typeof marker.name==='string'&&marker.name.length>0&&typeof marker.ariaLabel==='string'&&marker.ariaLabel.length>0);
  if(marker.cluster){
   // A group badge counts directions, not routes. Hidden member controls keep
   // old labels/counts, so only the current visible group is evidence here.
   assert.equal(marker.count,members.length,`${context}: cluster badge differs from its direction membership`);
  }else{
   assert.equal(marker.name,catalog.get(marker.id).name,`${context}: flag name differs from its catalogue direction`);
   assert.equal(marker.count,catalog.get(marker.id).count,`${context}: a hidden filter changed a flag count`);
  }
  positive ||= members.some(id=>catalog.get(id).count>0);
 }
 assert.equal(positive,true,`${context}: no visible direction control represents a populated catalogue`);
 return [...catalog].sort(([a],[b])=>a.localeCompare(b));
}

function assertSavedDirectionReentry(actions,context,engine,input,count){
 assert.ok(Array.isArray(actions)&&actions.length>=1&&actions.length<=7,`${context}: bounded native direction reentry is missing`);
 for(const [index,action] of actions.entries()){
  const grid=assertDirectionAction(action,`${context}/${index}`,engine,input);
  assert.equal(action.kind,'count');assert.equal(grid.regionId,'altai');assert.equal(action.before.region,'');
  const last=index===actions.length-1;
  assert.equal(grid.cluster,!last,`${context}: reentry must finish with an ordinary Altai flag`);
  const members=grid.groupKey.split('|'),surface=grid.surfaces.find(item=>item.kind==='count');
  assert.equal(new Set(members).size,members.length);assert.ok(members.includes('altai'));
  assert.equal(surface.text.trim(),String(last?count:members.length),`${context}: displayed count does not match the native reentry target`);
  if(last){assert.equal(grid.anchorId,'altai');assert.equal(grid.groupKey,'altai');assert.equal(action.after.region,'altai');}
  if(index)assert.ok(Math.abs(action.before.zoom-actions[index-1].after.zoom)<.01,`${context}: reentry camera measurements are disconnected`);
 }
}
function assertRequestDialog(dialog,context,{open,title='',note='',date=''}={}){
 assert.equal(dialog?.open,open,`${context}: unexpected modal visibility`);assert.equal(dialog.error,false);assert.equal(dialog.success,false);
 assert.equal(dialog.submitted,0,`${context}: the ownership audit must not submit a request`);
 assert.equal(dialog.routeTitle,title,`${context}: the modal belongs to another route`);
 assert.equal(dialog.note,open?note:null,`${context}: another request's note survived`);assert.equal(dialog.date,open?date:null,`${context}: another request's date survived`);
 assert.equal(dialog.heading,open?'Какой поход планируете?':'');
}

export function assertExploreExperience(receipt,name,engine,mobile,expectedCatalogue){
 assertCatalogueExpectations(expectedCatalogue);
 const input=mobile?'touch':'mouse',context=`${name}/explore`;
 assert.equal(engine,'tropnik-canvas');assert.equal(receipt?.schemaVersion,1);assert.equal(receipt.passed,true);assert.equal(receipt.input,input);
 const filter=receipt.filterReset;assert.ok(filter,`${context}: filter-reset evidence is missing`);
 for(const state of [filter.baseline,filter.restored]){assert.equal(state?.pressed,'false');assert.ok(Number.isInteger(state.count)&&state.count>0);assert.equal(state.expanded,'false');assert.equal(state.empty,false);}
 assert.equal(filter.filtered?.pressed,'true');assert.equal(filter.filtered.count,0);assert.equal(filter.filtered.empty,true);
 assert.equal(filter.restored.count,filter.baseline.count);
 assertExperienceClick(filter.enabled,input,`${context}/saved`,'.filter-row button[aria-pressed]');
 assertExperienceClick(filter.parent,input,`${context}/filter-parent`,'.explore-panel .back-link');
 const before=assertOverviewCounts(filter.overviewBefore,`${context}/before-filter`,expectedCatalogue),after=assertOverviewCounts(filter.overviewAfter,`${context}/after-filter`,expectedCatalogue);
 assert.deepEqual(after,before,`${context}: a hidden filter changed overview catalogue counts`);assert.equal(filter.overviewAfter.total,filter.overviewBefore.total);
 const altai=new Map(before).get('altai');assert.equal(altai?.name,'Алтай');
 assert.equal(altai.count,expectedCatalogue.directions.find(item=>item.id==='altai')?.count);
 assert.equal(altai.count,filter.baseline.count,`${context}: restored Altai differs from the overview count`);
 assertSavedDirectionReentry(filter.reentryActions,`${context}/saved-reentry`,engine,input,altai.count);

 const request=receipt.requestOwnership;assert.ok(request&&typeof request.route?.id==='string'&&request.route.id&&typeof request.route.title==='string'&&request.route.title);
 if(!mobile)assertRequestMapLayout(request.mapLayout,`${context}/request-layout`);
 const action='.route-actions button.primary',close='[role="dialog"] button[aria-label="Закрыть"]';
 assertExperienceScrolls(request.scrolls,input,`${context}/request-scroll`);assertExperienceScrolls(request.returnScrolls,input,`${context}/request-return-scroll`);
 assertExperienceClick(request.opened,input,`${context}/request-open`,action);assertExperienceClick(request.closedSame,input,`${context}/request-close`,close);assertExperienceClick(request.reopened,input,`${context}/request-reopen`,action);
 assertRequestDialog(request.first,`${context}/request-first`,{open:true,title:request.route.title});
 assert.equal(request.edit?.method,'Input.insertText');assert.ok(typeof request.edit.note==='string'&&request.edit.note.length>0);
 assert.ok(Array.isArray(request.edit.events)&&request.edit.events.length>0&&request.edit.events.length<=16);
 for(const event of request.edit.events){assert.equal(event.trusted,true);assert.equal(event.tag,'TEXTAREA');assert.equal(typeof event.value,'string');}
 assert.equal(request.edit.events.at(-1).value,request.edit.note);
 for(const key of ['edited','same'])assertRequestDialog(request[key],`${context}/${key}`,{open:true,title:request.route.title,note:request.edit.note});
 assertExperienceBack(request.back,{region:'altai',route:'',title:'Алтай'},`${context}/request-history`,{region:'altai',route:request.route.id});
 assertRequestDialog(request.afterBack,`${context}/after-history`,{open:false});
 const next=request.next;assertExperienceSelection(next?.selection,`${context}/next-route`);
 assert.equal(next.selection.region,'altai');assert.ok(next.selection.route&&next.selection.title);assert.notEqual(next.selection.route,request.route.id);assert.notEqual(next.selection.title,request.route.title);
 assertRequestDialog(next.before,`${context}/before-next-request`,{open:false});
 assertRequestDialog(next.dialog,`${context}/next-request`,{open:true,title:next.selection.title});
 assertExperienceScrolls(next.scrolls,input,`${context}/next-route-scroll`);assertExperienceScrolls(next.actionScrolls,input,`${context}/next-action-scroll`);
 assertExperienceClick(next.selected,input,`${context}/next-route-select`);assert.match(next.selected.selector,/^\.trail-list \.trail-card:nth-child\([1-9]\d*\) \.trail-card-main$/);
 assertExperienceClick(next.opened,input,`${context}/next-request-open`,action);assertExperienceClick(next.closed,input,`${context}/next-request-close`,close);

 const sibling=receipt.siblingParent;assert.ok(sibling,`${context}: sibling-parent evidence is missing`);
 for(const [key,selection] of Object.entries({previous:sibling.previous,sibling:sibling.sibling,overview:sibling.overview}))assertExperienceSelection(selection,`${context}/${key}`);
 assert.equal(sibling.previous.region,'baikal');assert.equal(sibling.previous.route,'');
 assert.ok(sibling.sibling.region&&sibling.sibling.title);assert.notEqual(sibling.sibling.region,sibling.previous.region);assert.equal(sibling.sibling.route,'');
 assertExperienceClick(sibling.selected,input,`${context}/sibling-select`,false);assert.equal(sibling.selected.point.id,sibling.sibling.region);assert.equal(sibling.selected.point.title,sibling.sibling.title);
 assertExperienceClick(sibling.parent,input,`${context}/sibling-parent`,'.explore-panel .back-link');
 assert.equal(sibling.overview.region,'');assert.equal(sibling.overview.route,'');
 assertExperienceBack(sibling.back,sibling.sibling,`${context}/parent-history`,sibling.overview);
 return receipt;
}

function assertStyleCameraFrame(frame,routeId,context,engine){
 assert.equal(frame?.engine,engine);assert.equal(frame.route,routeId);assert.equal(frame.moving,false);assert.equal(frame.visible,true);
 assert.ok([frame.camera?.longitude,frame.camera?.latitude,frame.camera?.zoom].every(Number.isFinite));assert.equal(frame.camera.tileSize,256);
 if(engine==='tropnik-canvas'){assert.equal(frame.rendering?.painted,true);assert.equal(frame.rendering.drawnRoute,routeId);assert.equal(frame.rendering.coverageReady,true);assert.equal(frame.rendering.tilesState,'ready');}
 assertExperienceRect(frame.rect,context);
}
function assertSameStyleCamera(actual,expected,context){
 for(const key of ['longitude','latitude'])assert.ok(Math.abs(actual[key]-expected[key])<=1e-5,`${context}: style replacement displaced the manually panned camera`);
 assert.ok(Math.abs(actual.zoom-expected.zoom)<.01,`${context}: style replacement changed manual zoom`);
}
export function assertStyleCameraRoundtrip(receipt,name){
 const context=`${name}/style-camera`,engine=receipt?.before?.engine;
 assert.equal(engine,'tropnik-canvas');assert.equal(receipt?.schemaVersion,3);assert.equal(receipt.passed,true);assert.equal(receipt.input,'mouse');assert.ok(typeof receipt.routeId==='string'&&receipt.routeId);
 assertExperienceSelection(receipt.selection,context);assert.equal(receipt.selection.route,receipt.routeId);
 for(const frame of [receipt.before,receipt.zoomed,receipt.pan?.before,receipt.pan?.after,receipt.manual])assertStyleCameraFrame(frame,receipt.routeId,context,engine);
 assertExperienceClick(receipt.zoom,'mouse',`${context}/zoom`,'.map-controls button[aria-label="Увеличить масштаб"]');
 assert.ok(Math.abs(receipt.zoomed.camera.zoom-receipt.before.camera.zoom-1)<.01,`${context}: native zoom did not advance one step`);
 assertSourceEndPanInput(receipt.pan,'mouse',`${context}/pan`);
 assert.deepEqual(receipt.pan.before.camera,receipt.zoomed.camera);assert.deepEqual(receipt.pan.after.camera,receipt.manual.camera);
 assert.ok(Math.abs(receipt.manual.camera.longitude-receipt.zoomed.camera.longitude)>1e-5||Math.abs(receipt.manual.camera.latitude-receipt.zoomed.camera.latitude)>1e-5,`${context}: no genuine manual pan was measured`);
 assert.ok(Math.abs(receipt.manual.camera.zoom-receipt.zoomed.camera.zoom)<.01,`${context}: panning changed scale`);
 assert.deepEqual(receipt.transitions?.map(transition=>transition.label),['Спутник','Рельеф']);
 for(const transition of receipt.transitions){
  assertExperienceClick(transition.selected,'mouse',`${context}/mode-select`,`.map-style-switch button[aria-label="${transition.label}"]`);assert.equal(transition.selected.point.label,transition.label);
  assertStyleCameraFrame(transition.frame,receipt.routeId,context,engine);assertSameStyleCamera(transition.frame.camera,receipt.manual.camera,context);
  const line=transition.line;assert.equal(line?.route,receipt.routeId);assert.equal(line.clicked,true);assert.equal(line.selectionRetained,true);assert.equal(line.reopened,false);
  assertExperienceClick({input:'mouse',point:line.point,events:line.events},'mouse',`${context}/restored-line`,false);
  assertStyleCameraFrame(transition.lineFrame,receipt.routeId,context,engine);assertSameStyleCamera(transition.lineFrame.camera,receipt.manual.camera,context);
  assertExperienceSelection(transition.selection,context);for(const key of ['region','route','title'])assert.equal(transition.selection[key],receipt.selection[key]);
  const restored=transition.restored;assert.equal(restored?.route,receipt.routeId);assert.equal(restored.selected,true);
  assert.equal(restored.canvasRetained,true);assert.equal(restored.terrainScenes,0);assert.equal(restored.pitch,0);
  assert.ok(Array.isArray(restored.mutations));
  if(engine==='tropnik-canvas'){
   assert.equal(restored.drawnRoute,receipt.routeId);assert.equal(restored.tilesState,'ready');assert.equal(restored.mode,transition.label==='Спутник'?'satellite':'detail');
   assert.ok(Number.isInteger(restored.drawRevision)&&restored.drawRevision>restored.beforeDrawRevision,`${context}: no actual post-switch draw`);
   assert.ok(restored.mutations.every(mutation=>mutation.current===receipt.routeId&&mutation.old===receipt.routeId),`${context}: an unrelated layer switch cleared the route`);
  }
  // Multipart routes intentionally have no single-line end markers. The native
  // line hit above still proves their route overlay after each style change.
  assert.ok(Number.isInteger(restored.edges?.before)&&restored.edges.before>=0,`${context}: missing original route-edge count`);
  assert.equal(restored.edges.after,restored.edges.before);assert.equal(restored.edges.replaced,0,`${context}: unexpected route-overlay ownership change`);
 }
 return receipt;
}

/** The same evidence gate runs before upload and against the public artifact. */
export function assertBrowserReport(browser,expectedCommit,expectedCatalogue){
 assert.equal(browser.verified,true);
 assert.match(expectedCommit||'',/^[a-f0-9]{40}$/,'Publication requires an exact source commit');
 assertBrowserEnvironment(browser.environment,expectedCommit);
 assertNativeSurfaceCoverage(browser.environment.nativeSurface);
 assertTerrainMaskReport(browser.terrainMask,{sourceCommit:expectedCommit,environment:browser.environment});
 assertOfflineSafetyAudit(browser.offlineSafety);
 assert.equal(browser.offlineSafety.originTransport.active,false,'Offline transport was not restored after the audit');
 assert.ok(Number.isFinite(Date.parse(browser.offlineSafety.originTransport.restoredAt)),'Offline transport cleanup is not recorded');
 assert.equal(browser.sourceCommit,expectedCommit);
 assertCatalogueExpectations(expectedCatalogue);
 assert.deepEqual(browser.catalogue,expectedCatalogue,'The browser report belongs to another catalogue snapshot');
 assert.equal(browser.mapInteractionSchemaVersion,6,'The browser report predates native map wheel ownership coverage');
 assert.ok(Array.isArray(browser.profiles));
 for(const name of MOBILE_PROFILES){
  const profile=browser.profiles.find(item=>item.name===name);
  assert.ok(profile,`Missing mobile profile ${name}`);
  assert.equal(profile.engine,'tropnik-canvas',`${name}: the custom mobile renderer was not verified`);
  assert.equal(profile.interactionTested,true,`${name}: story touch was not tested`);
  assert.equal(profile.sheetTested,true,`${name}: mobile sheet was not tested`);
  assertSheetGestures(profile.sheetGestures,name);
  if(name!=='phone-landscape')assertLayerMenuAudit(profile.layerMenus,name);
  assert.ok(profile.sheetHeightDelta<1.1,`${name}: mobile sheet changed layout height`);
  assert.ok(profile.layoutShift<.12,`${name}: excessive layout shift`);
  assert.ok(profile.longestTaskMs<350,`${name}: excessive long task`);
 }
 const desktop=browser.desktopProfiles?.find(item=>item.name==='desktop-webgl');
 assert.ok(desktop,'Missing desktop rendering profile');
 assert.equal(desktop.engine,'tropnik-canvas');
 assert.equal(desktop.coarse,false,'Desktop verification used a touch profile');
 assert.equal(desktop.mapInteractionTested,true);
 for(const [name,engine,mobile] of [['android-portrait','tropnik-canvas',true],['desktop-webgl','tropnik-canvas',false]]){
  assertSmoothnessAudit(browser.siteSmoothness?.find(item=>item.profile===name),{name,engine,mobile});
  assertZoomDesign(browser.zoomDesigns?.find(item=>item.profile===name),name,engine,mobile);
  const result=browser.mapInteractions?.find(item=>item.profile===name);
  assert.ok(result,`${name}: missing real map interaction evidence`);
  assert.equal(result.passed,true);
  assert.equal(result.engine,engine);
  assert.equal(result.mobile,mobile);
  assertDirectionHitAreas(result.directionHitAreas,name,engine,mobile);
  assertExploreExperience(result.experience,name,engine,mobile,expectedCatalogue);
  assert.equal(result.experience.requestOwnership.route.id,result.route?.id,`${name}: request ownership used another selected route`);
  if(!mobile){assert.equal(result.styleCameraRoundtrip?.before.engine,engine);assertStyleCameraRoundtrip(result.styleCameraRoundtrip,name);assert.equal(result.styleCameraRoundtrip.routeId,result.route?.id);assertMapWheelAudit(result.wheelOwnership);}
  assert.equal(result.firstDirection?.at(-1)?.selected,'altai');
  assert.equal(result.secondDirection?.at(-1)?.selected,'baikal');
  assert.ok(result.route?.id&&result.route.offsetPx>=12&&result.route.offsetPx<=22,`${name}: route hit target was not tested away from the small visual dot`);
  assert.equal(result.line?.route,result.route.id);
  assert.equal(result.line?.clicked,true);
  assert.equal(result.line?.selectionRetained,true);
  if(mobile){
   assert.equal(result.line?.reopened,true,'A line touch did not reopen the mobile route card');
   assert.equal(result.catalogScroll?.passed,true,'The actual route catalogue was not scrolled');
   assert.equal(result.catalogScroll.input,'touch');
   assert.ok(result.catalogScroll.deltaPx>=24);
   assert.ok(Number.isFinite(result.catalogScroll.scrollHeightDelta)&&result.catalogScroll.scrollHeightDelta<=1,'Route cards changed the scrollbar extent during the swipe');
   assert.ok(result.catalogScroll.pageScrollDeltaPx<=1&&result.catalogScroll.sheetDisplacementPx<=1,'Scrolling route cards moved the page or sheet');
  }
  for(const flag of ['returnedToRegion','returnedToDirections','countryCameraRestored'])assert.equal(result[flag],true,`${name}: missing ${flag}`);
  assert.ok(result.polygon?.id,`${name}: administrative polygon was not tested`);
  assert.equal(result.gestures?.zoomInput,mobile?'touch-control':'mouse-wheel');
  assert.ok(result.gestures.afterZoom>result.gestures.beforeZoom+.2,`${name}: zoom did not advance`);
  assert.equal(result.gestures.dragged,true);
  assert.equal(result.gestures.selectionPreserved,true);
  assert.ok(result.gestures.resizedTo?.width>0&&result.gestures.resizedTo?.height>0);
  assert.ok(result.gestures.postResizePolygon,`${name}: map input was not checked after resize`);
  assert.ok(Number.isFinite(result.longestTaskMs)&&result.longestTaskMs<(mobile?350:750));
  assert.ok(Number.isFinite(result.layoutShift)&&result.layoutShift<.12,`${name}: map interaction layout shift exceeded the unchanged limit`);
 }
 return browser;
}
