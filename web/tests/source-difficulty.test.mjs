import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sourceDifficultyLabel} from '../lib/source-difficulty.ts';

test('known source grades get their own scale without guessing an unrelated grade', () => {
  assert.deepEqual(sourceDifficultyLabel('hiking', 'database'), {label:'T1 · пешеходная тропа', sac:true});
  assert.deepEqual(sourceDifficultyLabel('difficult_alpine_hiking', 'database'), {label:'T6 · особо сложный альпийский маршрут', sac:true});
  const current = 'Перевал: 1А летом, 1Б зимой';
  assert.deepEqual(sourceDifficultyLabel(current), {label:current, sac:false});
  for (const value of ['off-road', 'moderate', 'future_grade', '__proto__', 'constructor', 'Русская пометка with unknown grade']) {
    const result = sourceDifficultyLabel(value, 'database');
    assert.equal(result.sac, false);
    assert.match(result.label, /уточнить по первоисточнику/);
    assert.ok(!result.label.includes(value));
  }
  for (const kind of ['official', 'published', 'community', undefined]) {
    const result = sourceDifficultyLabel('hiking', kind);
    assert.equal(result.sac, false, 'a source word does not establish the SAC scale outside the original database boundary');
    assert.match(result.label, /уточнить по первоисточнику/);
  }
});

test('all current imported source grades retain reviewed guidance', () => {
  let checked = 0;
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'sourceTechnicalDifficulty' && typeof child === 'string') {
        checked++;
        assert.ok(!sourceDifficultyLabel(child, value.sourceKind).label.includes('уточнить по первоисточнику'), 'missing reviewed grade: ' + child);
      } else visit(child);
    }
  }
  for (const file of ['catalog', 'discovery-routes', 'yandex-routes', 'russiadiscovery-east', 'national-editorial', 'telegram-reviewed', 'editorial-geometry']) {
    visit(JSON.parse(readFileSync(new URL('../lib/' + file + '.generated.json', import.meta.url), 'utf8')));
  }
  assert.ok(checked > 0);
});
