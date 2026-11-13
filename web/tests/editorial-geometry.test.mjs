import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readCatalogueInputs} from '../scripts/build-trail-connections.mjs';
import {nativeGeometryProvenance} from '../../tools/android-build/catalog-provenance.mjs';
import {trailGeometryDescription} from '../lib/trail-evidence.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const review = JSON.parse(await readFile(new URL('../../data/catalog/editorial-geometry-review.json', import.meta.url), 'utf8'));

test('pinned editorial sources conserve geometry and reject unsupported review states', () => {
  const result = spawnSync('python3', ['web/tests/editorial_geometry_test.py'], {cwd: root, encoding: 'utf8', timeout: 30000});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the shared catalogue exposes every reviewed track without changing route identity or access', async () => {
  const {trails} = await readCatalogueInputs();
  const byId = new Map(trails.map(trail => [trail.id, trail]));
  const originals = new Map();
  for (const filename of ['national-editorial', 'yandex-routes', 'discovery-routes', 'russiadiscovery-east']) {
    const source = JSON.parse(await readFile(new URL(`../lib/${filename}.generated.json`, import.meta.url), 'utf8'));
    for (const route of source.routes) originals.set(route.id, route);
  }
  for (const item of review.accepted) {
    const trail = byId.get(item.id), original = originals.get(item.id);
    assert.ok(trail.geometryUrl, item.id);
    assert.equal(trail.title, original.title);
    assert.equal(trail.publicationStatus, 'reference');
    assert.equal(trail.checkedAt, original.checkedAt);
    assert.equal(trail.distanceKm, original.distanceKm);
    assert.equal(trail.accessStatus, original.accessStatus);
    assert.deepEqual(trail.operatingNotice, original.operatingNotice);
    assert.ok(trail.center.every(Number.isFinite));
    assert.ok(!trail.notes.some(note => /геометрия.*(?:пока не добавлена|в каталог не добавлена)/i.test(note)));
    const provenance = nativeGeometryProvenance(trail, true);
    if (item.kind === 'existing_catalogue') {
      assert.equal(trail.geometryUrl, byId.get(item.sourceRouteId).geometryUrl);
      assert.equal(provenance.geometrySourceLicense, 'ODbL-1.0');
      assert.match(provenance.sourceLicense, /OpenStreetMap/);
    } else {
      assert.equal(trail.geometrySourceUrl, item.sourceUrl);
      assert.equal(provenance.geometrySourceLicense, item.license);
      assert.equal(provenance.geometrySourceName, item.sourceName);
      assert.doesNotMatch(provenance.sourceLicense, /OpenStreetMap|ODbL/);
      assert.match(trailGeometryDescription(trail), /опубликована организацией/);
    }
  }
  for (const item of review.unresolved) {
    const trail = byId.get(item.id);
    assert.equal(trail.geometryUrl, undefined, item.id);
    assert.equal(trail.center, undefined, item.id);
    assert.ok(item.sourceReview && item.reason && item.reasonCode);
  }
});

test('native official geometry never acquires an invented open license', () => {
  for (const license of [undefined, 'not-stated']) {
    const result = nativeGeometryProvenance({sourceName: 'Парк', geometrySourceKind: 'official', geometrySourceLicense: license}, true);
    assert.match(result.sourceLicense, /Открытая лицензия источником не указана/);
    assert.doesNotMatch(result.sourceLicense, /OpenStreetMap|ODbL/);
  }
  const absent = nativeGeometryProvenance({sourceName: 'Парк', geometrySourceKind: 'official'}, false);
  assert.equal(absent.geometrySourceKind, null);
  assert.match(absent.sourceLicense, /Линия маршрута пока не добавлена/);
});
