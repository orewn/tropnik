import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MAP_ATTRIBUTION_PROFILES,MAP_ATTRIBUTION_SCENARIOS,MAP_ATTRIBUTION_LAYOUT_CASES,attributionGeometry,attributionLinkHrefs,expectedMapAttributionSources,assertMapAttributionReceipt,collectAttributionGeometryCase} from '../map-attribution-verification.mjs';
import {browserEnvironmentFixture} from './browser-environment-fixture.mjs';

const commit='a'.repeat(40),box=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});
// Synthetic validator inputs only. Real browser geometry, native input and PNG
// production are exercised separately by browser-map-attribution.browser.mjs.
function fixture(t){
 const previewRoot=mkdtempSync(join(tmpdir(),'tropnik-attribution-validator-'));t.after(()=>rmSync(previewRoot,{recursive:true,force:true}));mkdirSync(join(previewRoot,'design-qa/map-attribution'),{recursive:true});
 const fonts=[400,500,600,700].flatMap(weight=>[0,1].map(()=>({family:'Manrope',weight:String(weight),status:'loaded'})));
 const picture=(name,profile)=>{
  // These header-only bytes test identity/dimensions, never visual parity.
  const png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(profile.width*profile.dpr,16);png.writeUInt32BE(profile.height*profile.dpr,20);
  const path='design-qa/map-attribution/'+name+'.png';writeFileSync(join(previewRoot,path),png);return{path,bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')};
 };
 const interaction=(satellite,source)=>{
  const hrefs=attributionLinkHrefs(satellite,source),url='http://127.0.0.1:12345/';
  return{input:'native-cdp-tab-and-enter',navigation:'intercepted-to-retain-fixture',before:{url,hrefs},links:hrefs.map(href=>({href,text:'Synthetic source link',focused:true,visibleUnblocked:true})),afterURL:url,observedInputs:{tabs:hrefs.slice(1).map(()=>({key:'Tab',trusted:true})),activations:[{href:'/sources',trusted:true}]}};
 };
 const report={schemaVersion:2,verified:true,phase:'complete',sourceCommit:commit,evidence:'production-react-compact-credit-and-css-browser-geometry',sources:{...expectedMapAttributionSources(),compiledCssSHA256:'b'.repeat(64),bundleSHA256:'c'.repeat(64)},environment:browserEnvironmentFixture(commit),profiles:MAP_ATTRIBUTION_PROFILES,negativeControls:[],cases:[],footerCases:[],caseFailures:[]};
 for(const profile of MAP_ATTRIBUTION_PROFILES){
  report.negativeControls.push({profile:profile.name,fonts,loading:{credit:box(16,72,180,66)},ready:{credit:box(32,88,164,50)},legacyPanelCount:1,notReady:{hidden:true,display:'none',visibleLinks:0}});
  for(const scenario of MAP_ATTRIBUTION_SCENARIOS)for(const returning of [false,true]){
   const name=`${profile.name}-${scenario.name}-${returning?'returning':'fresh'}`,sourceCredit=box(16,40,profile.width-84,32),credit=box(16,72,profile.width-84,88);
   const text=(value,top=76)=>({value,rect:box(20,top,100,16),visible:true,visibleUnblocked:true});
   const sourceAnchors=[['© участники OpenStreetMap','https://www.openstreetmap.org/copyright'],['OpenMapTiles','https://openmaptiles.org/']].map(([value,href])=>({...text(value,44),href}));
   const anchors=(scenario.source==='eox-s2'?[['EOxCloudless','https://cloudless.eox.at/'],['EOX','https://eox.at/']]:[['NASA Blue Marble','https://science.nasa.gov/earth/earth-observatory/'],['EOX','https://maps.eox.at/#data']]).map(([value,href])=>({...text(value),href}));
   const details=(scenario.source==='eox-s2'?(scenario.zoom>14?['Достигнута детализация снимка']:[]):['Обзорный снимок · детализация ниже',...(scenario.zoom>8?['Увеличен обзорный снимок']:[])]).map(value=>text(value));
   const compactStyles=Array.from({length:3},()=>({backgroundColor:'rgba(0, 0, 0, 0)',boxShadow:'none',borders:['0px','0px','0px','0px'],textShadow:'rgb(255, 254, 250) 0px 1px 0px'}));
   const loading={rect:box(16,40,profile.width-32,120),atlas:box(0,0,profile.width,profile.height),credit,sourceCredit,sourceLink:box(profile.width-60,116,44,44),sourceLinkHref:'/sources',sourceLinkLabel:'Источники данных карты и лицензии',panelCount:0,toggleCount:0,source:scenario.source,fontFamily:'Manrope',fontSize:'12px',lineHeight:'16px',sourceAnchors,anchors,details,status:{...text('Загружаем снимки…'),ariaHidden:'false',focusableChildren:0},compactStyles,blocked:false,documentWidth:profile.width,viewportWidth:profile.width};
   const ready=structuredClone(loading);ready.status.visible=false;ready.status.ariaHidden='true';
   const long=profile.name==='android-portrait'&&scenario.name==='detail'&&!returning,cycles=long?14:3;
   const item={name,profile:profile.name,source:scenario.source,zoom:scenario.zoom,returning,visitObserved:returning?'1':null,cycles,loading,ready,comparisons:Array.from({length:cycles},(_,index)=>({cycle:index+1,loading:attributionGeometry(loading),ready:attributionGeometry(ready)})),linkInteraction:interaction(true,scenario.source)};
   if(long)item.idlePersistence={delayMs:6000,after:structuredClone(ready)};
   if(returning&&scenario.name==='overview-limit'&&['compact-android','phone-landscape'].includes(profile.name))item.linkInteraction.focusScreenshot=picture(name+'-sources-focus',profile);
   if(scenario.name===(returning?'overview-limit':'detail'))item.screenshot=picture(name,profile);
   report.cases.push(item);
  }
 }
 for(const scenario of MAP_ATTRIBUTION_LAYOUT_CASES){
  const {profile,satellite,sheetOpen}=scenario,w=profile.width,short=profile.height<500,size=profile.mobile?48:44,status=box(0,short?108:300,w-64,34);
  const ui=[{kind:'map-context',rect:box(0,0,100,size)},{kind:'map-style-switch',rect:box(w-2*size-8,0,2*size+8,size)},{kind:'map-controls',rect:profile.mobile?box(w-3*size,56,3*size,size):box(w-size,52,size,5*size)},{kind:'layer-button',rect:profile.mobile?box(0,56,size,size):box(w-100,52,size,size)},{kind:'fact-closed',rect:profile.mobile?box(56,56,size,size):box(0,52,100,size)},
   {kind:'map-attribution-link',rect:box(w-size,short?186:378,size,size)},{kind:'map-source-credit',rect:box(w-128,short?150:342,64,16)},...(!profile.mobile?[{kind:'map-legend',rect:box(0,350,100,44)}]:[]),...(satellite?[{kind:'map-satellite-credit',rect:box(w-128,short?174:366,64,56)}]:[]),{kind:'map-preload-status',rect:status}];
  const target=(label,rect)=>({label,rect,minimumSize:size,unobscured:true}),railLabels=profile.mobile?['Увеличить масштаб','Уменьшить масштаб','Моё местоположение']:['Увеличить масштаб','Уменьшить масштаб','Север сверху','Моё местоположение','Показать Россию целиком'];
  const labels={'layer-button':'Настройки карты','fact-closed':'Истории мест','map-attribution-link':'Источники данных карты и лицензии'};
  const targets=[target('Рельеф',box(w-2*size-8,0,size,size)),target('Спутник',box(w-size,0,size,size)),...railLabels.map((label,index)=>target(label,profile.mobile?box(w-3*size+index*size,56,size,size):box(w-size,52+index*size,size,size))),...ui.filter(item=>Object.hasOwn(labels,item.kind)).map(item=>target(labels[item.kind],item.rect))];
  const loading={panelCount:0,toggleCount:0,width:w,height:profile.height,scrollWidth:w,scrollY:0,sheetOpen,panelHeight:360,sheetPeek:156,panelTransition:'transform',available:box(0,0,w,profile.height-(profile.mobile?(short?112:156):0)),footer:box(0,short?108:112,w,short?128:320),publishedFooterHeight:short?128:320,status:{rect:status,visible:true,ariaHidden:'false',text:'Подгружаем детали текущего ракурса'},ui,targets};
  const ready=structuredClone(loading);ready.ui=ready.ui.filter(item=>item.kind!=='map-preload-status');ready.status.visible=false;ready.status.ariaHidden='true';
  report.footerCases.push({...scenario,visitObserved:scenario.returning?'1':null,loading,ready,linkInteraction:interaction(satellite,'eox-bluemarble'),screenshot:picture('footer-'+scenario.name,profile)});
 }
 for(const item of report.cases)item.layout=structuredClone(report.footerCases.find(entry=>entry.name===item.profile+'-retained').ready);
 const cycle=baseline=>({input:'production-react-sheet-state',states:[false,true,false].map(sheetOpen=>({...structuredClone(baseline),sheetOpen}))});
 for(const item of report.cases){const p=MAP_ATTRIBUTION_PROFILES.find(value=>value.name===item.profile);if(p.mobile&&p.height>p.width)item.sheetCycle=cycle(item.layout);}
 for(const item of report.footerCases)if(item.profile.mobile&&item.profile.height>item.profile.width)item.sheetCycle=cycle(item.ready);
 return{report,options:{sourceCommit:commit,previewRoot}};
}
const rejectsChanges=(report,options,changes)=>{
 for(const [index,change]of changes.entries()){const bad=structuredClone(report);change(bad);assert.throws(()=>assertMapAttributionReceipt(bad,options),'Corrupt receipt mutation '+index+' must fail');}
};

test('compact receipt binds 40 visits, 24 footer layouts, 131 comparisons, real UI sources and 36 PNG identities',t=>{
 const {report,options}=fixture(t);assert.equal(assertMapAttributionReceipt(report,options),report);
 assert.equal(assertMapAttributionReceipt(report,{...options,environment:browserEnvironmentFixture(commit)}),report);
});
test('schema 1, restored licence panels and opaque cards cannot certify the compact UI',t=>{
 const {report,options}=fixture(t);
 rejectsChanges(report,options,[
  value=>value.schemaVersion=1,value=>value.evidence='production-react-and-compiled-css-browser-geometry',
  value=>value.cases[0].loading.panelCount=1,value=>value.cases[0].ready.toggleCount=1,
  value=>value.footerCases[0].ready.panelCount=1,value=>value.footerCases[0].loading.toggleCount=1,
  value=>value.negativeControls[0].legacyPanelCount=0,
  value=>value.cases[0].ready.compactStyles[0].backgroundColor='rgb(255, 255, 255)',
  value=>value.cases[0].ready.compactStyles[1].boxShadow='rgb(0, 0, 0) 0px 2px 6px',
  value=>value.cases[0].ready.compactStyles[2].borders[0]='1px',
  value=>value.cases[0].ready.compactStyles[0].textShadow='none',
  value=>delete value.cases[0].ready.compactStyles[0].textShadow,
  value=>value.negativeControls[0].notReady.display='flex',value=>value.negativeControls[0].notReady.visibleLinks=1,
 ]);
});
test('footer proof rejects missing widths, hidden credits, sheet overlap, blocked actions and loading-dependent movement',t=>{
 const {report,options}=fixture(t);
 rejectsChanges(report,options,[
  value=>value.caseFailures.push({name:'recorded bad geometry'}),value=>delete value.cases[1].layout,
  value=>value.footerCases.pop(),value=>value.footerCases[0].profile.width=700,value=>value.sources.uiFiles[0].sha256='f'.repeat(64),
  value=>value.footerCases[0].loading.ui=value.footerCases[0].loading.ui.filter(item=>item.kind!=='map-satellite-credit'),
  value=>value.footerCases[0].loading.ui=value.footerCases[0].loading.ui.filter(item=>item.kind!=='map-source-credit'),
  value=>{const v=value.footerCases[0].loading;v.ui.find(item=>item.kind==='map-satellite-credit').rect=structuredClone(v.ui.find(item=>item.kind==='map-legend').rect);},
  value=>{const v=value.footerCases.find(item=>item.name==='android-portrait-pending').loading;v.ui.find(item=>item.kind==='map-preload-status').rect.top=v.available.bottom-8;v.ui.find(item=>item.kind==='map-preload-status').rect.bottom=v.available.bottom+26;},
  value=>{const v=value.footerCases[0].ready.ui.find(item=>item.kind==='layer-button').rect;v.left++;v.right++;},
  value=>value.footerCases[0].loading.publishedFooterHeight++,value=>value.footerCases[0].ready.targets.pop(),value=>value.footerCases[0].loading.targets[0].unobscured=false,
  value=>value.footerCases[0].ready.status.visible=true,value=>value.footerCases[1].linkInteraction.links[0].visibleUnblocked=false,
  value=>value.footerCases[0].screenshot.sha256='e'.repeat(64),
 ]);
});
test('independent geometry assertions are retained while browser and capture failures remain fatal',async()=>{
 const recorded=[],executed=[];
 for(const name of ['first','second'])await collectAttributionGeometryCase(async()=>{executed.push(name);if(name==='first')assert.fail('Source link is covered');},async error=>recorded.push(error.message));
 assert.deepEqual(executed,['first','second']);assert.deepEqual(recorded,['Source link is covered']);
 await assert.rejects(()=>collectAttributionGeometryCase(async()=>{throw new Error('CDP disconnected');},async()=>assert.fail('Transport cannot be collected as geometry')),/CDP disconnected/);
 await assert.rejects(()=>collectAttributionGeometryCase(async()=>assert.fail('Bad rectangle'),async()=>{throw new Error('PNG capture failed');}),/PNG capture failed/);
});
test('portrait cycles reject panel-height jumps and footer reflow without weakening the animation and drag invariants',t=>{
 const {report,options}=fixture(t);
 for(const change of [
  value=>delete value.sheetCycle,value=>value.sheetCycle.states.pop(),
  value=>value.sheetCycle.states[1].panelHeight-=158.390625,
  value=>{const v=value.sheetCycle.states[1];v.footer.height+=8;v.footer.bottom+=8;v.publishedFooterHeight+=8;},
  value=>value.sheetCycle.states[1].panelTransition='height, transform',value=>value.sheetCycle.states[2].sheetOpen=true,
 ]){const bad=structuredClone(report);change(bad.cases.find(value=>value.name==='compact-android-overview-limit-returning'));assert.throws(()=>assertMapAttributionReceipt(bad,options));}
 const bad=structuredClone(report);delete bad.footerCases.find(value=>value.sheetOpen).sheetCycle;assert.throws(()=>assertMapAttributionReceipt(bad,options));
 for(const change of [value=>value.panelHeight=value.sheetPeek+60,value=>delete value.sheetPeek]){
  const bad=structuredClone(report),item=bad.footerCases.find(value=>value.name==='compact-android-pending');item.sheetCycle.states.forEach(change);assert.throws(()=>assertMapAttributionReceipt(bad,options),'A stable but unusably short compact drawer must fail');
 }
});
test('fresh and returning visits retain native source links without timers or navigation escaping the fixture',t=>{
 const {report,options}=fixture(t);
 rejectsChanges(report,options,[
  value=>value.cases[0].visitObserved='1',value=>value.cases[1].visitObserved=null,value=>value.footerCases[1].visitObserved=null,
  value=>delete value.cases.find(item=>item.cycles===14).idlePersistence,
  value=>value.cases.find(item=>item.cycles===14).idlePersistence.delayMs=5000,
  value=>value.cases.find(item=>item.cycles===14).idlePersistence.after.sourceAnchors[0].visible=false,
  value=>value.cases[1].linkInteraction.links[0].visibleUnblocked=false,
  value=>value.cases[1].linkInteraction.observedInputs.tabs[0].trusted=false,
  value=>value.cases[1].linkInteraction.observedInputs.activations[0].trusted=false,
  value=>value.cases[1].linkInteraction.observedInputs.activations=[],
  value=>value.cases[1].linkInteraction.observedInputs.activations[0].href='/sources#wrong',
  value=>value.cases[1].linkInteraction.navigation='unobserved',
  value=>value.cases[1].linkInteraction.afterURL+='sources',
  value=>{delete value.cases[1].linkInteraction.before.url;delete value.cases[1].linkInteraction.afterURL;},
  value=>value.cases[1].linkInteraction.before.hrefs.pop(),
  value=>value.footerCases[0].linkInteraction.links.pop(),
 ]);
});
test('success bits cannot conceal stale sources, missing loading cycles, removed labels or reduced controls',t=>{
 const {report,options}=fixture(t);
 rejectsChanges(report,options,[
  value=>value.sourceCommit='d'.repeat(40),value=>value.sources.files[0].sha256='d'.repeat(64),value=>value.sources.cssFiles.pop(),value=>value.sources.fixtureSHA256='d'.repeat(64),
  value=>value.cases.pop(),value=>value.cases[0].name=value.cases[1].name,value=>value.cases.find(item=>item.cycles===14).comparisons.pop(),
  value=>value.cases[0].ready.credit.left++,value=>value.cases[0].comparisons[1].ready.sourceLink.top++,
  value=>value.cases[0].ready.status.focusableChildren=1,value=>value.cases[0].loading.status.visible=false,value=>value.cases[0].ready.anchors[0].value='',
  value=>value.cases[0].ready.sourceLink=box(260,116,43,44),value=>value.cases[0].ready.blocked=true,value=>value.cases[0].ready.fontFamily='fallback',
  value=>value.cases[0].ready.sourceLinkHref='/elsewhere',value=>value.cases[0].ready.sourceLinkLabel='',
  value=>value.cases[1].ready.sourceAnchors[0].href='/sources',value=>value.cases[1].ready.sourceAnchors[0].visibleUnblocked=false,
  value=>value.cases[1].ready.sourceAnchors[0].rect=box(16,-32,100,16),
  value=>value.negativeControls[0].ready=value.negativeControls[0].loading,value=>value.negativeControls[0].fonts[0].status='unloaded',
  value=>delete value.environment.nativeSurface,value=>value.environment.gpu.featureStatus.gpu_compositing='enabled',
 ]);
});
test('screenshots cannot be omitted, replaced, redirected or silently captured at another DPR',t=>{
 const {report,options}=fixture(t);
 rejectsChanges(report,options,[value=>delete value.cases[0].screenshot,value=>value.cases[0].screenshot.sha256='d'.repeat(64),value=>value.cases[0].screenshot.path='../elsewhere.png',value=>value.cases[0].screenshot.bytes++,value=>delete value.cases.find(item=>item.linkInteraction.focusScreenshot).linkInteraction.focusScreenshot]);
 const bad=structuredClone(report),png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(320,16);png.writeUInt32BE(640,20);
 writeFileSync(join(options.previewRoot,bad.cases[0].screenshot.path),png);bad.cases[0].screenshot.sha256=createHash('sha256').update(png).digest('hex');
 assert.throws(()=>assertMapAttributionReceipt(bad,options),'Matching hash cannot excuse a lower DPR');
});
