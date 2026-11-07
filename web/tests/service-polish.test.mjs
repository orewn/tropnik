import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('route discovery stays responsive and browser history restores map state',async()=>{
  const [explore,browser,card]=await Promise.all([read('components/Explore.tsx'),read('components/TerritoryBrowser.tsx'),read('components/TrailCard.tsx')]);
  assert.match(explore,/useDeferredValue/);
  assert.match(explore,/const liveIds=new Set/);
  assert.match(explore,/const savedIds=useMemo/);
  assert.match(explore,/addEventListener\('popstate'/);
  assert.match(explore,/pushState':'replaceState/);
  assert.match(explore,/aria-busy=\{searchPending\}/);
  assert.match(browser,/const routeCounts = useMemo/);
  assert.doesNotMatch(browser,/catalog\.filter\(trail => trailBelongsToRegion/);
  assert.doesNotMatch(browser,/onTouchStart=\{warm\}/);
  assert.match(card,/pointer:coarse/);
  assert.doesNotMatch(card,/onTouchStart=\{warm\}/);
});

test('mobile navigation is focus managed and cannot scroll behind the menu',async()=>{
  const [header,css]=await Promise.all([read('components/Header.tsx'),read('components/Header.module.css')]);
  assert.match(header,/navigation\.current\?\.querySelector/);
  assert.match(header,/document\.addEventListener\('pointerdown'/);
  assert.match(header,/document\.body\.style\.overflow = 'hidden'/);
  assert.match(header,/menuButton\.current\?\.focus/);
  assert.match(css,/overscroll-behavior:contain/);
  assert.match(css,/safe-area-inset-bottom/);
});

test('story speculation respects idle time and constrained connections',async()=>{
  const stories=await read('components/PlaceStories.tsx');
  assert.match(stories,/requestIdleCallback/);
  assert.match(stories,/saveData/);
  assert.match(stories,/className="fact-photo-image"/);
  assert.match(stories,/<img\b/);
  assert.match(stories,/image\.decoding='async'/);
  assert.doesNotMatch(stories,/role="img"/);
});

test('safety drafts expose unsaved state and warn only while dirty',async()=>{
  const [component,css]=await Promise.all([read('components/SafetyRegistration.tsx'),read('components/SafetyRegistration.module.css')]);
  assert.match(component,/safetyPassportSnapshot/);
  assert.match(component,/addEventListener\('beforeunload'/);
  assert.match(component,/if \(!dirty\) return/);
  assert.match(component,/Есть несохранённые изменения/);
  assert.match(component,/disabled=\{!dirty\}/);
  assert.match(css,/\.saveState\.unsaved/);
});

test('service worker update is visible and user controlled',async()=>{
  const [client,worker,css,pkg]=await Promise.all([read('components/ServiceWorker.tsx'),read('public/sw.js'),read('app/final-polish.css'),read('package.json')]);
  assert.match(client,/registration\.waiting/);
  assert.match(client,/controllerchange/);
  assert.match(client,/skip-waiting/);
  assert.match(worker,/tropnik-shell-v19/);
  assert.match(worker,/self\.skipWaiting/);
  assert.match(css,/\.app-update/);
  assert.match(css,/forced-colors:active/);
  assert.equal(JSON.parse(pkg).version,'0.4.12');
});
