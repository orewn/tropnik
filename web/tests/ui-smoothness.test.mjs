import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('mobile sheet uses compositor transforms instead of resizing the map every frame',()=>{
  const explore=read('components/Explore.tsx');
  const css=read('app/map-ui-release.css');
  const framing=read('lib/map-framing.ts');
  assert.match(explore,/sheet-open.*sheet-closed/);
  assert.match(explore,/aria-controls=\{sheetPanelId\}/);
  assert.match(css,/--sheet-peek:156px/);
  assert.match(css,/transition:transform \.28s/);
  assert.match(css,/translate3d\(0,calc\(100% - var\(--sheet-peek\)\),0\)/);
  assert.doesNotMatch(css,/Tropnik 0\.4\.8[\s\S]*transition:height/);
  assert.match(framing,/property==='transform'/);
});

test('camera movement does not run full DOM collision layout on every frame',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const labels=read('lib/map-direction-layout.ts');
  assert.doesNotMatch(atlas,/map\.on\('move',scheduleDirectionLayout\)/);
  assert.doesNotMatch(canvas,/map\.on\('move',scheduleDirectionLayout\)/);
  assert.doesNotMatch(canvas,/map\.on\('zoom',scheduleDirectionLayout\)/);
  assert.match(atlas,/map\.on\('movestart'/);
  assert.match(canvas,/map\.on\('movestart'/);
  assert.match(labels,/requestAnimationFrame/);
  assert.match(labels,/if\(!disposed\)schedule\(\)/);
  assert.match(labels,/cancelAnimationFrame/);
  assert.doesNotMatch(labels,/root\.addEventListener\('pointerover'/);
});

test('mobile paint work is bounded and progress animation stays compositor-only',()=>{
  const css=read('app/map-ui-release.css');
  assert.match(css,/@keyframes fact-progress-smooth[\s\S]*transform:scaleX\(1\)/);
  assert.match(css,/backdrop-filter:none!important/);
  assert.match(css,/content-visibility:auto/);
  assert.match(css,/contain:layout paint style/);
  assert.match(css,/sheet-handle[\s\S]*min-height:44px/);
});

test('collapsed mobile sheet has a dedicated stable preview and public browser proof',()=>{
  const explore=read('components/Explore.tsx');
  const css=read('app/map-ui-release.css');
  const pages=read('../.github/workflows/pages.yml');
  const deployed=read('../tools/pages-preview/verify-deployed.mjs');
  const browser=read('../tools/pages-preview/browser-smoke.mjs');
  assert.match(explore,/className="sheet-peek-summary"/);
  assert.match(explore,/hidden=\{sheetOpen\}/);
  assert.match(explore,/routeCountPreview/);
  assert.match(css,/sheet-peek-summary[\s\S]*height:112px/);
  assert.match(css,/sheet-closed \.explore-panel-content[\s\S]*visibility:hidden!important/);
  assert.match(pages,/Verify real mobile rendering and sheet interaction/);
  assert.match(browser,/touchSheet/);
  assert.match(browser,/sheetHeightDelta/);
  assert.match(deployed,/browser-verification\.json/);
  assert.match(deployed,/browserRenderingTested: true/);
});


test('synthetic touch hover paint is cleared without removing keyboard focus',()=>{
  const css=read('app/map-ui-release.css');
  const stories=read('components/PlaceStories.tsx');
  assert.match(css,/Touch browsers may retain synthetic :hover after tap/);
  assert.match(css,/@media\(hover:none\),\(pointer:coarse\)[\s\S]*\.fact-controls button:hover[\s\S]*background:transparent!important/);
  assert.match(css,/focus:not\(:focus-visible\)/);
  assert.match(stories,/releaseTouchFocus/);
  assert.match(stories,/requestAnimationFrame\(\(\)=>button\.blur\(\)\)/);
});


test('compact landscape keeps every map control at 44px',()=>{
  const css=read('app/map-ui-release.css');
  assert.match(css,/Compact landscape keeps 44px touch targets/);
  assert.match(css,/@media\(max-height:620px\) and \(orientation:landscape\) and \(max-width:900px\)[\s\S]*map-style-switch button[\s\S]*map-controls button[\s\S]*height:44px!important[\s\S]*min-height:44px!important/);
});


test('mobile touch profiles avoid the heavy WebGL startup path',()=>{
  const preload=read('lib/map-preload.ts');
  const atlas=read('components/Atlas.tsx');
  const browser=read('../tools/pages-preview/browser-smoke.mjs');
  assert.match(preload,/export function preferCanvasMap/);
  assert.match(preload,/window\.innerWidth<=900/);
  assert.match(preload,/supportsMapWebGL\(\)&&!preferCanvasMap\(\)/);
  assert.match(atlas,/preferCanvasMap\(\)\|\|!supportsMapWebGL\(\)/);
  assert.match(browser,/assert\.equal\(geometry\.engine,profile\.engine/);
  assert.equal((browser.match(/mobile:true,engine:'leaflet'/g)||[]).length,4);
  assert.match(browser,/mobile:false,engine:'maplibre'/);
});


test('touch landscape receives the mobile sheet preview above 700px',()=>{
  const css=read('app/map-ui-release.css');
  assert.match(css,/Touch landscape uses the same compositor sheet above 700px/);
  assert.match(css,/@media\(min-width:701px\) and \(max-width:900px\) and \(max-height:620px\) and \(orientation:landscape\) and \(pointer:coarse\)/);
  assert.match(css,/sheet-peek-summary[\s\S]*height:68px[\s\S]*min-height:68px/);
  assert.match(css,/sheet-closed \.explore-panel[\s\S]*translate3d\(0,calc\(100% - var\(--sheet-peek\)\),0\)/);
});
