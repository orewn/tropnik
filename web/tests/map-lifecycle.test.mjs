import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {MapStyleSession, MapSelectionCamera, LatestMapNavigation, loadMapSelection, applyMapLayerVisibility} from '../lib/map-lifecycle.ts';

test('camera choices made during CSS zoom keep the newest intent and current insets', () => {
  let zooming = true, inset = 160;
  const visits = [], navigation = new LatestMapNavigation(() => zooming);
  navigation.request(() => visits.push(['region A', inset]));
  navigation.request(() => visits.push(['route B', inset]));
  navigation.flush();
  assert.deepEqual(visits, [], 'Leaflet must not receive ignored camera commands during zoom');
  inset = 240; zooming = false;
  navigation.flush(); navigation.flush();
  assert.deepEqual(visits, [['route B', 240]], 'one latest selection uses the settled drawer layout');
  navigation.request(() => visits.push(['overview', inset]));
  assert.deepEqual(visits.at(-1), ['overview', 240], 'idle camera choices apply immediately');
});

test('manual input and map disposal prevent delayed camera movement', () => {
  for (const action of ['cancel', 'dispose']) {
    let zooming = true;
    const visits = [], navigation = new LatestMapNavigation(() => zooming);
    navigation.request(() => visits.push('old region'));
    navigation[action](); zooming = false; navigation.flush();
    assert.deepEqual(visits, []);
    navigation.request(() => visits.push('new region'));
    assert.deepEqual(visits, action === 'dispose' ? [] : ['new region']);
  }
});

test('a flushed camera callback cannot replay or overwrite a newer reentrant request', () => {
  let zooming = true;
  const visits = [], navigation = new LatestMapNavigation(() => zooming);
  navigation.request(() => {
    visits.push('region'); zooming = true;
    navigation.request(() => visits.push('route'));
  });
  zooming = false; navigation.flush();
  assert.deepEqual(visits, ['region']);
  zooming = false; navigation.flush(); navigation.flush();
  assert.deepEqual(visits, ['region', 'route']);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

function mapSession(overrides = {}) {
  const applied = [], errors = [];
  let downloads = 0;
  const session = new MapStyleSession({
    online: true, preference: 'detail', currentMode: 'detail',
    detail: async () => {downloads++; return 'live';},
    overview: () => 'saved',
    ...overrides,
    apply: (style, mode) => applied.push({style, mode}),
    onError: error => errors.push(error),
  });
  return {session, applied, errors, downloads: () => downloads};
}

test('a temporary disconnect restores detail, while a chosen saved overview stays offline', async () => {
  const view = mapSession();
  await view.session.connect(false);
  await view.session.connect(true);
  assert.deepEqual(view.applied, [{style: 'saved', mode: 'overview'}, {style: 'live', mode: 'detail'}]);
  assert.equal(view.downloads(), 1);

  await view.session.select('overview');
  await view.session.connect(false);
  await view.session.connect(true);
  assert.equal(view.applied.at(-1).mode, 'overview');
  assert.equal(view.applied.length, 3);
  assert.equal(view.downloads(), 1, 'reconnection must not start a detail request for a saved overview');
});

test('a saved-overview selection made during an outage survives reconnection', async () => {
  const view = mapSession();
  await view.session.connect(false);
  await view.session.select('overview');
  await view.session.connect(true);
  assert.deepEqual(view.applied, [{style: 'saved', mode: 'overview'}]);
  assert.equal(view.downloads(), 0);
});

test('disconnect during detail loading cannot restore online sources with a late response', async () => {
  const gate = deferred();
  const view = mapSession({currentMode: 'overview', detail: () => gate.promise});
  const loading = view.session.select('detail');
  await view.session.connect(false);
  gate.resolve('late detail');
  assert.equal(await loading, false);
  assert.deepEqual(view.applied, []);
  assert.deepEqual(view.errors, []);
});

test('an explicit overview choice invalidates an already pending detail request', async () => {
  const gate = deferred();
  const view = mapSession({currentMode: 'overview', detail: () => gate.promise});
  const loading = view.session.select('detail');
  await view.session.select('overview');
  gate.resolve('unwanted detail');
  await loading;
  assert.deepEqual(view.applied, []);
  await view.session.connect(false);
  await view.session.connect(true);
  assert.deepEqual(view.applied, []);
});

test('only the newest reconnect response can replace the map', async () => {
  const old = deferred(), fresh = deferred();
  let request = 0;
  const view = mapSession({currentMode: 'overview', detail: () => (++request === 1 ? old.promise : fresh.promise)});
  const first = view.session.select('detail');
  await view.session.connect(false);
  const second = view.session.connect(true);
  fresh.resolve('current tiles');
  assert.equal(await second, true);
  old.resolve('stale tiles');
  assert.equal(await first, false);
  assert.deepEqual(view.applied, [{style: 'current tiles', mode: 'detail'}]);
});

test('late network errors do not overwrite a newer selection or a disposed map', async () => {
  for (const dispose of [false, true]) {
    const old = deferred();
    const view = mapSession({currentMode: 'overview', detail: () => old.promise});
    const loading = view.session.select('detail');
    if (dispose) view.session.dispose(); else await view.session.select('overview');
    old.reject(new Error('old connection failed'));
    assert.equal(await loading, false);
    assert.deepEqual(view.errors, []);
    assert.deepEqual(view.applied, []);
  }
});

test('a current detail failure preserves the existing map and a later retry can succeed', async () => {
  let request = 0;
  const error = new Error('unavailable');
  const view = mapSession({currentMode: 'overview', detail: async () => {
    if (++request === 1) throw error;
    return 'recovered';
  }});
  assert.equal(await view.session.select('detail'), false);
  assert.deepEqual(view.applied, []);
  assert.deepEqual(view.errors, [error]);
  assert.equal(await view.session.select('detail'), true);
  assert.deepEqual(view.applied, [{style: 'recovered', mode: 'detail'}]);
});

test('fatal style fallback invalidates in-flight detail without changing the preferred mode', async () => {
  const gate = deferred();
  let request = 0;
  const view = mapSession({currentMode: 'overview', detail: () => ++request === 1 ? gate.promise : Promise.resolve('recovered')});
  const loading = view.session.select('detail');
  view.session.fallback();
  gate.resolve('stale detail');
  await loading;
  assert.deepEqual(view.applied, [{style: 'saved', mode: 'overview'}]);
  await view.session.connect(true);
  assert.deepEqual(view.applied.at(-1), {style: 'recovered', mode: 'detail'});
});

test('a synchronous style error cannot undo the fallback when the failed apply returns', async () => {
  const applied = [];
  let failed = false;
  const session = new MapStyleSession({
    online: true, preference: 'detail', currentMode: 'overview',
    detail: async () => 'detail', overview: () => 'saved',
    apply: (style, mode) => {
      applied.push(mode);
      if (mode === 'detail' && !failed) {failed = true; session.fallback();}
    },
    onError: error => assert.fail(String(error)),
  });
  assert.equal(await session.select('detail'), false);
  assert.deepEqual(applied, ['detail', 'overview']);
  assert.equal(await session.connect(true), true);
  assert.deepEqual(applied, ['detail', 'overview', 'detail']);
});

test('hidden paths and boundaries are restored when a newly loaded style recreates layers', () => {
  let layers = new Map([['paths', 'visible'], ['tracks', 'visible'], ['region-boundary', 'visible']]);
  const map = {getLayer: id => layers.has(id), setLayoutProperty: (id, _name, value) => layers.set(id, value)};
  const preferences = {paths: false, boundaries: false};
  applyMapLayerVisibility(map, preferences);
  layers = new Map([['region-boundary', 'visible']]);
  applyMapLayerVisibility(map, preferences);
  assert.deepEqual([...layers], [['region-boundary', 'none']]);
  layers = new Map([['paths', 'visible'], ['tracks', 'visible'], ['region-boundary', 'visible']]);
  applyMapLayerVisibility(map, preferences);
  assert.deepEqual([...layers.values()], ['none', 'none', 'none']);
});

test('the actual detail style hides path labels and regional borders while keeping national borders', () => {
  const require = createRequire(import.meta.url);
  const {featureFilter} = createRequire(require.resolve('maplibre-gl/package.json'))('@maplibre/maplibre-gl-style-spec');
  const style = JSON.parse(readFileSync(new URL('../public/maps/tropa-style.json', import.meta.url), 'utf8'));
  const layers = new Map(style.layers.map(layer => [layer.id, layer]));
  const map = {
    getLayer: id => layers.get(id),
    setLayoutProperty: (id, name, value) => {const layer = layers.get(id); layer.layout = {...layer.layout, [name]: value};},
    setFilter: (id, filter) => {layers.get(id).filter = filter;},
  };
  const displaysBorder = level => featureFilter(layers.get('boundaries').filter, 'layers.boundaries.filter')
    .filter({zoom: 10}, {type: 2, properties: {admin_level: level}});
  assert.equal(displaysBorder(4), true, 'the source style contains regional borders in its vector layer');
  assert.ok(layers.has('path-label'), 'exercise the shipped label layer, not a mock layer list');
  applyMapLayerVisibility(map, {paths: false, boundaries: false});
  for (const id of ['paths', 'tracks', 'path-label']) assert.equal(layers.get(id).layout.visibility, 'none', id);
  assert.equal(displaysBorder(4), false, 'the vector base must not keep regional borders behind the hidden overlay');
  assert.equal(displaysBorder(2), true, 'the regional switch must preserve national borders');
  assert.equal(displaysBorder(6), false);
  applyMapLayerVisibility(map, {paths: true, boundaries: true});
  for (const id of ['paths', 'tracks', 'path-label']) assert.equal(layers.get(id).layout.visibility, 'visible', id);
  assert.equal(displaysBorder(4), true, 're-enabling restores the original regional source');
});

test('selecting a route clears the old line before the network request resolves', async () => {
  const gate = deferred();
  let geometry = 'old route';
  loadMapSelection({
    clear: () => {geometry = null;}, load: () => gate.promise, current: () => true,
    apply: value => {geometry = value;}, onError: () => assert.fail('unexpected error'),
  });
  assert.equal(geometry, null, 'the new card must never keep the previous route line');
  gate.resolve('selected route');
  await nextTurn();
  assert.equal(geometry, 'selected route');
});

test('rapid route changes cannot draw or report failures for the previous card', async () => {
  for (const rejectOld of [false, true]) {
    const old = deferred(), fresh = deferred();
    let identity = 'a', geometry = 'previous', errors = [];
    const select = (id, gate) => loadMapSelection({
      clear: () => {geometry = null;}, load: () => gate.promise, current: () => id === identity,
      apply: value => {geometry = value;}, onError: error => errors.push(error),
    });
    const cancel = select('a', old);
    await nextTurn();
    identity = 'b';
    select('b', fresh);
    await nextTurn();
    fresh.resolve('route b');
    await nextTurn();
    if (rejectOld) old.reject(new Error('route a failed')); else old.resolve('route a');
    await nextTurn();
    // Simulate the gap between a new React render and the previous effect cleanup.
    assert.equal(geometry, 'route b');
    assert.deepEqual(errors, []);
    cancel();
  }
});

test('style replacement or effect cleanup prevents a route from being added to an obsolete map', async () => {
  for (const cleanup of [false, true]) {
    const gate = deferred();
    let generation = 1, geometry = 'old route';
    const cancel = loadMapSelection({
      clear: () => {geometry = null;}, load: () => gate.promise, current: () => generation === 1,
      apply: value => {geometry = value;}, onError: () => assert.fail('obsolete map reported an error'),
    });
    await nextTurn();
    if (cleanup) cancel(); else generation++;
    gate.resolve('late route');
    await nextTurn();
    assert.equal(geometry, null);
  }
});

test('failed geometry leaves no stale line and reports only the current selection', async () => {
  let geometry = 'old route';
  const errors = [], error = new Error('geometry unavailable');
  loadMapSelection({
    clear: () => {geometry = null;}, load: async () => {throw error;}, current: () => true,
    apply: value => {geometry = value;}, onError: failure => errors.push(failure),
  });
  await nextTurn();
  assert.equal(geometry, null);
  assert.deepEqual(errors, [error]);
});

test('style and reconnect replacements restore route overlays without replaying selection navigation', async () => {
  const selection = new MapSelectionCamera(), overlays = [], fits = [];
  let selected = {id: 'route-a', url: '/data/route-a.geojson'};
  const restore = () => loadMapSelection({
    clear: () => {}, load: async () => selected, current: () => true,
    apply: identity => {overlays.push(identity.id); if (selection.routeChanged(identity)) fits.push(identity.id);},
    onError: error => assert.fail(String(error)),
  });
  restore(); await nextTurn();
  const session = new MapStyleSession({online: true, preference: 'detail', currentMode: 'detail',
    detail: async () => 'detail', overview: () => 'overview', apply: restore, onError: error => assert.fail(String(error))});
  await session.select('overview'); await nextTurn();
  await session.select('detail'); await nextTurn();
  await session.connect(false); await nextTurn();
  await session.connect(true); await nextTurn();
  assert.equal(overlays.length, 5, 'all replacement styles reinstall the selected overlay');
  assert.deepEqual(fits, ['route-a'], 'a manually changed camera is not replaced by a route fit');
  selected = {id: 'route-b', url: '/data/route-b.geojson'}; restore(); await nextTurn();
  assert.deepEqual(fits, ['route-a', 'route-b'], 'a genuine new selection still owns navigation');
});

test('region navigation runs once per selection, including the return to Russia, across style replacement', () => {
  const selection = new MapSelectionCamera(), visits = [];
  for (const id of [undefined, undefined, 'altai', 'altai', 'karelia', 'karelia', undefined, undefined]) {
    if (selection.regionChanged(id)) visits.push(id ?? 'russia');
  }
  assert.deepEqual(visits, ['russia', 'altai', 'karelia', 'russia']);
});

test('new route geometry or reselection can navigate while a cancelled stale response cannot claim ownership', async () => {
  const selection = new MapSelectionCamera(), old = deferred(), visits = [];
  const a = {id: 'route-a', url: '/data/a.geojson'}, b = {id: 'route-b', geometry: {type: 'FeatureCollection', features: []}};
  let current = true;
  loadMapSelection({clear: () => {}, load: () => old.promise, current: () => current,
    apply: identity => {if (selection.routeChanged(identity)) visits.push(identity.id);}, onError: error => assert.fail(String(error))});
  await nextTurn(); current = false; old.resolve(a); await nextTurn();
  assert.deepEqual(visits, []);
  assert.equal(selection.routeChanged(a), true);
  assert.equal(selection.routeChanged({...a}), false);
  assert.equal(selection.routeChanged({...a, url: '/data/a-revised.geojson'}), true);
  assert.equal(selection.routeChanged(b), true);
  assert.equal(selection.routeChanged({...b}), false);
  selection.routeChanged(undefined);
  assert.equal(selection.routeChanged(b), true);
});
