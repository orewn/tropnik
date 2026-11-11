import test from 'node:test';
import assert from 'node:assert/strict';
import {bindMapLabelReflow} from '../lib/map-direction-layout.ts';

function environment(t) {
  class Element extends EventTarget {
    children = [];
    parentElement = null;
    constructor(className=''){super();this.className=className;}
    closest(selector) {
      if(selector === '.explore-layout'&&this.root)return this.root;
      return this.matches(selector)?this:this.parentElement?.closest(selector)??null;
    }
    querySelectorAll(selector) {return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
    querySelector(selector) {return this.querySelectorAll(selector)[0]??null;}
    matches(selector) {return selector.split(',').some(value=>value.startsWith('.')&&this.className.split(' ').includes(value.slice(1)));}
  }
  const root = new Element('explore-layout'), viewport = new Element('atlas-canvas'), oldCard = new Element('fact-card');
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
  return {root, viewport, oldCard, frames, fonts, fontsReady: () => fontsReady(), element: (className='fact-card') => new Element(className),
    resize: () => resizes[0], mutation: () => mutations[0],
    change: (records=[{target: root}]) => mutations[0].callback(records),
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

test('search-card DOM changes leave label geometry alone while the real drawer and overlays stay observed', t => {
  const env=environment(t),panel=env.element('explore-panel'),content=env.element('explore-panel-content'),foot=env.element('panel-foot');
  panel.parentElement=env.root;content.parentElement=panel;foot.parentElement=panel;
  panel.children=[content,foot];env.root.children=[env.oldCard,panel];
  let layouts=0;
  const cleanup=bindMapLabelReflow(env.viewport,()=>{layouts++;});
  env.flush();assert.equal(layouts,1);
  for(let index=0;index<60;index++){
    const row=env.element('region-option'),previous=content.children;
    row.parentElement=content;content.children=[row];
    env.change([
      {type:'childList',target:content,addedNodes:[row],removedNodes:previous},
      {type:'attributes',attributeName:'class',target:row},
      {type:'attributes',attributeName:'class',target:content},
      {type:'childList',target:foot,addedNodes:[],removedNodes:[]},
    ]);
    env.flush();
  }
  assert.equal(layouts,1,'typing/filtering inside a fixed drawer cannot request repeated map label layouts');
  assert.deepEqual(env.resize().targets,new Set([env.viewport,env.oldCard,panel]));
  env.resize().callback([{target:panel}]);env.flush();assert.equal(layouts,2,'a real drawer resize still reflows labels');
  env.change([{type:'attributes',attributeName:'class',target:panel}]);env.flush();assert.equal(layouts,3,'drawer visibility/transform state is not ignored');
  const overlay=env.element('map-message');overlay.parentElement=env.root;env.root.children.push(overlay);
  env.change([{type:'childList',target:env.root,addedNodes:[overlay],removedNodes:[]}]);env.flush();
  assert.equal(layouts,4);assert.ok(env.resize().targets.has(overlay));
  env.root.children=env.root.children.filter(node=>node!==overlay);
  env.change([{type:'childList',target:env.root,addedNodes:[],removedNodes:[overlay]}]);env.flush();
  assert.equal(layouts,5);assert.ok(!env.resize().targets.has(overlay));
  cleanup();
});

test('real obstacles inserted inside the catalogue remain discoverable and responsive', t => {
  const env=environment(t),panel=env.element('explore-panel'),content=env.element('explore-panel-content');
  panel.parentElement=env.root;content.parentElement=panel;panel.children=[content];env.root.children=[panel];
  let layouts=0;const cleanup=bindMapLabelReflow(env.viewport,()=>{layouts++;});env.flush();
  const wrapper=env.element('route-content'),overlay=env.element('map-controls'),control=env.element('control');
  wrapper.parentElement=content;overlay.parentElement=wrapper;control.parentElement=overlay;
  wrapper.children=[overlay];overlay.children=[control];content.children=[wrapper];
  env.change([{type:'childList',target:content,addedNodes:[wrapper],removedNodes:[]}]);env.flush();
  assert.equal(layouts,2);assert.ok(env.resize().targets.has(overlay));
  env.change([{type:'attributes',attributeName:'hidden',target:wrapper}]);env.flush();assert.equal(layouts,3,'ancestor visibility still affects an actual obstacle');
  env.change([{type:'attributes',attributeName:'class',target:control}]);env.flush();assert.equal(layouts,4,'nested controls retain their existing invalidation behavior');
  content.children=[];
  env.change([{type:'childList',target:content,addedNodes:[],removedNodes:[wrapper]}]);env.flush();
  assert.equal(layouts,5);assert.ok(!env.resize().targets.has(overlay));
  cleanup();
});
