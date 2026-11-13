import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {rewriteCSS, rewriteScript} from '../../tools/pages-preview/paths.mjs';

const publicRoot = new URL('../public/', import.meta.url);
const source = await readFile(new URL('sw.js', publicRoot), 'utf8');
const origin = 'https://offline-shell-fixture.invalid';
const assets = await Promise.all([
  ['offline-safety.js', 'text/javascript'],
  ['offline-safety.css', 'text/css'],
  ['offline-fonts.css', 'text/css'],
].map(async ([path, type]) => ({path, type, body: await readFile(new URL(path, publicRoot), 'utf8')})));

function worker(base) {
  const handlers = {}, requests = [], reads = [], writes = [];
  const stored = new Map(assets.map(asset => {
    const body = base === '/' ? asset.body : asset.path.endsWith('.css')
      ? rewriteCSS(asset.body, base) : rewriteScript(asset.body, asset.path, {base});
    return [base + asset.path, new Response(body, {headers: {'Content-Type': asset.type}})];
  }));
  let online = false, payload = '', status = 200;
  const key = request => {const url = new URL(typeof request === 'string' ? request : request.url, origin); return url.pathname + url.search;};
  const cache = {
    async match(request) {reads.push(key(request)); return stored.get(key(request))?.clone();},
    async put(request, response) {writes.push(key(request)); stored.set(key(request), response.clone());},
  };
  vm.runInNewContext(base === '/' ? source : rewriteScript(source, 'sw.js', {base}), {
    self: {location: {origin}, addEventListener(name, handler) {handlers[name] = handler;}},
    URL, Response, caches: {async open() {return cache;}},
    async fetch(request) {
      requests.push(request);
      if (!online) throw new Error('Offline transport failure');
      const response = new Response(payload, {status, headers: {'Content-Type': 'text/javascript'}});
      Object.defineProperty(response, 'type', {value: 'basic'});
      return response;
    },
  });
  async function get(path, cacheMode = 'default', options = {}) {
    let result;
    handlers.fetch({request: new Request(new URL(path, origin + base), {cache: cacheMode, ...options}),
      respondWith(value) {result = value;}});
    return result;
  }
  return {get, stored, requests, reads, writes,
    network(value, body = '', responseStatus = 200) {online = value; payload = body; status = responseStatus;},
  };
}

test('forced refresh retains the installed emergency JS and CSS after a real network rejection', async t => {
  for (const base of ['/', '/tropnik/']) for (const cacheMode of ['no-store', 'reload']) {
    await t.test(base + ' ' + cacheMode, async () => {
      const env = worker(base);
      for (const asset of assets) {
        const expected = await env.stored.get(base + asset.path).clone().text();
        const response = await env.get(asset.path, cacheMode);
        assert.equal(await response.text(), expected, 'the exact installed dependency must remain available offline');
        assert.equal(response.headers.get('Content-Type'), asset.type);
      }
      assert.equal(env.requests.length, assets.length, 'explicit refresh still attempts the network first');
      assert.ok(env.requests.every(request => request.cache === cacheMode));
      assert.deepEqual(env.reads, assets.map(asset => base + asset.path));
      assert.deepEqual(env.writes, [], 'a failed refresh must not replace installed bytes');
    });
  }
});

test('connected shell refresh honors no-store and reload without hiding HTTP errors', async t => {
  for (const base of ['/', '/tropnik/']) await t.test(base, async () => {
    const env = worker(base), path = 'offline-safety.js';
    const previous = await env.stored.get(base + path).clone().text();
    const fresh = previous + '\n// refreshed shell fixture\n';
    env.network(true, fresh);
    assert.equal(await (await env.get(path, 'no-store')).text(), fresh);
    assert.equal(await env.stored.get(base + path).clone().text(), previous);
    assert.deepEqual(env.reads, []);
    assert.deepEqual(env.writes, []);
    assert.equal(await (await env.get(path, 'reload')).text(), fresh);
    assert.deepEqual(env.writes, [base + path]);
    env.network(false);
    assert.equal(await (await env.get(path)).text(), fresh);
    env.network(true, 'Service unavailable', 503);
    const failed = await env.get(path, 'reload');
    assert.equal(failed.status, 503);
    assert.equal(await failed.text(), 'Service unavailable');
    assert.equal(await env.stored.get(base + path).clone().text(), fresh);
  });
});

test('offline refresh cannot substitute an absent shell, other cached assets or private API data', async t => {
  for (const base of ['/', '/tropnik/']) for (const cacheMode of ['no-store', 'reload']) {
    await t.test(base + ' ' + cacheMode, async () => {
      const env = worker(base);
      env.stored.delete(base + 'offline-safety.js');
      await assert.rejects(env.get('offline-safety.js', cacheMode), /Offline transport failure/);
      env.stored.set(base + 'assets/unrelated.js', new Response('stale unrelated asset'));
      await assert.rejects(env.get('assets/unrelated.js', cacheMode), /Offline transport failure/);
      const before = {requests: env.requests.length, reads: env.reads.length, writes: env.writes.length};
      env.stored.set(base + 'api/emergency-card', new Response('private fixture'));
      assert.equal(await env.get('api/emergency-card', cacheMode), undefined);
      assert.deepEqual({requests: env.requests.length, reads: env.reads.length, writes: env.writes.length}, before);
    });
  }
});
