import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {terrainExaggerationForZoom,terrainPitchForZoom} from '../lib/map-camera-profile.ts';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('terrain camera stays restrained over Russia and gains depth on approach',()=>{
  assert.equal(terrainPitchForZoom(1.5,false),14);
  assert.ok(terrainPitchForZoom(4,false)<terrainPitchForZoom(8,true));
  assert.ok(terrainPitchForZoom(14,true)<=50);
  assert.ok(terrainExaggerationForZoom(2)<terrainExaggerationForZoom(12));
});

test('map attribution follows the five-second interactive-map safe harbour',()=>{
  const source=read('components/MapAttribution.tsx');
  assert.match(source,/© OpenStreetMap contributors/);
  assert.match(source,/setTimeout\(collapse,5000\)/);
  assert.match(source,/tropnik-map-attribution-seen/);
  assert.match(source,/Данные карты и лицензии/);
  assert.doesNotMatch(source,/Natural Earth/);
});

test('final palette and camera profile are wired into the atlas',()=>{
  const layout=read('app/layout.tsx');
  const css=read('app/map-polish.css');
  const atlas=read('components/Atlas.tsx');
  const style=read('scripts/create-map-style.mjs');
  assert.ok(layout.indexOf('map-polish.css')>layout.indexOf('event-categories.css'));
  for(const token of ['#F5F3EB','#FFFEFA','#244D3C','#1D3026','#59685D','#D5DCCE','#A56736'])assert.match(css,new RegExp(token,'i'));
  assert.match(atlas,/terrainPitchForZoom/);
  assert.match(atlas,/terrainExaggerationForZoom/);
  assert.doesNotMatch(atlas,/map\.easeTo\(\{pitch:55/);
  assert.match(style,/minzoom:2/);
  assert.match(style,/raster-contrast/);
});
