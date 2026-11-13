import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from '../../web/node_modules/typescript/lib/typescript.js';

const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const context = {exports: {}, DOMException, TextEncoder, setTimeout};
vm.runInNewContext(compile('./native-map-diagnostics.ts'), context);
const {prepareOutsideLabelEvidence, encodeDiagnosticMessage} = context.exports;

test('outside-label evidence classifies every retained point and yields bounded batches', async () => {
  let calls = 0, lastYield = 0, yields = 0;
  const covered = point => {calls++;return Math.floor(point[0]) % 3 === 0;};
  const evidence = await prepareOutsideLabelEvidence({left: 0, top: 0, right: 100, bottom: 60}, 1,
    ({x, y}) => [x, y], covered, () => true, async () => {assert.ok(calls - lastYield <= 64);lastYield = calls;yields++;});
  assert.equal(evidence.probes.length, 2048);
  assert.equal(evidence.limited, true);
  assert.equal(evidence.examined, calls);
  assert.ok(yields > 0);
  for (const [x, y] of evidence.probes) {assert.ok(x > 3 && y > 0);assert.notEqual(Math.floor(x) % 3, 0);}
});

test('a changed camera aborts partial fixture evidence without returning stale pixels', async () => {
  let current = true, calls = 0;
  await assert.rejects(prepareOutsideLabelEvidence({left: 0, top: 0, right: 100, bottom: 100}, 0,
    point => [point.x, point.y], () => {calls++;return false;}, () => current, async () => {current = false;}), {name: 'AbortError'});
  assert.equal(calls, 64);
});

test('transport receipt counts actual UTF-16 characters and UTF-8 bytes and fails closed at the existing cap', () => {
  const message = {version: 1, generation: 7, type: 'snapshot', payload: {label: 'ПРИМОРСК 🗺', requestId: 1}};
  const result = encodeDiagnosticMessage(message);
  const parsed = JSON.parse(result.encoded);
  assert.equal(parsed.payload.transport.chars, result.encoded.length);
  assert.equal(parsed.payload.transport.utf8Bytes, new TextEncoder().encode(result.encoded).byteLength);
  const oversized = encodeDiagnosticMessage({version: 1, generation: 7, type: 'snapshot', payload: {value: 'я'.repeat(256 * 1024)}});
  assert.equal(oversized.encoded, undefined);
  assert.ok(oversized.chars > 256 * 1024);
});

function bootstrap(labelCount, labelText, markers = [], {debug = true, hit = null} = {}) {
  const handlers = new Map(), inputHandlers = new Map(), messages = [];
  let createdEngine;
  const labels = Array.from({length: labelCount}, (_, id) => ({id: String(id), label: labelText, coordinate: [132, 43.1], visible: false, reason: 'outside-viewport'}));
  const element = {dataset: {}, clientWidth: 390, clientHeight: 260, querySelectorAll: () => markers, getBoundingClientRect: () => ({x: 0, y: 0, width: 390, height: 260}),
    addEventListener: (type, handler, options) => {assert.equal(options.capture, true);assert.equal(options.passive, true);inputHandlers.set(type, handler);}};
  class Engine {
    constructor(element, options) {this.options = options;this.camera = {center: [132, 43.1], zoom: 10};this.pitch = 0;this.size = {width: 390, height: 260};createdEngine = this;}
    getState() {return {ready: true, residentTiles: 1};}
    getCamera() {return {...this.camera, center: [...this.camera.center]};}
    getPitch() {return this.pitch;}
    getSize() {return {...this.size};}
    getCoverage() {return {status: {ready: true, revision: 1}, area: {}};}
    // This harness supplies no route geometry. The new diagnostic must still
    // query the actual completed viewport centre with the production radius.
    // Real source admission and hit selection have separate data/device gates.
    pickTrail(point, radius) {assert.equal(point.x, this.size.width / 2);assert.equal(point.y, this.size.height / 2);assert.equal(radius, 8);return undefined;}
    getLabelDiagnostics() {return labels;}
    inspect() {return {engine: 'tropnik-canvas', state: this.getState(), labels, tiles: {overview: []}};}
  }
  const port = {postMessage: value => messages.push(JSON.parse(value)), start() {}};
  const window = {addEventListener: (event, handler) => handlers.set(event, handler)};
  const sandbox = vm.createContext({exports: {}, window, document: {getElementById: () => element, elementFromPoint: () => hit, documentElement: {dataset: {}}}, location: {origin: 'https://map.tropnik.invalid'},
    performance, TextEncoder, TextDecoder, URL, AbortController, DOMException, Uint8Array, crypto, setTimeout, clearTimeout,
    fetch: () => assert.fail('A diagnostics-only bootstrap must not request catalogue or network bytes'), getComputedStyle: () => ({display: 'block'})});
  const modules = new Map();
  function load(url) {
    if (modules.has(url.href)) return modules.get(url.href).exports;
    assert.ok(url.href.startsWith(new URL('../../', import.meta.url).href), 'A runtime import escaped the checkout');
    const module = {exports: {}};modules.set(url.href, module);
    const evaluate = vm.runInContext(`(function(require,module,exports){${compile(url)}\n})`, sandbox, {filename: url.pathname});
    evaluate(name => {
      assert.ok(name.startsWith('.'), 'Unexpected external runtime dependency: ' + name);
      if (url.href === new URL('./custom-map-android.ts', import.meta.url).href && name === './custom-map-entry') return {CustomMapEngine: Engine, inRussiaCoverage: () => false};
      return load(new URL(name.endsWith('.ts') ? name : name + '.ts', url));
    }, module, module.exports);
    return module.exports;
  }
  // Catalogue, route cancellation, mode selection, overlay and diagnostics all
  // use their real imports. Only the visible renderer/DOM are controlled here.
  load(new URL('./custom-map-android.ts', import.meta.url));
  handlers.get('message')({data: JSON.stringify({type: 'tropnik-map-port', version: 1, generation: 7, debug}), ports: [port]});
  let sequence = 0;
  const snapshot = () => port.onmessage({data: JSON.stringify({type: 'snapshot', version: 1, generation: 7, sequence: ++sequence, payload: {requestId: 36 + sequence}})});
  if (debug) snapshot();
  return {messages, inputHandlers, snapshot, engine: createdEngine, element};
}

test('native snapshot carries the matching request ID and one copy of actual labels', () => {
  const {messages} = bootstrap(512, 'ПРИМОРСК');
  const receipt = messages.find(message => message.type === 'debugReceipt');
  assert.equal(receipt.payload.phase, 'snapshot-start');
  assert.equal(receipt.payload.requestId, 37);
  const snapshot = messages.find(message => message.type === 'snapshot');
  assert.equal(snapshot.payload.requestId, 37);
  assert.equal(snapshot.payload.labels.length, 512);
  assert.equal('labels' in snapshot.payload.rendered, false);
  assert.ok(snapshot.payload.transport.chars < 256 * 1024);
});

test('an oversized snapshot reports its exact rejection instead of silently losing the request', () => {
  const {messages} = bootstrap(512, 'я'.repeat(600));
  assert.equal(messages.some(message => message.type === 'snapshot'), false);
  const receipt = messages.find(message => message.payload.phase === 'snapshot-rejected');
  assert.equal(receipt.payload.reason, 'message-budget');
  assert.equal(receipt.payload.requestId, 37);
  assert.ok(receipt.payload.chars > 256 * 1024);
});

test('native diagnostics retain the real visible cluster and hidden member separately', () => {
  const marker = (id, hidden, groupKey) => ({dataset: {mapMarkerId: id, mapGroupKey: groupKey}, hidden,
    getBoundingClientRect: () => ({x: 100, y: 80, width: 44, height: 44})});
  const key = 'adygea|kabardino-balkaria|karachay-cherkessia|krasnodar';
  const {messages} = bootstrap(0, '', [marker('karachay-cherkessia', false, key), marker('krasnodar', true, undefined)]);
  const markers = messages.find(message => message.type === 'snapshot').payload.markers;
  assert.equal(markers[0].groupKey, key);
  assert.equal(markers[0].hidden, false);
  assert.equal(markers[1].hidden, true);
  assert.equal(markers[1].groupKey, 'krasnodar');
});

test('the marker hit receipt reports the actual topmost DOM target without assuming visibility means clickability', () => {
  const marker = {dataset: {mapMarkerId: 'group', mapGroupKey: 'one|two'}, hidden: false,
    getBoundingClientRect: () => ({x: 100, y: 80, width: 44, height: 44})};
  const canvas = {tagName: 'CANVAS', closest: () => null};
  const covered = bootstrap(0, '', [marker], {hit: canvas}).messages.find(message => message.type === 'snapshot').payload.markers[0];
  assert.equal(covered.hidden, false);
  assert.equal(covered.hitAtMarker.tag, 'canvas');
  assert.equal(covered.hitAtMarker.markerId, '');
  const child = {tagName: 'SPAN', closest: selector => {assert.equal(selector, '[data-map-marker-id]');return marker;}};
  const exposed = bootstrap(0, '', [marker], {hit: child}).messages.find(message => message.type === 'snapshot').payload.markers[0];
  assert.equal(exposed.hitAtMarker.markerId, 'group');
  assert.equal(exposed.hitAtMarker.groupKey, 'one|two');
});

test('input diagnostics preserve only a bounded actual trusted stream and never install in production', () => {
  const {messages, inputHandlers, snapshot} = bootstrap(0, '');
  const marker = {dataset: {mapMarkerId: 'group', mapGroupKey: 'one|two'}};
  const target = {tagName: 'BUTTON', closest: () => marker};
  const event = {isTrusted: true, timeStamp: 10, clientX: 122, clientY: 102, pointerId: 4, pointerType: 'touch', target};
  inputHandlers.get('pointerdown')({...event, isTrusted: false});
  assert.equal(messages.some(message => message.payload.phase === 'trusted-input'), false);
  for (let index = 0; index < 21; index++) inputHandlers.get('pointerup')({...event, timeStamp: index});
  inputHandlers.get('click')({...event, timeStamp: 80});
  snapshot();
  const observed = messages.filter(message => message.type === 'snapshot').at(-1).payload.trustedInput;
  assert.equal(observed.length, 16);
  assert.equal(observed[0].sequence, 7);
  assert.equal(observed.at(-1).sequence, 22);
  assert.equal(observed.at(-1).type, 'click');
  assert.equal(observed.at(-1).timeStamp, 80);
  assert.equal(observed.at(-1).target.markerId, 'group');
  assert.equal(observed.every(receipt => receipt.trusted === true), true);
  assert.equal(bootstrap(0, '', [], {debug: false}).inputHandlers.size, 0);
});

test('desired camera changes cannot make stale marker coordinates input-ready before their actual drawn frame', () => {
  const {messages, snapshot, engine, element} = bootstrap(0, '');
  const latest = () => messages.filter(message => message.type === 'snapshot').at(-1).payload;
  assert.equal(latest().inputReady, false);
  engine.options.onFrame(engine.getCamera());snapshot();
  assert.equal(latest().inputReady, true);
  engine.camera = {center: [81.5695492, 58.2767055], zoom: 6};snapshot();
  assert.equal(latest().camera.zoom, 6);
  assert.equal(latest().painted.camera.zoom, 10);
  assert.equal(latest().inputReady, false);
  engine.options.onFrame(engine.getCamera());snapshot();
  assert.equal(latest().inputReady, true);
  assert.equal(latest().painted.camera.zoom, 6);
  // clientWidth is an integer while native-density layout bounds can be
  // fractional. Keep those real bounds for screen-coordinate conversion.
  element.getBoundingClientRect = () => ({x: 0, y: 0, width: 389.625, height: 260});snapshot();
  assert.equal(latest().inputReady, true);
  assert.equal(latest().viewportBounds.width, 389.625);
  assert.equal(latest().viewportSize.width, 390);
  engine.pitch = 40;snapshot();assert.equal(latest().inputReady, false);
  engine.options.onFrame(engine.getCamera());snapshot();assert.equal(latest().inputReady, true);
  element.getBoundingClientRect = () => ({x: 0, y: 0, width: 400, height: 260});element.clientWidth = 400;snapshot();
  assert.equal(latest().inputReady, false);
  engine.size.width = 400;snapshot();assert.equal(latest().inputReady, false);
  engine.options.onFrame(engine.getCamera());snapshot();assert.equal(latest().inputReady, true);
  element.dataset.mapMoving = 'true';snapshot();assert.equal(latest().inputReady, false);
});
