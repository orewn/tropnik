import test from 'node:test';
import assert from 'node:assert/strict';
import {backendRequestHeaders, backendResponseHeaders} from '../lib/backend-forwarding.ts';

const secret = 'ab'.repeat(32); // isolated test fixture, not a deployment secret
const other = 'cd'.repeat(32);
const ingress = (ip, proof=secret) => new Headers({'X-Real-IP':ip,'X-Tropa-Proxy-Token':proof});

test('two clients behind the same authenticated BFF keep distinct upstream IPs', () => {
  for (const ip of ['198.51.100.4','198.51.100.5','2001:db8::1234']) {
    const result = backendRequestHeaders(ingress(ip), undefined, secret);
    assert.equal(result.get('X-Real-IP'), ip);
    assert.equal(result.get('X-Tropa-Proxy-Token'), secret);
  }
  assert.equal(backendRequestHeaders(ingress('198.51.100.4', secret.toUpperCase()), undefined, secret).get('X-Real-IP'), '198.51.100.4');
});

test('missing configuration, forged proof and malformed addresses fail closed', () => {
  for (const [incoming, configured] of [
    [ingress('198.51.100.4'), undefined],
    [ingress('198.51.100.4'), ''],
    [ingress('198.51.100.4'), 'short'],
    [ingress('198.51.100.4',other), secret],
    [new Headers({'X-Real-IP':'198.51.100.4','X-Forwarded-For':'198.51.100.4'}), secret],
    [ingress('198.51.100.4, 198.51.100.5'), secret],
    [ingress('198.51.100.4:1234'), secret],
    [ingress('[2001:db8::1]'), secret],
    [ingress('fe80::1%eth0'), secret],
    [ingress('not-an-address'), secret],
    [ingress('198.51.100.4',`${secret}, ${secret}`), secret],
  ]) {
    const result = backendRequestHeaders(incoming, undefined, configured);
    assert.equal(result.get('X-Real-IP'), null);
    assert.equal(result.get('X-Tropa-Proxy-Token'), null);
    assert.equal(result.get('X-Forwarded-For'), null);
  }
});

test('upstream authorization is derived only from a valid server cookie', () => {
  const incoming = ingress('198.51.100.4');
  incoming.set('Authorization','Bearer attacker');
  incoming.set('Cookie','untrusted=value');
  incoming.set('Idempotency-Key','same-operation-0001');
  incoming.set('X-Forwarded-Host','attacker.example');
  const session = 'a'.repeat(43);
  const result = backendRequestHeaders(incoming, session, secret);
  assert.equal(result.get('Authorization'), `Bearer ${session}`);
  assert.equal(result.get('Idempotency-Key'), 'same-operation-0001');
  assert.equal(result.get('Cookie'), null);
  assert.equal(result.get('X-Forwarded-Host'), null);
  assert.equal(backendRequestHeaders(incoming, 'short', secret).get('Authorization'), null);
});

test('rate-limit delay reaches the browser without leaking ingress headers', () => {
  const upstream = ingress('198.51.100.4');
  upstream.set('Retry-After','59');
  upstream.set('Set-Cookie','internal=never-forward');
  const result = backendResponseHeaders(upstream);
  assert.equal(result.get('Retry-After'),'59');
  assert.equal(result.get('Cache-Control'),'no-store');
  assert.equal(result.get('Vary'),'Cookie');
  assert.equal(result.get('Set-Cookie'),null);
  assert.equal(result.get('X-Tropa-Proxy-Token'),null);
  assert.equal(result.get('X-Real-IP'),null);
  for (const retry of ['0','-1','99999','9999','60, 60','tomorrow']) {
    assert.equal(backendResponseHeaders(new Headers({'Retry-After':retry})).get('Retry-After'),null);
  }
});
