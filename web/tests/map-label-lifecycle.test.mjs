import test from 'node:test';
import assert from 'node:assert/strict';
import {bindMapLabelReflow} from '../lib/map-direction-layout.ts';

function environment(t) {
  class Element extends EventTarget {
    children = [];
    closest(selector) {return selector === '.explore-layout' ? this.root || null : null;}
    querySelectorAll() {return this.children;}
    matches() {return false;}
  }
  const root = new Element(), viewport = new Element(), oldCard = new Element();
  viewport.root = root; root.children = [oldCard];
  let serial = 0, fontsReady;
  const resizes = [], mutations = [];
  const frames = new Map(), fonts = new EventTarget();
  fonts.ready = new Promise(resolve => {fontsReady = resolve;});
  const visual = new EventTarget(), window = Object.assign(new EventTarget(), {visualViewport: visual});
  const globals = {
    Element, document: {fonts}, window,
    requestAnimationFrame: callback => {frames.set(++serial, callback); return serial;},
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class {
      targets = new Set(); removed = [];
      constructor(callback) {this.callback = callback; resizes.push(this);}
      observe(element) {this.targets.add(element);}
      unobserve(element) {this.targets.delete(element); this.removed.push(element);}
      disconnect() {this.targets.clear();}
    },
    MutationObserver: class {
      constructor(callback) {this.callback = callback; mutations.push(this);}
      observe() {} disconnect() {this.disconnected = true;}
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, value});
    t.after(() => {if (old) Object.defineProperty(globalThis, name, old); else delete globalThis[name];});
  }
  return {root, viewport, oldCard, frames, fonts, fontsReady: () => fontsReady(), element: () => new Element(),
    resize: () => resizes[0], mutation: () => mutations[0],
    change: () => mutations[0].callback([{target: root}]),
    flush: () => {const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame();},
  };
}

test('label reflow unobserves removed cards and messages while retaining only current obstacles', t => {
  const env = environment(t);
  let layouts = 0;
  const cleanup = bindMapLabelReflow(env.viewport, () => {layouts++;});
  assert.deepEqual(env.resize().targets, new Set([env.viewport, env.oldCard]));
  env.flush(); assert.equal(layouts, 1);
  for (let i = 0; i < 40; i++) {
    const previous = env.root.children[0], next = env.element(); env.root.children = [next];
    env.change(); env.resize().callback();
    assert.equal(env.frames.size, 1, 'multiple layout signals coalesce');
    assert.deepEqual(env.resize().targets, new Set([env.viewport, next]));
    assert.ok(env.resize().removed.includes(previous));
    env.flush();
  }
  assert.equal(layouts, 41); cleanup();
  assert.equal(env.resize().targets.size, 0); assert.equal(env.frames.size, 0);
});

test('queued observer callbacks and late font readiness cannot restart work after unmount', async t => {
  const env = environment(t);
  let layouts = 0;
  const cleanup = bindMapLabelReflow(env.viewport, () => {layouts++;});
  const staleFrame = [...env.frames.values()][0];
  cleanup();
  staleFrame(); env.resize().callback(); env.change();
  env.fontsReady(); await Promise.resolve();
  env.fonts.dispatchEvent(new Event('loadingdone'));
  assert.equal(layouts, 0); assert.equal(env.frames.size, 0);
  assert.equal(env.resize().targets.size, 0); assert.equal(env.mutation().disconnected, true);
});
