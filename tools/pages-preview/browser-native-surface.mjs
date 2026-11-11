import assert from 'node:assert/strict';

// These are the existing audit dimensions and DPRs. They describe physical
// coverage required of a native output surface, not smaller emulated profiles.
export const BROWSER_REQUIRED_VIEWS=Object.freeze([
 Object.freeze({name:'compact-android',width:320,height:640,deviceScaleFactor:2}),
 Object.freeze({name:'iphone-portrait',width:390,height:844,deviceScaleFactor:2}),
 Object.freeze({name:'android-portrait',width:412,height:915,deviceScaleFactor:2}),
 Object.freeze({name:'phone-landscape',width:844,height:390,deviceScaleFactor:2}),
 Object.freeze({name:'desktop-webgl',width:1440,height:1000,deviceScaleFactor:1}),
]);
const NATIVE_SURFACE_TIMEOUT_MS=5000;
export function assertNativeSurfaceReceipt(surface){
 assert.equal(surface?.schemaVersion,1,'Missing actual native browser surface');
 assert.equal(surface.collection,'blank-target-before-emulation');
 assert.equal(surface.viewport?.url,'about:blank','Native dimensions must be recorded before page navigation and emulation');
 assert.equal(surface.viewport.visibilityState,'visible','The native browser target was hidden');
 assert.equal(surface.window?.windowState,'normal','The native browser window is not normal');
 for(const [object,keys]of [[surface.window,['width','height']],[surface.viewport,['innerWidth','innerHeight','outerWidth','outerHeight','devicePixelRatio']],[surface.viewport.screen,['width','height','availWidth','availHeight']]]){
  assert.ok(object,'Missing actual native surface dimensions');
  for(const key of keys)assert.ok(Number.isFinite(object[key])&&object[key]>0,`Missing actual native surface ${key}`);
 }
 return surface;
}
export function nativeSurfaceIdentity(surface){
 assertNativeSurfaceReceipt(surface);
 return{window:{width:surface.window.width,height:surface.window.height,windowState:surface.window.windowState},viewport:surface.viewport};
}
export function assertNativeSurfaceCoverage(surface,profiles=BROWSER_REQUIRED_VIEWS){
 assertNativeSurfaceReceipt(surface);
 const {viewport,window}=surface,scale=viewport.devicePixelRatio;
 const actual={width:Math.min(viewport.innerWidth,viewport.outerWidth,window.width,viewport.screen.width,viewport.screen.availWidth)*scale,
  height:Math.min(viewport.innerHeight,viewport.outerHeight,window.height,viewport.screen.height,viewport.screen.availHeight)*scale};
 assert.ok(Array.isArray(profiles)&&profiles.length>0,'Requested browser profiles must be explicit');
 for(const profile of profiles){
  for(const key of ['width','height','deviceScaleFactor'])assert.ok(Number.isFinite(profile[key])&&profile[key]>0,`Invalid requested profile ${key}`);
  const required={width:profile.width*profile.deviceScaleFactor,height:profile.height*profile.deviceScaleFactor};
  assert.ok(actual.width>=required.width&&actual.height>=required.height,`${profile.name}: native output ${actual.width}x${actual.height} does not cover requested ${required.width}x${required.height} physical pixels`);
 }
 return surface;
}
export async function collectNativeBrowserSurface(cdp){
 let timer,expired=false;
 const collect=async()=>{
  const target=await cdp.call('Browser.getWindowForTarget',{},NATIVE_SURFACE_TIMEOUT_MS);
  assert.ok(Number.isInteger(target?.windowId),'Chromium did not identify the native window');
  if(expired)throw new Error('Native surface collection expired');
  const [window,evaluated]=await Promise.all([
   cdp.call('Browser.getWindowBounds',{windowId:target.windowId},NATIVE_SURFACE_TIMEOUT_MS),
   cdp.call('Runtime.evaluate',{expression:'({url:location.href,visibilityState:document.visibilityState,innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight}})',returnByValue:true},NATIVE_SURFACE_TIMEOUT_MS),
  ]);
  assert.equal(evaluated.exceptionDetails,undefined,'Native window inspection failed');
  assert.deepEqual(window.bounds,target.bounds,'The native window changed while collecting its dimensions');
  const surface={schemaVersion:1,collection:'blank-target-before-emulation',window:window.bounds,viewport:evaluated.result?.value};
  return assertNativeSurfaceReceipt(surface);
 };
 try{return await Promise.race([collect(),new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Timed out collecting the native browser surface'));},NATIVE_SURFACE_TIMEOUT_MS);})]);}
 finally{clearTimeout(timer);}
}
