/** Geometric evidence from source lines. Nothing in this module asserts access or walkability. */
export type LngLat = [number, number];
export type TrailConnectionKind = 'shared' | 'intersection' | 'nearby';
export type TrailAnchor = {part: number; segment: number; t: number; point: LngLat; node: number};
export type TrailConnection = {
  id: string; trailA: string; trailB: string; kind: TrailConnectionKind;
  a: TrailAnchor; b: TrailAnchor; gapM: number; sharedLengthM?: number;
  evidence: 'shared_geometry' | 'shared_vertex' | 'geometric_crossing' | 'geometric_overlap' | 'proximity';
  sourceVertex: boolean; reviewRequired: true;
};
/** Edges retain an ordered interval of one original part; negative traversal reverses that interval. */
export type TrailEdgeRef = {part: number; from: number; to: number};
export type TrailTopology = {
  geometryUrl: string; sha256: string; geometryFingerprint: string; checkedAt: string; geometryRetrievedAt?: string;
  quality: 'reference_geometry'; accessStatus: 'closed' | 'restricted' | 'unknown';
  partCount: number; componentCount: number; lengthM: number; invalidPositions: number;
  nodes: [longitude: number, latitude: number, component: number, degree: number][];
  edges: [from: number, to: number, lengthM: number, part: number, start: number, end: number][];
};
export type TrailConnectionIndex = {
  schemaVersion: 1; sourceDigest: string;
  parameters: {nearbyMeters: number; coordinateJoin: 'exact'; crossingPolicy: 'review_only'};
  stats: {catalogueRoutes: number; geometryRoutes: number; missingGeometryRoutes: number; connections: number};
  routes: Record<string, TrailTopology>; connections: TrailConnection[];
};
export type TrailConnectionCandidate = {connection: TrailConnection; otherTrailId: string; from: TrailAnchor; to: TrailAnchor};
export type TrailEndpoint = {id: string; node: number; point: LngLat; component: number; degree: number; kind: 'terminal' | 'junction' | 'loop'};
export type CompositePlanIssue = {code: string; message: string; trailId?: string; connectionId?: string};
export type CompositePlanStage = {
  trailId: string; fromNode: number | null; toNode: number | null;
  refs: TrailEdgeRef[]; distanceM: number; connected: boolean;
};
export type CompositePlanGap = {connectionId?: string; trailId?: string; from: LngLat; to: LngLat; distanceM: number; kind: TrailConnectionKind | 'internal'};
export type CompositePlan = {
  sourceDigest: string; trailIds: string[]; connectionIds: string[]; stages: CompositePlanStage[];
  via: Record<number, string[]>;
  knownDistanceM: number; gaps: CompositePlanGap[]; issues: CompositePlanIssue[];
  complete: boolean; geometryContinuous: boolean; reviewRequired: true;
};
export type CompositePlanOptions = {trailIds: string[]; connectionIds: string[]; start?: string; finish?: string; via?: Record<number, string[]>};
export type TrailGeometry = {parts: LngLat[][]; invalidPositions: number; unsupportedGeometries: number};
export type ResolvedPlanGeometry = {
  type: 'FeatureCollection'; features: {type: 'Feature'; properties: {trailId: string; stage: number}; geometry: {type: 'LineString'; coordinates: LngLat[]}}[];
  segments: LngLat[][]; issues: CompositePlanIssue[];
};

const EARTH_RADIUS_M = 6371008.8;
const radians = Math.PI / 180;
const roundM = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
export function longitudeDelta(from: number, to: number): number {return ((to - from + 540) % 360) - 180;}
export function coordinateKey(point: LngLat): string {return `${point[0] === 180 ? -180 : point[0]},${point[1]}`;}
export function distanceMeters(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * radians, dLon = longitudeDelta(a[0], b[0]) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(clamp(h)), Math.sqrt(1 - clamp(h)));
}
export function interpolatePoint(a: LngLat, b: LngLat, t: number): LngLat {
  if (t <= 0) return [...a];
  if (t >= 1) return [...b];
  let lon = a[0] + longitudeDelta(a[0], b[0]) * t;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return [lon, a[1] + (b[1] - a[1]) * t];
}

/** Invalid positions split a part. Neither separate parts nor malformed points are bridged. */
export function normalizeTrailGeometry(value: unknown): TrailGeometry {
  const result: TrailGeometry = {parts: [], invalidPositions: 0, unsupportedGeometries: 0};
  function line(value: unknown) {
    if (!Array.isArray(value)) {result.invalidPositions++; return;}
    let part: LngLat[] = [];
    const finish = () => {if (part.length >= 2) result.parts.push(part); part = [];};
    for (const item of value) {
      if (!Array.isArray(item) || typeof item[0] !== 'number' || typeof item[1] !== 'number' ||
          !Number.isFinite(item[0]) || !Number.isFinite(item[1]) || Math.abs(item[0]) > 180 || Math.abs(item[1]) > 90) {
        result.invalidPositions++; finish(); continue;
      }
      const point: LngLat = [item[0], item[1]];
      if (!part.length || coordinateKey(part[part.length - 1]) !== coordinateKey(point)) part.push(point);
    }
    finish();
  }
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') {result.unsupportedGeometries++; return;}
    const item = value as Record<string, unknown>;
    if (item.type === 'FeatureCollection' && Array.isArray(item.features)) item.features.forEach(visit);
    else if (item.type === 'Feature') visit(item.geometry);
    else if (item.type === 'GeometryCollection' && Array.isArray(item.geometries)) item.geometries.forEach(visit);
    else if (item.type === 'MultiLineString' && Array.isArray(item.coordinates)) item.coordinates.forEach(line);
    else if (item.type === 'LineString') line(item.coordinates);
    else result.unsupportedGeometries++;
  }
  visit(value);
  return result;
}

/** A deterministic drift check for parsed coordinates; provenance uses the separate raw-file SHA256. */
export function geometryFingerprint(parts: LngLat[][]): string {
  let hash = 2166136261;
  const input = JSON.stringify(parts);
  for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type SegmentRelation = {a: {t: number; point: LngLat}; b: {t: number; point: LngLat}; gapM: number;
  overlap?: {aFrom: number; aTo: number; bFrom: number; bTo: number; lengthM: number}};
/** Local segment geometry only: an intersection in this plane is not evidence of a same-level junction. */
export function closestSegmentPoints(a: LngLat, b: LngLat, c: LngLat, d: LngLat): SegmentRelation {
  const latitude = (a[1] + b[1] + c[1] + d[1]) / 4 * radians;
  const scaleX = EARTH_RADIUS_M * radians * Math.max(1e-8, Math.cos(latitude));
  const scaleY = EARTH_RADIUS_M * radians;
  const p = [0, 0], q = [longitudeDelta(a[0], b[0]) * scaleX, (b[1] - a[1]) * scaleY];
  const r = [longitudeDelta(a[0], c[0]) * scaleX, (c[1] - a[1]) * scaleY];
  const s = [r[0] + longitudeDelta(c[0], d[0]) * scaleX, (d[1] - a[1]) * scaleY];
  const u = q, v = [s[0] - r[0], s[1] - r[1]];
  const cross = (x: number[], y: number[]) => x[0] * y[1] - x[1] * y[0];
  const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1];
  const uu = dot(u, u), vv = dot(v, v), denominator = cross(u, v);
  const make = (ta: number, tb: number): SegmentRelation => {
    ta = clamp(ta); tb = clamp(tb);
    const pointA = interpolatePoint(a, b, ta), pointB = interpolatePoint(c, d, tb);
    return {a: {t: ta, point: pointA}, b: {t: tb, point: pointB}, gapM: distanceMeters(pointA, pointB)};
  };
  if (Math.abs(denominator) > 1e-9) {
    const ta = cross(r, v) / denominator, tb = cross(r, u) / denominator;
    if (ta >= -1e-10 && ta <= 1 + 1e-10 && tb >= -1e-10 && tb <= 1 + 1e-10) return {...make(ta, tb), gapM: 0};
  } else if (uu > 0 && vv > 0 && Math.abs(cross(r, u)) <= 1e-7 * Math.sqrt(uu)) {
    const t0 = dot(r, u) / uu, t1 = dot(s, u) / uu;
    const from = Math.max(0, Math.min(t0, t1)), to = Math.min(1, Math.max(t0, t1));
    if (to >= from) {
      const at = (t: number) => dot([u[0] * t - r[0], u[1] * t - r[1]], v) / vv;
      const result = {...make(from, at(from)), gapM: 0};
      if (to > from + 1e-10) result.overlap = {aFrom: from, aTo: to, bFrom: clamp(at(from)), bTo: clamp(at(to)), lengthM: distanceMeters(interpolatePoint(a, b, from), interpolatePoint(a, b, to))};
      return result;
    }
  }
  const project = (point: number[], start: number[], vector: number[], lengthSquared: number) => lengthSquared ? clamp(dot([point[0] - start[0], point[1] - start[1]], vector) / lengthSquared) : 0;
  const candidates = [make(0, project(p, r, v, vv)), make(1, project(q, r, v, vv)), make(project(r, p, u, uu), 0), make(project(s, p, u, uu), 1)];
  return candidates.sort((left, right) => left.gapM - right.gapM)[0];
}

export function getTrailConnections(index: TrailConnectionIndex, trailId: string, options: {maxGapM?: number} = {}): TrailConnectionCandidate[] {
  const maximum = options.maxGapM ?? index.parameters.nearbyMeters;
  return index.connections.flatMap(connection => {
    if (connection.trailA !== trailId && connection.trailB !== trailId) return [];
    if (connection.kind === 'nearby' && connection.gapM > maximum) return [];
    return [{connection, otherTrailId: connection.trailA === trailId ? connection.trailB : connection.trailA,
      from: connection.trailA === trailId ? connection.a : connection.b, to: connection.trailA === trailId ? connection.b : connection.a}];
  }).sort((a, b) => Number(!a.connection.sourceVertex) - Number(!b.connection.sourceVertex) ||
    a.connection.gapM - b.connection.gapM || a.otherTrailId.localeCompare(b.otherTrailId) || a.connection.id.localeCompare(b.connection.id));
}

const endpointId = (trailId: string, node: number) => `${trailId}@${node}`;
export function getTrailEndpoints(index: TrailConnectionIndex, trailId: string): TrailEndpoint[] {
  const route = index.routes[trailId];
  if (!route) return [];
  const selected = new Set<number>();
  route.nodes.forEach((node, i) => {if (node[3] !== 2) selected.add(i);});
  for (let component = 0; component < route.componentCount; component++) {
    const members = route.nodes.map((node, i) => ({node, i})).filter(value => value.node[2] === component);
    if (!members.some(value => selected.has(value.i))) {
      // A ring has no terminal. Give two real vertices as explicit choices, never an invented endpoint.
      if (members[0]) selected.add(members[0].i);
      if (members.length > 1) {
        const first = members[0].node;
        selected.add(members.slice(1).sort((a, b) => distanceMeters([first[0], first[1]], [b.node[0], b.node[1]]) - distanceMeters([first[0], first[1]], [a.node[0], a.node[1]]))[0].i);
      }
    }
  }
  return [...selected].sort((a, b) => route.nodes[a][2] - route.nodes[b][2] || route.nodes[a][3] - route.nodes[b][3] || a - b).map(node => {
    const value = route.nodes[node];
    return {id: endpointId(trailId, node), node, point: [value[0], value[1]], component: value[2], degree: value[3], kind: value[3] === 1 ? 'terminal' : value[3] > 2 ? 'junction' : 'loop'};
  });
}
export function getTrailTerminals(index: TrailConnectionIndex, trailId: string): TrailEndpoint[] {return getTrailEndpoints(index, trailId).filter(endpoint => endpoint.kind === 'terminal');}

function shortestPath(route: TrailTopology, start: number, finish: number): {refs: TrailEdgeRef[]; distanceM: number} | null {
  if (start === finish) return {refs: [], distanceM: 0};
  if (!route.nodes[start] || !route.nodes[finish] || route.nodes[start][2] !== route.nodes[finish][2]) return null;
  const adjacency: {node: number; edge: number}[][] = route.nodes.map(() => []);
  route.edges.forEach((edge, i) => {adjacency[edge[0]].push({node: edge[1], edge: i}); adjacency[edge[1]].push({node: edge[0], edge: i});});
  const distances = new Float64Array(route.nodes.length).fill(Infinity);
  const previous = new Int32Array(route.nodes.length).fill(-1), via = new Int32Array(route.nodes.length).fill(-1);
  const heap: [number, number][] = [];
  const push = (item: [number, number]) => {heap.push(item); let i = heap.length - 1; while (i > 0) {const parent = (i - 1) >> 1; if (heap[parent][0] <= item[0]) break; heap[i] = heap[parent]; i = parent;} heap[i] = item;};
  const pop = () => {const result = heap[0], last = heap.pop()!; if (heap.length) {let i = 0; while (i * 2 + 1 < heap.length) {let child = i * 2 + 1; if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++; if (last[0] <= heap[child][0]) break; heap[i] = heap[child]; i = child;} heap[i] = last;} return result;};
  distances[start] = 0; push([0, start]);
  while (heap.length) {
    const [cost, node] = pop();
    if (cost !== distances[node]) continue;
    if (node === finish) break;
    for (const next of adjacency[node]) {
      const candidate = cost + route.edges[next.edge][2];
      if (candidate + 1e-8 >= distances[next.node]) continue;
      distances[next.node] = candidate; previous[next.node] = node; via[next.node] = next.edge; push([candidate, next.node]);
    }
  }
  if (!Number.isFinite(distances[finish])) return null;
  const refs: TrailEdgeRef[] = [];
  for (let node = finish; node !== start; node = previous[node]) {
    const edge = route.edges[via[node]], forward = edge[0] === previous[node];
    refs.push({part: edge[3], from: forward ? edge[4] : edge[5], to: forward ? edge[5] : edge[4]});
  }
  return {refs: refs.reverse(), distanceM: roundM(distances[finish])};
}

export function planTrailSequence(index: TrailConnectionIndex, options: CompositePlanOptions): CompositePlan {
  const via = Object.fromEntries(options.trailIds.map((_trailId, i) => [i, Array.isArray(options.via?.[i]) ? [...options.via![i]] : []]));
  const plan: CompositePlan = {sourceDigest: index.sourceDigest, trailIds: [...options.trailIds], connectionIds: [...options.connectionIds], via, stages: [], knownDistanceM: 0, gaps: [], issues: [], complete: true, geometryContinuous: true, reviewRequired: true};
  const issue = (value: CompositePlanIssue, incomplete = false) => {plan.issues.push(value); if (incomplete) {plan.complete = false; plan.geometryContinuous = false;}};
  if (!options.trailIds.length) {issue({code: 'empty_plan', message: 'Выберите стартовую тропу.'}, true); return plan;}
  const connections = new Map(index.connections.map(connection => [connection.id, connection]));
  const joins: (TrailConnectionCandidate | null)[] = [];
  for (let i = 0; i < options.trailIds.length - 1; i++) {
    const from = options.trailIds[i], to = options.trailIds[i + 1], connection = connections.get(options.connectionIds[i]);
    if (!connection || !((connection.trailA === from && connection.trailB === to) || (connection.trailB === from && connection.trailA === to))) {
      issue({code: 'missing_connection', message: 'Выберите существующий стык между последовательными этапами.', trailId: from}, true); joins.push(null); continue;
    }
    const join = {connection, otherTrailId: to, from: connection.trailA === from ? connection.a : connection.b, to: connection.trailA === from ? connection.b : connection.a};
    joins.push(join);
    if (!connection.sourceVertex) {
      plan.gaps.push({connectionId: connection.id, from: join.from.point, to: join.to.point, distanceM: connection.gapM, kind: connection.kind});
      issue({code: connection.kind === 'nearby' ? 'unverified_transfer' : 'unverified_crossing', message: connection.kind === 'nearby' ? 'Между тропами есть разрыв: расстояние по прямой не является длиной перехода.' : 'Пересечение линий не подтверждает общий проход: уровни, ограждения и доступ нужно проверить.', connectionId: connection.id}, true);
    }
  }
  if (options.connectionIds.length !== Math.max(0, options.trailIds.length - 1)) issue({code: 'connection_count', message: 'Количество стыков не соответствует последовательности этапов.'}, true);
  function readEndpoint(id: string | undefined, trailId: string, role: 'start' | 'finish' | 'via'): number | null {
    if (typeof id === 'string' && id.startsWith(trailId + '@')) {
      const suffix = id.slice(trailId.length + 1), node = Number(suffix);
      if (/^\d+$/.test(suffix) && index.routes[trailId]?.nodes[node]) return node;
    }
    issue({code: id ? `invalid_${role}` : `missing_${role}`, message: role === 'start' ? 'Выберите начало пути на первой тропе.' : role === 'finish' ? 'Выберите конец пути на последней тропе.' : 'Промежуточная точка не найдена на этом этапе.', trailId}, true);
    return null;
  }
  options.trailIds.forEach((trailId, i) => {
    const route = index.routes[trailId];
    const fromNode = i === 0 ? readEndpoint(options.start, trailId, 'start') : joins[i - 1]?.to.node ?? null;
    const toNode = i === options.trailIds.length - 1 ? readEndpoint(options.finish, trailId, 'finish') : joins[i]?.from.node ?? null;
    const stage: CompositePlanStage = {trailId, fromNode, toNode, refs: [], distanceM: 0, connected: false};
    plan.stages.push(stage);
    if (!route) {issue({code: 'missing_geometry', message: 'У этой карточки нет исходной геометрии для расчёта этапа.', trailId}, true); return;}
    if (route.accessStatus !== 'unknown') issue({code: `access_${route.accessStatus}`, message: route.accessStatus === 'closed' ? 'Источник сообщает о закрытии маршрута. Наличие линии не разрешает прохождение.' : 'На маршруте есть ограничения доступа. Проверьте разрешённые участки.', trailId});
    if (fromNode === null || toNode === null) return;
    const viaIds = options.via?.[i] ?? [];
    if (!Array.isArray(viaIds)) {issue({code: 'invalid_via', message: 'Промежуточные точки должны быть упорядоченным списком.', trailId}, true); return;}
    const viaNodes = viaIds.map(id => readEndpoint(id, trailId, 'via'));
    if (viaNodes.some(node => node === null)) return;
    const waypoints = [fromNode, ...viaNodes as number[], toNode];
    const path = {refs: [] as TrailEdgeRef[], distanceM: 0};
    for (let leg = 1; leg < waypoints.length; leg++) {
      const section = shortestPath(route, waypoints[leg - 1], waypoints[leg]);
      if (section) {path.refs.push(...section.refs); path.distanceM += section.distanceM; continue;}
      issue({code: 'disconnected_stage', message: 'Между выбранными точками нет непрерывного пути в исходной геометрии.', trailId}, true);
      const from = route.nodes[waypoints[leg - 1]], to = route.nodes[waypoints[leg]];
      if (from && to) plan.gaps.push({trailId, from: [from[0], from[1]], to: [to[0], to[1]], distanceM: roundM(distanceMeters([from[0], from[1]], [to[0], to[1]])), kind: 'internal'});
      return;
    }
    path.distanceM = roundM(path.distanceM);
    Object.assign(stage, path, {connected: true});
    plan.knownDistanceM += path.distanceM;
    if (!path.refs.length) issue({code: 'empty_stage', message: 'Вход и выход совпадают: эта тропа не добавляет пройденного участка. Выберите другую точку или уберите этап.', trailId});
  });
  plan.knownDistanceM = roundM(plan.knownDistanceM);
  if (plan.knownDistanceM === 0) {
    plan.complete = false;
    plan.geometryContinuous = false;
  }
  return plan;
}

function pointAt(part: LngLat[], index: number): LngLat | null {
  if (!Number.isFinite(index) || index < 0 || index > part.length - 1) return null;
  const position = Math.floor(index);
  return position === part.length - 1 ? [...part[position]] : interpolatePoint(part[position], part[position + 1], index - position);
}
export function resolvePlanGeometry(index: TrailConnectionIndex, plan: CompositePlan, loaded: Record<string, unknown>): ResolvedPlanGeometry {
  const result: ResolvedPlanGeometry = {type: 'FeatureCollection', features: [], segments: [], issues: []};
  if (plan.sourceDigest !== index.sourceDigest) {result.issues.push({code: 'stale_plan', message: 'Исходные данные изменились: пересчитайте сохранённый план.'}); return result;}
  const normalized = new Map<string, TrailGeometry>();
  const connectionMap = new Map(index.connections.map(connection => [connection.id, connection]));
  let precedingStage = -2;
  plan.stages.forEach((stage, stageIndex) => {
    if (!stage.connected || !stage.refs.length) return;
    const route = index.routes[stage.trailId];
    let geometry = normalized.get(stage.trailId);
    if (!geometry) {geometry = normalizeTrailGeometry(loaded[stage.trailId]); normalized.set(stage.trailId, geometry);}
    if (!route || geometry.parts.length !== route.partCount || geometryFingerprint(geometry.parts) !== route.geometryFingerprint) {
      result.issues.push({code: 'geometry_mismatch', message: 'Геометрия этапа не совпадает с индексом. Перезагрузите исходные данные.', trailId: stage.trailId}); return;
    }
    let coordinates: LngLat[] = [];
    for (const ref of stage.refs) {
      const part = geometry.parts[ref.part], start = part && pointAt(part, ref.from), finish = part && pointAt(part, ref.to);
      if (!start || !finish) {result.issues.push({code: 'invalid_reference', message: 'Исходный участок этапа отсутствует.', trailId: stage.trailId}); coordinates = []; break;}
      const forward = ref.to >= ref.from;
      const interior = part.filter((_point, i) => i > Math.min(ref.from, ref.to) && i < Math.max(ref.from, ref.to));
      if (!forward) interior.reverse();
      const segment = [start, ...interior, finish].filter((point, i, points) => !i || coordinateKey(point) !== coordinateKey(points[i - 1]));
      if (coordinates.length && coordinateKey(coordinates[coordinates.length - 1]) !== coordinateKey(start)) {
        result.issues.push({code: 'broken_reference', message: 'Исходные части не соединены. Линия через разрыв не построена.', trailId: stage.trailId}); coordinates = []; break;
      }
      coordinates.push(...(coordinates.length ? segment.slice(1) : segment));
    }
    if (coordinates.length < 2) return;
    result.features.push({type: 'Feature', properties: {trailId: stage.trailId, stage: stageIndex}, geometry: {type: 'LineString', coordinates}});
    const previous = result.segments[result.segments.length - 1];
    const join = connectionMap.get(plan.connectionIds[stageIndex - 1]);
    if (precedingStage === stageIndex - 1 && join?.sourceVertex && previous && coordinateKey(previous[previous.length - 1]) === coordinateKey(coordinates[0])) previous.push(...coordinates.slice(1));
    else result.segments.push([...coordinates]);
    precedingStage = stageIndex;
  });
  return result;
}
