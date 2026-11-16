import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {rewriteScript} from '../../tools/pages-preview/paths.mjs';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://map-delivery.invalid';
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};

// Execute the deployed fetch handler. Only network body delivery and the
// storage commit are controlled; the response is an actual streamed Response.
function worker(base = '/', {status = 200, failWrite = false} = {}) {
  const handlers = {}, stored = new Map(), writes = [], requests = [];
  const commit = deferred();
  let stream;
  const network = new Response(new ReadableStream({start(controller) {stream = controller;}}), {
    status, headers: {'Content-Type': 'image/png', 'X-Source-Bytes': 'unchanged'},
  });
  Object.defineProperty(network, 'type', {value: 'basic'});
  const key = request => {const url = new URL(typeof request === 'string' ? request : request.url, origin); return url.pathname + url.search;};
  const cache = {
    async match(request) {return stored.get(key(request))?.clone();},
    async put(request, response) {
      writes.push(key(request));
      const bytes = await response.arrayBuffer();
      if (failWrite) throw new Error('Quota exceeded');
      await commit.promise;
      stored.set(key(request), new Response(bytes, {status: response.status, headers: response.headers}));
    },
  };
  vm.runInNewContext(base === '/' ? source : rewriteScript(source, 'sw.js', {base}), {
    self: {location: {origin}, addEventListener(name, handler) {handlers[name] = handler;}},
    URL, Response, caches: {async open() {return cache;}},
    async fetch(request) {requests.push(request); return network;},
  });
  const get = (path, cacheMode = 'default') => {
    let response, lifetime;
    handlers.fetch({request: new Request(new URL(path, origin + base), {cache: cacheMode}),
      respondWith(work) {response = work;}, waitUntil(work) {lifetime = work;}});
    return {response, lifetime};
  };
  return {get, stored, writes, requests, commit,
    chunk(bytes) {stream.enqueue(new Uint8Array(bytes));}, end() {stream.close();},
  };
}

test('a cold map asset streams immediately while its owned offline write is still pending', async t => {
  for (const base of ['/', '/tropnik/']) for (const path of ['maps/russia-relief/4/9/5.png', 'assets/map.js', 'terrain/terrain-grid.json']) {
    await t.test(base + path, async () => {
      const env = worker(base), request = env.get(path);
      let delivered = false, completed = false;
      request.response.then(() => {delivered = true;});
      request.lifetime.then(() => {completed = true;});
      await turn();
      assert.equal(delivered, true, 'Headers must not wait for the network body or Cache.put');
      assert.equal(completed, false, 'FetchEvent owns the still-pending cache operation');
      const response = await request.response, reader = response.body.getReader();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-Source-Bytes'), 'unchanged');
      env.chunk([137, 80, 78, 71]);
      assert.deepEqual(await reader.read(), {done: false, value: new Uint8Array([137, 80, 78, 71])});
      assert.equal(env.stored.size, 0);
      env.chunk([13, 10, 26, 10]); env.end();
      assert.deepEqual(await reader.read(), {done: false, value: new Uint8Array([13, 10, 26, 10])});
      assert.equal((await reader.read()).done, true);
      await turn(); assert.equal(completed, false, 'Disk commit may lag behind complete foreground consumption');
      env.commit.resolve(); await request.lifetime;
      assert.equal(completed, true);
      assert.deepEqual(env.writes, [base + path]);
      const revisit = env.get(path);
      assert.deepEqual(new Uint8Array(await (await revisit.response).arrayBuffer()), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      await revisit.lifetime;
      assert.equal(env.requests.length, 1, 'Completed bytes remain available from the offline cache');
    });
  }
});

test('map cache quota failures do not reject or modify a successful visible response', async t => {
  for (const base of ['/', '/tropnik/']) await t.test(base, async () => {
    const env = worker(base, {failWrite: true}), request = env.get('maps/russia-relief/4/9/5.png');
    env.chunk([1, 2, 3, 4]); env.end();
    const response = await request.response;
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
    await request.lifetime;
    assert.equal(env.stored.size, 0);
  });
});

test('no-store and HTTP failures retain their exact response without starting an offline write', async t => {
  for (const base of ['/', '/tropnik/']) for (const [status, cacheMode] of [[200, 'no-store'], [503, 'reload']]) {
    await t.test(base + status + ' ' + cacheMode, async () => {
      const env = worker(base, {status}), request = env.get('maps/russia-relief/4/9/5.png', cacheMode);
      env.chunk([5, 0, 3]); env.end();
      const response = await request.response;
      assert.equal(response.status, status);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([5, 0, 3]));
      await request.lifetime;
      assert.deepEqual(env.writes, []); assert.equal(env.stored.size, 0);
    });
  }
});

test('reload uses fresh bytes immediately and retains them after the independent write finishes', async t => {
  for (const base of ['/', '/tropnik/']) await t.test(base, async () => {
    const env = worker(base), path = 'assets/map.js';
    env.stored.set(base + path, new Response('old'));
    const request = env.get(path, 'reload');
    env.chunk([110, 101, 119]); env.end();
    assert.equal(await (await request.response).text(), 'new');
    assert.equal(await env.stored.get(base + path).clone().text(), 'old');
    env.commit.resolve(); await request.lifetime;
    assert.equal(await env.stored.get(base + path).text(), 'new');
  });
});
