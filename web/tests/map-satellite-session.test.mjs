import test from 'node:test';
import assert from 'node:assert/strict';
import {SatelliteImagerySession, prepareMapLibreSatellite, prepareLeafletSatellite} from '../lib/map-satellite-session.ts';

const EOX = 'eox-s2', OVERVIEW = 'eox-bluemarble';
function fixture({cancelSettles = true} = {}) {
  const candidates = [], states = [], errors = [], events = [];
  let visible = null, prepareError = null, showError = null;
  const session = new SatelliteImagerySession({
    prepare(source) {
      if (prepareError) throw prepareError;
      let resolve, reject;
      const ready = new Promise((yes, no) => {resolve = yes; reject = no;});
      const record = {source, resolve, reject, shown: 0, disposed: 0};
      candidates.push(record);
      return {
        ready,
        show() {
          if (showError) throw showError;
          record.shown++; visible = record; events.push(['show', record]);
        },
        dispose() {
          record.disposed++; events.push(['dispose', record]);
          if (visible === record) visible = null;
          if (cancelSettles) reject(new DOMException('Candidate cancelled', 'AbortError'));
        },
      };
    },
    onState(state) {states.push(state);},
    onError(error, source) {errors.push({error, source});},
  });
  return {session, candidates, states, errors, events,
    visible: () => visible,
    failPrepare(error) {prepareError = error;},
    failShow(error) {showError = error;},
  };
}
async function showFirst(env, source = EOX) {
  const result = env.session.choose(source), candidate = env.candidates.at(-1);
  candidate.resolve(); assert.equal(await result, true);
  return candidate;
}

test('a replacement keeps the current imagery visible until ready and shows before releasing it', async () => {
  const env = fixture(), current = await showFirst(env);
  const result = env.session.choose(OVERVIEW), replacement = env.candidates.at(-1);
  assert.deepEqual(env.states.at(-1), {active: EOX, target: OVERVIEW, loading: true});
  assert.equal(env.visible(), current);
  assert.equal(current.disposed, 0);
  assert.equal(replacement.shown, 0);
  replacement.resolve(); assert.equal(await result, true);
  assert.equal(env.visible(), replacement);
  assert.deepEqual(env.events.slice(-2), [['show', replacement], ['dispose', current]]);
  assert.deepEqual(env.states.at(-1), {active: OVERVIEW, target: OVERVIEW, loading: false});
  assert.deepEqual(env.errors, []);
  env.session.dispose();
});

test('repeated choices share the pending operation and do not reload an already visible source', async () => {
  const env = fixture(), first = env.session.choose(OVERVIEW);
  assert.equal(env.session.choose(OVERVIEW), first);
  assert.equal(env.candidates.length, 1);
  assert.deepEqual(env.states.at(-1), {active: null, target: OVERVIEW, loading: true});
  env.candidates[0].resolve(); assert.equal(await first, true);
  assert.equal(await env.session.choose(OVERVIEW), true);
  assert.equal(env.candidates.length, 1);
  assert.equal(env.candidates[0].shown, 1);
  env.session.dispose();
});

test('returning to the visible provider cancels its pending replacement without a blank frame', async () => {
  const env = fixture(), current = await showFirst(env);
  const pending = env.session.choose(OVERVIEW), obsolete = env.candidates.at(-1);
  assert.equal(await env.session.choose(EOX), true);
  assert.equal(await pending, false);
  assert.equal(obsolete.disposed, 1);
  assert.equal(obsolete.shown, 0);
  assert.equal(current.disposed, 0);
  assert.equal(env.visible(), current);
  assert.deepEqual(env.states.at(-1), {active: EOX, target: EOX, loading: false});
  assert.deepEqual(env.errors, []);
  env.session.dispose();
});

test('cold A to B to A accepts only the latest instance even when cancelled loads settle late', async () => {
  const env = fixture({cancelSettles: false});
  const first = env.session.choose(EOX), oldEOX = env.candidates.at(-1);
  const second = env.session.choose(OVERVIEW), oldNASA = env.candidates.at(-1);
  const latest = env.session.choose(EOX), newEOX = env.candidates.at(-1);
  newEOX.resolve(); assert.equal(await latest, true);
  const stateCount = env.states.length;
  oldNASA.resolve(); oldEOX.reject(new Error('Late obsolete network failure'));
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(env.states.length, stateCount);
  assert.equal(env.visible(), newEOX);
  assert.equal(oldEOX.shown, 0); assert.equal(oldNASA.shown, 0);
  assert.equal(oldEOX.disposed, 1); assert.equal(oldNASA.disposed, 1);
  assert.deepEqual(env.errors, []);
  env.session.dispose();
});

test('a failed current replacement preserves the visible source and permits a fresh retry', async () => {
  const env = fixture(), current = await showFirst(env);
  const failed = env.session.choose(OVERVIEW), rejected = env.candidates.at(-1);
  const error = new Error('A required satellite tile failed');
  rejected.reject(error); assert.equal(await failed, false);
  assert.equal(env.visible(), current);
  assert.equal(rejected.disposed, 1);
  assert.deepEqual(env.errors, [{error, source: OVERVIEW}]);
  assert.deepEqual(env.states.at(-1), {active: EOX, target: EOX, loading: false});
  const retry = env.session.choose(OVERVIEW), fresh = env.candidates.at(-1);
  assert.notEqual(fresh, rejected);
  fresh.resolve(); assert.equal(await retry, true);
  assert.equal(env.visible(), fresh);
  assert.equal(current.disposed, 1);
  env.session.dispose();
});

test('dispose releases active and pending resources once and late completion cannot restore imagery', async () => {
  const env = fixture({cancelSettles: false}), current = await showFirst(env);
  const pending = env.session.choose(OVERVIEW), cancelled = env.candidates.at(-1);
  env.session.dispose(); env.session.dispose();
  const stateCount = env.states.length;
  cancelled.resolve(); assert.equal(await pending, false);
  assert.equal(await env.session.choose(EOX), false);
  assert.equal(env.candidates.length, 2);
  assert.equal(current.disposed, 1); assert.equal(cancelled.disposed, 1);
  assert.equal(cancelled.shown, 0);
  assert.equal(env.visible(), null);
  assert.equal(env.states.length, stateCount);
  assert.deepEqual(env.errors, []);
});

test('synchronous preparation failure preserves current imagery and can be retried', async () => {
  const env = fixture(), current = await showFirst(env);
  const error = new Error('Map source cannot be prepared');
  env.failPrepare(error);
  assert.equal(await env.session.choose(OVERVIEW), false);
  assert.equal(env.visible(), current);
  assert.equal(current.disposed, 0);
  assert.deepEqual(env.states.at(-1), {active: EOX, target: EOX, loading: false});
  assert.deepEqual(env.errors, [{error, source: OVERVIEW}]);
  env.failPrepare(null);
  const retry = env.session.choose(OVERVIEW); env.candidates.at(-1).resolve();
  assert.equal(await retry, true);
  env.session.dispose();
});

test('a failed atomic show releases the candidate without disposing the previous source', async () => {
  const env = fixture(), current = await showFirst(env);
  const error = new Error('Style disappeared before the swap');
  env.failShow(error);
  const result = env.session.choose(OVERVIEW), failed = env.candidates.at(-1);
  failed.resolve(); assert.equal(await result, false);
  assert.equal(env.visible(), current);
  assert.equal(current.disposed, 0); assert.equal(failed.disposed, 1);
  assert.deepEqual(env.states.at(-1), {active: EOX, target: EOX, loading: false});
  assert.deepEqual(env.errors, [{error, source: OVERVIEW}]);
  env.session.dispose();
});

// Controlled SDK events exercise the real adapters. In particular, both SDKs
// count failed tile requests as settled; a generic "loaded" signal is not proof
// that a replacement is usable. These fixtures expose no camera mutators.
function events() {
  const listeners = new Map();
  return {
    on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback); return this;
    },
    off(name, callback) {listeners.get(name)?.delete(callback); return this;},
    emit(name, value = {}) {for (const callback of [...listeners.get(name) ?? []]) callback(value);},
    listenerCount() {return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);},
  };
}
function mapLibreFixture() {
  const writes = [], map = Object.assign(events(), {
    loaded: false, present: true, moving: false, queries: 0, repaints: 0,
    getLayer() {return this.present ? {} : undefined;},
    isMoving() {return this.moving;},
    isSourceLoaded() {this.queries++; return this.loaded;},
    setPaintProperty(id, name, value) {writes.push(['paint', id, name, value]);},
    setLayoutProperty(id, name, value) {writes.push(['layout', id, name, value]);},
    triggerRepaint() {this.repaints++;},
  });
  return {map, writes};
}
function leafletFixture() {
  const layers = new Set(), opacities = [];
  const map = Object.assign(events(), {hasLayer(layer) {return layers.has(layer);}});
  const layer = Object.assign(events(), {
    removals: 0, loading: false,
    isLoading() {return this.loading;},
    setOpacity(value) {opacities.push(value); return this;},
    addTo() {layers.add(this); return this;},
    remove() {this.removals++; layers.delete(this); return this;},
  });
  return {map, layer, opacities};
}

test('MapLibre readiness requires a rendered current tile set, not an unused or prior-view loaded signal', async () => {
  const {map, writes} = mapLibreFixture();
  map.loaded = true;
  const candidate = prepareMapLibreSatellite(map, OVERVIEW, () => true);
  let ready = false; void candidate.ready.then(() => {ready = true;});
  map.emit('sourcedata', {sourceId: OVERVIEW}); await Promise.resolve();
  assert.equal(ready, false); assert.equal(map.queries, 0);
  map.loaded = false; map.emit('render');
  map.loaded = true; map.emit('sourcedata', {sourceId: OVERVIEW}); await Promise.resolve();
  assert.equal(ready, false, 'a source event cannot certify the next camera viewport before its render');
  map.emit('render'); await candidate.ready;
  assert.equal(ready, true);
  assert.equal(map.listenerCount(), 0);
  candidate.show();
  assert.deepEqual(writes.at(-1), ['paint', OVERVIEW, 'raster-opacity', 1]);
  assert.ok(writes.some(row => row[2] === 'raster-opacity-transition' && row[3].duration === 0));
  candidate.dispose();
  assert.deepEqual(writes.slice(-2), [['layout', OVERVIEW, 'visibility', 'none'], ['paint', OVERVIEW, 'raster-opacity', 0]]);
});

test('MapLibre keeps the previous ground during a flight and waits for the destination tile set', async () => {
  const {map, writes} = mapLibreFixture();
  map.moving = true; map.loaded = true;
  const candidate = prepareMapLibreSatellite(map, EOX, () => true);
  let ready = false; void candidate.ready.then(() => {ready = true;});
  map.emit('render'); await Promise.resolve();
  assert.equal(ready, false, 'a complete intermediate zoom is not the requested stationary view');
  assert.equal(map.queries, 0);
  map.loaded = false; map.moving = false; map.emit('moveend');
  assert.equal(map.repaints, 2, 'ending the movement requests a readiness frame');
  map.emit('render'); await Promise.resolve(); assert.equal(ready, false);
  map.loaded = true; map.emit('render'); await candidate.ready;
  assert.equal(ready, true); assert.equal(map.listenerCount(), 0);
  assert.ok(!writes.some(row => row[2] === 'raster-opacity' && row[3] === 1));
  candidate.show(); assert.deepEqual(writes.at(-1), ['paint', EOX, 'raster-opacity', 1]);
  candidate.dispose();
});

test('MapLibre tile error rejects a candidate even when the SDK now considers the source loaded', async () => {
  const {map} = mapLibreFixture(), error = new Error('Blue Marble tile HTTP failure');
  const candidate = prepareMapLibreSatellite(map, OVERVIEW, () => true);
  const rejection = assert.rejects(candidate.ready, value => value === error);
  map.emit('error', {sourceId: EOX, error: new Error('Unrelated source')});
  assert.ok(map.listenerCount() > 0);
  map.loaded = true; map.emit('error', {sourceId: OVERVIEW, error}); map.emit('render');
  await rejection;
  assert.equal(map.listenerCount(), 0);
  candidate.dispose();
});

test('a replaced MapLibre style cannot be shown or mutated by the old candidate cleanup', async () => {
  const {map, writes} = mapLibreFixture(); let current = true;
  const candidate = prepareMapLibreSatellite(map, OVERVIEW, () => current);
  const rejection = assert.rejects(candidate.ready, {name: 'AbortError'});
  const before = writes.length;
  current = false; map.loaded = true; map.emit('render');
  await rejection;
  assert.throws(() => candidate.show(), {name: 'AbortError'});
  candidate.dispose(); candidate.dispose();
  assert.equal(map.listenerCount(), 0);
  assert.equal(writes.length, before);
});

test('Leaflet keeps a candidate transparent until its current visible tile grid loads', async () => {
  const {layer, map, opacities} = leafletFixture(); let shown = 0;
  const candidate = prepareLeafletSatellite(layer, map, () => true, () => {shown++;});
  assert.equal(map.hasLayer(layer), true);
  assert.deepEqual(opacities, [0]);
  layer.emit('load'); await candidate.ready;
  assert.equal(shown, 0); assert.deepEqual(opacities, [0]);
  candidate.show(); assert.equal(shown, 1); assert.deepEqual(opacities, [0, 1]);
  assert.equal(layer.listenerCount(), 0);
  assert.equal(map.listenerCount(), 0);
  candidate.dispose(); candidate.dispose();
  assert.equal(layer.removals, 1); assert.equal(map.hasLayer(layer), false);
});

test('Leaflet tileerror followed by its normal load event cannot certify failed imagery', async () => {
  const {layer, map, opacities} = leafletFixture(); let shown = 0;
  const candidate = prepareLeafletSatellite(layer, map, () => true, () => {shown++;});
  const rejection = assert.rejects(candidate.ready, /Satellite tile failed/);
  layer.emit('tileerror'); layer.emit('load'); await rejection;
  assert.equal(layer.listenerCount(), 0);
  assert.equal(map.listenerCount(), 0);
  assert.deepEqual(opacities, [0]); assert.equal(shown, 0);
  candidate.dispose(); assert.equal(layer.removals, 1);
});

test('disposing pending Leaflet imagery rejects readiness and detaches late-load callbacks', async () => {
  const {layer, map, opacities} = leafletFixture(); let shown = 0;
  const candidate = prepareLeafletSatellite(layer, map, () => true, () => {shown++;});
  const rejection = assert.rejects(candidate.ready, {name: 'AbortError'});
  map.emit('moveend'); // Also cancel an already queued readiness check.
  candidate.dispose(); candidate.dispose(); await rejection;
  layer.emit('load'); layer.emit('tileerror');
  assert.throws(() => candidate.show(), {name: 'AbortError'});
  assert.equal(layer.removals, 1); assert.equal(layer.listenerCount(), 0);
  assert.equal(map.listenerCount(), 0);
  assert.deepEqual(opacities, [0]); assert.equal(shown, 0);
});

test('Leaflet ignores the previous moving grid and checks after the SDK moveend handler updates tiles', async () => {
  const {layer, map} = leafletFixture(); let moving = true, ready = false;
  const candidate = prepareLeafletSatellite(layer, map, () => true, () => {}, () => !moving);
  void candidate.ready.then(() => {ready = true;});
  layer.emit('load'); await Promise.resolve();
  assert.equal(ready, false, 'a load during a pan still describes the earlier grid');
  // The real GridLayer listener is attached during addTo, after the adapter's
  // listener; new tile requests begin later in the same moveend dispatch.
  const updateGrid = () => {layer.loading = true;};
  map.on('moveend', updateGrid);
  moving = false; map.emit('moveend'); await Promise.resolve();
  assert.equal(ready, false, 'readiness must wait for the newly requested current grid');
  layer.loading = false; layer.emit('load'); await candidate.ready;
  assert.equal(ready, true);
  map.off('moveend', updateGrid);
  assert.equal(map.listenerCount(), 0); assert.equal(layer.listenerCount(), 0);
  candidate.dispose();
});

test('Leaflet commits after a settled move that reuses complete tiles without a second load event', async () => {
  const {layer, map} = leafletFixture(); let moving = true, ready = false;
  const candidate = prepareLeafletSatellite(layer, map, () => true, () => {}, () => !moving);
  void candidate.ready.then(() => {ready = true;});
  layer.emit('load'); await Promise.resolve(); assert.equal(ready, false);
  moving = false; map.emit('moveend'); await candidate.ready;
  assert.equal(ready, true);
  assert.equal(map.listenerCount(), 0); assert.equal(layer.listenerCount(), 0);
  candidate.dispose();
});

test('both adapters bound a stalled tile load and remove listeners on timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const webgl = mapLibreFixture(), canvas = leafletFixture();
  const first = prepareMapLibreSatellite(webgl.map, OVERVIEW, () => true);
  const second = prepareLeafletSatellite(canvas.layer, canvas.map, () => true, () => assert.fail('Timed-out source was shown'));
  const failures = [assert.rejects(first.ready, /timed out/), assert.rejects(second.ready, /timed out/)];
  t.mock.timers.tick(19_999);
  assert.ok(webgl.map.listenerCount() > 0); assert.ok(canvas.layer.listenerCount() > 0);
  t.mock.timers.tick(1); await Promise.all(failures);
  assert.equal(webgl.map.listenerCount(), 0); assert.equal(canvas.layer.listenerCount(), 0);
  assert.equal(canvas.map.listenerCount(), 0);
  first.dispose(); second.dispose();
});
