import assert from 'node:assert/strict';

const MOBILE_PROFILES=['compact-android','iphone-portrait','android-portrait','phone-landscape'];

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

function assertZoomDesign(design,name,engine,mobile){
 assert.equal(design?.geometryPassed,true,`${name}: missing zoom-level design geometry evidence`);
 assert.equal(design.schemaVersion,2,'The design report predates notices, credits and saved-overview coverage');assert.equal(design.engine,engine);assert.equal(design.input,mobile?'touch':'mouse');
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
 if(scene.state==='ready'){assert.equal(scene.zoomInputs,28);assert.equal(scene.resetInput,true);assert.equal(scene.imageChanged,true);}
 assert.ok(Array.isArray(design.screenshots)&&design.screenshots.filter(item=>item.mode==='detail').length>=6,`${name}: key-scale review images are missing`);
 assert.ok(design.screenshots.filter(item=>item.mode==='saved-overview').length>=6,`${name}: saved-overview review images are missing`);
 for(const screenshot of design.screenshots){assert.match(screenshot.file,/^[a-z0-9_.-]+\.png$/);assert.match(screenshot.sha256,/^[a-f0-9]{64}$/);assert.ok(screenshot.bytes>1000);}
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
