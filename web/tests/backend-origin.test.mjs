import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {NextRequest} from 'next/server.js';
import {publicOriginPolicy} from '../lib/backend-origin.ts';

// Load the actual route handler with the same aliases resolved by Next.
// These tests exercise its request/cookie boundary without a live Go server.
const hooks = registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier === '@/lib/backend-origin') return nextResolve(new URL('../lib/backend-origin.ts', import.meta.url).href, context);
  if (specifier === '@/lib/backend-forwarding') return nextResolve(new URL('../lib/backend-forwarding.ts', import.meta.url).href, context);
  if (specifier === '@/lib/account-action') return nextResolve(new URL('../lib/account-action.ts', import.meta.url).href, context);
  if (specifier === '@/lib/service-readiness') return nextResolve(new URL('../lib/service-readiness.ts', import.meta.url).href, context);
  return nextResolve(specifier, context);
}});
const {GET, POST} = await import('../app/api/backend/[...path]/route.ts');
const {GET: status} = await import('../app/api/status/route.ts');
hooks.deregister();

const site = 'https://tropa.example';
const token = 'a'.repeat(43);
const context = path => ({params: Promise.resolve({path: path.split('/')})});
const request = (path, {origin = site, method = 'POST', headers = {}} = {}) => new NextRequest(`http://0.0.0.0:3000/api/backend/${path}`, {
  method,
  headers: {...(origin === null ? {} : {Origin: origin}), 'Content-Type': 'application/json', ...headers},
  ...(method === 'GET' ? {} : {body: '{}'}),
});
function configure(t, origin = site, environment = 'production') {
  const old = {PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN, NODE_ENV: process.env.NODE_ENV, TROPA_API_URL: process.env.TROPA_API_URL};
  const fetcher = globalThis.fetch;
  if (origin === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = origin;
  process.env.NODE_ENV = environment;
  process.env.TROPA_API_URL = 'http://api:8080';
  t.after(() => {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    globalThis.fetch = fetcher;
  });
}
const authResponse = () => Response.json({data: {token, expiresAt: '2099-01-01T00:00:00Z', user: {id: 'user'}}, meta: {mode: 'production'}});

test('public origin configuration is canonical and HTTP is restricted to explicit local development', () => {
  assert.deepEqual(publicOriginPolicy(site, 'production'), {origin: site, secureCookies: true});
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const local = `http://${host}:3000`;
    assert.deepEqual(publicOriginPolicy(local, 'development'), {origin: local, secureCookies: false});
    assert.equal(publicOriginPolicy(local, 'production'), null);
    assert.equal(publicOriginPolicy(local, undefined), null);
  }
  for (const value of [undefined, '', ' ', site + '/', site + '/path', site + '?token=secret', site + '#fragment', 'https://user:secret@tropa.example', 'http://tropa.example', 'https://TROPA.example', 'https://tropa.example:443', 'null', 'file:///tmp', ` ${site}`, `${site}\n`, 'http://0.0.0.0:3000', 'http://api:3000']) {
    assert.equal(publicOriginPolicy(value, 'production'), null);
    assert.equal(publicOriginPolicy(value, 'development'), null);
  }
});

test('actual BFF accepts the configured browser origin through an internal HTTP listener and sets Secure cookie', async t => {
  configure(t);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://api:8080/api/v1/auth/login');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('X-Forwarded-Host'), null);
    return authResponse();
  };
  const req = request('auth/login', {headers: {Host: '0.0.0.0:3000', 'X-Forwarded-Host': 'spoof.example', 'X-Forwarded-Proto': 'http'}});
  assert.equal(req.nextUrl.origin, 'http://0.0.0.0:3000');
  const response = await POST(req, context('auth/login'));
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /; Secure(?:;|$)/);
  assert.match(cookie, /; HttpOnly(?:;|$)/);
  assert.match(cookie, /; SameSite=lax(?:;|$)/i);
  assert.equal((await response.json()).data.token, undefined);
});

test('forwarded host and protocol never authorize a foreign or missing browser Origin', async t => {
  configure(t);
  globalThis.fetch = async () => assert.fail('Rejected browser request reached the API');
  for (const origin of ['https://attacker.example', 'http://0.0.0.0:3000', 'null', null, `${site}, https://attacker.example`]) {
    const response = await POST(request('auth/login', {origin, headers: {'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https', Host: 'attacker.example'}}), context('auth/login'));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'origin_mismatch');
  }
});

test('connected BFF fails closed before forwarding when the public origin is missing or invalid', async t => {
  configure(t);
  globalThis.fetch = async () => assert.fail('Invalid public configuration reached the API');
  for (const origin of [undefined, '', site + '/', 'http://localhost:3000', 'https://user:secret@tropa.example']) {
    if (origin === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = origin;
    for (const [method, handler, path] of [['POST', POST, 'auth/login'], ['GET', GET, 'me']]) {
      const response = await handler(request(path, {method}), context(path));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'service_config');
      assert.equal(response.headers.get('set-cookie'), null);
    }
  }
});

test('preview without a configured API stays explicitly disconnected', async t => {
  configure(t);
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.TROPA_API_URL;
  globalThis.fetch = async () => assert.fail('Preview contacted an API');
  const response = await POST(request('auth/login'), context('auth/login'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'service_not_configured');
  assert.deepEqual(await (await status()).json(), {configured: false, connected: false, version: '0.1.0', mode: 'preview'});
});

test('actual status endpoint requires valid public origin before it can advertise a healthy API', async t => {
  configure(t);
  delete process.env.PUBLIC_ORIGIN;
  globalThis.fetch = async () => assert.fail('Misconfigured BFF tried a readiness request');
  const unavailable = await status();
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {configured: true, connected: false, version: '0.1.0', mode: 'unavailable', reason: 'service_config'});
  process.env.PUBLIC_ORIGIN = site;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'http://api:8080/api/v1/health/ready');
    return Response.json({data: {status: 'ready'}, meta: {mode: 'production'}});
  };
  const ready = await status();
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {configured: true, connected: true, version: '0.1.0', mode: 'connected'});
});

test('actual status endpoint distinguishes configuration from upstream failure without exposing addresses', async t => {
  configure(t);
  process.env.TROPA_API_URL = 'https://user:PRIVATE-VALUE@internal.example';
  globalThis.fetch = async () => assert.fail('Unsafe API configuration was contacted');
  const invalid = await status();
  assert.equal(invalid.status, 503);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.reason, 'service_config');
  assert.doesNotMatch(JSON.stringify(invalidBody), /PRIVATE-VALUE|internal\.example/);
  process.env.TROPA_API_URL = 'https://internal.example';
  globalThis.fetch = async () => { throw new Error('PRIVATE-NETWORK-DETAIL'); };
  const offline = await status();
  assert.equal(offline.status, 503);
  const offlineBody = await offline.json();
  assert.equal(offlineBody.reason, 'upstream_unavailable');
  assert.doesNotMatch(JSON.stringify(offlineBody), /PRIVATE-NETWORK-DETAIL|internal\.example/);
});

test('explicit loopback development supports HTTP without accepting a remote HTTP origin', async t => {
  configure(t, 'http://localhost:3000', 'development');
  globalThis.fetch = async () => authResponse();
  const response = await POST(request('auth/login', {origin: 'http://localhost:3000'}), context('auth/login'));
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure(?:;|$)/);
  process.env.PUBLIC_ORIGIN = 'http://remote.example';
  globalThis.fetch = async () => assert.fail('Remote HTTP origin reached the API');
  assert.equal((await POST(request('auth/login', {origin: 'http://remote.example'}), context('auth/login'))).status, 503);
});

test('logout clears the same Secure cookie on success and on uncertain upstream revocation', async t => {
  configure(t);
  for (const failed of [false, true]) {
    globalThis.fetch = async () => { if (failed) throw new Error('upstream unavailable'); return new Response(null, {status: 204}); };
    const response = await POST(request('auth/logout', {headers: {Cookie: `tropa_session=${token}`}}), context('auth/logout'));
    assert.equal(response.status, failed ? 502 : 204);
    assert.equal(response.headers.get('X-Tropa-Session-Cleared'), '1');
    assert.match(response.headers.get('set-cookie'), /; Secure(?:;|$)/);
    assert.match(response.headers.get('set-cookie'), /; Max-Age=0(?:;|$)/i);
    if (failed) assert.equal((await response.json()).error.code, 'upstream_unavailable');
  }
});

test('actual BFF clears reset/deletion sessions only after confirmed account changes', async t => {
  configure(t);
  for (const path of ['auth/password/reset', 'me/delete']) {
    globalThis.fetch = async () => path === 'me/delete' ? new Response(null, {status: 204}) : Response.json({data: {status: 'password_changed'}});
    const success = await POST(request(path, {headers: {Cookie: `tropa_session=${token}`}}), context(path));
    assert.equal(success.status, path === 'me/delete' ? 204 : 200);
    assert.equal(success.headers.get('X-Tropa-Session-Cleared'), '1');
    assert.match(success.headers.get('set-cookie'), /; Max-Age=0(?:;|$)/i);
    assert.match(success.headers.get('set-cookie'), /; Secure(?:;|$)/);
    for (const status of [400, 403, 409, 429, 503]) {
      globalThis.fetch = async () => Response.json({error: {code: 'not_completed', message: 'Not completed'}}, {status});
      const failed = await POST(request(path, {headers: {Cookie: `tropa_session=${token}`}}), context(path));
      assert.equal(failed.status, status);
      assert.equal(failed.headers.get('set-cookie'), null);
    }
    globalThis.fetch = async () => { throw new Error('Uncertain operation'); };
    const uncertain = await POST(request(path, {headers: {Cookie: `tropa_session=${token}`}}), context(path));
    assert.equal(uncertain.status, 502);
    assert.equal(uncertain.headers.get('set-cookie'), null);
  }
});
