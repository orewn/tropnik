import test from 'node:test';
import assert from 'node:assert/strict';
import {filterMapTrails, mapDirectionCounts} from '../lib/map-catalog.ts';

const filters = {query: '', difficulty: 'all', duration: 'any', onlySaved: false, savedIds: new Set()};
const catalog = [
  {id: 'lake', title: 'Озёрная тропа', subtitle: 'Лесное кольцо', difficulty: 'easy', duration: '2–3 ч', regionId: 'karelia'},
  {id: 'ridge', title: 'Горный хребет', subtitle: 'К озёрам', difficulty: 'hard', duration: '5 дней', regionId: 'altai'},
  {id: 'coast', title: 'Береговая тропа', subtitle: 'Обзор озера', difficulty: 'unknown', duration: null, regionId: 'baikal'},
  {id: 'forest', title: 'Лесное кольцо', subtitle: 'Прогулка', difficulty: 'easy', duration: '40 мин', regionId: 'karelia'},
];

test('the initial country result includes the complete catalogue, grouped without individual map points', () => {
  const visible = filterMapTrails(catalog, filters);
  assert.deepEqual(visible.map(trail => trail.id), catalog.map(trail => trail.id));
  const counts = mapDirectionCounts(visible);
  assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), catalog.length);
  assert.deepEqual(Object.fromEntries(counts), {karelia: 2, altai: 1, baikal: 1});
});

test('the shared result applies search, difficulty, duration and saved filters together', () => {
  const result = filterMapTrails(catalog, {...filters, query: '  ОЗЕРНАЯ  ', difficulty: 'easy', duration: 'day', onlySaved: true, savedIds: new Set(['lake', 'ridge'])});
  assert.deepEqual(result.map(trail => trail.id), ['lake']);
  assert.equal(result[0], catalog[0], 'map callbacks retain the same route identity as the card');
  assert.deepEqual(Object.fromEntries(mapDirectionCounts(result)), {karelia: 1});
});

test('unknown times and day estimates are not presented as hourly routes', () => {
  assert.deepEqual(filterMapTrails(catalog, {...filters, duration: 'day'}).map(trail => trail.id), ['lake', 'forest']);
  assert.deepEqual(filterMapTrails(catalog, {...filters, onlySaved: true}), [], 'zero saved routes means zero map points');
  assert.deepEqual(filterMapTrails(catalog, {...filters, query: 'такого маршрута нет'}), []);
});

test('shared routes count once within each real direction, even with repeated membership', () => {
  const shared = {id: 'shared', regionId: 'altai', regionIds: ['altai', 'baikal', 'baikal']};
  assert.deepEqual(Object.fromEntries(mapDirectionCounts([shared, shared, {id: 'other', regionId: 'altai'}])), {altai: 2, baikal: 1});
});
