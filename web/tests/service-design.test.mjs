import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('home page uses the unified editorial service component',async()=>{
  const [page,component,css]=await Promise.all([read('app/page.tsx'),read('components/HomeEditorial.tsx'),read('components/HomeEditorial.module.css')]);
  assert.match(page,/HomeEditorial/);
  assert.doesNotMatch(page,/steps-editorial|region-links/);
  assert.equal((component.match(/className=\{styles\.serviceCard\}/g)||[]).length,1,'service cards must render from one bounded data model');
  assert.match(component,/const serviceCards = \[/);
  assert.match(component,/const steps = \[/);
  assert.match(component,/Проверяемая карта/);
  assert.match(component,/Работа без сети/);
  assert.match(component,/Паспорт похода/);
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:620px\)/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/env\(safe-area-inset-left\)/);
});

test('header has one calm desktop navigation surface and a bounded mobile menu',async()=>{
  const css=await read('components/Header.module.css');
  assert.match(css,/position:sticky!important/);
  assert.match(css,/backdrop-filter:blur\(18px\)/);
  assert.match(css,/top-nav a\.active\).*background:#fffef9/);
  assert.match(css,/height:calc\(100dvh - 68px\)/);
  assert.match(css,/safe-area-inset-bottom/);
  assert.match(css,/forced-colors:active/);
  assert.doesNotMatch(css,/animation:[^;]*infinite/);
});

test('footer groups product, preparation and legal routes without external dependencies',async()=>{
  const [component,css]=await Promise.all([read('components/Footer.tsx'),read('components/Footer.module.css')]);
  for(const label of ['Исследовать','Подготовиться','О сервисе'])assert.match(component,new RegExp(label));
  assert.match(component,/Источники и ограничения видны/);
  assert.match(component,/Ключевые данные доступны без сети/);
  assert.doesNotMatch(component,/target="_blank"|https?:\/\//);
  assert.match(css,/grid-template-columns:minmax\(270px,1\.35fr\)/);
  assert.match(css,/@media\(max-width:620px\)/);
  assert.match(css,/safe-area-inset-bottom/);
});

test('final service layer keeps premium states separate from map geometry',async()=>{
  const css=await read('app/final-polish.css');
  assert.match(css,/--shadow-md:/);
  assert.match(css,/--ease-service:/);
  assert.match(css,/prefers-contrast|forced-colors/);
  assert.match(css,/touch-action:manipulation/);
  assert.doesNotMatch(css,/region-marker|trail-marker|map-anchor|map-label/,'generic service polish must not alter geographic anchors');
});
