import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('map hints stay on map surfaces and article pages avoid map startup work',async()=>{
 const [layout,explore,hints]=await Promise.all([read('app/layout.tsx'),read('components/Explore.tsx'),read('components/MapResourceHints.tsx')]);
 assert.doesNotMatch(layout,/tiles\.openfreemap|russia-display-area\.geojson|tropa-style\.json/);
 assert.match(explore,/MapResourceHints/);
 assert.match(hints,/rel="preconnect"/);
 assert.match(hints,/russia-display-area\.geojson/);
 assert.match(hints,/tropa-style\.json/);
});

test('service worker registers after load and warms maps only during idle map sessions',async()=>{
 const [client,worker]=await Promise.all([read('components/ServiceWorker.tsx'),read('public/sw.js')]);
 assert.match(client,/requestIdleCallback/);
 assert.match(client,/addEventListener\('load'/);
 assert.match(client,/querySelector\('\.explore-layout'\)/);
 assert.match(client,/saveData/);
 assert.match(client,/type: 'warm-map'/);
 assert.match(worker,/tropnik-shell-v18/);
 assert.match(worker,/addEventListener\('message'/);
 assert.match(worker,/warmMapCache/);
 const install=worker.match(/addEventListener\('install'[\s\S]*?addEventListener\('activate'/)?.[0]||'';
 assert.doesNotMatch(install,/cacheOverview/);
});

test('safety registration loads the heavy route catalogue only on demand',async()=>{
 const source=await read('components/SafetyRegistration.tsx');
 assert.doesNotMatch(source,/import \{regions, trails\} from '@\/lib\/content'/);
 assert.match(source,/import\('@\/lib\/content'\)/);
 assert.match(source,/Выбрать маршрут из каталога/);
 assert.match(source,/catalogState/);
 assert.match(source,/datalist id="safety-regions"/);
});

test('final visual layer owns touch, viewport and reduced-motion guardrails',async()=>{
 const [layout,css,pkg]=await Promise.all([read('app/layout.tsx'),read('app/final-polish.css'),read('package.json')]);
 assert.ok(layout.indexOf('final-polish.css')>layout.indexOf('map-ui-release.css'));
 assert.match(css,/touch-action:manipulation/);
 assert.match(css,/content-visibility:auto/);
 assert.match(css,/safe-area-inset/);
 assert.match(css,/prefers-reduced-motion/);
 assert.equal(JSON.parse(pkg).version,'0.4.11');
});
