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

function bootstrap(labelCount, labelText) {
  const handlers = new Map(), messages = [];
  const labels = Array.from({length: labelCount}, (_, id) => ({id: String(id), label: labelText, coordinate: [132, 43.1], visible: false, reason: 'outside-viewport'}));
  const element = {dataset: {}, querySelectorAll: () => []};
  class Engine {
    getState() {return {ready: true, residentTiles: 1};}
    getCamera() {return {center: [132, 43.1], zoom: 10};}
    getPitch() {return 0;}
    getSize() {return {width: 390, height: 260};}
    getCoverage() {return {status: {ready: true, revision: 1}, area: {}};}
    getLabelDiagnostics() {return labels;}
    inspect() {return {engine: 'tropnik-canvas', state: this.getState(), labels, tiles: {overview: []}};}
  }
  const port = {postMessage: value => messages.push(JSON.parse(value)), start() {}};
  const window = {addEventListener: (event, handler) => handlers.set(event, handler)};
  const sandbox = {exports: {}, window, document: {getElementById: () => element, documentElement: {dataset: {}}}, location: {origin: 'https://map.tropnik.invalid'}, performance, TextEncoder, setTimeout,
    require: name => name === './custom-map-entry' ? {CustomMapEngine: Engine, inRussiaCoverage: () => false}
      : name === './native-map-route' ? {NativeMapRouteLoader: class {}}
        : name === './native-map-diagnostics' ? context.exports : assert.fail(name)};
  vm.runInNewContext(compile('./custom-map-android.ts'), sandbox);
  handlers.get('message')({data: JSON.stringify({type: 'tropnik-map-port', version: 1, generation: 7, debug: true}), ports: [port]});
  port.onmessage({data: JSON.stringify({type: 'snapshot', version: 1, generation: 7, sequence: 1, payload: {requestId: 37}})});
  return messages;
}

test('native snapshot carries the matching request ID and one copy of actual labels', () => {
  const messages = bootstrap(512, 'ПРИМОРСК');
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
  const messages = bootstrap(512, 'я'.repeat(600));
  assert.equal(messages.some(message => message.type === 'snapshot'), false);
  const receipt = messages.find(message => message.payload.phase === 'snapshot-rejected');
  assert.equal(receipt.payload.reason, 'message-budget');
  assert.equal(receipt.payload.requestId, 37);
  assert.ok(receipt.payload.chars > 256 * 1024);
});
