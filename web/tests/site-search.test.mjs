import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Exercise the real merged catalogue, including its JSON imports. This loader
// only evaluates checked-in application modules inside web/, never input data.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(web, 'package.json'));
const ts = require('typescript');
const cache = new Map();
function load(path) {
  assert.ok(path.startsWith(web + sep), 'test module must stay inside web/');
  if (cache.has(path)) return cache.get(path);
  if (path.endsWith('.json')) return JSON.parse(readFileSync(path, 'utf8'));
  const loadedModule = {exports: {}};
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true},
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => load(
    (id.startsWith('@/') ? resolve(web, id.slice(2)) : resolve(dirname(path), id)) + (id.endsWith('.json') ? '' : '.ts'),
  ), loadedModule, loadedModule.exports);
  cache.set(path, loadedModule.exports);
  return loadedModule.exports;
}
const {trails, regions} = load(resolve(web, 'lib/content.ts'));
const {searchSite, searchDocuments, createRouteSearch} = load(resolve(web, 'lib/site-search.ts'));
const {publishedTrail} = load(resolve(web, 'lib/route-adapter.ts'));

test('every published route and region is represented exactly once in the live index', () => {
  for (const [kind, records] of [['route', trails], ['region', regions]]) {
    const indexed = searchDocuments.filter(doc => doc.kind === kind);
    assert.equal(indexed.length, records.length);
    assert.deepEqual(new Set(indexed.map(doc => doc.id)), new Set(records.map(record => record.id)));
    assert.equal(searchSite('', {kind}).total, records.length);
  }
  assert.ok(!searchDocuments.some(doc => /moderation|account\/action|qa-mobile/.test(doc.href)));
  assert.ok(searchSite('конфиденциальность').results.some(doc => doc.href === '/privacy'));
});

test('every public app section is searchable, including the safety passport and MChS preparation', () => {
  const excluded = new Set(['/moderation', '/account/action', '/qa-mobile']);
  function publicPages(directory, prefix = '') {
    return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
      if (entry.isDirectory() && entry.name !== 'api' && !entry.name.includes('[')) {
        return publicPages(resolve(directory, entry.name), `${prefix}/${entry.name}`);
      }
      return entry.isFile() && entry.name === 'page.tsx' && !excluded.has(prefix)
        ? [prefix || '/'] : [];
    });
  }
  const indexedPages = searchDocuments.filter(doc => doc.kind === 'page');
  const expectedPages = publicPages(resolve(web, 'app'));
  assert.equal(indexedPages.length, expectedPages.length, 'public sections must be indexed exactly once');
  assert.deepEqual(new Set(indexedPages.map(doc => doc.href)), new Set(expectedPages));
  for (const query of ['МЧС', 'паспорт безопасности', 'регистрация похода', 'аварийная карточка', '112']) {
    assert.ok(searchSite(query, {kind: 'page'}).results.some(hit => hit.href === '/safety/registration'), `missing safety result for: ${query}`);
  }
});

test('reviewed source-only cards are discoverable and do not acquire invented map geometry', () => {
  const reviewed = trails.filter(trail => !trail.geometry && !trail.geometryUrl);
  assert.ok(reviewed.length >= 29);
  for (const trail of reviewed) {
    const hit = searchSite(trail.title, {kind: 'route'}).results.find(doc => doc.id === trail.id);
    assert.ok(hit, `missing search result: ${trail.id}`);
    assert.equal(hit.missingGeometry, true);
    assert.equal(trail.center, undefined);
    assert.equal(trail.bbox, undefined);
    assert.ok(trail.sourceUrl.startsWith('https://'));
    assert.ok(trail.territoryIds?.length);
  }
});

test('actual Russian names, typing mistakes and constrained results retain source limitations', () => {
  assert.ok(searchSite('Бзепринский').results.some(hit => /Бзерпинский/.test(hit.title)));
  assert.ok(searchSite(',fqrfk').results.some(hit => hit.regionId === 'baikal'));
  assert.ok(searchSite('Верхнее Мультинское').results.some(hit => /Мультинские/.test(hit.title)));
  assert.ok(searchSite('Териберка').results.some(hit => hit.id === 'teriberka-batareysky-waterfall'));
  const closed = trails.filter(trail => trail.accessStatus === 'closed');
  assert.ok(closed.length);
  for (const trail of closed) {
    assert.equal(searchSite(trail.title, {kind: 'route'}).results.find(hit => hit.id === trail.id)?.accessStatus, 'closed');
  }
  const constrained = searchSite('Байкал до 15 км');
  assert.ok(constrained.total);
  assert.equal(constrained.results[0].unspecifiedParameters, undefined, 'known matching parameters precede incomplete cards');
  for (const hit of constrained.results) {
    assert.equal(hit.kind, 'route');
    if (hit.distanceKm == null) assert.equal(hit.unspecifiedParameters, true);
    else assert.ok(hit.distanceKm <= 15);
  }
});

test('search preserves one-way distance notes and never invents distances for source-only cards', () => {
  const oneWay = trails.filter(trail => trail.distanceNote);
  assert.ok(oneWay.length);
  for (const trail of oneWay) {
    const hit = searchSite(trail.title, {kind: 'route'}).results.find(doc => doc.id === trail.id);
    assert.equal(hit?.distanceNote, trail.distanceNote);
    assert.equal(hit?.distanceKm, trail.distanceKm);
  }
  for (const trail of trails.filter(trail => trail.distanceKm == null)) {
    const hit = searchSite(trail.title, {kind: 'route'}).results.find(doc => doc.id === trail.id);
    assert.equal(hit?.distanceKm, null);
  }
});

test('dated legacy closure notices also reach search, while partial access remains distinct', () => {
  const polikarya = trails.find(trail => trail.id === 'osm-relation-13025082');
  assert.equal(polikarya.accessStatus, 'closed');
  assert.ok(polikarya.operatingNotice.url.startsWith('https://krasnayapolyanaresort.ru/'));
  assert.equal(searchSite('Поликаря').results.find(hit => hit.id === polikarya.id)?.accessStatus, 'closed');
  assert.equal(trails.find(trail => trail.id === 'kavkaz-8a').accessStatus, 'restricted');
  assert.equal(trails.find(trail => trail.id === 'osm-relation-14397487').accessStatus, 'restricted', 'closed tower does not assert closure of its entire approach');
  assert.equal(trails.find(trail => trail.id === 'osm-relation-14376203').accessStatus, undefined, 'no inferred open or closed status for an unconfirmed future visit');
});


test('the map search includes live routes added after the reference catalogue was built', () => {
  const live = {
    ...trails[0], id: 'live-search-fixture', title: 'Сапфировая поляна',
    subtitle: 'Тестовая опубликованная карточка', description: 'Тестовое описание',
    regionId: 'baikal', regionIds: ['baikal'], publicationStatus: 'published',
    sourceTitle: '', sourceName: '', season: '', notes: [], operatingNotice: undefined, officialEvidence: undefined,
    distanceKm: 7.5, duration: '3 ч',
  };
  const catalog = [live, ...trails];
  const searchRoutes = createRouteSearch(catalog);
  assert.equal(searchRoutes('').total, catalog.length);
  assert.deepEqual(searchRoutes('Сапфировая поляна').results.map(hit => hit.id), [live.id]);
  assert.deepEqual(searchRoutes('Сапфировая поляна до 8 км').results.map(hit => hit.id), [live.id]);
  assert.equal(searchRoutes('Сапфировая поляна до 6 км').total, 0);
  assert.equal(searchSite('Сапфировая поляна').results.some(hit => hit.id === live.id), false, 'the page-wide reference index remains isolated');
});

test('a catalogue revision replaces searchable names and distance limits for an existing route ID', () => {
  const original = {
    ...trails[0], title: 'Сапфировая поляна', subtitle: '', description: '',
    sourceTitle: '', sourceName: '', season: '', notes: [], operatingNotice: undefined, officialEvidence: undefined,
    distanceKm: 19, duration: '6 ч',
  };
  const updated = {...original, title: 'Янтарный причал', distanceKm: 7.5, duration: '2 ч', publicationStatus: 'published'};
  const before = createRouteSearch([original]);
  const after = createRouteSearch([updated, ...trails.filter(trail => trail.id !== updated.id)]);
  assert.equal(before('Сапфировая поляна').results[0]?.id, original.id);
  assert.equal(after('Сапфировая поляна').results.some(hit => hit.id === original.id), false, 'old text must not match a replaced card');
  assert.equal(after('').total, trails.length, 'replacement keeps one searchable record per ID');
  const hit = after('Янтарный причал до 8 км до 3 ч').results.find(item => item.id === updated.id);
  assert.ok(hit, 'both text and numeric constraints use the updated record');
  assert.equal(hit.title, updated.title);
  assert.equal(hit.distanceKm, 7.5);
  assert.equal(hit.duration, '2 ч');
  assert.equal(after('Янтарный причал до 7 км').results.some(item => item.id === updated.id), false);
});


test('a server-closed route retains its closure through the adapter and catalogue search', () => {
  const route = {
    id: 'server-closed-fixture', slug: 'server-closed-fixture', regionId: 'krasnodar',
    title: 'Сапфировая долина', description: 'Тестовая карточка оператора', difficulty: 'easy', activity: 'hiking',
    distanceKm: 7.5, ascentM: 240, durationMin: 180, minPeople: 4, maxGroupSize: 8, requiredGuides: 1,
    status: 'closed', revisionId: 'revision-fixture', revision: 3, verifiedAt: '2026-11-08T10:00:00Z',
    source: {name: 'Источник оператора', url: 'https://example.test/routes/server-closed-fixture', license: 'Test fixture', retrievedAt: '2026-11-08T09:00:00Z'},
    geometry: {type: 'LineString', coordinates: [[40, 45], [40.01, 45.01]]}, geometryDetail: 'full',
    season: 'Лето', updatedAt: '2026-11-10T09:30:00Z',
  };
  const closed = publishedTrail(route);
  assert.equal(closed.accessStatus, 'closed', 'Explore and TrailCard use this field for closure eligibility and labels');
  assert.deepEqual(closed.operatingNotice, {
    title: 'Маршрут закрыт', body: 'Новые выходы и старт групп недоступны до изменения статуса оператором.',
    url: route.source.url, effectiveAt: '2026-11-10',
  }, 'operator notice, evidence link and closure date remain intact');
  const closedHit = createRouteSearch([closed])(route.title).results[0];
  assert.equal(closedHit?.id, route.id);
  assert.equal(closedHit.accessStatus, 'closed');
  const published = publishedTrail({...route, status: 'published'});
  assert.equal(published.accessStatus, undefined, 'publication does not invent confirmed open access');
  assert.equal(published.operatingNotice, undefined);
  assert.equal(createRouteSearch([published])(route.title).results[0].accessStatus, undefined);
});

test('a route belonging directly to an administrative territory is searchable by its real region name',()=>{
 const {territories}=load(resolve(web,'lib/territories.ts'));
 const territory=territories.find(region=>region.shapeNames.includes('Moscow'));
 assert.ok(territory);
 const record={...trails[0],id:'territory-search-fixture',title:'Янтарный причал',regionId:territory.id,regionIds:[],territoryIds:[territory.id],sourceTitle:'',sourceName:'',subtitle:'',description:'',season:'',notes:[],operatingNotice:undefined,officialEvidence:undefined};
 const search=createRouteSearch([record]);
 assert.equal(search(territory.name).results[0]?.id,record.id);
 assert.equal(search(record.title).results[0]?.regionName,territory.name);
 assert.equal(search(record.title).results[0]?.regionId,territory.id,'keep the exact territory ID, including uppercase source digits');
});
