import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real TypeScript module with controlled I/O. Cache handles keep
// their identity after CacheStorage.delete, as browser CacheStorage does.
// These are concurrency and integrity tests, not a browser or device certificate.
const source = readFileSync(new URL('../lib/offline-map.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const marker = '/_offline/verified-map';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function packageData(id = 'fixture-map', text = 'verified tile') {
  const bytes = Buffer.from(text);
  return {
    manifest: { id, complete: true, files: [{
      path: 'tile.pbf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    }] },
    resources: new Map([['/offline-map/tile.pbf', bytes]]),
  };
}
function fixture(initial = packageData()) {
  const stores = new Map(), requests = [], channels = new Set(), tails = new Map();
  let current = initial, hook, deletionFailure, clock = 1_700_000_000_000, fixedClock = false;
  class Cache {
    entries = new Map();
    async put(key, response) { this.entries.set(key, response.clone()); }
    async match(key) { return this.entries.get(key)?.clone(); }
  }
  const caches = {
    async keys() { return [...stores.keys()]; },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Cache());
      return stores.get(name);
    },
    async delete(name) {
      if (deletionFailure?.(name)) throw new Error('Controlled cache removal failure');
      return stores.delete(name);
    },
  };
  const locks = {
    request(name, options, callback) {
      assert.equal(options.mode, 'exclusive');
      const previous = tails.get(name) ?? Promise.resolve();
      const operation = previous.then(() => {
        options.signal?.throwIfAborted();
        return callback({ name, mode: options.mode });
      });
      tails.set(name, operation.then(() => {}, () => {}));
      return operation;
    },
  };
  class Channel {
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) {
      for (const other of channels) if (other !== this && other.name === this.name) {
        queueMicrotask(() => { if (channels.has(other)) other.onmessage?.({ data }); });
      }
    }
    close() { channels.delete(this); }
  }
  class Clock extends Date {
    static now() { return fixedClock ? clock : clock++; }
  }
  const respond = async url => {
    if (url === '/offline-map/manifest.json') return Response.json(current.manifest);
    if (url === '/maps/pilot-style.json') return Response.json({ version: 8, sources: {}, layers: [] });
    if (current.resources.has(url)) return new Response(current.resources.get(url));
    throw new Error('Unexpected fixture request: ' + url);
  };
  const makeTab = ({ locking = true } = {}) => {
    const window = Object.assign(new EventTarget(), { caches, isSecureContext: true });
    const scope = {
      exports: {}, window, caches, navigator: {
        locks: locking ? locks : undefined,
        storage: { async estimate() { return { quota: 100_000_000, usage: 0 }; }, async persist() { return true; } },
      },
      crypto: webcrypto, Event, BroadcastChannel: Channel, Response, AbortController, DOMException,
      Date: Clock, fetch: async (url, options = {}) => {
        requests.push({ url, options });
        options.signal?.throwIfAborted();
        return hook ? hook(url, options, respond) : respond(url);
      },
    };
    vm.runInNewContext(compiled, scope);
    return { ...scope.exports, window };
  };
  return {
    caches, stores, requests, makeTab, tab: makeTab(),
    setPackage(value) { current = value; },
    intercept(value) { hook = value; },
    failDelete(value) { deletionFailure = value; },
    freezeClock() { fixedClock = true; },
  };
}

test('another tab cannot delete a package while its download still holds the mutation lock', async () => {
  const env = fixture(), second = env.makeTab();
  const old = await env.tab.downloadMap(() => {});
  const began = deferred(), resume = deferred();
  env.setPackage(packageData('replacement-map', 'replacement tile'));
  env.intercept(async (url, _options, respond) => {
    if (url === '/offline-map/tile.pbf') { began.resolve(); await resume.promise; }
    return respond(url);
  });
  const download = env.tab.downloadMap(() => {});
  await began.promise;
  let removed = false;
  const removal = second.removeMap().then(() => { removed = true; });
  await tick();
  assert.equal(removed, false);
  assert.equal((await env.tab.getMapReceipt()).cacheName, old.cacheName);
  assert.equal((await env.caches.keys()).length, 2);
  resume.resolve();
  const replacement = await download;
  assert.equal(replacement.verified, true);
  await removal;
  assert.equal(await env.tab.getMapReceipt(), null);
  assert.deepEqual(await env.caches.keys(), []);
});

test('corrupt replacement bytes preserve the previous verified package, even with a repeated timestamp', async () => {
  const env = fixture();
  env.freezeClock();
  const old = await env.tab.downloadMap(() => {});
  const oldCache = await env.caches.open(old.cacheName);
  const before = Buffer.from(await (await oldCache.match('/offline-map/tile.pbf')).arrayBuffer());
  env.intercept(async (url, _options, respond) =>
    url === '/offline-map/tile.pbf' ? new Response(Buffer.alloc(before.length, 0)) : respond(url));
  await assert.rejects(env.tab.downloadMap(() => {}), /целостности/);
  assert.equal((await env.tab.getMapReceipt()).cacheName, old.cacheName);
  assert.deepEqual(await env.caches.keys(), [old.cacheName]);
  assert.deepEqual(Buffer.from(await (await oldCache.match('/offline-map/tile.pbf')).arrayBuffer()), before);
});

test('cancelling an in-flight replacement leaves the installed package available', async () => {
  const env = fixture();
  const old = await env.tab.downloadMap(() => {});
  const began = deferred(), abort = new AbortController();
  env.intercept(async (url, options, respond) => {
    if (url === '/offline-map/tile.pbf') {
      began.resolve();
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort',
        () => reject(options.signal.reason), { once: true }));
    }
    return respond(url);
  });
  const replacement = env.tab.downloadMap(() => {}, abort.signal);
  const rejected = assert.rejects(replacement, { name: 'AbortError' });
  await began.promise;
  abort.abort();
  await rejected;
  assert.equal((await env.tab.getMapReceipt()).cacheName, old.cacheName);
  assert.deepEqual(await env.caches.keys(), [old.cacheName]);
});

test('an aborted queued download does not fetch or create a partial package', async () => {
  const env = fixture(), second = env.makeTab();
  const began = deferred(), resume = deferred(), abort = new AbortController();
  env.intercept(async (url, _options, respond) => {
    if (url === '/offline-map/tile.pbf') { began.resolve(); await resume.promise; }
    return respond(url);
  });
  const first = env.tab.downloadMap(() => {});
  await began.promise;
  const queued = second.downloadMap(() => {}, abort.signal);
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  abort.abort();
  resume.resolve();
  const receipt = await first;
  await rejected;
  assert.equal(env.requests.filter(item => item.url === '/offline-map/manifest.json').length, 1);
  assert.deepEqual(await env.caches.keys(), [receipt.cacheName]);
});

test('failure to clean an old package cannot delete the newly published working copy', async () => {
  const env = fixture();
  const old = await env.tab.downloadMap(() => {});
  env.setPackage(packageData('replacement-map', 'replacement tile'));
  env.failDelete(name => name === old.cacheName);
  const replacement = await env.tab.downloadMap(() => {});
  assert.notEqual(replacement.cacheName, old.cacheName);
  assert.equal((await env.tab.getMapReceipt()).cacheName, replacement.cacheName);
  assert.equal((await (await env.caches.open(replacement.cacheName)).match(marker)).ok, true);
  assert.equal((await (await env.caches.open(old.cacheName)).match(marker)).ok, true);
});

test('the cached manifest is the exact snapshot whose files were verified', async () => {
  const env = fixture();
  const initial = packageData('snapshot-one');
  env.setPackage(initial);
  env.intercept(async (url, _options, respond) => {
    if (url === '/offline-map/manifest.json') {
      const reply = await respond(url);
      env.setPackage({ ...initial, manifest: { ...initial.manifest, id: 'snapshot-two' } });
      return reply;
    }
    return respond(url);
  });
  const receipt = await env.tab.downloadMap(() => {});
  const installed = await env.caches.open(receipt.cacheName);
  const manifest = await (await installed.match('/offline-map/manifest.json')).json();
  assert.equal(receipt.id, 'snapshot-one');
  assert.equal(manifest.id, receipt.id);
  assert.equal(env.requests.filter(item => item.url === '/offline-map/manifest.json').length, 1);
});

test('cache change notifications refresh other tabs after deletion and unsubscribe cleanly', async () => {
  const env = fixture(), second = env.makeTab(), observed = [], pending = [];
  await env.tab.downloadMap(() => {});
  const stop = second.watchMapChanges(() => { pending.push(second.getMapReceipt().then(value => observed.push(value))); });
  await env.tab.removeMap();
  await tick();
  await Promise.all(pending);
  assert.equal(observed.length, 1);
  assert.equal(observed[0], null);
  stop();
  second.window.dispatchEvent(new Event('focus'));
  await env.tab.downloadMap(() => {});
  await tick();
  assert.equal(observed.length, 1);
});

test('missing cross-tab locks fail closed for changes but keep an installed package readable', async () => {
  const env = fixture();
  const installed = await env.tab.downloadMap(() => {});
  const unsupported = env.makeTab({ locking: false });
  const requestsBefore = env.requests.length;
  await assert.rejects(unsupported.downloadMap(() => {}), /между вкладками/);
  await assert.rejects(unsupported.removeMap(), /между вкладками/);
  assert.equal(env.requests.length, requestsBefore);
  assert.equal((await unsupported.getMapReceipt()).cacheName, installed.cacheName);
});

test('the shipped pilot package passes its real file hashes and size checks', async () => {
  const base = new URL('../public/offline-map/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
  const resources = new Map(manifest.files.map(file => [
    '/offline-map/' + file.path.split('/').map(encodeURIComponent).join('/'),
    readFileSync(new URL(file.path.split('/').map(encodeURIComponent).join('/'), base)),
  ]));
  const env = fixture({ manifest, resources });
  const progress = [];
  const receipt = await env.tab.downloadMap((loaded, total) => progress.push([loaded, total]));
  assert.equal(receipt.files, manifest.files.length);
  assert.equal(receipt.bytes, manifest.files.reduce((total, file) => total + file.bytes, 0));
  assert.deepEqual(progress.at(-1), [manifest.files.length, manifest.files.length]);
  assert.equal(receipt.landscape, true);
  assert.equal((await env.tab.getMapReceipt()).cacheName, receipt.cacheName);
  assert.equal(env.requests.some(item => item.url.startsWith('/api/')), false);
});
