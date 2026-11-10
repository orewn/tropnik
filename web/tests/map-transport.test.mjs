import test from 'node:test';
import assert from 'node:assert/strict';
import {MapResourcePool} from '../lib/map-resource-pool.ts';
import {createMapTransport, publicMapResourceKey} from '../lib/map-transport.ts';

const origin = () => 'https://tropnik.example';
test('preloaded vector data is reused and worker transfer cannot detach the cache', async () => {
  let requests = 0;
  const pool = new MapResourcePool({fetcher: async () => {requests++; return new Response(new Uint8Array([1, 2, 3, 4]));}});
  const source = 'https://tiles.openfreemap.org/tiles/12/2507/1493.pbf';
  const cached = await pool.get(source);
  const transport = createMapTransport(pool, origin);
  const params = transport.transformRequest(source);
  assert.ok(params.url.startsWith('tropnik-map://'));
  const {data} = await transport.load({...params, type: 'arrayBuffer'}, new AbortController());
  assert.notEqual(data, cached);
  assert.deepEqual([...new Uint8Array(structuredClone(data, {transfer: [data]}))], [1, 2, 3, 4]);
  assert.equal(data.byteLength, 0);
  assert.equal(cached.byteLength, 4);
  const again = await transport.load(params, new AbortController());
  assert.equal(again.data.byteLength, 4);
  assert.equal(requests, 1);
});

test('JSON style and source responses cannot mutate the shared preview data', async () => {
  const pool = new MapResourcePool({fetcher: async () => Response.json({version: 8, sources: {terrain: {type: 'raster-dem'}}})});
  const original = await pool.json('/maps/tropa-style.json');
  const transport = createMapTransport(pool, origin);
  const params = transport.transformRequest(origin() + '/maps/tropa-style.json');
  const response = await transport.load({...params, type: 'json'}, new AbortController());
  response.data.sources.terrain.type = 'modified';
  assert.equal(original.sources.terrain.type, 'raster-dem');
});

test('cancelling one map consumer does not cancel another map or the preview', async () => {
  let release, requests = 0;
  const gate = new Promise(resolve => {release = resolve;});
  const pool = new MapResourcePool({fetcher: async () => {requests++; await gate; return new Response('tile');}});
  const preview = pool.get('/terrain/tile.png');
  const transport = createMapTransport(pool, origin), params = transport.transformRequest('/terrain/tile.png');
  const cancelled = new AbortController();
  const first = transport.load(params, cancelled), second = transport.load(params, new AbortController());
  cancelled.abort();
  await assert.rejects(first, {name: 'AbortError'});
  release();
  assert.equal((await preview).byteLength, 4);
  assert.equal((await second).data.byteLength, 4);
  assert.equal(requests, 1);
});

test('new live tiles use native scheduling and cache eviction never claims a cached tile', async () => {
  const pool = new MapResourcePool({maxBytes: 4, maxResourceBytes: 4, fetcher: async () => new Response('tile')});
  const transport = createMapTransport(pool, origin);
  assert.equal(transport.transformRequest('/terrain/a.png').url, '/terrain/a.png');
  await pool.get('/terrain/a.png');
  assert.ok(transport.transformRequest('/terrain/a.png').url.startsWith('tropnik-map://'));
  await pool.get('/terrain/b.png');
  assert.equal(transport.transformRequest('/terrain/a.png').url, '/terrain/a.png');
});

test('private API, alternate origins and unsafe URL forms never enter the public cache transport', () => {
  for (const url of ['/api/backend/me', '/api/backend/routes/id', '//tiles.openfreemap.org/planet/latest', 'https://untrusted.example/terrain/a', 'https://user:secret@tiles.mapterhorn.com/1/1/1.webp', '/terrain/../api/me', '/data/%2fapi/me', 'data:text/plain,hello', 'http://tiles.mapterhorn.com/1/1/1.webp']) {
    assert.equal(publicMapResourceKey(url, origin()), null, url);
  }
  assert.equal(publicMapResourceKey(origin() + '/terrain/terrain-grid.json?v=3', origin()), '/terrain/terrain-grid.json?v=3');
});

test('both satellite providers retain native loading without widening the shared public-cache allowlist', async () => {
  const pool = {has() {assert.fail('Satellite imagery must not enter the preview pool');}};
  const transport = createMapTransport(pool, origin);
  for (const layer of ['s2cloudless_3857', 'bluemarble_3857']) {
    const url = `https://tiles.maps.eox.at/wmts/1.0.0/${layer}/default/g/8/63/255.jpg`;
    assert.equal(publicMapResourceKey(url, origin()), null);
    assert.equal(transport.transformRequest(url).url, url);
    await assert.rejects(transport.load({url: 'tropnik-map://' + encodeURIComponent(url)}, new AbortController()), /Unknown public map resource/);
  }
});

test('an opened map can replace queued speculative work without exceeding concurrency', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const calls = [];
  const pool = new MapResourcePool({concurrency: 1, maxQueued: 1, fetcher: async url => {calls.push(url); await gate; return new Response('ok');}});
  const active = pool.get('/active', 2), speculative = pool.get('/speculative', 2);
  const dropped = assert.rejects(speculative, /superseded/);
  const opened = pool.get('/opened', 0);
  release();
  await Promise.all([active, opened, dropped]);
  assert.deepEqual(calls, ['/active', '/opened']);
});

test('rejected HTTP status and oversized headers stop the underlying network request', async () => {
  for (const response of [new Response('oversize', {headers: {'content-length': '1000'}}), new Response('missing', {status: 404})]) {
    let signal;
    const pool = new MapResourcePool({maxResourceBytes: 4, fetcher: async (_, options) => {signal = options.signal; return response;}});
    await assert.rejects(pool.get('/terrain/rejected'));
    assert.equal(signal.aborted, true);
    assert.equal(pool.stats().cached, 0);
  }
});

test('empty coverage tiles and string resources preserve MapLibre response types', async () => {
  const pool = new MapResourcePool({fetcher: async url => url.endsWith('empty.webp') ? new Response(null, {status: 204}) : new Response('карта')});
  const transport = createMapTransport(pool, origin);
  await pool.get('/terrain/empty.webp');
  const empty = await transport.load({...transport.transformRequest('/terrain/empty.webp'), type: 'image'}, new AbortController());
  assert.equal(empty.data.byteLength, 0);
  await pool.get('/terrain/note.txt');
  const text = await transport.load({...transport.transformRequest('/terrain/note.txt'), type: 'string'}, new AbortController());
  assert.equal(text.data, 'карта');
});
