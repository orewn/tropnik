import type {CompositePlan, CompositePlanOptions, ResolvedPlanGeometry, TrailConnectionIndex} from './trail-connections';

export type HikeDraftStage = {
  trailId: string;
  day: number;
  entryConnectionId?: string;
  via?: string[];
};

export type HikeDraft = {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceDigest: string;
  stages: HikeDraftStage[];
  start?: string;
  finish?: string;
  notes: string;
};

export type CreateHikeDraftOptions = {id?: string; now?: string | Date};

const MAX_STAGES = 20;
const MAX_DAYS = 31;
const MAX_VIA = 10;
const MAX_NAME = 160;
const MAX_NOTES = 20_000;
const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
const HIKE_NAMESPACE = 'urn:tropnik:hike:1';
const STALE_MESSAGE = 'Данные троп изменились. Пересоберите поход по текущей версии: прежние точки и стыки нельзя переносить автоматически.';
let localIdSequence = 0;

function draftId(): string {
  const runtimeCrypto = globalThis.crypto;
  if (typeof runtimeCrypto?.randomUUID === 'function') {
    try {return runtimeCrypto.randomUUID();} catch { /* Local draft identity does not require a secure context. */ }
  }
  if (typeof runtimeCrypto?.getRandomValues === 'function') {
    try {
      const bytes = runtimeCrypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch { /* A locally unique identifier is sufficient when Web Crypto is unavailable. */ }
  }
  return `hike-${Date.now().toString(36)}-${(++localIdSequence).toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект JSON.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label}: ожидается обычный объект JSON.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label}: ожидается текст.`);
  if (value.length > maximum) throw new Error(`${label}: не больше ${maximum} символов.`);
  if (!allowEmpty && !value.trim()) throw new Error(`${label}: заполните значение.`);
  // JSON can contain control characters or lone surrogates which XML 1.0 cannot represent.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value) ||
      [...value].some(character => {const point = character.codePointAt(0)!; return point >= 0xD800 && point <= 0xDFFF;})) {
    throw new Error(`${label}: удалите недопустимые служебные символы.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const source = text(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(source)) {
    throw new Error(`${label}: нужна дата в формате ISO UTC.`);
  }
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== source.slice(0, 19)) {
    throw new Error(`${label}: некорректная дата.`);
  }
  return parsed.toISOString();
}

function optionalReference(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label, 240);
}

/** Shape validation also strips unknown fields: imported JSON never supplies executable route geometry. */
function readDraft(value: unknown): HikeDraft {
  const source = object(value, 'Поход');
  if (source.schemaVersion !== 1) throw new Error('Эта версия файла похода не поддерживается. Нужен schemaVersion: 1.');
  const id = text(source.id, 'Идентификатор похода', 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) throw new Error('Идентификатор похода содержит недопустимые символы.');
  const name = text(source.name, 'Название похода', MAX_NAME).trim();
  const createdAt = timestamp(source.createdAt, 'Дата создания');
  const updatedAt = timestamp(source.updatedAt, 'Дата изменения');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('Дата изменения не может быть раньше даты создания.');
  const sourceDigest = text(source.sourceDigest, 'Версия данных', 64);
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)) throw new Error('В файле отсутствует корректная версия исходных данных троп.');
  const notes = text(source.notes, 'Заметки', MAX_NOTES, true);
  if (!Array.isArray(source.stages) || source.stages.length > MAX_STAGES) throw new Error(`В походе может быть не больше ${MAX_STAGES} этапов.`);
  let previousDay = 1;
  const stages: HikeDraftStage[] = Array.from(source.stages, (value, index) => {
    const stage = object(value, `Этап ${index + 1}`);
    const trailId = text(stage.trailId, `Тропа этапа ${index + 1}`, 200);
    if (typeof stage.day !== 'number' || !Number.isInteger(stage.day) || stage.day < 1 || stage.day > MAX_DAYS) {
      throw new Error(`Этап ${index + 1}: день должен быть целым числом от 1 до ${MAX_DAYS}.`);
    }
    if (stage.day < previousDay) throw new Error('Дни этапов должны идти по порядку и не уменьшаться.');
    previousDay = stage.day;
    const entryConnectionId = optionalReference(stage.entryConnectionId, `Стык этапа ${index + 1}`);
    if (index === 0 && entryConnectionId !== undefined) throw new Error('У первого этапа не может быть входного стыка с предыдущей тропой.');
    let via: string[] | undefined;
    if (stage.via !== undefined) {
      if (!Array.isArray(stage.via) || stage.via.length > MAX_VIA) throw new Error(`Этап ${index + 1}: не больше ${MAX_VIA} промежуточных точек.`);
      via = Array.from(stage.via, (point, position) => text(point, `Промежуточная точка ${position + 1} этапа ${index + 1}`, 240));
    }
    return {trailId, day: stage.day, ...(entryConnectionId !== undefined ? {entryConnectionId} : {}), ...(via !== undefined ? {via} : {})};
  });
  const start = optionalReference(source.start, 'Начало похода');
  const finish = optionalReference(source.finish, 'Конец похода');
  if (!stages.length && (start !== undefined || finish !== undefined)) throw new Error('Добавьте этап перед выбором начала и конца похода.');
  return {schemaVersion: 1, id, name, createdAt, updatedAt, sourceDigest, stages,
    ...(start !== undefined ? {start} : {}), ...(finish !== undefined ? {finish} : {}), notes};
}

function endpointNode(reference: string, trailId: string): number | null {
  if (!reference.startsWith(`${trailId}@`)) return null;
  const suffix = reference.slice(trailId.length + 1);
  if (!/^(0|[1-9]\d*)$/.test(suffix)) return null;
  const node = Number(suffix);
  return Number.isSafeInteger(node) ? node : null;
}

/** Incomplete drafts may omit choices; every supplied reference must belong to this exact index. */
export function validateHikeDraft(value: unknown, index: TrailConnectionIndex): HikeDraft {
  const draft = readDraft(value);
  if (index.schemaVersion !== 1 || draft.sourceDigest !== index.sourceDigest) throw new Error(STALE_MESSAGE);
  const connections = new Map(index.connections.map(connection => [connection.id, connection]));
  const checkEndpoint = (reference: string, trailId: string, label: string) => {
    const node = endpointNode(reference, trailId);
    if (node === null || !index.routes[trailId]?.nodes[node]) throw new Error(`${label}: точка отсутствует на выбранной тропе. Выберите её заново.`);
  };
  draft.stages.forEach((stage, position) => {
    if (!Object.prototype.hasOwnProperty.call(index.routes, stage.trailId)) {
      throw new Error(`Этап ${position + 1}: тропа отсутствует в данных или не имеет геометрии для планирования.`);
    }
    for (const reference of stage.via || []) checkEndpoint(reference, stage.trailId, `Промежуточная точка этапа ${position + 1}`);
    if (stage.entryConnectionId !== undefined) {
      const connection = connections.get(stage.entryConnectionId), previous = draft.stages[position - 1].trailId;
      if (!connection || !((connection.trailA === previous && connection.trailB === stage.trailId) ||
          (connection.trailB === previous && connection.trailA === stage.trailId))) {
        throw new Error(`Этап ${position + 1}: выбранный стык не соединяет эти две последовательные тропы.`);
      }
    }
  });
  if (draft.start !== undefined) checkEndpoint(draft.start, draft.stages[0].trailId, 'Начало похода');
  if (draft.finish !== undefined) checkEndpoint(draft.finish, draft.stages[draft.stages.length - 1].trailId, 'Конец похода');
  return draft;
}

export function createHikeDraft(index: TrailConnectionIndex, seedTrailId?: string, options: CreateHikeDraftOptions = {}): HikeDraft {
  const now = options.now instanceof Date ? options.now.toISOString() : options.now ?? new Date().toISOString();
  return validateHikeDraft({schemaVersion: 1, id: options.id ?? draftId(), name: 'Новый поход',
    createdAt: now, updatedAt: now, sourceDigest: index.sourceDigest,
    stages: seedTrailId === undefined ? [] : [{trailId: seedTrailId, day: 1}], notes: ''}, index);
}

export function serializeHikeDraft(draft: HikeDraft): string {
  return `${JSON.stringify(readDraft(draft), null, 2)}\n`;
}

/** Metadata and day labels do not change the walked path or map markers. */
export function hikeDraftPathKey(draft: HikeDraft): string {
  const options: CompositePlanOptions = {
    trailIds: draft.stages.map(stage => stage.trailId),
    connectionIds: draft.stages.slice(1).map(stage => stage.entryConnectionId || ''),
    start: draft.start, finish: draft.finish,
    via: Object.fromEntries(draft.stages.map((stage, i) => [i, stage.via ?? []])),
  };
  return JSON.stringify(options);
}

export function safeHikeFilename(name: string, extension?: 'json' | 'gpx'): string {
  if (extension !== undefined && extension !== 'json' && extension !== 'gpx') throw new Error('Неподдерживаемое расширение файла похода.');
  let stem = name.normalize('NFC').replace(/\.(?:gpx|json)$/i, '')
    .replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '-').replace(/-+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  stem = [...stem].slice(0, 80).join('').replace(/[._-]+$/g, '') || 'поход';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `поход-${stem}`;
  return extension ? `${stem}.${extension}` : stem;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** GPX latitude/longitude use XML decimal, which does not accept scientific notation. */
function decimal(value: number): string {
  const source = String(Object.is(value, -0) ? 0 : value);
  if (!/[eE]/.test(source)) return source;
  const [coefficient, exponent] = source.toLowerCase().split('e');
  const sign = coefficient.startsWith('-') ? '-' : '', unsigned = sign ? coefficient.slice(1) : coefficient;
  const point = unsigned.includes('.') ? unsigned.indexOf('.') : unsigned.length;
  const digits = unsigned.replace('.', ''), position = point + Number(exponent);
  if (position <= 0) return `${sign}0.${'0'.repeat(-position)}${digits}`;
  if (position >= digits.length) return `${sign}${digits}${'0'.repeat(position - digits.length)}`;
  return `${sign}${digits.slice(0, position)}.${digits.slice(position)}`;
}

/** Shared by the download control and exporter so an enabled action always has the same requirements. */
function requireHikeGpxExport(value: HikeDraft, plan: CompositePlan, resolved: ResolvedPlanGeometry): HikeDraft & {start: string; finish: string} {
  const draft = readDraft(value);
  if (!draft.stages.length) throw new Error('Добавьте этапы перед экспортом GPX.');
  if (!draft.start || !draft.finish) throw new Error('Выберите начало и конец похода перед экспортом GPX.');
  const connectionIds = draft.stages.slice(1).map(stage => stage.entryConnectionId);
  if (connectionIds.some(id => id === undefined)) throw new Error('Выберите стык между каждым из последовательных этапов.');
  if (plan.sourceDigest !== draft.sourceDigest) throw new Error(STALE_MESSAGE);
  const plannedVia = (plan as CompositePlan & {via?: Record<number, string[]>}).via || {};
  if (JSON.stringify(plan.trailIds) !== JSON.stringify(draft.stages.map(stage => stage.trailId)) ||
      JSON.stringify(plan.connectionIds) !== JSON.stringify(connectionIds) || plan.stages.length !== draft.stages.length ||
      JSON.stringify(draft.stages.map((_stage, i) => plannedVia[i] || [])) !== JSON.stringify(draft.stages.map(stage => stage.via || [])) ||
      plan.stages.some((stage, i) => stage.trailId !== draft.stages[i].trailId) ||
      plan.stages[0].fromNode !== endpointNode(draft.start, draft.stages[0].trailId) ||
      plan.stages[plan.stages.length - 1].toNode !== endpointNode(draft.finish, draft.stages[draft.stages.length - 1].trailId)) {
    throw new Error('Расчёт не соответствует текущему походу. Пересчитайте путь перед экспортом.');
  }
  const exportableIssues = new Set(['access_closed', 'access_restricted', 'unverified_transfer', 'unverified_crossing', 'disconnected_stage']);
  const blocker = plan.issues.find(issue => !exportableIssues.has(issue.code));
  if (blocker) throw new Error(`GPX пока недоступен: ${blocker.message}`);
  if (resolved.issues.length) throw new Error(`Геометрия не готова к экспорту: ${resolved.issues[0].message}`);
  if (!Number.isFinite(plan.knownDistanceM) || plan.knownDistanceM <= 0 || !resolved.segments.length) throw new Error('Нет рассчитанных участков для экспорта GPX.');
  const expectedStages = plan.stages.flatMap((stage, i) => stage.connected && stage.refs.length ? [i] : []);
  if (resolved.features.length !== expectedStages.length || resolved.features.some((feature, i) =>
    feature.properties.stage !== expectedStages[i] || feature.properties.trailId !== plan.stages[expectedStages[i]].trailId)) {
    throw new Error('Не все рассчитанные этапы загружены. Дождитесь геометрии и повторите экспорт.');
  }
  for (const segment of resolved.segments) {
    if (!Array.isArray(segment) || segment.length < 2) throw new Error('В GPX есть пустой участок. Пересчитайте путь.');
    for (const point of segment) if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
      throw new Error('В геометрии есть некорректные координаты. Экспорт остановлен.');
    }
    if (!segment.some(point => point[0] !== segment[0][0] || point[1] !== segment[0][1])) throw new Error('В GPX есть пустой участок. Пересчитайте путь.');
  }
  return {...draft, start: draft.start, finish: draft.finish};
}

export type HikeGpxExportState = {canExport: true} | {canExport: false; reason: string};

export function getHikeGpxExportState(value: HikeDraft, plan: CompositePlan, resolved: ResolvedPlanGeometry): HikeGpxExportState {
  try {
    requireHikeGpxExport(value, plan, resolved);
    return {canExport: true};
  } catch (error) {
    return {canExport: false, reason: error instanceof Error ? error.message : 'Не удалось проверить план для GPX. Пересчитайте путь.'};
  }
}

/** Export only resolved source segments. A review break remains a distinct trkseg, including zero-meter crossings. */
export function exportHikeGpx(value: HikeDraft, plan: CompositePlan, resolved: ResolvedPlanGeometry): string {
  const draft = requireHikeGpxExport(value, plan, resolved);
  const hasBreaks = plan.gaps.length > 0 || !plan.geometryContinuous;
  const warning = hasBreaks
    ? 'Известные участки плана. Между ними есть разрывы или неподтверждённые переходы. Связующие линии не добавлены; проверьте переходы и условия на местности.'
    : 'План по исходным линиям троп. Проверьте проходимость, ограничения доступа и условия на местности.';
  const days = [...new Set(draft.stages.map(stage => stage.day))].join(', ');
  const description = `${warning}\nДни похода: ${days}.${draft.notes ? `\n${draft.notes}` : ''}`;
  const stages = draft.stages.map((stage, i) => {
    const entry = stage.entryConnectionId ? ` entryConnectionId="${xml(stage.entryConnectionId)}"` : '';
    const via = (stage.via || []).map(reference => `          <tropnik:via>${xml(reference)}</tropnik:via>`).join('\n');
    return `        <tropnik:stage index="${i + 1}" day="${stage.day}" trailId="${xml(stage.trailId)}"${entry}>${via ? `\n${via}\n        ` : ''}</tropnik:stage>`;
  }).join('\n');
  const segments = resolved.segments.map(segment => `    <trkseg>\n${segment.map(point => `      <trkpt lat="${decimal(point[1])}" lon="${decimal(point[0])}"/>`).join('\n')}\n    </trkseg>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Тропник" xmlns="${GPX_NAMESPACE}" xmlns:tropnik="${HIKE_NAMESPACE}">
  <metadata>
    <name>${xml(draft.name)}</name>
    <desc>${xml(description)}</desc>
    <extensions>
      <tropnik:plan id="${xml(draft.id)}" schemaVersion="1" sourceDigest="${draft.sourceDigest}" complete="${plan.complete}" gaps="${plan.gaps.length}">
        <tropnik:notes>${xml(draft.notes)}</tropnik:notes>
        <tropnik:start>${xml(draft.start)}</tropnik:start>
        <tropnik:finish>${xml(draft.finish)}</tropnik:finish>
${stages}
      </tropnik:plan>
    </extensions>
  </metadata>
  <trk>
    <name>${xml(draft.name)}</name>
    <desc>${xml(warning)}</desc>
${segments}
  </trk>
</gpx>
`;
}
