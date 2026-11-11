import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {assertOfflineOriginTransport} from './browser-origin-transport.mjs';

const OUTPUT=new URL('../../web/pages-preview/design-qa/',import.meta.url);
const TITLE='CI · Берег Приморска';
const LEADER='Проверочный руководитель CI';
const PHONE='+79990000000';
const INPUT_SELECTORS=['#route-title','#region','#leader-name','#leader-phone'];

export function assertOfflineSafetyInput(input){
 assert.equal(input?.passed,true,'Safety input did not complete');
 assert.equal(input.focusedBeforeTyping,true,'Safety text was sent before its native focus arrived');
 assert.ok(input.events?.some(event=>event.type==='input'&&event.trusted&&'#'+event.id===input.selector&&event.valueLength===input.valueLength),'Safety text lacks a trusted input event on the intended field');
 return input;
}

export async function inputOfflineSafetyText(cdp,helpers,profile,selector,value,inputs){
 const {evaluate,waitValue,pointerSelector}=helpers;
 const input={selector,valueLength:value.length,passed:false};inputs.push(input);
 await evaluate(cdp,`(()=>{const events=[];const record=event=>{const target=event.target;events.push({type:event.type,id:target?.id||'',tag:target?.tagName||'',trusted:event.isTrusted,valueLength:typeof target?.value==='string'?target.value.length:null});if(events.length>40)events.shift();};const types=['pointerdown','pointerup','click','focusin','beforeinput','input'];for(const type of types)document.addEventListener(type,record,true);window.__tropnikSafetyInput={events,cleanup:()=>{for(const type of types)document.removeEventListener(type,record,true);}};document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});})()`);
 try{
  // Smooth scrolling can expose a field before it stops moving. Use the same
  // compositor/geometry gate as other native taps, then await the actual focus.
  input.point=await pointerSelector(cdp,selector,profile);
  const focus=await waitValue('Safety input did not receive native focus: '+selector,()=>evaluate(cdp,`({focused:document.activeElement===document.querySelector(${JSON.stringify(selector)}),activeId:document.activeElement?.id||''})`),state=>state.focused);
  input.focusedBeforeTyping=focus.focused;
  await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
  await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
  await cdp.call('Input.insertText',{text:value});
  await waitValue('Safety form did not accept native text: '+selector,()=>evaluate(cdp,`document.querySelector(${JSON.stringify(selector)}).value`),current=>current===value);
  input.events=await evaluate(cdp,'window.__tropnikSafetyInput.events');
  input.passed=true;assertOfflineSafetyInput(input);return input;
 }catch(error){input.passed=false;input.error=error.message;throw error;}
 finally{
  const state=await evaluate(cdp,`(()=>{const probe=window.__tropnikSafetyInput;probe?.cleanup();delete window.__tropnikSafetyInput;return{events:probe?.events||[],activeId:document.activeElement?.id||'',valueLength:document.querySelector(${JSON.stringify(selector)})?.value.length??null};})()`);
  input.events=state.events;input.finalActiveId=state.activeId;input.finalValueLength=state.valueLength;
 }
}

export function assertOfflineSafetyAudit(report){
 assert.equal(report?.schemaVersion,1,'Missing offline emergency-card cold-start gate');
 assert.equal(report.passed,true);assert.equal(report.profile,'android-portrait');
 for(const key of ['savedThroughUI','workerControlled','coldNavigation','offline','titleRestored','contactRestored','draftExplicit','privateApiNotCached'])assert.equal(report[key],true,`Offline safety: missing ${key}`);
 assert.ok(report.nativeInputs>=4);assert.equal(report.networkSuccessfulResponses,0);
 assertOfflineOriginTransport(report.originTransport);
 for(const selector of INPUT_SELECTORS)assertOfflineSafetyInput(report.inputs?.find(input=>input.selector===selector));
 assert.ok(report.screenshot?.bytes>1000);assert.match(report.screenshot.sha256,/^[a-f0-9]{64}$/);
 return report;
}

export async function restoreOfflineSafetyEnvironment(cdp,report,originTransport,save){
 const transport=originTransport?.restore();if(transport)report.originTransport=transport;
 const results=await Promise.allSettled([
  cdp.call('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1}),
  cdp.call('Network.setCacheDisabled',{cacheDisabled:false}),
 ]);
 const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
 if(errors.length){report.passed=false;report.cleanupError=errors.map(error=>String(error?.message||error));}
 await save();
 if(errors.length)throw new AggregateError(errors,'Offline safety environment restoration failed');
}

/** Save a local draft through the form, discard its document, then reopen its
 * URL with the network disabled. No storage seed or component state injection. */
export async function runOfflineSafetyAudit(cdp,helpers){
 const {evaluate,waitValue,sleep,pointerAt}=helpers;
 const profile={name:'android-portrait',width:412,height:915,mobile:true,engine:'tropnik-canvas'};
 const report={schemaVersion:1,profile:profile.name,passed:false,nativeInputs:0,inputs:[]};
 const url=new URL('safety/registration/',helpers.url).href;
 let observingOffline=false,successfulResponses=0;
 const forget=cdp.observe('Network.responseReceived',({response})=>{
  if(observingOffline&&response?.status>=200&&response.status<400&&!response.fromServiceWorker&&!response.url.startsWith('data:'))successfulResponses++;
 });
 const save=async()=>{await mkdir(OUTPUT,{recursive:true});await writeFile(new URL('offline-safety.json',OUTPUT),JSON.stringify(report,null,2)+'\n');};
 const navigate=async target=>{const loaded=cdp.event('Page.loadEventFired',30000);await cdp.call('Page.navigate',{url:target});await loaded;};
 async function input(selector,value){
  await inputOfflineSafetyText(cdp,helpers,profile,selector,value,report.inputs);
  report.nativeInputs++;
 }
 try{
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:profile.width,height:profile.height,deviceScaleFactor:2,mobile:true,screenWidth:profile.width,screenHeight:profile.height});
  await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await navigate(url);
  await waitValue('Safety form did not mount',()=>evaluate(cdp,"!!document.querySelector('#route-title')"),Boolean);
  await input('#route-title',TITLE);await input('#region','Ленинградская область');await input('#leader-name',LEADER);await input('#leader-phone',PHONE);
  await evaluate(cdp,"[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Сохранить на устройстве').scrollIntoView({block:'center'})");
  let previousButton=null,stableFrames=0;
  const button=await waitValue('Local passport save is not reachable',()=>evaluate(cdp,"(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='Сохранить на устройстве'),r=button?.getBoundingClientRect();if(!r)return null;const x=r.left+r.width/2,y=r.top+r.height/2;return button.contains(document.elementFromPoint(x,y))?{x,y}:null;})()"),point=>{if(point&&previousButton&&Math.hypot(point.x-previousButton.x,point.y-previousButton.y)<1)stableFrames++;else stableFrames=0;previousButton=point;return stableFrames>=3;});
  await pointerAt(cdp,button,profile);
  report.savedThroughUI=await waitValue('Passport did not persist after save',()=>evaluate(cdp,`(()=>{try{return JSON.parse(localStorage.getItem('tropnik-safety-passports-v1')||'[]').some(item=>item.routeTitle===${JSON.stringify(TITLE)}&&item.leaderName===${JSON.stringify(LEADER)}&&item.leaderPhone===${JSON.stringify(PHONE)});}catch{return false;}})()`),Boolean);
  report.workerControlled=await waitValue('The offline shell never took control',()=>evaluate(cdp,"!!navigator.serviceWorker?.controller"),Boolean,30000);
  await waitValue('The offline emergency viewer is not cached',()=>evaluate(cdp,`(async()=>{for(const name of await caches.keys()){if(!name.includes('tropnik-shell-'))continue;const cache=await caches.open(name);if(await cache.match(${JSON.stringify(new URL('offline-safety.html',helpers.url).pathname)}))return true;}return false;})()`),Boolean,30000);
  await navigate('about:blank');report.coldNavigation=true;
  await cdp.call('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  report.originTransport=await helpers.originTransport.start();
  observingOffline=true;
  await navigate(url);
  await waitValue('Offline safety viewer did not mount after a cold navigation',()=>evaluate(cdp,"!!document.querySelector('#safety-status')&&!!document.querySelector('#safety-detail')"),Boolean,15000);
  const card=await waitValue('Saved emergency data disappeared offline',()=>evaluate(cdp,"({text:document.querySelector('#safety-detail')?.textContent||'',status:document.querySelector('#safety-status')?.textContent||'',offline:navigator.onLine===false})"),state=>state.text.includes(TITLE)&&state.text.includes(LEADER)&&state.text.includes(PHONE),10000);
  report.offline=card.offline;report.titleRestored=card.text.includes(TITLE);report.contactRestored=card.text.includes(LEADER)&&card.text.includes(PHONE);
  report.draftExplicit=/черновик|не.*регистрац/i.test(card.text+' '+card.status);
  report.privateApiNotCached=await evaluate(cdp,"(async()=>{for(const name of await caches.keys()){for(const request of await(await caches.open(name)).keys()){if(/\\/api\\//.test(new URL(request.url).pathname))return false;}}return true;})()");
  await sleep(100);report.networkSuccessfulResponses=successfulResponses;report.originTransport=helpers.originTransport.snapshot();
  const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),bytes=Buffer.from(shot.data,'base64');
  const file='android-offline-emergency-card.png';await mkdir(OUTPUT,{recursive:true});await writeFile(new URL(file,OUTPUT),bytes);
  report.screenshot={file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};report.passed=true;
  assertOfflineSafetyAudit(report);await save();return report;
 }catch(error){report.passed=false;report.error=error.stack||String(error);await save();throw error;}
 finally{observingOffline=false;forget();await restoreOfflineSafetyEnvironment(cdp,report,helpers.originTransport,save);}
}
