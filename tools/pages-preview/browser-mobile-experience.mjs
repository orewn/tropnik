import assert from 'node:assert/strict';
import {sendNativeText} from './browser-native-text.mjs';
import {projectMapPoint} from './map-projection.mjs';
import {assertExperienceClick,assertExperienceScrolls} from './browser-report.mjs';
import {observeSmoothnessPan} from './browser-smoothness.mjs';
import {assertSourceEndPanInput} from './browser-source-end-pan.mjs';

export const MOBILE_EXPERIENCE_SOURCES=Object.freeze([
 'tools/pages-preview/browser-mobile-experience.mjs','tools/pages-preview/browser-smoke.mjs','tools/pages-preview/browser-report.mjs',
 'web/components/Explore.tsx','web/components/Header.tsx','web/components/Offline.tsx',
]);
const NAV=[['map','Карта'],['saved','Сохранено'],['more','Ещё']];
const INPUT='[data-map-search-input]',CONTENT='.explore-panel-content';
const selectorForRoute=id=>`.trail-card[data-route-id=${JSON.stringify(id)}] .trail-card-main`;
const selectorForSaved=(id,action)=>`.saved-card[data-saved-route-id=${JSON.stringify(id)}] [data-saved-action="${action}"]`;
const destination=id=>`[data-mobile-destination="${id}"]`;

export function mobileTargetSelectors(stage,routeId){
 const nav=NAV.map(([id])=>[`destination-${id}`,destination(id)]);
 switch(stage){
  case 'initial':return [...nav,['search-launch','.mobile-search-launch'],['sheet-toggle','.sheet-handle'],['sheet-preview','.sheet-peek-summary'],['zoom-in','.map-controls button[aria-label="Увеличить масштаб"]'],['zoom-out','.map-controls button[aria-label="Уменьшить масштаб"]'],['location','.map-controls button[aria-label="Моё местоположение"]'],['layers','.layer-button'],['stories','.fact-closed']];
  case 'search':return [...nav,['search-input',INPUT],['search-clear','.search-field button[aria-label="Очистить поиск"]'],['search-submit','.map-search-submit'],['sheet-toggle','.sheet-handle']];
  case 'filters':return [['difficulty','[data-filter-field="difficulty"]'],['duration','[data-filter-field="duration"]'],['apply','[data-filter-action="apply"]'],['reset','[data-filter-action="reset"]'],['close','[role="dialog"] button[aria-label="Закрыть"]']];
  case 'route':return [...nav,['save','[data-route-action="save"]'],['show-map','[data-route-action="map"]'],['sheet-toggle','.sheet-handle']];
  case 'route-map':return [...nav,['save','.mobile-peek-save'],['sheet-toggle','.sheet-handle'],['sheet-preview','.sheet-peek-summary']];
  case 'saved':return [...nav,['saved-open',selectorForSaved(routeId,'open')],['saved-remove',selectorForSaved(routeId,'remove')]];
  case 'more':return [...nav,['menu-first','#main-navigation a[href]']];
  default:throw new Error(`Unknown mobile target stage ${stage}`);
 }
}

/** Read only painted controls and actual hit tests. No application handler or
 * state is used to prepare a target. This function runs in the browser. */
export function inspectMobileTargets(stage,selectors){
 const box=r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height});
 const targets=selectors.map(([id,selector])=>{
  const element=document.querySelector(selector);if(!element)return{id,selector,missing:true};
  const r=element.getBoundingClientRect(),s=getComputedStyle(element);
  const samples=[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([fx,fy])=>{
   const x=r.left+r.width*fx,y=r.top+r.height*fy,hit=document.elementFromPoint(x,y);
   return{x,y,owned:!!hit&&element.contains(hit),hit:hit?.tagName||null};
  });
  return{id,selector,label:(element.getAttribute('aria-label')||[...(element.labels||[])].map(label=>label.textContent).join(' ')||element.textContent||'').trim(),rect:box(r),visible:!!element.getClientRects().length&&s.visibility!=='hidden'&&s.display!=='none'&&!element.closest('[hidden],[inert]'),disabled:!!element.disabled,samples};
 });
 const navigation=[...document.querySelectorAll('[data-mobile-destination]')].map(element=>({id:element.dataset.mobileDestination,text:element.textContent?.trim(),active:element.getAttribute('aria-current')==='page'}));
 return{schemaVersion:1,stage,viewport:{width:innerWidth,height:innerHeight},navigation,storyExpanded:!!document.querySelector('.fact-card')?.getClientRects().length,targets};
}

export function assertMobileTargets(receipt,stage,routeId){
 assert.equal(receipt?.schemaVersion,1);assert.equal(receipt.stage,stage);
 assert.ok(Number.isFinite(receipt.viewport?.width)&&receipt.viewport.width>0&&Number.isFinite(receipt.viewport?.height)&&receipt.viewport.height>0);
 assert.deepEqual(receipt.targets?.map(item=>[item.id,item.selector]),mobileTargetSelectors(stage,routeId),`${stage}: mobile primary controls are missing`);
 assert.deepEqual(receipt.navigation?.map(item=>[item.id,item.text]),NAV,`${stage}: the three stable primary destinations changed`);
 assert.deepEqual(receipt.navigation.filter(item=>item.active).map(item=>item.id),[stage==='saved'?'saved':stage==='more'?'more':'map'],`${stage}: active primary destination is ambiguous`);
 if(stage==='initial')assert.equal(receipt.storyExpanded,false,'Mobile stories must start collapsed');
 for(const target of receipt.targets){
  const context=`${stage}/${target.id}`,r=target.rect;
  assert.equal(target.visible,true,`${context}: target is hidden or inert`);assert.equal(target.disabled,false,`${context}: target is disabled`);
  assert.ok(typeof target.label==='string'&&target.label.length>0,`${context}: missing accessible name`);
  assert.ok(r&&['left','top','right','bottom','width','height'].every(key=>Number.isFinite(r[key])),`${context}: missing measured target`);
  assert.ok(Math.abs(r.right-r.left-r.width)<.01&&Math.abs(r.bottom-r.top-r.height)<.01);
  assert.ok(r.width>=47.99&&r.height>=47.99,`${context}: primary target is smaller than 48 CSS px`);
  assert.ok(r.left>=-1&&r.top>=-1&&r.right<=receipt.viewport.width+1&&r.bottom<=receipt.viewport.height+1,`${context}: target escapes the viewport`);
  assert.equal(target.samples?.length,5);
  for(const [index,[fx,fy]] of [[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]].entries()){
   const sample=target.samples[index];assert.equal(sample.owned,true,`${context}: target is covered by another element`);
   assert.ok(Math.abs(sample.x-r.left-r.width*fx)<.01&&Math.abs(sample.y-r.top-r.height*fy)<.01,`${context}: hit test does not belong to the measured target`);
  }
 }
 return receipt;
}

/** Diagnostic event collection only; never changes an input, focus, history,
 * scroll position, storage or application state. */
export function installMobileInputRecorder(){
 const events=[];
 const record=event=>{
  const target=event.target;
  events.push({type:event.type,key:event.key||null,trusted:event.isTrusted,time:performance.now(),tag:target?.tagName||null,search:!!target?.matches?.('[data-map-search-input]'),field:target?.getAttribute?.('data-filter-field')||null,value:typeof target?.value==='string'?target.value:null});
  if(events.length>128)events.shift();
 };
 const types=['keydown','keyup','input','change','submit'];
 for(const type of types)document.addEventListener(type,record,{capture:true,passive:true});
 return{read:()=>events.slice(),clear:()=>{events.length=0;},stop:()=>{for(const type of types)document.removeEventListener(type,record,true);}};
}

export function inspectMobileFrame(){
 const root=document.querySelector('.explore-layout'),content=document.querySelector('.explore-panel-content'),params=new URLSearchParams(location.search);
 const input=document.querySelector('[data-map-search-input]'),filter=document.querySelector('[data-filter-action="expand"]'),saved=document.querySelector('[data-filter-action="saved"]');
 const active=document.activeElement,r=active?.getBoundingClientRect(),hit=r?document.elementFromPoint(r.left+r.width/2,r.top+r.height/2):null;
 const heading=[...document.querySelectorAll('.explore-panel h1')].find(element=>!element.closest('[hidden]'));
 return{url:location.href,region:params.get('region')||'',route:params.get('route')||'',view:root?.dataset.panelView||'',origin:root?.dataset.routeOrigin||'',sheet:root?.dataset.sheetState||'',title:heading?.textContent?.replace(/\s+/g,' ').trim()||'',query:input?.value??null,busy:content?.getAttribute('aria-busy'),
  filters:{expanded:filter?.getAttribute('aria-expanded')??null,saved:saved?.getAttribute('aria-pressed')??null,summary:filter?.textContent?.replace(/\s+/g,' ').trim()??null},
  values:{difficulty:document.querySelector('[data-filter-field="difficulty"]')?.value??null,duration:document.querySelector('[data-filter-field="duration"]')?.value??null},
  count:Number(document.querySelector('[data-result-count]')?.textContent?.replace(/\D/g,'')||0),
  scroll:{top:content?.scrollTop??0,height:content?.scrollHeight??0,clientHeight:content?.clientHeight??0,page:scrollY},
  cards:[...document.querySelectorAll('.trail-card[data-route-id]')].map(element=>({id:element.dataset.routeId,title:element.querySelector('h3')?.textContent?.trim()||''})),
  savedIds:[...document.querySelectorAll('.saved-card[data-saved-route-id]')].map(element=>element.dataset.savedRouteId),
  save:{pressed:document.querySelector('[data-route-action="save"]')?.getAttribute('aria-pressed')??null,busy:document.querySelector('[data-route-action="save"]')?.getAttribute('aria-busy')??null},
  navigation:[...document.querySelectorAll('[data-mobile-destination]')].map(element=>({id:element.dataset.mobileDestination,text:element.textContent?.trim(),active:element.getAttribute('aria-current')==='page',expanded:element.getAttribute('aria-expanded')})),
  focus:{tag:active?.tagName,search:active===input,field:active?.getAttribute('data-filter-field'),destination:active?.getAttribute('data-mobile-destination'),inMenu:!!active?.closest('#main-navigation'),inHeader:!!active?.closest('.site-header'),inDialog:!!active?.closest('[role="dialog"]'),visible:!!r&&r.width>0&&r.height>0&&r.top>=-1&&r.bottom<=innerHeight+1,unobscured:!!hit&&active.contains(hit)},
  mainInert:[...document.querySelectorAll('main')].every(element=>element.inert),canvasCount:document.querySelectorAll('.atlas-canvas > canvas.tropnik-map-canvas').length,historyLength:history.length};
}

export async function runMobileExperience(cdp,profile,helpers,binding){
 const {loadProfile,evaluate,waitValue,settledSheet,settledMap,mapState,recordedClick,scrollContainer,revealNative,browserBack,freeCanvasPoint,sleep,url}=helpers;
 assert.equal(profile.name,'android-portrait');assert.equal(profile.mobile,true);
 const receipt={schemaVersion:1,passed:false,profile:profile.name,engine:profile.engine,input:'touch',physicalDevice:false,...binding,scenarios:[],targets:[]};
 const inspect=expression=>evaluate(cdp,expression),click=selector=>recordedClick(cdp,selector,profile);
 const read=()=>inspect(`(${inspectMobileFrame.toString()})()`);
 const wait=(label,accept)=>waitValue(label,read,accept);
 const snapshot=async()=>{
  const frame=await read();await settledSheet(cdp,frame.sheet);const map=await settledMap(cdp,profile.engine);
  const document=await cdp.call('DOM.getDocument',{depth:0});
  const node=await cdp.call('DOM.querySelector',{nodeId:document.root.nodeId,selector:'.atlas-canvas > canvas.tropnik-map-canvas'});
  assert.ok(node.nodeId,'Mobile experience lost its canvas');
  const described=await cdp.call('DOM.describeNode',{nodeId:node.nodeId});
  return{...await read(),map,canvasBackendNodeId:described.node.backendNodeId};
 };
 const targets=async(stage,routeId)=>{
  const result=await inspect(`(${inspectMobileTargets.toString()})(${JSON.stringify(stage)},${JSON.stringify(mobileTargetSelectors(stage,routeId))})`);
  assertMobileTargets(result,stage,routeId);receipt.targets.push(result);return result;
 };
 const key=async(value,code,virtualKey)=>{
  const before=await read();await inspect('window.__tropnikMobileInput.clear()');
  const commands=[];
  for(const type of ['keyDown','keyUp']){await cdp.call('Input.dispatchKeyEvent',{type,key:value,code,windowsVirtualKeyCode:virtualKey});commands.push({method:'Input.dispatchKeyEvent',type,key:value,status:'fulfilled'});}
  const events=await waitValue(`Native ${value} key was not delivered`,()=>inspect('window.__tropnikMobileInput.read()'),events=>events.some(event=>event.type==='keyup'&&event.key===value));
  return{key:value,commands,events,before:before.focus,after:(await read()).focus};
 };
 const choose=async(exclude='')=>{
  const candidates=await inspect(`(()=>[...document.querySelectorAll('.trail-card[data-route-id]')].filter(element=>!element.querySelector('.source-status')?.textContent?.includes('Закрыт')).map(element=>({id:element.dataset.routeId,title:element.querySelector('h3')?.textContent?.trim()})))()`);
  const route=candidates.find(value=>value.id&&value.id!==exclude);assert.ok(route,'The mobile experience needs two distinct visible catalogue routes');
  const selector=selectorForRoute(route.id),scrolls=await revealNative(cdp,selector,CONTENT,profile);
  return{...route,selector,scrolls};
 };
 try{
  // A public deep link supplies a repeatable starting region; every change
  // below is delivered through the same UI that a user operates.
  const start=new URL(url);start.searchParams.set('region','altai');await loadProfile(cdp,start.href,profile);
  await inspect(`window.__tropnikMobileInput=(${installMobileInputRecorder.toString()})();true`);
  await wait('Altai list did not become ready',state=>state.region==='altai'&&state.route===''&&state.view==='map');
  const discovery={name:'search-route-return'};receipt.scenarios.push(discovery);
  discovery.launch=await click('.mobile-search-launch');await settledSheet(cdp,'open');
  discovery.focused=await wait('Search launcher did not expose and focus the input',state=>state.focus.search&&state.focus.visible&&state.focus.unobscured);
  await inspect('window.__tropnikMobileInput.clear()');await sendNativeText(cdp,'Алтай',{delayMs:0});
  discovery.typing={method:'Input.dispatchKeyEvent',text:'Алтай',events:await inspect('window.__tropnikMobileInput.read()')};
  await wait('Mobile search did not settle',state=>state.query==='Алтай'&&state.busy==='false'&&state.count>=2);
  discovery.submit=await key('Enter','Enter',13);await wait('Search submit did not release its editing focus',state=>!state.focus.search&&state.query==='Алтай');
  await targets('search');
  discovery.filter={};discovery.filter.opened=await click('[data-filter-action="expand"]');
  await wait('Difficulty filter did not open',state=>state.values.difficulty==='all');
  discovery.filter.tabs=[];
  for(let attempt=0;(await read()).focus.field!=='difficulty';attempt++){
   assert.ok(attempt<4,'Tab did not reach the visible difficulty select');discovery.filter.tabs.push(await key('Tab','Tab',9));
  }
  // A native keyboard selection on the closed select avoids browser-popup
  // automation and exercises the actual change event without setting value.
  discovery.filter.end=await key('End','End',35);discovery.filter.leave=await key('Tab','Tab',9);
  discovery.filter.selected=await wait('Native difficulty selection was not applied',state=>state.values.difficulty==='unknown');
  await targets('filters');discovery.filter.applied=await click('[data-filter-action="apply"]');
  await wait('Filter dialog did not close with results',state=>state.filters.expanded==='false'&&state.values.difficulty===null&&state.count>=2);
  discovery.scroll=await scrollContainer(cdp,CONTENT,profile);
  const routeB=await choose();discovery.route=routeB;discovery.before=await snapshot();
  discovery.selected=await click(routeB.selector);await wait('The selected mobile route did not open',state=>state.route===routeB.id&&state.origin==='catalog');
  discovery.detail=await snapshot();await targets('route');
  assert.equal(discovery.detail.save.pressed,'false','The fixture route must begin unsaved in the isolated browser profile');
  discovery.save=await click('[data-route-action="save"]');await wait('Saving did not finish',state=>state.save.pressed==='true'&&state.save.busy==='false');
  discovery.saved=await snapshot();discovery.showMap=await click('[data-route-action="map"]');await settledSheet(cdp,'closed');
  discovery.onMap=await snapshot();discovery.framing={policy:'automatic-sheet-refit',cameraDelta:Object.fromEntries(['longitude','latitude','zoom'].map(key=>[key,discovery.onMap.map.camera[key]-discovery.saved.map.camera[key]]))};await targets('route-map');
  discovery.back=await browserBack(cdp,{region:'altai',route:'',title:'Алтай',view:'map'});discovery.restored=await snapshot();

  const workspace={name:'saved-map-context'};receipt.scenarios.push(workspace);
  workspace.route=await choose(routeB.id);workspace.before=await snapshot();
  workspace.selected=await click(workspace.route.selector);await wait('The distinct Map route did not open',state=>state.route===workspace.route.id&&state.origin==='catalog');
  workspace.pan={showMap:await click('[data-route-action="map"]')};await settledSheet(cdp,'closed');workspace.pan.before=await snapshot();
  const panStart=await freeCanvasPoint(cdp,workspace.pan.before.map),delta={dx:panStart.x+80<workspace.pan.before.map.rect.right?48:-48,dy:12};
  workspace.pan.input=await observeSmoothnessPan(cdp,panStart,delta,profile,{evaluate,sleep});workspace.pan.after=await snapshot();
  workspace.pan.reopened=await click('.sheet-handle');await settledSheet(cdp,'open');
  workspace.mapBefore=await snapshot();
  workspace.saved={opened:await click(destination('saved'))};await wait('Saved workspace did not open',state=>state.view==='saved'&&state.savedIds.includes(routeB.id));
  workspace.saved.scrolls=await revealNative(cdp,selectorForSaved(routeB.id,'open'),CONTENT,profile);
  workspace.saved.before=await snapshot();await targets('saved',routeB.id);
  workspace.saved.repeat=await click(destination('saved'));workspace.saved.repeated=await snapshot();
  workspace.saved.selected=await click(selectorForSaved(routeB.id,'open'));await wait('Saved opened another route',state=>state.route===routeB.id&&state.view==='map'&&state.origin==='saved');
  workspace.saved.detail=await snapshot();
  workspace.saved.back=await browserBack(cdp,{region:'altai',route:workspace.route.id,title:'Сохранено',view:'saved'});workspace.saved.restored=await snapshot();
  workspace.map=await click(destination('map'));await wait('Map did not restore its own route',state=>state.view==='map'&&state.route===workspace.route.id&&state.origin==='catalog');
  workspace.mapRestored=await snapshot();workspace.repeatMap=await click(destination('map'));workspace.mapRepeated=await snapshot();
  workspace.more={opened:await click(destination('more'))};
  workspace.more.open=await wait('More did not expose its keyboard navigation',state=>state.navigation.find(item=>item.id==='more')?.expanded==='true'&&state.focus.inMenu&&state.focus.visible&&state.mainInert);
  await targets('more');workspace.more.tab=await key('Tab','Tab',9);
  workspace.more.tabbed=await wait('Tab left the visible More navigation',state=>state.focus.inMenu&&state.focus.visible&&state.focus.unobscured);
  workspace.more.escape=await key('Escape','Escape',27);
  await wait('Escape did not close More and return focus',state=>state.navigation.find(item=>item.id==='more')?.expanded==='false'&&state.focus.destination==='more'&&state.focus.visible&&state.focus.unobscured);
  workspace.more.closed=await snapshot();
  workspace.parentScrolls=await revealNative(cdp,'.explore-panel .back-link',CONTENT,profile);workspace.parent=await click('.explore-panel .back-link');
  await wait('Contextual Back did not restore the list',state=>state.route===''&&state.region==='altai');workspace.restored=await snapshot();
  workspace.filterScrolls=await revealNative(cdp,'[data-filter-action="expand"]',CONTENT,profile);
  workspace.filter={opened:await click('[data-filter-action="expand"]')};
  workspace.filter.restored=await wait('Restored difficulty filter did not open',state=>state.values.difficulty!==null);
  workspace.filter.closed=await click('[data-filter-action="apply"]');await wait('Restored filter dialog did not close',state=>state.values.difficulty===null);

  // Clean up only the fixture route created through Save above, using the
  // existing confirmation UI. Later profiles must retain their empty baseline.
  receipt.cleanup={opened:await click(destination('saved'))};await wait('Saved cleanup did not open',state=>state.view==='saved'&&state.savedIds.includes(routeB.id));
  receipt.cleanup.scrolls=await revealNative(cdp,selectorForSaved(routeB.id,'remove'),CONTENT,profile);
  receipt.cleanup.remove=await click(selectorForSaved(routeB.id,'remove'));await waitValue('Saved removal confirmation did not open',()=>inspect('!!document.querySelector(\'[data-saved-action="confirm-remove"]\')'),Boolean);
  receipt.cleanup.confirm=await click('[data-saved-action="confirm-remove"]');
  receipt.cleanup.after=await wait('The fixture card was not removed through the UI',state=>state.view==='saved'&&!state.savedIds.includes(routeB.id));
  receipt.cleanup.returned=await click(destination('map'));await wait('Cleanup did not return to Map',state=>state.view==='map');
  receipt.performance=await inspect('({layoutShift:window.__tropnikPerf?.cls||0,longestTaskMs:window.__tropnikPerf?.longest||0})');
  assertMobileExperience({...receipt,passed:true},binding);receipt.passed=true;return receipt;
 }catch(error){
  try{receipt.lastFrame={...await read(),map:await mapState(cdp)};}catch{}
  error.mobileExperience=receipt;throw error;
 }finally{try{await inspect('window.__tropnikMobileInput?.stop();delete window.__tropnikMobileInput');}catch{}}
}

function assertFrame(frame,context){
 assert.ok(frame&&typeof frame.url==='string');const url=new URL(frame.url);
 assert.equal(url.searchParams.get('region')||'',frame.region);assert.equal(url.searchParams.get('route')||'',frame.route);
 assert.ok(['map','saved'].includes(frame.view));assert.ok(['catalog','saved'].includes(frame.origin));assert.ok(['closed','open'].includes(frame.sheet));
 assert.equal(frame.canvasCount,1,`${context}: duplicate or missing map canvas`);assert.ok(Number.isInteger(frame.canvasBackendNodeId)&&frame.canvasBackendNodeId>0);
 assert.equal(frame.map?.engine,'tropnik-canvas');assert.equal(frame.map.moving,false);assert.equal(frame.map.visible,true);
 assert.ok(['longitude','latitude','zoom','tileSize'].every(key=>Number.isFinite(frame.map.camera?.[key])));assert.equal(frame.map.camera.tileSize,256);
 assert.ok(['top','height','clientHeight','page'].every(key=>Number.isFinite(frame.scroll?.[key])));
 assert.ok(frame.scroll.top>=-1&&frame.scroll.height>=frame.scroll.clientHeight&&frame.scroll.clientHeight>0);
 assert.deepEqual(frame.navigation?.map(item=>[item.id,item.text]),NAV);
 const active=frame.navigation.filter(item=>item.active);assert.equal(active.length,1,`${context}: primary destination is ambiguous`);
 assert.equal(active[0].id,frame.view==='saved'||frame.origin==='saved'&&frame.route?'saved':'map');
}
function assertCamera(before,after,context){
 const center=projectMapPoint([before.camera.longitude,before.camera.latitude],after.camera,after.rect);
 assert.ok(Math.hypot(center.x-(after.rect.left+after.rect.width/2),center.y-(after.rect.top+after.rect.height/2))<=1,`${context}: returning moved the map center`);
 assert.ok(Math.abs(before.camera.zoom-after.camera.zoom)<=.001,`${context}: returning changed map zoom`);
}
function assertContext(before,after,context,{history=false,camera=true}={}){
 assertFrame(before,`${context}/before`);assertFrame(after,`${context}/after`);
 for(const key of ['region','route','view','origin','sheet','title','query','url'])assert.equal(after[key],before[key],`${context}: ${key} was lost`);
 assert.deepEqual(after.filters,before.filters,`${context}: visible filters changed`);assert.equal(after.count,before.count);assert.deepEqual(after.cards,before.cards);
 assert.ok(Math.abs(after.scroll.top-before.scroll.top)<=1,`${context}: list position was lost`);assert.ok(Math.abs(after.scroll.page-before.scroll.page)<=1,`${context}: page scrolled`);
 assert.equal(after.canvasBackendNodeId,before.canvasBackendNodeId,`${context}: navigation remounted the map`);if(camera)assertCamera(before.map,after.map,context);
 if(history)assert.equal(after.historyLength,before.historyLength,`${context}: repeated current destination pushed history`);
}
function assertKey(receipt,key,context){
 assert.equal(receipt?.key,key);assert.deepEqual(receipt.commands?.map(command=>[command.method,command.type,command.key,command.status]),['keyDown','keyUp'].map(type=>['Input.dispatchKeyEvent',type,key,'fulfilled']));
 assert.ok(Array.isArray(receipt.events)&&receipt.events.length>=2&&receipt.events.length<=128);
 const events=receipt.events.filter(event=>['keydown','keyup'].includes(event.type));
 assert.deepEqual(events.map(event=>[event.type,event.key]),[['keydown',key],['keyup',key]],`${context}: native key events are missing`);
 for(const event of receipt.events){assert.equal(event.trusted,true,`${context}: synthetic keyboard event`);assert.ok(Number.isFinite(event.time));}
}
function assertBack(receipt,before,after,context){
 assert.equal(receipt?.method,'Page.navigateToHistoryEntry');assert.ok(Number.isInteger(receipt.from?.id)&&Number.isInteger(receipt.target?.id));assert.notEqual(receipt.from.id,receipt.target.id);
 assert.equal(receipt.from.url,before.url);assert.equal(receipt.target.url,after.url);assert.equal(receipt.url,after.url);
 for(const key of ['region','route','view','title'])assert.equal(receipt.after[key],after[key],`${context}: browser Back restored another ${key}`);
}

export function assertMobileExperience(receipt,binding={}){
 assert.equal(receipt?.schemaVersion,1);assert.equal(receipt.passed,true);assert.equal(receipt.profile,'android-portrait');assert.equal(receipt.engine,'tropnik-canvas');assert.equal(receipt.input,'touch');assert.equal(receipt.physicalDevice,false);
 assert.match(receipt.sourceCommit||'',/^[a-f0-9]{40}$/);assert.match(receipt.buildId||'',/^[a-f0-9]{16}$/);
 if(binding.sourceCommit!==undefined)assert.equal(receipt.sourceCommit,binding.sourceCommit);
 if(binding.buildId!==undefined)assert.equal(receipt.buildId,binding.buildId);
 assert.deepEqual(Object.keys(receipt.sources||{}).sort(),[...MOBILE_EXPERIENCE_SOURCES].sort());
 for(const path of MOBILE_EXPERIENCE_SOURCES){assert.match(receipt.sources[path],/^[a-f0-9]{64}$/);if(binding.sources)assert.equal(receipt.sources[path],binding.sources[path],`Mobile UX proof belongs to another input: ${path}`);}
 assert.deepEqual(receipt.scenarios?.map(item=>item.name),['search-route-return','saved-map-context']);
 const [search,workspace]=receipt.scenarios,click=(value,selector,context)=>assertExperienceClick(value,'touch',context,selector);
 click(search.launch,'.mobile-search-launch','mobile/search-launch');assert.equal(search.focused.focus.search,true);assert.equal(search.focused.focus.visible,true);assert.equal(search.focused.focus.unobscured,true);
 assert.equal(search.typing?.method,'Input.dispatchKeyEvent');assert.equal(search.typing.text,'Алтай');
 assert.ok(Array.isArray(search.typing.events)&&search.typing.events.length>0&&search.typing.events.length<=128);
 for(const event of search.typing.events){assert.equal(event.trusted,true);assert.equal(event.search,true);}
 assert.deepEqual(search.typing.events.filter(event=>event.type==='keydown').map(event=>event.key),[...'Алтай']);
 assert.deepEqual(search.typing.events.filter(event=>event.type==='keyup').map(event=>event.key),[...'Алтай']);
 assert.equal(search.typing.events.filter(event=>event.type==='input').at(-1)?.value,'Алтай');assertKey(search.submit,'Enter','mobile/search-submit');
 assert.equal(search.submit.before.search,true);assert.equal(search.submit.after.search,false);assert.ok(search.submit.events.some(event=>event.type==='submit'));
 click(search.filter.opened,'[data-filter-action="expand"]','mobile/filter-open');assert.ok(Array.isArray(search.filter.tabs)&&search.filter.tabs.length>=1&&search.filter.tabs.length<=4);
 for(const tab of search.filter.tabs){assertKey(tab,'Tab','mobile/difficulty-tab');assert.equal(tab.after.inDialog,true);assert.equal(tab.after.visible,true);assert.equal(tab.after.unobscured,true);}
 assert.equal(search.filter.tabs.at(-1).after.field,'difficulty');assertKey(search.filter.end,'End','mobile/difficulty-end');assert.equal(search.filter.end.before.field,'difficulty');assertKey(search.filter.leave,'Tab','mobile/difficulty-leave');assert.equal(search.filter.leave.after.field,'duration');assert.ok([...search.filter.end.events,...search.filter.leave.events].some(event=>['input','change'].includes(event.type)&&event.field==='difficulty'&&event.value==='unknown'),'Mobile difficulty needs its delivered native change event');assert.equal(search.filter.selected.values.difficulty,'unknown');assert.equal(search.filter.selected.values.duration,'any');
 click(search.filter.applied,'[data-filter-action="apply"]','mobile/filter-apply');
 assertExperienceScrolls([search.scroll],'touch','mobile/list-scroll');assert.ok(search.scroll.after.scrollTop-search.scroll.before.scrollTop>=24);
 assertExperienceScrolls(search.route?.scrolls,'touch','mobile/route-reveal');assert.ok(search.route.id&&search.route.title);
 click(search.selected,selectorForRoute(search.route.id),'mobile/route-open');
 for(const frame of [search.before,search.detail,search.saved,search.onMap,search.restored])assertFrame(frame,'mobile/search-route');
 assert.equal(search.before.query,'Алтай');assert.equal(search.before.filters.saved,'false');assert.equal(search.before.filters.expanded,'false');assert.ok(search.before.count>=2);
 assert.equal(search.detail.route,search.route.id);assert.equal(search.detail.title,search.route.title);assert.equal(search.detail.save.pressed,'false');
 click(search.save,'[data-route-action="save"]','mobile/save');assert.equal(search.saved.route,search.route.id);assert.equal(search.saved.save.pressed,'true');assert.equal(search.saved.save.busy,'false');
 click(search.showMap,'[data-route-action="map"]','mobile/show-map');assert.equal(search.onMap.sheet,'closed');assert.equal(search.onMap.route,search.route.id);
 assert.equal(search.onMap.map.route,search.route.id);assert.equal(search.onMap.map.rendering?.painted,true);assert.equal(search.onMap.map.rendering?.drawnRoute,search.route.id);assert.equal(search.onMap.map.rendering?.coverageReady,true);assert.equal(search.onMap.map.rendering?.tilesState,'ready');
 assert.equal(search.framing?.policy,'automatic-sheet-refit');for(const key of ['longitude','latitude','zoom'])assert.equal(search.framing.cameraDelta?.[key],search.onMap.map.camera[key]-search.saved.map.camera[key],'ShowMap must record its automatic camera change honestly');
 assertBack(search.back,search.onMap,search.restored,'mobile/route-back');assertContext(search.before,search.restored,'mobile/search-return');
 assert.ok(workspace.route?.id&&workspace.route.id!==search.route.id,'Saved context must be tested with a different Map route');
 assertExperienceScrolls(workspace.route.scrolls,'touch','mobile/second-route-reveal');click(workspace.selected,selectorForRoute(workspace.route.id),'mobile/second-route');
 click(workspace.pan?.showMap,'[data-route-action="map"]','mobile/manual-map');assertFrame(workspace.pan.before,'mobile/pan-before');assertFrame(workspace.pan.after,'mobile/pan-after');
 assert.equal(workspace.pan.before.route,workspace.route.id);assert.equal(workspace.pan.after.route,workspace.route.id);assert.equal(workspace.pan.before.sheet,'closed');assert.equal(workspace.pan.after.sheet,'closed');
 assertSourceEndPanInput(workspace.pan.input,'touch','mobile/manual-pan');assert.ok(Math.abs(workspace.pan.after.map.camera.zoom-workspace.pan.before.map.camera.zoom)<=.001,'Mobile context pan changed zoom');
 const panned=projectMapPoint([workspace.pan.before.map.camera.longitude,workspace.pan.before.map.camera.latitude],workspace.pan.after.map.camera,workspace.pan.after.map.rect);
 assert.ok(Math.hypot(panned.x-workspace.pan.after.map.rect.left-workspace.pan.after.map.rect.width/2,panned.y-workspace.pan.after.map.rect.top-workspace.pan.after.map.rect.height/2)>=8,'Map context needs an actual manually moved camera');
 click(workspace.pan.reopened,'.sheet-handle','mobile/manual-map-reopen');assertCamera(workspace.pan.after.map,workspace.mapBefore.map,'mobile/manual-camera-after-sheet');
 assertFrame(workspace.mapBefore,'mobile/map-before');assert.equal(workspace.mapBefore.route,workspace.route.id);
 const saved=workspace.saved;click(saved.opened,destination('saved'),'mobile/saved');assertFrame(saved.before,'mobile/saved-before');assert.equal(saved.before.view,'saved');assert.ok(saved.before.savedIds.includes(search.route.id));
 assertExperienceScrolls(saved.scrolls,'touch','mobile/saved-reveal');click(saved.repeat,destination('saved'),'mobile/saved-repeat');assertContext(saved.before,saved.repeated,'mobile/repeated-saved',{history:true});
 click(saved.selected,selectorForSaved(search.route.id,'open'),'mobile/saved-open');assertFrame(saved.detail,'mobile/saved-route');assert.equal(saved.detail.route,search.route.id);assert.equal(saved.detail.origin,'saved');
 assertBack(saved.back,saved.detail,saved.restored,'mobile/saved-back');assertContext(saved.before,saved.restored,'mobile/saved-return',{camera:false});
 click(workspace.map,destination('map'),'mobile/map-return');assertContext(workspace.mapBefore,workspace.mapRestored,'mobile/map-context');
 click(workspace.repeatMap,destination('map'),'mobile/map-repeat');assertContext(workspace.mapRestored,workspace.mapRepeated,'mobile/repeated-map',{history:true});
 click(workspace.more.opened,destination('more'),'mobile/more');assert.equal(workspace.more.open.mainInert,true);assert.equal(workspace.more.open.focus.inMenu,true);
 assertKey(workspace.more.tab,'Tab','mobile/more-tab');assert.equal(workspace.more.tabbed.focus.inMenu,true);assert.equal(workspace.more.tabbed.focus.visible,true);assert.equal(workspace.more.tabbed.focus.unobscured,true);
 assertKey(workspace.more.escape,'Escape','mobile/more-escape');assert.equal(workspace.more.closed.focus.destination,'more');assert.equal(workspace.more.closed.focus.visible,true);assert.equal(workspace.more.closed.focus.unobscured,true);assert.equal(workspace.more.closed.mainInert,false);
 assertContext(workspace.mapRepeated,workspace.more.closed,'mobile/more-close',{history:true});
 assertExperienceScrolls(workspace.parentScrolls,'touch','mobile/parent-reveal');click(workspace.parent,'.explore-panel .back-link','mobile/parent');assertContext(workspace.before,workspace.restored,'mobile/final-list-return');
 assertExperienceScrolls(workspace.filterScrolls,'touch','mobile/filter-reveal');click(workspace.filter.opened,'[data-filter-action="expand"]','mobile/restored-filter-open');assert.equal(workspace.filter.restored.values.difficulty,'unknown');assert.equal(workspace.filter.restored.values.duration,'any');click(workspace.filter.closed,'[data-filter-action="apply"]','mobile/restored-filter-close');
 const frames=[search.before,search.detail,search.saved,search.onMap,search.restored,workspace.before,workspace.pan.before,workspace.pan.after,workspace.mapBefore,saved.before,saved.repeated,saved.detail,saved.restored,workspace.mapRestored,workspace.mapRepeated,workspace.more.closed,workspace.restored];
 for(const frame of frames)assert.equal(frame.canvasBackendNodeId,search.before.canvasBackendNodeId,'Mobile navigation replaced the single map canvas');
 assert.deepEqual(receipt.targets?.map(item=>item.stage),['search','filters','route','route-map','saved','more']);for(const target of receipt.targets)assertMobileTargets(target,target.stage,search.route.id);
 click(receipt.cleanup?.opened,destination('saved'),'mobile/cleanup-saved');assertExperienceScrolls(receipt.cleanup.scrolls,'touch','mobile/cleanup-reveal');click(receipt.cleanup.remove,selectorForSaved(search.route.id,'remove'),'mobile/cleanup-remove');click(receipt.cleanup.confirm,'[data-saved-action="confirm-remove"]','mobile/cleanup-confirm');assert.ok(!receipt.cleanup.after.savedIds.includes(search.route.id));click(receipt.cleanup.returned,destination('map'),'mobile/cleanup-map');
 assert.ok(Number.isFinite(receipt.performance?.layoutShift)&&Number.isFinite(receipt.performance?.longestTaskMs));
 return receipt;
}
