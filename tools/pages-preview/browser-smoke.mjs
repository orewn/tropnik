import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, writeFile, stat} from 'node:fs/promises';
import {spawn, spawnSync} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, normalize, extname} from 'node:path';

const ROOT = new URL('../../web/pages-preview/dist/', import.meta.url);
const REPORT = new URL('browser-verification.json', ROOT);
const profiles = [
  {name:'compact-android',width:320,height:640},
  {name:'iphone-portrait',width:390,height:844},
  {name:'android-portrait',width:412,height:915},
  {name:'phone-landscape',width:844,height:390},
];
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
async function waitFor(url,attempts=80){
  let last;
  for(let attempt=0;attempt<attempts;attempt++){
    try{const response=await fetch(url,{cache:'no-store'});if(response.ok)return response;}catch(error){last=error;}
    await sleep(100);
  }
  throw last||new Error(`Timed out waiting for ${url}`);
}
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
  constructor(url){this.url=url;this.next=1;this.pending=new Map();this.listeners=new Map();}
  async open(){
    this.socket=new WebSocket(this.url);
    await new Promise((resolve,reject)=>{this.socket.addEventListener('open',resolve,{once:true});this.socket.addEventListener('error',reject,{once:true});});
    this.socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.id){const waiter=this.pending.get(message.id);if(!waiter)return;this.pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);return;}
      const waiters=this.listeners.get(message.method);if(!waiters?.length)return;
      this.listeners.set(message.method,[]);for(const waiter of waiters)waiter(message.params);
    });
  }
  call(method,params={}){
    const id=this.next++;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});
  }
  event(method,timeout=15000){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${method}`)),timeout);
      const wrapped=value=>{clearTimeout(timer);resolve(value);};
      this.listeners.set(method,[...(this.listeners.get(method)||[]),wrapped]);
    });
  }
  close(){this.socket?.close();}
}
async function evaluate(cdp,expression){
  const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'Browser evaluation failed');
  return result.result.value;
}
async function loadProfile(cdp,url,profile){
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:profile.width,height:profile.height,deviceScaleFactor:2,mobile:true,screenWidth:profile.width,screenHeight:profile.height});
  await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
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
  await evaluate(cdp,`window.__tropnikPerf={cls:0,longest:0}`);
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
    return{available:true,state:root.dataset.sheetState,height:rect.height,top:rect.top,transform:getComputedStyle(panel).transform,summaryVisible:visible(summary),contentVisible:visible(content),focused:document.activeElement===handle};
  })()`);
}
async function touchSheet(cdp){
  let closed=await sheetSnapshot(cdp);
  if(!closed.available)return{available:false};
  if(closed.state!=='closed'){
    assert.equal(await tapSelector(cdp,'.sheet-handle',7),true);
    await sleep(380);closed=await sheetSnapshot(cdp);
  }
  assert.equal(await tapSelector(cdp,'.sheet-handle',8),true);
  await sleep(380);const open=await sheetSnapshot(cdp);
  assert.equal(await tapSelector(cdp,'.sheet-handle',9),true);
  await sleep(380);const final=await sheetSnapshot(cdp);
  const perf=await evaluate(cdp,`(()=>({cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0}))()`);
  return{available:true,closed,open,final,heightDelta:Math.max(Math.abs(open.height-closed.height),Math.abs(final.height-closed.height)),cls:perf.cls,longest:perf.longest};
}
async function touchPrevious(cdp){
  const point=await evaluate(cdp,`(()=>{const button=document.querySelector('.fact-controls button[aria-label="Предыдущая история"]');if(!button)return null;const r=button.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if(!point)return{available:false};
  await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1,radiusX:2,radiusY:2,force:1}]});
  await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await sleep(240);
  return evaluate(cdp,`(()=>{
    const previous=document.querySelector('.fact-controls button[aria-label="Предыдущая история"]');
    const next=document.querySelector('.fact-controls button[aria-label="Следующая история"]');
    if(!previous||!next)return{available:false};
    const a=getComputedStyle(previous),b=getComputedStyle(next);
    return{available:true,focused:document.activeElement===previous,hovered:previous.matches(':hover'),background:a.backgroundColor,nextBackground:b.backgroundColor,transition:a.transitionDuration,cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0};
  })()`);
}

const httpPort=await freePort(),debugPort=await freePort();
const server=serve(ROOT);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(httpPort,'127.0.0.1',resolve);});
const userData=join(tmpdir(),`tropnik-chrome-${process.pid}`);
const browser=spawn(browserBinary(),[
  '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update',
  '--disable-default-apps','--disable-extensions','--disable-features=Translate,MediaRouter','--mute-audio',
  `--remote-debugging-port=${debugPort}`,`--user-data-dir=${userData}`,'about:blank',
],{stdio:['ignore','ignore','pipe']});
let browserErrors='';browser.stderr.on('data',chunk=>{browserErrors+=chunk;});
let cdp;
try{
  await waitFor(`http://127.0.0.1:${debugPort}/json/version`);
  const target=await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${httpPort}/tropnik/`)}`,{method:'PUT'})).json();
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();
  await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Performance.enable');
  await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__tropnikPerf={cls:0,longest:0};
    try{new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.__tropnikPerf.cls+=entry.value;}).observe({type:'layout-shift',buffered:true});}catch{}
    try{new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__tropnikPerf.longest=Math.max(window.__tropnikPerf.longest,entry.duration);}).observe({type:'longtask',buffered:true});}catch{}
  `});
  const results=[];
  for(const profile of profiles){
    const geometry=await loadProfile(cdp,`http://127.0.0.1:${httpPort}/tropnik/`,profile);
    assert.equal(geometry.engine,'leaflet',`${profile.name}: mobile profile loaded the heavy ${geometry.engine} engine`);
    assert.ok(geometry.scrollWidth<=geometry.width+1,`${profile.name}: horizontal overflow ${geometry.scrollWidth}>${geometry.width}`);
    assert.deepEqual(geometry.escaping,[],`${profile.name}: labels escaped the map viewport`);
    assert.deepEqual(geometry.undersized,[],`${profile.name}: interactive targets smaller than 44 CSS px`);
    if(geometry.card)assert.ok(geometry.card.left>=-1&&geometry.card.right<=geometry.width+1&&geometry.card.top>=-1&&geometry.card.bottom<=geometry.height+1,`${profile.name}: story card escaped the visual viewport`);
    const sheet=await touchSheet(cdp);
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
    const touch=await touchPrevious(cdp);
    if(touch.available){
      assert.equal(touch.focused,false,`${profile.name}: story navigation retained touch focus`);
      assert.equal(touch.background,touch.nextBackground,`${profile.name}: previous-story control kept a sticky visual state`);
      assert.ok(touch.cls<.12,`${profile.name}: interaction layout shift ${touch.cls}`);
      assert.ok(touch.longest<350,`${profile.name}: long task ${touch.longest}ms`);
    }
    results.push({...profile,geometry,sheet,touch});
  }
  const report={verified:true,browser:'system Chromium via CDP',profiles:results.map(({name,width,height,sheet,touch})=>({name,width,height,interactionTested:touch.available,sheetTested:sheet.available,sheetHeightDelta:sheet.heightDelta??0,layoutShift:Math.max(touch.cls??0,sheet.cls??0),longestTaskMs:Math.max(touch.longest??0,sheet.longest??0)})),sourceCommit:process.env.GITHUB_SHA||null};
  await writeFile(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{
  cdp?.close();browser.kill('SIGTERM');server.close();
  await sleep(100);
  if(browser.exitCode&&browser.exitCode!==0)console.error(browserErrors.slice(-4000));
}
