import test from 'node:test';
import assert from 'node:assert/strict';
import {territoryForMapPoint,territoriesForShapes} from '../lib/territories.ts';

test('a rendered administrative shape resolves to its exact territory',()=>{
  const candidates=territoriesForShapes(['Moscow']);
  assert.equal(candidates.length,1);
  assert.equal(territoryForMapPoint(['Moscow'],[37.62,55.75])?.id,candidates[0].id);
});

test('renderer order cannot change a multi-feature click result',()=>{
  const names=['Moscow Oblast','Moscow'];
  const forward=territoryForMapPoint(names,[37.62,55.75]);
  const reverse=territoryForMapPoint([...names].reverse(),[37.62,55.75]);
  assert.equal(forward?.id,reverse?.id);
  assert.ok(forward?.shapeNames.includes('Moscow'));
});

test('the smallest containing territory wins over a surrounding territory',()=>{
  const selected=territoryForMapPoint(['Moscow Oblast','Moscow'],[37.62,55.75]);
  assert.ok(selected);
  assert.ok(selected.shapeNames.includes('Moscow'));
});

test('unknown renderer properties never select a random territory',()=>{
  assert.equal(territoryForMapPoint(['__missing__'],[40,55]),undefined);
});
