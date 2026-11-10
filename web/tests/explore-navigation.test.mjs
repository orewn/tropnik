import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_EXPLORE_FILTERS, exploreFiltersForRegion, exploreParentSelection, exploreTrailSelection, writeExploreHistory} from '../lib/explore-navigation.ts';
import {filterMapTrails, mapDirectionCounts} from '../lib/map-catalog.ts';

function browserHistory(href = 'https://example.test/') {
  const location = {href}, entries = [{href, state: {framework: 'retained'}}];
  let index = 0;
  const history = {
    get state() {return entries[index].state;},
    get length() {return entries.length;},
    scrollRestoration: 'manual',
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({state, href: new URL(url, location.href).href});
      index++; location.href = entries[index].href;
    },
    replaceState(state, _title, url) {entries[index] = {state, href: new URL(url, location.href).href}; location.href = entries[index].href;},
    back() {if (index > 0) location.href = entries[--index].href;},
    forward() {if (index + 1 < entries.length) location.href = entries[++index].href;},
  };
  const selection = () => {
    const params = new URL(location.href).searchParams;
    return {regionId: params.get('region') || undefined, trailId: params.get('route') || undefined};
  };
  return {location, history, selection};
}

test('All directions reaches overview after sibling selection and browser history remains chronological', () => {
  const browser = browserHistory();
  writeExploreHistory(browser, {}, 'replace');
  writeExploreHistory(browser, {regionId: 'altai'});
  writeExploreHistory(browser, {regionId: 'baikal'});
  writeExploreHistory(browser, exploreParentSelection(browser.selection()));
  assert.deepEqual(browser.selection(), {regionId: undefined, trailId: undefined});
  assert.equal(browser.history.state.tropnikExploreLevel, 0);
  browser.history.back();
  assert.equal(browser.selection().regionId, 'baikal');
  browser.history.back();
  assert.equal(browser.selection().regionId, 'altai');
  browser.history.forward();
  assert.equal(browser.selection().regionId, 'baikal');
  browser.history.forward();
  assert.deepEqual(browser.selection(), {regionId: undefined, trailId: undefined});
  assert.equal(browser.history.state.framework, 'retained');
  assert.equal(browser.history.scrollRestoration, 'manual');
});

test('Routes of the direction reaches its catalogue after sibling routes without duplicating repeated selections', () => {
  const browser = browserHistory();
  writeExploreHistory(browser, {regionId: 'altai'});
  writeExploreHistory(browser, {regionId: 'altai', trailId: 'first'});
  writeExploreHistory(browser, {regionId: 'altai', trailId: 'second'});
  const length = browser.history.length;
  assert.equal(writeExploreHistory(browser, {regionId: 'altai', trailId: 'second'}), false);
  assert.equal(browser.history.length, length);
  writeExploreHistory(browser, exploreParentSelection(browser.selection()));
  assert.deepEqual(browser.selection(), {regionId: 'altai', trailId: undefined});
  assert.equal(browser.history.state.tropnikExploreLevel, 1);
  browser.history.back();
  assert.equal(browser.selection().trailId, 'second');
  browser.history.back();
  assert.equal(browser.selection().trailId, 'first');
  browser.history.forward();
  browser.history.forward();
  assert.deepEqual(browser.selection(), {regionId: 'altai', trailId: undefined});
});

test('deep-link parent navigation preserves root or Pages paths, other parameters and the fragment', () => {
  for (const path of ['/', '/tropnik/']) {
    const browser = browserHistory(`https://example.test${path}?map=canvas&region=altai&route=first#map`);
    writeExploreHistory(browser, browser.selection(), 'replace');
    assert.equal(browser.history.length, 1, 'initial URL normalisation only replaces');
    assert.equal(browser.history.state.tropnikExplorePushed, false);
    writeExploreHistory(browser, exploreParentSelection(browser.selection()));
    const url = new URL(browser.location.href);
    assert.equal(url.pathname, path);
    assert.equal(url.search, '?map=canvas&region=altai');
    assert.equal(url.hash, '#map');
    assert.equal(browser.history.state.framework, 'retained');
    assert.equal(browser.history.state.tropnikExplorePushed, true);
    browser.history.back();
    assert.equal(browser.selection().trailId, 'first');
  }
});

test('a place-story route writes its explicit direction and route together in one history entry', () => {
  const browser = browserHistory('https://example.test/tropnik/?region=altai');
  const trail = {id: 'baikal-trail', regionId: 'baikal'};
  const selection = exploreTrailSelection(trail, 'altai', 'baikal');
  writeExploreHistory(browser, selection);
  assert.deepEqual(browser.selection(), {regionId: 'baikal', trailId: 'baikal-trail'});
  assert.equal(browser.history.length, 2, 'no intermediate direction-only visit is inserted');
  assert.equal(new URL(browser.location.href).pathname, '/tropnik/');
  browser.history.back();
  assert.deepEqual(browser.selection(), {regionId: 'altai', trailId: undefined});
  assert.deepEqual(exploreTrailSelection(trail), {regionId: 'baikal', trailId: 'baikal-trail'});
  assert.deepEqual(exploreTrailSelection(trail, 'selected-territory'), {regionId: 'selected-territory', trailId: 'baikal-trail'});
});

test('overview results and direction counts ignore stale region-only filters on the first render', () => {
  const trails = [
    {id: 'first', regionId: 'altai', title: 'First', subtitle: '', difficulty: 'easy', duration: '2 ч'},
    {id: 'second', regionId: 'baikal', title: 'Second', subtitle: '', difficulty: 'hard', duration: null},
  ];
  const stale = {expanded: true, difficulty: 'hard', duration: 'day', onlySaved: true};
  const savedIds = new Set();
  const regional = filterMapTrails(trails, {query: '', savedIds, ...exploreFiltersForRegion('altai', stale)});
  assert.equal(regional.length, 0);
  const filters = exploreFiltersForRegion(undefined, stale);
  assert.deepEqual(filters, DEFAULT_EXPLORE_FILTERS);
  const overview = filterMapTrails(trails, {query: '', savedIds, ...filters});
  assert.deepEqual(overview.map(trail => trail.id), ['first', 'second']);
  assert.deepEqual([...mapDirectionCounts(overview)], [['altai', 1], ['baikal', 1]]);
  assert.equal(filters.expanded, false, 'the reset also closes the regional filter panel');
});
