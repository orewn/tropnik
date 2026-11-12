import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {bindMapAttributionCollapse} from '../lib/map-attribution.ts';

function gesture(host, type, path) {
  const event = new Event(type, {cancelable: true});
  Object.defineProperty(event, 'composedPath', {value: () => path});
  host.dispatchEvent(event);
  return event;
}

const engagementTypes = ['pointerdown', 'wheel', 'keydown', 'focusin'];
class CaptureLayout extends EventTarget {
  addEventListener(type, listener, options) {
    assert.equal(options?.capture, true, 'panel handlers may stop bubbling; engagement must be captured first');
    super.addEventListener(type, listener, options);
  }
}
function assertNoListeners(host, layout) {
  for (const type of ['pointerdown', 'wheel']) assert.equal(getEventListeners(host, type).length, 0);
  for (const type of engagementTypes) assert.equal(getEventListeners(layout, type).length, 0);
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
  const host = new EventTarget(), credit = new EventTarget(), layout = new CaptureLayout();
  let collapsed = 0;
  const cleanup = bindMapAttributionCollapse(host, credit, () => {collapsed++;}, layout);
  t.mock.timers.tick(4999); assert.equal(collapsed, 0);
  t.mock.timers.tick(1); assert.equal(collapsed, 1);
  assertNoListeners(host, layout);
  cleanup();
  const pinnedCleanup = bindMapAttributionCollapse(host, credit, () => {collapsed++;}, layout);
  pinnedCleanup();
  assertNoListeners(host, layout);
  gesture(host, 'pointerdown', [host]);
  gesture(host, 'wheel', [host]);
  for (const type of engagementTypes) gesture(layout, type, [layout]);
  t.mock.timers.tick(5000);
  assert.equal(collapsed, 1);
});

for (const type of engagementTypes) test(`adjacent panel ${type} keeps geometry stable across the idle deadline and later gestures`, t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const host = new EventTarget(), credit = new EventTarget(), layout = new CaptureLayout(), panel = new EventTarget();
  let collapsed = 0;
  const cleanup = bindMapAttributionCollapse(host, credit, () => {collapsed++;}, layout);
  t.mock.timers.tick(4990);
  assert.equal(gesture(layout, type, [panel, layout]).defaultPrevented, false, 'native panel input must remain available');
  t.mock.timers.tick(10000);
  assert.equal(collapsed, 0, 'the five-second timer must not resize an engaged drawer');
  // A later-mounted Stories panel needs no new binding, and pointer release
  // or a gap between gestures must not re-arm the idle timer.
  const stories = new EventTarget();
  gesture(layout, 'pointerup', [panel, layout]);
  gesture(layout, 'pointerdown', [stories, layout]);
  t.mock.timers.tick(60000);
  assert.equal(collapsed, 0, 'geometry stays stable between separate panel interactions');
  gesture(layout, 'pointerdown', [host, layout]);
  assert.equal(collapsed, 0, 'capture must leave the real map gesture to its existing handler');
  gesture(host, 'pointerdown', [host, layout]);
  assert.equal(collapsed, 1, 'the next map gesture must still collapse, once');
  assertNoListeners(host, layout);
  gesture(host, 'wheel', [host, layout]);
  t.mock.timers.tick(10000);
  assert.equal(collapsed, 1);
  cleanup();
});

test('keyboard focus entering a credit from outside keeps its link mounted without consuming the next map wheel', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const host = new EventTarget(), credit = new EventTarget(), layout = new CaptureLayout(), link = new EventTarget();
  let collapsed = 0;
  const cleanup = bindMapAttributionCollapse(host, credit, () => {collapsed++;}, layout);
  t.mock.timers.tick(4999);
  gesture(layout, 'focusin', [link, credit, host, layout]);
  t.mock.timers.tick(1);
  assert.equal(collapsed, 0, 'focus arriving via Tab must protect the newly focused link before the timeout');
  for (const type of ['keydown', 'pointerdown', 'wheel']) gesture(layout, type, [link, credit, host, layout]);
  gesture(host, 'pointerdown', [link, credit, host, layout]);
  gesture(host, 'wheel', [link, credit, host, layout]);
  t.mock.timers.tick(5000);
  assert.equal(collapsed, 0);
  gesture(layout, 'wheel', [host, layout]);
  gesture(host, 'wheel', [host, layout]);
  assert.equal(collapsed, 1);
  assertNoListeners(host, layout);
  cleanup();
});

test('map focus does not cancel the untouched idle timeout; cleanup after panel engagement removes every listener', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const host = new EventTarget(), credit = new EventTarget(), layout = new CaptureLayout();
  let collapsed = 0;
  const cleanup = bindMapAttributionCollapse(host, credit, () => {collapsed++;}, layout);
  gesture(layout, 'focusin', [host, layout]);
  gesture(layout, 'keydown', [host, layout]);
  t.mock.timers.tick(5000);
  assert.equal(collapsed, 1, 'map focus and keys must not be mistaken for engagement outside the map');
  assertNoListeners(host, layout);
  cleanup();
  const unmount = bindMapAttributionCollapse(host, credit, () => {collapsed++;}, layout);
  gesture(layout, 'pointerdown', [new EventTarget(), layout]);
  unmount(); unmount();
  assertNoListeners(host, layout);
  gesture(host, 'pointerdown', [host, layout]);
  for (const type of engagementTypes) gesture(layout, type, [layout]);
  t.mock.timers.tick(60000);
  assert.equal(collapsed, 1, 'unmount after preserving geometry must leave no callbacks');
});
