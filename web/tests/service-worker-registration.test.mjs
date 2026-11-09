import test from 'node:test';
import assert from 'node:assert/strict';
import {watchServiceWorkerRegistration} from '../lib/service-worker-registration.ts';

class Target extends EventTarget {
  listeners = new Map();
  addEventListener(name, listener, options) {super.addEventListener(name, listener, options); const set = this.listeners.get(name) || new Set(); set.add(listener); this.listeners.set(name, set);}
  removeEventListener(name, listener, options) {super.removeEventListener(name, listener, options); this.listeners.get(name)?.delete(listener);}
  count(name) {return this.listeners.get(name)?.size || 0;}
}
const worker = () => Object.assign(new Target(), {state: 'installing'});

test('already installing and newly found workers get one listener and release it on terminal state', () => {
  const first = worker(), registration = Object.assign(new Target(), {installing: first});
  let announced = 0;
  const cleanup = watchServiceWorkerRegistration(registration, () => {announced++;});
  assert.equal(first.count('statechange'), 1);
  registration.dispatchEvent(new Event('updatefound'));
  assert.equal(first.count('statechange'), 1);
  first.state = 'installed'; first.dispatchEvent(new Event('statechange'));
  assert.equal(announced, 1); assert.equal(first.count('statechange'), 0);
  const second = worker(); registration.installing = second;
  registration.dispatchEvent(new Event('updatefound'));
  second.state = 'redundant'; second.dispatchEvent(new Event('statechange'));
  assert.equal(announced, 1); assert.equal(second.count('statechange'), 0);
  cleanup(); assert.equal(registration.count('updatefound'), 0);
});

test('unmount detaches registration and all pending workers; stale callbacks cannot revive a remount', () => {
  const first = worker(), second = worker(), registration = Object.assign(new Target(), {installing: first});
  let oldCalls = 0, newCalls = 0;
  const cleanup = watchServiceWorkerRegistration(registration, () => {oldCalls++;});
  const staleUpdate = [...registration.listeners.get('updatefound')][0];
  const staleState = [...first.listeners.get('statechange')][0];
  registration.installing = second; registration.dispatchEvent(new Event('updatefound'));
  cleanup();
  assert.equal(first.count('statechange'), 0); assert.equal(second.count('statechange'), 0);
  staleUpdate(); first.state = 'installed'; staleState();
  assert.equal(oldCalls, 0); assert.equal(second.count('statechange'), 0);
  const nextCleanup = watchServiceWorkerRegistration(registration, () => {newCalls++;});
  assert.equal(registration.count('updatefound'), 1); assert.equal(second.count('statechange'), 1);
  second.state = 'installed'; second.dispatchEvent(new Event('statechange'));
  assert.equal(newCalls, 1); assert.equal(oldCalls, 0);
  nextCleanup();
});
