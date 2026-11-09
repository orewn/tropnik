import test from 'node:test';
import assert from 'node:assert/strict';
import {bindMapDirectionButton} from '../lib/map-direction-interaction.ts';

// EventTarget exercises the real cancellation flags and listener lifecycle.
// The final step models bubbling to the map; it does not model DOM hit testing,
// CSS, native focus, or the browser's generation of a click from a pointer/key.
function event(type, values = {}) {
  const result = new Event(type, {bubbles: true, cancelable: true});
  for (const [name, value] of Object.entries(values)) Object.defineProperty(result, name, {value});
  return result;
}

function fixture() {
  const button = Object.assign(new EventTarget(), {disabled: false, hidden: false, isConnected: true});
  const map = new EventTarget(), calls = [], received = [];
  let pendingNavigation = true;
  const types = ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'keydown', 'keyup', 'click'];
  for (const type of types) map.addEventListener(type, () => received.push(type));
  const unbind = bindMapDirectionButton(button, () => {
    assert.equal(pendingNavigation, false, 'stale camera/GPS work must be cancelled before selection');
    calls.push('activate');
  }, () => {pendingNavigation = false; calls.push('press');});
  const dispatch = (type, values = {}) => {
    const value = event(type, values);
    assert.equal(button.dispatchEvent(value), true, 'native default actions must remain available');
    if (value.bubbles && !value.cancelBubble) map.dispatchEvent(value);
    assert.equal(value.defaultPrevented, false);
    return value;
  };
  return {button, calls, received, dispatch, unbind, types, queueNavigation: () => {pendingNavigation = true;}};
}

test('pointer and touch gestures stay inside the region button and activate only on click', () => {
  const env = fixture();
  const down = env.dispatch('pointerdown', {isPrimary: true, button: 0, pointerType: 'mouse'});
  assert.equal(down.cancelBubble, true);
  assert.deepEqual(env.calls, ['press']);
  for (const type of ['mousedown', 'touchstart', 'dblclick']) {
    assert.equal(env.dispatch(type).cancelBubble, true, type);
    assert.deepEqual(env.calls, ['press'], `${type} must not synthesize selection`);
  }
  env.queueNavigation();
  const click = env.dispatch('click', {detail: 1});
  assert.equal(click.cancelBubble, true);
  assert.deepEqual(env.calls, ['press', 'press', 'activate']);
  assert.deepEqual(env.received, [], 'the map cannot start a competing drag or double-click zoom');
});

test('Enter and Space keep native activation and keyboard-only clicks cancel stale work first', () => {
  for (const key of ['Enter', ' ']) {
    const env = fixture();
    assert.equal(env.dispatch('keydown', {key}).cancelBubble, true);
    assert.equal(env.dispatch('keyup', {key}).cancelBubble, true);
    assert.deepEqual(env.calls, [], 'key handlers must leave click synthesis to the browser');
    assert.equal(env.dispatch('click', {detail: 0}).cancelBubble, true);
    assert.deepEqual(env.calls, ['press', 'activate']);
    assert.deepEqual(env.received, []);
  }
});

test('unrelated keys retain bubbling and secondary pointer presses do not cancel navigation', () => {
  const env = fixture();
  for (const key of ['Tab', 'Escape', 'ArrowRight']) {
    assert.equal(env.dispatch('keydown', {key}).cancelBubble, false);
    assert.equal(env.dispatch('keyup', {key}).cancelBubble, false);
  }
  for (const values of [{isPrimary: false, button: 0}, {isPrimary: true, button: 1}, {isPrimary: true, button: 2}]) {
    assert.equal(env.dispatch('pointerdown', values).cancelBubble, true);
  }
  assert.deepEqual(env.calls, []);
  assert.deepEqual(env.received, ['keydown', 'keyup', 'keydown', 'keyup', 'keydown', 'keyup']);
});

test('disabled, grouped-away, and disconnected buttons ignore late clicks', () => {
  for (const state of [{disabled: true}, {hidden: true}, {isConnected: false}]) {
    const env = fixture();
    Object.assign(env.button, state);
    for (const detail of [0, 1]) assert.equal(env.dispatch('click', {detail}).cancelBubble, true);
    assert.deepEqual(env.calls, [], JSON.stringify(state));
    assert.deepEqual(env.received, [], 'a stale click cannot fall through to map selection');
  }
});

test('stopping propagation preserves same-button listeners and their default actions', () => {
  const env = fixture(), observed = [];
  env.button.addEventListener('click', value => observed.push({cancelBubble: value.cancelBubble, defaultPrevented: value.defaultPrevented}));
  env.dispatch('click', {detail: 1});
  assert.deepEqual(observed, [{cancelBubble: true, defaultPrevented: false}]);
  assert.deepEqual(env.calls, ['press', 'activate']);
});

test('cleanup releases every gesture/key/click listener without removing unrelated listeners', () => {
  const env = fixture(), own = [];
  env.button.addEventListener('click', () => own.push('click'));
  env.unbind();
  env.unbind();
  for (const type of env.types) {
    const value = env.dispatch(type, {isPrimary: true, button: 0, key: 'Enter', detail: 1});
    assert.equal(value.cancelBubble, false, `${type} must have no remaining helper handler`);
  }
  assert.deepEqual(env.calls, []);
  assert.deepEqual(env.received, env.types);
  assert.deepEqual(own, ['click']);
});
