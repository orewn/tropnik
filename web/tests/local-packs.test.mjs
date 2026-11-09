import test from 'node:test';
import assert from 'node:assert/strict';
import {packs, saveReference, deletePack} from '../lib/local.ts';

const trail = {id: 'test-route', title: 'Пробная тропа', regionId: 'karelia', checkedAt: '2026-11-09'};
const geometry = {type: 'LineString', coordinates: [[30, 61], [30.01, 61.01]]};

function storage(t, options = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  let opened = 0, closed = 0, ready, transaction;
  const started = new Promise(resolve => {ready = resolve;});
  const database = {
    close() {closed++;},
    transaction(name, mode) {
      assert.equal(name, 'packs');
      if (options.transactionError) throw options.transactionError;
      const request = {result: undefined, error: null};
      const tx = {
        mode, request, error: null, operation: null, value: undefined,
        objectStore(storeName) {
          assert.equal(storeName, 'packs');
          const operation = kind => value => {tx.operation = kind; tx.value = value; if (options.requestError) throw options.requestError; return request;};
          return {getAll: operation('getAll'), put: operation('put'), delete: operation('delete')};
        },
        abort(error = new DOMException('Transaction aborted', 'AbortError')) {tx.error = error; queueMicrotask(() => tx.onabort?.({target: tx}));},
        succeed(value) {request.result = value; request.onsuccess?.({target: request});},
        complete() {tx.oncomplete?.({target: tx});},
        fail(error) {request.error = error; request.onerror?.({target: request}); tx.error = error; tx.onerror?.({target: tx});},
      };
      transaction = tx; ready(tx); return tx;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {configurable: true, value: {open(name, version) {
    assert.equal(name, 'tropa-local-v1'); assert.equal(version, 1); opened++;
    const request = {result: database}; queueMicrotask(() => request.onsuccess()); return request;
  }}});
  t.after(() => {if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB;});
  return {started, counts: () => ({opened, closed}), transaction: () => transaction};
}

for (const operation of [
  {name: 'read', run: () => packs(), result: [], kind: 'getAll'},
  {name: 'save', run: () => saveReference({...trail, geometry}), result: trail.id, kind: 'put'},
  {name: 'delete', run: () => deletePack(trail.id), result: undefined, kind: 'delete'},
]) test(`${operation.name} waits for transaction commit and rejects a later abort instead of hanging or reporting success`, async t => {
  const env = storage(t), pending = operation.run();
  let settled = false; void pending.then(() => {settled = true;}, () => {settled = true;});
  const tx = await env.started;
  assert.equal(tx.operation, operation.kind);
  tx.succeed(operation.result); await Promise.resolve();
  assert.equal(settled, false, 'request success does not mean transaction commit');
  assert.equal(env.counts().closed, 0);
  tx.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(env.counts().closed, 1);
});

test('successful commits close the database and keep the existing saved-card format with inline geometry', async t => {
  const env = storage(t);
  t.mock.method(globalThis, 'fetch', () => {throw new Error('Inline geometry must not download a second source');});
  const pending = saveReference({...trail, geometry, geometryUrl: '/unused.geojson'}), tx = await env.started;
  assert.equal(tx.mode, 'readwrite');
  assert.deepEqual(tx.value.geometry, geometry);
  assert.equal(tx.value.kind, 'reference');
  assert.equal(tx.value.sourceCheckedAt, trail.checkedAt);
  assert.ok(tx.value.bytes > 0);
  tx.succeed(trail.id); tx.complete();
  const saved = await pending;
  assert.equal(saved, tx.value); assert.equal(env.counts().closed, 1);
});

test('downloaded API geometry is unwrapped without any casting or format migration', async t => {
  const env = storage(t);
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => ({data: {geometry}})}));
  const pending = saveReference({...trail, geometryUrl: '/route.geojson'}), tx = await env.started;
  assert.deepEqual(tx.value.geometry, geometry);
  tx.succeed(trail.id); tx.complete();
  await pending; assert.equal(env.counts().closed, 1);
});

test('transaction creation, request creation and request failure always reject and close once', async t => {
  for (const kind of ['transactionError', 'requestError', 'eventError']) await t.test(kind, async t => {
    const error = new DOMException('Storage rejected the operation', 'QuotaExceededError');
    const env = storage(t, {[kind]: error});
    const pending = saveReference({...trail, geometry});
    if (kind === 'eventError') {const tx = await env.started; tx.fail(error); tx.abort(error);}
    await assert.rejects(pending, error);
    await Promise.resolve();
    assert.equal(env.counts().closed, 1);
  });
});

test('a failed geometry download never opens or changes the existing IndexedDB pack', async t => {
  const env = storage(t);
  t.mock.method(globalThis, 'fetch', async () => ({ok: false}));
  await assert.rejects(saveReference({...trail, geometryUrl: '/missing.geojson'}), /Пакет не изменён/);
  assert.deepEqual(env.counts(), {opened: 0, closed: 0});
});
