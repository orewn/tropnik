import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {mkdir,readFile,writeFile,stat,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {extname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {launchBrowser,browserErrorDetails} from './browser-startup.mjs';
import {browserEnvironmentArgs,collectBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {collectNativeBrowserSurface,assertNativeSurfaceCoverage} from './browser-native-surface.mjs';
import {projectMapPoint} from './map-projection.mjs';
import {decodeOverlayLine} from '../../web/lib/map-trail-overlay.ts';

const ROOT=fileURLToPath(new URL('../../web/pages-preview/dist/',import.meta.url));
const CAPTURES=fileURLToPath(new URL('../../web/pages-preview/design-qa/trail-overlay/',import.meta.url));
const RECEIPT=join(ROOT,'browser-trail-overlay-verification.json');
const PROFILES=[{name:'desktop',width:1440,height:1000,mobile:false,deviceScaleFactor:1},{name:'phone',width:390,height:844,mobile:true,deviceScaleFactor:2}];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.geojson':'application/geo+json','.coverage':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.pbf':'application/x-protobuf'};

/** Imported by the final publication gate: absent, partial or foreign-build
 * evidence cannot pass merely because a previous browser command exited. */
export function assertTrailOverlayReceipt(report,{sourceCommit,buildId,metadata,environment}={}){
  assert.equal(report?.schemaVersion,1);assert.equal(report?.evidence,'native-catalogue-trail-overlay');
  assert.equal(report.verified,true);assert.match(sourceCommit||'',/^[a-f0-9]{40}$/);
  assert.equal(report.sourceCommit,sourceCommit);assert.equal(report.buildId,buildId);
  assert.equal(report.overlay.sha256,metadata.sha256);assert.equal(report.overlay.sourceDigest,metadata.sourceDigest);
  assert.equal(report.overlay.sources,metadata.uniqueGeometries);
  assert.deepEqual(report.profiles.map(item=>({name:item.name,width:item.width,height:item.height,mobile:item.mobile,deviceScaleFactor:item.deviceScaleFactor})),PROFILES);
  if(environment)assertMatchingBrowserEnvironments(report.environment,environment,sourceCommit);
  for(const item of report.profiles){
    assert.equal(item.verified,true);assert.deepEqual(item.pageErrors,[]);
    assert.deepEqual(item.httpErrors.filter(error=>error.local),[]);
    assert.deepEqual(item.failedRequests.filter(error=>error.local&&!error.canceled),[]);
    assert.equal(item.country.routeId,'');assert.equal(item.country.drawnRoute,'');
    assert.equal(item.country.catalogueOverlay.sources,metadata.uniqueGeometries);assert.ok(item.country.catalogueOverlay.preparedParts>0);
    assert.equal(item.layers.off.catalogueOverlay.sources,0);assert.equal(item.layers.off.catalogueOverlay.preparedParts,0);
    assert.equal(item.layers.on.catalogueOverlay.sources,metadata.uniqueGeometries);assert.ok(item.layers.on.catalogueOverlay.preparedParts>0);
    assert.equal(new URL(item.region.url).searchParams.get('region'),'altai');assert.equal(item.region.routeId,'');
    assert.ok(item.regionSourceKeys.length>0&&item.regionSourceKeys.length<metadata.uniqueGeometries);assert.equal(item.region.catalogueOverlay.sources,item.regionSourceKeys.length);
    assert.ok(item.regionSourceKeys.includes(item.geometry.key));assert.ok(item.region.camera.zoom>=8);
    assert.equal(item.lineHit.pointerType,item.mobile?'touch':'mouse');assert.equal(item.lineHit.trusted,true);assert.equal(item.lineHit.target,'canvas');
    assert.ok(Math.hypot(item.lineHit.actualX-item.lineHit.x,item.lineHit.actualY-item.lineHit.y)<=1,'Observed native input missed its source-line witness');
    assert.ok(item.lineHit.acceptableIds.includes(item.selected.routeId));assert.equal(item.selected.drawnRoute,item.selected.routeId);
    assert.ok(item.selected.camera.zoom>item.country.camera.zoom);
    assert.equal(item.geometry.status,200);assert.equal(item.geometry.sha256,metadata.sourceHashes[item.geometry.key]);
    assert.equal(item.geometry.version,item.geometry.sha256.slice(0,16));assert.ok(item.geometry.ids.includes(item.selected.routeId));
    assert.ok(item.geometry.bytes>0);assert.ok(['cdp-stream','cdp-body'].includes(item.geometry.capture));assert.ok(item.geometry.requestId);assert.equal(item.geometry.error,undefined);
    assert.equal(item.reliefOption,true);assert.equal(item.satelliteOption,true);
    assert.deepEqual(item.screenshots.map(capture=>capture.phase),['country','selected']);
    for(const capture of item.screenshots){assert.match(capture.file,/^(?:desktop|phone)-(?:country|selected)\.png$/);assert.match(capture.sha256,/^[a-f0-9]{64}$/);assert.ok(capture.bytes>1000);}
  }
  return report;
}

class CDP{
  constructor(url){this.url=url;this.next=1;this.pending=new Map();this.observers=new Map();}
  async open(){
    this.socket=new WebSocket(this.url);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CDP connection timed out')),10000);this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connection failed'));},{once:true});});
    this.socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.id){const job=this.pending.get(message.id);if(!job)return;this.pending.delete(message.id);clearTimeout(job.timer);message.error?job.reject(new Error(message.error.message)):job.resolve(message.result);return;}
      for(const callback of this.observers.get(message.method)||[])callback(message.params);
    });
  }
  call(method,params={},timeout=15000){const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP ${method} timed out`));},timeout);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  observe(method,callback){const list=this.observers.get(method)||new Set();list.add(callback);this.observers.set(method,list);return()=>list.delete(callback);}
  close(){for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(new Error('CDP closed'));}this.pending.clear();this.socket?.close();}
}

/** Observe the bytes of the page's own requests, including preload requests.
 * A fetch can consume its complete body and then abort its controller: CDP
 * emits loadingFailed in that case, without decoding getResponseBody content.
 * streamResourceContent preserves that raw prefix and subsequent data chunks.
 * https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-streamResourceContent
 */
export function observeGeometryBytes(cdp,{origin,sources,responses,maxBytes=4*1024*1024}){
  const pending=new Map(),jobs=[],byKey=new Map(sources.map(source=>[source.key,source])),remove=[];
  const append=(state,data,prefix=false)=>{
    if(state.captureError)return;
    const bytes=Buffer.from(data||'','base64');state.length+=bytes.length;
    if(state.length>maxBytes){state.captureError=new Error('Geometry response exceeds the CDP byte budget');state.chunks=[];state.prefix=null;return;}
    if(prefix)state.prefix=bytes;else state.chunks.push(bytes);
  };
  const start=(requestId,url)=>{
    if(!url.startsWith(origin+'/')||!/\.geojson\?v=/.test(url))return;
    if(pending.has(requestId))return pending.get(requestId);
    const parsed=new URL(url),key=parsed.pathname.split('/data/')[1],source=byKey.get(key);
    const state={record:{requestId,url,key,version:parsed.searchParams.get('v'),ids:source?.ids??[]},chunks:[],prefix:null,length:0};pending.set(requestId,state);
    state.streamReady=cdp.call('Network.streamResourceContent',{requestId}).then(result=>{
      // dataReceived may precede the command's acknowledgement. The returned
      // bufferedData always precedes those events; it must not be appended.
      append(state,result.bufferedData,true);state.streaming=true;
    }).catch(error=>{state.streamError=String(error);});
    jobs.push(state.streamReady);return state;
  };
  // Chromium creates ResourceData before requestWillBeSent. Arm at that event
  // so fast local/preloaded responses are observed before their body arrives.
  remove.push(cdp.observe('Network.requestWillBeSent',event=>start(event.requestId,event.request.url)));
  remove.push(cdp.observe('Network.responseReceived',event=>{
    const state=start(event.requestId,event.response.url);if(state)state.record.status=event.response.status;
  }));
  remove.push(cdp.observe('Network.dataReceived',event=>{
    const state=pending.get(event.requestId);if(state&&event.data!==undefined)append(state,event.data);
  }));
  const finish=(event,terminal)=>{
    const state=pending.get(event.requestId);if(!state||state.terminal)return;state.terminal=terminal;
    jobs.push((async()=>{
      await state.streamReady;
      const record={...state.record,terminal,...(terminal==='failed'?{canceled:!!event.canceled,transportError:event.errorText}:{})};
      try{
        if(state.captureError)throw state.captureError;
        let bytes;
        if(state.streaming){bytes=Buffer.concat([state.prefix,...state.chunks],state.length);record.capture='cdp-stream';}
        else{
          // A small resource may finish before streaming is enabled. Reading
          // CDP's retained body observes the same request, never a second GET.
          const body=await cdp.call('Network.getResponseBody',{requestId:event.requestId});
          bytes=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');record.capture='cdp-body';record.streamError=state.streamError;
          if(bytes.length>maxBytes)throw new Error('Geometry response exceeds the CDP byte budget');
        }
        responses.push({...record,bytes:bytes.length,sha256:digest(bytes)});
      }catch(error){responses.push({...record,error:String(error),streamError:state.streamError});}
      finally{state.chunks=[];state.prefix=null;pending.delete(event.requestId);}
    })());
  };
  remove.push(cdp.observe('Network.loadingFinished',event=>finish(event,'finished')));
  remove.push(cdp.observe('Network.loadingFailed',event=>finish(event,'failed')));
  return{settle:()=>Promise.allSettled(jobs),dispose:()=>{remove.forEach(unbind=>unbind());pending.clear();}};
}

async function evaluate(cdp,expression){const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
async function waitValue(label,read,accept,timeout=25000){const deadline=performance.now()+timeout;let last;while(performance.now()<deadline){last=await read();if(accept(last))return last;await pause(80);}throw new Error(`${label}: condition did not settle: ${JSON.stringify(last)}`);}
function readMap(cdp){return evaluate(cdp,`(()=>{
 const host=document.querySelector('.atlas-canvas[data-map-engine="tropnik-canvas"]'),canvas=host?.querySelector('canvas.tropnik-map-canvas');
 if(!host?.dataset.mapInspection||!canvas)return null;const value=JSON.parse(host.dataset.mapInspection),rect=canvas.getBoundingClientRect();
 return{engine:value.engine,camera:value.camera,state:value.state,routeId:value.routeId,drawnRoute:value.drawnRoute,catalogueOverlay:value.catalogueOverlay,drawRevision:value.drawRevision,moving:host.dataset.mapMoving,rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},url:location.href};
})()`);}
const stable=value=>value?.state.ready&&value.moving!=='true'&&value.drawRevision>0;
async function pointer(cdp,profile,point){
  if(profile.mobile){await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:41,radiusX:2,radiusY:2,force:1}]});await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  else{await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,pointerType:'mouse'});await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});}
}
async function pointerSelector(cdp,profile,selector){
  let previous,idle=0;
  const point=await waitValue(selector,()=>evaluate(cdp,`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const rect=element.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,top=document.elementFromPoint(x,y);let animating=false;for(let node=element;node;node=node.parentElement)if(node.getAnimations().some(animation=>animation.pending||animation.playState==='running'))animating=true;return rect.width>0&&rect.height>0&&!element.disabled&&!animating&&(top===element||element.contains(top))?{x,y}:null;})()`),current=>{
    idle=current&&previous&&Math.abs(current.x-previous.x)<.25&&Math.abs(current.y-previous.y)<.25?idle+1:0;previous=current;return idle>=2;
  });
  await pointer(cdp,profile,point);
}
function failureUi(cdp){return evaluate(cdp,`(()=>{
  const box=element=>{if(!element)return null;const rect=element.getBoundingClientRect();return{left:rect.left,top:rect.top,width:rect.width,height:rect.height};};
  const layers=document.querySelector('.layer-button'),menu=document.querySelector('.layer-menu'),credit=document.querySelector('.map-attribution-toggle');
  return{inputs:window.__trailAuditInputs||[],layers:{expanded:layers?.getAttribute('aria-expanded'),rect:box(layers)},menu:{rect:box(menu),checkboxes:[...(menu?.querySelectorAll('input')||[])].map(input=>({checked:input.checked,rect:box(input)}))},credit:{expanded:credit?.getAttribute('aria-expanded'),rect:box(document.querySelector('.map-attribution-content'))},footer:box(document.querySelector('.map-footer')),sheet:document.querySelector('.explore-layout')?.dataset.sheetState};
})()`);}
async function screenshot(cdp,profile,phase){const {data}=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const bytes=Buffer.from(data,'base64'),file=`${profile.name}-${phase}.png`;await writeFile(join(CAPTURES,file),bytes);return{phase,file,bytes:bytes.length,sha256:digest(bytes)};}
function distanceToLine(point,a,b){const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/l)):0;return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);}
async function lineWitness(cdp,map,sources){
  const camera={longitude:map.camera.center[0],latitude:map.camera.center[1],zoom:map.camera.zoom,tileSize:256},level=map.camera.zoom<=8?0:1,parts=[],candidates=[];
  for(const source of sources)for(const part of source.parts){
    const points=decodeOverlayLine(part[level+1]).map(coordinate=>projectMapPoint(coordinate,camera,map.rect));parts.push({ids:source.ids,points});
    for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],length=Math.hypot(a.x-b.x,a.y-b.y);if(length<1)continue;
      for(const ratio of [.5,.25,.75]){const x=a.x+(b.x-a.x)*ratio,y=a.y+(b.y-a.y)*ratio;if(x>map.rect.left+32&&x<map.rect.left+map.rect.width-32&&y>map.rect.top+80&&y<map.rect.top+map.rect.height-100)candidates.push({x,y,length,key:source.key});}
    }
  }
  candidates.sort((a,b)=>b.length-a.length);
  const visible=await evaluate(cdp,`(${JSON.stringify(candidates.slice(0,512))}).filter(point=>document.elementFromPoint(point.x,point.y)?.matches('canvas.tropnik-map-canvas'))`);
  assert.ok(visible.length,'No source-line point is exposed through the actual map UI');
  const witness=visible[0],ids=new Set();
  // Native CSS coordinates are quantised by input dispatch. Accept only source
  // lines lying within one pixel of this exact painted point, including aliases.
  for(const part of parts)for(let i=1;i<part.points.length;i++)if(distanceToLine(witness,part.points[i-1],part.points[i])<=1){part.ids.forEach(id=>ids.add(id));break;}
  assert.ok(ids.size);return{...witness,acceptableIds:[...ids]};
}
function port(){return new Promise((resolve,reject)=>{const server=createNetServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});});}
function binary(){for(const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser'])if(spawnSync('which',[name],{stdio:'ignore'}).status===0)return name;throw new Error('Chromium is unavailable');}
function serve(){return createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith('/tropnik/'))throw new Error('Unexpected prefix');
  let path=resolve(ROOT,decodeURIComponent(url.pathname.slice('/tropnik/'.length))||'index.html');if(!path.startsWith(ROOT))throw new Error('Path leaves artifact');
  if((await stat(path)).isDirectory())path=join(path,'index.html');const bytes=await readFile(path);res.writeHead(200,{'content-type':MIME[extname(path)]||'application/octet-stream','cache-control':'no-store'});res.end(bytes);
 }catch{res.writeHead(404);res.end('Not found');}});}

async function run(){
  const build=JSON.parse(await readFile(join(ROOT,'build-info.json'),'utf8')),metadata=JSON.parse(await readFile(new URL('../../web/lib/trail-overlay.generated.json',import.meta.url),'utf8'));
  const raw=await readFile(join(ROOT,metadata.url.slice(1))),overlay=JSON.parse(raw);
  assert.equal(digest(raw),metadata.sha256);assert.equal(overlay.sources.length,metadata.uniqueGeometries);assert.equal(overlay.sourceDigest,metadata.sourceDigest);assert.equal(build.referenceRoutes,metadata.catalogueRoutes);
  if(process.argv.includes('--check-inputs')){console.log(JSON.stringify({verified:false,browserLaunched:false,inputsMatch:true,buildId:build.buildId,sources:overlay.sources.length}));return;}
  assert.match(process.env.GITHUB_SHA||'',/^[a-f0-9]{40}$/);assert.equal(build.sourceCommit,process.env.GITHUB_SHA);
  await mkdir(CAPTURES,{recursive:true});
  const report={schemaVersion:1,evidence:'native-catalogue-trail-overlay',sourceCommit:build.sourceCommit,buildId:build.buildId,startedAt:new Date().toISOString(),verified:false,overlay:{sha256:metadata.sha256,sourceDigest:metadata.sourceDigest,sources:overlay.sources.length},profiles:[],satelliteScope:'Actual satellite network/rendering remains required by browser-smoke.mjs; this gate verifies the new catalogue layer and selected source.'};
  const checkpoint=()=>writeFile(RECEIPT,JSON.stringify(report,null,2)+'\n');
  const server=serve();let browser,cdp,failure;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,debugPort=await port();
  try{
    browser=launchBrowser(binary(),browserEnvironmentArgs({debugPort,userDataDir:await mkdtemp(join(tmpdir(),'tropnik-overlay-'))}));
    const version=await browser.waitUntilReady(`http://127.0.0.1:${debugPort}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:build.sourceCommit});
    const target=await browser.requestJSON(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'});cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();
    report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);assertNativeSurfaceCoverage(report.environment.nativeSurface,PROFILES);
    await cdp.call('Page.enable');await cdp.call('Runtime.enable');await cdp.call('Network.enable',{maxTotalBufferSize:32*1024*1024,maxResourceBufferSize:4*1024*1024});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__trailAuditInputs=[];for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{const layers=document.querySelector('.layer-button'),rect=layers?.getBoundingClientRect(),control=event.target?.closest('button,input,label,a');window.__trailAuditInputs.push({type:event.type,pointerType:event.pointerType,trusted:event.isTrusted,target:event.target?.matches('canvas.tropnik-map-canvas')?'canvas':event.target?.tagName,x:event.clientX,y:event.clientY,control:control?.className,controlLabel:control?.getAttribute('aria-label')||control?.textContent?.trim(),layersExpanded:layers?.getAttribute('aria-expanded'),layersRect:rect?{left:rect.left,top:rect.top,width:rect.width,height:rect.height}:null,creditExpanded:document.querySelector('.map-attribution-toggle')?.getAttribute('aria-expanded')});if(window.__trailAuditInputs.length>96)window.__trailAuditInputs.shift();},{capture:true});`});
    for(const profile of PROFILES){
      console.log(JSON.stringify({phase:'trail-overlay-profile',profile:profile.name,buildId:build.buildId}));
      const result={...profile,verified:false,pageErrors:[],consoleErrors:[],httpErrors:[],failedRequests:[],geometryResponses:[],screenshots:[]};report.profiles.push(result);await checkpoint();
      const requests=new Map(),remove=[],geometryBytes=observeGeometryBytes(cdp,{origin,sources:overlay.sources,responses:result.geometryResponses});
      remove.push(cdp.observe('Runtime.exceptionThrown',event=>result.pageErrors.push(event.exceptionDetails)));
      remove.push(cdp.observe('Runtime.consoleAPICalled',event=>{if(event.type==='error')result.consoleErrors.push(event.args.map(arg=>arg.value??arg.description).join(' '));}));
      remove.push(cdp.observe('Network.requestWillBeSent',event=>requests.set(event.requestId,event.request.url)));
      remove.push(cdp.observe('Network.loadingFailed',event=>{const url=requests.get(event.requestId)||'';result.failedRequests.push({url,local:url.startsWith(origin+'/'),canceled:!!event.canceled,error:event.errorText});}));
      remove.push(cdp.observe('Network.responseReceived',event=>{
        const {url,status}=event.response;if(status>=400)result.httpErrors.push({url,status,local:url.startsWith(origin+'/')});
      }));
      try{
        await cdp.call('Emulation.setDeviceMetricsOverride',{width:profile.width,height:profile.height,deviceScaleFactor:profile.deviceScaleFactor,mobile:profile.mobile,screenWidth:profile.width,screenHeight:profile.height});
        await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:profile.mobile,maxTouchPoints:profile.mobile?5:1});
        await cdp.call('Page.navigate',{url:origin+'/tropnik/'});
        result.country=await waitValue('complete catalogue without a selected card',()=>readMap(cdp),value=>stable(value)&&value.routeId===''&&value.catalogueOverlay.sources===metadata.uniqueGeometries&&value.catalogueOverlay.preparedParts>0);
        result.screenshots.push(await screenshot(cdp,profile,'country'));
        await pointerSelector(cdp,profile,'.layer-button');
        const checkbox='.layer-menu label:first-of-type input[type="checkbox"]';
        await pointerSelector(cdp,profile,checkbox);
        const off=await waitValue('hidden paths',()=>readMap(cdp),value=>stable(value)&&value.catalogueOverlay.sources===0&&value.catalogueOverlay.preparedParts===0);
        await pointerSelector(cdp,profile,checkbox);
        const on=await waitValue('restored paths',()=>readMap(cdp),value=>stable(value)&&value.catalogueOverlay.sources===metadata.uniqueGeometries&&value.catalogueOverlay.preparedParts>0);
        result.layers={off,on};await pointerSelector(cdp,profile,'.layer-button');
        if(profile.mobile&&await evaluate(cdp,'document.querySelector(".explore-layout")?.dataset.sheetState==="closed"'))await pointerSelector(cdp,profile,'.sheet-peek-summary');
        const regionButton='.region-option:has(.region-thumbnail-altai)';
        await evaluate(cdp,`document.querySelector(${JSON.stringify(regionButton)})?.scrollIntoView({block:'nearest',inline:'nearest'})`);
        await pointerSelector(cdp,profile,regionButton);
        result.region=await waitValue('Altai catalogue without a selected card',()=>readMap(cdp),value=>stable(value)&&new URL(value.url).searchParams.get('region')==='altai'&&value.routeId===''&&value.catalogueOverlay.sources>0&&value.catalogueOverlay.sources<metadata.uniqueGeometries);
        if(profile.mobile&&await evaluate(cdp,'document.querySelector(".explore-layout")?.dataset.sheetState==="open"'))await pointerSelector(cdp,profile,'.sheet-handle');
        for(let step=0;step<6&&result.region.camera.zoom<8;step++){
          const previous=result.region.camera.zoom;await pointerSelector(cdp,profile,'.map-controls button[aria-label="Увеличить масштаб"]');
          result.region=await waitValue('Altai zoom via native control',()=>readMap(cdp),value=>stable(value)&&value.routeId===''&&value.camera.zoom>=previous+.95);
        }
        const regionalIds=new Set(await evaluate(cdp,'[...document.querySelectorAll(".tropnik-point-marker[data-trail-id]")].map(element=>element.dataset.trailId).filter(Boolean)'));
        const regionalSources=overlay.sources.filter(source=>source.ids.some(id=>regionalIds.has(id))).map(source=>({...source,ids:source.ids.filter(id=>regionalIds.has(id))}));
        result.regionSourceKeys=regionalSources.map(source=>source.key);assert.equal(regionalSources.length,result.region.catalogueOverlay.sources,'DOM route identities must cover the complete filtered overlay');
        const witness=await lineWitness(cdp,result.region,regionalSources);await pointer(cdp,profile,witness);
        result.selected=await waitValue('native source-line selection',()=>readMap(cdp),value=>stable(value)&&!!value.routeId&&value.routeId===value.drawnRoute);
        const input=await evaluate(cdp,'window.__trailAuditInputs.filter(input=>input.type==="pointerup"&&input.target==="canvas").at(-1)');
        result.lineHit={...witness,pointerType:input?.pointerType,trusted:input?.trusted,target:input?.target,actualX:input?.x,actualY:input?.y};
        assert.ok(witness.acceptableIds.includes(result.selected.routeId),'Native line click opened another source');
        if(profile.mobile&&await evaluate(cdp,'document.querySelector(".explore-layout")?.dataset.sheetState==="open"'))await pointerSelector(cdp,profile,'.sheet-handle');
        result.selected=await waitValue('selected route after panel transition',()=>readMap(cdp),value=>stable(value)&&value.routeId===result.selected.routeId);
        result.screenshots.push(await screenshot(cdp,profile,'selected'));
        const options=await evaluate(cdp,'({relief:!!document.querySelector(".map-style-switch button[aria-label=Рельеф]"),satellite:!!document.querySelector(".map-style-switch button[aria-label=Спутник]")})');result.reliefOption=options.relief;result.satelliteOption=options.satellite;
        const selectedBytes=await waitValue('versioned selected source bytes',async()=>{
          await geometryBytes.settle();const observed=result.geometryResponses.filter(item=>item.ids?.includes(result.selected.routeId));
          return{match:observed.find(item=>item.status===200&&item.sha256===metadata.sourceHashes[item.key]&&item.version===item.sha256.slice(0,16)),observed};
        },value=>!!value.match);result.geometry=selectedBytes.match;
        result.verified=true;
      }catch(error){result.failure=browserErrorDetails(error);result.lastInspection=await readMap(cdp).catch(()=>null);result.failureUi=await failureUi(cdp).catch(()=>null);try{result.failureCapture=await screenshot(cdp,profile,'failure');}catch{}throw error;}
      finally{await geometryBytes.settle();geometryBytes.dispose();remove.forEach(unbind=>unbind());await checkpoint();}
    }
    report.verified=true;assertTrailOverlayReceipt(report,{sourceCommit:build.sourceCommit,buildId:build.buildId,metadata});
  }catch(error){failure=error;report.verified=false;report.failure=browserErrorDetails(error);}
  finally{cdp?.close();if(browser){await browser.close();report.browserProcess=browser.diagnostics();}await new Promise(resolve=>server.close(resolve));report.finishedAt=new Date().toISOString();await checkpoint();}
  if(failure)throw failure;
  console.log(JSON.stringify({verified:true,sourceCommit:report.sourceCommit,buildId:report.buildId,sources:report.overlay.sources,profiles:report.profiles.map(item=>item.name),receipt:RECEIPT}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(error=>{console.error(error);process.exitCode=1;});
