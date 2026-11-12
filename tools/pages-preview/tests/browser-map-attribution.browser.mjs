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
import {MAP_ATTRIBUTION_PROFILES,MAP_ATTRIBUTION_SCENARIOS,MAP_ATTRIBUTION_LAYOUT_CASES,assertAttributionFooterLayout,assertAttributionSheetCycle,footerLoadingGeometry,collectAttributionGeometryCase} from '../map-attribution-verification.mjs';

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
  const state={ready:true,loading:layout.loading,reliefReady:false,imageryLoading:props.satelliteLoading,imagerySource:props.satelliteSource||'eox-s2'};
  return <section className={'explore-layout sheet-'+(layout.sheetOpen?'open':'closed')} data-sheet-state={layout.sheetOpen?'open':'closed'}>
   <aside className={'explore-panel '+(layout.sheetOpen?'expanded':'collapsed')}/>
   <div className="atlas-wrap tropnik-custom-atlas"><div className="atlas-canvas"/>${parts.get('map-context')}${parts.get('map-style-switch')}${parts.get('map-controls')}${parts.get('layer-control')}${parts.get('MapFooter')}</div>${launcher}
  </section>;
 }
 const root=createRoot(document.getElementById('fixture-root'));window.renderAttribution=(props,layout={})=>{flushSync(()=>root.render(<Fixture props={props} layout={{loading:false,sheetOpen:false,...layout}}/>));russiaView(document.querySelector('.atlas-canvas'));if(scaleValue.current)scaleValue.current.textContent='10 км';};window.renderAttribution({satellite:true,satelliteLoading:true,zoom:14});`,resolveDir:web,sourcefile:'attribution-fixture.tsx',loader:'tsx'},bundle:true,write:false,minify:true,metafile:true,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':web},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const script=bundled.outputFiles[0].text,sourceFiles=['components/MapAttribution.tsx','components/MapIcon.tsx','components/TropnikIcons.tsx','lib/map-attribution.ts','lib/map-satellite.ts','lib/russia-map.ts'];
 const sources={layoutSHA256:sha(layout),fixtureSHA256:sha(await readFile(new URL(import.meta.url))),cssFiles,compiledCssSHA256:sha(css),bundleSHA256:sha(script),uiFiles:uiFiles.map((path,index)=>({path,sha256:sha(ui[index])})),files:await Promise.all(sourceFiles.map(async path=>({path,sha256:sha(await readFile(join(web,path)))})))};
 for(const file of sourceFiles)assert.ok(Object.keys(bundled.metafile.inputs).some(input=>input.endsWith('/'+file)),`The actual ${file} must be bundled`);
 const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><header style="height:var(--header)"></header><main><div id="fixture-root"></div></main><script>${script.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 return{html,sources};
})();}

test('attribution fixture bundles the actual interactive component, complete CSS and Cyrillic font bytes',async()=>{
 const fixture=await productionFixture();assert.equal(fixture.sources.cssFiles.filter(file=>file.path.startsWith('@fontsource/manrope/')).length,8);
 assert.match(fixture.html,/data:font\/woff2;base64,/);assert.doesNotMatch(fixture.html,/url\(["']?\.\/files\/manrope/);
 assert.deepEqual(fixture.sources.files.map(file=>file.path),['components/MapAttribution.tsx','components/MapIcon.tsx','components/TropnikIcons.tsx','lib/map-attribution.ts','lib/map-satellite.ts','lib/russia-map.ts']);
 assert.deepEqual(fixture.sources.uiFiles.map(file=>file.path),['components/CustomAtlas.tsx','components/PlaceStories.tsx']);
});

const geometryExpression=`(()=>{
 const box=element=>{if(!element)return null;const r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
 const attribution=document.querySelector('.map-attribution'),credit=document.querySelector('.map-satellite-credit'),status=document.querySelector('.map-satellite-status'),toggle=document.querySelector('.map-attribution-toggle'),content=document.querySelector('.map-attribution-content'),rect=box(toggle),creditStyle=getComputedStyle(credit);
 const text=element=>{const range=document.createRange();range.selectNodeContents(element);return{value:element.textContent,rect:box(range),visible:getComputedStyle(element).visibility==='visible',visibleUnblocked:[...range.getClientRects()].some(r=>element.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)))}};
 return{rect:box(attribution),atlas:box(document.querySelector('.atlas-wrap')),credit:box(credit),content:box(content),toggle:rect,expanded:toggle.getAttribute('aria-expanded')==='true',source:credit.dataset.imagerySource,fontFamily:creditStyle.fontFamily,fontSize:creditStyle.fontSize,lineHeight:creditStyle.lineHeight,anchors:[...credit.querySelectorAll('a')].map(element=>({...text(element),href:element.href})),details:[...credit.querySelectorAll('.map-satellite-detail:not(.map-satellite-status)')].map(text),status:{...text(status),ariaHidden:status.getAttribute('aria-hidden'),focusableChildren:status.querySelectorAll('a,button,input,select,textarea,[tabindex]').length},contentText:content?.textContent||null,blocked:[[.5,.5],[.3,.3],[.7,.3],[.3,.7],[.7,.7]].some(([x,y])=>!toggle.contains(document.elementFromPoint(rect.left+rect.width*x,rect.top+rect.height*y))),documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};
})()`;
const stableGeometry=value=>({rect:value.rect,atlas:value.atlas,credit:value.credit,content:value.content,toggle:value.toggle,anchors:value.anchors,details:value.details,statusRect:value.status.rect,contentText:value.contentText});
const footerGeometryExpression=`(()=>{
 const box=element=>{const r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
 const visible=element=>{const style=getComputedStyle(element),r=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&r.width>1&&r.height>1};
 const host=document.querySelector('.explore-layout'),atlas=box(document.querySelector('.atlas-wrap')),sheet=box(document.querySelector('.explore-panel')),status=document.querySelector('.map-preload-status'),sheetOpen=host.dataset.sheetState==='open';
 const touch=matchMedia('(max-width:700px),(min-width:701px) and (max-width:900px) and (max-height:620px) and (orientation:landscape) and (pointer:coarse)').matches;
 const available={left:atlas.left,top:atlas.top,right:atlas.right,bottom:Math.min(atlas.bottom,touch?sheet.top:Infinity)};available.width=available.right-available.left;available.height=available.bottom-available.top;
 const ui=[...document.querySelectorAll('.map-context,.map-style-switch,.map-controls,.layer-button,.map-preload-status,.fact-closed,.map-attribution-toggle,.map-attribution-content,.map-satellite-credit,.map-legend')].filter(visible).map(element=>({kind:element.className,rect:box(element)}));
 const targets=[...document.querySelectorAll('.map-style-switch button,.map-controls button,.layer-button,.fact-closed,.map-attribution-toggle')].filter(visible).map(element=>{const r=box(element),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return{label:element.getAttribute('aria-label')||element.textContent.trim(),rect:r,minimumSize:44,unobscured:!!hit&&element.contains(hit)}});
 return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY,sheetOpen,panelHeight:sheet.height,sheetPeek:parseFloat(getComputedStyle(host).getPropertyValue('--sheet-peek')),panelTransition:getComputedStyle(document.querySelector('.explore-panel')).transitionProperty,available,footer:box(document.querySelector('.map-footer')),publishedFooterHeight:parseFloat(getComputedStyle(host).getPropertyValue('--map-footer-height')),status:{rect:box(status),visible:visible(status),ariaHidden:status.getAttribute('aria-hidden'),text:status.textContent},ui,targets};
})()`;
function assertReadable(value,profile,scenario,expanded,loading){
 assert.equal(value.expanded,expanded);assert.equal(value.source,scenario.source);assert.equal(value.blocked,false,'The actual 44px licence control must remain reachable');
 assert.ok(value.toggle.width>=44&&value.toggle.height>=44);assert.ok(value.credit.left>=0&&value.credit.right<=profile.width,'The entire source card must fit the viewport');
 assert.ok(value.credit.top>=0&&value.credit.bottom<=profile.height,'The source card must remain visible');assert.ok(value.documentWidth<=profile.width,'Attribution must not add horizontal overflow');
 assert.match(value.fontFamily,/Manrope/);assert.equal(value.fontSize,'12px');assert.equal(value.lineHeight,'16px');assert.equal(value.anchors.length,2);
 assert.equal(value.anchors[0].value,scenario.source==='eox-s2'?'EOxCloudless':'NASA Blue Marble');assert.equal(value.anchors[1].value,'EOX');
 for(const text of [...value.anchors,...value.details,...(loading?[value.status]:[])]){
  assert.equal(text.visible,true);assert.equal(text.visibleUnblocked,true,'The licence panel must not obscure the source text');assert.ok(text.rect.left>=value.credit.left&&text.rect.right<=value.credit.right&&text.rect.top>=value.credit.top&&text.rect.bottom<=value.credit.bottom,'All visible source text must fit its card');
 }
 assert.equal(value.status.value,'Загружаем снимки…');assert.equal(value.status.visible,loading);assert.equal(value.status.ariaHidden,String(!loading));assert.equal(value.status.focusableChildren,0);
 if(expanded){
  assert.match(value.contentText,/OpenStreetMap contributors/);assert.match(value.contentText,/Данные и лицензии/);assert.match(value.contentText,scenario.source==='eox-s2'?/CC BY 4\.0/:/NASA Earth Observatory/);
  assert.ok(value.content.left>=value.atlas.left&&value.content.right<=value.atlas.right&&value.content.top>=value.atlas.top&&value.content.bottom<=value.atlas.bottom,'The licence panel must stay inside the actual map viewport');
 }
}

test('satellite attribution retains exact geometry over loading cycles with all visible credits and 44px controls',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+85000,
},async t=>{
 assert.ok(binary,'A Chromium binary is required for the production attribution geometry gate');
 const fixture=await productionFixture(),directory=await mkdtemp(join(tmpdir(),'tropnik-map-attribution-'));
 const lease=createServer();await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory})),output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/map-attribution');
 const report={schemaVersion:1,verified:false,phase:'browser-startup',sourceCommit:process.env.GITHUB_SHA||null,evidence:'production-react-and-compiled-css-browser-geometry',sources:fixture.sources,profiles,negativeControls:[],cases:[],footerCases:[],caseFailures:[]};let socket,cdp;
 t.after(async()=>{socket?.close();await browser.close();await rm(directory,{recursive:true,force:true});await mkdir(output,{recursive:true});report.browserStartup=browser.diagnostics();await writeFile(join(output,'browser-map-attribution-verification.json'),JSON.stringify(report,null,2)+'\n');});
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  cdp={call:(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Attribution CDP timeout: '+method));},5000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));})};
  const evaluate=async expression=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error('Attribution fixture execution failed: '+JSON.stringify(result.exceptionDetails));return result.result.value;};
  const settle=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const render=async(scenario,loading)=>{await evaluate(`window.renderAttribution(${JSON.stringify({satellite:true,satelliteSource:scenario.source,satelliteLoading:loading,zoom:scenario.zoom})})`);await settle();return evaluate(geometryExpression);};
  const setExpanded=async expanded=>{
   const toggleExpression="(()=>{const button=document.querySelector('.map-attribution-toggle'),r=button.getBoundingClientRect();return{expanded:button.getAttribute('aria-expanded')==='true',toggle:{left:r.left,top:r.top,width:r.width,height:r.height}}})()";
   const before=await evaluate(toggleExpression);if(before.expanded===expanded)return;const x=before.toggle.left+before.toggle.width/2,y=before.toggle.top+before.toggle.height/2;
   await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});await settle();
   // Let the actual 300ms press-release transform finish before measuring
   // loading changes. Do not disable motion or alter the production CSS.
   await evaluate("Promise.race([Promise.all(document.querySelector('.map-attribution-toggle').getAnimations().map(animation=>animation.finished.catch(()=>{}))),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Attribution toggle transition did not finish')),1000))])");
   await settle();assert.equal((await evaluate(toggleExpression)).expanded,expanded);
  };
  const capture=async filename=>{const {data}=await cdp.call('Page.captureScreenshot',{format:'png'}),bytes=Buffer.from(data,'base64');await writeFile(join(pictures,filename),bytes);return{path:'design-qa/map-attribution/'+filename,bytes:bytes.length,sha256:sha(bytes)};};
  const collectCase=(entry,run)=>collectAttributionGeometryCase(run,async error=>{
   entry.failure=browserErrorDetails(error);entry.failureLayout=await evaluate(footerGeometryExpression);entry.failureScreenshot=await capture('failed-'+report.phase+'.png');
   // A failed native-link assertion returns before the normal listener cleanup.
   // Retire those listeners before the next independent case can reuse its log.
   const inputs=await evaluate("(()=>{const inputs=window.__licenceInputs;window.__removeLicenceInputs?.();return inputs})()");
   if(entry.licenseInteraction&&!entry.licenseInteraction.observedInputs)entry.licenseInteraction.observedInputs=inputs;
   report.caseFailures.push({name:report.phase,failure:entry.failure,screenshot:entry.failureScreenshot});
  });
  const licenceInteraction=async(entry,profile)=>{
   const before=await evaluate(`(()=>{const panel=document.querySelector('.map-attribution-content'),r=panel.getBoundingClientRect();window.__licenceInputs={tabs:[],wheels:[]};const tab=event=>{if(event.key==='Tab'&&window.__licenceInputs.tabs.length<16)window.__licenceInputs.tabs.push({key:event.key,trusted:event.isTrusted})},wheel=event=>{if(panel.contains(event.target)&&window.__licenceInputs.wheels.length<8)window.__licenceInputs.wheels.push({deltaY:event.deltaY,trusted:event.isTrusted})};document.addEventListener('keydown',tab);panel.addEventListener('wheel',wheel,{passive:true});window.__removeLicenceInputs=()=>{document.removeEventListener('keydown',tab);panel.removeEventListener('wheel',wheel)};return{devicePixelRatio,scrollTop:panel.scrollTop,scrollHeight:panel.scrollHeight,clientHeight:panel.clientHeight,overflowY:getComputedStyle(panel).overflowY,center:{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2},hrefs:[...panel.querySelectorAll('a')].map(a=>a.getAttribute('href'))}})()`);
   assert.equal(before.devicePixelRatio,profile.dpr,'Observe the actual DPR before converting wheel transport units');
   const scrollable=['auto','scroll'].includes(before.overflowY)&&before.scrollHeight>before.clientHeight+1,interaction={input:'native-cdp-wheel-and-tab',before,scrollable,links:[],wheelTransitions:[]};entry.licenseInteraction=interaction;
   await evaluate("document.querySelector('.map-attribution-content a').focus()");await settle();
   for(let index=0;index<before.hrefs.length;index++){
    if(index){for(const type of ['keyDown','keyUp'])await cdp.call('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});await settle();}
    const link=await evaluate(`(()=>{const panel=document.querySelector('.map-attribution-content'),active=document.activeElement,bounds=panel.getBoundingClientRect();return{href:active.getAttribute('href'),text:active.textContent,focused:active.tagName==='A'&&panel.contains(active),visibleUnblocked:[...active.getClientRects()].some(rect=>{const left=Math.max(rect.left,bounds.left+1),right=Math.min(rect.right,bounds.right-1),top=Math.max(rect.top,bounds.top+1),bottom=Math.min(rect.bottom,bounds.bottom-1);return right>left&&bottom>top&&active.contains(document.elementFromPoint((left+right)/2,(top+bottom)/2))}),scrollTop:panel.scrollTop}})()`);
    interaction.links.push(link);assert.equal(link.href,before.hrefs[index]);assert.equal(link.focused,true);assert.equal(link.visibleUnblocked,true,'Every licence link must be reachable with native Tab navigation');
   }
   if(scrollable){
    for(const [index,deltaY]of [-before.scrollHeight,before.scrollHeight,-before.scrollHeight].entries()){
     // Under this fixed Chromium emulation profile, the native wheel payload
     // is divided by the actual DPR before the DOM event. Preserve both units
     // and continue requiring the exact requested CSS delta in trusted input.
     const nativeDeltaY=deltaY*before.devicePixelRatio,previous=await evaluate("document.querySelector('.map-attribution-content').scrollTop");await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:before.center.x,y:before.center.y,deltaX:0,deltaY:nativeDeltaY});
     const expected=deltaY>0?before.scrollHeight-before.clientHeight:0;let observed;
     for(let attempt=0;attempt<40;attempt++){await settle();observed=await evaluate("document.querySelector('.map-attribution-content').scrollTop");if(Math.abs(observed-expected)<=1)break;await sleep(10);}
     interaction.wheelTransitions.push({deltaY,nativeDeltaY,before:previous,after:observed,expected});assert.ok(Math.abs(observed-expected)<=1,'Native wheel must expose the full licence panel');
     if(index===1&&entry.name.includes('-overview-limit-'))interaction.bottomScreenshot=await capture(entry.name+'-license-bottom.png');
    }
   }
   interaction.observedInputs=await evaluate("(()=>{const result=window.__licenceInputs;window.__removeLicenceInputs();document.activeElement.blur();return result})()");
   assert.equal(interaction.observedInputs.tabs.length,before.hrefs.length-1);assert.ok(interaction.observedInputs.tabs.every(event=>event.trusted));assert.equal(interaction.observedInputs.wheels.length,interaction.wheelTransitions.length);assert.ok(interaction.observedInputs.wheels.every(event=>event.trusted));await settle();
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
   await cdp.call('Page.navigate',{url:'data:text/html;charset=utf-8,'+encodeURIComponent(fixture.html)});
   let loaded=false;for(let attempt=0;attempt<80;attempt++){if(await evaluate("!!document.querySelector('.map-satellite-status')")){loaded=true;break;}await sleep(25);}assert.ok(loaded,'The actual React component must mount');
   const fonts=await evaluate(`(async()=>{const faces=[...document.fonts].filter(face=>face.family.replace(/['"]/g,'')==='Manrope');await Promise.all(faces.map(face=>face.load()));await document.fonts.ready;return faces.map(face=>({family:face.family,weight:face.weight,status:face.status}))})()`);assert.equal(fonts.length,8);assert.ok(fonts.every(face=>face.status==='loaded'));
   await settle();return fonts;
  };
  for(const profile of profiles){
   report.phase=profile.name;const fonts=await loadFixture(profile);
   await render(scenarios[0],true);await setExpanded(false);
   // Recreate the old conditional absence using display:none on the same
   // real text node. This override is removed before every corrected case.
   await evaluate("(()=>{const style=document.createElement('style');style.id='previous-attribution-status';style.textContent='.map-satellite-status[aria-hidden=\"true\"]{display:none}';document.head.appendChild(style)})()");
   const previousLoading=await render(scenarios[0],true),previousReady=await render(scenarios[0],false);
   assert.notDeepEqual(previousLoading.credit,previousReady.credit,'The negative control must reproduce loading-dependent source reflow');
   report.negativeControls.push({profile:profile.name,loading:stableGeometry(previousLoading),ready:stableGeometry(previousReady),fonts});await evaluate("document.getElementById('previous-attribution-status').remove()");
   for(const scenario of scenarios)for(const expanded of [false,true]){
    const name=`${profile.name}-${scenario.name}-${expanded?'expanded':'collapsed'}`;report.phase=name;
    const cycles=profile.name==='android-portrait'&&scenario.name==='detail'&&!expanded?14:3,entry={name,profile:profile.name,source:scenario.source,zoom:scenario.zoom,expanded,cycles,comparisons:[]};report.cases.push(entry);
    await collectCase(entry,async()=>{
    await render(scenario,true);await setExpanded(expanded);
    for(let cycle=0;cycle<cycles;cycle++){
     const loading=await render(scenario,true),ready=await render(scenario,false);
     if(cycle===0){entry.loading=loading;entry.ready=ready;}
     const loadingGeometry=stableGeometry(loading),readyGeometry=stableGeometry(ready);entry.comparisons.push({cycle:cycle+1,loading:loadingGeometry,ready:readyGeometry});
     assertReadable(loading,profile,scenario,expanded,true);assertReadable(ready,profile,scenario,expanded,false);assert.deepEqual(readyGeometry,loadingGeometry,`${name}: a tile request must not move the source, licence popup, or control`);
    }
    entry.layout=await evaluate(footerGeometryExpression);assertAttributionFooterLayout(entry.layout,{name,profile,satellite:true,expanded,sheetOpen:false},false);
    if(expanded)await licenceInteraction(entry,profile);
    await sheetCycle(entry,{name,profile,satellite:true,expanded,sheetOpen:false},{satellite:true,satelliteSource:scenario.source,satelliteLoading:false,zoom:scenario.zoom},entry.layout);
    if(scenario.name===(expanded?'overview-limit':'detail'))entry.screenshot=await capture(name+'.png');
    });
   }
  }
  let footerProfile='';
  for(const scenario of MAP_ATTRIBUTION_LAYOUT_CASES){
   const {profile,satellite,expanded,sheetOpen,name}=scenario;report.phase='footer-'+name;
   if(footerProfile!==profile.name){await loadFixture(profile);footerProfile=profile.name;}
   const renderFooter=async loading=>{
    await evaluate(`window.renderAttribution(${JSON.stringify({satellite,satelliteSource:'eox-bluemarble',satelliteLoading:loading,zoom:12})},${JSON.stringify({loading,sheetOpen})})`);
    await evaluate("Promise.race([Promise.all(document.querySelector('.explore-panel').getAnimations().map(animation=>animation.finished.catch(()=>{}))),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Sheet transition did not finish')),1000))])");
    await settle();return evaluate(footerGeometryExpression);
   };
   const entry={name,profile,satellite,expanded,sheetOpen};report.footerCases.push(entry);
   await collectCase(entry,async()=>{
   await renderFooter(true);await setExpanded(expanded);
   entry.loading=await renderFooter(true);entry.screenshot=await capture('footer-'+name+'.png');
   entry.ready=await renderFooter(false);assertAttributionFooterLayout(entry.loading,scenario,true);assertAttributionFooterLayout(entry.ready,scenario,false);
   assert.deepEqual(footerLoadingGeometry(entry.ready),footerLoadingGeometry(entry.loading),name+': loading must not move the footer, Layers, launcher or licence control');
   if(expanded)await licenceInteraction(entry,profile);
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
