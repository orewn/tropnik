import assert from 'node:assert/strict';

const MOBILE_PROFILES=['compact-android','iphone-portrait','android-portrait','phone-landscape'];

/** The same evidence gate runs before upload and against the public artifact. */
export function assertBrowserReport(browser,expectedCommit){
 assert.equal(browser.verified,true);
 assert.equal(browser.sourceCommit,expectedCommit);
 assert.equal(browser.mapInteractionSchemaVersion,1,'The browser report predates real map pointer checks');
 assert.ok(Array.isArray(browser.profiles));
 for(const name of MOBILE_PROFILES){
  const profile=browser.profiles.find(item=>item.name===name);
  assert.ok(profile,`Missing mobile profile ${name}`);
  assert.equal(profile.engine,'leaflet',`${name}: the mobile renderer was not verified`);
  assert.equal(profile.interactionTested,true,`${name}: story touch was not tested`);
  assert.equal(profile.sheetTested,true,`${name}: mobile sheet was not tested`);
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
  if(mobile)assert.equal(result.line?.reopened,true,'A line touch did not reopen the mobile route card');
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
