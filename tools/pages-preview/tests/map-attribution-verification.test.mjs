import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MAP_ATTRIBUTION_PROFILES,MAP_ATTRIBUTION_SCENARIOS,attributionGeometry,expectedMapAttributionSources,assertMapAttributionReceipt} from '../map-attribution-verification.mjs';
import {browserEnvironmentFixture} from './browser-environment-fixture.mjs';

const commit='a'.repeat(40),box=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});
// Synthetic validator inputs only. Browser geometry and screenshot production
// are exercised separately by browser-map-attribution.browser.mjs.
function fixture(t){
 const previewRoot=mkdtempSync(join(tmpdir(),'tropnik-attribution-validator-'));t.after(()=>rmSync(previewRoot,{recursive:true,force:true}));mkdirSync(join(previewRoot,'design-qa/map-attribution'),{recursive:true});
 const fonts=[400,500,600,700].flatMap(weight=>[0,1].map(()=>({family:'Manrope',weight:String(weight),status:'loaded'})));
 const picture=(name,profile)=>{
  // Only PNG header/identity binding is tested here, never visual parity.
  const png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(profile.width*profile.dpr,16);png.writeUInt32BE(profile.height*profile.dpr,20);
  const path='design-qa/map-attribution/'+name+'.png';writeFileSync(join(previewRoot,path),png);return{path,bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')};
 };
 const report={schemaVersion:1,verified:true,phase:'complete',sourceCommit:commit,evidence:'production-react-and-compiled-css-browser-geometry',sources:{...expectedMapAttributionSources(),compiledCssSHA256:'b'.repeat(64),bundleSHA256:'c'.repeat(64)},environment:browserEnvironmentFixture(commit),profiles:MAP_ATTRIBUTION_PROFILES,negativeControls:[],cases:[]};
 for(const profile of MAP_ATTRIBUTION_PROFILES){
  report.negativeControls.push({profile:profile.name,fonts,loading:{credit:box(16,40,180,66)},ready:{credit:box(32,56,164,50)}});
  for(const scenario of MAP_ATTRIBUTION_SCENARIOS)for(const expanded of [false,true]){
   const name=`${profile.name}-${scenario.name}-${expanded?'expanded':'collapsed'}`,credit=box(16,40,profile.width-84,120),text=value=>({value,rect:box(20,44,100,16),visible:true,visibleUnblocked:true});
   const anchors=(scenario.source==='eox-s2'?[['EOxCloudless','https://cloudless.eox.at/'],['EOX','https://eox.at/']]:[['NASA Blue Marble','https://science.nasa.gov/earth/earth-observatory/'],['EOX','https://maps.eox.at/#data']]).map(([value,href])=>({...text(value),href}));
   const details=(scenario.source==='eox-s2'?(scenario.zoom>14?['Достигнута детализация снимка']:[]):['Обзорный снимок · детализация ниже',...(scenario.zoom>8?['Увеличен обзорный снимок']:[])]).map(text);
   const loading={rect:box(16,40,profile.width-32,120),atlas:box(0,0,profile.width,profile.height),credit,content:expanded?box(16,10,200,20):null,toggle:box(profile.width-60,116,44,44),expanded,source:scenario.source,fontFamily:'Manrope',fontSize:'12px',lineHeight:'16px',anchors,details,status:{...text('Загружаем снимки…'),ariaHidden:'false',focusableChildren:0},contentText:expanded?'OpenStreetMap contributors · Данные и лицензии · CC BY 4.0 · NASA Earth Observatory':null,blocked:false,documentWidth:profile.width,viewportWidth:profile.width};
   const ready=structuredClone(loading);ready.status.visible=false;ready.status.ariaHidden='true';const cycles=profile.name==='android-portrait'&&scenario.name==='detail'&&!expanded?14:3;
   const item={name,profile:profile.name,source:scenario.source,zoom:scenario.zoom,expanded,cycles,loading,ready,comparisons:Array.from({length:cycles},(_,index)=>({cycle:index+1,loading:attributionGeometry(loading),ready:attributionGeometry(ready)}))};
   if(expanded){
    const scrollable=profile.name==='phone-landscape'&&scenario.source==='eox-bluemarble',hrefs=['https://www.openstreetmap.org/copyright','https://openmaptiles.org/','/sources',...(scenario.source==='eox-s2'?['https://cloudless.eox.at','https://eox.at','https://creativecommons.org/licenses/by/4.0/']:[]),'/sources#satellite-attribution'];
    const scrollHeight=scrollable?36:18,clientHeight=18,maxScroll=scrollHeight-clientHeight;
    item.licenseInteraction={input:'native-cdp-wheel-and-tab',scrollable,before:{devicePixelRatio:profile.dpr,scrollTop:0,scrollHeight,clientHeight,overflowY:scrollable?'auto':'visible',center:{x:116,y:20},hrefs},links:hrefs.map(href=>({href,text:'Synthetic link',focused:true,visibleUnblocked:true,scrollTop:0})),wheelTransitions:scrollable?[{deltaY:-scrollHeight,nativeDeltaY:-scrollHeight*profile.dpr,before:maxScroll,after:0,expected:0},{deltaY:scrollHeight,nativeDeltaY:scrollHeight*profile.dpr,before:0,after:maxScroll,expected:maxScroll},{deltaY:-scrollHeight,nativeDeltaY:-scrollHeight*profile.dpr,before:maxScroll,after:0,expected:0}]:[],observedInputs:{tabs:hrefs.slice(1).map(()=>({key:'Tab',trusted:true})),wheels:scrollable?[-scrollHeight,scrollHeight,-scrollHeight].map(deltaY=>({deltaY,trusted:true})):[]}};
    if(scrollable&&scenario.name==='overview-limit')item.licenseInteraction.bottomScreenshot=picture(name+'-license-bottom',profile);
   }
   if(scenario.name===(expanded?'overview-limit':'detail'))item.screenshot=picture(name,profile);
   report.cases.push(item);
  }
 }
 return{report,options:{sourceCommit:commit,previewRoot}};
}

test('receipt binds all 40 cases, 131 comparison slots, source inputs, loaded fonts and 11 PNG identities',t=>{
 const {report,options}=fixture(t);assert.equal(assertMapAttributionReceipt(report,options),report);
 assert.equal(assertMapAttributionReceipt(report,{...options,environment:browserEnvironmentFixture(commit)}),report);
});
test('success bits cannot conceal stale source, missing loading cycles, removed labels or reduced controls',t=>{
 const {report,options}=fixture(t);
 const changes=[
  value=>value.sourceCommit='d'.repeat(40),value=>value.sources.files[0].sha256='d'.repeat(64),value=>value.sources.cssFiles.pop(),value=>value.sources.fixtureSHA256='d'.repeat(64),
  value=>value.cases.pop(),value=>value.cases[0].name=value.cases[1].name,value=>value.cases.find(item=>item.cycles===14).comparisons.pop(),
  value=>value.cases[0].ready.credit.left++,value=>value.cases[0].comparisons[1].ready.toggle.top++,
  value=>value.cases[0].ready.status.focusableChildren=1,value=>value.cases[0].loading.status.visible=false,value=>value.cases[0].ready.anchors[0].value='',
  value=>value.cases[0].ready.toggle=box(260,116,43,44),value=>value.cases[0].ready.blocked=true,value=>value.cases[0].ready.fontFamily='fallback',
  value=>value.cases[1].ready.content=box(16,-32,200,144),
  value=>value.cases[1].licenseInteraction.links[0].visibleUnblocked=false,value=>value.cases[1].licenseInteraction.observedInputs.tabs[0].trusted=false,
  value=>value.cases.find(item=>item.licenseInteraction?.scrollable).licenseInteraction.wheelTransitions[1].after=0,
  value=>value.cases.find(item=>item.licenseInteraction?.scrollable).licenseInteraction.observedInputs.wheels[0].trusted=false,
  value=>value.cases.find(item=>item.licenseInteraction?.scrollable).licenseInteraction.observedInputs.wheels[0].deltaY/=2,
  value=>value.cases.find(item=>item.licenseInteraction?.scrollable).licenseInteraction.wheelTransitions[0].nativeDeltaY/=2,
  value=>value.cases.find(item=>item.licenseInteraction?.scrollable).licenseInteraction.before.devicePixelRatio=1,
  value=>value.negativeControls[0].ready=value.negativeControls[0].loading,value=>value.negativeControls[0].fonts[0].status='unloaded',
  value=>delete value.environment.nativeSurface,value=>value.environment.gpu.featureStatus.gpu_compositing='enabled',
 ];
 for(const change of changes){const bad=structuredClone(report);change(bad);assert.throws(()=>assertMapAttributionReceipt(bad,options));}
});
test('screenshots cannot be omitted, replaced, redirected or silently captured at another DPR',t=>{
 const {report,options}=fixture(t);
 for(const change of [value=>delete value.cases[0].screenshot,value=>value.cases[0].screenshot.sha256='d'.repeat(64),value=>value.cases[0].screenshot.path='../elsewhere.png',value=>value.cases[0].screenshot.bytes++]){
  const bad=structuredClone(report);change(bad);assert.throws(()=>assertMapAttributionReceipt(bad,options));
 }
 const bad=structuredClone(report),png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(320,16);png.writeUInt32BE(640,20);
 writeFileSync(join(options.previewRoot,bad.cases[0].screenshot.path),png);bad.cases[0].screenshot.sha256=createHash('sha256').update(png).digest('hex');
 assert.throws(()=>assertMapAttributionReceipt(bad,options),'Matching hash cannot excuse a lower DPR');
});
