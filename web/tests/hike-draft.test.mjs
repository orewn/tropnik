import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildTrailConnectionIndex} from '../scripts/build-trail-connections.mjs';
import {coordinateKey, planTrailSequence, resolvePlanGeometry} from '../lib/trail-connections.ts';
import {createHikeDraft, validateHikeDraft, serializeHikeDraft, safeHikeFilename, exportHikeGpx, getHikeGpxExportState} from '../lib/hike-draft.ts';

const now = '2026-11-09T12:00:00.000Z';
const line = coordinates => ({type: 'LineString', coordinates});
const a = line([[40, 45], [40.001, 45], [40.002, 45]]);
const b = line([[40.001, 45], [40.001, 45.001]]);
const c = line([[40.003, 45], [40.004, 45]]);
const geometries = {a, b, c};
const route = (id, geometry) => ({id, geometry, geometryUrl: `/data/${id}.geojson`, checkedAt: '2026-11-09', sha256: createHash('sha256').update(JSON.stringify(geometry)).digest('hex')});
const index = buildTrailConnectionIndex(Object.entries(geometries).map(([id, geometry]) => route(id, geometry)));
const pointId = (id, point) => `${id}@${index.routes[id].nodes.findIndex(node => coordinateKey([node[0], node[1]]) === coordinateKey(point))}`;
const connection = (first, second) => index.connections.find(item => [item.trailA, item.trailB].includes(first) && [item.trailA, item.trailB].includes(second));
const create = (seed = 'a') => createHikeDraft(index, seed, {id: 'draft-test', now});
const planFor = draft => planTrailSequence(index, {trailIds: draft.stages.map(stage => stage.trailId),
  connectionIds: draft.stages.slice(1).map(stage => stage.entryConnectionId), start: draft.start, finish: draft.finish,
  via: Object.fromEntries(draft.stages.map((stage, i) => [i, stage.via || []]))});
const build = draft => {const plan = planFor(draft); return {plan, resolved: resolvePlanGeometry(index, plan, geometries)};};
const connectedDraft = () => ({...create(), name: 'Через развилку', stages: [{trailId: 'a', day: 1}, {trailId: 'b', day: 2, entryConnectionId: connection('a', 'b').id}],
  start: pointId('a', [40, 45]), finish: pointId('b', [40.001, 45.001]), notes: 'Воду проверить до выхода.'});
const tracks = gpx => [...gpx.matchAll(/<trkseg>([\s\S]*?)<\/trkseg>/g)].map(match =>
  [...match[1].matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"\/>/g)].map(point => [Number(point[2]), Number(point[1])]));

test('creation works in HTTP previews without randomUUID and without Web Crypto', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    let calls = 0;
    Object.defineProperty(globalThis, 'crypto', {configurable: true, value: {getRandomValues: bytes => {
      calls++; bytes.forEach((_value, i) => {bytes[i] = i + 1;}); return bytes;
    }}});
    const fromRandomValues = createHikeDraft(index, 'a', {now});
    assert.equal(calls, 1);
    assert.match(fromRandomValues.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(validateHikeDraft(fromRandomValues, index), fromRandomValues);

    Object.defineProperty(globalThis, 'crypto', {configurable: true, value: undefined});
    const first = createHikeDraft(index, 'a', {now}), second = createHikeDraft(index, 'a', {now});
    assert.notEqual(first.id, second.id);
    assert.deepEqual(validateHikeDraft(first, index), first);
    assert.deepEqual(validateHikeDraft(second, index), second);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

test('creation and JSON round trip retain dates, day boundaries, notes and via without mutating input', () => {
  const draft = connectedDraft();
  draft.stages[0].via = [pointId('a', [40.001, 45])];
  draft.notes = 'День 1\nВстреча у развилки; день 2 — возврат.';
  const withExtra = {...draft, geometry: {coordinates: [[0, 0], [90, 90]]}};
  const validated = validateHikeDraft(withExtra, index);
  assert.deepEqual(validated, draft);
  assert.notEqual(validated.stages, draft.stages);
  assert.notEqual(validated.stages[0].via, draft.stages[0].via);
  assert.deepEqual(validateHikeDraft(JSON.parse(serializeHikeDraft(validated)), index), draft);
  assert.equal(validated.createdAt, now);
  assert.equal(validated.updatedAt, now);
  assert.deepEqual(createHikeDraft(index, undefined, {id: 'empty-draft', now: new Date(now)}).stages, []);
  assert.doesNotThrow(() => validateHikeDraft({...create(), stages: [{trailId: 'a', day: 1}, {trailId: 'b', day: 3}]}, index), 'unfinished choices may be saved without inventing a junction');
});

test('draft validation bounds stage count, day order and intermediate points', () => {
  const draft = create();
  assert.throws(() => validateHikeDraft({...draft, stages: Array.from({length: 21}, () => ({trailId: 'a', day: 1}))}, index), /20 этапов/);
  for (const day of [0, 32, 1.5, '2']) assert.throws(() => validateHikeDraft({...draft, stages: [{trailId: 'a', day}]}, index), /целым числом/);
  assert.throws(() => validateHikeDraft({...draft, stages: [{trailId: 'a', day: 2}, {trailId: 'b', day: 1}]}, index), /не уменьшаться/);
  assert.throws(() => validateHikeDraft({...draft, stages: [{trailId: 'a', day: 1, via: Array(11).fill(pointId('a', [40, 45]))}]}, index), /10 промежуточных/);
  assert.doesNotThrow(() => validateHikeDraft({...draft, stages: [{trailId: 'a', day: 31}]}, index));
});

test('all supplied route, endpoint, via and adjacent connection references are checked', () => {
  const draft = connectedDraft();
  assert.throws(() => validateHikeDraft({...draft, stages: [{trailId: 'missing', day: 1}]}, index), /тропа отсутствует/);
  for (const start of ['a@-1', 'a@1.5', 'a@999999', pointId('b', [40.001, 45])]) {
    assert.throws(() => validateHikeDraft({...draft, start}, index), /Начало похода: точка отсутствует/);
  }
  assert.throws(() => validateHikeDraft({...draft, finish: pointId('a', [40.002, 45])}, index), /Конец похода: точка отсутствует/);
  assert.throws(() => validateHikeDraft({...draft, stages: [{trailId: 'a', day: 1, via: [pointId('b', [40.001, 45])]}, draft.stages[1]]}, index), /Промежуточная точка/);
  assert.throws(() => validateHikeDraft({...draft, stages: [{...draft.stages[0], entryConnectionId: connection('a', 'b').id}, draft.stages[1]]}, index), /первого этапа/);
  for (const entryConnectionId of ['missing-join', connection('a', 'c').id]) {
    assert.throws(() => validateHikeDraft({...draft, stages: [draft.stages[0], {...draft.stages[1], entryConnectionId}]}, index), /не соединяет/);
  }
});

test('unsupported schemas and stale data fail with an explanation instead of reusing old node numbers', () => {
  const draft = create();
  assert.throws(() => validateHikeDraft({...draft, schemaVersion: 2}, index), /версия файла похода не поддерживается/);
  assert.throws(() => validateHikeDraft({...draft, sourceDigest: '0'.repeat(64)}, index), /Данные троп изменились/);
  assert.throws(() => validateHikeDraft({...draft, createdAt: '2026-02-30T12:00:00.000Z'}, index), /некорректная дата/);
  assert.throws(() => validateHikeDraft({...draft, updatedAt: '2026-11-08T12:00:00.000Z'}, index), /раньше даты создания/);
  assert.throws(() => validateHikeDraft({...draft, notes: 'bad\u0000xml'}, index), /служебные символы/);
  assert.throws(() => validateHikeDraft({...draft, name: '\ud800'}, index), /служебные символы/);
});

test('GPX escapes user text, preserves day and provenance metadata, and invents no elevation or timestamps', () => {
  const draft = connectedDraft();
  draft.name = 'A&B <перевал> "север" \'юг\'';
  draft.notes = 'Не <script> и не ]]>; "кавычки" & вода.';
  const {plan, resolved} = build(draft);
  assert.deepEqual(getHikeGpxExportState(draft, plan, resolved), {canExport: true});
  const gpx = exportHikeGpx(draft, plan, resolved);
  assert.match(gpx, /<name>A&amp;B &lt;перевал&gt; &quot;север&quot; &apos;юг&apos;<\/name>/);
  assert.match(gpx, /Не &lt;script&gt; и не \]\]&gt;; &quot;кавычки&quot; &amp; вода\./);
  assert.match(gpx, /xmlns:tropnik="urn:tropnik:hike:1"/);
  assert.ok(gpx.includes(`sourceDigest="${index.sourceDigest}"`));
  assert.match(gpx, /index="1" day="1" trailId="a"/);
  assert.match(gpx, /index="2" day="2" trailId="b"/);
  assert.doesNotMatch(gpx, /<(?:ele|time|rte|rtept)(?:\s|>)/);
  assert.doesNotMatch(gpx, /<script>/);
  assert.deepEqual(tracks(gpx), resolved.segments);
});

test('GPX keeps reversed traversal in order and writes latitude and longitude to their proper attributes', () => {
  const draft = {...create('b'), stages: [{trailId: 'b', day: 1}, {trailId: 'a', day: 1, entryConnectionId: connection('a', 'b').id}],
    start: pointId('b', [40.001, 45.001]), finish: pointId('a', [40, 45])};
  const {plan, resolved} = build(draft);
  const gpx = exportHikeGpx(draft, plan, resolved);
  assert.match(gpx, /<trkpt lat="45\.001" lon="40\.001"\/>/);
  assert.deepEqual(tracks(gpx), [[[40.001, 45.001], [40.001, 45], [40, 45]]]);
});

test('unverified transfers export distinct completed segments without a synthetic bridge', () => {
  const draft = {...create(), stages: [{trailId: 'a', day: 1}, {trailId: 'c', day: 3, entryConnectionId: connection('a', 'c').id}],
    start: pointId('a', [40, 45]), finish: pointId('c', [40.004, 45])};
  const {plan, resolved} = build(draft);
  assert.equal(plan.complete, false);
  assert.equal(plan.gaps.length, 1);
  assert.deepEqual(getHikeGpxExportState(draft, plan, resolved), {canExport: true}, 'review breaks still allow an export of the known segments');
  const gpx = exportHikeGpx(draft, plan, resolved);
  const segments = tracks(gpx);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments, resolved.segments);
  assert.deepEqual(segments[0].at(-1), [40.002, 45]);
  assert.deepEqual(segments[1][0], [40.003, 45]);
  assert.match(gpx, /Связующие линии не добавлены/);
  assert.match(gpx, /complete="false" gaps="1"/);
  assert.match(gpx, /Дни похода: 1, 3\./);
});

test('GPX blocks unfinished choices, stale results, missing stage geometry and coordinate problems', () => {
  const draft = connectedDraft(), {plan, resolved} = build(draft);
  assert.throws(() => exportHikeGpx({...draft, start: undefined}, plan, resolved), /начало и конец/);
  assert.throws(() => exportHikeGpx({...draft, sourceDigest: '0'.repeat(64)}, plan, resolved), /Данные троп изменились/);
  assert.throws(() => exportHikeGpx({...draft, start: pointId('a', [40.002, 45])}, plan, resolved), /не соответствует/);
  assert.throws(() => exportHikeGpx(draft, plan, {...resolved, issues: [{code: 'geometry_mismatch', message: 'Исходная линия изменилась.'}]}), /Геометрия не готова/);
  assert.throws(() => exportHikeGpx(draft, plan, {...resolved, features: resolved.features.slice(1)}), /Не все рассчитанные этапы/);
  assert.throws(() => exportHikeGpx(draft, plan, {...resolved, segments: []}), /Нет рассчитанных участков/);
  assert.throws(() => exportHikeGpx(draft, plan, {...resolved, segments: [[[181, 45], [40, 45]]]}), /некорректные координаты/);
  assert.throws(() => exportHikeGpx(draft, plan, {...resolved, segments: [[null, [40, 45]]]}), /некорректные координаты/);
  assert.throws(() => exportHikeGpx(draft, {...plan, issues: [{code: 'missing_geometry', message: 'Нет линии.'}]}, resolved), /GPX пока недоступен/);
  const empty = createHikeDraft(index, undefined, {id: 'empty-draft', now});
  assert.throws(() => exportHikeGpx(empty, plan, resolved), /Добавьте этапы/);
});

test('changing an intermediate point requires a fresh path before GPX can claim that point', () => {
  const draft = connectedDraft(), old = build(draft);
  const via = pointId('a', [40.002, 45]);
  const changed = {...draft, stages: [{...draft.stages[0], via: [via]}, draft.stages[1]]};
  assert.throws(() => exportHikeGpx(changed, old.plan, old.resolved), /не соответствует текущему походу/);
  const current = build(changed);
  assert.ok(current.plan.knownDistanceM > old.plan.knownDistanceM);
  const gpx = exportHikeGpx(changed, current.plan, current.resolved);
  assert.ok(gpx.includes(`<tropnik:via>${via}</tropnik:via>`));
  assert.ok(tracks(gpx)[0].some(point => point[0] === 40.002 && point[1] === 45));
  assert.doesNotThrow(() => exportHikeGpx({...draft, stages: [{...draft.stages[0], via: []}, draft.stages[1]]}, old.plan, old.resolved));
});

test('a zero-distance selection cannot be exported as a completed loop', () => {
  const draft = {...create(), start: pointId('a', [40, 45]), finish: pointId('a', [40, 45])};
  const {plan, resolved} = build(draft);
  assert.throws(() => exportHikeGpx(draft, plan, resolved), /GPX пока недоступен|Нет рассчитанных участков/);
});

test('an empty stage keeps a nonzero hike incomplete and disables GPX until that stage has a path', () => {
  const join = connection('a', 'b').id;
  const firstEmpty = {...connectedDraft(), start: pointId('a', [40.001, 45])};
  const lastEmpty = {...connectedDraft(), finish: pointId('b', [40.001, 45])};
  const middleEmpty = {...create(), start: pointId('a', [40, 45]), finish: pointId('a', [40.002, 45]),
    stages: [{trailId: 'a', day: 1}, {trailId: 'b', day: 1, entryConnectionId: join}, {trailId: 'a', day: 2, entryConnectionId: join}]};
  for (const [draft, emptyAt, turn] of [
    [firstEmpty, 0, pointId('a', [40, 45])],
    [middleEmpty, 1, pointId('b', [40.001, 45.001])],
    [lastEmpty, 1, pointId('b', [40.001, 45.001])],
  ]) {
    const {plan, resolved} = build(draft);
    assert.ok(plan.knownDistanceM > 0, 'other stages still have a real distance');
    assert.equal(plan.complete, false, 'a visible nonzero line must not hide an empty stage');
    assert.equal(plan.geometryContinuous, false);
    const state = getHikeGpxExportState(draft, plan, resolved);
    assert.equal(state.canExport, false);
    assert.match(state.reason, /Вход и выход совпадают/);
    assert.throws(() => exportHikeGpx(draft, plan, resolved), error => error.message === state.reason);

    const repaired = {...draft, stages: draft.stages.map((stage, i) => i === emptyAt ? {...stage, via: [turn]} : stage)};
    const current = build(repaired);
    assert.equal(current.plan.complete, true);
    assert.equal(current.plan.geometryContinuous, true);
    assert.deepEqual(getHikeGpxExportState(repaired, current.plan, current.resolved), {canExport: true});
    assert.doesNotThrow(() => exportHikeGpx(repaired, current.plan, current.resolved));
  }
});

test('download eligibility reports the exporter reason for invalid drafts, stale paths and incomplete geometry', () => {
  const draft = connectedDraft(), {plan, resolved} = build(draft);
  for (const [value, geometry, expected] of [
    [{...draft, name: ' '}, resolved, /Название похода/],
    [{...draft, sourceDigest: '0'.repeat(64)}, resolved, /Данные троп изменились/],
    [{...draft, stages: [{...draft.stages[0], via: [pointId('a', [40.002, 45])]}, draft.stages[1]]}, resolved, /не соответствует/],
    [draft, {...resolved, features: resolved.features.slice(1)}, /Не все рассчитанные этапы/],
    [draft, {...resolved, segments: [[[181, 45], [40, 45]]]}, /некорректные координаты/],
  ]) {
    const state = getHikeGpxExportState(value, plan, geometry);
    assert.equal(state.canExport, false);
    assert.match(state.reason, expected);
    assert.throws(() => exportHikeGpx(value, plan, geometry), error => error.message === state.reason);
  }
});

test('GPX decimal coordinates remain valid for values normally printed in scientific notation', () => {
  const tiny = line([[0.0000001, 0.0000002], [0.0000003, 0.0000004]]);
  const tinyIndex = buildTrailConnectionIndex([route('tiny', tiny)]);
  const draft = {...createHikeDraft(tinyIndex, 'tiny', {id: 'tiny-draft', now}), start: 'tiny@0', finish: 'tiny@1'};
  const plan = planTrailSequence(tinyIndex, {trailIds: ['tiny'], connectionIds: [], start: draft.start, finish: draft.finish});
  const resolved = resolvePlanGeometry(tinyIndex, plan, {tiny});
  const gpx = exportHikeGpx(draft, plan, resolved);
  assert.match(gpx, /lat="0\.0000002" lon="0\.0000001"/);
  assert.doesNotMatch(gpx, /(?:lat|lon)="[^"]*[eE][+-]?\d+/);
  assert.deepEqual(tracks(gpx), [tiny.coordinates]);
});

test('download filenames retain readable Cyrillic and remove paths, controls and reserved device names', () => {
  assert.equal(safeHikeFilename('../Поход: озёра / перевал?.gpx', 'gpx'), 'Поход-озёра-перевал.gpx');
  assert.equal(safeHikeFilename('CON', 'json'), 'поход-CON.json');
  assert.equal(safeHikeFilename(' ... ', 'gpx'), 'поход.gpx');
  assert.equal(safeHikeFilename('План похода'), 'План-похода');
  assert.ok([...safeHikeFilename('я'.repeat(150))].length <= 80);
  assert.throws(() => safeHikeFilename('поход', '../bad'), /Неподдерживаемое расширение/);
});
