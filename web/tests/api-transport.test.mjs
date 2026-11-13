import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {gzipSync} from 'node:zlib';
import vm from 'node:vm';
import ts from 'typescript';
import {NextRequest, NextResponse} from 'next/server.js';
import * as transport from '../lib/api-transport.ts';
import * as forwarding from '../lib/backend-forwarding.ts';
import {publicOriginPolicy} from '../lib/backend-origin.ts';
import {clearsAccountSession} from '../lib/account-action.ts';
import {api, ApiError, isAbort} from '../lib/api.ts';

const {API_TRANSPORT_LIMITS: limits, BodyLimitError, apiResponseBytes, readBoundedBody, readBoundedJSON, requestDeadline} = transport;
const tick = () => new Promise(resolve => setImmediate(resolve));
const compiledBFF = ts.transpileModule(readFileSync(new URL('../app/api/backend/[...path]/route.ts', import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
function bff(fetcher, timeoutMs = limits.proxyTimeoutMs) {
  const deps = {
    'next/server': {NextRequest, NextResponse}, '@/lib/backend-forwarding': forwarding,
    '@/lib/backend-origin': {publicOriginPolicy}, '@/lib/account-action': {clearsAccountSession},
    '@/lib/api-transport': {...transport, API_TRANSPORT_LIMITS: {...limits, proxyTimeoutMs: timeoutMs}},
  };
  const context = vm.createContext({URL, Headers, Error, fetch: fetcher, process: {env: {TROPA_API_URL: 'https://api.example.invalid', PUBLIC_ORIGIN: 'https://tropnik.example', NODE_ENV: 'production'}}});
  const loaded = {exports: {}};
  vm.runInContext(`(function(require,module,exports){${compiledBFF}\n})`, context)(name => {assert.ok(deps[name], name); return deps[name];}, loaded, loaded.exports);
  return (path, init = {}) => {
    const request = new NextRequest('https://tropnik.example/api/backend/' + path, {method: 'GET', ...init, headers: {'Content-Type': 'application/json', Origin: 'https://tropnik.example', ...init.headers}, ...(init.body instanceof ReadableStream ? {duplex: 'half'} : {})});
    return loaded.exports[request.method](request, {params: Promise.resolve({path: path.split('?')[0].split('/')})});
  };
}

test('response budgets whitelist exact resources and methods without broad path matching', () => {
  for (const path of ['routes/id', '/routes/id', 'routes/id?source=map']) assert.equal(apiResponseBytes(path), limits.routeDetailBytes);
  for (const path of ['routes', 'routes?limit=100', 'routes/id/reviews', 'routes/id/', 'routes/../me', 'guides/id', 'routes/id#fragment']) assert.equal(apiResponseBytes(path), limits.responseBytes);
  assert.equal(apiResponseBytes('routes/id', 'POST'), limits.responseBytes);
  assert.equal(apiResponseBytes('routes/id', 'GET', false), limits.responseBytes);
  for (const path of ['departures/id/messages', 'recruitment-requests/id/messages?cursor=next']) {
    assert.equal(apiResponseBytes(path), limits.chatBytes);
    assert.equal(apiResponseBytes(path, 'POST'), limits.responseBytes);
    assert.equal(apiResponseBytes(path, 'GET', false), limits.responseBytes);
  }
  for (const path of ['departures/id/messages/other', 'departures/id/messages/', 'me/messages']) assert.equal(apiResponseBytes(path), limits.responseBytes);
  for (const path of ['departures/id/reviews', 'guides/id/reviews', 'recruitment-requests', 'me/reports', 'me/moderation-actions', 'me/appeals', 'me/notifications', 'moderation/reports', 'moderation/appeals']) {
    assert.equal(apiResponseBytes(path), limits.collectionBytes);
    assert.equal(apiResponseBytes(path + '?status=open'), limits.collectionBytes);
    assert.equal(apiResponseBytes(path + '/extra'), limits.responseBytes);
    assert.equal(apiResponseBytes(path, 'POST'), limits.responseBytes);
    assert.equal(apiResponseBytes(path, 'GET', false), limits.responseBytes);
  }
  for (const path of ['guides?path=moderation/reports', 'routes?next=routes/id', 'departures/id%2Fmessages', 'moderation/reports%2Fextra']) assert.equal(apiResponseBytes(path), limits.responseBytes);
  assert.equal(apiResponseBytes('departures/id/emergency-card'), limits.emergencyCardBytes);
  assert.equal(apiResponseBytes('departures/id/safety-passport'), limits.safetyPassportBytes);
  for (const suffix of ['safety-passport/prepare', 'mchs/submission', 'mchs/confirmation', 'mchs/start-contact', 'mchs/return-report']) {
    const path = 'departures/id/' + suffix;
    assert.equal(apiResponseBytes(path + '?replay=1', 'POST'), limits.safetyPassportBytes);
    for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal(apiResponseBytes(path, method), limits.responseBytes);
    assert.equal(apiResponseBytes(path + '/extra', 'POST'), limits.responseBytes);
    assert.equal(apiResponseBytes(path, 'POST', false), limits.responseBytes);
  }
  for (const suffix of ['safety-passport', 'emergency-card', 'safety-check-ins', 'mchs/close']) assert.equal(apiResponseBytes('departures/id/' + suffix, 'POST'), limits.responseBytes);
  assert.equal(apiResponseBytes('departures/id/safety-passport', 'GET', false), limits.responseBytes);
});

test('the body budget counts UTF-8 chunks and cannot trust a small or missing Content-Length', async () => {
  for (const headers of [{}, {'Content-Length': '1'}]) {
    let cancelled = 0;
    const source = new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('я')); controller.enqueue(new TextEncoder().encode('я'));}, cancel() {cancelled++;}}), {headers});
    await assert.rejects(readBoundedBody(source, 3, new AbortController().signal), BodyLimitError);
    assert.equal(source.body.locked, false); assert.equal(cancelled, 1);
  }
  assert.equal((await readBoundedBody(new Response('яя'), 4, new AbortController().signal)).byteLength, 4);
  await assert.rejects(readBoundedBody(new Response('x', {headers: {'Content-Length': '100'}}), 4, new AbortController().signal), BodyLimitError);
});

test('one decoded budget spans pages without counting the compressed Content-Length', async () => {
  const signal = new AbortController().signal, budget = {remainingBytes: 7};
  assert.deepEqual(await readBoundedJSON(new Response('{"n":1}'), 1024, signal, budget), {n: 1});
  assert.equal(budget.remainingBytes, 0);
  await assert.rejects(readBoundedJSON(new Response('{}'), 1024, signal, budget), BodyLimitError);
});

test('caller cancellation releases an in-progress body read even if the source cancel hook never settles', {timeout: 1000}, async () => {
  const caller = new AbortController(), reason = new Error('Selection replaced');
  let cancelled = 0;
  const source = new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array([1]));}, cancel() {cancelled++; return new Promise(() => {});}}));
  const pending = readBoundedBody(source, 100, caller.signal);
  await tick(); caller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(cancelled, 1); assert.equal(source.body.locked, false);
});

test('tiny chunks are copied as they arrive with bounded adaptive storage and an exact final buffer', async () => {
  const allocations = [], NativeBytes = Uint8Array;
  class TrackedBytes extends NativeBytes {constructor(...args) {super(...args); if (typeof args[0] === 'number') allocations.push(args[0]);}}
  const source = ts.transpileModule(readFileSync(new URL('../lib/api-transport.ts', import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
  const context = vm.createContext({Uint8Array: TrackedBytes, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout});
  const loaded = {exports: {}};
  vm.runInContext(`(function(module,exports){${source}\n})`, context)(loaded, loaded.exports);
  let index = 0, previous, released = 0;
  const count = 20000;
  const body = {headers: new Headers(), body: {getReader: () => ({
    async read() {
      // A consumed transport buffer can be reused once the next read starts.
      // Retaining chunk references until EOF would corrupt the result here.
      previous?.fill(255);
      if (index === count) return {done: true};
      previous = NativeBytes.of(index++ % 251); return {done: false, value: previous};
    },
    async cancel() {}, releaseLock() {released++;},
  })}};
  const bytes = await loaded.exports.readBoundedBody(body, limits.routeDetailBytes, new AbortController().signal);
  assert.equal(bytes.length, count); assert.equal(bytes.buffer.byteLength, count);
  assert.ok(bytes.every((byte, position) => byte === position % 251));
  assert.ok(allocations.length < 16); assert.ok(Math.max(...allocations) <= 2 * count, 'A small response must not reserve its 8 MiB maximum');
  assert.equal(released, 1);
});

test('one deadline also bounds a stalled request stream before any upstream fetch', {timeout: 1000}, async () => {
  const deadline = requestDeadline(15);
  const source = new Request('https://tropnik.example/', {method: 'POST', body: new ReadableStream({start(controller) {controller.enqueue(new Uint8Array([1]));}}), duplex: 'half'});
  try { await assert.rejects(readBoundedBody(source, 100, deadline.signal), error => error.name === 'TimeoutError'); assert.equal(deadline.timedOut(), true); }
  finally { deadline.dispose(); }
  assert.equal(source.body.locked, false);
});

test('the browser preserves a real HTTP cancellation after response headers have arrived', async t => {
  const original = globalThis.fetch;
  const server = createServer((_request, response) => {response.writeHead(200, {'Content-Type': 'application/json'}); response.write('{"data":');});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const controller = new AbortController(); let headersRead = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const response = await original(`http://127.0.0.1:${server.address().port}/`, init);
    headersRead = true; setTimeout(() => controller.abort(), 5); return response;
  });
  await assert.rejects(api('guides/fixture/reviews', {signal: controller.signal}), error => isAbort(error) && !(error instanceof ApiError));
  assert.equal(headersRead, true);
});

test('a browser deadline during JSON consumption remains a timeout rather than invalid_response', async t => {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => timer(callback, delay === limits.browserTimeoutMs ? 15 : delay, ...args));
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('{"data":'));}, cancel() {cancelled++;}})));
  await assert.rejects(api('guides'), error => error instanceof ApiError && error.code === 'timeout');
  assert.equal(cancelled, 1);
});

test('an exact-limit decoded response is not rejected by gzip overhead in its wire Content-Length', async t => {
  const encoded = '{"data":1}', compressed = gzipSync(encoded);
  assert.ok(compressed.length > Buffer.byteLength(encoded));
  const server = createServer((_request, response) => {response.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length}); response.end(compressed);});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const signal = new AbortController().signal, budget = {remainingBytes: Buffer.byteLength(encoded)};
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {signal});
  assert.deepEqual(await readBoundedJSON(response, Buffer.byteLength(encoded), signal, budget), {data: 1});
  assert.equal(budget.remainingBytes, 0);
});

test('the browser rejects an oversized gzip response using decoded bytes', async t => {
  const compressed = gzipSync(JSON.stringify({data: 'x'.repeat(limits.responseBytes)}));
  assert.ok(compressed.byteLength < 2000);
  const server = createServer((_request, response) => {response.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length}); response.end(compressed);});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (_url, init) => original(`http://127.0.0.1:${server.address().port}/`, init));
  await assert.rejects(api('routes'), error => error instanceof ApiError && error.code === 'response_too_large');
});

test('the BFF forwards a valid observation batch above the previous 64 KiB limit and rejects requests over 1 MiB', async () => {
  const observations = Array.from({length: 50}, (_, index) => ({clientId: `observation-${String(index).padStart(4, '0')}`, departureId: '00000000-0000-4000-8000-000000000001', observedAt: '2026-11-13T12:00:00Z', baseVersion: 1, kind: 'field_note', body: 'a'.repeat(4000)}));
  const body = JSON.stringify({observations}); let calls = 0;
  const request = bff(async (_url, init) => {calls++; assert.equal(new TextDecoder().decode(init.body), body); return Response.json({data: []});});
  assert.ok(Buffer.byteLength(body) > 65536 && Buffer.byteLength(body) < limits.requestBytes);
  assert.equal((await request('sync/observations', {method: 'POST', body})).status, 200);
  const oversized = await request('sync/observations', {method: 'POST', body: 'x'.repeat(limits.requestBytes + 1)});
  assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error.code, 'body_too_large'); assert.equal(calls, 1);
});

test('the BFF bounds both upload and response stalls, cancels on disconnect and never starts an aborted upload', {timeout: 2000}, async () => {
  let calls = 0;
  const request = bff(async () => {calls++; return new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('{"data":'));}}));}, 20);
  const upload = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array([123]));}});
  assert.equal((await request('sync/observations', {method: 'POST', body: upload})).status, 502);
  assert.equal(calls, 0); assert.equal(upload.locked, false);
  const caller = new AbortController(), cancelled = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array([123]));}});
  const pending = request('sync/observations', {method: 'POST', body: cancelled, signal: caller.signal});
  await tick(); caller.abort(); assert.equal((await pending).status, 502); assert.equal(calls, 0);
  assert.equal((await request('guides')).status, 502); assert.equal(calls, 1);
});

test('BFF responses use the same route budget and keep local logout clearing after an oversized upstream reply', async () => {
  const value = {data: 'x'.repeat(limits.responseBytes)};
  const request = bff(async () => Response.json(value));
  assert.equal((await request('routes')).status, 502);
  assert.equal((await request('routes/fixture')).status, 200);
  const failure = await request('auth/logout', {method: 'POST', body: '{}'});
  assert.equal(failure.status, 502); assert.equal(failure.headers.get('X-Tropa-Session-Cleared'), '1');
  assert.equal((await failure.json()).error.code, 'response_too_large');
  const errors = bff(async () => Response.json(value, {status: 500}));
  assert.equal((await errors('routes/fixture')).status, 502);
});

test('the bounded chat allowance retains 100 Go-escaped or Unicode messages and moderation tombstones', async t => {
  for (const body of ['<'.repeat(4000), '漢'.repeat(4000), '🧭'.repeat(4000)]) {
    const messages = Array.from({length: 100}, (_, index) => ({id: 'message-' + index, body: index === 99 ? '' : body, visibility: index === 99 ? 'hidden' : 'visible'}));
    // encoding/json escapes HTML characters by default; raw JSON.stringify
    // alone would underestimate a valid Go response by a factor of six here.
    const encoded = JSON.stringify({data: messages, meta: {mode: 'production'}}).replaceAll('<', '\\u003c');
    assert.ok(Buffer.byteLength(encoded) > limits.responseBytes && Buffer.byteLength(encoded) < limits.chatBytes);
    for (const path of ['departures/id/messages', 'recruitment-requests/id/messages']) {
      t.mock.method(globalThis, 'fetch', async () => new Response(encoded));
      const data = await api(path);
      assert.deepEqual(data, messages);
      const response = await bff(async () => new Response(encoded))(path);
      assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, messages);
    }
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(limits.chatBytes + 1)));
  await assert.rejects(api('departures/id/messages'), error => error.code === 'response_too_large');
});

test('rich collection responses retain SQL-bounded staff report text above 4 MiB without broadening mutation or error budgets', async t => {
  const rows = Array.from({length: 100}, (_, index) => ({id: 'report-' + index, body: '<'.repeat(2000), decisionReason: '<'.repeat(2000), targetBody: '<'.repeat(4000), reporter: {displayName: '<'.repeat(80)}, subject: {displayName: '<'.repeat(80)}}));
  const encoded = JSON.stringify({data: rows, meta: {mode: 'production'}}).replaceAll('<', '\\u003c');
  assert.ok(Buffer.byteLength(encoded) > limits.chatBytes && Buffer.byteLength(encoded) < limits.collectionBytes);
  t.mock.method(globalThis, 'fetch', async () => new Response(encoded));
  assert.deepEqual(await api('moderation/reports?status=open'), rows);
  const response = await bff(async () => new Response(encoded))('moderation/reports');
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, rows);
  await assert.rejects(api('moderation/reports', {method: 'POST', body: '{}'}), error => error.code === 'response_too_large');
  t.mock.method(globalThis, 'fetch', async () => new Response(encoded, {status: 500}));
  await assert.rejects(api('moderation/reports'), error => error.code === 'response_too_large');
});

test('permitted safety text sizes use the same bounded allowance for GET and the five full-passport POST responses', async t => {
  const points = Array.from({length: 50}, () => ({name: '<'.repeat(240), description: '<'.repeat(2000)}));
  const emergency = {data: {emergencyExits: points, controlPoints: points, emergencyNumber: '112'}, meta: {mode: 'production'}};
  const encodedEmergency = JSON.stringify(emergency).replaceAll('<', '\\u003c');
  assert.ok(Buffer.byteLength(encodedEmergency) > limits.responseBytes && Buffer.byteLength(encodedEmergency) < limits.emergencyCardBytes);
  t.mock.method(globalThis, 'fetch', async () => new Response(encodedEmergency));
  assert.deepEqual(await api('departures/id/emergency-card'), emergency.data);
  // A legal RFC3339 fractional string survives the source route's 8 MiB
  // import envelope. Private details can put its full passport above 8 MiB.
  const passport = {data: {public: {route: {defaultCheckInSchedule: [{name: 'Control', at: '2026-11-13T12:00:00.' + '1'.repeat(limits.routeDetailBytes - 10000) + 'Z'}]}}, private: {notes: '<'.repeat(2000)}}, meta: {mode: 'production'}};
  const encoded = JSON.stringify(passport).replaceAll('<', '\\u003c');
  assert.ok(Buffer.byteLength(encoded) > limits.routeDetailBytes && Buffer.byteLength(encoded) < limits.safetyPassportBytes);
  t.mock.method(globalThis, 'fetch', async () => new Response(encoded));
  assert.deepEqual(await api('departures/id/safety-passport'), passport.data);
  for (const suffix of ['safety-passport/prepare', 'mchs/submission', 'mchs/confirmation', 'mchs/start-contact', 'mchs/return-report']) {
    const path = 'departures/id/' + suffix;
    assert.deepEqual(await api(path, {method: 'POST', body: '{}'}), passport.data);
    const response = await bff(async () => new Response(encoded, {status: suffix === 'safety-passport/prepare' ? 201 : 200}))(path, {method: 'POST', body: '{}'});
    assert.ok(response.ok);
  }
  await assert.rejects(api('departures/id/safety-check-ins', {method: 'POST', body: '{}'}), error => error.code === 'response_too_large');
  t.mock.method(globalThis, 'fetch', async () => new Response(encoded, {status: 500}));
  await assert.rejects(api('departures/id/safety-passport'), error => error.code === 'response_too_large');
});
