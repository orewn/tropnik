import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMapWheelLayout, assertNativeMapWheelBurst, mapWheelTarget} from '../browser-map-wheel.mjs';

const baseline = {scrollY: 0, rect: {left: 384, top: 72, right: 1440, bottom: 1000, width: 1056, height: 928}};
function receipt({before = 4.4, after = 3.4, direction = 1} = {}) {
  return {direction, eventSpanMs: 30, point: {markerId: 'krasnoyarsk', kind: 'label'}, before: {camera: {zoom: before}}, after: {camera: {zoom: after}}, layout: structuredClone(baseline),
    events: Array.from({length: 4}, (_, index) => ({...structuredClone(baseline), time: 100 + index * 10, trusted: true, cancelable: true, defaultPrevented: true, inMap: true, markerId: index ? null : 'krasnoyarsk', deltaY: direction * 120, deltaMode: 0}))};
}

test('native marker-to-canvas wheel bursts move zoom and keep the page and viewport still through the floor', () => {
  assertNativeMapWheelBurst(receipt(), baseline, 2.5);
  assertNativeMapWheelBurst(receipt({before: 4.4, after: 5.4, direction: -1}), baseline, 2.5);
  assertNativeMapWheelBurst(receipt({before: 3.1, after: 2.5}), baseline, 2.5);
  assertNativeMapWheelBurst(receipt({before: 2.5, after: 2.5}), baseline, 2.5);
  const coalesced = receipt();coalesced.events = [{...coalesced.events[0], deltaY: 480}];coalesced.eventSpanMs = 0;
  assertNativeMapWheelBurst(coalesced, baseline, 2.5);
});

test('the pre-fix native label leak fails even if the document was already at its scroll boundary', () => {
  const missed = receipt({after: 4.4});missed.events[0].defaultPrevented = false;
  assert.throws(() => assertNativeMapWheelBurst(missed, baseline, 2.5), /wheel escaped the map/);
  const drifted = receipt();drifted.events[1].scrollY = 468;drifted.events[1].rect.top = -396;
  assert.throws(() => assertNativeMapWheelBurst(drifted, baseline, 2.5), /scrolled the document/);
});

test('synthetic input, a missed marker, lost delivery and duplicated zoom cannot pass as native ownership', () => {
  const synthetic = receipt();synthetic.events[0].trusted = false;
  assert.throws(() => assertNativeMapWheelBurst(synthetic, baseline, 2.5), /synthetic wheel/);
  const canvasOnly = receipt();canvasOnly.events[0].markerId = null;
  assert.throws(() => assertNativeMapWheelBurst(canvasOnly, baseline, 2.5), /missed the observed DOM marker/);
  const short = receipt();short.events.pop();short.eventSpanMs = 20;
  assert.throws(() => assertNativeMapWheelBurst(short, baseline, 2.5), /complete wheel burst/);
  assert.throws(() => assertNativeMapWheelBurst(receipt({after: 2.5}), baseline, 2.5), /expected zoom/);
  const resized = structuredClone(baseline);resized.rect.height -= 48;
  assert.throws(() => assertMapWheelLayout(baseline, resized, 'wheel'), /viewport height/);
  const noMarker = receipt();noMarker.point.markerId = null;noMarker.events[0].markerId = null;
  assert.throws(() => assertNativeMapWheelBurst(noMarker, baseline, 2.5), /missing DOM marker identity/);
  const slow = receipt();slow.events.forEach((event, index) => {event.time = 100 + index * 10000;});slow.eventSpanMs = 30000;
  assert.throws(() => assertNativeMapWheelBurst(slow, baseline, 2.5), /rapid burst/);
  const forgedSpan = receipt();forgedSpan.eventSpanMs = 1;
  assert.throws(() => assertNativeMapWheelBurst(forgedSpan, baseline, 2.5), /rapid burst/);
});

test('the DOM picker uses an actual unobscured label and never substitutes bare canvas or a hidden marker', () => {
  const marker = {hidden: false, dataset: {mapMarkerId: 'krasnoyarsk'}, getAttribute: () => 'Открыть Красноярский край'};
  const label = {nodeType: 1, tagName: 'SPAN', getAttribute: () => 'region-marker-label', closest: () => marker,
    getBoundingClientRect: () => ({left: 800, top: 620, width: 200, height: 44}), style: {display: 'block', visibility: 'visible', opacity: '1'}};
  const surface = {getBoundingClientRect: () => baseline.rect, querySelectorAll: selector => selector === '.region-marker-label' ? [label] : []};
  let hit = label;
  const doc = {querySelector: () => surface, elementFromPoint: () => hit};
  const win = {innerWidth: 1440, innerHeight: 1000, getComputedStyle: node => node.style};
  assert.deepEqual(mapWheelTarget(doc, win), {x: 900, y: 642, markerId: 'krasnoyarsk', kind: 'label', label: 'Открыть Красноярский край', hit: 'SPAN[region-marker-label]'});
  hit = {closest: () => null};assert.equal(mapWheelTarget(doc, win), null, 'Another control covering the label cannot receive the test wheel');
  hit = label;marker.hidden = true;assert.equal(mapWheelTarget(doc, win), null);
  marker.hidden = false;label.style.visibility = 'hidden';assert.equal(mapWheelTarget(doc, win), null);
});
