import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCatalogueRegions} from './catalog-regions.mjs';

const curated = [{id: 'baikal', name: 'Байкал', center: [108, 53], zoom: 6}];
const east = 'territory-28173009B123', west = 'territory-28173009B456';
const territories = [
  {id: east, name: 'Бурятия', center: [108, 53], geometryUrls: ['/data/imported/shared.geojson']},
  {id: west, name: 'Иркутская область', center: [104, 53], geometryUrls: ['/data/imported/shared.geojson']},
  {id: 'territory-28173009B789', name: 'Без маршрутов', center: [120, 60], geometryUrls: []},
];

test('keeps original direction and exact cross-territory geometry memberships without duplicate routes', () => {
  const trail = {id: 'shared', regionId: 'baikal', regionIds: ['baikal'], territoryIds: [east], geometryUrl: '/data/imported/shared.geojson'};
  const result = nativeCatalogueRegions(curated, territories, [trail]);
  assert.deepEqual(result.memberships.get('shared'), ['baikal', east, west]);
  assert.deepEqual(result.regions.map(region => [region.id, region.territory]), [['baikal', false], [east, true], [west, true]]);
  assert.deepEqual(trail.territoryIds, [east]);
});

test('makes territory-only and geometry-free source cards reachable without inferring coordinates', () => {
  const result = nativeCatalogueRegions(curated, territories, [{id: 'description', regionId: west, territoryIds: [west]}]);
  assert.deepEqual(result.memberships.get('description'), [west]);
  assert.equal(result.regions.at(-1).id, west);
  assert.equal(result.regions.some(region => region.id === east), false);
});

test('rejects mismatched source identifiers, case changes and unsafe filesystem identities', () => {
  for (const regionId of [west.toLowerCase(), 'missing', '../outside']) {
    assert.throws(() => nativeCatalogueRegions(curated, territories, [{id: 'route', regionId}]), /Unknown region/);
  }
  assert.throws(() => nativeCatalogueRegions(curated, territories, [{id: 'route', regionId: 'baikal', territoryIds: ['missing']}]), /Unknown territory/);
  assert.throws(() => nativeCatalogueRegions([{...curated[0], id: '../escape'}], territories, []), /Invalid catalogue region/);
});

test('rejects duplicate source identities and a primary region absent from membership', () => {
  const trail = {id: 'route', regionId: 'baikal'};
  assert.throws(() => nativeCatalogueRegions(curated, territories, [trail, trail]), /Duplicate route/);
  assert.throws(() => nativeCatalogueRegions(curated, [...territories, territories[0]], [trail]), /Invalid catalogue region/);
  assert.throws(() => nativeCatalogueRegions(curated, territories, [{...trail, regionIds: [east]}]), /Unknown region/);
});
