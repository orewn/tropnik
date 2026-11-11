import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {MapStyleSession, MapSelectionCamera, LatestMapNavigation, loadMapSelection, applyMapLayerVisibility} from '../lib/map-lifecycle.ts';
import {bindZoomButtonCancellation} from '../lib/map-zoom-buttons.ts';
import {canRefitMapOverview} from '../lib/map-framing.ts';
import {russiaCamera,russiaPadding} from '../public/maps/russia-viewport.js';

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

test('returning from a route to its same parent region restores the region camera once', () => {
  const selection = new MapSelectionCamera(), visits = [];
  const show = (region, route) => {
    if (selection.regionChanged(region, route)) visits.push(region ?? 'russia');
  };
  show('altai');
  show('altai', 'route-77');
  show('altai', 'route-77'); // A style reload restores overlays, not navigation.
  show('altai', 'route-77'); // A user pan and unrelated rerender stay authoritative.
  show('altai');
  show('altai');
  assert.deepEqual(visits, ['altai', 'altai']);
  show('altai', 'route-77');
  show('altai', 'route-78');
  show('altai');
  assert.deepEqual(visits, ['altai', 'altai', 'altai'], 'switching routes must not visit the parent between them');
});

test('leaving a route before its geometry loads still returns to its parent camera', () => {
  const selection = new MapSelectionCamera();
  assert.equal(selection.regionChanged('baikal'), true);
  assert.equal(selection.regionChanged('baikal', 'pending-route'), false);
  // No routeChanged call: the fetch may still be pending or may have failed.
  assert.equal(selection.regionChanged('baikal'), true);
  assert.equal(selection.regionChanged('baikal'), false);
  assert.equal(selection.regionChanged('baikal', 'another-route'), false);
  assert.equal(selection.regionChanged(undefined), true, 'returning to all directions visits Russia');
  assert.equal(selection.regionChanged(undefined), false);
});

test('source-only cards visit their known parent once and never revive a cancelled frame on rerender', () => {
  const selection = new MapSelectionCamera();
  assert.equal(selection.regionChanged('chukotka', 'whale-alley', false), true, 'direct description links frame the territory');
  selection.cancelNavigation();
  assert.equal(selection.regionChanged('chukotka', 'whale-alley', false), false, 'style restoration preserves manual navigation');
  assert.equal(selection.regionChanged('chukotka', 'source-track', true), false, 'a source line owns its separate route fit');
  assert.equal(selection.regionChanged('chukotka', 'whale-alley', false), true, 'returning from a line fits the known parent');
  assert.equal(selection.regionChanged('chukotka', 'another-description', false), true, 'a different description is a new selection');
  assert.equal(selection.regionChanged('chukotka', 'another-description', true), false);
  assert.equal(selection.regionChanged('chukotka', 'another-description', false), true, 'removing geometry from a revision returns to parent bounds');
  assert.equal(selection.regionChanged('chukotka'), true);
  assert.equal(selection.regionChanged('chukotka'), false);
});

test('late route geometry is drawn without moving a camera the visitor already navigated', async () => {
  for (const action of ['pointerdown', 'touchstart', 'wheel', 'ArrowRight', 'camera-button']) {
    const selection = new MapSelectionCamera(), gate = deferred(), events = new Map();
    const surface = {addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name)};
    const unbind = bindZoomButtonCancellation(surface, {cancel() {}}, () => selection.cancelNavigation());
    const route = {id: 'route-a', url: '/route-a.geojson'};
    selection.beginRouteSelection(route);
    const canNavigate = selection.captureNavigation();
    const overlays = [], camera = [];
    loadMapSelection({clear: () => {}, load: () => gate.promise, current: () => true,
      apply: geometry => {
        overlays.push(geometry);
        if (selection.routeChanged(route) && canNavigate()) camera.push(route.id);
      }, onError: error => assert.fail(String(error))});
    await nextTurn();
    if (action === 'camera-button') selection.cancelNavigation();
    else if (action === 'ArrowRight') events.get('keydown')({key: action});
    else events.get(action)({});
    gate.resolve('fresh geometry'); await nextTurn();
    assert.deepEqual(overlays, ['fresh geometry'], action + ': navigation cancellation must not lose route data');
    assert.deepEqual(camera, [], action + ': late geometry must not snap the visitor back');
    assert.equal(selection.routeChanged(route), false, 'style restoration cannot revive the cancelled navigation');
    const nextRoute = {id: 'route-b', url: '/route-b.geojson'};
    selection.beginRouteSelection(nextRoute);
    const nextNavigation = selection.captureNavigation();
    assert.equal(selection.routeChanged(nextRoute) && nextNavigation(), true, 'a new deliberate selection can navigate');
    unbind(); assert.equal(events.size, 0);
  }
});

test('initial layout resizing cannot cancel a selected route before or during its asynchronous load', async () => {
  for (const resizePhase of ['before-load-effect', 'during-load']) {
    for (const region of [undefined, {id:'krasnodar'}]) {
      const selection=new MapSelectionCamera(), gate=deferred(), overlays=[], visits=[];
      const route={id:'osm-relation-2244794',url:'/data/imported/osm-relation-2244794.geojson'};
      selection.beginRouteSelection(route);
      const fitRussia=()=>{selection.cancelNavigation();visits.push('russia');};
      const initialResize=()=>{if(canRefitMapOverview(true,region,route))fitRussia();};
      const permissionAtMount=selection.captureNavigation();
      if(resizePhase==='before-load-effect')initialResize();
      const canNavigate=selection.captureNavigation();
      loadMapSelection({clear:()=>{},load:()=>gate.promise,current:()=>true,
        apply:geometry=>{overlays.push(geometry);if(selection.routeChanged(route)&&canNavigate())visits.push(route.id);},
        onError:error=>assert.fail(String(error))});
      await nextTurn();
      if(resizePhase==='during-load')initialResize();
      assert.equal(permissionAtMount(),true,`${resizePhase}: a ResizeObserver is not manual navigation`);
      gate.resolve('source geometry');await nextTurn();
      assert.deepEqual(overlays,['source geometry']);
      assert.deepEqual(visits,[route.id],`${resizePhase}: the source geometry still owns its initial fit`);
    }
  }
});

test('an explicit Home command still cancels a pending route, while unselected overview layout may refit', async () => {
  const selection=new MapSelectionCamera(), gate=deferred(), visits=[], overlays=[];
  const route={id:'pending-route'};
  selection.beginRouteSelection(route);
  const canNavigate=selection.captureNavigation();
  const fitRussia=()=>{selection.cancelNavigation();visits.push('russia');};
  loadMapSelection({clear:()=>{},load:()=>gate.promise,current:()=>true,
    apply:geometry=>{overlays.push(geometry);if(selection.routeChanged(route)&&canNavigate())visits.push(route.id);},
    onError:error=>assert.fail(String(error))});
  await nextTurn();fitRussia();
  assert.equal(canNavigate(),false,'the Home control remains a newer deliberate camera choice');
  gate.resolve('source geometry');await nextTurn();
  assert.deepEqual(overlays,['source geometry']);assert.deepEqual(visits,['russia']);
  assert.equal(canRefitMapOverview(true,undefined,undefined),true);
  assert.equal(canRefitMapOverview(false,undefined,undefined),false,'manual navigation is not an overview');
  assert.equal(canRefitMapOverview(true,{id:'krasnodar'},undefined),false,'a pending region also owns its framing');
});

test('explicit Home with a retained card still fits Russia after a physical viewport resize', () => {
  const region={id:'krasnodar'}, route={id:'selected-route'}, selection=new MapSelectionCamera();
  selection.beginRouteSelection(route);
  const pendingRoute=selection.captureNavigation();
  let overviewRequested=false, camera;
  const fitOverview=(width,height)=>{camera=russiaCamera(width,height,russiaPadding(width,height),256);};
  const home=(width,height)=>{overviewRequested=true;selection.cancelNavigation();fitOverview(width,height);};
  const resize=(width,height)=>{if(canRefitMapOverview(true,region,route,overviewRequested))fitOverview(width,height);};
  assert.equal(canRefitMapOverview(true,region,route,overviewRequested),false,'the loading placeholder is not an overview choice');
  home(1000,700);
  assert.equal(pendingRoute(),false,'Home owns the camera before layout changes');
  const wide=camera;
  resize(412,700);
  const narrow=russiaCamera(412,700,russiaPadding(412,700),256);
  assert.deepEqual(camera,narrow);assert.ok(camera.zoom<wide.zoom-1,'the full country must fit the narrower viewport');
  assert.equal(pendingRoute(),false,'resizing cannot revive the old route');
  resize(1000,700);assert.deepEqual(camera,wide,'widening restores both overview scale and centre');
  // A different selection revokes the overview intent synchronously, even
  // while the actual camera still shows the previous whole-country view.
  overviewRequested=false;selection.beginRouteSelection({id:'next-route'});
  const nextRoute=selection.captureNavigation();resize(412,700);
  assert.deepEqual(camera,wide);assert.equal(nextRoute(),true,'the new selection keeps its future fit');
});

test('both renderers guard their actual layout observers with the shared overview permission', () => {
  for(const file of ['Atlas.tsx','Atlas2D.tsx']){
    const source=readFileSync(new URL(`../components/${file}`,import.meta.url),'utf8');
    const resize=source.slice(source.indexOf(file==='Atlas2D.tsx'?'const queueResize=':'resizeFrame=coalesceMapFrame('),source.indexOf('resize=new ResizeObserver'));
    assert.match(resize,/canRefitMapOverview\((?:wasOverview|fullView\.current),regionRef\.current,trailRef\.current,overviewRequested\.current\)/,file);
    const home=source.slice(source.indexOf(file==='Atlas2D.tsx'?'const fitRussia=':'function fitRussia('));
    assert.match(home.slice(0,500),/selectionCamera\.current\.cancelNavigation\(\)/,`${file}: explicit Home must keep cancellation`);
    assert.match(home.slice(0,500),/overviewRequested\.current=true/,`${file}: explicit Home retains overview layout intent`);
    assert.match(source,/useLayoutEffect\(\(\)=>\{overviewRequested\.current=false;\},\[region\?\.id,trail\?\.id,trail\?\.geometryUrl,trail\?\.geometry\]\)/,`${file}: new selection resets the previous overview choice`);
  }
});

test('manual navigation also cancels a route fit already waiting for Leaflet zoom to settle', async () => {
  const selection = new MapSelectionCamera(), gate = deferred(), visits = [], overlays = [];
  let zooming = true;
  selection.beginRouteSelection({id: 'route-a'});
  const navigation = new LatestMapNavigation(() => zooming), canNavigate = selection.captureNavigation();
  loadMapSelection({clear: () => {}, load: () => gate.promise, current: () => true,
    apply: geometry => {
      overlays.push(geometry);
      if (selection.routeChanged({id: 'route-a'}) && canNavigate()) {
        navigation.request(() => {if (canNavigate()) visits.push('route-a');});
      }
    }, onError: error => assert.fail(String(error))});
  gate.resolve('route-a geometry'); await nextTurn();
  selection.cancelNavigation(); zooming = false; navigation.flush();
  assert.deepEqual(overlays, ['route-a geometry']);
  assert.deepEqual(visits, [], 'pending zoom completion must not replay an obsolete camera intent');
});

test('a style replacement during pending route geometry cannot revive navigation cancelled by a pan', async () => {
  for (const manualPan of [false, true]) {
    const selection = new MapSelectionCamera(), geometry = deferred();
    const route = {id: 'uncached-route', url: '/uncached-route.geojson'}, overlays = [], camera = [];
    let generation = 0, cleanup;
    selection.beginRouteSelection(route);
    const mountRouteLayer = () => {
      cleanup?.();
      const currentGeneration = ++generation;
      // A newly loaded style reruns the component effects for the same card.
      selection.beginRouteSelection({...route});
      const canNavigate = selection.captureNavigation();
      cleanup = loadMapSelection({clear: () => {}, load: () => geometry.promise,
        current: () => currentGeneration === generation,
        apply: data => {
          overlays.push([currentGeneration, data]);
          if (selection.routeChanged(route) && canNavigate()) camera.push(route.id);
        }, onError: error => assert.fail(String(error))});
    };
    mountRouteLayer(); await nextTurn();
    if (manualPan) selection.cancelNavigation();
    const style = new MapStyleSession({online: true, preference: 'detail', currentMode: 'detail',
      detail: async () => 'detail', overview: () => 'overview', apply: mountRouteLayer,
      onError: error => assert.fail(String(error))});
    await style.select('overview'); await nextTurn();
    assert.deepEqual(overlays, [], 'the original request is still pending when the style changes');
    geometry.resolve('selected route geometry'); await nextTurn();
    assert.deepEqual(overlays, [[2, 'selected route geometry']], 'only the new style receives the geometry');
    assert.deepEqual(camera, manualPan ? [] : [route.id], 'the same pending selection retains its original camera permission');
    await style.select('detail'); await nextTurn();
    assert.equal(overlays.length, 2, 'subsequent style restoration still draws the route');
    assert.deepEqual(camera, manualPan ? [] : [route.id], 'no replacement style may replay that selection');
    cleanup(); style.dispose();
  }
});

test('route camera permission starts with selection, survives rerenders, and renews only for a new identity', () => {
  const selection = new MapSelectionCamera(), route = {id: 'route-a', url: '/route-a.geojson'};
  selection.beginRouteSelection(route);
  const first = selection.captureNavigation();
  selection.cancelNavigation();
  selection.beginRouteSelection({...route});
  assert.equal(selection.captureNavigation()(), false, 'a pan before the loading effect also cancels its future fit');
  assert.equal(first(), false);
  selection.beginRouteSelection({...route, url: '/route-a-revised.geojson'});
  const revised = selection.captureNavigation();
  assert.equal(revised(), true, 'an explicitly changed geometry URL is a new camera selection');
  selection.beginRouteSelection(undefined);
  selection.beginRouteSelection(route);
  assert.equal(selection.captureNavigation()(), true, 'leaving then choosing the same route renews the intent');
  assert.equal(first(), false, 'new permission must not validate an old callback');
  assert.equal(revised(), false, 'changing selection invalidates a callback even without a manual pan');
});

test('reselecting the displayed route after a different pending selection is a new camera intent', () => {
  const selection = new MapSelectionCamera(), first = {id: 'route-a'}, pending = {id: 'route-b'};
  selection.beginRouteSelection(first);
  assert.equal(selection.routeChanged(first), true);
  selection.beginRouteSelection(pending); // The replacement geometry has not arrived.
  selection.beginRouteSelection(first);
  assert.equal(selection.routeChanged(first) && selection.captureNavigation()(), true);
  selection.beginRouteSelection({...first});
  assert.equal(selection.routeChanged(first), false, 'ordinary rerenders remain camera-neutral');
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
