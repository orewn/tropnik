import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeOverlayLine, prepareTrailOverlay, prepareTrailOverlayAsync, TrailOverlayLoader} from '../lib/map-trail-overlay.ts';

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).buffer;
const hash = value => createHash('sha256').update(new Uint8Array(value)).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(condition(), 'Expected asynchronous state did not settle');
}
function catalogue({parts = 1, points = 2} = {}) {
  const line = Array.from({length: points}, (_, index) => [(4_000_000 + index) / 100000, 50]);
  const encoded = encodeOverlayLine(line), bounds = [40, 50, line.at(-1)[0], 50];
  return {version: 1, sourceDigest: 'a'.repeat(64), catalogueRoutes: 1, geometryRoutes: 1, sources: [{
    key: 'imported/example.geojson', ids: ['example'], sha256: 'b'.repeat(64), bounds, points: points * parts,
    parts: Array.from({length: parts}, () => [[...bounds], encoded, encoded]),
  }]};
}

test('budgeted preparation matches build validation and retains only encoded offscreen coordinates', async () => {
  const input = catalogue({parts: 12, points: 769});
  let clock = 0, yields = 0;
  const prepared = await prepareTrailOverlayAsync(input, {
    budgetMs: 5, now: () => clock++, yieldControl: async () => {yields++;},
  });
  assert.deepEqual(prepared, prepareTrailOverlay(input));
  assert.ok(yields > 12, 'Validation must yield within long parts as well as between parts');
  assert.ok(prepared.every(source => source.prepared.parts.every(part => part.lines.length === 0)));
  await assert.rejects(prepareTrailOverlayAsync(input, {budgetMs: 0}), /budget/);
});

test('cancellation interrupts validation inside one long source part before any result is published', async () => {
  const controller = new AbortController();
  let clock = 0, yields = 0;
  await assert.rejects(prepareTrailOverlayAsync(catalogue({points: 10000}), {
    signal: controller.signal, budgetMs: 1, now: () => clock++,
    yieldControl: async () => {yields++; controller.abort();},
  }), {name: 'AbortError'});
  assert.equal(yields, 1);
  await assert.rejects(prepareTrailOverlayAsync(catalogue(), {signal: controller.signal}), {name: 'AbortError'});
});

test('malformed coordinates after yielded validation still reject the whole catalogue', async () => {
  const input = catalogue({points: 1000});
  input.sources[0].parts[0][2] += '_';
  let clock = 0, yields = 0;
  await assert.rejects(prepareTrailOverlayAsync(input, {
    budgetMs: 1, now: () => clock++, yieldControl: async () => {yields++;},
  }), /Truncated/);
  assert.ok(yields > 0);
  assert.throws(() => prepareTrailOverlay(input), /Truncated/);
});

test('overview integrity mismatch invalidates bytes and retry publishes only the matching catalogue', async t => {
  const original = catalogue(), accepted = bytes(original), changed = structuredClone(original);
  changed.sources[0].ids = ['substituted'];
  let response = bytes(changed), loads = 0;
  const errors = [], changes = [], invalidated = [];
  const loader = new TrailOverlayLoader({
    url: '/data/trail-overlay-test.json', sha256: hash(accepted),
    load: async () => {loads++; return response;},
    invalidate: url => invalidated.push(url), onError: message => errors.push(message),
    onChange: entries => changes.push(entries),
  });
  t.after(() => loader.destroy());
  loader.update({ids: ['example', 'substituted'], bounds: [39, 49, 41, 51], zoom: 8});
  await until(() => errors.some(Boolean));
  await turn();
  assert.equal(loader.inspect().sources, 0);
  assert.deepEqual(changes, []);
  assert.deepEqual(invalidated, ['/data/trail-overlay-test.json']);
  response = accepted;
  loader.retry();
  await until(() => changes.length > 0);
  assert.equal(loads, 2);
  assert.deepEqual(changes.at(-1).map(entry => entry.ids), [['example']]);
  assert.equal(errors.at(-1), '');
});

test('destroyed overview download cannot start validation or publish an integrity error', async () => {
  let release;
  const accepted = bytes(catalogue()), changes = [], errors = [], invalidated = [];
  const loader = new TrailOverlayLoader({
    url: '/data/trail-overlay-test.json', sha256: hash(accepted),
    load: () => new Promise(resolve => {release = resolve;}),
    onChange: entries => changes.push(entries), onError: message => errors.push(message),
    invalidate: url => invalidated.push(url),
  });
  loader.update({ids: ['example'], bounds: [39, 49, 41, 51], zoom: 8});
  loader.destroy(); release(accepted);
  await turn(); await turn();
  assert.equal(loader.inspect().sources, 0);
  assert.deepEqual(changes, []); assert.deepEqual(errors, []); assert.deepEqual(invalidated, []);
});
