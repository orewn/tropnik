import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {ApiError, isAbort, errorText} from '../lib/api.ts';
import {API_TRANSPORT_LIMITS} from '../lib/api-transport.ts';
import {mergeMessages} from '../lib/trip-policy.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
class Surface extends EventTarget {
  listeners = new Map();
  addEventListener(name, listener, options) {if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(listener); super.addEventListener(name, listener, options);}
  removeEventListener(name, listener, options) {this.listeners.get(name)?.delete(listener); super.removeEventListener(name, listener, options);}
  emit(name) {this.dispatchEvent(new Event(name));}
  count() {return [...this.listeners.values()].reduce((sum, list) => sum + list.size, 0);}
}
function clock() {
  let now = 0, serial = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay = 0) {const id = ++serial; timers.set(id, {callback, at: now + delay}); return id;},
    clearTimeout(id) {timers.delete(id);},
    async advance(duration) {
      const end = now + duration;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.at; timers.delete(id); timer.callback(); await turn();
      }
      now = end; await turn();
    },
  };
}

// Execute the actual TSX effects, callbacks and JSX. Only React scheduling,
// browser visibility/connectivity, timers and network delivery are controlled.
function host(file, name, api, timers = clock()) {
  const hooks = [], pending = [];
  let cursor = 0, dirty = false, props, tree, disposed = false;
  const changed = (before, after) => !before || !after || after.some((value, index) => !Object.is(value, before[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = {value: typeof initial === 'function' ? initial() : initial};
      return [hooks[index].value, value => {if (disposed) return; const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) {hooks[index].value = next; dirty = true;}}];
    },
    useRef(initial) {return hooks[cursor++] ??= {current: initial};},
    useCallback(callback, deps) {const index = cursor++; if (changed(hooks[index]?.deps, deps)) hooks[index] = {value: callback, deps}; return hooks[index].value;},
    useEffect(callback, deps) {const index = cursor++, previous = hooks[index]; if (changed(previous?.deps, deps)) {hooks[index] = {deps, cleanup: previous?.cleanup}; pending.push(() => {hooks[index].cleanup?.(); hooks[index].cleanup = callback();});}},
  };
  const jsx = (type, props, key) => ({type, props: props || {}, key});
  const window = new Surface(), document = Object.assign(new Surface(), {hidden: false}), navigator = {onLine: true};
  const dependencies = {'react': react, 'react/jsx-runtime': {jsx, jsxs: jsx, Fragment: 'fragment'}, '@/components/TropnikIcons': {}, '@/lib/api': {api, ApiError, isAbort, errorText}, '@/lib/trip-policy': {mergeMessages}, '@/lib/api-transport': {API_TRANSPORT_LIMITS}, './ReportDialog': {ReportDialog: 'report'}};
  const source = ts.transpileModule(readFileSync(new URL('../components/' + file, import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText;
  const context = vm.createContext({AbortController, DOMException, Error, window, document, navigator, crypto: globalThis.crypto, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout});
  const loaded = {exports: {}};
  vm.runInContext(`(function(require,module,exports){${source}\n})`, context)(id => {assert.ok(dependencies[id], id); return dependencies[id];}, loaded, loaded.exports);
  const nodes = () => {const list = []; const visit = node => {if (Array.isArray(node)) node.forEach(visit); else if (node && typeof node === 'object') {list.push(node); visit(node.props?.children);}}; visit(tree); return list;};
  const text = () => {const visit = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(visit).join(' ') : node && typeof node === 'object' ? visit(node.props?.children) : ''; return visit(tree);};
  const render = (next = props) => {props = next; do {dirty = false; cursor = 0; tree = loaded.exports[name](props); for (const effect of pending.splice(0)) effect();} while (dirty); return tree;};
  return {window, document, navigator, timers, render, nodes, text,
    async settle() {await turn(); render();},
    click(label) {const button = nodes().find(node => node.type === 'button' && node.props['aria-label'] === label); assert.ok(button); assert.ok(!button.props.disabled); button.props.onClick(); render();},
    unmount() {disposed = true; for (const hook of hooks) hook?.cleanup?.();},
  };
}

function chatNetwork(timers, {latency = 11000, honourAbort = true} = {}) {
  const calls = []; let active = 0, maximum = 0;
  const api = (path, {signal}) => {
    const wait = deferred(), call = {...wait, path, signal, finished: false}; calls.push(call); active++; maximum = Math.max(maximum, active);
    const finish = (error, messages = []) => {
      if (call.finished) return;
      call.finished = true; active--; timers.clearTimeout(call.timer);
      if (error) wait.reject(error); else wait.resolve(messages);
    };
    call.finish = finish;
    if (latency !== null) call.timer = timers.setTimeout(() => finish(), latency);
    signal.addEventListener('abort', () => {if (honourAbort) finish(signal.reason);}, {once: true});
    return wait.promise;
  };
  return {api, calls, active: () => active, maximum: () => maximum};
}

test('an 11-second chat response completes and subsequent polls, refresh and foreground triggers never overlap it', async t => {
  const timers = clock(), network = chatNetwork(timers), view = host('ChatPanel.tsx', 'ChatPanel', network.api, timers);
  t.after(() => view.unmount()); view.render({kind: 'departures', id: 'trip', user: {id: 'person'}});
  assert.equal(network.calls.length, 1);
  await timers.advance(10000); view.render(); assert.equal(network.calls.length, 1); assert.equal(network.calls[0].signal.aborted, false);
  await timers.advance(1000); view.render(); assert.equal(network.calls[0].finished, true); assert.doesNotMatch(view.text(), /Загружаем сообщения/);
  await timers.advance(10000); view.render(); assert.equal(network.calls.length, 2);
  view.click('Обновить сообщения'); view.window.emit('online'); view.document.emit('visibilitychange');
  assert.equal(network.calls.length, 2); assert.equal(network.calls[1].signal.aborted, false);
  await timers.advance(11000); view.render(); assert.equal(network.calls[1].finished, true); assert.equal(network.maximum(), 1);
});

test('chat polling pauses while hidden/offline, resumes once and releases timers, reads and listeners on unmount', async () => {
  const timers = clock(), network = chatNetwork(timers, {latency: 1}), view = host('ChatPanel.tsx', 'ChatPanel', network.api, timers);
  view.render({kind: 'departures', id: 'trip', user: {id: 'person'}}); await timers.advance(1); view.render();
  view.document.hidden = true; view.document.emit('visibilitychange'); await timers.advance(100000); assert.equal(network.calls.length, 1);
  view.document.hidden = false; view.document.emit('visibilitychange'); assert.equal(network.calls.length, 2);
  view.navigator.onLine = false; view.window.emit('offline'); await timers.advance(100000); assert.equal(network.calls.length, 2);
  view.navigator.onLine = true; view.window.emit('online'); view.window.emit('online'); assert.equal(network.calls.length, 3);
  view.unmount(); await turn();
  assert.equal(network.calls[2].signal.aborted, true); assert.equal(network.active(), 0); assert.equal(timers.timers.size, 0);
  assert.equal(view.window.count(), 0); assert.equal(view.document.count(), 0);
});

test('conversation and account changes abort old reads and late private results cannot enter the new scope', async t => {
  const timers = clock(), network = chatNetwork(timers, {latency: null, honourAbort: false}), view = host('ChatPanel.tsx', 'ChatPanel', network.api, timers);
  t.after(() => view.unmount());
  view.render({kind: 'departures', id: 'trip-a', user: {id: 'person-a'}});
  view.render({kind: 'departures', id: 'trip-b', user: {id: 'person-a'}});
  assert.equal(network.calls[0].signal.aborted, true); assert.equal(network.calls.length, 2);
  network.calls[0].finish(null, [{id: 'secret', body: 'OLD PRIVATE BODY', createdAt: '2026-11-13T00:00:00Z', visibility: 'visible'}]); await view.settle();
  assert.doesNotMatch(view.text(), /OLD PRIVATE BODY/);
  view.render({kind: 'departures', id: 'trip-b', user: {id: 'person-b'}});
  assert.equal(network.calls[1].signal.aborted, true); assert.equal(network.calls.length, 3);
  network.calls[1].finish(new ApiError(403, 'denied', 'OLD ACCOUNT ERROR')); await view.settle();
  assert.doesNotMatch(view.text(), /OLD ACCOUNT ERROR/);
  network.calls[2].finish(null, [{id: 'current', body: 'CURRENT PRIVATE BODY', createdAt: '2026-11-13T00:00:00Z', visibility: 'visible'}]); await view.settle();
  assert.match(view.text(), /CURRENT PRIVATE BODY/); assert.doesNotMatch(view.text(), /OLD PRIVATE BODY|OLD ACCOUNT ERROR/);
});

test('a guide review error arriving after selection changes cannot replace the current guide reviews', async t => {
  const pending = [], guides = ['a', 'b'].map(id => ({id, displayName: 'Guide ' + id, activities: [], completedTrips: 0, rating: null, reviewCount: 0}));
  const api = (path, init) => {
    if (path === 'guides') return Promise.resolve(guides);
    const wait = deferred(); pending.push({...wait, path, signal: init.signal}); return wait.promise;
  };
  const view = host('GuideDirectory.tsx', 'GuideDirectory', api); t.after(() => view.unmount()); view.render({}); await view.settle();
  const buttons = () => view.nodes().filter(node => node.type === 'button' && node.props['aria-expanded'] !== undefined);
  buttons()[0].props.onClick(); view.render(); buttons()[1].props.onClick(); view.render();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve([{id: 'review-b', body: 'CURRENT GUIDE REVIEW', rating: 5, createdAt: '2026-11-13T00:00:00Z'}]); await view.settle();
  pending[0].reject(new ApiError(502, 'invalid_response', 'STALE GUIDE ERROR')); await view.settle();
  assert.match(view.text(), /CURRENT GUIDE REVIEW/); assert.doesNotMatch(view.text(), /STALE GUIDE ERROR/);
});
