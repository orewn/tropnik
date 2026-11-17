import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {BROWSER_REQUIRED_VIEWS,assertNativeSurfaceCoverage} from './browser-native-surface.mjs';
import {assertMapUIBounds} from './browser-zoom-audit.mjs';

const repoRoot=resolve(import.meta.dirname,'../..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const MAP_ATTRIBUTION_PROFILES=BROWSER_REQUIRED_VIEWS.map(({name,width,height,deviceScaleFactor})=>({name,width,height,mobile:name!=='desktop-webgl',dpr:deviceScaleFactor}));
export const MAP_ATTRIBUTION_SCENARIOS=[{name:'detail',source:'eox-s2',zoom:14},{name:'detail-limit',source:'eox-s2',zoom:18},{name:'overview',source:'eox-bluemarble',zoom:8},{name:'overview-limit',source:'eox-bluemarble',zoom:12}];
export const MAP_ATTRIBUTION_LAYOUT_CASES=[
 ...[701,930,931,1024].flatMap(width=>[false,true].map(returning=>({name:'sidebar-'+width+'-'+(returning?'returning':'fresh'),profile:{name:'sidebar-'+width,width,height:1000,dpr:1,mobile:false},satellite:true,returning,sheetOpen:false}))),
 ...MAP_ATTRIBUTION_PROFILES.flatMap(profile=>[false,true].map(satellite=>({name:profile.name+'-'+(satellite?'retained':'pending'),profile,satellite,returning:false,sheetOpen:false}))),
 ...MAP_ATTRIBUTION_PROFILES.filter(profile=>profile.mobile&&profile.height>profile.width).flatMap(profile=>[false,true].map(satellite=>({name:profile.name+'-sheet-open-'+(satellite?'retained':'pending'),profile,satellite,returning:false,sheetOpen:true}))),
];
export const attributionGeometry=value=>({rect:value.rect,atlas:value.atlas,credit:value.credit,sourceCredit:value.sourceCredit,sourceLink:value.sourceLink,sourceAnchors:value.sourceAnchors,anchors:value.anchors,details:value.details,statusRect:value.status.rect,compactStyles:value.compactStyles});
export const footerLoadingGeometry=value=>({footer:value.footer,publishedFooterHeight:value.publishedFooterHeight,statusRect:value.status.rect,ui:value.ui.filter(item=>item.kind!=='map-preload-status'),targets:value.targets});
export const attributionLinkHrefs=(satellite=true,source='eox-s2')=>['https://www.openstreetmap.org/copyright','https://openmaptiles.org/',...(satellite?(source==='eox-s2'?['https://cloudless.eox.at','https://eox.at']:['https://science.nasa.gov/earth/earth-observatory/','https://maps.eox.at/#data']):[]),'/sources'];
/** Independent assertion failures are retained; transport and capture errors remain fatal. */
export async function collectAttributionGeometryCase(run,recordFailure){
 try{await run();return true;}catch(error){
  if(error?.name!=='AssertionError'||error?.code!=='ERR_ASSERTION')throw error;
  await recordFailure(error);return false;
 }
}
export function expectedMapAttributionSources(root=repoRoot){
 const web=join(root,'web'),require=createRequire(join(web,'package.json')),layout=readFileSync(join(web,'app/layout.tsx'),'utf8');
 const cssFiles=[...layout.matchAll(/^import ["']([^"']+\.css)["'];/gm)].map(match=>match[1].startsWith('./')?'app/'+match[1].slice(2):match[1]);
 const files=['components/MapAttribution.tsx','components/MapIcon.tsx','components/TropnikIcons.tsx','lib/map-satellite.ts','lib/russia-map.ts'];
 return{layoutSHA256:sha(layout),fixtureSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/browser-map-attribution.browser.mjs'))),cssFiles:cssFiles.map(path=>({path,sha256:sha(readFileSync(path.startsWith('@')?require.resolve(path):join(web,path)))})),uiFiles:['components/CustomAtlas.tsx','components/PlaceStories.tsx'].map(path=>({path,sha256:sha(readFileSync(join(web,path)))})),files:files.map(path=>({path,sha256:sha(readFileSync(join(web,path)))}))};
}
function validRect(rect){
 assert.ok(rect&&['left','top','right','bottom','width','height'].every(key=>Number.isFinite(rect[key])),'Missing actual geometry');
 assert.ok(rect.width>0&&rect.height>0,'Empty measured geometry');
 assert.ok(Math.abs(rect.right-rect.left-rect.width)<.001&&Math.abs(rect.bottom-rect.top-rect.height)<.001,'Inconsistent measured geometry');
}
export function assertAttributionFooterLayout(value,scenario,loading){
 const {profile,satellite,sheetOpen}=scenario;
 assert.equal(value.width,profile.width);assert.equal(value.height,profile.height);assert.equal(value.sheetOpen,sheetOpen);
 validRect(value.available);validRect(value.footer);validRect(value.status.rect);
 assert.equal(value.status.visible,loading);assert.equal(value.status.ariaHidden,String(!loading));assert.equal(value.status.text,'Подгружаем детали текущего ракурса');
 assert.equal(value.publishedFooterHeight,Math.ceil(value.footer.height),'Actions must consume the observed footer height');
 const count=kind=>value.ui.filter(item=>item.kind===kind).length;
 for(const kind of ['map-context','map-style-switch','map-controls','layer-button','fact-closed','map-attribution-link','map-source-credit'])assert.equal(count(kind),1,'Missing real fixture control: '+kind);
 assert.equal(count('map-satellite-credit'),Number(satellite));assert.equal(count('map-preload-status'),Number(loading));
 assert.equal(value.panelCount,0,'An automatic or expandable licence panel must not return');
 assert.equal(value.toggleCount,0,'The source-page link must not become a popup toggle');
 assert.equal(count('map-legend'),Number(!profile.mobile),'The desktop scale and legend must remain visible');
 for(const item of value.ui)validRect(item.rect);
 const primary=['Рельеф','Спутник','Увеличить масштаб','Уменьшить масштаб','Моё местоположение','Настройки карты','Истории мест','Источники данных карты и лицензии'];
 const expected=profile.mobile?primary:[...primary,'Север сверху','Показать Россию целиком'];
 assert.deepEqual(value.targets.map(target=>target.label).sort(),expected.sort(),'Every named primary action must remain reachable; mobile secondary camera actions are verified in Settings');
 if(profile.mobile)for(const target of value.targets)assert.ok(target.minimumSize>=48,'Mobile source and map actions retain a 48px touch minimum');
 assertMapUIBounds(value,scenario.name+(loading?' loading':' ready'));return value;
}
export function assertAttributionSheetCycle(cycle,scenario,baseline){
 const {profile}=scenario,portrait=profile.mobile&&profile.height>profile.width;
 if(!portrait){assert.equal(cycle,undefined);return;}
 assert.equal(cycle?.input,'production-react-sheet-state');assert.equal(cycle.states.length,3);
 assert.deepEqual(cycle.states.map(value=>value.sheetOpen),[false,true,false]);
 for(const value of cycle.states){
  assertAttributionFooterLayout(value,{...scenario,sheetOpen:value.sheetOpen},false);
  assert.ok(Number.isFinite(value.panelHeight)&&value.panelHeight>0);assert.equal(value.panelTransition,'transform');
  if(profile.name==='compact-android'){
   assert.ok(Number.isFinite(value.sheetPeek)&&value.sheetPeek>0);
   assert.ok(value.panelHeight-value.sheetPeek>60,'The compact catalogue must retain usable native drag travel');
  }
 }
 const heights=cycle.states.map(value=>value.panelHeight);
 assert.ok(Math.max(...heights)-Math.min(...heights)<1.1,'Sheet state must not change physical panel height');
 assert.deepEqual(cycle.states.map(value=>value.footer.height),Array(3).fill(cycle.states[0].footer.height),'The sheet must not reflow source text');
 assert.deepEqual(footerLoadingGeometry(cycle.states[2]),footerLoadingGeometry(cycle.states[0]));
 assert.deepEqual(footerLoadingGeometry(cycle.states[scenario.sheetOpen?1:0]),footerLoadingGeometry(baseline));
}
function compactStyle(value){
 assert.equal(value.backgroundColor,'rgba(0, 0, 0, 0)');assert.equal(value.boxShadow,'none');
 assert.deepEqual(value.borders,['0px','0px','0px','0px']);
 assert.ok(typeof value.textShadow==='string'&&value.textShadow!=='none','Credits require legible text over imagery');
}
export function assertCompactAttributionSnapshot(value,profile,scenario,loading){
 for(const key of ['rect','atlas','credit','sourceCredit','sourceLink'])validRect(value[key]);validRect(value.status.rect);
 assert.equal(value.panelCount,0);assert.equal(value.toggleCount,0);assert.equal(value.source,scenario.source);assert.equal(value.blocked,false);
 assert.equal(value.sourceLinkHref,'/sources');assert.equal(value.sourceLinkLabel,'Источники данных карты и лицензии');
 assert.ok(value.sourceLink.width>=44&&value.sourceLink.height>=44);
 for(const key of ['rect','credit','sourceCredit','sourceLink'])assert.ok(value[key].left>=0&&value[key].right<=profile.width&&value[key].top>=0&&value[key].bottom<=profile.height,'Compact sources must remain inside the viewport');
 assert.equal(value.viewportWidth,profile.width);assert.ok(value.documentWidth<=profile.width);
 assert.match(value.fontFamily,/Manrope/);assert.equal(value.fontSize,'12px');assert.equal(value.lineHeight,'16px');
 assert.equal(value.compactStyles.length,3);value.compactStyles.forEach(compactStyle);
 assert.deepEqual(value.sourceAnchors.map(item=>item.value),['© участники OpenStreetMap','OpenMapTiles']);
 assert.deepEqual(value.sourceAnchors.map(item=>item.href),['https://www.openstreetmap.org/copyright','https://openmaptiles.org/']);
 assert.deepEqual(value.anchors.map(item=>item.value),[scenario.source==='eox-s2'?'EOxCloudless':'NASA Blue Marble','EOX']);
 assert.deepEqual(value.anchors.map(item=>item.href),scenario.source==='eox-s2'?['https://cloudless.eox.at/','https://eox.at/']:['https://science.nasa.gov/earth/earth-observatory/','https://maps.eox.at/#data']);
 const details=scenario.source==='eox-s2'?(scenario.zoom>14?['Достигнута детализация снимка']:[]):['Обзорный снимок · детализация ниже',...(scenario.zoom>8?['Увеличен обзорный снимок']:[])];
 assert.deepEqual(value.details.map(item=>item.value),details);
 for(const [texts,bounds]of [[value.sourceAnchors,value.sourceCredit],[[...value.anchors,...value.details,...(loading?[value.status]:[])].flat(),value.credit]]){
  for(const text of texts){validRect(text.rect);assert.equal(text.visible,true);assert.equal(text.visibleUnblocked,true);assert.ok(text.rect.left>=bounds.left&&text.rect.right<=bounds.right&&text.rect.top>=bounds.top&&text.rect.bottom<=bounds.bottom,'Visible source text lies outside its measured bounds');}
 }
 assert.equal(value.status.value,'Загружаем снимки…');assert.equal(value.status.visible,loading);assert.equal(value.status.ariaHidden,String(!loading));assert.equal(value.status.focusableChildren,0);
}
function linkInteraction(interaction,hrefs){
 assert.equal(interaction?.input,'native-cdp-tab-and-enter');assert.equal(interaction.navigation,'intercepted-to-retain-fixture');
 assert.match(interaction.before.url,/^http:\/\/127\.0\.0\.1:\d+\/$/,'Source activation must start on the live fixture origin');
 assert.deepEqual(interaction.before.hrefs,hrefs);assert.deepEqual(interaction.links.map(link=>link.href),hrefs);
 assert.ok(interaction.links.every(link=>link.focused&&link.visibleUnblocked&&link.text.length>0));
 assert.equal(interaction.observedInputs.tabs.length,hrefs.length-1);assert.ok(interaction.observedInputs.tabs.every(event=>event.key==='Tab'&&event.trusted));
 assert.deepEqual(interaction.observedInputs.activations,[{href:'/sources',trusted:true}]);
 assert.equal(interaction.afterURL,interaction.before.url,'Native activation must not abandon the matrix fixture');
}
/** A schema-1 expandable-panel receipt cannot certify the compact-credit UI. */
export function assertMapAttributionReceipt(report,{sourceCommit,root=repoRoot,previewRoot=join(root,'web/pages-preview'),environment}={}){
 assert.match(sourceCommit||'',/^[a-f0-9]{40}$/);
 assert.equal(report?.schemaVersion,2);assert.equal(report.verified,true);assert.equal(report.phase,'complete');assert.equal(report.sourceCommit,sourceCommit);
 assert.equal(report.evidence,'production-react-compact-credit-and-css-browser-geometry');assert.deepEqual(report.caseFailures,[]);
 for(const [key,value]of Object.entries(expectedMapAttributionSources(root)))assert.deepEqual(report.sources?.[key],value,'Attribution source binding differs: '+key);
 for(const key of ['compiledCssSHA256','bundleSHA256'])assert.match(report.sources[key],/^[a-f0-9]{64}$/);
 assertBrowserEnvironment(report.environment,sourceCommit);assertNativeSurfaceCoverage(report.environment.nativeSurface);
 if(environment)assertMatchingBrowserEnvironments(report.environment,environment,sourceCommit);
 assert.deepEqual(report.profiles,MAP_ATTRIBUTION_PROFILES);
 assert.deepEqual(report.negativeControls.map(item=>item.profile),MAP_ATTRIBUTION_PROFILES.map(item=>item.name));
 for(const control of report.negativeControls){
  validRect(control.loading.credit);validRect(control.ready.credit);assert.notDeepEqual(control.loading.credit,control.ready.credit,'Missing demonstrated loading reflow');
  assert.equal(control.legacyPanelCount,1,'Missing detection of a deliberately restored legal panel');
  assert.deepEqual(control.notReady,{hidden:true,display:'none',visibleLinks:0},'Not-yet-ready source links must stay hidden');
  assert.equal(control.fonts.length,8);assert.deepEqual(control.fonts.map(face=>String(face.weight)).sort(),['400','400','500','500','600','600','700','700']);
  assert.ok(control.fonts.every(face=>face.family.replace(/['"]/g,'')==='Manrope'&&face.status==='loaded'));
 }
 const expected=MAP_ATTRIBUTION_PROFILES.flatMap(profile=>MAP_ATTRIBUTION_SCENARIOS.flatMap(scenario=>[false,true].map(returning=>({profile,scenario,returning,name:profile.name+'-'+scenario.name+'-'+(returning?'returning':'fresh')}))));
 assert.deepEqual(report.cases.map(item=>item.name),expected.map(item=>item.name));let cycles=0,pictures=0;
 const picture=(capture,file,profile)=>{
  assert.equal(capture?.path,file);const png=readFileSync(join(previewRoot,file));assert.equal(png.length,capture.bytes);assert.equal(sha(png),capture.sha256);
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[profile.width*profile.dpr,profile.height*profile.dpr]);pictures++;
 };
 for(const [index,{profile,scenario,returning,name}]of expected.entries()){
  const item=report.cases[index],long=profile.name==='android-portrait'&&scenario.name==='detail'&&!returning,count=long?14:3;
  assert.equal(item.profile,profile.name);assert.equal(item.source,scenario.source);assert.equal(item.zoom,scenario.zoom);assert.equal(item.returning,returning);assert.equal(item.visitObserved,returning?'1':null);assert.equal(item.cycles,count);assert.equal(item.comparisons.length,count);
  assertCompactAttributionSnapshot(item.loading,profile,scenario,true);assertCompactAttributionSnapshot(item.ready,profile,scenario,false);
  assertAttributionFooterLayout(item.layout,{name,profile,satellite:true,returning,sheetOpen:false},false);
  assertAttributionSheetCycle(item.sheetCycle,{name,profile,satellite:true,returning,sheetOpen:false},item.layout);
  const baseline=attributionGeometry(item.loading);assert.deepEqual(attributionGeometry(item.ready),baseline,'A tile request changed the source footprint');
  for(const [cycle,comparison]of item.comparisons.entries()){assert.equal(comparison.cycle,cycle+1);assert.deepEqual(comparison.loading,baseline);assert.deepEqual(comparison.ready,baseline);cycles++;}
  linkInteraction(item.linkInteraction,attributionLinkHrefs(true,scenario.source));
  if(long){assert.equal(item.idlePersistence.delayMs,6000);assertCompactAttributionSnapshot(item.idlePersistence.after,profile,scenario,false);assert.deepEqual(attributionGeometry(item.idlePersistence.after),attributionGeometry(item.ready));}else assert.equal(item.idlePersistence,undefined);
  const focused=returning&&scenario.name==='overview-limit'&&['compact-android','phone-landscape'].includes(profile.name);
  if(focused)picture(item.linkInteraction.focusScreenshot,'design-qa/map-attribution/'+name+'-sources-focus.png',profile);else assert.equal(item.linkInteraction.focusScreenshot,undefined);
  if(scenario.name===(returning?'overview-limit':'detail'))picture(item.screenshot,'design-qa/map-attribution/'+name+'.png',profile);else assert.equal(item.screenshot,undefined);
 }
 assert.equal(cycles,131);assert.equal(pictures,12);
 assert.deepEqual(report.footerCases?.map(item=>item.name),MAP_ATTRIBUTION_LAYOUT_CASES.map(item=>item.name));
 for(const [index,scenario]of MAP_ATTRIBUTION_LAYOUT_CASES.entries()){
  const entry=report.footerCases[index];for(const key of ['name','profile','satellite','returning','sheetOpen'])assert.deepEqual(entry[key],scenario[key]);
  assert.equal(entry.visitObserved,scenario.returning?'1':null);
  assertAttributionFooterLayout(entry.loading,scenario,true);assertAttributionFooterLayout(entry.ready,scenario,false);assertAttributionSheetCycle(entry.sheetCycle,scenario,entry.ready);
  assert.deepEqual(footerLoadingGeometry(entry.ready),footerLoadingGeometry(entry.loading),'Loading moved the footer or an adjacent action');
  linkInteraction(entry.linkInteraction,attributionLinkHrefs(scenario.satellite,'eox-bluemarble'));
  picture(entry.screenshot,'design-qa/map-attribution/footer-'+scenario.name+'.png',scenario.profile);
 }
 assert.equal(pictures,36);return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const report=JSON.parse(readFileSync(join(repoRoot,'web/pages-preview/dist/browser-map-attribution-verification.json'),'utf8'));
 assertMapAttributionReceipt(report,{sourceCommit:process.env.GITHUB_SHA});
 console.log(JSON.stringify({verified:true,sourceCommit:report.sourceCommit,profiles:report.profiles.length,cases:report.cases.length,loadingCycles:131,footerCases:report.footerCases.length,pngs:36}));
}
