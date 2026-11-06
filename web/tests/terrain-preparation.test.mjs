import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {TerrainPreparation} from '../lib/terrain-preparation.ts';
import * as renderer from '../public/terrain/terrain-renderer.js';

const grid = (width = 9, height = 7) => ({schemaVersion: 2, width, height, bounds: [40, 43, 40.02, 43.02],
  units: 'meters', rowOrder: 'north-to-south', columnOrder: 'west-to-east',
  source: {name: 'Test DEM', url: 'local:test', license: 'Test', checkedAt: '2026-11-06'},
  elevations: Array.from({length: width * height}, (_, i) => 100 + i % width * 12 + Math.floor(i / width) * 5), minElevation: 100, maxElevation: 1000});

class FakeWorker {
  onmessage = null; onerror = null; onmessageerror = null; terminated = 0; posted = 0; lastRequest = null;
  constructor(behavior = worker => worker.succeed()) {this.behavior = behavior;}
  postMessage(request) {this.posted++; this.lastRequest = structuredClone(request); queueMicrotask(() => this.behavior(this));}
  succeed(transform = value => value) {
    const model = transform(renderer.createTerrainModel(this.lastRequest.grid));
    const message = structuredClone({type: 'terrain-prepared', protocol: 1, requestId: this.lastRequest.requestId, model},
      {transfer: [model.heights.buffer, model.normals.buffer, model.normalTexture.buffer]});
    this.transferred = model;
    this.onmessage?.({data: message});
  }
  terminate() {this.terminated++;}
}

test('one shared preparation survives consumer cancellation and retains transferred buffers for later cards', async () => {
  const source = grid(); let loads = 0, modules = 0, starts = 0, worker;
  const preparation = new TerrainPreparation({loadModule: async () => {modules++; return renderer;}, loadGrid: async () => {loads++; return source;},
    createWorker: () => {starts++; return worker = new FakeWorker(() => {});}});
  const first = preparation.load(), cancel = new AbortController(), consumer = preparation.load(cancel.signal);
  assert.equal(preparation.load(), first, 'non-cancelled consumers share the exact promise');
  cancel.abort(); await assert.rejects(consumer, {name: 'AbortError'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.terminated, 0, 'cancelling a card must not terminate shared preparation');
  worker.succeed();
  const result = await first;
  assert.equal(await preparation.load(), result); assert.equal(preparation.load(), first);
  assert.deepEqual([modules, loads, starts, worker.posted, worker.terminated], [1, 1, 1, 1, 1]);
  assert.equal(result[1], source); assert.equal(result[2].grid, source);
  assert.equal(result[2].heights.length, source.elevations.length); assert.ok(result[2].normals.buffer.byteLength > 0);
  assert.equal(worker.transferred.heights.buffer.byteLength, 0, 'worker buffers transferred, cached receiver buffers remain attached');
  assert.equal(preparation.snapshot().method, 'worker');
});

test('an already cancelled consumer starts no fetch, import, or worker', async () => {
  let calls = 0; const cancel = new AbortController(); cancel.abort();
  const preparation = new TerrainPreparation({loadModule: async () => {calls++; return renderer;}, loadGrid: async () => {calls++; return grid();}, createWorker: () => {calls++; return new FakeWorker();}});
  await assert.rejects(preparation.load(cancel.signal), {name: 'AbortError'}); assert.equal(calls, 0);
  await preparation.load(); assert.equal(calls, 3);
});

test('unsupported, blocked, failed, undecodable, and timed-out workers use one cooperative fallback', async t => {
  for (const mode of ['unsupported', 'blocked', 'failed', 'decode', 'timeout']) await t.test(mode, async () => {
    let fallback = 0, worker;
    const preparation = new TerrainPreparation({loadModule: async () => ({...renderer, createTerrainModelAsync: async source => {fallback++; return renderer.createTerrainModelAsync(source);}}),
      loadGrid: async () => grid(), timeoutMs: 8, createWorker: () => {
        if (mode === 'unsupported') return undefined;
        if (mode === 'blocked') throw new Error('Worker blocked');
        return worker = new FakeWorker(current => {
          if (mode === 'failed') current.onerror?.({message: 'Worker startup failed', preventDefault() {}});
          else if (mode === 'decode') current.onmessageerror?.({});
        });
      }});
    const first = await preparation.load(); assert.equal(await preparation.load(), first); assert.equal(fallback, 1);
    assert.equal(preparation.snapshot().method, 'cooperative'); assert.ok(preparation.snapshot().fallbackReason);
    if (worker) {assert.equal(worker.terminated, 1); assert.equal(worker.onmessage, null); worker.succeed(); assert.equal(await preparation.load(), first);}
  });
});

test('invalid worker models fail validation before cache and use the verified source for fallback', async () => {
  const source = grid(); let fallback = 0;
  const preparation = new TerrainPreparation({loadModule: async () => ({...renderer, createTerrainModelAsync: async input => {fallback++; assert.equal(input, source); return renderer.createTerrainModelAsync(input);}}),
    loadGrid: async () => source, createWorker: () => new FakeWorker(worker => worker.succeed(model => {model.heights[0] += 99; return model;}))});
  const [, , model] = await preparation.load();
  assert.equal(fallback, 1); assert.deepEqual(model.heights, renderer.createTerrainModel(source).heights);
  assert.equal(preparation.snapshot().method, 'cooperative');
});

test('a failed module or grid load clears the shared job so a corrected resource can retry', async t => {
  for (const part of ['module', 'grid']) await t.test(part, async () => {
    let fail = true, cleanups = 0, workers = 0;
    const preparation = new TerrainPreparation({loadModule: async () => {if (fail && part === 'module') throw new Error('Module unavailable'); return renderer;},
      loadGrid: async () => {if (fail && part === 'grid') throw new Error('Grid unavailable'); return grid();},
      createWorker: () => {workers++; return new FakeWorker();}, onFailure: () => cleanups++});
    const first = preparation.load(); assert.equal(preparation.load(), first); await assert.rejects(first, /unavailable/);
    assert.equal(cleanups, 1); assert.equal(workers, 0); fail = false;
    const retry = preparation.load(); assert.notEqual(retry, first); await retry;
    assert.equal(workers, 1); assert.equal(preparation.snapshot().attempts, 2);
  });
});

test('fallback failure is not cached; the next attempt may use a fresh worker successfully', async () => {
  let attempts = 0, cleanups = 0;
  const preparation = new TerrainPreparation({loadModule: async () => ({...renderer, createTerrainModelAsync: async () => {throw new Error('Bad source');}}),
    loadGrid: async () => grid(), createWorker: () => new FakeWorker(worker => {if (++attempts === 1) worker.onerror?.({message: 'Worker failed'}); else worker.succeed();}),
    onFailure: () => cleanups++});
  await assert.rejects(preparation.load(), /Bad source/); assert.equal(cleanups, 1);
  const result = await preparation.load(); assert.equal(result[2].grid, result[1]);
  assert.equal(preparation.snapshot().method, 'worker'); assert.equal(preparation.snapshot().workerStarts, 2);
});

test('the actual worker module produces identical derivatives across a real thread boundary', async () => {
  class ThreadWorker {
    onmessage = null; onerror = null; onmessageerror = null; terminated = 0;
    constructor() {
      this.thread = new NodeWorker(new URL('./fixtures/terrain-worker-thread.mjs', import.meta.url));
      this.thread.on('message', data => this.onmessage?.({data}));
      this.thread.on('error', error => this.onerror?.({message: error.message}));
      this.thread.on('messageerror', error => this.onmessageerror?.(error));
    }
    postMessage(request) {this.thread.postMessage(request);}
    terminate() {this.terminated++; void this.thread.terminate();}
  }
  const source = grid(17, 17); let worker;
  const preparation = new TerrainPreparation({loadModule: async () => renderer, loadGrid: async () => source, createWorker: () => worker = new ThreadWorker()});
  const [, , actual] = await preparation.load(), expected = renderer.createTerrainModel(source);
  assert.equal(preparation.snapshot().method, 'worker', preparation.snapshot().fallbackReason || '');
  assert.deepEqual(actual.heights, expected.heights); assert.deepEqual(actual.normals, expected.normals); assert.deepEqual(actual.normalTexture, expected.normalTexture);
  assert.equal(actual.grid, source); assert.equal(worker.terminated, 1);
});
