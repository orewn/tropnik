import test from 'node:test';
import assert from 'node:assert/strict';
import {MapResourcePool, routeTilePlan} from '../lib/map-resource-pool.ts';

test('all preview cards share one concurrency limit and duplicate requests', async () => {
  let active=0, maximum=0, requests=0;
  const pool=new MapResourcePool({concurrency:3,fetcher:async()=>{
    requests++; active++; maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,3)); active--; return Response.json({height:42});
  }});
  const first=pool.get('/terrain/same.json');
  assert.equal(pool.get('/terrain/same.json'),first);
  await Promise.all([first,...Array.from({length:12},(_,i)=>pool.get(`/data/${i}.json`))]);
  assert.equal(maximum,3);assert.equal(requests,13);
  const a=await pool.json('/terrain/same.json'),b=await pool.json('/terrain/same.json');
  assert.equal(a,b);assert.equal(requests,13);
});

test('network and malformed JSON failures do not poison retries', async () => {
  let calls=0;
  const pool=new MapResourcePool({fetcher:async()=>{calls++;return calls===1?new Response('not found',{status:503}):calls===2?new Response('{broken'):Response.json({ok:true});}});
  await assert.rejects(pool.json('/terrain/grid.json'));
  await assert.rejects(pool.json('/terrain/grid.json'));
  assert.deepEqual(await pool.json('/terrain/grid.json'),{ok:true});assert.equal(calls,3);
});

test('semantic invalidation retries settled data and preserves a shared in-flight request', async () => {
  let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
  const pool=new MapResourcePool({fetcher:async()=>{calls++;await gate;return Response.json({valid:calls>1});}});
  const first=pool.json('/terrain/grid.json');pool.invalidate('/terrain/grid.json');
  const shared=pool.json('/terrain/grid.json');release();
  assert.equal((await first).valid,false);assert.equal(await shared,await first);assert.equal(calls,1);
  pool.invalidate('/terrain/grid.json');assert.equal(pool.stats().bytes,0);
  assert.equal((await pool.json('/terrain/grid.json')).valid,true);assert.equal(calls,2);
});

test('streamed resource size and retained byte budget are bounded', async () => {
  const tooLarge=new MapResourcePool({maxResourceBytes:8,fetcher:async()=>new Response('123456789')});
  await assert.rejects(tooLarge.get('/terrain/huge'),/budget/);
  assert.equal(tooLarge.stats().cached,0);
  let calls=0;
  const pool=new MapResourcePool({maxBytes:16,maxResourceBytes:8,fetcher:async()=>{calls++;return new Response('12345678');}});
  for(const path of ['/data/a','/data/b','/data/c'])await pool.get(path);
  assert.ok(pool.stats().bytes<=16);await pool.get('/data/a');assert.equal(calls,4);
});

test('bounded queue rejects extra speculative work and still completes accepted requests', async () => {
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const pool=new MapResourcePool({concurrency:1,maxQueued:1,fetcher:async()=>{await gate;return new Response('ok');}});
  const a=pool.get('/a'),b=pool.get('/b');await assert.rejects(pool.get('/c'),/queue/);release();await Promise.all([a,b]);
});

test('route tile plan covers bounds without truncating at the centre', () => {
  const bounds=[40.29,43.64,40.49,43.82],tiles=routeTilePlan(bounds,12);
  assert.ok(tiles.length>1&&tiles.length<=12);
  const z=tiles[0].z,n=2**z;
  for(const lng of [bounds[0],bounds[2]])for(const lat of [bounds[1],bounds[3]]){
    const x=Math.floor((lng+180)/360*n),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);
    assert.ok(tiles.some(t=>t.x===x&&t.y===y));
  }
  assert.ok(routeTilePlan([0,0,150,80],12)[0].z<z);
});

test('antimeridian bounds wrap without out-of-world tiles; invalid coordinates fail closed', () => {
  const tiles=routeTilePlan([179,50,-179,51],12);
  assert.ok(tiles.length&&tiles.length<=12);
  assert.ok(tiles.some(t=>t.x===0));assert.ok(tiles.some(t=>t.x===2**t.z-1));
  assert.ok(tiles.every(t=>t.x>=0&&t.x<2**t.z&&t.y>=0&&t.y<2**t.z));
  for(const invalid of [[0,NaN,1,2],[200,0,201,1],[0,91,1,92],[0,2,1,1],[]])assert.deepEqual(routeTilePlan(invalid),[]);
});
