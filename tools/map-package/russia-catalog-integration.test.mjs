import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inRussiaCoverage} from '../../web/public/maps/russia-viewport.js';

// Root-project integration only. The standalone web checkout has its own
// byte-identical report fixtures and tests, and does not require data/.
const root = new URL('../../', import.meta.url);
const read = relative => readFileSync(new URL(relative, root));
const json = relative => JSON.parse(read(relative));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const coverage = json('data/boundaries/catalog-mask-coverage.json');
const provenance = json('web/public/data/russia-boundaries-provenance.json');
const catalog = json('data/catalog/routes.geojson');

function* positions(value) {
  if (value.type === 'FeatureCollection') {
    for (const feature of value.features) yield* positions(feature);
  } else if (value.type === 'Feature') yield* positions(value.geometry);
  else if (value.type === 'GeometryCollection') {
    for (const geometry of value.geometries) yield* positions(geometry);
  } else {
    function* visit(coordinates) {
      if (typeof coordinates[0] === 'number') yield coordinates;
      else for (const child of coordinates) yield* visit(child);
    }
    yield* visit(value.coordinates);
  }
}

test('actual full catalogue bytes, root reports and committed web fixtures are bound to one provenance', () => {
  const actualHash = hash(read('data/catalog/routes.geojson'));
  assert.equal(actualHash, coverage.catalogSha256, 'the report must describe the current full catalogue');
  assert.equal(actualHash, provenance.routeDetailPreservation.catalogSha256,
    'runtime boundary detail must protect the same catalogue');
  assert.equal(hash(read('data/boundaries/catalog-mask-coverage.json')), provenance.routeCoverageReport.sha256);
  assert.equal(hash(read('data/boundaries/russia-mask-checks.json')), provenance.validation.sha256);
  assert.deepEqual(read('web/tests/fixtures/russia-route-coverage.json'), read('data/boundaries/catalog-mask-coverage.json'));
  assert.deepEqual(read('web/tests/fixtures/russia-checks.json'), read('data/boundaries/russia-mask-checks.json'));
});

test('the report accounts for every actual route and all 223073 geometry vertices without simplification loss', () => {
  assert.equal(catalog.features.length, 278);
  assert.equal(coverage.routeCount, catalog.features.length);
  const reports = new Map(coverage.routes.map(row => [row.id, row]));
  assert.equal(reports.size, coverage.routes.length, 'report route IDs must be unique');
  assert.deepEqual([...reports.keys()].sort(), catalog.features.map(f => f.properties.id).sort());
  let total = 0;
  for (const feature of catalog.features) {
    const actualCount = [...positions(feature)].length;
    const row = reports.get(feature.properties.id);
    assert.equal(row.vertexCount, actualCount, feature.properties.id);
    assert.equal(row.verticesIncorrectlyRemovedBySimplification, 0, feature.properties.id);
    total += actualCount;
  }
  assert.equal(total, 223073);
  assert.equal(coverage.totalVertices, total);
  assert.equal(coverage.verticesIncorrectlyRemovedBySimplification, 0);
  assert.deepEqual(coverage.routes.filter(row => row.whollyOutsideSelectedDisplaySource).map(row => row.id),
    provenance.excludedCatalogRouteIds);
});

test('the excluded public relation contains the exact 92 source vertices and is wholly outside display coverage', () => {
  const source = [...positions(json('data/catalog/geometry/osm-relation-14407325.geojson'))];
  const shipped = [...positions(json('web/public/data/imported/osm-relation-14407325.geojson'))];
  const area = json('web/public/data/russia-display-area.geojson');
  assert.equal(source.length, 92);
  assert.deepEqual(shipped, source, 'the standalone web geometry must preserve the actual excluded source line');
  assert.ok(shipped.every(([lng, lat]) => !inRussiaCoverage(lng, lat, area)));
  assert.deepEqual(provenance.excludedCatalogRouteIds, ['osm-relation-14407325']);
  const row = coverage.routes.find(item => item.id === 'osm-relation-14407325');
  assert.equal(row.outsideDisplaySource, source.length);
  assert.equal(row.whollyOutsideSelectedDisplaySource, true);
});
