import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const document = readFileSync(new URL('../../android/app/src/main/assets/landscape/landscape.html', import.meta.url), 'utf8');
const scripts = [...document.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const combined = scripts.at(-1);
const start = combined.lastIndexOf('\n(function(){\nconst canvas=');
assert.ok(start >= 0, 'Generated Android bootstrap must be present');
const bootstrap = combined.slice(start);
const flush = () => new Promise(resolve => setImmediate(resolve));

// Execute the real generated host lifecycle code with a controllable renderer.
// This proves cancellation/readiness/reuse; it does not emulate WebView or GPU.
function host(initialHeights = {}) {
  const events = new EventTarget(), preparations = [], renderers = [];
  const heights = {html: 620, body: 620, 'terrain-canvas': 620, ...initialHeights};
  events.innerHeight = 620;
  const node = (id) => ({dataset: {}, hidden: false, textContent: '', addEventListener() {},
    getBoundingClientRect: () => ({width: 360, height: heights[id] ?? 620, top: 0, bottom: 64})});
  const elements = new Map(['terrain-canvas', 'scene-status', 'zoom-in', 'zoom-out', 'reset'].map(id => [id, node(id)]));
  const document = {documentElement: node('html'), body: node('body'), getElementById: id => elements.get(id),
    querySelector: () => node(), fonts: {ready: Promise.resolve()}};
  class Renderer {
    constructor(canvas, grid, options) { this.options = options; this.visibility = []; this.destroyed = false; this.warmups = 0; renderers.push(this); }
    setGeometry() {} setViewportInsets() {} zoomBy() {} reset() {}
    setVisible(value) { this.visibility.push(value); }
    warmup() { this.warmups++; }
    destroy() { this.destroyed = true; }
  }
  const createTerrainModelAsync = (grid, {signal}) => new Promise((resolve, reject) => {
    preparations.push({grid, signal, resolve, reject});
    signal.addEventListener('abort', () => reject(new DOMException('Preparation stopped', 'AbortError')), {once: true});
  });
  const context = vm.createContext({document, window: events, Event, AbortController, TerrainRenderer: Renderer, createTerrainModelAsync});
  vm.runInContext(scripts[0], context);
  vm.runInContext(bootstrap, context);
  return {document, preparations, renderers, heights, viewport: events, dispatch: type => events.dispatchEvent(new Event(type))};
}

test('all generated scripts parse as classic offline WebView scripts', () => {
  assert.equal(scripts.length, 2);
  for (const script of scripts) new vm.Script(script);
});

test('a rendered canvas clipped by zero-height roots is not ready, including after viewport changes', async () => {
  // Real failed-device geometry: native viewport exists, CSS root height is 0,
  // and the canvas has only its old 240px minimum. Renderer callbacks still ran.
  const state = host({html: 0, body: 0, 'terrain-canvas': 240});
  state.viewport.innerHeight = 728;
  state.dispatch('tropnik-scene-resume');
  state.preparations[0].resolve({});
  await flush();
  const renderer = state.renderers[0];
  renderer.options.onRender();
  assert.equal(state.document.documentElement.dataset.sceneState, 'loading');
  assert.equal(state.document.getElementById('scene-status').hidden, false);
  for (const id of ['html', 'body', 'terrain-canvas']) state.heights[id] = 728;
  renderer.options.onRender();
  assert.equal(state.document.documentElement.dataset.sceneState, 'ready');
  state.viewport.innerHeight = 180;
  renderer.options.onRender();
  assert.equal(state.document.documentElement.dataset.sceneState, 'loading');
  for (const id of ['html', 'body', 'terrain-canvas']) state.heights[id] = 180;
  renderer.options.onRender();
  assert.equal(state.document.documentElement.dataset.sceneState, 'ready');
});

test('preparation waits for foreground, cancels on pause, then retains the first committed scene', async () => {
  const state = host();
  assert.equal(state.preparations.length, 0);
  assert.equal(state.document.documentElement.dataset.sceneState, 'loading');
  state.dispatch('tropnik-scene-resume');
  state.dispatch('tropnik-scene-resume');
  assert.equal(state.preparations.length, 1);
  state.dispatch('tropnik-scene-pause');
  assert.equal(state.preparations[0].signal.aborted, true);
  state.dispatch('tropnik-scene-resume');
  await flush();
  assert.equal(state.preparations.length, 2);
  assert.equal(state.renderers.length, 0);
  const prepared = {source: 'controlled-test-model'};
  state.preparations[1].resolve(prepared);
  await flush();
  const renderer = state.renderers[0];
  assert.equal(renderer.options.preparedModel, prepared);
  assert.equal(renderer.warmups, 1);
  assert.equal(state.document.documentElement.dataset.sceneState, 'loading');
  renderer.options.onRender();
  assert.equal(state.document.documentElement.dataset.sceneState, 'ready');
  state.dispatch('tropnik-scene-pause');
  assert.equal(renderer.visibility.at(-1), false);
  state.dispatch('tropnik-scene-resume');
  assert.equal(renderer.visibility.at(-1), true);
  assert.equal(state.renderers.length, 1);
  assert.equal(state.preparations.length, 2);
  state.dispatch('pagehide');
  assert.equal(renderer.destroyed, true);
});

test('leaving during preparation cannot create a detached renderer', async () => {
  const state = host();
  state.dispatch('tropnik-scene-resume');
  state.dispatch('pagehide');
  assert.equal(state.preparations[0].signal.aborted, true);
  state.preparations[0].resolve({});
  await flush();
  assert.equal(state.renderers.length, 0);
  assert.equal(state.document.documentElement.dataset.sceneState, 'loading');
});

test('a real preparation error is reported instead of enabling the scene', async () => {
  const state = host();
  state.dispatch('tropnik-scene-resume');
  state.preparations[0].reject(new Error('Invalid DEM'));
  await flush();
  assert.equal(state.document.documentElement.dataset.sceneState, 'failed');
  assert.equal(state.renderers.length, 0);
});

test('fatal graphics failure after ready invalidates the document and never reuses its renderer', async () => {
  const state = host();
  state.dispatch('tropnik-scene-resume');
  state.preparations[0].resolve({});
  await flush();
  const renderer = state.renderers[0];
  renderer.options.onRender();
  assert.equal(state.document.documentElement.dataset.sceneState, 'ready');
  renderer.options.onFatal('Graphics context cannot recover');
  assert.equal(state.document.documentElement.dataset.sceneState, 'failed');
  assert.equal(renderer.destroyed, true);
  state.dispatch('tropnik-scene-pause');
  state.dispatch('tropnik-scene-resume');
  renderer.options.onRender(); // A stale frame callback must not restore readiness.
  assert.equal(state.document.documentElement.dataset.sceneState, 'failed');
  assert.equal(state.renderers.length, 1);
  assert.equal(state.preparations.length, 1);
  // Native retry loads a fresh verified document into a new WebView.
  const replacement = host();
  replacement.dispatch('tropnik-scene-resume');
  replacement.preparations[0].resolve({});
  await flush();
  replacement.renderers[0].options.onRender();
  assert.equal(replacement.document.documentElement.dataset.sceneState, 'ready');
  assert.notEqual(replacement.renderers[0], renderer);
});

test('a global document failure after ready cannot be undone by a late frame callback', async () => {
  const state = host();
  state.dispatch('tropnik-scene-resume');
  state.preparations[0].resolve({});
  await flush();
  const renderer = state.renderers[0];
  renderer.options.onRender();
  state.dispatch('error');
  renderer.options.onRender();
  assert.equal(state.document.documentElement.dataset.sceneState, 'failed');
  assert.equal(renderer.destroyed, true);
  state.dispatch('tropnik-scene-resume');
  assert.equal(state.renderers.length, 1);
});
