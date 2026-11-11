import test from 'node:test';
import assert from 'node:assert/strict';
import {MapResourcePool} from '../lib/map-resource-pool.ts';
import {consumeShared,publicMapResourceKey} from '../lib/map-transport.ts';
const origin = () => 'https://tropnik.example';

test('cancelling a consumer retains the shared source request for the other map',async()=>{
  let release,requests=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const pool=new MapResourcePool({fetcher:async()=>{requests++;await gate;return new Response('tile');}});
  const shared=pool.get('/terrain/tile.png'),first=new AbortController(),second=new AbortController();
  const cancelled=consumeShared(shared,first.signal),kept=consumeShared(shared,second.signal);
  first.abort();await assert.rejects(cancelled,{name:'AbortError'});release();
  assert.equal((await kept).byteLength,4);assert.equal(requests,1);
  assert.equal((await pool.get('/terrain/tile.png')).byteLength,4);
});

test('licensed imagery uses only public canonical source URLs',()=>{
  for(const layer of ['s2cloudless_3857','bluemarble_3857']){
    const url=`https://tiles.maps.eox.at/wmts/1.0.0/${layer}/default/g/8/92/172.jpg`;
    assert.equal(publicMapResourceKey(url,origin()),url);
  }
  for(const url of ['https://tiles.maps.eox.at/api/me','https://tiles.maps.eox.at/wmts/1.0.0/unknown/default/g/8/1/1.jpg','https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/8/1/1.jpg?token=private','https://user:secret@tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/8/1/1.jpg'])assert.equal(publicMapResourceKey(url,origin()),null,url);
});

test('private API, alternate origins and unsafe URL forms never enter the public cache transport', () => {
  for (const url of ['/api/backend/me', '/api/backend/routes/id', '//tiles.openfreemap.org/planet/latest', 'https://untrusted.example/terrain/a', 'https://user:secret@tiles.mapterhorn.com/1/1/1.webp', '/terrain/../api/me', '/data/%2fapi/me', 'data:text/plain,hello', 'http://tiles.mapterhorn.com/1/1/1.webp']) {
    assert.equal(publicMapResourceKey(url, origin()), null, url);
  }
  assert.equal(publicMapResourceKey(origin() + '/terrain/terrain-grid.json?v=3', origin()), '/terrain/terrain-grid.json?v=3');
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
