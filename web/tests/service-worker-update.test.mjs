import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as registrationTools from '../lib/service-worker-registration.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
class Surface extends EventTarget {
  listeners = new Map();
  addEventListener(name, listener, options) {super.addEventListener(name, listener, options); if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(listener);}
  removeEventListener(name, listener, options) {super.removeEventListener(name, listener, options); this.listeners.get(name)?.delete(listener);}
  emit(name) {this.dispatchEvent(new Event(name));}
  count() {return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);}
}
function worker(state = 'installed') {
  return Object.assign(new Surface(), {state, messages: [], postMessage(message) {if (this.postError) throw this.postError; this.messages.push(message);}});
}
function clock() {
  let now = 0, serial = 0;
  const timers = new Map();
  return {timers, setTimeout(callback, delay = 0) {const id = ++serial; timers.set(id, {callback, at: now + delay}); return id;}, clearTimeout(id) {timers.delete(id);},
    async advance(duration) {const end = now + duration; for (;;) {const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [id, timer] = next; now = timer.at; timers.delete(id); timer.callback(); await turn();} now = end; await turn();}};
}

// Run the component's real effects, JSX and click handler with actual
// registration/update lifecycle code. Only browser delivery and time are held.
function host() {
  const hooks = [], effects = [], timers = clock();
  let cursor = 0, dirty = false, disposed = false, tree, reloads = 0;
  const active = worker('activated'), waiting = worker(), registration = Object.assign(new Surface(), {active, waiting, installing: null, updates: 0, async update() {this.updates++; return this;}});
  const serviceWorker = Object.assign(new Surface(), {controller: active, register: async () => registration});
  const window = Object.assign(new Surface(), {isSecureContext: true, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, matchMedia: () => ({matches: false})});
  const document = Object.assign(new Surface(), {hidden: false, readyState: 'complete', querySelector: () => ({})});
  const react = {
    useRef(initial) {return hooks[cursor++] ??= {current: initial};},
    useState(initial) {const index = cursor++; if (!hooks[index]) hooks[index] = {value: initial}; return [hooks[index].value, value => {if (disposed) return; const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) {hooks[index].value = next; dirty = true;}}];},
    useEffect(callback, deps) {const index = cursor++, previous = hooks[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {hooks[index] = {deps}; effects.push(() => {hooks[index].cleanup = callback();});}},
  };
  const jsx = (type, props) => ({type, props: props || {}}), loaded = {exports: {}};
  const dependencies = {'react': react, 'react/jsx-runtime': {jsx, jsxs: jsx}, '@/lib/service-worker-registration': registrationTools};
  const source = ts.transpileModule(readFileSync(new URL('../components/ServiceWorker.tsx', import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText;
  const context = vm.createContext({window, document, navigator: {serviceWorker, onLine: true}, location: {reload() {reloads++;}}, Date, Error, queueMicrotask, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout});
  vm.runInContext(`(function(require,module,exports){${source}\n})`, context)(id => {assert.ok(dependencies[id], id); return dependencies[id];}, loaded, loaded.exports);
  const render = () => {do {cursor = 0; dirty = false; tree = loaded.exports.ServiceWorker(); while (effects.length) effects.shift()();} while (dirty);};
  const nodes = () => {const values = []; const visit = node => {if (Array.isArray(node)) node.forEach(visit); else if (node && typeof node === 'object') {values.push(node); visit(node.props.children);}}; visit(tree); return values;};
  const textOf = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join(' ') : node && typeof node === 'object' ? textOf(node.props.children) : '';
  const button = label => nodes().find(node => node.type === 'button' && textOf(node) === label);
  render();
  return {active, waiting, registration, serviceWorker, timers, button, text: () => textOf(tree), reloads: () => reloads,
    async ready() {await timers.advance(1400); render(); assert.match(textOf(tree), /Доступна свежая версия/);},
    click(label) {const target = button(label); assert.ok(target, `Missing ${label}`); assert.ok(!target.props.disabled, `${label} is disabled`); target.props.onClick(); render();},
    async advance(ms) {await timers.advance(ms); render();},
    async settle() {await turn(); render();},
    changeController(value) {serviceWorker.controller = value; serviceWorker.emit('controllerchange'); render();},
    replaceWaiting() {const next = worker('installing'); registration.installing = next; registration.emit('updatefound'); waiting.state = 'redundant'; waiting.emit('statechange'); registration.waiting = next; registration.installing = null; next.state = 'installed'; next.emit('statechange'); render(); return next;},
    unmount() {disposed = true; for (const hook of hooks) hook?.cleanup?.();},
  };
}

test('an accepted update shows bounded progress, cancels optional warming and reloads once only after a new controller', async t => {
  const env = host(); t.after(() => env.unmount()); await env.ready(); env.click('Обновить');
  assert.equal(env.button('Обновляем…')?.props.disabled, true);
  assert.ok(env.active.messages.some(message => message.type === 'cancel-map-warm'));
  assert.equal(env.waiting.messages.filter(message => message.type === 'skip-waiting').length, 1);
  assert.equal(env.reloads(), 0); await env.advance(1400);
  assert.ok(!env.active.messages.some(message => message.type === 'warm-map'), 'Deferred warmup cannot start behind an accepted update');
  env.registration.active = env.waiting; env.registration.waiting = null; env.waiting.state = 'activated'; env.changeController(env.waiting); env.changeController(env.waiting);
  assert.equal(env.reloads(), 1);
});

test('a missing controller transition times out visibly and a late or foreign activation never reloads without renewed consent', async t => {
  const env = host(); t.after(() => env.unmount()); await env.ready(); env.click('Обновить'); await env.advance(30000);
  assert.match(env.text(), /Не удалось обновить/); assert.ok(env.button('Повторить')); assert.equal(env.reloads(), 0);
  env.registration.active = env.waiting; env.registration.waiting = null; env.waiting.state = 'activated'; env.changeController(env.waiting);
  assert.equal(env.reloads(), 0, 'Timed-out consent cannot trigger a late page reload');
  env.click('Повторить'); assert.equal(env.reloads(), 1, 'A new click may reload the controller that actually changed');
});

test('replacing an already requested waiting worker targets its successor once within the same deadline', async t => {
  const env = host(); t.after(() => env.unmount()); await env.ready(); env.click('Обновить');
  const next = env.replaceWaiting(); await env.settle();
  assert.equal(next.messages.filter(message => message.type === 'skip-waiting').length, 1);
  next.emit('statechange'); await env.settle(); assert.equal(next.messages.filter(message => message.type === 'skip-waiting').length, 1);
  env.registration.active = next; env.registration.waiting = null; next.state = 'activated'; env.changeController(next); assert.equal(env.reloads(), 1);
});

test('waiting becoming active before controllerchange keeps its activation attempt alive', async t => {
  const env = host(); t.after(() => env.unmount()); await env.ready(); env.click('Обновить');
  env.registration.active = env.waiting; env.registration.waiting = null; env.waiting.state = 'activating'; env.waiting.emit('statechange'); await env.settle();
  assert.equal(env.button('Обновляем…')?.props.disabled, true, 'Activation precedes controller delivery and is not a vanished update');
  assert.equal(env.registration.updates, 0); assert.equal(env.reloads(), 0);
  env.waiting.state = 'activated'; env.waiting.emit('statechange'); await env.settle();
  assert.equal(env.button('Обновляем…')?.props.disabled, true); assert.equal(env.reloads(), 0);
  env.changeController(env.waiting); assert.equal(env.reloads(), 1);
});

test('a removed update cannot reload the old controller or leave a stale manual reload request armed', async t => {
  const env = host(); t.after(() => env.unmount()); await env.ready();
  env.waiting.state = 'redundant'; env.registration.waiting = null; env.click('Обновить'); await env.settle();
  assert.equal(env.reloads(), 0); assert.match(env.text(), /Не удалось обновить/); assert.ok(env.button('Повторить'));
  env.changeController(worker('activated')); assert.equal(env.reloads(), 0);
});

test('a rejected update message exposes retry and cleanup detaches the requested worker', async t => {
  const env = host(); t.after(() => env.unmount()); await env.ready(); env.waiting.postError = new Error('Worker became redundant');
  assert.doesNotThrow(() => env.click('Обновить')); assert.match(env.text(), /Не удалось обновить/);
  env.waiting.postError = null; env.click('Повторить'); assert.equal(env.button('Обновляем…')?.props.disabled, true);
  env.unmount(); assert.equal(env.waiting.count(), 0); assert.equal(env.serviceWorker.count(), 0); assert.equal(env.timers.timers.size, 0);
  env.changeController(env.waiting); await env.advance(30000); assert.equal(env.reloads(), 0);
});

test('a foreign activation announces availability and still requires the user to request the page reload', async t => {
  const env = host(); t.after(() => env.unmount()); await env.ready();
  const fresh = worker('activated'); env.registration.waiting = null; env.registration.active = fresh; env.changeController(fresh);
  assert.equal(env.reloads(), 0); env.click('Обновить'); assert.equal(env.reloads(), 1);
});
