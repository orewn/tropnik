import test from 'node:test';
import assert from 'node:assert/strict';
import {bindSheetGesture} from '../lib/sheet-gesture.ts';

class Style {
  transform = '';
  properties = new Map();
  setProperty(name, value) {if (name === 'transform') this.transform = value; else this.properties.set(name, value);}
  removeProperty(name) {if (name === 'transform') this.transform = ''; else this.properties.delete(name);}
}
class Element extends EventTarget {
  dataset = {};
  style = new Style();
  captures = new Set();
  reads = 0;
  measure = () => ({height:0, bottom:0});
  getBoundingClientRect() {this.reads++; return this.measure();}
  setPointerCapture(id) {this.captures.add(id);}
  hasPointerCapture(id) {return this.captures.has(id);}
  releasePointerCapture(id) {this.captures.delete(id); this.dispatchEvent(pointer('lostpointercapture', {pointerId:id}));}
}
function pointer(type, values = {}) {
  const event = new Event(type, {cancelable:true});
  for (const [key, value] of Object.entries({pointerId:1, isPrimary:true, button:0, clientX:100, clientY:740, timeStamp:1, ...values})) {
    Object.defineProperty(event, key, {value});
  }
  return event;
}
function click(detail = 1) {
  const event = new Event('click', {cancelable:true});
  Object.defineProperty(event, 'detail', {value:detail});
  return event;
}
function fixture({initialOpen = false, reducedMotion = false} = {}) {
  let open = initialOpen, enabled = true, height = 472, nextId = 0;
  const root = new Element(), panel = new Element(), handle = new Element(), preview = new Element(), list = new Element();
  const environment = new EventTarget(), frames = new Map(), timers = new Map(), commits = [];
  root.measure = () => ({height:780, bottom:844});
  const offset = () => panel.style.transform ? Number(panel.style.transform.match(/,(-?[\d.]+)px,/)[1]) : open ? 0 : height - 156;
  panel.measure = () => ({height, bottom:844 + offset()});
  Object.assign(environment, {
    requestAnimationFrame:fn => {frames.set(++nextId, fn); return nextId;},
    cancelAnimationFrame:id => frames.delete(id),
    setTimeout:fn => {timers.set(++nextId, fn); return nextId;},
    clearTimeout:id => timers.delete(id),
    getComputedStyle:() => ({getPropertyValue:() => '156px'}),
    matchMedia:() => ({matches:reducedMotion}),
  });
  let api;
  api = bindSheetGesture({root,panel,handles:[handle,preview],enabled:() => enabled,getOpen:() => open,setOpen:value => {
    open = value; commits.push(value); api.sync();
  }}, environment);
  let settled = 0;
  panel.addEventListener('tropnik:sheet-settled', () => settled++);
  return {
    api, root, panel, handle, preview, list, environment, frames, timers, commits, offset,
    get open() {return open;}, get settled() {return settled;},
    setOpen(value) {open = value; api.sync();},
    setEnabled(value) {enabled = value;},
    resize(value) {height = value; environment.dispatchEvent(new Event('resize'));},
    down(values = {}, target = handle) {target.dispatchEvent(pointer('pointerdown', values));},
    move(values) {const event=pointer('pointermove', values); environment.dispatchEvent(event); return event;},
    up(values) {environment.dispatchEvent(pointer('pointerup', values));},
    cancel(values = {}) {environment.dispatchEvent(pointer('pointercancel', values));},
    frame() {const pending=[...frames.values()]; frames.clear(); pending.forEach(fn => fn(16));},
    endTransition() {const event=new Event('transitionend'); Object.defineProperty(event,'propertyName',{value:'transform'}); panel.dispatchEvent(event);},
    timersEnd() {const pending=[...timers.values()]; timers.clear(); pending.forEach(fn => fn());},
  };
}

test('a real handle drag follows the last pointer position once per frame and preserves direction reversals', () => {
  const view=fixture();
  view.down();
  const reads=view.panel.reads;
  for(let y=730;y>=540;y-=10) view.move({clientY:y,timeStamp:741-y});
  assert.equal(view.frames.size,1);
  assert.equal(view.panel.reads,reads,'pointermove must not read layout');
  assert.equal(view.commits.length,0,'pointermove must not commit React state');
  view.frame();
  assert.equal(view.offset(),116);
  assert.equal(view.root.dataset.sheetDragging,'true');
  view.move({clientY:640,timeStamp:260}); view.frame();
  assert.equal(view.offset(),216,'reversal follows the finger without restarting from the snap point');
  view.move({clientY:480,timeStamp:500}); view.frame();
  view.up({clientY:480,timeStamp:700});
  assert.equal(view.open,true);
  assert.deepEqual(view.commits,[true]);
  assert.equal(view.root.dataset.sheetDragging,undefined);
  assert.equal(view.offset(),0);
  view.endTransition();
  assert.equal(view.panel.style.transform,'');
  assert.equal(view.timers.size,0);
  assert.equal(view.settled,0,'the real transitionend is already the geometry notification');
  view.api.dispose();
});

test('recent flick velocity snaps while a held finger uses the closest endpoint', () => {
  const fast=fixture({initialOpen:true});
  fast.down({clientY:400,timeStamp:10});
  fast.move({clientY:430,timeStamp:40}); fast.frame();
  fast.up({clientY:430,timeStamp:50});
  assert.equal(fast.open,false,'a short deliberate downward flick closes the drawer');
  fast.api.dispose();
  const held=fixture({initialOpen:true});
  held.down({clientY:400,timeStamp:10});
  held.move({clientY:430,timeStamp:40}); held.frame();
  held.up({clientY:430,timeStamp:600});
  assert.equal(held.open,true,'stale velocity must not close a held, nearly open drawer');
  held.api.dispose();
});

test('a drag consumes its synthetic pointer click but keeps the next tap and keyboard activation', () => {
  const view=fixture();
  view.down(); view.move({clientY:450,timeStamp:300}); view.frame(); view.up({clientY:450,timeStamp:500});
  const ghost=click(); view.handle.dispatchEvent(ghost);
  assert.equal(ghost.defaultPrevented,true);
  const keyboard=click(0); view.handle.dispatchEvent(keyboard);
  assert.equal(keyboard.defaultPrevented,false);
  view.down({clientY:450,timeStamp:510}); view.up({clientY:450,timeStamp:520});
  const next=click(); view.handle.dispatchEvent(next);
  assert.equal(next.defaultPrevented,false,'a quick new tap must not inherit drag suppression');
  assert.deepEqual(view.commits,[true]);
  view.api.dispose();
});

test('cancel and lost capture return to the committed state without an accidental toggle', () => {
  for(const lost of [false,true]) {
    const view=fixture();
    view.down(); view.move({clientY:450,timeStamp:300}); view.frame();
    if(lost) view.handle.dispatchEvent(pointer('lostpointercapture'));
    else view.cancel();
    assert.equal(view.open,false);
    assert.deepEqual(view.commits,[]);
    assert.equal(view.root.dataset.sheetDragging,undefined);
    assert.equal(view.offset(),316);
    assert.equal(view.handle.captures.size,0);
    view.up({clientY:450,timeStamp:500});
    assert.deepEqual(view.commits,[],'a late pointerup after cancel cannot resurrect a gesture');
    view.endTransition();
    view.api.dispose();
  }
});

test('resize invalidates queued frames and reuses the new CSS geometry', () => {
  const view=fixture();
  view.down(); view.move({clientY:500,timeStamp:100});
  const stale=[...view.frames.values()];
  view.resize(360);
  stale.forEach(fn=>fn(16));
  view.frame();
  assert.equal(view.offset(),204);
  assert.equal(view.panel.style.transform,'');
  assert.equal(view.root.dataset.sheetDragging,undefined);
  assert.equal(view.settled,1);
  view.up({clientY:400,timeStamp:200});
  assert.deepEqual(view.commits,[]);
  view.api.dispose();
});

test('external navigation wins over an old pointer and disposal blocks extracted callbacks', () => {
  const view=fixture();
  view.down(); view.move({clientY:500,timeStamp:100});
  const stale=[...view.frames.values()];
  view.setOpen(true);
  view.up({clientY:740,timeStamp:200});
  assert.deepEqual(view.commits,[]);
  assert.equal(view.offset(),0);
  view.api.dispose();
  stale.forEach(fn=>fn(16));
  view.frame(); view.timersEnd();
  assert.equal(view.panel.style.transform,'');
  assert.equal(view.settled,0);
  assert.equal(view.handle.captures.size,0);
});

test('horizontal motion and a second pointer cannot leave a captured or toggled drawer', () => {
  const view=fixture();
  view.down();
  view.move({clientX:180,clientY:735,timeStamp:100});
  assert.equal(view.handle.captures.size,0);
  assert.equal(view.open,false);
  assert.deepEqual(view.commits,[]);
  view.frame();
  view.down(); view.move({clientY:500,timeStamp:100}); view.frame();
  view.environment.dispatchEvent(pointer('pointerdown',{pointerId:2,isPrimary:false,timeStamp:101}));
  assert.equal(view.handle.captures.size,0);
  assert.equal(view.root.dataset.sheetDragging,undefined);
  view.up({clientY:400,timeStamp:200});
  assert.deepEqual(view.commits,[]);
  view.api.dispose();
});

test('content scrolling, desktop layout and nonprimary buttons are never claimed', () => {
  const view=fixture();
  view.down({},view.list);
  assert.equal(view.move({clientY:400,timeStamp:100}).defaultPrevented,false);
  assert.equal(view.frames.size,0);
  view.down({button:2});
  view.down({isPrimary:false});
  view.setEnabled(false); view.down();
  assert.equal(view.handle.captures.size,0);
  assert.equal(view.panel.style.transform,'');
  assert.deepEqual(view.commits,[]);
  view.api.dispose();
});

test('collapsed preview is draggable and reduced motion emits one settled boundary', () => {
  const view=fixture({reducedMotion:true});
  view.down({},view.preview);
  view.move({clientY:400,timeStamp:300}); view.frame();
  view.up({clientY:400,timeStamp:500});
  assert.equal(view.open,true);
  view.frame(); view.timersEnd();
  assert.equal(view.settled,1);
  assert.equal(view.panel.style.transform,'');
  assert.equal(view.preview.captures.size,0);
  view.api.dispose();
});

test('reduced-motion tap, keyboard and programmatic state changes notify after their final geometry', () => {
  const view=fixture({reducedMotion:true});
  view.down(); view.up();
  const activation=click(); view.handle.dispatchEvent(activation);
  assert.equal(activation.defaultPrevented,false);
  view.setOpen(true); view.frame();
  assert.equal(view.settled,1);
  assert.equal(view.offset(),0);
  view.setOpen(false); view.setOpen(true); view.frame();
  assert.equal(view.settled,2,'rapid state changes publish only the latest endpoint');
  assert.equal(view.offset(),0);
  view.api.dispose();
});

test('an interrupted transition falls back once and a new drag starts at its visible position', () => {
  const view=fixture();
  view.down(); view.move({clientY:450,timeStamp:300}); view.frame(); view.up({clientY:450,timeStamp:500});
  assert.equal(view.timers.size,1);
  const obsoleteTimeout=[...view.timers.values()][0];
  // The browser is halfway through the opening transition when grabbed again.
  view.panel.style.transform='translate3d(0,150px,0)';
  view.down({clientY:500,timeStamp:510});
  assert.equal(view.timers.size,0);
  view.move({clientY:540,timeStamp:600}); view.frame();
  assert.equal(view.offset(),190);
  view.up({clientY:540,timeStamp:800});
  assert.equal(view.open,false);
  obsoleteTimeout();
  assert.equal(view.settled,0,'an already dequeued timeout from the old snap cannot finish the new one');
  assert.notEqual(view.panel.style.transform,'');
  view.timersEnd();
  assert.equal(view.settled,1);
  assert.equal(view.panel.style.transform,'');
  view.api.dispose();
});
