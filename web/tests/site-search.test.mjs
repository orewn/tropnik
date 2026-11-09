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
const {searchSite, searchDocuments} = load(resolve(web, 'lib/site-search.ts'));

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

test('dated legacy closure notices also reach search, while partial access remains distinct', () => {
  const polikarya = trails.find(trail => trail.id === 'osm-relation-13025082');
  assert.equal(polikarya.accessStatus, 'closed');
  assert.ok(polikarya.operatingNotice.url.startsWith('https://krasnayapolyanaresort.ru/'));
  assert.equal(searchSite('Поликаря').results.find(hit => hit.id === polikarya.id)?.accessStatus, 'closed');
  assert.equal(trails.find(trail => trail.id === 'kavkaz-8a').accessStatus, 'restricted');
  assert.equal(trails.find(trail => trail.id === 'osm-relation-14397487').accessStatus, 'restricted', 'closed tower does not assert closure of its entire approach');
  assert.equal(trails.find(trail => trail.id === 'osm-relation-14376203').accessStatus, undefined, 'no inferred open or closed status for an unconfirmed future visit');
});
