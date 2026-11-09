import assert from 'node:assert/strict';
import {projectMapPoint} from './map-projection.mjs';

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
export function assertRouteEdgeFrame(frame,context,{requireBothVisible=false}={}){
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
  if(requireBothVisible){
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
 const step=engine==='leaflet'?.75:1;let previous=audit.initialZoom;
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
  assertRouteEdgeFrame(frame,`${name}/source-ends/${frame.zoom}`,{requireBothVisible:index===1});
  const screenshot=screenshots.find(item=>item.file===frame.screenshot);
  assert.ok(screenshot&&screenshot.mode==='source-ends'&&Math.abs(screenshot.zoom-frame.zoom)<.01,`${name}: a source-end frame has no reviewable image`);
 }
 assert.equal(audit.frames.at(-1).inputCount,audit.inputs.length);
 assert.equal(new Set(audit.frames.map(frame=>frame.screenshot)).size,3);
 return true;
}

function assertZoomDesign(design,name,engine,mobile){
 assert.equal(design?.geometryPassed,true,`${name}: missing zoom-level design geometry evidence`);
 assert.equal(design.schemaVersion,4,'The design report predates native single-line source-end coverage');assert.equal(design.engine,engine);assert.equal(design.input,mobile?'touch':'mouse');
 assert.equal(design.visualReviewRequired,true,'DOM bounds must not be reported as human visual review');
 assert.equal(design.maximumZoom,18);assert.equal(design.routeId,'kavkaz-8a');
 assert.ok(Number.isFinite(design.minimumZoom)&&design.minimumZoom<4,`${name}: zoom coverage omitted the overview`);
 const steps=design.detailSteps;
 assert.ok(Array.isArray(steps)&&steps.length>=15,`${name}: the available zoom steps were not exercised`);
 assert.ok(Math.abs(steps[0].zoom-design.minimumZoom)<.01);
 assert.ok(Math.abs(steps.at(-1).zoom-18)<.01,`${name}: close zoom18 was not inspected`);
 for(let index=0;index<steps.length;index++){
  assert.ok(Number.isFinite(steps[index].zoom));
  if(index){const increment=steps[index].zoom-steps[index-1].zoom;assert.ok(increment>0&&increment<=1.01,`${name}: zoom coverage skipped an available increment`);}
 }
 const bursts=design.zoomBurst,step=engine==='leaflet'?.75:1;
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
 const overview=design.modes?.overview,keys=[2,5,8,11,14,18];
 assert.equal(overview?.state,'active',`${name}: the saved overview was not exercised`);
 assert.equal(overview.selectedControl,true);assert.equal(overview.visualReviewRequired,true);
 assert.equal(overview.keySteps?.length,keys.length,`${name}: saved-overview key scales are incomplete`);
 for(const [index,key] of keys.entries()){
  const sample=overview.keySteps[index],minimum=Math.max(key,design.minimumZoom);
  assert.equal(sample.targetZoom,key);assert.equal(sample.mode,'saved-overview');
  assert.ok(Number.isFinite(sample.zoom)&&sample.zoom>=minimum-.01&&sample.zoom<minimum+step+.01,`${name}: saved-overview scale ${key} was skipped`);
 }
 assert.ok(Array.isArray(overview.sourceEvidence?.geoJSON),`${name}: saved-overview source availability was not recorded`);
 for(const source of overview.sourceEvidence.geoJSON){assert.match(source.path,/\/data\/[^/]+\.geojson$/);assert.ok(Number.isFinite(source.status));assert.equal(typeof source.finished,'boolean');}
 for(const field of ['finishedReliefImageResponses','failedResponses','loadedReliefTiles'])assert.ok(Number.isInteger(overview.sourceEvidence[field])&&overview.sourceEvidence[field]>=0);
 assert.ok(['active','fallback','unavailable'].includes(design.modes?.satellite?.state),`${name}: satellite availability was not recorded`);
 assert.ok(['active','not-offered'].includes(design.modes?.terrain?.state),`${name}: global terrain availability was not recorded`);
 const scene=design.modes?.scene3d;
 assert.ok(['ready','error','not-ready','not-offered'].includes(scene?.state),`${name}: prepared3D availability was not recorded`);
 if(scene.state==='ready'){assert.equal(scene.retainedMapNoticeVisible,false,`${name}: a retained 2D notice covers the ready 3D scene`);assert.equal(scene.zoomInputs,28);assert.equal(scene.resetInput,true);assert.equal(scene.imageChanged,true);}
 assert.ok(Array.isArray(design.screenshots)&&design.screenshots.filter(item=>item.mode==='detail').length>=6,`${name}: key-scale review images are missing`);
 assert.ok(design.screenshots.filter(item=>item.mode==='saved-overview').length>=6,`${name}: saved-overview review images are missing`);
 for(const screenshot of design.screenshots){assert.match(screenshot.file,/^[a-z0-9_.-]+\.png$/);assert.match(screenshot.sha256,/^[a-f0-9]{64}$/);assert.ok(screenshot.bytes>1000);}
 assertCloseTrailAudit(design.closeTrail,name,engine,mobile,design.screenshots);
}

/** The same evidence gate runs before upload and against the public artifact. */
export function assertBrowserReport(browser,expectedCommit){
 assert.equal(browser.verified,true);
 assert.equal(browser.sourceCommit,expectedCommit);
 assert.equal(browser.mapInteractionSchemaVersion,2,'The browser report predates real sheet drag and map pointer checks');
 assert.ok(Array.isArray(browser.profiles));
 for(const name of MOBILE_PROFILES){
  const profile=browser.profiles.find(item=>item.name===name);
  assert.ok(profile,`Missing mobile profile ${name}`);
  assert.equal(profile.engine,'leaflet',`${name}: the mobile renderer was not verified`);
  assert.equal(profile.interactionTested,true,`${name}: story touch was not tested`);
  assert.equal(profile.sheetTested,true,`${name}: mobile sheet was not tested`);
  assertSheetGestures(profile.sheetGestures,name);
  assert.ok(profile.sheetHeightDelta<1.1,`${name}: mobile sheet changed layout height`);
  assert.ok(profile.layoutShift<.12,`${name}: excessive layout shift`);
  assert.ok(profile.longestTaskMs<350,`${name}: excessive long task`);
 }
 const desktop=browser.desktopProfiles?.find(item=>item.name==='desktop-webgl');
 assert.ok(desktop,'Missing desktop rendering profile');
 assert.equal(desktop.engine,'maplibre');
 assert.equal(desktop.coarse,false,'Desktop verification used a touch profile');
 assert.equal(desktop.mapInteractionTested,true);
 for(const [name,engine,mobile] of [['android-portrait','leaflet',true],['desktop-webgl','maplibre',false]]){
  assertZoomDesign(browser.zoomDesigns?.find(item=>item.profile===name),name,engine,mobile);
  const result=browser.mapInteractions?.find(item=>item.profile===name);
  assert.ok(result,`${name}: missing real map interaction evidence`);
  assert.equal(result.passed,true);
  assert.equal(result.engine,engine);
  assert.equal(result.mobile,mobile);
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
 }
 return browser;
}
