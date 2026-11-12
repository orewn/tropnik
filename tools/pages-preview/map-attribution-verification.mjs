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
 ...[701,930,931,1024].flatMap(width=>[false,true].map(expanded=>({name:`sidebar-${width}-${expanded?'expanded':'collapsed'}`,profile:{name:`sidebar-${width}`,width,height:1000,dpr:1,mobile:false},satellite:true,expanded,sheetOpen:false}))),
 ...MAP_ATTRIBUTION_PROFILES.flatMap(profile=>[false,true].map(satellite=>({name:`${profile.name}-${satellite?'retained':'pending'}`,profile,satellite,expanded:false,sheetOpen:false}))),
 ...MAP_ATTRIBUTION_PROFILES.filter(profile=>profile.mobile&&profile.height>profile.width).flatMap(profile=>[false,true].map(satellite=>({name:`${profile.name}-sheet-open-${satellite?'retained':'pending'}`,profile,satellite,expanded:false,sheetOpen:true}))),
];
export const attributionGeometry=value=>({rect:value.rect,atlas:value.atlas,credit:value.credit,content:value.content,toggle:value.toggle,anchors:value.anchors,details:value.details,statusRect:value.status.rect,contentText:value.contentText});
export const footerLoadingGeometry=value=>({footer:value.footer,publishedFooterHeight:value.publishedFooterHeight,statusRect:value.status.rect,ui:value.ui.filter(item=>item.kind!=='map-preload-status'),targets:value.targets});

export function expectedMapAttributionSources(root=repoRoot){
 const web=join(root,'web'),require=createRequire(join(web,'package.json')),layout=readFileSync(join(web,'app/layout.tsx'),'utf8');
 const cssFiles=[...layout.matchAll(/^import ["']([^"']+\.css)["'];/gm)].map(match=>match[1].startsWith('./')?'app/'+match[1].slice(2):match[1]);
 const files=['components/MapAttribution.tsx','components/MapIcon.tsx','components/TropnikIcons.tsx','lib/map-attribution.ts','lib/map-satellite.ts','lib/russia-map.ts'];
 return{layoutSHA256:sha(layout),fixtureSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/browser-map-attribution.browser.mjs'))),cssFiles:cssFiles.map(path=>({path,sha256:sha(readFileSync(path.startsWith('@')?require.resolve(path):join(web,path)))})),uiFiles:['components/CustomAtlas.tsx','components/PlaceStories.tsx'].map(path=>({path,sha256:sha(readFileSync(join(web,path)))})),files:files.map(path=>({path,sha256:sha(readFileSync(join(web,path)))}))};
}
function validRect(rect){
 assert.ok(rect&&['left','top','right','bottom','width','height'].every(key=>Number.isFinite(rect[key])),'Missing actual geometry');
 assert.ok(rect.width>0&&rect.height>0,'Empty measured geometry');assert.ok(Math.abs(rect.right-rect.left-rect.width)<.001&&Math.abs(rect.bottom-rect.top-rect.height)<.001,'Inconsistent measured geometry');
}
export function assertAttributionFooterLayout(value,scenario,loading){
 const {profile,satellite,expanded,sheetOpen}=scenario;
 assert.equal(value.width,profile.width);assert.equal(value.height,profile.height);assert.equal(value.sheetOpen,sheetOpen);
 validRect(value.available);validRect(value.status.rect);assert.equal(value.status.visible,loading);assert.equal(value.status.ariaHidden,String(!loading));assert.equal(value.status.text,'Подгружаем детали текущего ракурса');
 assert.equal(value.publishedFooterHeight,Math.ceil(value.footer.height),'The actions must consume the actual observed footer height');
 const count=kind=>value.ui.filter(item=>item.kind===kind).length;
 for(const kind of ['map-context','map-style-switch','map-controls','layer-button','fact-closed','map-attribution-toggle'])assert.equal(count(kind),1,'Missing real fixture control: '+kind);
 assert.equal(count('map-satellite-credit'),Number(satellite));assert.equal(count('map-attribution-content'),Number(expanded));assert.equal(count('map-preload-status'),Number(loading));
 assert.equal(count('map-legend'),Number(!profile.mobile),'The desktop scale and legend must remain visible');
 for(const item of value.ui)validRect(item.rect);
 assert.equal(value.targets.length,10,'The five map actions, two modes, layer, story and licence controls must all remain reachable');
 assertMapUIBounds(value,scenario.name+(loading?' loading':' ready'));
 return value;
}
function snapshot(value,profile,scenario,expanded,loading){
 for(const key of ['rect','atlas','credit','toggle'])validRect(value[key]);validRect(value.status.rect);
 if(expanded){validRect(value.content);assert.ok(value.content.left>=value.atlas.left&&value.content.right<=value.atlas.right&&value.content.top>=value.atlas.top&&value.content.bottom<=value.atlas.bottom,'The licence panel is clipped by its map viewport');}else assert.equal(value.content,null);
 assert.equal(value.source,scenario.source);assert.equal(value.expanded,expanded);assert.equal(value.blocked,false);
 assert.ok(value.toggle.width>=44&&value.toggle.height>=44);assert.ok(value.credit.left>=0&&value.credit.right<=profile.width&&value.credit.top>=0&&value.credit.bottom<=profile.height);
 assert.equal(value.viewportWidth,profile.width);assert.ok(value.documentWidth<=profile.width);assert.match(value.fontFamily,/Manrope/);assert.equal(value.fontSize,'12px');assert.equal(value.lineHeight,'16px');
 assert.deepEqual(value.anchors.map(item=>item.value),[scenario.source==='eox-s2'?'EOxCloudless':'NASA Blue Marble','EOX']);
 assert.deepEqual(value.anchors.map(item=>item.href),scenario.source==='eox-s2'?['https://cloudless.eox.at/','https://eox.at/']:['https://science.nasa.gov/earth/earth-observatory/','https://maps.eox.at/#data']);
 const details=scenario.source==='eox-s2'?(scenario.zoom>14?['Достигнута детализация снимка']:[]):['Обзорный снимок · детализация ниже',...(scenario.zoom>8?['Увеличен обзорный снимок']:[])];
 assert.deepEqual(value.details.map(item=>item.value),details);
 for(const text of [...value.anchors,...value.details,...(loading?[value.status]:[])]){validRect(text.rect);assert.equal(text.visible,true);assert.equal(text.visibleUnblocked,true);assert.ok(text.rect.left>=value.credit.left&&text.rect.right<=value.credit.right&&text.rect.top>=value.credit.top&&text.rect.bottom<=value.credit.bottom,'Source text lies outside its card');}
 assert.equal(value.status.value,'Загружаем снимки…');assert.equal(value.status.visible,loading);assert.equal(value.status.ariaHidden,String(!loading));assert.equal(value.status.focusableChildren,0);
 if(expanded){assert.match(value.contentText,/OpenStreetMap contributors/);assert.match(value.contentText,/Данные и лицензии/);assert.match(value.contentText,scenario.source==='eox-s2'?/CC BY 4\.0/:/NASA Earth Observatory/);}else assert.equal(value.contentText,null);
}

/** Validate the retained proof against this checkout, not only its success bit. */
export function assertMapAttributionReceipt(report,{sourceCommit,root=repoRoot,previewRoot=join(root,'web/pages-preview'),environment}={}){
 assert.match(sourceCommit||'',/^[a-f0-9]{40}$/,'An exact source commit is required');
 assert.equal(report?.schemaVersion,1);assert.equal(report.verified,true);assert.equal(report.phase,'complete');assert.equal(report.sourceCommit,sourceCommit);assert.equal(report.evidence,'production-react-and-compiled-css-browser-geometry');
 for(const [key,value]of Object.entries(expectedMapAttributionSources(root)))assert.deepEqual(report.sources?.[key],value,'Attribution source binding differs: '+key);
 for(const key of ['compiledCssSHA256','bundleSHA256'])assert.match(report.sources[key],/^[a-f0-9]{64}$/);
 assertBrowserEnvironment(report.environment,sourceCommit);assertNativeSurfaceCoverage(report.environment.nativeSurface);
 if(environment)assertMatchingBrowserEnvironments(report.environment,environment,sourceCommit);
 assert.deepEqual(report.profiles,MAP_ATTRIBUTION_PROFILES);
 assert.deepEqual(report.negativeControls.map(item=>item.profile),MAP_ATTRIBUTION_PROFILES.map(item=>item.name));
 for(const control of report.negativeControls){
  validRect(control.loading.credit);validRect(control.ready.credit);assert.notDeepEqual(control.loading.credit,control.ready.credit,'Missing demonstrated old reflow');
  assert.equal(control.fonts.length,8);assert.deepEqual(control.fonts.map(face=>String(face.weight)).sort(),['400','400','500','500','600','600','700','700']);
  assert.ok(control.fonts.every(face=>face.family.replace(/['"]/g,'')==='Manrope'&&face.status==='loaded'));
 }
 const expected=MAP_ATTRIBUTION_PROFILES.flatMap(profile=>MAP_ATTRIBUTION_SCENARIOS.flatMap(scenario=>[false,true].map(expanded=>({profile,scenario,expanded,name:`${profile.name}-${scenario.name}-${expanded?'expanded':'collapsed'}`}))));
 assert.deepEqual(report.cases.map(item=>item.name),expected.map(item=>item.name));let cycles=0,pictures=0;
 const picture=(capture,file,profile)=>{
  assert.equal(capture?.path,file);const png=readFileSync(join(previewRoot,file));assert.equal(png.length,capture.bytes);assert.equal(sha(png),capture.sha256);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[profile.width*profile.dpr,profile.height*profile.dpr]);pictures++;
 };
 for(const [index,{profile,scenario,expanded,name}]of expected.entries()){
  const item=report.cases[index],count=profile.name==='android-portrait'&&scenario.name==='detail'&&!expanded?14:3;
  assert.equal(item.profile,profile.name);assert.equal(item.source,scenario.source);assert.equal(item.zoom,scenario.zoom);assert.equal(item.expanded,expanded);assert.equal(item.cycles,count);assert.equal(item.comparisons.length,count);
  snapshot(item.loading,profile,scenario,expanded,true);snapshot(item.ready,profile,scenario,expanded,false);
  const baseline=attributionGeometry(item.loading);assert.deepEqual(attributionGeometry(item.ready),baseline,'Loading changed the measured source footprint');
  for(const [cycle,comparison]of item.comparisons.entries()){assert.equal(comparison.cycle,cycle+1);assert.deepEqual(comparison.loading,baseline);assert.deepEqual(comparison.ready,baseline);cycles++;}
  if(expanded){
   const interaction=item.licenseInteraction,hrefs=['https://www.openstreetmap.org/copyright','https://openmaptiles.org/','/sources',...(scenario.source==='eox-s2'?['https://cloudless.eox.at','https://eox.at','https://creativecommons.org/licenses/by/4.0/']:[]),'/sources#satellite-attribution'];
   assert.equal(interaction?.input,'native-cdp-wheel-and-tab');assert.deepEqual(interaction.before.hrefs,hrefs);assert.deepEqual(interaction.links.map(link=>link.href),hrefs);assert.ok(interaction.links.every(link=>link.focused&&link.visibleUnblocked&&link.text.length>0));
   assert.equal(interaction.observedInputs.tabs.length,hrefs.length-1);assert.ok(interaction.observedInputs.tabs.every(event=>event.key==='Tab'&&event.trusted));
   const {scrollHeight,clientHeight,overflowY,center,devicePixelRatio}=interaction.before,maxScroll=scrollHeight-clientHeight;assert.ok(Number.isFinite(scrollHeight)&&clientHeight>0&&clientHeight<=item.ready.content.height&&maxScroll>=0);assert.equal(interaction.before.scrollTop,0);assert.equal(devicePixelRatio,profile.dpr);
   assert.ok(center.x>item.ready.content.left&&center.x<item.ready.content.right&&center.y>item.ready.content.top&&center.y<item.ready.content.bottom);
   const scrollable=['auto','scroll'].includes(overflowY)&&maxScroll>1;assert.equal(interaction.scrollable,scrollable);assert.equal(scrollable,profile.name==='phone-landscape'&&scenario.source==='eox-bluemarble');
   assert.equal(interaction.wheelTransitions.length,scrollable?3:0);assert.equal(interaction.observedInputs.wheels.length,scrollable?3:0);
   if(scrollable){
    assert.deepEqual(interaction.wheelTransitions.map(step=>step.deltaY),[-scrollHeight,scrollHeight,-scrollHeight]);assert.deepEqual(interaction.wheelTransitions.map(step=>step.expected),[0,maxScroll,0]);
    for(const [index,step]of interaction.wheelTransitions.entries()){
     assert.ok(Math.abs(step.after-step.expected)<=1);assert.ok(step.before>=0&&step.before<=maxScroll);if(index)assert.ok(Math.abs(step.before-interaction.wheelTransitions[index-1].after)<=1);
     assert.equal(step.nativeDeltaY,step.deltaY*devicePixelRatio,'Native wheel payload must preserve the requested CSS delta at actual DPR');
     assert.equal(interaction.observedInputs.wheels[index].deltaY,step.deltaY);assert.equal(interaction.observedInputs.wheels[index].trusted,true);
    }
   }
   if(scrollable&&scenario.name==='overview-limit')picture(interaction.bottomScreenshot,'design-qa/map-attribution/'+name+'-license-bottom.png',profile);else assert.equal(interaction.bottomScreenshot,undefined);
  }else assert.equal(item.licenseInteraction,undefined);
  if(scenario.name===(expanded?'overview-limit':'detail')){
   picture(item.screenshot,'design-qa/map-attribution/'+name+'.png',profile);
  }else assert.equal(item.screenshot,undefined);
 }
 assert.equal(cycles,131);assert.equal(pictures,11);
 assert.deepEqual(report.footerCases?.map(item=>item.name),MAP_ATTRIBUTION_LAYOUT_CASES.map(item=>item.name));
 for(const [index,scenario]of MAP_ATTRIBUTION_LAYOUT_CASES.entries()){
  const entry=report.footerCases[index];for(const key of ['name','profile','satellite','expanded','sheetOpen'])assert.deepEqual(entry[key],scenario[key]);
  assertAttributionFooterLayout(entry.loading,scenario,true);assertAttributionFooterLayout(entry.ready,scenario,false);
  assert.deepEqual(footerLoadingGeometry(entry.ready),footerLoadingGeometry(entry.loading),'A loading cycle moved the footer or an adjacent action');
  if(scenario.expanded){
   const interaction=entry.licenseInteraction,hrefs=['https://www.openstreetmap.org/copyright','https://openmaptiles.org/','/sources','/sources#satellite-attribution'];
   assert.equal(interaction?.input,'native-cdp-wheel-and-tab');assert.deepEqual(interaction.before.hrefs,hrefs);assert.deepEqual(interaction.links.map(link=>link.href),hrefs);assert.ok(interaction.links.every(link=>link.focused&&link.visibleUnblocked&&link.text.length>0));
   assert.equal(interaction.scrollable,false);assert.equal(interaction.before.devicePixelRatio,scenario.profile.dpr);assert.equal(interaction.wheelTransitions.length,0);assert.equal(interaction.observedInputs.wheels.length,0);
   assert.equal(interaction.observedInputs.tabs.length,hrefs.length-1);assert.ok(interaction.observedInputs.tabs.every(event=>event.key==='Tab'&&event.trusted));
  }else assert.equal(entry.licenseInteraction,undefined);
  picture(entry.screenshot,'design-qa/map-attribution/footer-'+scenario.name+'.png',scenario.profile);
 }
 assert.equal(pictures,35);return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const report=JSON.parse(readFileSync(join(repoRoot,'web/pages-preview/dist/browser-map-attribution-verification.json'),'utf8'));
 assertMapAttributionReceipt(report,{sourceCommit:process.env.GITHUB_SHA});
 console.log(JSON.stringify({verified:true,sourceCommit:report.sourceCommit,profiles:report.profiles.length,cases:report.cases.length,loadingCycles:131,footerCases:report.footerCases.length,pngs:35}));
}
