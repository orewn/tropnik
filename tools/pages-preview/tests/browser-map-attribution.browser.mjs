import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {launchBrowser,BROWSER_STARTUP_LIMITS,browserErrorDetails} from '../browser-startup.mjs';
import {browserEnvironmentArgs,collectBrowserEnvironment} from '../browser-environment.mjs';
import {collectNativeBrowserSurface} from '../browser-native-surface.mjs';
import {MAP_ATTRIBUTION_PROFILES,MAP_ATTRIBUTION_SCENARIOS} from '../map-attribution-verification.mjs';

const root=resolve(import.meta.dirname,'../../..'),web=join(root,'web'),require=createRequire(join(web,'package.json'));
const viteRequire=createRequire(require.resolve('vite')),{build}=viteRequire('esbuild'),{transform}=viteRequire('lightningcss');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profiles=MAP_ATTRIBUTION_PROFILES,scenarios=MAP_ATTRIBUTION_SCENARIOS;
const binary=['google-chrome','google-chrome-stable','chromium','chromium-browser'].find(name=>spawnSync('which',[name],{stdio:'ignore'}).status===0);
let fixturePromise;
function productionFixture(){return fixturePromise??=(async()=>{
 const layout=await readFile(join(web,'app/layout.tsx'),'utf8'),files=[...layout.matchAll(/^import ["']([^"']+\.css)["'];/gm)].map(match=>match[1].startsWith('./')?'app/'+match[1].slice(2):match[1]);
 assert.ok(files.length>=10,'Consume the complete production CSS cascade');
 const cssFiles=[],styles=[];
 for(const file of files){
  const path=file.startsWith('@')?require.resolve(file):join(web,file),bytes=await readFile(path);let css=bytes.toString();cssFiles.push({path:file,sha256:sha(bytes)});
  if(file.startsWith('@fontsource/'))for(const match of [...css.matchAll(/url\((\.\/[^)]+)\)/g)]){
   const font=await readFile(resolve(dirname(path),match[1])),format=match[1].endsWith('.woff2')?'woff2':'woff';
   css=css.replace(match[0],`url(data:font/${format};base64,${font.toString('base64')})`);
  }
  styles.push(css);
 }
 const css=transform({filename:'production-map-attribution.css',code:Buffer.from(styles.join('\n')),minify:true,targets:{chrome:107<<16}}).code.toString();
 const bundled=await build({stdin:{contents:`import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {createElement} from 'react';import {MapAttribution} from './components/MapAttribution';import {russiaView} from './lib/russia-map';const root=createRoot(document.getElementById('fixture-credit'));window.renderAttribution=props=>{flushSync(()=>root.render(createElement(MapAttribution,props)));russiaView(document.querySelector('.atlas-canvas'));};window.renderAttribution({satellite:true,satelliteLoading:true,zoom:14});`,resolveDir:web,sourcefile:'attribution-fixture.ts'},bundle:true,write:false,minify:true,metafile:true,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':web},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const script=bundled.outputFiles[0].text,sourceFiles=['components/MapAttribution.tsx','components/MapIcon.tsx','lib/map-attribution.ts','lib/map-satellite.ts','lib/russia-map.ts'];
 const sources={layoutSHA256:sha(layout),fixtureSHA256:sha(await readFile(new URL(import.meta.url))),cssFiles,compiledCssSHA256:sha(css),bundleSHA256:sha(script),files:await Promise.all(sourceFiles.map(async path=>({path,sha256:sha(await readFile(join(web,path)))})))};
 for(const file of sourceFiles)assert.ok(Object.keys(bundled.metafile.inputs).some(input=>input.endsWith('/'+file)),`The actual ${file} must be bundled`);
 const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><header style="height:var(--header)"></header><main><section class="explore-layout sheet-closed" data-sheet-state="closed"><aside class="explore-panel"></aside><div class="atlas-wrap tropnik-custom-atlas"><div class="atlas-canvas"></div><div id="fixture-credit"></div></div></section></main><script>${script.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 return{html,sources};
})();}

test('attribution fixture bundles the actual interactive component, complete CSS and Cyrillic font bytes',async()=>{
 const fixture=await productionFixture();assert.equal(fixture.sources.cssFiles.filter(file=>file.path.startsWith('@fontsource/manrope/')).length,8);
 assert.match(fixture.html,/data:font\/woff2;base64,/);assert.doesNotMatch(fixture.html,/url\(["']?\.\/files\/manrope/);
 assert.deepEqual(fixture.sources.files.map(file=>file.path),['components/MapAttribution.tsx','components/MapIcon.tsx','lib/map-attribution.ts','lib/map-satellite.ts','lib/russia-map.ts']);
});

const geometryExpression=`(()=>{
 const box=element=>{if(!element)return null;const r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
 const attribution=document.querySelector('.map-attribution'),credit=document.querySelector('.map-satellite-credit'),status=document.querySelector('.map-satellite-status'),toggle=document.querySelector('.map-attribution-toggle'),content=document.querySelector('.map-attribution-content'),rect=box(toggle),creditStyle=getComputedStyle(credit);
 const text=element=>{const range=document.createRange();range.selectNodeContents(element);return{value:element.textContent,rect:box(range),visible:getComputedStyle(element).visibility==='visible'}};
 return{rect:box(attribution),credit:box(credit),content:box(content),toggle:rect,expanded:toggle.getAttribute('aria-expanded')==='true',source:credit.dataset.imagerySource,fontFamily:creditStyle.fontFamily,fontSize:creditStyle.fontSize,lineHeight:creditStyle.lineHeight,anchors:[...credit.querySelectorAll('a')].map(element=>({...text(element),href:element.href})),details:[...credit.querySelectorAll('.map-satellite-detail:not(.map-satellite-status)')].map(text),status:{...text(status),ariaHidden:status.getAttribute('aria-hidden'),focusableChildren:status.querySelectorAll('a,button,input,select,textarea,[tabindex]').length},contentText:content?.textContent||null,blocked:[[.5,.5],[.3,.3],[.7,.3],[.3,.7],[.7,.7]].some(([x,y])=>!toggle.contains(document.elementFromPoint(rect.left+rect.width*x,rect.top+rect.height*y))),documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};
})()`;
const stableGeometry=value=>({rect:value.rect,credit:value.credit,content:value.content,toggle:value.toggle,anchors:value.anchors,details:value.details,statusRect:value.status.rect,contentText:value.contentText});
function assertReadable(value,profile,scenario,expanded,loading){
 assert.equal(value.expanded,expanded);assert.equal(value.source,scenario.source);assert.equal(value.blocked,false,'The actual 44px licence control must remain reachable');
 assert.ok(value.toggle.width>=44&&value.toggle.height>=44);assert.ok(value.credit.left>=0&&value.credit.right<=profile.width,'The entire source card must fit the viewport');
 assert.ok(value.credit.top>=0&&value.credit.bottom<=profile.height,'The source card must remain visible');assert.ok(value.documentWidth<=profile.width,'Attribution must not add horizontal overflow');
 assert.match(value.fontFamily,/Manrope/);assert.equal(value.fontSize,'12px');assert.equal(value.lineHeight,'16px');assert.equal(value.anchors.length,2);
 assert.equal(value.anchors[0].value,scenario.source==='eox-s2'?'EOxCloudless':'NASA Blue Marble');assert.equal(value.anchors[1].value,'EOX');
 for(const text of [...value.anchors,...value.details,...(loading?[value.status]:[])]){
  assert.equal(text.visible,true);assert.ok(text.rect.left>=value.credit.left&&text.rect.right<=value.credit.right&&text.rect.top>=value.credit.top&&text.rect.bottom<=value.credit.bottom,'All visible source text must fit its card');
 }
 assert.equal(value.status.value,'Загружаем снимки…');assert.equal(value.status.visible,loading);assert.equal(value.status.ariaHidden,String(!loading));assert.equal(value.status.focusableChildren,0);
 if(expanded){assert.match(value.contentText,/OpenStreetMap contributors/);assert.match(value.contentText,/Данные и лицензии/);assert.match(value.contentText,scenario.source==='eox-s2'?/CC BY 4\.0/:/NASA Earth Observatory/);}
}

test('satellite attribution retains exact geometry over loading cycles with all visible credits and 44px controls',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+55000,
},async t=>{
 assert.ok(binary,'A Chromium binary is required for the production attribution geometry gate');
 const fixture=await productionFixture(),directory=await mkdtemp(join(tmpdir(),'tropnik-map-attribution-'));
 const lease=createServer();await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory})),output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/map-attribution');
 const report={schemaVersion:1,verified:false,phase:'browser-startup',sourceCommit:process.env.GITHUB_SHA||null,evidence:'production-react-and-compiled-css-browser-geometry',sources:fixture.sources,profiles,negativeControls:[],cases:[]};let socket,cdp;
 t.after(async()=>{socket?.close();await browser.close();await rm(directory,{recursive:true,force:true});await mkdir(output,{recursive:true});report.browserStartup=browser.diagnostics();await writeFile(join(output,'browser-map-attribution-verification.json'),JSON.stringify(report,null,2)+'\n');});
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  cdp={call:(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Attribution CDP timeout: '+method));},5000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));})};
  const evaluate=async expression=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.equal(result.exceptionDetails,undefined);return result.result.value;};
  const settle=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const render=async(scenario,loading)=>{await evaluate(`window.renderAttribution(${JSON.stringify({satellite:true,satelliteSource:scenario.source,satelliteLoading:loading,zoom:scenario.zoom})})`);await settle();return evaluate(geometryExpression);};
  const setExpanded=async expanded=>{
   const before=await evaluate(geometryExpression);if(before.expanded===expanded)return;const x=before.toggle.left+before.toggle.width/2,y=before.toggle.top+before.toggle.height/2;
   await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});await settle();
   // Let the actual 300ms press-release transform finish before measuring
   // loading changes. Do not disable motion or alter the production CSS.
   await evaluate("Promise.race([Promise.all(document.querySelector('.map-attribution-toggle').getAnimations().map(animation=>animation.finished.catch(()=>{}))),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Attribution toggle transition did not finish')),1000))])");
   await settle();assert.equal((await evaluate(geometryExpression)).expanded,expanded);
  };
  report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);await mkdir(pictures,{recursive:true});
  for(const profile of profiles){
   report.phase=profile.name;await cdp.call('Emulation.setDeviceMetricsOverride',{width:profile.width,height:profile.height,deviceScaleFactor:profile.dpr,mobile:profile.mobile,screenWidth:profile.width,screenHeight:profile.height});await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:profile.mobile,maxTouchPoints:profile.mobile?5:1});
   await cdp.call('Page.navigate',{url:'data:text/html;charset=utf-8,'+encodeURIComponent(fixture.html)});
   let loaded=false;for(let attempt=0;attempt<80;attempt++){if(await evaluate("!!document.querySelector('.map-satellite-status')")){loaded=true;break;}await sleep(25);}assert.ok(loaded,'The actual React component must mount');
   const fonts=await evaluate(`(async()=>{const faces=[...document.fonts].filter(face=>face.family.replace(/['"]/g,'')==='Manrope');await Promise.all(faces.map(face=>face.load()));await document.fonts.ready;return faces.map(face=>({family:face.family,weight:face.weight,status:face.status}))})()`);assert.equal(fonts.length,8);assert.ok(fonts.every(face=>face.status==='loaded'));
   await render(scenarios[0],true);await setExpanded(false);
   // Recreate the old conditional absence using display:none on the same
   // real text node. This override is removed before every corrected case.
   await evaluate("(()=>{const style=document.createElement('style');style.id='previous-attribution-status';style.textContent='.map-satellite-status[aria-hidden=\"true\"]{display:none}';document.head.appendChild(style)})()");
   const previousLoading=await render(scenarios[0],true),previousReady=await render(scenarios[0],false);
   assert.notDeepEqual(previousLoading.credit,previousReady.credit,'The negative control must reproduce loading-dependent source reflow');
   report.negativeControls.push({profile:profile.name,loading:stableGeometry(previousLoading),ready:stableGeometry(previousReady),fonts});await evaluate("document.getElementById('previous-attribution-status').remove()");
   for(const scenario of scenarios)for(const expanded of [false,true]){
    const name=`${profile.name}-${scenario.name}-${expanded?'expanded':'collapsed'}`;report.phase=name;await render(scenario,true);await setExpanded(expanded);
    const cycles=profile.name==='android-portrait'&&scenario.name==='detail'&&!expanded?14:3,entry={name,profile:profile.name,source:scenario.source,zoom:scenario.zoom,expanded,cycles,comparisons:[]};report.cases.push(entry);
    for(let cycle=0;cycle<cycles;cycle++){
     const loading=await render(scenario,true),ready=await render(scenario,false);
     if(cycle===0){entry.loading=loading;entry.ready=ready;}
     const loadingGeometry=stableGeometry(loading),readyGeometry=stableGeometry(ready);entry.comparisons.push({cycle:cycle+1,loading:loadingGeometry,ready:readyGeometry});
     assertReadable(loading,profile,scenario,expanded,true);assertReadable(ready,profile,scenario,expanded,false);assert.deepEqual(readyGeometry,loadingGeometry,`${name}: a tile request must not move the source, licence popup, or control`);
    }
    if(scenario.name===(expanded?'overview-limit':'detail')){
     const {data}=await cdp.call('Page.captureScreenshot',{format:'png'}),bytes=Buffer.from(data,'base64'),filename=name+'.png';await writeFile(join(pictures,filename),bytes);entry.screenshot={path:'design-qa/map-attribution/'+filename,bytes:bytes.length,sha256:sha(bytes)};
    }
   }
  }
  assert.equal(report.cases.length,40);assert.equal(report.negativeControls.length,5);report.phase='complete';report.verified=true;
 }catch(error){
  report.failure=browserErrorDetails(error);
  if(cdp)try{const {data}=await cdp.call('Page.captureScreenshot',{format:'png'}),bytes=Buffer.from(data,'base64');await mkdir(pictures,{recursive:true});await writeFile(join(pictures,'failure.png'),bytes);report.failureScreenshot={path:'design-qa/map-attribution/failure.png',bytes:bytes.length,sha256:sha(bytes)};}catch(captureError){report.failureScreenshotError=browserErrorDetails(captureError);}
  throw error;
 }
});
