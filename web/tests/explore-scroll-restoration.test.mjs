import test from 'node:test';
import assert from 'node:assert/strict';
import {bindExploreScrollRestoration} from '../lib/explore-scroll-restoration.ts';

function fixture(mode = 'auto') {
  const environment = new EventTarget();
  environment.history = {scrollRestoration:mode};
  return environment;
}

test('full-page leave releases ownership and BFCache return reacquires it without wheel or scroll handlers', () => {
  const environment = fixture(), registrations = [];
  const add = environment.addEventListener.bind(environment);
  environment.addEventListener = (type, ...args) => {registrations.push(type);add(type, ...args);};
  const dispose = bindExploreScrollRestoration(environment);
  assert.equal(environment.history.scrollRestoration, 'manual');
  assert.deepEqual(registrations, ['pagehide', 'pageshow']);
  environment.dispatchEvent(new Event('pagehide'));
  assert.equal(environment.history.scrollRestoration, 'auto');
  environment.dispatchEvent(new Event('pagehide'));
  assert.equal(environment.history.scrollRestoration, 'auto');
  environment.dispatchEvent(new Event('pageshow'));
  assert.equal(environment.history.scrollRestoration, 'manual');
  environment.dispatchEvent(new Event('pageshow'));
  dispose();
  assert.equal(environment.history.scrollRestoration, 'auto', 'duplicate pageshow must not replace the original mode with manual');
});

test('cleanup preserves an existing owner and cannot reacquire after disposal or a remount', () => {
  const environment = fixture('manual');
  const dispose = bindExploreScrollRestoration(environment);
  dispose();dispose();
  assert.equal(environment.history.scrollRestoration, 'manual');
  environment.history.scrollRestoration = 'auto';
  environment.dispatchEvent(new Event('pageshow'));
  assert.equal(environment.history.scrollRestoration, 'auto');
  const remount = bindExploreScrollRestoration(environment);
  assert.equal(environment.history.scrollRestoration, 'manual');
  remount();
  assert.equal(environment.history.scrollRestoration, 'auto');
});
