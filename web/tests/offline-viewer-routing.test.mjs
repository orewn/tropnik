import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { rewriteScript } from '../../tools/pages-preview/paths.mjs';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const viewer = await readFile(new URL('../public/offline-viewer.html', import.meta.url), 'utf8');
const origin = 'https://offline-fixture.invalid';

function worker({ base = '/', connected = false } = {}) {
  const handlers = {}, cacheReads = [], requests = [];
  const cache = {
    async match(path) {
      cacheReads.push(path);
      return path === base + 'offline-viewer.html' ? new Response(viewer, { headers: { 'Content-Type': 'text/html' } }) : undefined;
    },
  };
  const script = base === '/' ? source : rewriteScript(source, 'sw.js', { base });
  vm.runInNewContext(script, {
    self: { location: { origin }, addEventListener(name, listener) { handlers[name] = listener; } },
    URL, Response, caches: { async open() { return cache; } },
    async fetch(request) {
      requests.push(request.url);
      if (!connected) throw new Error('Offline fixture');
      return new Response('Framework offline management page');
    },
  });
  async function navigate(path) {
    let response;
    handlers.fetch({ request: { url: origin + path, mode: 'navigate', method: 'GET', headers: new Headers() },
      respondWith(value) { response = value; } });
    return response;
  }
  return { navigate, cacheReads, requests };
}

test('connected navigation to offline management uses the framework response', async () => {
  const env = worker({ connected: true });
  const result = await env.navigate('/offline');
  assert.equal(await result.text(), 'Framework offline management page');
  assert.deepEqual(env.cacheReads, []);
});

test('offline navigation retains the actual standalone viewer at root and under the static base path', async t => {
  for (const base of ['/', '/tropnik-test/']) await t.test(base, async () => {
    const env = worker({ base });
    for (const path of ['offline', 'offline-viewer', 'offline-viewer.html?route=kavkaz-8a']) {
      const result = await env.navigate(base + path);
      assert.equal(result.status, 200);
      assert.equal(await result.text(), viewer);
    }
    assert.ok(env.cacheReads.includes(base + 'offline-viewer.html'));
    assert.equal(env.cacheReads.some(path => path.endsWith('/offline.html')), false);
  });
});

test('private API navigation never receives an offline viewer or cache response', async () => {
  const env = worker();
  assert.equal(await env.navigate('/api/backend/me'), undefined);
  assert.deepEqual(env.cacheReads, []);
  assert.deepEqual(env.requests, []);
});
