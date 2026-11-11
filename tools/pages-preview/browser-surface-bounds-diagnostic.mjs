import assert from 'node:assert/strict';
import {BROWSER_REQUIRED_VIEWS,collectNativeBrowserSurface,assertNativeSurfaceCoverage} from './browser-native-surface.mjs';

// A diagnostic-only A/B. Both sides retain the existing page metrics, native
// inputs and budgets. The cover side expands the actual host output so that
// every existing profile can be presented, including DPR2 mobile pixels.
export function nativeSurfaceBoundsMode(env=process.env){
 const mode=env.TROPNIK_BROWSER_SURFACE_BOUNDS||null;
 assert.ok(mode===null||mode==='existing'||mode==='cover','Unknown native surface bounds diagnostic');
 if(mode){
  assert.equal(env.TROPNIK_BROWSER_DIAGNOSTIC,'ui-smoothness','Native surface bounds cannot certify release');
  assert.equal(env.TROPNIK_BROWSER_SURFACE,'headless-software','Native bounds compare the same software compositor and real WebGL2 path');
  assert.ok(env.TROPNIK_BROWSER_TRACE!=='1'&&env.TROPNIK_BROWSER_SURFACE_TRACE!=='1','Native surface bounds performance windows must remain untraced');
 }
 return mode;
}
const COMMON_FLAGS=Object.freeze([
 '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update',
 '--disable-default-apps','--disable-extensions','--disable-features=Translate,MediaRouter','--mute-audio',
 '--use-gl=angle','--use-angle=swiftshader-webgl','--enable-unsafe-swiftshader',
]);
export function nativeSurfaceBoundsFlags(mode){
 assert.ok(mode==='existing'||mode==='cover');
 return [...COMMON_FLAGS,...(mode==='cover'?['--window-size=1920,1920','--ozone-override-screen-size=1920,1920']:[])];
}
export function assertNativeSurfaceBoundsCommandLine(commandLine,mode){
 assert.equal(typeof commandLine,'string');
 const switches=commandLine.split(/\s+/);
 for(const flag of nativeSurfaceBoundsFlags(mode)){
  const key=flag.split('=')[0],observed=switches.filter(value=>value===key||value.startsWith(key+'='));
  assert.ok(observed.length>0&&observed.every(value=>value===flag),`Native bounds used another Chromium switch: ${key}`);
 }
 assert.ok(switches.includes('--ozone-platform=headless'),'Native bounds require the same Ozone backend');
 if(mode==='existing'){
  assert.ok(!switches.some(value=>value.startsWith('--window-size')),'Existing output must retain the old native window');
  assert.ok(switches.includes('--ozone-override-screen-size=800,600'),'Existing output no longer has the original headless screen');
 }
}
export async function collectNativeSurfaceBoundsDiagnostic(cdp,{mode,sourceCommit=null,chromiumVersion,commandLine,inputArtifactSha256,staticBuildInfoSha256,profiles=BROWSER_REQUIRED_VIEWS}){
 assertNativeSurfaceBoundsCommandLine(commandLine,mode);
 assert.deepEqual(profiles,BROWSER_REQUIRED_VIEWS,'All five requested viewport sizes and DPRs must remain unchanged');
 const nativeSurface=await collectNativeBrowserSurface(cdp);
 let coverageError=null;
 try{assertNativeSurfaceCoverage(nativeSurface,profiles);}catch(error){coverageError=error.message;}
 return{schemaVersion:1,diagnosticOnly:true,verified:false,releaseEligible:false,sourceCommit,mode,chromiumVersion,commandLine,
  requestedFlags:nativeSurfaceBoundsFlags(mode),inputArtifactSha256,staticBuildInfoSha256,nativeSurface,profiles,
  coveragePassed:coverageError===null,coverageError,traceEnabled:false,instrumented:false,capturedAt:new Date().toISOString()};
}

// Pixel proof records the same browser-target facts as the normal audit.
// Collection stays outside page navigation and performance measurement.
export async function collectNativeBoundsBrowserInfo(browserURL,{WebSocketClass=WebSocket}={}){
 return new Promise((resolve,reject)=>{
  let socket,finished=false;const replies=new Map();
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);try{socket?.close();}catch{}error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(new Error('Native bounds browser information timed out')),5000);
  try{
   socket=new WebSocketClass(browserURL);
   socket.addEventListener('error',()=>finish(new Error('Native bounds browser information connection failed')),{once:true});
   socket.addEventListener('close',()=>{if(!finished)finish(new Error('Native bounds browser information closed early'));},{once:true});
   socket.addEventListener('open',()=>{try{for(const[id,method]of [[1,'SystemInfo.getInfo'],[2,'Browser.getVersion']])socket.send(JSON.stringify({id,method,params:{}}));}catch(error){finish(error);}},{once:true});
   socket.addEventListener('message',event=>{
    try{
     assert.ok(typeof event.data==='string'&&Buffer.byteLength(event.data)<=128*1024,'Oversized native bounds browser response');
     const message=JSON.parse(event.data);if(![1,2].includes(message.id))return;
     assert.equal(message.error,undefined,`Native bounds browser information failed: ${message.error?.message}`);
     assert.ok(message.result&&typeof message.result==='object');replies.set(message.id,message.result);
     if(replies.size===2)finish(null,{info:replies.get(1),browser:replies.get(2)});
    }catch(error){finish(error);}
   });
  }catch(error){finish(error);}
 });
}
