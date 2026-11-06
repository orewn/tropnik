import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
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
  const module = {exports: {}};
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true},
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => load(
    (id.startsWith('@/') ? resolve(web, id.slice(2)) : resolve(dirname(path), id)) + (id.endsWith('.json') ? '' : '.ts'),
  ), module, module.exports);
  cache.set(path, module.exports);
  return module.exports;
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
