import assert from 'node:assert/strict';

const TERRITORY = 'territory-28173009B65133456612022';

/** Inspect real painted hit targets. Never move a marker or substitute canvas
 * pixels when a DOM marker/label is missing or covered by another control. */
export function mapWheelTarget(doc = document, win = window) {
  const surface = doc.querySelector('.atlas-canvas[data-map-engine]');
  if (!surface) return null;
  const map = surface.getBoundingClientRect();
  for (const selector of ['.region-marker-label', '.tropnik-point-marker:not([hidden])', '.region-marker:not([hidden])']) {
    for (const node of surface.querySelectorAll(selector)) {
      const marker = node.closest('[data-map-marker-id]'), style = win.getComputedStyle(node), r = node.getBoundingClientRect();
      if (!marker || marker.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || r.width < 2 || r.height < 2) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < Math.max(0, map.left) + 8 || x >= Math.min(win.innerWidth, map.right) - 8 || y < Math.max(0, map.top) + 8 || y >= Math.min(win.innerHeight, map.bottom) - 8) continue;
      const hit = doc.elementFromPoint(x, y);
      if (hit?.closest('[data-map-marker-id]') !== marker) continue;
      return {x, y, markerId: marker.dataset.mapMarkerId, kind: selector.includes('label') ? 'label' : 'marker', label: marker.getAttribute('aria-label'), hit: hit.tagName + '[' + (hit.getAttribute('class') || '') + ']'};
    }
  }
  return null;
}

/** Passive observation after the map's bubble handler, including native page
 * scroll events. This recorder cannot cancel input or restore a scroll offset. */
export function installMapWheelRecorder(doc = document, win = window) {
  const surface = doc.querySelector('.atlas-canvas[data-map-engine]');
  const sample = () => {
    const r = surface.getBoundingClientRect();
    return {scrollY: win.scrollY, rect: {left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height}};
  };
  const events = [], samples = [sample()];
  const observeScroll = () => {samples.push(sample()); if (samples.length > 64) samples.shift();};
  const observeWheel = event => {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    events.push({time: win.performance.now(), trusted: event.isTrusted, cancelable: event.cancelable, defaultPrevented: event.defaultPrevented,
      deltaY: event.deltaY, deltaMode: event.deltaMode, inMap: surface.contains(target), markerId: target?.closest('[data-map-marker-id]')?.dataset.mapMarkerId || null,
      target: target?.tagName + '[' + (target?.getAttribute('class') || '') + ']', ...sample()});
  };
  doc.addEventListener('wheel', observeWheel, {passive: true});
  win.addEventListener('scroll', observeScroll, {passive: true});
  win.__tropnikMapWheel = {events, samples, sample, stop() {doc.removeEventListener('wheel', observeWheel); win.removeEventListener('scroll', observeScroll);}};
}

export function assertMapWheelLayout(baseline, current, label) {
  assert.ok(Math.abs(current.scrollY - baseline.scrollY) <= 1, `${label}: map wheel scrolled the document`);
  for (const edge of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
    assert.ok(Math.abs(current.rect[edge] - baseline.rect[edge]) <= 1, `${label}: map wheel changed the viewport ${edge}`);
  }
}

export function assertNativeMapWheelBurst(burst, baseline, minimumZoom) {
  const label = `Native map wheel (${burst.direction > 0 ? 'out' : 'in'})`;
  assert.ok(typeof burst.point.markerId === 'string' && burst.point.markerId.trim(), `${label}: missing DOM marker identity`);
  assert.ok(['label', 'marker'].includes(burst.point.kind), `${label}: invalid marker hit surface`);
  assert.ok(burst.events.length > 0, `${label}: no native wheel reached the page`);
  assert.equal(burst.events[0].markerId, burst.point.markerId, `${label}: the first wheel missed the observed DOM marker/label`);
  for (const [index, event] of burst.events.entries()) {
    assert.equal(event.trusted, true, `${label}: synthetic wheel is not browser evidence`);
    assert.equal(event.cancelable, true, `${label}: wheel could not be owned by the map`);
    assert.equal(event.defaultPrevented, true, `${label}: wheel escaped the map`);
    assert.equal(event.inMap, true, `${label}: wheel reached an unrelated control`);
    assert.equal(event.deltaMode, 0, `${label}: expected pixel-mode native input`);
    assert.ok(Number.isFinite(event.time) && (!index || event.time >= burst.events[index - 1].time), `${label}: invalid native event order`);
    assert.ok(event.deltaY * burst.direction > 0, `${label}: wheel changed direction inside the burst`);
    assertMapWheelLayout(baseline, event, label);
  }
  const delta = burst.events.reduce((sum, event) => sum + event.deltaY, 0);
  const span = burst.events.at(-1).time - burst.events[0].time;
  assert.ok(Number.isFinite(burst.eventSpanMs) && Math.abs(burst.eventSpanMs - span) < .001 && span < 200, `${label}: native wheel was not delivered as one rapid burst`);
  assert.equal(delta, burst.direction * 480, `${label}: the complete wheel burst was not delivered`);
  const expected = Math.max(minimumZoom, burst.before.camera.zoom - burst.direction);
  assert.ok(Math.abs(burst.after.camera.zoom - expected) < .01, `${label}: expected zoom ${expected}, received ${burst.after.camera.zoom}`);
  assertMapWheelLayout(baseline, burst.layout, label);
}

/** Publication must carry the native evidence, not only a passed flag. */
export function assertMapWheelAudit(report) {
  assert.equal(report?.schemaVersion, 1, 'Missing native map wheel ownership evidence');
  assert.equal(report.passed, true);assert.equal(report.input, 'mouse-wheel');
  assert.equal(report.regionId, TERRITORY);assert.ok(Number.isFinite(report.minimumZoom));
  for (const selection of [report.selection, report.selectionAfter]) {
    assert.equal(selection?.region, TERRITORY);assert.equal(selection.route, '');assert.equal(selection.title, 'Красноярский край');
  }
  assert.ok(report.bursts?.length >= 3 && report.bursts.length <= 11, 'Missing zoom and floor wheel bursts');
  let previous = report.initial.camera.zoom;
  for (const [index, burst] of report.bursts.entries()) {
    assert.equal(burst.direction, index === 0 ? -1 : 1);
    assert.equal(burst.dispatchMode, 'ordered-native');
    assert.ok(Number.isFinite(burst.producerDurationMs) && burst.producerDurationMs >= 0 && burst.producerDurationMs < 200);
    assert.ok(Number.isFinite(burst.eventSpanMs) && burst.eventSpanMs >= 0);
    assert.ok(Math.abs(burst.before.camera.zoom - previous) < .01, 'Wheel burst cameras are discontinuous');
    assert.equal(burst.commands?.length, 4);
    for (const [commandIndex, command] of burst.commands.entries()) {
      assert.equal(command.index, commandIndex);
      assert.equal(command.method, 'Input.dispatchMouseEvent');assert.equal(command.type, 'mouseWheel');
      assert.equal(command.status, 'fulfilled');assert.equal(command.deltaY, burst.direction * 120);
      assert.ok(Number.isFinite(command.sentOffsetMs) && command.sentOffsetMs >= 0 && command.sentOffsetMs <= burst.producerDurationMs);
      assert.ok(Number.isFinite(command.ackOffsetMs) && command.ackOffsetMs >= command.sentOffsetMs);
      if (commandIndex) assert.ok(command.sentOffsetMs >= burst.commands[commandIndex - 1].sentOffsetMs);
    }
    assertNativeMapWheelBurst(burst, report.baseline, report.minimumZoom);
    previous = burst.after.camera.zoom;
  }
  const last = report.bursts.at(-1);
  assert.ok(report.bursts.some(burst => burst.point.kind === 'label' && /\bregion-marker-label\b/.test(burst.events[0].target)), 'Missing real native direction-label wheel coverage');
  assert.ok(Math.abs(last.before.camera.zoom - report.minimumZoom) < .01 && Math.abs(last.after.camera.zoom - report.minimumZoom) < .01, 'Missing wheel ownership at the zoom floor');
  assert.ok(report.samples?.length > 0);
  for (const sample of report.samples) assertMapWheelLayout(report.baseline, sample, 'Native map wheel scroll observation');
  const sidebar = report.sidebar;
  assert.equal(sidebar?.input, 'mouse');assert.equal(sidebar.selector, '.explore-panel-content');
  assert.ok(sidebar.events?.some(event => event.type === 'wheel' && event.trusted), 'Missing native sidebar wheel');
  assert.ok(sidebar.after.scrollTop - sidebar.before.scrollTop > 1, 'The sidebar must retain native scrolling');
  assert.ok(Math.abs(sidebar.after.scrollY - sidebar.before.scrollY) <= 1, 'The sidebar scrolled the document');
  assertMapWheelLayout(report.baseline, report.finalLayout, 'Native sidebar scroll');
}

/** Runs in the existing mandatory desktop profile, with its existing CDP
 * connection, timeouts and real catalogue. Every burst starts over a DOM marker
 * and keeps one pointer coordinate while the map moves underneath it. */
export async function runMapWheelAudit(cdp, profile, helpers, minimumZoom) {
  assert.equal(profile.mobile, false, 'Map wheel ownership requires the existing desktop profile');
  assert.ok(Number.isFinite(minimumZoom), 'Map wheel audit needs the measured country zoom floor');
  const {loadProfile, evaluate, waitValue, settledMap, clearMapStories, expectSelection, scrollContainer, url} = helpers;
  await loadProfile(cdp, `${url}?region=${TERRITORY}`, profile);
  await clearMapStories(cdp, profile);
  const selection = await expectSelection(cdp, {region: TERRITORY, route: '', title: 'Красноярский край'});
  const initial = await settledMap(cdp, profile.engine), bursts = [];
  const report = {schemaVersion: 1, passed: false, regionId: TERRITORY, input: 'mouse-wheel', minimumZoom, initial, selection, bursts};
  await evaluate(cdp, `(${installMapWheelRecorder.toString()})()`);
  const baseline = await evaluate(cdp, 'window.__tropnikMapWheel.sample()');
  report.baseline = baseline;
  try {
    const burst = async direction => {
      const before = await settledMap(cdp, profile.engine);
      const point = await waitValue('No visible DOM map marker/label for native wheel', () => evaluate(cdp, `(${mapWheelTarget.toString()})()`), Boolean, 4000);
      await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse'});
      const offset = await evaluate(cdp, 'window.__tropnikMapWheel.events.length');
      const commands = [], pending = [], started = performance.now();
      // Queue the ordered native inputs before waiting for any browser ACK.
      // Renderer work cannot stretch the producer into four separate gestures.
      for (let index = 0; index < 4; index++) {
        const command = {index, method: 'Input.dispatchMouseEvent', type: 'mouseWheel', deltaY: direction * 120, status: 'pending', sentOffsetMs: performance.now() - started};
        commands.push(command);
        pending.push(cdp.call(command.method, {type: command.type, x: point.x, y: point.y, deltaX: 0, deltaY: command.deltaY, pointerType: 'mouse'}).then(() => {
          command.status = 'fulfilled';command.ackOffsetMs = performance.now() - started;
        }, error => {command.status = 'rejected';throw error;}));
      }
      const producerDurationMs = performance.now() - started;
      const dispatched = await Promise.allSettled(pending), failed = dispatched.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const events = await waitValue('Native map wheel burst was not delivered', () => evaluate(cdp, `window.__tropnikMapWheel.events.slice(${offset})`), value => Math.abs(value.reduce((sum, event) => sum + event.deltaY, 0)) >= 480, 4000);
      const after = await settledMap(cdp, profile.engine), layout = await evaluate(cdp, 'window.__tropnikMapWheel.sample()');
      const receipt = {direction, point, dispatchMode: 'ordered-native', producerDurationMs, eventSpanMs: events.at(-1).time - events[0].time, commands, events, before, after, layout};
      bursts.push(receipt);assertNativeMapWheelBurst(receipt, baseline, minimumZoom);
      return receipt;
    };
    // Ensure a real zoom range even if the selected territory already fits at
    // the country floor; the marker under the pointer owns this input too.
    await burst(-1);
    let heldAtFloor = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const step = await burst(1);
      if (Math.abs(step.before.camera.zoom - minimumZoom) < .01 && Math.abs(step.after.camera.zoom - minimumZoom) < .01) {heldAtFloor = true; break;}
    }
    assert.ok(heldAtFloor, 'Native map wheel did not reach and hold the measured country floor within 10 bursts');
    report.samples = await evaluate(cdp, 'window.__tropnikMapWheel.samples');
    for (const sample of report.samples) assertMapWheelLayout(baseline, sample, 'Native map wheel scroll observation');
    report.selectionAfter = await expectSelection(cdp, {region: TERRITORY, route: '', title: 'Красноярский край'});
  } catch (error) {
    report.observed = await evaluate(cdp, '({events:window.__tropnikMapWheel.events,samples:window.__tropnikMapWheel.samples,current:window.__tropnikMapWheel.sample()})').catch(() => null);
    error.mapWheelOwnership = report;throw error;
  } finally {
    await evaluate(cdp, 'window.__tropnikMapWheel.stop()');
  }
  try {
    // The catalogue remains a separate native scroller outside the map owner.
    report.sidebar = await scrollContainer(cdp, '.explore-panel-content', profile);
    assert.ok(report.sidebar.events.some(event => event.type === 'wheel' && event.trusted), 'The sidebar check requires a trusted native wheel');
    report.finalLayout = await evaluate(cdp, 'window.__tropnikMapWheel.sample()');
    assertMapWheelLayout(baseline, report.finalLayout, 'Native sidebar scroll');
    report.passed = true;
    assertMapWheelAudit(report);
    return report;
  } catch (error) {
    report.passed = false;error.mapWheelOwnership = report;throw error;
  }
}
