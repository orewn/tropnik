import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {rewriteScript} from '../../tools/pages-preview/paths.mjs';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://trail-cache-fixture.invalid';
const overlay = 'data/trail-overlay-0123456789abcdef.json';

function worker({base = '/', limits, failWrite = false} = {}) {
  const handlers = {}, requests = [];
  const stored = new Map([
    [base + 'offline-safety.html', new Response('emergency shell')],
    [base + 'data/map-coverage/cells/existing.coverage', new Response('coverage cell')],
  ]);
  let online = true, payload = '{"track":1}', status = 200, type = 'basic', contentLength;
  const key = value => {const url = new URL(typeof value === 'string' ? value : value.url, origin); return url.pathname + url.search;};
  const cache = {
    async keys() {return [...stored.keys()].map(path => ({url: origin + path}));},
    async match(value) {return stored.get(key(value))?.clone();},
    async delete(value) {return stored.delete(key(value));},
    async put(value, response) {if (failWrite) throw new Error('Quota exceeded'); stored.set(key(value), response.clone());},
  };
  const context = vm.createContext({
    self: {location: {origin}, addEventListener(name, handler) {handlers[name] = handler;}},
    URL, Response, Uint8Array, caches: {async open() {return cache;}},
    async fetch(request) {
      requests.push(request);
      if (!online) throw new Error('Offline');
      const headers = {'Content-Type': 'application/json'};
      if (contentLength !== undefined) headers['Content-Length'] = String(contentLength);
      const response = new Response(payload, {status, headers});
      Object.defineProperty(response, 'type', {value: type});
      return response;
    },
  });
  vm.runInContext(base === '/' ? source : rewriteScript(source, 'sw.js', {base}), context);
  const realLimits = JSON.parse(vm.runInContext('JSON.stringify(TRAIL_CACHE_LIMITS)', context));
  if (limits) {context.testLimits = limits; vm.runInContext('Object.assign(TRAIL_CACHE_LIMITS,testLimits)', context);}
  async function get(path, options = {}) {
    let result;
    const pending = [];
    handlers.fetch({request: {url: new URL(path, origin + base).href, method: 'GET', headers: new Headers(), ...options},
      respondWith(value) {result = value;}, waitUntil(value) {pending.push(value);}});
    try {return await result;} finally {await Promise.allSettled(pending);}
  }
  return {stored, requests, get, realLimits,
    network(value) {online = value;},
    response(body, options = {}) {payload = body; status = options.status ?? 200; type = options.type ?? 'basic'; contentLength = options.contentLength;},
  };
}

test('visited overlay and imported tracks reopen offline on root and Pages paths', async t => {
  for (const base of ['/', '/tropnik/']) await t.test(base, async () => {
    const env = worker({base});
    assert.equal(env.requests.length, 0, 'the catalogue is not precached');
    for (const path of [overlay, 'data/imported/route-17.geojson?v=first']) {
      assert.equal(await (await env.get(path)).text(), '{"track":1}');
    }
    env.network(false);
    for (const path of [overlay, 'data/imported/route-17.geojson?v=first']) {
      assert.equal(await (await env.get(path)).text(), '{"track":1}');
    }
    assert.equal(env.requests.length, 2);
    await assert.rejects(env.get('data/imported/route-17.geojson?v=second'), /Offline/);
    assert.equal(await env.stored.get(base + 'data/map-coverage/cells/existing.coverage').text(), 'coverage cell');
  });
});

test('no-store bypasses the cache and reload refreshes it after bypassing stale bytes', async () => {
  const env = worker();
  await env.get(overlay);
  env.response('{"track":2}');
  assert.equal(await (await env.get(overlay, {cache: 'no-store'})).text(), '{"track":2}');
  assert.equal(await (await env.get(overlay)).text(), '{"track":1}');
  assert.equal(await (await env.get(overlay, {cache: 'reload'})).text(), '{"track":2}');
  assert.equal(await (await env.get(overlay)).text(), '{"track":2}');
  env.network(false);
  for (const cache of ['reload', 'no-store']) await assert.rejects(env.get(overlay, {cache}), /Offline/);
});

test('exact legacy route sources also recover from cached invalid bytes on a validation retry', async t => {
  for (const base of ['/', '/tropnik/']) await t.test(base, async () => {
    const env = worker({base}), path = 'data/routes/kolyma-black-creek.geojson?v=pinned';
    env.response('invalid source bytes'); await env.get(path);
    env.response('{"type":"FeatureCollection","features":[]}');
    assert.equal(await (await env.get(path, {cache: 'no-store'})).text(), '{"type":"FeatureCollection","features":[]}');
    assert.equal(await (await env.get(path)).text(), 'invalid source bytes');
    await env.get(path, {cache: 'reload'});
    env.network(false);
    assert.equal(await (await env.get(path)).text(), '{"type":"FeatureCollection","features":[]}');
  });
});

test('concurrent trail writes respect the 64-entry and byte budgets without evicting shell or coverage', async () => {
  const env = worker();
  assert.deepEqual(env.realLimits, {bytes: 32 * 1024 * 1024, entries: 64, fileBytes: 4 * 1024 * 1024});
  await Promise.all(Array.from({length: 70}, (_, i) => env.get(`data/imported/route-${i}.geojson?v=1`)));
  const retained = [...env.stored.keys()].filter(path => path.includes('/imported/'));
  assert.equal(retained.length, 64);
  assert.ok(!retained.includes('/data/imported/route-0.geojson?v=1'));
  assert.equal(await env.stored.get('/offline-safety.html').text(), 'emergency shell');
  assert.equal(await env.stored.get('/data/map-coverage/cells/existing.coverage').text(), 'coverage cell');
  const bytes = worker({limits: {bytes: 32, fileBytes: 8}});
  bytes.response('12345678');
  await Promise.all(Array.from({length: 6}, (_, i) => bytes.get(`data/imported/route-${i}.geojson`)));
  const data = [...bytes.stored.values()].filter(response => response.headers.has('x-tropnik-trail-bytes'));
  assert.equal(data.length, 4);
  assert.equal(data.reduce((sum, response) => sum + Number(response.headers.get('x-tropnik-trail-bytes')), 0), 32);
});

test('oversized streams, error responses and quota failures are delivered without entering the cache', async () => {
  for (const contentLength of [undefined, 1, 9]) {
    const env = worker({limits: {fileBytes: 8}});
    env.response('123456789', {contentLength});
    assert.equal(await (await env.get(overlay)).text(), '123456789');
    assert.equal(env.stored.size, 2);
  }
  for (const options of [{status: 404}, {type: 'cors'}]) {
    const env = worker(); env.response('unusable', options);
    assert.equal(await (await env.get(overlay)).text(), 'unusable');
    assert.equal(env.stored.size, 2);
  }
  const quota = worker({failWrite: true});
  assert.equal(await (await quota.get(overlay)).text(), '{"track":1}');
  assert.equal(quota.stored.size, 2);
});

test('trail cache never intercepts APIs, cross-origin data, RSC, writes or unknown overlay names', async () => {
  const env = worker();
  for (const [path, options] of [
    ['/api/trail-overlay-0123456789abcdef.json', {}],
    ['https://other.invalid/' + overlay, {}],
    [overlay, {method: 'POST'}],
    [overlay, {headers: new Headers({RSC: '1'})}],
    ['data/trail-overlay-latest.json', {}],
    ['data/trail-overlay-0123456789abcdef.json.extra', {}],
    ['data/imported/route.json', {}],
    ['data/imported/private/nested.geojson', {}],
  ]) assert.equal(await env.get(path, options), undefined, path);
  assert.equal(env.requests.length, 0);
  assert.equal(env.stored.size, 2);
});
