import test from 'node:test';
import assert from 'node:assert/strict';
import {probeServiceReadiness} from '../lib/service-readiness.ts';
import {serviceStatus, ApiError} from '../lib/api.ts';

test('unconfigured service stays preview without a network request', async () => {
  for (const config of [undefined, '', '   ']) {
    const result = await probeServiceReadiness(config, {fetcher: async () => assert.fail('No endpoint should be contacted')});
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {configured:false, connected:false, version:'0.1.0', mode:'preview'});
  }
});

test('connected requires the database readiness endpoint and its exact success body', async () => {
  const result = await probeServiceReadiness('http://api:8080', {fetcher: async (url, init) => {
    assert.equal(String(url), 'http://api:8080/api/v1/health/ready');
    assert.equal(init.method, 'GET');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('Authorization'), null);
    return Response.json({data:{status:'ready'}, meta:{mode:'production'}});
  }});
  assert.equal(result.status, 200);
  assert.equal(result.body.configured, true);
  assert.equal(result.body.connected, true);
  assert.equal(result.body.mode, 'connected');
});

test('liveness, non-200, malformed and oversized responses never report ready', async () => {
  const responses = [
    () => Response.json({data:{status:'ok'}}),
    () => Response.json({data:{status:'ready'}}),
    () => Response.json({data:{status:'ready'},meta:{mode:'preview'}}),
    () => Response.json({data:{status:'ready'}}, {status:201}),
    () => Response.json({data:{status:'ready'}}, {status:503}),
    () => Response.json({data:{status:'ready'},error:{code:'not_ready'}}),
    () => Response.json({status:'ready'}),
    () => new Response('not json', {headers:{'Content-Type':'application/json'}}),
    () => new Response('<html>Sign in</html>', {headers:{'Content-Type':'text/html'}}),
    () => Response.json({data:{status:'ready'},meta:{mode:'production'},padding:'x'.repeat(5000)}),
  ];
  for (const response of responses) {
    const result = await probeServiceReadiness('https://api.example', {fetcher:async () => response()});
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {configured:true, connected:false, version:'0.1.0', mode:'unavailable', reason:'upstream_unavailable'});
  }
});

test('unsafe configuration is not contacted or disclosed', async () => {
  for (const config of ['http://remote.example', 'https://user:private-value@api.example', 'file:///private', 'https://api.example?token=private-value', 'https://api.example#fragment']) {
    const result = await probeServiceReadiness(config, {fetcher:async () => assert.fail('Invalid endpoint was contacted')});
    assert.equal(result.status, 503);
    assert.equal(result.body.configured, true);
    assert.equal(result.body.connected, false);
    assert.equal(result.body.reason, 'service_config');
    assert.doesNotMatch(JSON.stringify(result.body), /private-value|api\.example|remote\.example/);
  }
});

test('network failure does not expose upstream error text', async () => {
  const result = await probeServiceReadiness('https://api.example', {fetcher:async () => { throw new Error('PRIVATE-CONNECTION-DETAIL'); }});
  assert.equal(result.status, 503);
  assert.equal(result.body.connected, false);
  assert.equal(result.body.reason, 'upstream_unavailable');
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE-CONNECTION-DETAIL/);
});

test('timeout aborts a stalled readiness request and returns unavailable', async () => {
  let aborted = false;
  const result = await probeServiceReadiness('https://api.example', {timeoutMs:10, fetcher:async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted','AbortError')); }, {once:true});
  })});
  assert.equal(aborted, true);
  assert.equal(result.status, 503);
  assert.equal(result.body.connected, false);
});

test('client keeps auth disabled for preview or failed readiness and rejects presence-only status', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({configured:false,connected:false,mode:'preview'});
    assert.equal(await serviceStatus(), false);
    globalThis.fetch = async () => Response.json({configured:true,connected:false,mode:'unavailable'}, {status:503});
    await assert.rejects(serviceStatus(), error => error instanceof ApiError && error.status === 503);
    globalThis.fetch = async () => Response.json({connected:true});
    await assert.rejects(serviceStatus(), error => error instanceof ApiError && error.status === 502);
    globalThis.fetch = async () => Response.json({configured:false,connected:true,mode:'connected'});
    await assert.rejects(serviceStatus(), error => error instanceof ApiError);
    globalThis.fetch = async () => Response.json({configured:true,connected:true,mode:'connected'});
    assert.equal(await serviceStatus(), true);
  } finally { globalThis.fetch = original; }
});
