import test from 'node:test';
import assert from 'node:assert/strict';
import {readSearchState, searchStateQuery, searchResultPage, searchPageNumbers} from '../lib/search-state.ts';

test('search links preserve the query, material kind, unspecified choice and result page', () => {
  const state = {query: 'Байкал до 15 км', kind: 'route', includeUnspecified: false, page: 3};
  const query = searchStateQuery(state);
  assert.deepEqual(readSearchState(new URLSearchParams(query)), state);
  assert.equal(searchStateQuery({query: '  ', kind: 'all', includeUnspecified: true, page: 1}), '');
  assert.deepEqual(readSearchState(new URLSearchParams()), {query: '', kind: 'all', includeUnspecified: true, page: 1});
});

test('invalid URL options cannot make the catalog unreachable or allocate an unbounded page', () => {
  const state = readSearchState(new URLSearchParams({q: 'x'.repeat(300), kind: 'private', unknown: 'yes', page: '99999999999'}));
  assert.equal(state.query.length, 160);
  assert.equal(state.kind, 'all');
  assert.equal(state.includeUnspecified, true);
  assert.equal(state.page, 1);
  for (const page of ['-1', '0', '1.5', 'NaN', 'Infinity']) assert.equal(readSearchState(new URLSearchParams({page})).page, 1);
});

test('every search hit is reachable exactly once across 12-result pages', () => {
  for (const length of [0, 1, 12, 13, 70, 277, 450]) {
    const results = Array.from({length}, (_, id) => ({id})), collected = [];
    const first = searchResultPage(results, 1);
    for (let page = 1; page <= first.pages; page++) collected.push(...searchResultPage(results, page).items);
    assert.deepEqual(collected, results);
    assert.equal(new Set(collected.map(hit => hit.id)).size, length);
    const last = searchResultPage(results, 99999);
    assert.equal(last.end, length);
    assert.equal(last.page, first.pages);
    assert.equal(searchResultPage(results, -1).page, 1);
    assert.equal(searchResultPage(results, NaN).page, 1);
  }
});

test('pagination retains first, last and neighbouring pages without duplicates', () => {
  assert.deepEqual(searchPageNumbers(1, 1), [1]);
  assert.deepEqual(searchPageNumbers(1, 24), [1, 2, 'gap', 24]);
  assert.deepEqual(searchPageNumbers(12, 24), [1, 'gap', 11, 12, 13, 'gap', 24]);
  assert.deepEqual(searchPageNumbers(24, 24), [1, 'gap', 23, 24]);
  assert.throws(() => searchResultPage([], 1, 0));
});
