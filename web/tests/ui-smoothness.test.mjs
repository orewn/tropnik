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
  assert.match(labels,/let frame=0/);
  assert.match(labels,/requestAnimationFrame\(\(\)=>\{frame=0;schedule\(\);\}\)/);
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
