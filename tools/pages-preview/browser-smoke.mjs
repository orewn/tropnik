import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile, rename, writeFile, stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, normalize, extname} from 'node:path';
import {projectMapPoint,unprojectMapPoint,pointInPolygonGeometry} from './map-projection.mjs';
import {runZoomDesignAudit,settleMapCamera,mapCameraIsMoving,browserAuditRunPolicy} from './browser-zoom-audit.mjs';
import {browserTraceEnabled,traceDesktopSelection,recordBrowserLongTask} from './browser-trace.mjs';
import {launchBrowser,browserErrorDetails} from './browser-startup.mjs';
import {directionHitGrid,directionExternalPoint,inspectDirectionHitAreas} from './browser-direction-hitareas.mjs';
import {dispatchSourceEndPan} from './browser-source-end-pan.mjs';
import {runOfflineSafetyAudit} from './browser-offline-safety.mjs';
import {assertDirectionHitGrid,assertDirectionHitAreas,assertNativeBurstEventOrder,assertLayerMenuAudit,assertOverviewCounts,assertExploreExperience,assertStyleCameraRoundtrip} from './browser-report.mjs';

const ROOT = new URL('../../web/pages-preview/dist/', import.meta.url);
const runPolicy=browserAuditRunPolicy(process.env.TROPNIK_BROWSER_DIAGNOSTIC);
const traceEnabled=browserTraceEnabled(process.env.TROPNIK_BROWSER_TRACE,runPolicy.diagnostic);
const REPORT = new URL(runPolicy.reportFile, ROOT);
const profiles = [
  {name:'compact-android',width:320,height:640,mobile:true,engine:'leaflet'},
  {name:'iphone-portrait',width:390,height:844,mobile:true,engine:'leaflet'},
  {name:'android-portrait',width:412,height:915,mobile:true,engine:'leaflet',mapInteraction:true},
  {name:'phone-landscape',width:844,height:390,mobile:true,engine:'leaflet'},
  {name:'desktop-webgl',width:1440,height:1000,mobile:false,engine:'maplibre',mapInteraction:true},
];
const catalogSources=await Promise.all(['catalog.generated.json','yandex-routes.generated.json','discovery-routes.generated.json','russiadiscovery-east.generated.json','telegram-reviewed.generated.json'].map(async name=>JSON.parse(await readFile(new URL(`../../web/lib/${name}`,import.meta.url),'utf8'))));
const mapTrails=catalogSources.flatMap(source=>Array.isArray(source)?source:source.routes||[]).map(trail=>{
 let current=trail;for(const source of catalogSources)if(source.updatesByRouteId?.[trail.id])current={...current,...source.updatesByRouteId[trail.id],id:trail.id};return current;
}).filter(trail=>Array.isArray(trail.center)&&trail.center.length===2);
const administrativeFeatures=JSON.parse(await readFile(new URL('../../web/public/data/territories.geojson',import.meta.url),'utf8')).features;
const territoryRecords=JSON.parse(await readFile(new URL('../../web/lib/territories.generated.json',import.meta.url),'utf8')).territories;
const mime = new Map([
  ['.html','text/html; charset=utf-8'],['.js','text/javascript; charset=utf-8'],['.css','text/css; charset=utf-8'],
  ['.json','application/json; charset=utf-8'],['.svg','image/svg+xml'],['.png','image/png'],['.woff','font/woff'],
  ['.woff2','font/woff2'],['.pbf','application/x-protobuf'],['.geojson','application/geo+json'],['.apk','application/vnd.android.package-archive'],
]);

function freePort(){
  return new Promise((resolve,reject)=>{
    const server=createNetServer();
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{const address=server.address();const port=typeof address==='object'&&address?address.port:0;server.close(error=>error?reject(error):resolve(port));});
  });
}
function browserBinary(){
  for(const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser']){
    if(spawnSync('which',[name],{stdio:'ignore'}).status===0)return name;
  }
  throw new Error('No Chromium-compatible browser is installed on the runner');
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function serve(rootUrl){
  return createServer(async(request,response)=>{
    try{
      const url=new URL(request.url||'/', 'http://127.0.0.1');
      let path=decodeURIComponent(url.pathname);
      if(path==='/tropnik')path='/tropnik/';
      if(!path.startsWith('/tropnik/')){response.writeHead(404);response.end('Not found');return;}
      path=path.slice('/tropnik/'.length);
      if(!path||path.endsWith('/'))path+='index.html';
      const safe=normalize(path).replace(/^([.][.][/\\])+/, '');
      let target=new URL(safe,rootUrl);
      let info;
      try{info=await stat(target);}catch{info=undefined;}
      if(info?.isDirectory())target=new URL('index.html',target.href.endsWith('/')?target:new URL(`${target.href}/`));
      const body=await readFile(target);
      response.writeHead(200,{'content-type':mime.get(extname(target.pathname))||'application/octet-stream','cache-control':'no-store'});
      response.end(body);
    }catch{
      try{const body=await readFile(new URL('404.html',rootUrl));response.writeHead(404,{'content-type':'text/html; charset=utf-8'});response.end(body);}
      catch{response.writeHead(404);response.end('Not found');}
    }
  });
}
class CDP{
  constructor(url){this.url=url;this.next=1;this.pending=new Map();this.listeners=new Map();this.observers=new Map();}
  async open(){
    this.socket=new WebSocket(this.url);
    await new Promise((resolve,reject)=>{this.socket.addEventListener('open',resolve,{once:true});this.socket.addEventListener('error',reject,{once:true});});
    this.socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.id){const waiter=this.pending.get(message.id);if(!waiter)return;this.pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);return;}
      for(const observer of this.observers.get(message.method)||[])observer(message.params);
      const waiters=this.listeners.get(message.method);if(!waiters?.length)return;
      this.listeners.set(message.method,[]);for(const waiter of waiters)waiter(message.params);
    });
  }
  call(method,params={},timeout=15000){
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Timed out waiting for CDP ${method}`));},timeout);
      this.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      this.socket.send(JSON.stringify({id,method,params}));
    });
  }
  event(method,timeout=15000){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${method}`)),timeout);
      const wrapped=value=>{clearTimeout(timer);resolve(value);};
      this.listeners.set(method,[...(this.listeners.get(method)||[]),wrapped]);
    });
  }
  observe(method,observer){
    const observers=this.observers.get(method)||new Set();observers.add(observer);this.observers.set(method,observers);
    return()=>{observers.delete(observer);if(!observers.size)this.observers.delete(method);};
  }
  close(){this.socket?.close();}
}
async function evaluate(cdp,expression){
  const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'Browser evaluation failed');
  return result.result.value;
}
async function diagnosticPhase(cdp,name){
  return evaluate(cdp,`(()=>{
    const name=${JSON.stringify(name)},box=selector=>{const element=document.querySelector(selector);if(!element)return null;const r=element.getBoundingClientRect(),s=getComputedStyle(element);return{x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,transform:s.transform};};
    const state={name,time:performance.now(),perf:{...window.__tropnikPerf},fonts:document.fonts?.status,sheet:document.querySelector('.explore-layout')?.dataset.sheetState,story:box('.fact-card'),storyPhoto:box('.fact-photo'),panel:box('.explore-panel'),canvas:box('.atlas-canvas'),firstDirection:box('.region-marker:not([hidden])'),attribution:box('.map-attribution'),mapMessage:box('.map-message')};
    window.__tropnikPhase=name;performance.mark('tropnik:'+name);window.__tropnikPhases.push(state);if(window.__tropnikPhases.length>32)window.__tropnikPhases.shift();return state;
  })()`);
}
async function performanceDiagnostics(cdp){
  return evaluate(cdp,'({timeOrigin:performance.timeOrigin,current:window.__tropnikPerf,counterStart:window.__tropnikPerfStart,phase:window.__tropnikPhase,phases:window.__tropnikPhases,layoutShifts:window.__tropnikLayoutShifts,recentLongTasks:window.__tropnikLongTasks,expectedPointer:window.__tropnikExpectedPointer,inputEvents:window.__tropnikInputEvents})');
}
async function loadProfile(cdp,url,profile){
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:profile.width,height:profile.height,deviceScaleFactor:profile.mobile?2:1,mobile:profile.mobile,screenWidth:profile.width,screenHeight:profile.height});
  await cdp.call('Emulation.setTouchEmulationEnabled',profile.mobile?{enabled:true,maxTouchPoints:5}:{enabled:false});
  const loaded=cdp.event('Page.loadEventFired');
  await cdp.call('Page.navigate',{url});
  await loaded;
  for(let attempt=0;attempt<80;attempt++){
    const ready=await evaluate(cdp,`document.readyState==='complete'&&!!document.querySelector('.explore-layout')`);
    if(ready)break;
    if(attempt===79)throw new Error(`${profile.name}: application did not mount`);
    await sleep(100);
  }
  await sleep(1800);
  await settledMap(cdp,profile.engine);
  await evaluate(cdp,`window.__tropnikPerf={cls:0,longest:0};window.__tropnikPerfStart=performance.now()`);
  await diagnosticPhase(cdp,'profile-ready');
  return evaluate(cdp,`(()=>{
    const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&rect.width>1&&rect.height>1};
    const atlas=document.querySelector('.atlas-wrap')?.getBoundingClientRect();
    const labels=[...document.querySelectorAll('.region-marker-label')].filter(visible).map(element=>{const r=element.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,text:element.textContent}});
    const targetSelector='.fact-controls button,.fact-dismiss,.fact-story-toggle,.map-controls button,.map-style-switch button,.layer-button';
    const targets=[...document.querySelectorAll(targetSelector)].filter(visible).map(element=>{const r=element.getBoundingClientRect();return{label:element.getAttribute('aria-label')||element.textContent?.trim(),width:r.width,height:r.height}});
    const card=document.querySelector('.fact-card')?.getBoundingClientRect();
    return{
      width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,engine:document.querySelector('.leaflet-container')?'leaflet':document.querySelector('.maplibregl-map')?'maplibre':'unknown',
      escaping:atlas?labels.filter(label=>label.left<atlas.left-1||label.right>atlas.right+1||label.top<atlas.top-1||label.bottom>atlas.bottom+1):[],
      undersized:targets.filter(target=>target.width<43.5||target.height<43.5),
      card:card?{left:card.left,right:card.right,top:card.top,bottom:card.bottom}:null,
    };
  })()`);
}
async function tapSelector(cdp,selector,id=1){
  const point=await evaluate(cdp,`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const r=element.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if(!point)return false;
  await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id,radiusX:2,radiusY:2,force:1}]});
  await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  return true;
}
async function sheetSnapshot(cdp){
  return evaluate(cdp,`(()=>{
    const visible=element=>{if(!element)return false;const style=getComputedStyle(element),r=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&r.width>1&&r.height>1};
    const root=document.querySelector('.explore-layout'),panel=document.querySelector('.explore-panel'),handle=document.querySelector('.sheet-handle'),summary=document.querySelector('.sheet-peek-summary'),content=document.querySelector('.explore-panel-content');
    if(!root||!panel||!handle)return{available:false};
    const rect=panel.getBoundingClientRect();
    return{available:true,state:root.dataset.sheetState,height:rect.height,top:rect.top,transform:getComputedStyle(panel).transform,animating:panel.getAnimations().some(animation=>animation.playState==='running'||animation.pending),summaryVisible:visible(summary),contentVisible:visible(content),focused:document.activeElement===handle,dragging:root.dataset.sheetDragging==='true'||panel.dataset.sheetDragging==='true',scrollY:window.scrollY,contentScrollTop:content?.scrollTop||0,contentScrollHeight:content?.scrollHeight||0,contentClientHeight:content?.clientHeight||0};
  })()`);
}
async function settledSheet(cdp,state){
  let previous,stable=0;
  for(let attempt=0;attempt<60;attempt++){
    const current=await sheetSnapshot(cdp);
    if(!current.available)return current;
    const stopped=current.state===state&&!current.animating&&previous?.state===state&&Math.abs(current.top-previous.top)<.25&&Math.abs(current.height-previous.height)<.25&&current.transform===previous.transform;
    stable=stopped?stable+1:0;
    if(stable>=2)return current;
    previous=current;
    await sleep(50);
  }
  throw new Error(`The ${state} sheet did not settle: ${JSON.stringify(previous)}`);
}
async function touchSheet(cdp){
  let closed=await sheetSnapshot(cdp);
  if(!closed.available)return{available:false};
  if(closed.state!=='closed'){
    assert.equal(await tapSelector(cdp,'.sheet-handle',7),true);
  }
  closed=await settledSheet(cdp,'closed');
  assert.equal(await tapSelector(cdp,'.sheet-handle',8),true);
  const open=await settledSheet(cdp,'open');
  assert.ok(Math.abs(open.scrollY-closed.scrollY)<=1,'Tapping the sheet handle scrolled the page while opening');
  assert.equal(await tapSelector(cdp,'.sheet-handle',9),true);
  const final=await settledSheet(cdp,'closed');
  assert.ok(Math.abs(final.scrollY-closed.scrollY)<=1,'Tapping the sheet handle scrolled the page while closing');
  const perf=await evaluate(cdp,`(()=>({cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0}))()`);
  return{available:true,closed,open,final,heightDelta:Math.max(Math.abs(open.height-closed.height),Math.abs(final.height-closed.height)),cls:perf.cls,longest:perf.longest};
}
async function compositorFrame(cdp){
  // Inspect rendered geometry after the input has reached a compositor frame.
  // This waits for paint; it never calls application gesture callbacks.
  await evaluate(cdp,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function dragSheetHandle(cdp,profile,baseline,{name,from,to,progress,cancel=false}){
  const before=await settledSheet(cdp,from),target=await elementPoint(cdp,'.sheet-handle');
  assert.ok(target?.unobscured,`${profile.name}: ${name} handle is not reachable`);
  const travel=baseline.closed.top-baseline.open.top;
  assert.ok(travel>60,`${profile.name}: sheet has no usable drag travel (${travel}px)`);
  const direction=from==='closed'?-1:1,id=71,samples=[];
  await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:target.x,y:target.y,id,radiusX:3,radiusY:3,force:1}]});
  let lastY=target.y;
  for(const fraction of progress){
    lastY=target.y+direction*travel*fraction;
    assert.ok(lastY>=1&&lastY<profile.height,`${profile.name}: ${name} pointer left the viewport`);
    await cdp.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:target.x,y:lastY,id,radiusX:3,radiusY:3,force:1}]});
    await compositorFrame(cdp);
    const actual=await sheetSnapshot(cdp),expectedTop=before.top+direction*travel*fraction;
    const trackingErrorPx=Math.abs(actual.top-expectedTop),pageScrollDeltaPx=Math.abs(actual.scrollY-before.scrollY);
    samples.push({fraction,fingerY:lastY,panelTop:actual.top,expectedTop,trackingErrorPx,pageScrollDeltaPx});
    assert.ok(trackingErrorPx<=3,`${profile.name}: ${name} sheet does not follow the finger: ${JSON.stringify(samples.at(-1))}`);
    assert.ok(pageScrollDeltaPx<=1,`${profile.name}: ${name} scrolled the whole page instead of the handle`);
    assert.ok(Math.abs(actual.height-before.height)<1.1,`${profile.name}: ${name} changed panel layout height while dragging`);
  }
  await cdp.call('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});
  const settled=await settledSheet(cdp,to);
  // A delayed compatibility click must not toggle the sheet back after a drag.
  await sleep(350);
  const after=await sheetSnapshot(cdp);
  assert.equal(after.state,to,`${profile.name}: ${name} generated a ghost toggle after release`);
  assert.equal(after.dragging,false,`${profile.name}: ${name} retained its drag capture state`);
  assert.ok(Math.abs(after.top-settled.top)<1,`${profile.name}: ${name} moved again after settling`);
  assert.ok(Math.abs(after.scrollY-before.scrollY)<=1,`${profile.name}: ${name} moved the page`);
  return{name,from,to,cancelled:cancel,passed:true,input:'touch',samples,maxTrackingErrorPx:Math.max(...samples.map(sample=>sample.trackingErrorPx)),pageScrollDeltaPx:Math.abs(after.scrollY-before.scrollY),heightDelta:Math.abs(after.height-before.height),draggingCleared:!after.dragging};
}
async function scrollSheetContent(cdp,profile,{stableExtent=false}={}){
  const before=await settledSheet(cdp,'open'),selection=await selectionState(cdp);
  const area=await evaluate(cdp,`(()=>{const element=document.querySelector('.explore-panel-content'),r=element.getBoundingClientRect(),y=Math.min(r.bottom,innerHeight)-32,x=r.left+r.width/2,hit=document.elementFromPoint(x,y);return{x,y,distance:Math.min(140,y-Math.max(r.top,0)-32),unobscured:!!hit&&element.contains(hit),scrollTop:element.scrollTop,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight};})()`);
  assert.ok(area.unobscured&&area.distance>=48,`${profile.name}: the list has no native swipe area: ${JSON.stringify(area)}`);
  assert.ok(area.scrollHeight-area.clientHeight-area.scrollTop>40,`${profile.name}: the catalogue has no scrollable content`);
  const id=72;
  await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:area.x,y:area.y,id,radiusX:3,radiusY:3,force:1}]});
  for(let step=1;step<=8;step++){
    await cdp.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:area.x,y:area.y-area.distance*step/8,id,radiusX:3,radiusY:3,force:1}]});
    await sleep(30);
  }
  // Stop inside the list before releasing. Scroll chaining at its boundary is
  // intentional; this case verifies ownership of a gesture within the list.
  await sleep(100);
  await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  let previous=-1,stable=0;
  const after=await waitValue(`${profile.name}: native list scrolling did not settle`,()=>sheetSnapshot(cdp),current=>{
    stable=Math.abs(current.contentScrollTop-previous)<.5?stable+1:0;previous=current.contentScrollTop;return stable>=3;
  },4000);
  const deltaPx=after.contentScrollTop-before.contentScrollTop,pageScrollDeltaPx=Math.abs(after.scrollY-before.scrollY),sheetDisplacementPx=Math.abs(after.top-before.top);
  assert.ok(deltaPx>=24,`${profile.name}: swiping the catalogue did not scroll it (${deltaPx}px)`);
  assert.equal(after.state,'open',`${profile.name}: list scrolling collapsed the sheet`);
  assert.ok(pageScrollDeltaPx<=1,`${profile.name}: the list swipe scrolled the whole page`);
  assert.ok(sheetDisplacementPx<=1,`${profile.name}: list scrolling dragged the sheet`);
  const scrollHeightDelta=Math.abs(after.contentScrollHeight-before.contentScrollHeight);
  if(stableExtent)assert.ok(scrollHeightDelta<=1,`${profile.name}: route cards changed the scrollbar extent during a swipe (${scrollHeightDelta}px)`);
  await expectSelection(cdp,{region:selection.region,route:selection.route,title:selection.title});
  return{passed:true,input:'touch',before:before.contentScrollTop,after:after.contentScrollTop,deltaPx,pageScrollDeltaPx,sheetDisplacementPx,scrollHeightBefore:before.contentScrollHeight,scrollHeightAfter:after.contentScrollHeight,scrollHeightDelta,selectionPreserved:true};
}
async function touchSheetGestures(cdp,profile,baseline){
  const initial=await selectionState(cdp),drags=[];
  drags.push(await dragSheetHandle(cdp,profile,baseline,{name:'open',from:'closed',to:'open',progress:[.15,.35,.55,.75,1]}));
  const scroll=await scrollSheetContent(cdp,profile);
  drags.push(await dragSheetHandle(cdp,profile,baseline,{name:'close',from:'open',to:'closed',progress:[.15,.35,.55,.75,1]}));
  const reversal=await dragSheetHandle(cdp,profile,baseline,{name:'reverse',from:'closed',to:'closed',progress:[.2,.5,.75,.5,.2,.05]});
  const cancelled=await dragSheetHandle(cdp,profile,baseline,{name:'cancel',from:'closed',to:'closed',progress:[.2,.45],cancel:true});
  await pointerSelector(cdp,'.sheet-handle',profile);
  const recovered=await settledSheet(cdp,'open');
  assert.ok(Math.abs(recovered.contentScrollTop-scroll.after)<=1,`${profile.name}: opening the sheet lost the list position`);
  await pointerSelector(cdp,'.sheet-handle',profile);await settledSheet(cdp,'closed');
  drags.push(await dragSheetHandle(cdp,profile,baseline,{name:'open-again',from:'closed',to:'open',progress:[.2,.5,.8,1]}));
  drags.push(await dragSheetHandle(cdp,profile,baseline,{name:'close-again',from:'open',to:'closed',progress:[.2,.5,.8,1]}));
  await pointerSelector(cdp,'.sheet-handle',profile);await settledSheet(cdp,'open');
  await pointerSelector(cdp,'.sheet-handle',profile);const final=await settledSheet(cdp,'closed');
  await expectSelection(cdp,{region:initial.region,route:initial.route,title:initial.title});
  return{passed:true,input:'touch',drags,reversal,cancelled,scroll,tapAfterCancel:true,tapAfterDrag:true,listPositionRetained:true,selectionPreserved:true,finalState:final.state,maxTrackingErrorPx:Math.max(...[...drags,reversal,cancelled].map(item=>item.maxTrackingErrorPx)),maxPageScrollDeltaPx:Math.max(scroll.pageScrollDeltaPx,...[...drags,reversal,cancelled].map(item=>item.pageScrollDeltaPx))};
}
async function mapGeometrySnapshot(cdp){
  await settledSheet(cdp,'closed');
  return evaluate(cdp,`(()=>{
    const visible=element=>{if(!element)return false;const style=getComputedStyle(element),r=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&r.width>1&&r.height>1};
    const box=element=>{if(!visible(element))return null;const r=element.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const root=document.querySelector('.explore-layout'),atlas=document.querySelector('.atlas-wrap'),panel=document.querySelector('.explore-panel');
    const layout=box(root),map=box(atlas),sheet=box(panel);
    const overlays=Object.fromEntries(Object.entries({stories:document.querySelector('.fact-card')||document.querySelector('.fact-closed'),context:document.querySelector('.map-context'),styles:document.querySelector('.map-style-switch'),rail:document.querySelector('.map-controls'),layers:document.querySelector('.layer-button')}).map(([name,element])=>[name,box(element)]).filter(([,rect])=>rect));
    const targets=[...document.querySelectorAll('.map-controls button:not([disabled]),.layer-button')].filter(visible).map(element=>{
      const r=element.getBoundingClientRect(),samples=[[.5,.5],[.3,.3],[.7,.3],[.3,.7],[.7,.7]];
      const blocked=samples.map(([x,y])=>{const hit=document.elementFromPoint(r.left+r.width*x,r.top+r.height*y);return hit&&element.contains(hit)?null:hit?hit.tagName.toLowerCase()+(hit.id?'#'+hit.id:'')+(hit.getAttribute('class')?'.'+hit.getAttribute('class').trim().replace(/\\s+/g,'.'):''):'outside-viewport'}).filter(Boolean);
      return{label:element.getAttribute('aria-label')||element.textContent?.trim(),rect:box(element),blocked};
    });
    const overlaps=[];
    const entries=Object.entries(overlays);
    for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
      const [a,first]=entries[i],[b,second]=entries[j];
      const width=Math.min(first.right,second.right)-Math.max(first.left,second.left),height=Math.min(first.bottom,second.bottom)-Math.max(first.top,second.top);
      if(width>1&&height>1)overlaps.push({first:a,second:b,width,height});
    }
    const available=map?{left:Math.max(0,map.left),right:Math.min(innerWidth,map.right),top:Math.max(0,map.top),bottom:Math.min(innerHeight,map.bottom,root?.dataset.sheetState==='closed'&&sheet?sheet.top:Infinity)}:null;
    return{width:innerWidth,height:innerHeight,coarse:matchMedia('(pointer:coarse)').matches,state:root?.dataset.sheetState,layout,atlas:map,available,overlays,targets,overlaps};
  })()`);
}
async function layerMenuState(cdp,expanded){
  for(let attempt=0;attempt<40;attempt++){
    const state=await evaluate(cdp,`(()=>{const button=document.querySelector('.layer-button'),menu=document.querySelector('.layer-menu'),r=menu?.getBoundingClientRect();return{expanded:button?.getAttribute('aria-expanded')==='true',visible:!!r&&r.width>0&&r.height>0&&getComputedStyle(menu).visibility!=='hidden'};})()`);
    if(state.expanded===expanded&&state.visible===expanded)return state;
    await sleep(50);
  }
  throw new Error(`Layers menu did not ${expanded?'open':'close'} after a touch`);
}
async function checkMapGeometry(cdp,profile){
  const geometry=await mapGeometrySnapshot(cdp);
  assert.equal(geometry.state,'closed',`${profile.name}: map geometry was measured before the sheet closed`);
  assert.ok(geometry.atlas&&geometry.layout&&geometry.available,`${profile.name}: map viewport is missing`);
  assert.deepEqual(geometry.overlaps,[],`${profile.name}: map controls, stories or context overlap`);
  const inside=(rect,bounds)=>rect.left>=bounds.left-1&&rect.right<=bounds.right+1&&rect.top>=bounds.top-1&&rect.bottom<=bounds.bottom+1;
  for(const [name,rect] of Object.entries(geometry.overlays))assert.ok(inside(rect,geometry.available),`${profile.name}: ${name} escapes the usable map above the closed sheet: ${JSON.stringify({rect,available:geometry.available})}`);
  for(const label of ['Увеличить масштаб','Уменьшить масштаб','Моё местоположение','Показать Россию целиком','Слои'])assert.ok(geometry.targets.some(target=>target.label===label),`${profile.name}: missing enabled map control ${label}`);
  for(const target of geometry.targets)assert.deepEqual(target.blocked,[],`${profile.name}: ${target.label} is obscured in the map hit-test`);
  if(profile.name==='phone-landscape'){
    assert.equal(geometry.coarse,true,'Landscape verification must use a coarse pointer');
    assert.ok(Math.abs(geometry.atlas.left-geometry.layout.left)<=1&&Math.abs(geometry.atlas.width-geometry.layout.width)<=1&&geometry.atlas.width>=geometry.width-2,`${profile.name}: the map retained a sidebar column: ${JSON.stringify({atlas:geometry.atlas,layout:geometry.layout,width:geometry.width})}`);
  }
  assert.equal(await tapSelector(cdp,'.layer-button',10),true,`${profile.name}: Layers button is absent`);
  const opened=await layerMenuState(cdp,true);
  assert.equal(await tapSelector(cdp,'.layer-button',11),true);
  const closed=await layerMenuState(cdp,false);
  return{...geometry,layersInteraction:{opened,closed}};
}
async function dismissMapMessage(cdp){
  const dismissible=await evaluate(cdp,`document.querySelector('.map-message button')?.textContent?.trim()==='Понятно'`);
  if(!dismissible)return false;
  assert.equal(await tapSelector(cdp,'.map-message button',13),true,'The map message must accept its dismiss touch');
  await sleep(50);
  return true;
}
async function touchPrevious(cdp,profile){
  await dismissMapMessage(cdp);
  if(await evaluate(cdp,`!!document.querySelector('.fact-closed')`)){
    assert.equal(await tapSelector(cdp,'.fact-closed',12),true,'The stories opener must accept a touch');
  }
  let point,last;
  for(let attempt=0;attempt<40;attempt++){
    last=await evaluate(cdp,`(()=>{
      const button=document.querySelector('.fact-controls button[aria-label="Предыдущая история"]');
      const message=document.querySelector('.map-message'),dismiss=message?.querySelector('button');
      const notice={message:message?.textContent?.trim(),dismissible:dismiss?.textContent?.trim()==='Понятно'};
      if(!button)return{ready:false,reason:'missing-button',dismissed:!!document.querySelector('.fact-closed'),...notice};
      button.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      const r=button.getBoundingClientRect(),style=getComputedStyle(button),x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y),card=button.closest('.fact-card'),cardRect=card?.getBoundingClientRect();
      const box=rect=>rect?{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height}:null;
      const ready=style.display!=='none'&&style.visibility!=='hidden'&&r.width>1&&r.height>1&&button.contains(hit);
      return{ready,x,y,title:document.querySelector('.fact-copy h3')?.textContent,visibility:style.visibility,rect:box(r),card:box(cardRect),scrollTop:card?.scrollTop,hit:hit?hit.tagName.toLowerCase()+'.'+(hit.getAttribute('class')||''):null,...notice};
    })()`);
    if(last?.ready){point=last;break;}
    if(last?.dismissible)await dismissMapMessage(cdp);
    await sleep(50);
  }
  assert.ok(point,`${profile.name}: story navigation did not become visible after opening: ${JSON.stringify(last)}`);
  await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1,radiusX:2,radiusY:2,force:1}]});
  await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await sleep(240);
  const result=await evaluate(cdp,`(()=>{
    const previous=document.querySelector('.fact-controls button[aria-label="Предыдущая история"]');
    const next=document.querySelector('.fact-controls button[aria-label="Следующая история"]');
    if(!previous||!next)return{available:false};
    const a=getComputedStyle(previous),b=getComputedStyle(next);
    return{available:true,title:document.querySelector('.fact-copy h3')?.textContent,focused:document.activeElement===previous,hovered:previous.matches(':hover'),background:a.backgroundColor,nextBackground:b.backgroundColor,transition:a.transitionDuration,cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0};
  })()`);
  assert.equal(result.available,true,'Story controls disappeared after the touch');
  assert.notEqual(result.title,point.title,'The previous-story touch must change the displayed story');
  return result;
}

async function waitValue(label,read,accept,timeout=12000){
  const deadline=Date.now()+timeout;let last;
  do{last=await read();if(accept(last))return last;await sleep(100);}while(Date.now()<deadline);
  throw new Error(`${label}: ${JSON.stringify(last).slice(0,2500)}`);
}
async function selectionState(cdp){
  return evaluate(cdp,`(()=>{const params=new URLSearchParams(location.search),active=document.activeElement;return{region:params.get('region')||'',route:params.get('route')||'',title:document.querySelector('.explore-panel h1')?.textContent?.replace(/\\s+/g,' ').trim()||'',sheet:document.querySelector('.explore-layout')?.dataset.sheetState,history:{length:history.length,level:history.state?.tropnikExploreLevel,pushed:history.state?.tropnikExplorePushed,explore:history.state?.tropnikExplore},activeElement:active?{tag:active.tagName,classes:active.getAttribute('class'),label:active.getAttribute('aria-label')}:null};})()`);
}
async function expectSelection(cdp,expected){
  return waitValue(`Map selection did not become ${JSON.stringify(expected)}`,()=>selectionState(cdp),state=>Object.entries(expected).every(([key,value])=>state[key]===value));
}
async function mapState(cdp){
  return evaluate(cdp,`(()=>{
    const element=document.querySelector('.atlas-canvas[data-map-engine]');if(!element)return null;
    const r=element.getBoundingClientRect(),s=getComputedStyle(element),d=element.dataset;
    return{camera:{longitude:Number(d.mapLongitude),latitude:Number(d.mapLatitude),zoom:Number(d.mapZoom),tileSize:Number(d.mapTileSize),...(d.mapCenterX!==undefined?{centerX:Number(d.mapCenterX),centerY:Number(d.mapCenterY)}:{})},engine:d.mapEngine,route:d.mapRouteId||'',moving:(${mapCameraIsMoving.toString()})(element),visible:s.visibility!=='hidden'&&s.display!=='none'&&r.width>20&&r.height>20,rect:{left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom},width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth${runPolicy.diagnostic?',terrainCamera:(()=>{try{return JSON.parse(d.mapTerrainCamera||\'null\')}catch{return null}})()':''}};
  })()`);
}
async function settledMap(cdp,engine){
  return settleMapCamera({engine,read:()=>mapState(cdp),frame:()=>compositorFrame(cdp),wait:waitValue});
}
async function pointerAt(cdp,point,profile){
  assert.ok(Number.isFinite(point.x)&&Number.isFinite(point.y),'Pointer coordinates must be finite');
  await evaluate(cdp,`window.__tropnikExpectedPointer={time:performance.now(),x:${point.x},y:${point.y},selector:${JSON.stringify(point.selector||null)},label:${JSON.stringify(point.label||point.title||null)},sampledAt:${JSON.stringify(point.sampledAt??null)},animating:${JSON.stringify(point.animating??null)},animations:${JSON.stringify(point.animations??[])}}`);
  if(profile.mobile){
    await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:51,radiusX:3,radiusY:3,force:1}]});
    await sleep(45);await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }else{
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,pointerType:'mouse'});
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1,pointerType:'mouse'});
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1,pointerType:'mouse'});
  }
}
async function elementPoint(cdp,selector){
  return evaluate(cdp,`(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const r=element.getBoundingClientRect(),s=getComputedStyle(element);if(element.hidden||s.visibility==='hidden'||s.display==='none'||r.width<2||r.height<2)return null;
    const x=r.left+r.width/2,y=r.top+r.height/2;if(x<0||y<0||x>=innerWidth||y>=innerHeight)return null;
    const animations=[];for(let node=element;node;node=node.parentElement)for(const animation of node.getAnimations())if(animation.pending||animation.playState==='running')animations.push({tag:node.tagName,classes:node.getAttribute('class'),name:animation.animationName||animation.transitionProperty||'',pending:animation.pending,playState:animation.playState,currentTime:typeof animation.currentTime==='number'?animation.currentTime:null});
    const hit=document.elementFromPoint(x,y);return{x,y,width:r.width,height:r.height,label:element.getAttribute('aria-label')||element.textContent?.trim(),hit:hit?.tagName,unobscured:!!hit&&element.contains(hit),sampledAt:performance.now(),animating:animations.length>0,animations};
  })()`);
}
async function pointerSelector(cdp,selector,profile){
  let previous=null,stable=0;const samples=[];
  try{
    const point=await waitValue(`Pointer target ${selector} did not become stable and unobscured`,async()=>{await compositorFrame(cdp);return elementPoint(cdp,selector);},current=>{
      samples.push(current);if(samples.length>16)samples.shift();
      const stopped=current?.unobscured&&!current.animating&&previous?.unobscured&&!previous.animating&&['x','y','width','height'].every(key=>Math.abs(current[key]-previous[key])<.25);
      stable=stopped?stable+1:0;previous=current;return stable>=2;
    });
    const target={...point,selector};await pointerAt(cdp,target,profile);return target;
  }catch(error){error.pointerTarget={selector,requiredIdleObservations:3,geometryTolerancePx:.25,samples};throw error;}
}
async function closeMapSheet(cdp,profile){
  if(!profile.mobile)return;
  if((await selectionState(cdp)).sheet!=='closed')await pointerSelector(cdp,'.sheet-handle',profile);
  await settledSheet(cdp,'closed');
}
async function recordedClick(cdp,selector,profile){
  await evaluate(cdp,'window.__tropnikInputEvents=[]');
  const point=await pointerSelector(cdp,selector,profile);
  const events=await waitValue(`Native click on ${selector} was not delivered`,()=>evaluate(cdp,'window.__tropnikInputEvents'),events=>events.some(event=>event.type==='click'),2000);
  const input=profile.mobile?'touch':'mouse';assertNativeBurstEventOrder(events,input,1);
  return{input,selector,point,events};
}
async function scrollContainerState(cdp,selector){
  return evaluate(cdp,`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const r=element.getBoundingClientRect();return{rect:{left:r.left,right:r.right,top:Math.max(0,r.top),bottom:Math.min(innerHeight,r.bottom),width:r.width,height:Math.min(innerHeight,r.bottom)-Math.max(0,r.top)},scrollTop:element.scrollTop,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight,scrollY, sheet:document.querySelector('.explore-layout')?.dataset.sheetState};})()`);
}
/** Native scrolling only: never set scrollTop or call an application handler. */
async function scrollContainer(cdp,selector,profile,direction=1){
  const input=profile.mobile?'touch':'mouse',commands=[],observations=[];
  let before,after,start,end,distance,events=[];
  try{
    before=await scrollContainerState(cdp,selector);assert.ok(before,`Missing scroll container ${selector}`);
    const remaining=direction>0?before.scrollHeight-before.clientHeight-before.scrollTop:before.scrollTop;
    assert.ok(remaining>0,`No remaining content in ${selector}`);
    distance=Math.min(240,before.rect.height-48,Math.max(32,remaining));
    assert.ok(distance>=12,`No remaining native scroll travel in ${selector}: ${JSON.stringify(before)}`);
    start={x:before.rect.left+before.rect.width/2,y:direction>0?before.rect.bottom-24:before.rect.top+24};end={x:start.x,y:start.y-direction*distance};
    const owned=await evaluate(cdp,`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${start.x},${start.y}))`);assert.equal(owned,true,`${selector}: native scroll starts behind another control`);
    await evaluate(cdp,'window.__tropnikScrollEvents=[]');
    const send=async(method,params)=>{await cdp.call(method,params);commands.push({method,type:params.type,status:'fulfilled'});};
    if(profile.mobile){
      await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:73,radiusX:3,radiusY:3,force:1}]});
      for(let step=1;step<=8;step++){await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x,y:start.y-direction*distance*step/8,id:73,radiusX:3,radiusY:3,force:1}]});await sleep(25);}
      await sleep(100);await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }else await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:start.x,y:start.y,deltaX:0,deltaY:direction*distance,pointerType:'mouse'});
    let previous=-1,stable=0;
    after=await waitValue(`${selector}: native scroll did not settle`,()=>scrollContainerState(cdp,selector),value=>{
      after=value;observations.push(value);if(observations.length>16)observations.shift();
      const progressed=direction*(value.scrollTop-before.scrollTop)>1;
      stable=progressed&&Math.abs(value.scrollTop-previous)<.5?stable+1:0;previous=value.scrollTop;return stable>=3;
    },4000);
    events=await evaluate(cdp,'window.__tropnikScrollEvents');
    assert.ok(direction*(after.scrollTop-before.scrollTop)>1,`${selector}: native scrolling made no progress`);
    assert.ok(Math.abs(after.scrollY-before.scrollY)<=1,`${selector}: internal scrolling moved the page`);assert.equal(after.sheet,before.sheet);
    return{input,selector,direction,start,end,distance,before,after,commands,events};
  }catch(error){
    let current=null;try{current=await scrollContainerState(cdp,selector);}catch{}
    if(commands.length)try{events=await evaluate(cdp,'window.__tropnikScrollEvents');}catch{}
    error.nativeScroll={input,selector,direction,start,end,distance,before,after,current,commands,events,observations};throw error;
  }
}
async function revealNative(cdp,selector,container,profile,limit=12){
  const scrolls=[];
  for(let attempt=0;attempt<=limit;attempt++){
    const target=await evaluate(cdp,`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),parent=document.querySelector(${JSON.stringify(container)});if(!element||!parent)return null;const r=element.getBoundingClientRect(),p=parent.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{inside:r.top>=Math.max(0,p.top)-1&&r.bottom<=Math.min(innerHeight,p.bottom)+1&&r.width>0&&r.height>0,unobscured:!!hit&&element.contains(hit),direction:r.top<Math.max(0,p.top)?-1:1};})()`);
    assert.ok(target,`Missing ${selector} inside ${container}`);
    if(target.inside&&target.unobscured)return scrolls;
    assert.ok(attempt<limit,`Native scrolling could not reveal ${selector} within ${limit} gestures`);
    scrolls.push(await scrollContainer(cdp,container,profile,target.direction));
  }
}
async function layerMenuFrame(cdp){
  return evaluate(cdp,`(()=>{
    const box=element=>{const r=element.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const root=document.querySelector('.explore-layout'),atlas=document.querySelector('.atlas-wrap'),panel=document.querySelector('.explore-panel'),menu=document.querySelector('.layer-menu'),button=document.querySelector('.layer-button');
    if(!menu||!atlas||!button)return null;const map=box(atlas),sheet=box(panel),rect=box(menu),usable={left:Math.max(0,map.left),right:Math.min(innerWidth,map.right),top:Math.max(0,map.top),bottom:Math.min(innerHeight,map.bottom,sheet.top)};usable.width=usable.right-usable.left;usable.height=usable.bottom-usable.top;
    const controls=[...menu.querySelectorAll('button,input,a')].map((element,index)=>{const r=box(element),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y),inside=r.top>=rect.top-1&&r.bottom<=rect.bottom+1&&r.left>=rect.left-1&&r.right<=rect.right+1;return{index,tag:element.tagName,label:(element.getAttribute('aria-label')||(element.tagName==='INPUT'?element.closest('label')?.textContent:element.textContent)||'').trim(),rect:r,inside,unobscured:!!hit&&element.contains(hit),point:{x,y},hit:hit?{tag:hit.tagName,classes:hit.getAttribute('class'),label:(hit.closest('button,a,label')?.textContent||'').trim()}:null};});
    return{sheet:root.dataset.sheetState,map,usable,menu:rect,button:box(button),scrollTop:menu.scrollTop,scrollHeight:menu.scrollHeight,clientHeight:menu.clientHeight,scrollY,controls};
  })()`);
}
async function checkPortraitLayerMenus(cdp,profile){
  const states=[];let current=null;
  try{
    await clearMapStories(cdp,profile);
    for(const sheet of ['closed','open']){
      if((await selectionState(cdp)).sheet!==sheet){await recordedClick(cdp,'.sheet-handle',profile);await settledSheet(cdp,sheet);}
      await settledMap(cdp,profile.engine);
      const opened=await recordedClick(cdp,'.layer-button',profile);await layerMenuState(cdp,true);
      const frames=[await layerMenuFrame(cdp)],scrolls=[];current={sheet,opened,frames,scrolls};
      const reached=new Set();
      for(let attempt=0;attempt<=8;attempt++){
        for(const control of frames.at(-1).controls)if(control.inside&&control.unobscured)reached.add(control.index);
        if(reached.size===frames[0].controls.length)break;
        assert.ok(attempt<8,`${profile.name}/${sheet}: not all Layers controls became reachable`);
        scrolls.push(await scrollContainer(cdp,'.layer-menu',profile));frames.push(await layerMenuFrame(cdp));
      }
      const closed=await recordedClick(cdp,'.layer-button',profile);await layerMenuState(cdp,false);
      states.push({...current,closed});current=null;
    }
    await closeMapSheet(cdp,profile);
    const receipt={schemaVersion:1,passed:true,input:'touch',states};assertLayerMenuAudit(receipt,profile.name);return receipt;
  }catch(error){
    let frame=null;try{frame=await layerMenuFrame(cdp);}catch{}
    error.layerMenuAudit={profile:profile.name,states,current,frame};throw error;
  }
}
async function browserBack(cdp,expected){
  const history=await cdp.call('Page.getNavigationHistory'),from=history.entries[history.currentIndex],target=history.entries[history.currentIndex-1];
  assert.ok(target,'Browser Back has no previous entry');await cdp.call('Page.navigateToHistoryEntry',{entryId:target.id});
  const after=await expectSelection(cdp,expected);
  const url=await evaluate(cdp,'location.href');assert.equal(url,target.url,'Browser Back did not restore its actual history entry');
  return{method:'Page.navigateToHistoryEntry',from:{id:from.id,url:from.url},target:{id:target.id,url:target.url},url,after};
}
async function overviewCounts(cdp){
  return evaluate(cdp,`(()=>{
    const number=text=>Number((text||'').match(/[0-9][0-9\\s\\u00a0]*/)?.[0].replace(/\\D/g,'')||0);
    const catalog=[...document.querySelectorAll('.region-option')].map(element=>({id:[...element.querySelector('.region-thumbnail').classList].find(name=>name.startsWith('region-thumbnail-'))?.slice('region-thumbnail-'.length),name:element.querySelector('strong')?.textContent?.trim(),count:number(element.querySelector('small')?.textContent)}));
    const markers=[...document.querySelectorAll('.region-marker:not([hidden])')].map(element=>({id:element.dataset.regionId,name:element.querySelector('.region-marker-label')?.textContent?.trim(),count:number(element.querySelector('.region-marker-count')?.textContent),groupKey:element.dataset.mapGroupKey,cluster:element.classList.contains('direction-cluster'),ariaLabel:element.getAttribute('aria-label')}));
    return{region:new URLSearchParams(location.search).get('region')||'',catalog,markers,total:number(document.querySelector('.sheet-peek-copy>span')?.textContent),mapTotal:number(document.querySelector('.map-context>span:last-child')?.textContent)};
  })()`);
}
async function filterState(cdp){
  return evaluate(cdp,`(()=>({pressed:document.querySelector('.filter-row button[aria-pressed]')?.getAttribute('aria-pressed')??null,count:Number(document.querySelector('.explore-panel .section-heading>span')?.textContent?.replace(/\\D/g,'')||0),expanded:document.querySelector('.filter-row button[aria-expanded]')?.getAttribute('aria-expanded'),empty:!!document.querySelector('.catalog-empty')}))()`);
}
async function checkSavedFilterReset(cdp,profile,receipt){
  receipt.baseline=await filterState(cdp);assert.equal(receipt.baseline.pressed,'false');assert.ok(receipt.baseline.count>0);
  receipt.enabled=await recordedClick(cdp,'.filter-row button[aria-pressed]',profile);
  receipt.filtered=await waitValue('Saved filter did not become active',()=>filterState(cdp),state=>state.pressed==='true'&&state.count===0&&state.empty);
  receipt.parent=await recordedClick(cdp,'.explore-panel .back-link',profile);await expectSelection(cdp,{region:'',route:''});await closeMapSheet(cdp,profile);await settledMap(cdp,profile.engine);
  currentExploreExperience.step='overview-after';receipt.overviewAfter=await overviewCounts(cdp);
  assertOverviewCounts(receipt.overviewAfter,`${profile.name}/explore/after-filter`);
  currentExploreExperience.step='saved-filter-map-reentry';receipt.reentryActions=[];
  await selectMapDirection(cdp,profile,'altai','Алтай',{kind:'count',actions:receipt.reentryActions});
  await expectSelection(cdp,{region:'altai',route:'',title:'Алтай'});receipt.restored=await filterState(cdp);
  return receipt;
}
async function requestDialogState(cdp){
  return evaluate(cdp,`(()=>{const dialog=document.querySelector('[role="dialog"]');return{open:!!dialog,heading:dialog?.querySelector('h2')?.textContent||'',routeTitle:dialog?.querySelector('form>p')?.textContent||'',date:dialog?.querySelector('input[type=date]')?.value??null,note:dialog?.querySelector('textarea')?.value??null,error:!!dialog?.querySelector('[role=alert]'),success:!!dialog?.querySelector('.success-panel'),submitted:window.__tropnikFormSubmits||0};})()`);
}
async function checkRequestOwnership(cdp,profile,route){
  const action='.route-actions button.primary',scrolls=await revealNative(cdp,action,'.explore-panel-content',profile),opened=await recordedClick(cdp,action,profile);
  const first=await waitValue('Route request did not open',()=>requestDialogState(cdp),state=>state.open&&state.routeTitle===route.title);
  await recordedClick(cdp,'[role="dialog"] textarea',profile);await evaluate(cdp,'window.__tropnikFormInputs=[]');
  const note='Проверка принадлежности запроса маршруту';await cdp.call('Input.insertText',{text:note});
  const edited=await waitValue('Native request note input was not delivered',()=>requestDialogState(cdp),state=>state.note===note),editEvents=await evaluate(cdp,'window.__tropnikFormInputs');
  const closedSame=await recordedClick(cdp,'[role="dialog"] button[aria-label="Закрыть"]',profile);await waitValue('Request did not close',()=>requestDialogState(cdp),state=>!state.open);
  const reopened=await recordedClick(cdp,action,profile);const same=await waitValue('Same-route draft was not restored',()=>requestDialogState(cdp),state=>state.open&&state.note===note);
  const back=await browserBack(cdp,{region:'altai',route:'',title:'Алтай'}),afterBack=await waitValue('Browser Back retained the previous route request',()=>requestDialogState(cdp),state=>!state.open);
  if(profile.mobile)await settledSheet(cdp,'open');
  const next=await evaluate(cdp,`(()=>{const cards=[...document.querySelectorAll('.trail-card')],index=cards.findIndex(element=>element.querySelector('h3')?.textContent!==${JSON.stringify(route.title)}&&!element.querySelector('.source-status')?.textContent?.includes('Закрыт'));return index<0?null:{selector:'.trail-list .trail-card:nth-child('+(index+1)+') .trail-card-main',title:cards[index].querySelector('h3').textContent};})()`);assert.ok(next,'No sibling route is available for request ownership');
  const nextScrolls=await revealNative(cdp,next.selector,'.explore-panel-content',profile),nextSelected=await recordedClick(cdp,next.selector,profile);
  const nextSelection=await expectSelection(cdp,{region:'altai',title:next.title});assert.ok(nextSelection.route);assert.notEqual(nextSelection.route,route.id);
  const beforeNext=await requestDialogState(cdp);assert.equal(beforeNext.open,false);
  const nextActionScrolls=await revealNative(cdp,action,'.explore-panel-content',profile),nextOpened=await recordedClick(cdp,action,profile),second=await waitValue('Sibling route request did not open',()=>requestDialogState(cdp),state=>state.open&&state.routeTitle===next.title);
  const nextClosed=await recordedClick(cdp,'[role="dialog"] button[aria-label="Закрыть"]',profile);await waitValue('Sibling request did not close',()=>requestDialogState(cdp),state=>!state.open);
  const returnScrolls=await revealNative(cdp,'.explore-panel .back-link','.explore-panel-content',profile);
  return{route:{id:route.id,title:route.title},scrolls,opened,first,edit:{method:'Input.insertText',note,events:editEvents},edited,closedSame,reopened,same,back,afterBack,next:{selection:nextSelection,scrolls:nextScrolls,selected:nextSelected,before:beforeNext,actionScrolls:nextActionScrolls,opened:nextOpened,dialog:second,closed:nextClosed},returnScrolls};
}
async function clearMapStories(cdp,profile){
  if(await elementPoint(cdp,'.fact-dismiss'))await pointerSelector(cdp,'.fact-dismiss',profile);
  const message=await elementPoint(cdp,'.map-message button');
  if(message?.label==='Понятно')await pointerAt(cdp,message,profile);
}
async function selectMapDirection(cdp,profile,id,title,{kind,actions}){
  const progress=[];
  for(let step=0;step<7;step++){
    const before=await settledMap(cdp,profile.engine);
    const selectedBefore=await selectionState(cdp);
    if(selectedBefore.region===id){await expectSelection(cdp,{region:id,route:'',title});return progress;}
    let previous=null,stable=0;
    const {grid,point}=await waitValue(`${profile.name}: external ${kind} of ${id} did not become stable and reachable`,async()=>{
      const grid=await evaluate(cdp,`(()=>{const directionHitGrid=${directionHitGrid.toString()};return (${inspectDirectionHitAreas.toString()})(${JSON.stringify(id)});})()`);
      return{grid,point:directionExternalPoint(grid,kind)};
    },current=>{
      const point=current.point,stopped=point&&previous&&point.anchorId===previous.anchorId&&point.groupKey===previous.groupKey&&point.name===previous.name&&Math.abs(point.x-previous.x)<.25&&Math.abs(point.y-previous.y)<.25;
      stable=stopped?stable+1:0;previous=point;return stable>=2;
    });
    assertDirectionHitGrid(grid,`${profile.name}/${id}/${kind}`,profile.engine);
    await evaluate(cdp,'window.__tropnikInputEvents=[]');
    await pointerAt(cdp,{...point,label:grid.ariaLabel},profile);
    await waitValue(`${profile.name}: external ${kind} did not select or expand ${id}`,async()=>({selection:await selectionState(cdp),map:await mapState(cdp)}),state=>state.selection.region===id||!!state.map&&state.map.camera.zoom>before.camera.zoom+.2);
    const after=await settledMap(cdp,profile.engine),selection=await selectionState(cdp);
    const events=await evaluate(cdp,'window.__tropnikInputEvents');
    actions.push({kind,input:profile.mobile?'touch':'mouse',grid,point,events,
      before:{region:selectedBefore.region,route:selectedBefore.route,zoom:before.camera.zoom},
      after:{region:selection.region,route:selection.route,zoom:after.camera.zoom}});
    progress.push({group:grid.groupKey,beforeZoom:before.camera.zoom,afterZoom:after.camera.zoom,selected:selection.region});
    if(selection.region===id){await expectSelection(cdp,{region:id,route:'',title});return progress;}
    assert.ok(after.camera.zoom>=before.camera.zoom+.7,`${profile.name}: a direction cluster repeated the same view`);
  }
  throw new Error(`${profile.name}: direction ${id} never became selectable: ${JSON.stringify(progress)}`);
}
async function canvasPoints(cdp,points){
  if(!points.length)return[];
  return evaluate(cdp,`(${JSON.stringify(points)}).filter(point=>{
    if(point.x<12||point.y<12||point.x>=innerWidth-12||point.y>=innerHeight-12)return false;
    const hit=document.elementFromPoint(point.x,point.y);return !!hit&&hit.tagName==='CANVAS'&&!!hit.closest('.atlas-canvas');
  })`);
}
async function trailTouch(cdp,profile,regionId){
  const regional=mapTrails.filter(trail=>trail.regionId===regionId||trail.regionIds?.includes(regionId));
  for(let attempt=0;attempt<4;attempt++){
    const state=await settledMap(cdp,profile.engine),candidates=[];
    const locations=regional.map(trail=>({trail,point:projectMapPoint(trail.center,state.camera,state.rect)}));
    for(const {trail,point} of locations){
      if(!trail.geometryUrl?.startsWith('/data/'))continue;
      for(const [dx,dy] of [[14,0],[-14,0],[0,14],[0,-14]]){
        const x=point.x+dx,y=point.y+dy;
        if(locations.some(other=>other.trail.id!==trail.id&&Math.hypot(other.point.x-x,other.point.y-y)<25))continue;
        candidates.push({x,y,id:trail.id,title:trail.title,geometryUrl:trail.geometryUrl,center:trail.center,offset:Math.hypot(dx,dy)});
      }
    }
    const target=(await canvasPoints(cdp,candidates))[0];
    if(target){
      await pointerAt(cdp,target,profile);
      await expectSelection(cdp,{region:regionId,route:target.id,title:target.title,...(profile.mobile?{sheet:'open'}:{})});
      await waitValue(`${profile.name}: selected route geometry was not rendered`,()=>mapState(cdp),map=>map?.route===target.id);
      await settledMap(cdp,profile.engine);return target;
    }
    if(attempt<3)await pointerSelector(cdp,'.map-controls button[aria-label="Увеличить масштаб"]',profile);
  }
  throw new Error(`${profile.name}: no unobscured, isolated route touch target in ${regionId}`);
}
function lineParts(value){
  if(value?.type==='FeatureCollection')return value.features.flatMap(lineParts);
  if(value?.type==='Feature')return lineParts(value.geometry);
  if(value?.type==='GeometryCollection')return value.geometries.flatMap(lineParts);
  if(value?.type==='LineString')return[value.coordinates];
  if(value?.type==='MultiLineString')return value.coordinates;
  return[];
}
async function reopenSelectedLine(cdp,profile,trail){
  await closeMapSheet(cdp,profile);
  const state=await settledMap(cdp,profile.engine);
  const geometry=JSON.parse(await readFile(new URL(`../../web/public${trail.geometryUrl}`,import.meta.url),'utf8'));
  const candidates=[],pointLocations=mapTrails.map(item=>projectMapPoint(item.center,state.camera,state.rect));
  for(const line of lineParts(geometry?.data?.geometry||geometry)){
    const step=Math.max(1,Math.floor(line.length/100));
    for(let index=1;index<line.length;index+=step){
      const a=projectMapPoint(line[index-1],state.camera,state.rect),b=projectMapPoint(line[index],state.camera,state.rect),point={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      if(pointLocations.every(other=>Math.hypot(other.x-point.x,other.y-point.y)>28))candidates.push(point);
    }
  }
  const target=(await canvasPoints(cdp,candidates))[0];
  assert.ok(target,`${profile.name}: selected line has no visible test segment away from route points`);
  await evaluate(cdp,'window.__tropnikInputEvents=[]');
  await pointerAt(cdp,target,profile);
  await expectSelection(cdp,{region:'altai',route:trail.id,title:trail.title,...(profile.mobile?{sheet:'open'}:{})});
  if(profile.mobile)await settledSheet(cdp,'open');
  const events=await evaluate(cdp,'window.__tropnikInputEvents');assertNativeBurstEventOrder(events,profile.mobile?'touch':'mouse',1);
  return{point:target,route:trail.id,clicked:true,selectionRetained:true,reopened:profile.mobile,events};
}
async function polygonTouch(cdp,profile){
  await closeMapSheet(cdp,profile);
  const state=await settledMap(cdp,profile.engine),candidates=[];
  const points=mapTrails.map(trail=>projectMapPoint(trail.center,state.camera,state.rect));
  for(const fy of [.5,.62,.38,.74,.26,.82])for(const fx of [.5,.35,.65,.2,.8]){
    const point={x:state.rect.left+state.rect.width*fx,y:state.rect.top+state.rect.height*fy};
    if(points.some(other=>Math.hypot(point.x-other.x,point.y-other.y)<30))continue;
    const coordinate=unprojectMapPoint(point,state.camera,state.rect);
    const feature=administrativeFeatures.find(feature=>pointInPolygonGeometry(coordinate,feature.geometry)&&[[8,0],[-8,0],[0,8],[0,-8]].every(([dx,dy])=>pointInPolygonGeometry(unprojectMapPoint({x:point.x+dx,y:point.y+dy},state.camera,state.rect),feature.geometry)));
    const territory=feature&&territoryRecords.find(item=>item.shapeNames.includes(feature.properties?.shapeName));
    if(territory)candidates.push({...point,coordinate,id:territory.id,title:territory.name});
  }
  const target=(await canvasPoints(cdp,candidates))[0];
  assert.ok(target,`${profile.name}: no unobscured administrative polygon point away from routes`);
  await evaluate(cdp,'window.__tropnikInputEvents=[]');
  await pointerAt(cdp,target,profile);
  await expectSelection(cdp,{region:target.id,route:'',title:target.title,...(profile.mobile?{sheet:'open'}:{})});
  await settledMap(cdp,profile.engine);const events=await evaluate(cdp,'window.__tropnikInputEvents');assertNativeBurstEventOrder(events,profile.mobile?'touch':'mouse',1);
  return{...target,input:profile.mobile?'touch':'mouse',events};
}
async function freeCanvasPoint(cdp,state){
  const candidates=[];
  for(const fy of [.45,.55,.65,.35,.75])for(const fx of [.5,.35,.65,.25,.75])candidates.push({x:state.rect.left+state.rect.width*fx,y:state.rect.top+state.rect.height*fy});
  const point=(await canvasPoints(cdp,candidates))[0];assert.ok(point,'No visible Canvas position for a real map gesture');return point;
}
async function mapGestures(cdp,profile){
  await closeMapSheet(cdp,profile);
  const selection=await selectionState(cdp),before=await settledMap(cdp,profile.engine);
  if(profile.mobile)await pointerSelector(cdp,'.map-controls button[aria-label="Увеличить масштаб"]',profile);
  else{
    const point=await freeCanvasPoint(cdp,before);
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX:0,deltaY:-400,pointerType:'mouse'});
  }
  await waitValue(`${profile.name}: zoom input had no effect`,()=>mapState(cdp),state=>state?.camera.zoom>before.camera.zoom+.2);
  const zoomed=await settledMap(cdp,profile.engine),start=await freeCanvasPoint(cdp,zoomed);
  const dx=start.x+70<Math.min(zoomed.width,zoomed.rect.right)?48:-48,dy=12;
  if(profile.mobile)await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:61,radiusX:3,radiusY:3,force:1}]});
  else await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});
  for(let step=1;step<=8;step++){
    const point={x:start.x+dx*step/8,y:start.y+dy*step/8};
    if(profile.mobile)await cdp.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...point,id:61,radiusX:3,radiusY:3,force:1}]});
    else await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'left',buttons:1,pointerType:'mouse'});
    await sleep(25);
  }
  if(profile.mobile)await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  else await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:start.x+dx,y:start.y+dy,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});
  const moved=await settledMap(cdp,profile.engine);
  assert.ok(Math.abs(moved.camera.longitude-zoomed.camera.longitude)>1e-5||Math.abs(moved.camera.latitude-zoomed.camera.latitude)>1e-5,`${profile.name}: drag did not move the map`);
  await expectSelection(cdp,{region:selection.region,route:selection.route,title:selection.title});
  const dimensions=profile.mobile?{width:profile.height,height:profile.width}:{width:profile.width-180,height:profile.height-100};
  await cdp.call('Emulation.setDeviceMetricsOverride',{...dimensions,deviceScaleFactor:profile.mobile?2:1,mobile:profile.mobile,screenWidth:dimensions.width,screenHeight:dimensions.height});
  await waitValue(`${profile.name}: viewport did not resize`,()=>mapState(cdp),state=>state?.width===dimensions.width&&state.height===dimensions.height);
  const resized=await settledMap(cdp,profile.engine);
  assert.ok(resized.scrollWidth<=resized.width+1,`${profile.name}: resize caused horizontal overflow`);
  await expectSelection(cdp,{region:selection.region,route:selection.route,title:selection.title});
  const afterResize=await polygonTouch(cdp,profile);
  return{zoomInput:profile.mobile?'touch-control':'mouse-wheel',beforeZoom:before.camera.zoom,afterZoom:zoomed.camera.zoom,dragged:true,dragCameras:{before:zoomed.camera,after:moved.camera},selectionPreserved:true,resizedTo:dimensions,postResizePolygon:afterResize.id};
}
async function checkSiblingParent(cdp,profile,previous,polygon){
  const sibling=await selectionState(cdp);assert.ok(sibling.region&&sibling.region!==previous.region);assert.equal(sibling.route,'');
  const parent=await recordedClick(cdp,'.explore-panel .back-link',profile),overview=await expectSelection(cdp,{region:'',route:''});
  const back=await browserBack(cdp,{region:sibling.region,route:'',title:sibling.title});await settledMap(cdp,profile.engine);
  return{previous,sibling,selected:{input:polygon.input,point:{x:polygon.x,y:polygon.y,id:polygon.id,title:polygon.title},events:polygon.events},parent,overview,back};
}
async function checkStyleCameraRoundtrip(cdp,profile,trail){
  const selection=await selectionState(cdp);assert.ok(selection.route,'Style preservation needs an actual selected route');
  const before=await settledMap(cdp,profile.engine),zoom=await recordedClick(cdp,'.map-controls button[aria-label="Увеличить масштаб"]',profile);
  await waitValue('The genuine route zoom had no effect',()=>mapState(cdp),state=>state?.camera.zoom>before.camera.zoom+.2);
  const zoomed=await settledMap(cdp,profile.engine),delta={dx:48,dy:12},starts=[];
  for(const fy of [.45,.55,.65,.35,.75])for(const fx of [.5,.35,.65,.25,.75])starts.push({x:zoomed.rect.left+zoomed.rect.width*fx,y:zoomed.rect.top+zoomed.rect.height*fy});
  const paths=starts.flatMap((point,candidate)=>Array.from({length:13},(_,index)=>({x:point.x+delta.dx*index/12,y:point.y+delta.dy*index/12,candidate})));
  const owned=await canvasPoints(cdp,paths),start=starts.find((_,candidate)=>owned.filter(point=>point.candidate===candidate).length===13);
  assert.ok(start,'No entire native route pan path is clear of UI overlays');
  await evaluate(cdp,'window.__tropnikInputEvents=[]');
  const pan=await dispatchSourceEndPan(cdp,start,delta,profile,sleep),manual=await settledMap(cdp,profile.engine);
  pan.events=await evaluate(cdp,'window.__tropnikInputEvents');pan.before=zoomed;pan.after=manual;
  const transitions=[];
  for(const label of ['Сохранённый обзор','Детальные тропы онлайн']){
    const opened=await recordedClick(cdp,'.layer-button',profile);await layerMenuState(cdp,true);
    const selector=await evaluate(cdp,`(()=>{const buttons=[...document.querySelectorAll('.layer-menu>button')],index=buttons.findIndex(button=>button.textContent?.trim()===${JSON.stringify(label)});return index<0?null:'.layer-menu>button:nth-of-type('+(index+1)+')';})()`);assert.ok(selector,`Missing layer ${label}`);
    const scrolls=await revealNative(cdp,selector,'.layer-menu',profile);
    await evaluate(cdp,`(()=>{window.__tropnikRouteRestoreObserver?.disconnect();window.__tropnikRouteRestores=[];window.__tropnikRouteEdgesBefore=[...document.querySelectorAll('.atlas-wrap .route-edge-marker')];const element=document.querySelector('.atlas-canvas[data-map-engine]');window.__tropnikRouteRestoreObserver=new MutationObserver(records=>{for(const record of records)window.__tropnikRouteRestores.push({old:record.oldValue,current:element.getAttribute('data-map-route-id')});});window.__tropnikRouteRestoreObserver.observe(element,{attributes:true,attributeFilter:['data-map-route-id'],attributeOldValue:true});})()`);
    const selected=await recordedClick(cdp,selector,profile);
    const restored=await waitValue(`${label}: route overlays were not reinstalled`,()=>evaluate(cdp,`(()=>{const current=[...document.querySelectorAll('.atlas-wrap .route-edge-marker')],prior=window.__tropnikRouteEdgesBefore;return{route:document.querySelector('.atlas-canvas[data-map-engine]')?.dataset.mapRouteId,selected:!![...document.querySelectorAll('.layer-menu>button')].find(button=>button.textContent?.trim()===${JSON.stringify(label)})?.querySelector('svg'),mutations:window.__tropnikRouteRestores,edges:{before:prior.length,after:current.length,replaced:current.filter(element=>!prior.includes(element)).length}};})()`),value=>value.route===selection.route&&value.selected&&value.mutations.some(item=>item.current===selection.route)&&value.edges.after===value.edges.before&&value.edges.replaced===value.edges.after);
    await evaluate(cdp,'window.__tropnikRouteRestoreObserver.disconnect()');
    const closed=await recordedClick(cdp,'.layer-button',profile);await layerMenuState(cdp,false);
    const frame=await settledMap(cdp,profile.engine),line=await reopenSelectedLine(cdp,profile,trail),lineFrame=await settledMap(cdp,profile.engine),currentSelection=await selectionState(cdp);
    transitions.push({label,opened,scrolls,selected,closed,frame,line,lineFrame,selection:currentSelection,restored});
  }
  const receipt={schemaVersion:1,passed:true,input:'mouse',routeId:selection.route,selection,before,zoomed,zoom,pan,manual,transitions};assertStyleCameraRoundtrip(receipt,profile.name);return receipt;
}
async function mapInteraction(cdp,profile,performanceIssues){
  const focusedDiagnostic=runPolicy.diagnostic==='map-interactions';
  const phase=async name=>{if(focusedDiagnostic)await diagnosticPhase(cdp,'map-interactions/'+name);};
  const experience={schemaVersion:1,passed:false,input:profile.mobile?'touch':'mouse',filterReset:{}};
  currentExploreExperience={profile:profile.name,step:'overview-before',receipt:experience};
  const started=Date.now();await clearMapStories(cdp,profile);await closeMapSheet(cdp,profile);
  const country=await settledMap(cdp,profile.engine);experience.filterReset.overviewBefore=await overviewCounts(cdp);
  assertOverviewCounts(experience.filterReset.overviewBefore,`${profile.name}/explore/before-filter`);
  await evaluate(cdp,'window.__tropnikPerf={cls:0,longest:0};window.__tropnikPerfStart=performance.now()');
  await diagnosticPhase(cdp,'map-interactions');
  const directionActions=[];
  await phase('first-altai');
  const selectFirstDirection=()=>selectMapDirection(cdp,profile,'altai','Алтай',{kind:'label',actions:directionActions});
  const firstSelection=profile.mobile?{value:await selectFirstDirection(),trace:null}:await traceDesktopSelection(cdp,selectFirstDirection,{enabled:traceEnabled,sourceCommit:process.env.GITHUB_SHA||null});
  const firstDirection=firstSelection.value;
  currentExploreExperience.step='saved-filter';await phase('saved-filter');await checkSavedFilterReset(cdp,profile,experience.filterReset);
  const catalogScroll=profile.mobile?await scrollSheetContent(cdp,profile,{stableExtent:true}):null;
  await closeMapSheet(cdp,profile);
  await phase('route-selection');const trail=await trailTouch(cdp,profile,'altai'),line=await reopenSelectedLine(cdp,profile,trail);
  currentExploreExperience.step='style-camera';
  await phase('style-camera');
  const styleCameraRoundtrip=profile.engine==='maplibre'?await checkStyleCameraRoundtrip(cdp,profile,trail):null;
  currentExploreExperience.styleCameraRoundtrip=styleCameraRoundtrip;
  currentExploreExperience.step='request-ownership';await phase('request-ownership');experience.requestOwnership=await checkRequestOwnership(cdp,profile,trail);
  await phase('return-to-country');
  await pointerSelector(cdp,'.explore-panel .back-link',profile);
  await expectSelection(cdp,{region:'altai',route:'',title:'Алтай'});
  await pointerSelector(cdp,'.explore-panel .back-link',profile);
  await expectSelection(cdp,{region:'',route:''});
  await closeMapSheet(cdp,profile);
  const returned=await settledMap(cdp,profile.engine);
  assert.ok(Math.abs(returned.camera.longitude-country.camera.longitude)<.1&&Math.abs(returned.camera.latitude-country.camera.latitude)<.1&&Math.abs(returned.camera.zoom-country.camera.zoom)<.05,`${profile.name}: return to directions displaced the country after the sheet settled: ${JSON.stringify({initial:country.camera,returned:returned.camera})}`);
  await phase('second-baikal');const secondDirection=await selectMapDirection(cdp,profile,'baikal','Байкал',{kind:'count',actions:directionActions});
  const directionHitAreas={schemaVersion:1,passed:true,engine:profile.engine,input:profile.mobile?'touch':'mouse',actions:directionActions};
  assertDirectionHitAreas(directionHitAreas,profile.name,profile.engine,profile.mobile);
  currentExploreExperience.step='sibling-parent';await phase('sibling-polygon');const previous=await selectionState(cdp);
  const siblingSelection=await traceDesktopSelection(cdp,async()=>{
    const polygon=await polygonTouch(cdp,profile),siblingParent=await checkSiblingParent(cdp,profile,previous,polygon);
    return{polygon,siblingParent};
  },{enabled:focusedDiagnostic&&!profile.mobile,sourceCommit:process.env.GITHUB_SHA||null,prefix:'desktop-webgl-sibling-polygon',scope:'desktop-sibling-polygon-selection'});
  const {polygon,siblingParent}=siblingSelection.value;experience.siblingParent=siblingParent;
  await phase('map-gestures');const gestures=await mapGestures(cdp,profile);
  currentExploreExperience.step='validation';assertExploreExperience({...experience,passed:true},profile.name,profile.engine,profile.mobile);experience.passed=true;
  const perf=await evaluate(cdp,'({cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0})');
  const longTaskLimit=profile.mobile?350:750;
  if(!(perf.longest<longTaskLimit))performanceIssues.push({profile:profile.name,phase:'map-interactions',metric:'longestTaskMs',value:perf.longest,limit:longTaskLimit});
  currentExploreExperience=null;
  return{profile:profile.name,engine:profile.engine,mobile:profile.mobile,passed:true,firstDirection,firstSelectionTrace:firstSelection.trace,siblingSelectionTrace:siblingSelection.trace,directionHitAreas,catalogScroll,route:{id:trail.id,title:trail.title,offsetPx:trail.offset},line,returnedToRegion:true,returnedToDirections:true,countryCameraRestored:true,countryCameras:{initial:country.camera,returned:returned.camera},secondDirection,polygon,gestures,experience,styleCameraRoundtrip,longestTaskMs:perf.longest,layoutShift:perf.cls,durationMs:Date.now()-started};
}

const httpPort=await freePort(),debugPort=await freePort();
const server=serve(ROOT);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(httpPort,'127.0.0.1',resolve);});
const userData=join(tmpdir(),`tropnik-chrome-${process.pid}`);
const browserLaunchStarted=performance.now();
let browser,cdp,currentProfile,failure,currentExploreExperience=null;
const results=[],desktopProfiles=[],mapInteractions=[],zoomDesigns=[],profilePerformance=[],performanceIssues=[];
// GitHub can terminate this process before catch/finally. Preserve completed
// interactions before the long zoom matrix, without marking them as a release.
const progressDirectory=new URL('../../web/pages-preview/design-qa/',import.meta.url);
async function checkpoint(phase){
  await mkdir(progressDirectory,{recursive:true});
  const temporary=new URL('browser-progress.tmp',progressDirectory);
  await writeFile(temporary,JSON.stringify({verified:false,sourceCommit:process.env.GITHUB_SHA||null,updatedAt:new Date().toISOString(),profile:currentProfile,phase,performanceIssues,profilePerformance,completedMapInteractions:mapInteractions,completedDesktopProfiles:desktopProfiles,completedProfiles:results.map(({name,engine,sheet,touch})=>({name,engine,sheetTested:sheet.available,storyTested:touch.available,layoutShift:touch.cls,longestTaskMs:touch.longest})),completedZoomProfiles:zoomDesigns.map(({profile,geometryPassed,performance})=>({profile,geometryPassed,performance}))},null,2)+'\n');
  await rename(temporary,new URL('browser-progress.json',progressDirectory));
}
try{
  browser=launchBrowser(browserBinary(),[
    '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update',
    '--disable-default-apps','--disable-extensions','--disable-features=Translate,MediaRouter','--mute-audio',
    '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
    `--remote-debugging-port=${debugPort}`,`--user-data-dir=${userData}`,'about:blank',
  ]);
  await browser.waitUntilReady(`http://127.0.0.1:${debugPort}/json/version`);
  const initialUrl=runPolicy.diagnostic==='offline-safety'?'about:blank':`http://127.0.0.1:${httpPort}/tropnik/`;
  const target=await browser.requestJSON(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(initialUrl)}`,{method:'PUT'});
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();
  await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Performance.enable');
  await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__tropnikPerf={cls:0,longest:0};
    window.__tropnikPerfStart=0;window.__tropnikPhase='loading';window.__tropnikPhases=[];window.__tropnikLayoutShifts=[];
    window.__tropnikInputEvents=[];window.__tropnikExpectedPointer=null;window.__tropnikLongTasks=[];
    window.__tropnikRecordLongTask=${recordBrowserLongTask.toString()};
    window.__tropnikScrollEvents=[];window.__tropnikFormInputs=[];window.__tropnikFormSubmits=0;
    for(const type of ['touchstart','touchmove','touchend','wheel'])document.addEventListener(type,event=>{
      const point=event.changedTouches?.[0]||event;
      window.__tropnikScrollEvents.push({type,time:performance.now(),trusted:event.isTrusted,x:point.clientX,y:point.clientY});
      if(window.__tropnikScrollEvents.length>64)window.__tropnikScrollEvents.shift();
    },{capture:true,passive:true});
    document.addEventListener('input',event=>{if(event.target?.closest('[role="dialog"]'))window.__tropnikFormInputs.push({trusted:event.isTrusted,tag:event.target.tagName,value:event.target.value});},{capture:true,passive:true});
    document.addEventListener('submit',event=>{if(event.target?.closest('[role="dialog"]'))window.__tropnikFormSubmits++;},{capture:true,passive:true});
    for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{
      const node=event.target?.nodeType===1?event.target:event.target?.parentElement,button=node?.closest('button,a'),r=button?.getBoundingClientRect();
      window.__tropnikInputEvents.push({type,time:performance.now(),timestamp:event.timeStamp,pointerType:event.pointerType||'',pointerId:Number.isInteger(event.pointerId)?event.pointerId:null,x:event.clientX,y:event.clientY,trusted:event.isTrusted,target:node?node.tagName+'['+(node.getAttribute('class')||'')+']':null,button:button?{tag:button.tagName,classes:button.getAttribute('class'),label:(button.getAttribute('aria-label')||button.textContent||'').trim().slice(0,120),regionId:button.dataset.regionId||null,groupKey:button.dataset.mapGroupKey||null,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}:null});
      if(window.__tropnikInputEvents.length>36)window.__tropnikInputEvents.shift();
    },{capture:true,passive:true});
    try{new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput){
      window.__tropnikPerf.cls+=entry.value;
      const rect=value=>({x:value.x,y:value.y,width:value.width,height:value.height});
      const nodePath=node=>{let element=node?.nodeType===1?node:node?.parentElement;const parts=[];for(let i=0;element&&i<4;i++,element=element.parentElement)parts.push(element.tagName.toLowerCase()+(element.id?'#'+element.id:'')+'['+(element.getAttribute('class')||'').slice(0,180)+']');return parts.join(' < ');};
      window.__tropnikLayoutShifts.push({time:entry.startTime,observedAt:performance.now(),lastInputTime:entry.lastInputTime,counterStart:window.__tropnikPerfStart,phase:window.__tropnikPhase,value:entry.value,cumulative:window.__tropnikPerf.cls,sources:(entry.sources||[]).slice(0,5).map(source=>({node:nodePath(source.node),previous:rect(source.previousRect),current:rect(source.currentRect)}))});
      if(window.__tropnikLayoutShifts.length>40)window.__tropnikLayoutShifts.shift();
    }}).observe({type:'layout-shift',buffered:true});}catch{}
    try{new PerformanceObserver(list=>{for(const entry of list.getEntries()){
      window.__tropnikRecordLongTask(window,{startTime:entry.startTime,duration:entry.duration,name:entry.name,observedAt:performance.now(),phase:window.__tropnikPhase});
    }}).observe({type:'longtask',buffered:true});}catch{}
  `});
  for(const profile of profiles.filter(profile=>!runPolicy.profiles||runPolicy.profiles.includes(profile.name))){
    currentProfile=profile.name;
    if(runPolicy.diagnostic==='terrain-close'){
      const systemInfo=async()=>{
        const version=await browser.requestJSON(`http://127.0.0.1:${debugPort}/json/version`);
        assert.ok(version.webSocketDebuggerUrl,'The browser target does not advertise SystemInfo access');
        const gpuCdp=new CDP(version.webSocketDebuggerUrl);
        try{await gpuCdp.open();return await gpuCdp.call('SystemInfo.getInfo',{},3000);}finally{gpuCdp.close();}
      };
      const report=await runZoomDesignAudit(cdp,profile,{loadProfile,evaluate,waitValue,sleep,settledMap,closeMapSheet,clearMapStories,elementPoint,pointerAt,pointerSelector,diagnosticPhase,mapState,performanceDiagnostics,systemInfo,url:`http://127.0.0.1:${httpPort}/tropnik/`},{diagnostic:runPolicy.diagnostic});
      assert.equal(report.diagnosticOnly,true);assert.equal(report.verified,false);assert.equal(report.releaseEligible,false);
      assert.notEqual(runPolicy.reportFile,'browser-verification.json');
      await writeFile(REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
      continue;
    }
    const geometry=await loadProfile(cdp,`http://127.0.0.1:${httpPort}/tropnik/`,profile);
    assert.equal(geometry.engine,profile.engine,`${profile.name}: expected ${profile.engine}, actually loaded ${geometry.engine}`);
    assert.ok(geometry.scrollWidth<=geometry.width+1,`${profile.name}: horizontal overflow ${geometry.scrollWidth}>${geometry.width}`);
    assert.deepEqual(geometry.escaping,[],`${profile.name}: labels escaped the map viewport`);
    assert.deepEqual(geometry.undersized,[],`${profile.name}: interactive targets smaller than 44 CSS px`);
    if(geometry.card)assert.ok(geometry.card.left>=-1&&geometry.card.right<=geometry.width+1&&geometry.card.top>=-1&&geometry.card.bottom<=geometry.height+1,`${profile.name}: story card escaped the visual viewport`);
    if(!profile.mobile){
      const coarse=await evaluate(cdp,"matchMedia('(pointer:coarse)').matches||navigator.maxTouchPoints>0");
      assert.equal(coarse,false,'The desktop MapLibre check must use a fine pointer');
      const interaction=await mapInteraction(cdp,profile,performanceIssues);mapInteractions.push(interaction);
      desktopProfiles.push({name:profile.name,width:profile.width,height:profile.height,engine:geometry.engine,coarse:false,mapInteractionTested:true});
      profilePerformance.push({profile:profile.name,...await performanceDiagnostics(cdp)});
      if(runPolicy.diagnostic==='map-interactions'){
        assert.notEqual(runPolicy.reportFile,'browser-verification.json');
        const report={schemaVersion:1,diagnostic:runPolicy.diagnostic,diagnosticOnly:true,verified:false,releaseEligible:false,status:'completed',sourceCommit:process.env.GITHUB_SHA||null,profile:profile.name,engine:profile.engine,interaction,performanceIssues,performancePassed:performanceIssues.length===0,performance:profilePerformance.at(-1),completedAt:new Date().toISOString()};
        await writeFile(REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
        await checkpoint('map-interactions-diagnostic-complete');continue;
      }
      await checkpoint('before-zoom-audit');
      zoomDesigns.push(await runZoomDesignAudit(cdp,profile,{loadProfile,evaluate,waitValue,sleep,settledMap,closeMapSheet,clearMapStories,elementPoint,pointerAt,pointerSelector,diagnosticPhase,mapState,url:`http://127.0.0.1:${httpPort}/tropnik/`},{traceEnabled}));
      await checkpoint('profile-complete');
      continue;
    }
    await diagnosticPhase(cdp,'sheet-before');
    const sheet=await touchSheet(cdp);
    await diagnosticPhase(cdp,'sheet-after');
    if(sheet.available){
      assert.equal(sheet.closed.state,'closed',`${profile.name}: initial sheet state`);
      assert.equal(sheet.closed.summaryVisible,true,`${profile.name}: collapsed preview is not visible`);
      assert.equal(sheet.closed.contentVisible,false,`${profile.name}: full content leaks into collapsed preview`);
      assert.equal(sheet.open.state,'open',`${profile.name}: sheet did not open`);
      assert.equal(sheet.open.contentVisible,true,`${profile.name}: opened content is not visible`);
      assert.equal(sheet.open.summaryVisible,false,`${profile.name}: collapsed preview remained visible while open`);
      assert.equal(sheet.final.state,'closed',`${profile.name}: sheet did not close`);
      assert.equal(sheet.final.focused,false,`${profile.name}: sheet handle retained touch focus`);
      assert.ok(sheet.heightDelta<1.1,`${profile.name}: panel height changed during transform animation (${sheet.heightDelta}px)`);
    }
    await diagnosticPhase(cdp,'sheet-gestures-before');
    const sheetGestures=await touchSheetGestures(cdp,profile,sheet);
    await diagnosticPhase(cdp,'sheet-gestures-after');
    await diagnosticPhase(cdp,'layers-before');
    const mapGeometry=await checkMapGeometry(cdp,profile);
    const layerMenus=profile.width<profile.height?await checkPortraitLayerMenus(cdp,profile):null;
    await diagnosticPhase(cdp,'layers-after');
    await diagnosticPhase(cdp,'story-before');
    const touch=await touchPrevious(cdp,profile);
    await diagnosticPhase(cdp,'story-after');
    if(touch.available){
      assert.equal(touch.focused,false,`${profile.name}: story navigation retained touch focus`);
      assert.equal(touch.background,touch.nextBackground,`${profile.name}: previous-story control kept a sticky visual state`);
      if(!(touch.cls<.12))performanceIssues.push({profile:profile.name,phase:'story-after',metric:'layoutShift',value:touch.cls,limit:.12});
      if(!(touch.longest<350))performanceIssues.push({profile:profile.name,phase:'story-after',metric:'longestTaskMs',value:touch.longest,limit:350});
    }
    const interaction=profile.mapInteraction?await mapInteraction(cdp,profile,performanceIssues):null;
    if(interaction)mapInteractions.push(interaction);
    results.push({...profile,geometry,sheet,sheetGestures,mapGeometry,layerMenus,touch,interaction});
    profilePerformance.push({profile:profile.name,...await performanceDiagnostics(cdp)});
    await checkpoint(interaction?'before-zoom-audit':'profile-complete');
    if(profile.mapInteraction)zoomDesigns.push(await runZoomDesignAudit(cdp,profile,{loadProfile,evaluate,waitValue,sleep,settledMap,closeMapSheet,clearMapStories,elementPoint,pointerAt,pointerSelector,diagnosticPhase,mapState,url:`http://127.0.0.1:${httpPort}/tropnik/`},{traceEnabled}));
    if(profile.mapInteraction)await checkpoint('profile-complete');
  }
  if(!runPolicy.diagnostic||runPolicy.diagnostic==='offline-safety'){
  currentProfile='android-offline-safety';
  if(runPolicy.diagnostic==='offline-safety')await cdp.call('Network.enable');
  const offlineSafety=await runOfflineSafetyAudit(cdp,{evaluate,waitValue,sleep,pointerAt,pointerSelector,url:`http://127.0.0.1:${httpPort}/tropnik/`});
  if(runPolicy.diagnostic==='offline-safety'){
    assert.notEqual(runPolicy.reportFile,'browser-verification.json');
    const report={schemaVersion:1,diagnostic:runPolicy.diagnostic,diagnosticOnly:true,verified:false,releaseEligible:false,status:'completed',sourceCommit:process.env.GITHUB_SHA||null,profile:offlineSafety.profile,offlineSafety,completedAt:new Date().toISOString()};
    await writeFile(REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  }else{
  // Keep all pointer and zoom images for diagnosis even when a performance
  // budget fails. Both original strict limits still block verified output/upload.
  assert.deepEqual(performanceIssues,[],'Rendering exceeded the unchanged CLS/long-task budgets');
  const report={verified:true,mapInteractionSchemaVersion:3,browser:'system Chromium via CDP',profiles:results.map(({name,width,height,engine,sheet,sheetGestures,mapGeometry,layerMenus,touch,interaction})=>({name,width,height,engine,interactionTested:touch.available,sheetTested:sheet.available,sheetHeightDelta:sheet.heightDelta??0,sheetGestures,mapGeometry,layerMenus,layoutShift:Math.max(touch.cls??0,sheet.cls??0),longestTaskMs:Math.max(touch.longest??0,sheet.longest??0,interaction?.longestTaskMs??0)})),desktopProfiles,mapInteractions,zoomDesigns,offlineSafety,sourceCommit:process.env.GITHUB_SHA||null};
  await writeFile(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  }
  }
}catch(error){
  failure={profile:currentProfile,error:error.stack||String(error),errorDetails:browserErrorDetails(error),browserStartup:browser?.diagnostics()??{status:'not-started',binary:null,exitCode:null,signalCode:null,elapsedMs:performance.now()-browserLaunchStarted,errorDetails:browserErrorDetails(error)},performanceIssues,profilePerformance,completedMapInteractions:mapInteractions,completedZoomDesigns:zoomDesigns,completedDesktopProfiles:desktopProfiles,completedProfiles:results.map(({name,engine,sheet,sheetGestures,touch})=>({name,engine,sheetTested:sheet.available,sheetGestures,storyTested:touch.available,layoutShift:touch.cls,longestTaskMs:touch.longest}))};
  if(error.layerMenuAudit)failure.layerMenuAudit=error.layerMenuAudit;
  if(error.nativeScroll)failure.nativeScroll=error.nativeScroll;
  if(error.pointerTarget)failure.pointerTarget=error.pointerTarget;
  if(currentExploreExperience)failure.exploreExperience=currentExploreExperience;
  if(runPolicy.diagnostic)Object.assign(failure,{diagnosticOnly:true,diagnostic:runPolicy.diagnostic,verified:false,releaseEligible:false,status:'failed',...(error.settleDiagnostics?{settleDiagnostics:error.settleDiagnostics}:{})});
  if(cdp){
    try{failure.map=await mapState(cdp);failure.selection=await selectionState(cdp);failure.sheet=await sheetSnapshot(cdp);}catch{}
    try{failure.navigationHistory=await cdp.call('Page.getNavigationHistory');}catch{}
    try{failure.performance=await performanceDiagnostics(cdp);}catch{}
    try{const screenshot=await cdp.call('Page.captureScreenshot',{format:'png'});await writeFile(new URL('browser-failure.png',ROOT),Buffer.from(screenshot.data,'base64'));}catch{}
  }
  await writeFile(new URL('browser-failure.json',ROOT),JSON.stringify(failure,null,2)+'\n');
  if(runPolicy.diagnostic)await writeFile(REPORT,JSON.stringify(failure,null,2)+'\n');
  throw error;
}finally{
  cdp?.close();
  const cleanup=await browser?.close();server.closeAllConnections();server.close();
  if(failure){
    failure.browserStartup=browser?.diagnostics()??failure.browserStartup;
    await writeFile(new URL('browser-failure.json',ROOT),JSON.stringify(failure,null,2)+'\n');
  }
  if(cleanup&&['timed-out','error'].includes(cleanup.status)){
    const error=new Error(`Chromium cleanup did not complete: ${JSON.stringify(browser.diagnostics())}`);
    console.error(error.message);
    if(!failure){await writeFile(new URL('browser-failure.json',ROOT),JSON.stringify({error:error.message,browserStartup:browser.diagnostics()},null,2)+'\n');throw error;}
  }
}
