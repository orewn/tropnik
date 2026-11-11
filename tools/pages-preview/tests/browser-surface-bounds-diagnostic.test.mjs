import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_REQUIRED_VIEWS,assertNativeSurfaceCoverage} from '../browser-native-surface.mjs';
import {nativeSurfaceBoundsMode,nativeSurfaceBoundsFlags,assertNativeSurfaceBoundsCommandLine,collectNativeSurfaceBoundsDiagnostic,collectNativeBoundsBrowserInfo} from '../browser-surface-bounds-diagnostic.mjs';

const env={TROPNIK_BROWSER_DIAGNOSTIC:'ui-smoothness',TROPNIK_BROWSER_SURFACE:'headless-software',TROPNIK_BROWSER_SURFACE_BOUNDS:'cover'};
const command=mode=>'/usr/bin/google-chrome '+nativeSurfaceBoundsFlags(mode).join(' ')+' --ozone-platform=headless'+(mode==='existing'?' --ozone-override-screen-size=800,600':'');
function page(width=1920,height=1920,innerHeight=1833){
 const bounds={left:0,top:0,width,height,windowState:'normal'};
 const viewport={url:'about:blank',visibilityState:'visible',innerWidth:width,innerHeight,outerWidth:width,outerHeight:height,devicePixelRatio:1,screen:{width,height,availWidth:width,availHeight:height}};
 const calls=[];
 return{calls,async call(method,params){calls.push([method,params]);if(method==='Browser.getWindowForTarget')return{windowId:1,bounds};if(method==='Browser.getWindowBounds')return{bounds};if(method==='Runtime.evaluate')return{result:{value:viewport}};throw new Error('Unexpected method '+method);}};
}
test('bounds comparison cannot run as release, CPU throttle, another surface or traced timing',()=>{
 assert.equal(nativeSurfaceBoundsMode({}),null);assert.equal(nativeSurfaceBoundsMode(env),'cover');
 for(const update of [{TROPNIK_BROWSER_DIAGNOSTIC:undefined},{TROPNIK_BROWSER_DIAGNOSTIC:'ui-smoothness-cpu'},{TROPNIK_BROWSER_SURFACE:'headless'},{TROPNIK_BROWSER_TRACE:'1'},{TROPNIK_BROWSER_SURFACE_TRACE:'1'},{TROPNIK_BROWSER_SURFACE_BOUNDS:'small'}])assert.throws(()=>nativeSurfaceBoundsMode({...env,...update}));
});
test('cover changes only actual host window and screen, retaining SwiftShader WebGL and all other flags',()=>{
 const existing=nativeSurfaceBoundsFlags('existing'),cover=nativeSurfaceBoundsFlags('cover');
 assert.deepEqual(cover.slice(0,existing.length),existing);
 assert.deepEqual(cover.slice(existing.length),['--window-size=1920,1920','--ozone-override-screen-size=1920,1920']);
 assert.ok(existing.includes('--use-angle=swiftshader-webgl'));assert.ok(!existing.includes('--disable-webgl'));
 for(const mode of ['existing','cover'])assert.doesNotThrow(()=>assertNativeSurfaceBoundsCommandLine(command(mode),mode));
 assert.throws(()=>assertNativeSurfaceBoundsCommandLine(command('cover')+' --window-size=780,580','cover'));
 assert.throws(()=>assertNativeSurfaceBoundsCommandLine(command('existing')+' --window-size=1920,1920','existing'));
});
test('before-emulation receipt requires full native client coverage of every unchanged physical profile',async()=>{
 const cdp=page(),receipt=await collectNativeSurfaceBoundsDiagnostic(cdp,{mode:'cover',chromiumVersion:'Chrome/156.0.8078.79',commandLine:command('cover')});
 assert.equal(receipt.coveragePassed,true);assert.equal(receipt.releaseEligible,false);assert.equal(receipt.instrumented,false);
 assert.deepEqual(receipt.profiles,BROWSER_REQUIRED_VIEWS);
 assert.deepEqual(cdp.calls.map(([method])=>method),['Browser.getWindowForTarget','Browser.getWindowBounds','Runtime.evaluate']);
 const insufficient=await collectNativeSurfaceBoundsDiagnostic(page(1920,1920,1800),{mode:'cover',commandLine:command('cover')});
 assert.equal(insufficient.coveragePassed,false);assert.match(insufficient.coverageError,/android-portrait.*1830/);
 assert.throws(()=>assertNativeSurfaceCoverage(insufficient.nativeSurface));
 const old=await collectNativeSurfaceBoundsDiagnostic(page(780,580,493),{mode:'existing',commandLine:command('existing')});
 assert.equal(old.coveragePassed,false);assert.equal(old.nativeSurface.window.width,780);
 assert.equal(old.verified,false);assert.equal(old.releaseEligible,false);
});
test('pixel proof captures actual browser version and SystemInfo with bounded browser-target requests',async()=>{
 class Socket extends EventTarget{
  constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(raw){const request=JSON.parse(raw),result=request.method==='SystemInfo.getInfo'?{commandLine:command('cover'),gpu:{featureStatus:{gpu_compositing:'disabled_software'}}}:{product:'Chrome/156.0.8078.79'};queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:request.id,result})})));}
  close(){this.dispatchEvent(new Event('close'));}
 }
 const result=await collectNativeBoundsBrowserInfo('ws://127.0.0.1:123/devtools/browser/test',{WebSocketClass:Socket});
 assert.equal(result.browser.product,'Chrome/156.0.8078.79');assert.equal(result.info.commandLine,command('cover'));
});
