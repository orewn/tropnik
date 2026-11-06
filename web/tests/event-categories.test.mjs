import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveRouteCategories, eventCategoryById} from '../lib/event-categories.ts';

test('no source means no inferred route theme', () => {
  assert.deepEqual(deriveRouteCategories(null), []);
  assert.deepEqual(deriveRouteCategories({title: '   '}), []);
});
test('landscape categories keep title priority and a bounded number of labels', () => {
  const themes = deriveRouteCategories({title: 'Кальдера вулкана Головнина', description: 'Дорога через лес к озеру; рядом берег моря и водопад.'});
  assert.equal(themes[0], 'volcano');
  assert.equal(themes.length, 3);
  assert.equal(new Set(themes).size, themes.length);
  assert.ok(themes.every(theme => eventCategoryById[theme]));
});
test('distant summit views and a nearby pass do not promise an ascent', () => {
  const themes = deriveRouteCategories({title: 'Экотропа', description: 'С площадки видны вершины и перевал.'});
  assert.ok(!themes.includes('summit'));
  assert.ok(!themes.includes('pass'));
});
test('restricted overnight stays and incidental training do not create event categories', () => {
  const themes = deriveRouteCategories({title: 'Прогулка по роще', description: 'Палаточные стоянки запрещены. Встреча с гидом; опыт обучения не требуется.'});
  assert.ok(!themes.includes('camp'));
  assert.ok(!themes.includes('meetup'));
  assert.ok(!themes.includes('training'));
});
test('operational and difficulty fields are irrelevant to landscape themes', () => {
  const source = {title: 'К озеру', description: 'Тропа у воды.'};
  assert.deepEqual(deriveRouteCategories({...source, difficulty: 'easy', accessStatus: 'closed', notes: ['ночевка у вулкана']}), deriveRouteCategories(source));
});
test('Russian inflections and ё are recognised without matching an unrelated word', () => {
  assert.ok(deriveRouteCategories({title: 'Мультинские озёра'}).includes('lake'));
  assert.ok(deriveRouteCategories({title: 'К мысу Тобизина'}).includes('coast'));
  assert.ok(!deriveRouteCategories({title: 'Пеший маршрут', description: 'Смысл прогулки — познакомиться с природой.'}).includes('coast'));
});
