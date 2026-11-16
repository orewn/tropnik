import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {createServer as createHTTPServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {launchBrowser,BROWSER_STARTUP_LIMITS,browserErrorDetails} from '../browser-startup.mjs';
import {browserEnvironmentArgs,collectBrowserEnvironment} from '../browser-environment.mjs';
import {collectNativeBrowserSurface} from '../browser-native-surface.mjs';
import {MAP_ATTRIBUTION_PROFILES,MAP_ATTRIBUTION_SCENARIOS,MAP_ATTRIBUTION_LAYOUT_CASES,assertAttributionFooterLayout,assertAttributionSheetCycle,footerLoadingGeometry,collectAttributionGeometryCase,attributionGeometry,assertCompactAttributionSnapshot} from '../map-attribution-verification.mjs';

const root=resolve(import.meta.dirname,'../../..'),web=join(root,'web'),require=createRequire(join(web,'package.json'));
const viteRequire=createRequire(require.resolve('vite')),{build}=viteRequire('esbuild'),{transform}=viteRequire('lightningcss');
const ts=require('typescript');
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
 // These are the real footer, rail and launcher JSX subtrees. Only transport,
 // camera effects and their event callbacks are excluded from the layout test.
 const uiFiles=['components/CustomAtlas.tsx','components/PlaceStories.tsx'],ui=await Promise.all(uiFiles.map(path=>readFile(join(web,path),'utf8')));
 const subtrees=(source,filename,wanted)=>{
  const tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),parts=new Map();
  const visit=node=>{if(ts.isJsxElement(node)){
   const name=node.openingElement.tagName.getText(tree),attribute=node.openingElement.attributes.properties.find(item=>ts.isJsxAttribute(item)&&item.name.text==='className'&&item.initializer&&ts.isStringLiteral(item.initializer)),key=name==='MapFooter'?name:attribute?.initializer.text;
   if(wanted.includes(key))parts.set(key,node.getText(tree));
  }ts.forEachChild(node,visit);};visit(tree);assert.equal(parts.size,wanted.length,filename+': actual layout subtrees must exist');return parts;
 };
 const parts=subtrees(ui[0],'CustomAtlas.tsx',['MapFooter','map-controls','layer-control','map-style-switch','map-context']),launcher=subtrees(ui[1],'PlaceStories.tsx',['fact-closed']).get('fact-closed');
 const bundled=await build({stdin:{contents:`
 import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {createRef} from 'react';
 import {MapAttribution,MapFooter} from './components/MapAttribution';import {MapIcon} from './components/MapIcon';import {Compass} from './components/TropnikIcons';import {russiaView} from './lib/russia-map';
 const noOperation=()=>{},engine={current:null},scaleValue=createRef(),scaleLine=createRef();
 const locate=noOperation,fitAll=noOperation,setLayers=noOperation,changeMode=noOperation,setPaths=noOperation,setRelief=noOperation,setBoundaries=noOperation,setDismissed=noOperation;
 function Fixture({props,layout}){
  const satelliteVisible=props.satellite,satellite=true,zoom=props.zoom,planning=false,trail=null,region=null,visibleTrails=[],routeCountLabel=()=>'',contours=null,message='',layers=false,offline=false,paths=true,relief=true,boundaries=true;
  const state={ready:props.ready??true,loading:layout.loading,reliefReady:false,imageryLoading:props.satelliteLoading,imagerySource:props.satelliteSource||'eox-s2'};
  return <section className={'explore-layout sheet-'+(layout.sheetOpen?'open':'closed')} data-sheet-state={layout.sheetOpen?'open':'closed'}>
   <aside className={'explore-panel '+(layout.sheetOpen?'expanded':'collapsed')}/>
   <div className="atlas-wrap tropnik-custom-atlas"><div className="atlas-canvas"/>${parts.get('map-context')}${parts.get('map-style-switch')}${parts.get('map-controls')}${parts.get('layer-control')}${parts.get('MapFooter')}</div>${launcher}
  </section>;
 }
 const root=createRoot(document.getElementById('fixture-root'));window.resetAttribution=returning=>{flushSync(()=>root.render(null));if(returning)sessionStorage.setItem('tropnik-map-attribution-seen','1');else sessionStorage.removeItem('tropnik-map-attribution-seen');return sessionStorage.getItem('tropnik-map-attribution-seen')};window.renderAttribution=(props,layout={})=>{flushSync(()=>root.render(<Fixture props={props} layout={{loading:false,sheetOpen:false,...layout}}/>));russiaView(document.querySelector('.atlas-canvas'));if(scaleValue.current)scaleValue.current.textContent='10 км';};window.renderAttribution({satellite:true,satelliteLoading:true,zoom:14});`,resolveDir:web,sourcefile:'attribution-fixture.tsx',loader:'tsx'},bundle:true,write:false,minify:true,metafile:true,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':web},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const script=bundled.outputFiles[0].text,sourceFiles=['components/MapAttribution.tsx','components/MapIcon.tsx','components/TropnikIcons.tsx','lib/map-satellite.ts','lib/russia-map.ts'];
 const sources={layoutSHA256:sha(layout),fixtureSHA256:sha(await readFile(new URL(import.meta.url))),cssFiles,compiledCssSHA256:sha(css),bundleSHA256:sha(script),uiFiles:uiFiles.map((path,index)=>({path,sha256:sha(ui[index])})),files:await Promise.all(sourceFiles.map(async path=>({path,sha256:sha(await readFile(join(web,path)))})))};
 for(const file of sourceFiles)assert.ok(Object.keys(bundled.metafile.inputs).some(input=>input.endsWith('/'+file)),`The actual ${file} must be bundled`);
 const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><header style="height:var(--header)"></header><main><div id="fixture-root"></div></main><script>${script.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 return{html,sources};
})();}

test('attribution fixture bundles the actual interactive component, complete CSS and Cyrillic font bytes',async()=>{
 const fixture=await productionFixture();assert.equal(fixture.sources.cssFiles.filter(file=>file.path.startsWith('@fontsource/manrope/')).length,8);
 assert.match(fixture.html,/data:font\/woff2;base64,/);assert.doesNotMatch(fixture.html,/url\(["']?\.\/files\/manrope/);
 assert.deepEqual(fixture.sources.files.map(file=>file.path),['components/MapAttribution.tsx','components/MapIcon.tsx','components/TropnikIcons.tsx','lib/map-satellite.ts','lib/russia-map.ts']);
 assert.deepEqual(fixture.sources.uiFiles.map(file=>file.path),['components/CustomAtlas.tsx','components/PlaceStories.tsx']);
});

const geometryExpression="(()=>{\n const box=element=>{if(!element)return null;const r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};\n const attribution=document.querySelector('.map-attribution'),credit=document.querySelector('.map-satellite-credit'),status=document.querySelector('.map-satellite-status'),link=document.querySelector('.map-attribution-link'),sourceCredit=document.querySelector('.map-source-credit'),rect=box(link),creditStyle=getComputedStyle(credit);\n const text=element=>{const range=document.createRange();range.selectNodeContents(element);return{value:element.textContent,rect:box(range),visible:getComputedStyle(element).visibility==='visible',visibleUnblocked:[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).every(r=>element.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)))}};\n const compactStyle=element=>{const s=getComputedStyle(element);return{backgroundColor:s.backgroundColor,boxShadow:s.boxShadow,borders:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],textShadow:s.textShadow}};\n return{rect:box(attribution),atlas:box(document.querySelector('.atlas-wrap')),credit:box(credit),sourceCredit:box(sourceCredit),sourceLink:rect,sourceLinkHref:link.getAttribute('href'),sourceLinkLabel:link.getAttribute('aria-label'),panelCount:document.querySelectorAll('.map-attribution-content').length,toggleCount:document.querySelectorAll('.map-attribution-toggle').length,source:credit.dataset.imagerySource,fontFamily:creditStyle.fontFamily,fontSize:creditStyle.fontSize,lineHeight:creditStyle.lineHeight,sourceAnchors:[...sourceCredit.querySelectorAll('a')].map(element=>({...text(element),href:element.getAttribute('href')})),anchors:[...credit.querySelectorAll('a')].map(element=>({...text(element),href:element.href})),details:[...credit.querySelectorAll('.map-satellite-detail:not(.map-satellite-status)')].map(text),status:{...text(status),ariaHidden:status.getAttribute('aria-hidden'),focusableChildren:status.querySelectorAll('a,button,input,select,textarea,[tabindex]').length},compactStyles:[attribution,credit,link].map(compactStyle),blocked:[[.5,.5],[.3,.3],[.7,.3],[.3,.7],[.7,.7]].some(([x,y])=>!link.contains(document.elementFromPoint(rect.left+rect.width*x,rect.top+rect.height*y))),documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};\n})()";
const stableGeometry=attributionGeometry;
const footerGeometryExpression=`(()=>{
 const box=element=>{const r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
 const visible=element=>{const style=getComputedStyle(element),r=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&r.width>1&&r.height>1};
 const host=document.querySelector('.explore-layout'),atlas=box(document.querySelector('.atlas-wrap')),sheet=box(document.querySelector('.explore-panel')),status=document.querySelector('.map-preload-status'),sheetOpen=host.dataset.sheetState==='open';
 const touch=matchMedia('(max-width:700px),(min-width:701px) and (max-width:900px) and (max-height:620px) and (orientation:landscape) and (pointer:coarse)').matches;
 const available={left:atlas.left,top:atlas.top,right:atlas.right,bottom:Math.min(atlas.bottom,touch?sheet.top:Infinity)};available.width=available.right-available.left;available.height=available.bottom-available.top;
 const ui=[...document.querySelectorAll('.map-context,.map-style-switch,.map-controls,.layer-button,.map-preload-status,.fact-closed,.map-attribution-link,.map-source-credit,.map-satellite-credit,.map-legend')].filter(visible).map(element=>({kind:element.className,rect:box(element)}));
 const targets=[...document.querySelectorAll('.map-style-switch button,.map-controls button,.layer-button,.fact-closed,.map-attribution-link')].filter(visible).map(element=>{const r=box(element),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return{label:element.getAttribute('aria-label')||element.textContent.trim(),rect:r,minimumSize:44,unobscured:!!hit&&element.contains(hit)}});
 return{panelCount:document.querySelectorAll('.map-attribution-content').length,toggleCount:document.querySelectorAll('.map-attribution-toggle').length,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY,sheetOpen,panelHeight:sheet.height,sheetPeek:parseFloat(getComputedStyle(host).getPropertyValue('--sheet-peek')),panelTransition:getComputedStyle(document.querySelector('.explore-panel')).transitionProperty,available,footer:box(document.querySelector('.map-footer')),publishedFooterHeight:parseFloat(getComputedStyle(host).getPropertyValue('--map-footer-height')),status:{rect:box(status),visible:visible(status),ariaHidden:status.getAttribute('aria-hidden'),text:status.textContent},ui,targets};
})()`;

test('satellite attribution retains exact geometry over loading cycles with all visible credits and 44px controls',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+85000,
},async t=>{
 assert.ok(binary,'A Chromium binary is required for the production attribution geometry gate');
 const fixture=await productionFixture(),directory=await mkdtemp(join(tmpdir(),'tropnik-map-attribution-'));
 const fixtureServer=createHTTPServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(fixture.html);});
 await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));const fixtureURL='http://127.0.0.1:'+fixtureServer.address().port+'/';
 const lease=createServer();await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory})),output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/map-attribution');
 const report={schemaVersion:2,verified:false,phase:'browser-startup',sourceCommit:process.env.GITHUB_SHA||null,evidence:'production-react-compact-credit-and-css-browser-geometry',sources:fixture.sources,profiles,negativeControls:[],cases:[],footerCases:[],caseFailures:[]};let socket,cdp;
 t.after(async()=>{socket?.close();await browser.close();fixtureServer.closeAllConnections();await new Promise(resolve=>fixtureServer.close(resolve));await rm(directory,{recursive:true,force:true});await mkdir(output,{recursive:true});report.browserStartup=browser.diagnostics();await writeFile(join(output,'browser-map-attribution-verification.json'),JSON.stringify(report,null,2)+'\n');});
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  cdp={call:(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Attribution CDP timeout: '+method));},5000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));})};
  const evaluate=async expression=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error('Attribution fixture execution failed: '+JSON.stringify(result.exceptionDetails));return result.result.value;};
  const settle=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const render=async(scenario,loading)=>{await evaluate(`window.renderAttribution(${JSON.stringify({satellite:true,satelliteSource:scenario.source,satelliteLoading:loading,zoom:scenario.zoom})})`);await settle();return evaluate(geometryExpression);};
  const setVisit=returning=>evaluate('window.resetAttribution('+JSON.stringify(returning)+')');
  const capture=async filename=>{const {data}=await cdp.call('Page.captureScreenshot',{format:'png'}),bytes=Buffer.from(data,'base64');await writeFile(join(pictures,filename),bytes);return{path:'design-qa/map-attribution/'+filename,bytes:bytes.length,sha256:sha(bytes)};};
  const collectCase=(entry,run)=>collectAttributionGeometryCase(run,async error=>{
   entry.failure=browserErrorDetails(error);entry.failureLayout=await evaluate(footerGeometryExpression);entry.failureScreenshot=await capture('failed-'+report.phase+'.png');
   // A failed native-link assertion returns before the normal listener cleanup.
   // Retire those listeners before the next independent case can reuse its log.
   const inputs=await evaluate("(()=>{const inputs=window.__sourceInputs;window.__removeSourceInputs?.();return inputs})()");
   if(entry.linkInteraction&&!entry.linkInteraction.observedInputs)entry.linkInteraction.observedInputs=inputs;
   report.caseFailures.push({name:report.phase,failure:entry.failure,screenshot:entry.failureScreenshot});
  });
  const sourceInteraction=async(entry,profile,focusPicture=false)=>{
   const before=await evaluate("(()=>{const panel=document.querySelector('.map-attribution');window.__sourceInputs={tabs:[],activations:[]};const tab=event=>{if(event.key==='Tab')window.__sourceInputs.tabs.push({key:event.key,trusted:event.isTrusted})},activate=event=>{const link=event.target?.closest('.map-attribution-link');if(!link)return;window.__sourceInputs.activations.push({href:link.getAttribute('href'),trusted:event.isTrusted});event.preventDefault()};document.addEventListener('keydown',tab);panel.addEventListener('click',activate);window.__removeSourceInputs=()=>{document.removeEventListener('keydown',tab);panel.removeEventListener('click',activate)};return{url:location.href,hrefs:[...panel.querySelectorAll('a')].map(a=>a.getAttribute('href'))}})()");
   const interaction={input:'native-cdp-tab-and-enter',navigation:'intercepted-to-retain-fixture',before,links:[]};entry.linkInteraction=interaction;
   await evaluate("document.querySelector('.map-attribution a').focus()");await settle();
   for(let index=0;index<before.hrefs.length;index++){
    if(index){for(const type of ['keyDown','keyUp'])await cdp.call('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});await settle();}
    const link=await evaluate("(()=>{const panel=document.querySelector('.map-attribution'),active=document.activeElement;return{href:active.getAttribute('href'),text:active.textContent,focused:active.tagName==='A'&&panel.contains(active),visibleUnblocked:[...active.getClientRects()].filter(r=>r.width>0&&r.height>0).every(r=>active.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)))}})()");
    interaction.links.push(link);assert.equal(link.href,before.hrefs[index]);assert.equal(link.focused,true);assert.equal(link.visibleUnblocked,true,'Every compact source link must support native Tab navigation');
   }
   for(const type of ['keyDown','keyUp'])await cdp.call('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
   await settle();
   if(focusPicture)interaction.focusScreenshot=await capture(entry.name+'-sources-focus.png');
   interaction.afterURL=await evaluate('location.href');
   interaction.observedInputs=await evaluate("(()=>{const result=window.__sourceInputs;window.__removeSourceInputs();document.activeElement.blur();return result})()");
   assert.equal(interaction.observedInputs.tabs.length,before.hrefs.length-1);assert.ok(interaction.observedInputs.tabs.every(event=>event.trusted));
   assert.deepEqual(interaction.observedInputs.activations,[{href:'/sources',trusted:true}]);assert.equal(interaction.afterURL,before.url);await settle();
  };
  const sheetCycle=async(entry,scenario,props,baseline)=>{
   if(!scenario.profile.mobile||scenario.profile.width>=scenario.profile.height)return;
   const renderState=async sheetOpen=>{
    await evaluate(`window.renderAttribution(${JSON.stringify(props)},${JSON.stringify({loading:false,sheetOpen})})`);
    await evaluate("Promise.race([Promise.all(document.querySelector('.explore-panel').getAnimations().map(animation=>animation.finished.catch(()=>{}))),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Sheet transition did not finish')),1000))])");
    await settle();return evaluate(footerGeometryExpression);
   };
   entry.sheetCycle={input:'production-react-sheet-state',states:[]};
   for(const sheetOpen of [false,true,false])entry.sheetCycle.states.push(await renderState(sheetOpen));
   assertAttributionSheetCycle(entry.sheetCycle,scenario,baseline);
   if(scenario.sheetOpen)await renderState(true);
  };
  report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);await mkdir(pictures,{recursive:true});
  const loadFixture=async profile=>{
   await cdp.call('Emulation.setDeviceMetricsOverride',{width:profile.width,height:profile.height,deviceScaleFactor:profile.dpr,mobile:profile.mobile,screenWidth:profile.width,screenHeight:profile.height});await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:profile.mobile,maxTouchPoints:profile.mobile?5:1});
   await cdp.call('Page.navigate',{url:fixtureURL});
   let loaded=false;for(let attempt=0;attempt<80;attempt++){if(await evaluate("!!document.querySelector('.map-satellite-status')")){loaded=true;break;}await sleep(25);}assert.ok(loaded,'The actual React component must mount');
   const fonts=await evaluate(`(async()=>{const faces=[...document.fonts].filter(face=>face.family.replace(/['"]/g,'')==='Manrope');await Promise.all(faces.map(face=>face.load()));await document.fonts.ready;return faces.map(face=>({family:face.family,weight:face.weight,status:face.status}))})()`);assert.equal(fonts.length,8);assert.ok(fonts.every(face=>face.status==='loaded'));
   await settle();return fonts;
  };
  for(const profile of profiles){
   report.phase=profile.name;const fonts=await loadFixture(profile);
   await evaluate("window.renderAttribution({ready:false,satellite:true,satelliteLoading:false,zoom:14})");await settle();
   const notReady=await evaluate("(()=>{const source=document.querySelector('.map-attribution');return{hidden:source.hidden,display:getComputedStyle(source).display,visibleLinks:[...source.querySelectorAll('a')].filter(link=>link.getClientRects().length>0).length}})()");
   assert.deepEqual(notReady,{hidden:true,display:'none',visibleLinks:0});
   await setVisit(false);await render(scenarios[0],true);
   // The first negative control recreates loading reflow; the second restores
   // the retired panel so the no-panel measurement must detect it.
   await evaluate("(()=>{const style=document.createElement('style');style.id='previous-attribution-status';style.textContent='.map-satellite-status[aria-hidden=\"true\"]{display:none}';document.head.appendChild(style)})()");
   const previousLoading=await render(scenarios[0],true),previousReady=await render(scenarios[0],false);
   assert.notDeepEqual(previousLoading.credit,previousReady.credit);
   const legacyPanelCount=await evaluate("(()=>{const panel=document.createElement('div');panel.className='map-attribution-content';document.querySelector('.map-attribution').appendChild(panel);const count=document.querySelectorAll('.map-attribution-content').length;panel.remove();return count})()");
   assert.equal(legacyPanelCount,1);report.negativeControls.push({profile:profile.name,loading:stableGeometry(previousLoading),ready:stableGeometry(previousReady),fonts,legacyPanelCount,notReady});
   await evaluate("document.getElementById('previous-attribution-status').remove()");
   for(const scenario of scenarios)for(const returning of [false,true]){
    const name=profile.name+'-'+scenario.name+'-'+(returning?'returning':'fresh');report.phase=name;
    const long=profile.name==='android-portrait'&&scenario.name==='detail'&&!returning,cycles=long?14:3,entry={name,profile:profile.name,source:scenario.source,zoom:scenario.zoom,returning,cycles,comparisons:[]};report.cases.push(entry);
    await collectCase(entry,async()=>{
     entry.visitObserved=await setVisit(returning);await render(scenario,true);
     for(let cycle=0;cycle<cycles;cycle++){
      const loading=await render(scenario,true),ready=await render(scenario,false);
      if(cycle===0){entry.loading=loading;entry.ready=ready;}
      const loadingGeometry=stableGeometry(loading),readyGeometry=stableGeometry(ready);entry.comparisons.push({cycle:cycle+1,loading:loadingGeometry,ready:readyGeometry});
      assertCompactAttributionSnapshot(loading,profile,scenario,true);assertCompactAttributionSnapshot(ready,profile,scenario,false);assert.deepEqual(readyGeometry,loadingGeometry,name+': loading must not move compact sources');
     }
     if(long){await sleep(6000);entry.idlePersistence={delayMs:6000,after:await evaluate(geometryExpression)};assertCompactAttributionSnapshot(entry.idlePersistence.after,profile,scenario,false);assert.deepEqual(stableGeometry(entry.idlePersistence.after),stableGeometry(entry.ready));}
     entry.layout=await evaluate(footerGeometryExpression);assertAttributionFooterLayout(entry.layout,{name,profile,satellite:true,returning,sheetOpen:false},false);
     await sourceInteraction(entry,profile,returning&&scenario.name==='overview-limit'&&['compact-android','phone-landscape'].includes(profile.name));
     await sheetCycle(entry,{name,profile,satellite:true,returning,sheetOpen:false},{satellite:true,satelliteSource:scenario.source,satelliteLoading:false,zoom:scenario.zoom},entry.layout);
     if(scenario.name===(returning?'overview-limit':'detail'))entry.screenshot=await capture(name+'.png');
    });
   }
  }
  let footerProfile='';
  for(const scenario of MAP_ATTRIBUTION_LAYOUT_CASES){
   const {profile,satellite,returning,sheetOpen,name}=scenario;report.phase='footer-'+name;
   if(footerProfile!==profile.name){await loadFixture(profile);footerProfile=profile.name;}
   const renderFooter=async loading=>{
    await evaluate('window.renderAttribution('+JSON.stringify({satellite,satelliteSource:'eox-bluemarble',satelliteLoading:loading,zoom:12})+','+JSON.stringify({loading,sheetOpen})+')');
    await evaluate("Promise.race([Promise.all(document.querySelector('.explore-panel').getAnimations().map(animation=>animation.finished.catch(()=>{}))),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Sheet transition did not finish')),1000))])");
    await settle();return evaluate(footerGeometryExpression);
   };
   const entry={name,profile,satellite,returning,sheetOpen};report.footerCases.push(entry);
   await collectCase(entry,async()=>{
    entry.visitObserved=await setVisit(returning);await renderFooter(true);
    entry.loading=await renderFooter(true);entry.screenshot=await capture('footer-'+name+'.png');
    entry.ready=await renderFooter(false);assertAttributionFooterLayout(entry.loading,scenario,true);assertAttributionFooterLayout(entry.ready,scenario,false);
    assert.deepEqual(footerLoadingGeometry(entry.ready),footerLoadingGeometry(entry.loading),name+': loading must not move source links or adjacent actions');
    await sourceInteraction(entry,profile);
    await sheetCycle(entry,scenario,{satellite,satelliteSource:'eox-bluemarble',satelliteLoading:false,zoom:12},entry.ready);
   });
  }
  assert.equal(report.cases.length,40);assert.equal(report.negativeControls.length,5);assert.equal(report.footerCases.length,24);
  report.phase='geometry-complete';assert.equal(report.caseFailures.length,0,'Geometry failed: '+report.caseFailures.map(item=>item.name).join(', '));report.phase='complete';report.verified=true;
 }catch(error){
  report.failure=browserErrorDetails(error);
  if(cdp)try{const {data}=await cdp.call('Page.captureScreenshot',{format:'png'}),bytes=Buffer.from(data,'base64');await mkdir(pictures,{recursive:true});await writeFile(join(pictures,'failure.png'),bytes);report.failureScreenshot={path:'design-qa/map-attribution/failure.png',bytes:bytes.length,sha256:sha(bytes)};}catch(captureError){report.failureScreenshotError=browserErrorDetails(captureError);}
  throw error;
 }
});
