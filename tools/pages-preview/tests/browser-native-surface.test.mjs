import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_REQUIRED_VIEWS,collectNativeBrowserSurface,assertNativeSurfaceReceipt,assertNativeSurfaceCoverage} from '../browser-native-surface.mjs';
import {nativeSurfaceFixture} from './browser-environment-fixture.mjs';

test('native coverage retains every original profile size and device pixel ratio',()=>{
 assert.deepEqual(BROWSER_REQUIRED_VIEWS.map(({name,width,height,deviceScaleFactor})=>[name,width,height,deviceScaleFactor]),[
  ['compact-android',320,640,2],['iphone-portrait',390,844,2],['android-portrait',412,915,2],['phone-landscape',844,390,2],['desktop-webgl',1440,1000,1],
 ]);
 assert.equal(Math.max(...BROWSER_REQUIRED_VIEWS.map(profile=>profile.width*profile.deviceScaleFactor)),1688);
 assert.equal(Math.max(...BROWSER_REQUIRED_VIEWS.map(profile=>profile.height*profile.deviceScaleFactor)),1830);
});
test('native surface records real browser bounds and blank viewport before any emulation',async()=>{
 const actual=nativeSurfaceFixture(),calls=[];
 const cdp={call:async(method,params,timeout)=>{
  calls.push({method,params,timeout});
  if(method==='Browser.getWindowForTarget')return{windowId:42,bounds:actual.window};
  if(method==='Browser.getWindowBounds'){assert.equal(params.windowId,42);return{bounds:actual.window};}
  assert.equal(method,'Runtime.evaluate');assert.equal(params.returnByValue,true);assert.doesNotMatch(params.expression,/requestAnimationFrame|setDeviceMetrics|resizeTo/);
  return{result:{value:actual.viewport}};
 }};
 const receipt=await collectNativeBrowserSurface(cdp);assert.deepEqual(receipt,actual);
 assert.deepEqual(calls.map(call=>call.method),['Browser.getWindowForTarget','Browser.getWindowBounds','Runtime.evaluate']);
 assert.ok(calls.every(call=>call.timeout===5000));assert.equal(assertNativeSurfaceCoverage(receipt),receipt);
});
test('observed default 780x493 native output cannot validate larger emulated screenshot dimensions',()=>{
 const surface=nativeSurfaceFixture();surface.viewport.innerWidth=780;surface.viewport.innerHeight=493;
 assert.throws(()=>assertNativeSurfaceCoverage(surface),/native output 780x493/);
 const smallScreen=nativeSurfaceFixture();smallScreen.viewport.screen.width=800;smallScreen.viewport.screen.height=600;
 assert.throws(()=>assertNativeSurfaceCoverage(smallScreen),/native output 800x600/);
});
test('the physical coverage boundary includes landscape width, portrait height and actual native DPR',()=>{
 const surface=nativeSurfaceFixture();
 for(const object of [surface.window,surface.viewport.screen]){object.width=1688;object.height=1830;}
 Object.assign(surface.viewport,{innerWidth:1688,outerWidth:1688,innerHeight:1830,outerHeight:1830});
 Object.assign(surface.viewport.screen,{availWidth:1688,availHeight:1830});
 assert.equal(assertNativeSurfaceCoverage(surface),surface);
 surface.viewport.innerHeight=1829;assert.throws(()=>assertNativeSurfaceCoverage(surface),/android-portrait.*824x1830/);
 surface.viewport.innerHeight=1830;surface.viewport.innerWidth=1687;assert.throws(()=>assertNativeSurfaceCoverage(surface),/phone-landscape.*1688x780/);
 const scaled=nativeSurfaceFixture();for(const object of [scaled.window,scaled.viewport.screen]){object.width=960;object.height=960;}
 Object.assign(scaled.viewport,{innerWidth:950,innerHeight:950,outerWidth:960,outerHeight:960,devicePixelRatio:2});Object.assign(scaled.viewport.screen,{availWidth:960,availHeight:960});
 assert.equal(assertNativeSurfaceCoverage(scaled),scaled);
});
test('hidden, emulated, missing and unstable native geometry cannot pass inspection',async()=>{
 for(const change of [value=>value.viewport.visibilityState='hidden',value=>value.viewport.url='https://example.invalid/',value=>delete value.viewport.devicePixelRatio,value=>value.window.windowState='minimized',value=>value.viewport.screen.availWidth=0]){
  const bad=nativeSurfaceFixture();change(bad);assert.throws(()=>assertNativeSurfaceReceipt(bad));
 }
 const surface=nativeSurfaceFixture();
 await assert.rejects(collectNativeBrowserSurface({call:async method=>method==='Browser.getWindowForTarget'?{windowId:42,bounds:surface.window}:method==='Browser.getWindowBounds'?{bounds:{...surface.window,width:800}}:{result:{value:surface.viewport}}}),/native window changed/);
});
