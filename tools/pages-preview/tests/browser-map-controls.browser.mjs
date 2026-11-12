import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import vm from 'node:vm';
import {launchBrowser,BROWSER_STARTUP_LIMITS,browserErrorDetails} from '../browser-startup.mjs';
import {browserEnvironmentArgs,collectBrowserEnvironment} from '../browser-environment.mjs';
import {collectNativeBrowserSurface} from '../browser-native-surface.mjs';

const root=resolve(import.meta.dirname,'../../..'),web=join(root,'web'),require=createRequire(join(web,'package.json'));
const ts=require('typescript'),{renderToStaticMarkup}=require('react-dom/server'),jsx=require('react/jsx-runtime');
const binary=['google-chrome','google-chrome-stable','chromium','chromium-browser'].find(name=>spawnSync('which',[name],{stdio:'ignore'}).status===0);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function compile(source,filename,scope={}){
 const code=ts.transpileModule(source,{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const module={exports:{}},load=id=>{assert.equal(id,'react/jsx-runtime');return jsx;};
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`,scope,{filename})(load,module,module.exports);return module.exports;
}
async function productionFixture(){
 const layout=await readFile(join(web,'app/layout.tsx'),'utf8'),atlas=await readFile(join(web,'components/CustomAtlas.tsx'),'utf8'),explore=await readFile(join(web,'components/Explore.tsx'),'utf8');
 const files=[...layout.matchAll(/^import ["']([^"']+\.css)["'];/gm)].map(match=>match[1].startsWith('./')?'app/'+match[1].slice(2):match[1]);
 assert.ok(files.length>=10,'The fixture must consume the complete production CSS cascade');
 const styles=await Promise.all(files.map(async file=>{
  const path=file.startsWith('@')?require.resolve(file):join(web,file);let css=await readFile(path,'utf8');
  if(file.startsWith('@fontsource/')){
   // Preserve every production font face and fallback format on the data URL
   // page. The same bytes are bundled by the production CSS build.
   for(const url of [...css.matchAll(/url\((\.\/[^)]+)\)/g)]){
    const font=await readFile(resolve(dirname(path),url[1])),format=url[1].endsWith('.woff2')?'woff2':'woff';
    css=css.replace(url[0],`url(data:font/${format};base64,${font.toString('base64')})`);
   }
  }
  return css;
 })),source=styles.join('\n');
 const viteRequire=createRequire(require.resolve('vite')),{transform}=viteRequire('lightningcss');
 const css=transform({filename:'production-map-controls.css',code:Buffer.from(source),minify:true,targets:{chrome:107<<16}}).code.toString();
 const subtrees=(source,filename,classes)=>{
  const tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),parts=new Map(),wanted=new Set(classes);
  const visit=node=>{
   if(ts.isJsxElement(node)){
    const attr=node.openingElement.attributes.properties.find(attr=>ts.isJsxAttribute(attr)&&attr.name.text==='className'&&attr.initializer&&ts.isStringLiteral(attr.initializer));
    if(attr&&wanted.has(attr.initializer.text))parts.set(attr.initializer.text,node.getText(tree));
   }
   ts.forEachChild(node,visit);
  };visit(tree);assert.equal(parts.size,wanted.size,`${filename}: the production subtrees are missing`);return parts;
 };
 const parts=subtrees(atlas,'CustomAtlas.tsx',['map-controls','layer-control','map-style-switch']),peek=subtrees(explore,'Explore.tsx',['sheet-peek-summary']);
 const iconSource=await readFile(join(web,'components/MapIcon.tsx'),'utf8'),{MapIcon}=compile(iconSource,'MapIcon.tsx');
 const iconSet=await readFile(join(web,'components/TropnikIcons.tsx'),'utf8'),{ArrowRight}=compile(iconSet,'TropnikIcons.tsx');
 // Render the real TSX subtrees, not a copied button count or a CSS formula.
 // Transport, camera effects and React event execution do not affect this
 // layout fixture; the full browser audit exercises their actual behavior.
 const noOperation=()=>{},scope={MapIcon,planning:false,trail:null,offline:false,paths:true,relief:true,boundaries:true,engine:{current:null}};
 for(const name of ['locate','fitAll','setLayers','changeMode','setPaths','setRelief','setBoundaries'])scope[name]=noOperation;
 const {Controls}=compile(`export function Controls({layers=false,ready=true}){const state={ready,mode:'detail'},satellite=state.mode==='satellite';return <>${[...parts.values()].join('\n')}</>;}`,'ControlsFixture.tsx',scope);
 const {Peek}=compile(`export function Peek({kind='Каталог',title='Все направления',meta='680 маршрутов'}){const sheetOpen=false,sheetPreviewKind=kind,sheetPreviewTitle=title,sheetPreviewMeta=meta;return ${peek.get('sheet-peek-summary')};}`,'PeekFixture.tsx',{ArrowRight,sheetPreview:{current:null},setSheetOpen:noOperation});
 const html=({layers=false,...copy}={})=>`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><header style="height:var(--header)"></header><main><div class="explore-layout sheet-closed" data-sheet-state="closed"><aside class="explore-panel"><button class="sheet-handle"><span></span></button>${renderToStaticMarkup(jsx.jsx(Peek,copy))}</aside><div class="atlas-wrap tropnik-custom-atlas"><div class="atlas-canvas"></div>${renderToStaticMarkup(jsx.jsx(Controls,{layers}))}</div></div></main></body></html>`;
 return{html,sources:{atlasSHA256:createHash('sha256').update(atlas).digest('hex'),exploreSHA256:createHash('sha256').update(explore).digest('hex'),cssSHA256:createHash('sha256').update(css).digest('hex'),cssFiles:files}};
}

test('production control fixture renders both menu states, actual peek icons and bundled Cyrillic fonts',async()=>{
 const fixture=await productionFixture(),closed=fixture.html(),open=fixture.html({layers:true});
 assert.doesNotMatch(closed,/class="layer-menu"/);assert.match(open,/class="layer-menu"/);
 assert.match(closed,/aria-label="Рельеф"[^>]*aria-pressed="true"/);assert.match(closed,/aria-label="Спутник"[^>]*aria-pressed="false"/);
 assert.doesNotMatch(open,/Рельеф всей карты|Карта сверху|Сохранённый обзор|Тропы и ландшафт/);assert.match(closed,/data-tropnik-icon="ArrowRight"/);
 assert.match(closed,/<small>Каталог<\/small><strong>Все направления<\/strong><span>680 маршрутов<\/span>/);
 assert.equal(fixture.sources.cssFiles.filter(file=>file.startsWith('@fontsource/manrope/')).length,8);
 assert.match(closed,/data:font\/woff2;base64,/);assert.doesNotMatch(closed,/url\(["']?\.\/files\/manrope/);
});

test('production landscape map controls and collapsed peek keep readable text and unobscured touch targets',{
 timeout:BROWSER_STARTUP_LIMITS.readyMs+25000,
},async t=>{
 assert.ok(binary,'A Chromium binary is required for the production map controls geometry gate');
 const fixture=await productionFixture(),directory=await mkdtemp(join(tmpdir(),'tropnik-map-controls-'));
 const lease=createServer();await new Promise(resolve=>lease.listen(0,'127.0.0.1',resolve));const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
 const browser=launchBrowser(binary,browserEnvironmentArgs({debugPort:port,userDataDir:directory}));
 const output=join(web,'pages-preview/dist'),pictures=join(web,'pages-preview/design-qa/map-controls');
 const report={schemaVersion:1,verified:false,phase:'browser-startup',sourceCommit:process.env.GITHUB_SHA||null,evidence:'production-jsx-and-compiled-css-browser-geometry',sources:fixture.sources,cases:[]};
 let socket;
 t.after(async()=>{
  socket?.close();await browser.close();await rm(directory,{recursive:true,force:true});await mkdir(output,{recursive:true});
  report.browserStartup=browser.diagnostics();await writeFile(join(output,'browser-map-controls-verification.json'),JSON.stringify(report,null,2)+'\n');
 });
 try{
  const version=await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);
  report.environment=await collectBrowserEnvironment(version.webSocketDebuggerUrl,{sourceCommit:report.sourceCommit});
  const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
  const cdp={call:(method,params={})=>new Promise((resolve,reject)=>{
   const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Map controls CDP timeout: '+method));},5000);
   pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));
  })};
  const evaluate=async expression=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.equal(result.exceptionDetails,undefined);return result.result.value;};
  report.environment.nativeSurface=await collectNativeBrowserSurface(cdp);
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:2,mobile:true,screenWidth:844,screenHeight:390});
  await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await mkdir(pictures,{recursive:true});
  const cases=[{name:'closed',layers:false},{name:'open',layers:true},{name:'long-copy',layers:false,kind:'Маршрут',title:'Длинное название маршрута с перевалами, озёрами и несколькими остановками '.repeat(4),meta:'Протяжённость по сведениям источника и подробное описание времени в пути '.repeat(4)}];
  for(const scenario of cases){
   const name=`phone-landscape-${scenario.name}`;report.phase=name;
   await cdp.call('Page.navigate',{url:'data:text/html;charset=utf-8,'+encodeURIComponent(fixture.html(scenario))});
   let loaded=false;for(let attempt=0;attempt<40;attempt++){if(await evaluate("!!document.querySelector('.layer-button')")){loaded=true;break;}await sleep(25);}assert.ok(loaded);
   const fonts=await evaluate(`(async()=>{const faces=[...document.fonts].filter(face=>face.family.replace(/['"]/g,'')==='Manrope');await Promise.all(faces.map(face=>face.load()));await document.fonts.ready;return faces.map(face=>({family:face.family,weight:face.weight,status:face.status}))})()`);
   assert.equal(fonts.length,8,'The text fixture must load all production Manrope faces');assert.ok(fonts.every(face=>face.status==='loaded'));
   await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   if(scenario.name==='closed'){
    // Negative control: reproduce the exact 31px production overlap before
    // checking the corrected stylesheet. This override exists only here.
    report.previousReservation=await evaluate(`(()=>{const style=document.createElement('style');style.textContent='.explore-layout .layer-control{right:calc(var(--map-right) + 208px)!important}';document.head.appendChild(style);const rail=document.querySelector('.map-controls').getBoundingClientRect(),layers=document.querySelector('.layer-button').getBoundingClientRect();const result={railWidth:rail.width,overlapWidth:Math.min(rail.right,layers.right)-Math.max(rail.left,layers.left),overlapHeight:Math.min(rail.bottom,layers.bottom)-Math.max(rail.top,layers.top)};style.remove();return result})()`);
    assert.deepEqual(report.previousReservation,{railWidth:239,overlapWidth:31,overlapHeight:44},'The production CSS/JSX fixture must reproduce the observed landscape defect');
   }
   const geometry=await evaluate(`(()=>{
    const box=element=>{const r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
    const rail=document.querySelector('.map-controls'),layers=document.querySelector('.layer-button'),atlas=box(document.querySelector('.atlas-wrap')),sheet=box(document.querySelector('.explore-panel'));
    const targets=[...rail.querySelectorAll('button'),layers].map(element=>{const rect=box(element);return{label:element.getAttribute('aria-label')||element.textContent.trim(),rect,blocked:[[.5,.5],[.3,.3],[.7,.3],[.3,.7],[.7,.7]].some(([x,y])=>!element.contains(document.elementFromPoint(rect.left+rect.width*x,rect.top+rect.height*y)))}});
    const preview=document.querySelector('.sheet-peek-summary'),copy=preview.querySelector('.sheet-peek-copy'),copyStyle=getComputedStyle(copy),rows=[...copy.children].map(element=>{const style=getComputedStyle(element);return{rect:box(element),fontSize:parseFloat(style.fontSize),lineHeight:parseFloat(style.lineHeight),fontFamily:style.fontFamily,whiteSpace:style.whiteSpace,textOverflow:style.textOverflow,overflowX:style.overflowX,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth}});
    return{viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,coarse:matchMedia('(pointer:coarse)').matches},rail:box(rail),layers:box(layers),available:{left:atlas.left,right:atlas.right,top:atlas.top,bottom:Math.min(atlas.bottom,sheet.top)},targets,menu:document.querySelector('.layer-menu')?box(document.querySelector('.layer-menu')):null,peek:{rect:box(preview),copy:box(copy),display:copyStyle.display,direction:copyStyle.flexDirection,rows,arrow:box(preview.querySelector('svg')),handle:box(document.querySelector('.sheet-handle'))}};
   })()`);
   const screenshot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const png=Buffer.from(screenshot.data,'base64'),file=`${name}.png`;
   await writeFile(join(pictures,file),png);report.cases.push({name,...geometry,fonts,screenshot:{file,sha256:createHash('sha256').update(png).digest('hex')}});
   assert.deepEqual(geometry.viewport,{width:844,height:390,dpr:2,coarse:true});
   assert.equal(geometry.targets.length,6,'The actual five rail controls and Layers must all remain present');
   const gap=geometry.rail.left-geometry.layers.right;
   assert.ok(gap>=8-.01,`Layers must keep the 8px spacing beside the whole ready rail; actual gap ${gap}px`);
   for(const target of geometry.targets){
    const r=target.rect,b=geometry.available;assert.ok(r.width>=44&&r.height>=44,`${target.label}: touch target shrank`);
    assert.ok(r.left>=b.left&&r.right<=b.right&&r.top>=b.top&&r.bottom<=b.bottom,`${target.label}: control escapes usable map`);
    assert.equal(target.blocked,false,`${target.label}: actual hit target is obscured`);
   }
   const {peek}=geometry;assert.equal(peek.display,'flex');assert.equal(peek.direction,'column');assert.equal(peek.rows.length,3);
   assert.equal(peek.handle.height,44);assert.equal(peek.rect.height,68);assert.ok(peek.rect.bottom<=390+.01);
   assert.deepEqual(peek.rows.map(row=>[row.fontSize,row.lineHeight]),[[12,16],[18,28],[12,16]],'The peek must retain the named caption/title hierarchy');
   for(let index=0;index<peek.rows.length;index++){
    const r=peek.rows[index].rect;assert.ok(r.left>=peek.rect.left&&r.right<=peek.rect.right&&r.top>=peek.rect.top&&r.bottom<=peek.rect.bottom,'Peek text must stay inside its fixed touch target');
    if(index)assert.ok(r.top-peek.rows[index-1].rect.bottom>=2-.01,'Peek copy must occupy separate rows');
   }
   assert.ok(peek.arrow.left-peek.copy.right>=12-.01,'The actual ArrowRight must keep its own column');
   for(const row of peek.rows.slice(1)){
    assert.equal(row.whiteSpace,'nowrap');assert.equal(row.textOverflow,'ellipsis');assert.equal(row.overflowX,'hidden');
    if(scenario.name==='long-copy')assert.ok(row.scrollWidth>row.clientWidth,'Long real title/meta nodes must actually exercise ellipsis');
   }
  }
  report.verified=true;report.phase='complete';
 }catch(error){report.error=browserErrorDetails(error);throw error;}
});
