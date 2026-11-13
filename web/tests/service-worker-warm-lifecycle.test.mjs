import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {rewriteScript} from '../../tools/pages-preview/paths.mjs';

const root = new URL('../public/', import.meta.url), source = await readFile(new URL('sw.js', root), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let now = 0, serial = 0; const timers = new Map();
  return {timers, setTimeout(callback, delay) {const id = ++serial; timers.set(id, {callback, at: now + delay}); return id;}, clearTimeout(id) {timers.delete(id);},
    async advance(duration) {const end = now + duration; for (;;) {const next = [...timers].find(([, timer]) => timer.at <= end); if (!next) break; const [id, timer] = next; timers.delete(id); now = timer.at; timer.callback(); await turn();} now = end; await turn();}};
}
function worker({base = '/', ignoreAbort = false} = {}) {
  const handlers = {}, timers = clock(), requests = [], writes = [], removed = [];
  const userPack = new Map([['saved-route', 'unchanged verified user pack']]), saved = new Map([[base + 'offline-safety.html', 'installed emergency shell']]);
  let hang = true;
  const block = signal => new Promise((resolve, reject) => {const request = {signal, resolve, reject}; requests.push(request); if (signal && !ignoreAbort) signal.addEventListener('abort', () => reject(signal.reason), {once: true});});
  const cache = {async match(path) {return saved.has(path) ? new Response(saved.get(path)) : undefined;}, async put(path, response) {writes.push(path); saved.set(path, new Uint8Array(await response.arrayBuffer()));}, async addAll(paths) {if (hang) return block(); for (const path of paths) saved.set(path, 'public asset');}};
  const context = vm.createContext({
    self: {addEventListener(name, handler) {handlers[name] = handler;}, skipWaiting: async () => {}},
    caches: {open: async () => cache, keys: async () => ['tropnik-map-saved'], delete: async name => {removed.push(name); return true;}},
    AbortController, DOMException, Response, Uint8Array, crypto: webcrypto, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    async fetch(path, options) {
      if (hang) return block(options?.signal);
      assert.ok(path.startsWith(base)); const response = new Response(await readFile(new URL(path.slice(base.length), root))); Object.defineProperty(response, 'type', {value: 'basic'}); return response;
    },
  });
  vm.runInContext(base === '/' ? source : rewriteScript(source, 'sw.js', {base}), context);
  const message = type => {let pending; handlers.message({data: {type, engine: 'canvas'}, waitUntil(value) {pending = value;}}); return pending || Promise.resolve();};
  return {timers, requests, writes, removed, saved, userPack, message, connect() {hang = false;}};
}

test('optional warmup has one total deadline even when its transport ignores AbortSignal', async t => {
  for (const base of ['/', '/tropnik/']) await t.test(base, async () => {
    const env = worker({base, ignoreAbort: true}); let ended = false;
    const pending = env.message('warm-map'); pending.then(() => {ended = true;}, () => {ended = true;}); await turn();
    assert.equal(ended, false); await env.timers.advance(30000);
    assert.equal(ended, true, 'Optional warmup cannot hold an old active worker indefinitely');
    assert.ok(env.requests.every(request => request.signal?.aborted), 'Every optional network read receives cancellation');
    for (const request of env.requests) {const response = new Response('late bytes'); Object.defineProperty(response, 'type', {value: 'basic'}); request.resolve(response);}
    await turn(); assert.equal(env.timers.timers.size, 0); assert.equal(env.writes.length, 0, 'Late bytes cannot revive a cancelled warmup');
    assert.equal(env.userPack.get('saved-route'), 'unchanged verified user pack'); assert.deepEqual(env.removed, []);
    assert.ok(![...env.saved.keys()].some(path => path.includes('/_offline/map-warm-')));
  });
});

test('an explicit update cancels all warmup reads and a late idle message cannot restart them', async () => {
  const env = worker(); let ended = false;
  const pending = env.message('warm-map'); pending.then(() => {ended = true;}, () => {ended = true;}); await turn();
  const started = env.requests.length; assert.ok(started > 0); await env.message('cancel-map-warm'); await turn();
  assert.equal(ended, true); assert.ok(env.requests.every(request => request.signal?.aborted)); assert.equal(env.timers.timers.size, 0);
  await env.message('warm-map'); assert.equal(env.requests.length, started);
  assert.equal(env.saved.get('/offline-safety.html'), 'installed emergency shell'); assert.deepEqual(env.removed, []);
});

test('a deadline failure remains retryable and only a complete verified retry writes the ready marker', async () => {
  const env = worker(); let ended = false;
  env.message('warm-map').then(() => {ended = true;}, () => {ended = true;}); await turn(); await env.timers.advance(30000);
  assert.equal(ended, true); assert.ok(![...env.saved.keys()].some(path => path.includes('/_offline/map-warm-')));
  env.connect(); await env.message('warm-map');
  assert.equal([...env.saved.keys()].filter(path => path.includes('/_offline/map-warm-')).length, 1);
  assert.ok(env.saved.has('/maps/russia-relief/4/15/15.png')); assert.ok(env.saved.has('/custom-map/map-runtime.js'));
  assert.equal(env.userPack.get('saved-route'), 'unchanged verified user pack'); assert.deepEqual(env.removed, []); assert.equal(env.timers.timers.size, 0);
});

test('the successor can warm its own verified map after accepting activation', async () => {
  const env = worker(); await env.message('skip-waiting'); env.connect(); await env.message('warm-map');
  assert.equal([...env.saved.keys()].filter(path => path.includes('/_offline/map-warm-')).length, 1, 'Only retiring controllers suppress later idle work');
  assert.ok(env.saved.has('/maps/russia-relief/4/15/15.png')); assert.deepEqual(env.removed, []);
});
