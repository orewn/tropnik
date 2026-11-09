import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {invocationSchema, driverMessageSchema, sessionOptionsSchema} from '../scripts/connector-preview/protocol.mjs';
import {createPreviewBinding} from '../scripts/connector-preview/host-binding.mjs';
import {connectorResponse, connectorErrorRecovery} from '../lib/connector-errors.mts';

const grant = {connectorId:'fixture-connector', actionName:'read', readOnly:true};
const invocation = args => ({connectorId:grant.connectorId, actionName:grant.actionName, arguments:args});
const request = body => new Request('https://preview.invalid/invoke', {
  method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body),
});

test('connector arguments retain arbitrary JSON values while the invocation envelope stays strict', () => {
  const input = invocation({query:'trail', empty:null, enabled:true, nested:{items:[1, 'two', null]}});
  assert.deepEqual(invocationSchema.parse(input), input);
  for (const invalid of [
    {...input, accountId:'not-site-owned'}, {...input, nativeTool:'not-site-owned'},
    {...input, arguments:[]}, {...input, arguments:null},
    {connectorId:grant.connectorId, actionName:grant.actionName},
  ]) assert.equal(invocationSchema.safeParse(invalid).success, false);
});

test('driver response records and real UUIDs remain compatible after the Zod upgrade', () => {
  const response = {jsonrpc:'2.0', id:randomUUID(), result:{content:[{type:'text', text:'fixture'}], structuredContent:null}};
  assert.deepEqual(driverMessageSchema.parse(response), response);
  assert.deepEqual(driverMessageSchema.parse({jsonrpc:'2.0', method:'stop'}), {jsonrpc:'2.0', method:'stop'});
  const failure = {jsonrpc:'2.0', id:randomUUID(), error:{code:-32000, message:'Fixture failure', data:{retry:false}}};
  assert.deepEqual(driverMessageSchema.parse(failure), failure);
  assert.equal(driverMessageSchema.safeParse({...response, result:[]}).success, false);
  assert.equal(driverMessageSchema.safeParse({...response, id:'invalid'}).success, false);
});

test('preview limit defaults and safe integer bounds survive the Zod migration', () => {
  assert.deepEqual(sessionOptionsSchema.parse({}), {timeoutMs:120000, maxConcurrent:64});
  for (const invalid of [{timeoutMs:0}, {timeoutMs:2**31}, {maxConcurrent:1.5},
    {maxCalls:Number.MAX_SAFE_INTEGER+1}, {lifetimeMs:-1}, {unownedOption:true}]) {
    assert.equal(sessionOptionsSchema.safeParse(invalid).success, false);
  }
});

test('preview binding calls only the granted action and preserves MCP JSON content', async () => {
  const calls = [];
  const binding = createPreviewBinding({tools:[{...grant, invoke:async args => {
    calls.push(args);
    return {content:[{type:'text', text:'route'}], structuredContent:{items:[null, true, 42]}, requestId:'fixture-1'};
  }}]});
  try {
    const args = {nested:{query:'trail', value:null}, limit:3};
    const response = await binding.fetch(request(invocation(args)));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {status:'success', requestId:'fixture-1',
      result:{content:[{type:'text', text:'route'}], structuredContent:{items:[null, true, 42]}}});
    assert.deepEqual(calls, [args]);
    const denied = await binding.fetch(request({...invocation({}), actionName:'write'}));
    assert.equal((await denied.json()).status, 'tool_not_allowed');
    assert.equal(calls.length, 1);
  } finally { binding.close(); }
});

test('invalid invocation fields are rejected before a connector tool can run', async () => {
  let called = false;
  const binding = createPreviewBinding({tools:[{...grant, invoke:async () => {
    called = true; return {content:[]};
  }}]});
  try {
    const response = await binding.fetch(request({...invocation({}), accountId:'injected'}));
    assert.equal((await response.json()).status, 'invalid_request');
    assert.equal(called, false);
    binding.close();
    assert.equal((await (await binding.fetch(request(invocation({})))).json()).status, 'binding_unavailable');
  } finally { binding.close(); }
});

test('provider tool errors remain failures rather than becoming a successful result', async () => {
  const binding = createPreviewBinding({tools:[{...grant, invoke:async () => ({
    content:[{type:'text', text:'Rate limited'}], isError:true,
    structuredContent:{error_code:'RATE_LIMITED', retry_after_seconds:2},
  })}]});
  try {
    const result = await (await binding.fetch(request(invocation({})))).json();
    assert.equal(result.status, 'rate_limited');
    assert.equal(result.retryAfterMs, 2000);
    assert.equal(result.result, undefined);
    assert.equal(result.isError, undefined);
  } finally { binding.close(); }
});

test('public connector responses keep null JSON and reject ambiguous raw error envelopes', async () => {
  const good = connectorResponse({status:'success', result:{content:[], structuredContent:null}, requestId:'fixture-2'});
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await good.json(), {status:'success', result:{content:[], structuredContent:null}, requestId:'fixture-2'});
  const bad = connectorResponse({status:'success', result:{content:[]}, error:'ambiguous'});
  assert.equal(bad.status, 502);
  assert.equal((await bad.json()).status, 'upstream_error');
});

test('connector recovery offers reconnect only for a confirmed authentication request', () => {
  const href = 'https://preview.invalid/connect';
  assert.deepEqual(connectorErrorRecovery({status:'reauthentication_required', message:'Connect again'}, 'Fixture', href), {
    message:'Connect again', action:{label:'Connect Fixture', href},
  });
  assert.deepEqual(connectorErrorRecovery({status:'rate_limited', message:'Try later'}, 'Fixture', href), {message:'Try later'});
});
