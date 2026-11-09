import test from 'node:test';
import assert from 'node:assert/strict';
import {bindMapAttributionCollapse} from '../lib/map-attribution.ts';

function gesture(host, type, path) {
  const event = new Event(type);
  Object.defineProperty(event, 'composedPath', {value: () => path});
  host.dispatchEvent(event);
}

test('credit links and their toggle survive pointerdown until click; the next map gesture still collapses once', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const host = new EventTarget(), credit = new EventTarget(), link = new EventTarget();
  let collapsed = 0;
  const cleanup = bindMapAttributionCollapse(host, credit, () => {collapsed++;});
  gesture(host, 'pointerdown', [link, credit, host]);
  gesture(host, 'pointerdown', [credit, host]);
  gesture(host, 'wheel', [link, credit, host]);
  t.mock.timers.tick(5000);
  assert.equal(collapsed, 0, 'own credit controls must remain mounted for their click and scroll');
  gesture(host, 'pointerdown', [host]);
  assert.equal(collapsed, 1, 'an ignored credit press must not consume the subsequent map gesture');
  gesture(host, 'wheel', [host]);
  t.mock.timers.tick(5000);
  assert.equal(collapsed, 1, 'the timer and both listeners are retired together');
  cleanup();
});

test('timeout collapses at five seconds, while pinning or unmount cleanup cancels all callbacks', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const host = new EventTarget(), credit = new EventTarget();
  let collapsed = 0;
  const cleanup = bindMapAttributionCollapse(host, credit, () => {collapsed++;});
  t.mock.timers.tick(4999); assert.equal(collapsed, 0);
  t.mock.timers.tick(1); assert.equal(collapsed, 1);
  cleanup();
  const pinnedCleanup = bindMapAttributionCollapse(host, credit, () => {collapsed++;});
  pinnedCleanup();
  gesture(host, 'pointerdown', [host]);
  gesture(host, 'wheel', [host]);
  t.mock.timers.tick(5000);
  assert.equal(collapsed, 1);
});
