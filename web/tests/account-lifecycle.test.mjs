import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {parseAccountAction, validAccountPassword, clearsAccountSession} from '../lib/account-action.ts';

test('email fragment accepts only a canonical 256-bit token and known action', () => {
  for (const action of ['verify_email', 'reset_password']) {
    const token = randomBytes(32).toString('base64url');
    assert.deepEqual(parseAccountAction(`#action=${action}&token=${token}`), {action, token});
  }
  const token = 'A'.repeat(43);
  for (const value of ['', `?action=verify_email&token=${token}`, `#action=login&token=${token}`, `#action=verify_email&token=short`, `#action=verify_email&token=${'A'.repeat(42)}B`, `#action=verify_email&action=reset_password&token=${token}`, `#action=verify_email&token=${token}&token=${token}`, `#action=verify_email&token=${token}&next=https://other.invalid`, '#'.repeat(201)]) {
    assert.equal(parseAccountAction(value), null, value);
  }
});

test('password confirmation uses the shared Unicode character bounds', () => {
  assert.equal(validAccountPassword('short'), false);
  assert.equal(validAccountPassword('🧭'.repeat(12)), true);
  assert.equal(validAccountPassword('a'.repeat(128)), true);
  assert.equal(validAccountPassword('🧭'.repeat(129)), false);
});

test('reset and deletion clear the browser session only on confirmed success', () => {
  for (const path of [['me', 'delete'], ['auth', 'password', 'reset']]) {
    assert.equal(clearsAccountSession('POST', path, 200), true);
    assert.equal(clearsAccountSession('POST', path, 204), true);
    for (const status of [400, 403, 409, 429, 500, 503]) assert.equal(clearsAccountSession('POST', path, status), false);
    assert.equal(clearsAccountSession('GET', path, 200), false);
  }
  assert.equal(clearsAccountSession('POST', ['auth', 'email', 'confirm'], 200), false);
  assert.equal(clearsAccountSession('POST', ['auth', 'password', 'request'], 202), false);
});
