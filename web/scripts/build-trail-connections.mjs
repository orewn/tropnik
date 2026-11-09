import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {closestSegmentPoints, coordinateKey, distanceMeters, geometryFingerprint, interpolatePoint, longitudeDelta, normalizeTrailGeometry} from '../lib/trail-connections.ts';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const roundM = value => Math.round(value * 1000) / 1000;
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const combinations = values => values.flatMap((a, i) => values.slice(i + 1).map(b => [a, b]));

/** Pure, deterministic builder. The browser receives only this compact topology, never the full catalogue geometry. */
export function buildTrailConnectionIndex(inputs, {nearbyMeters = 300, catalogueRoutes = inputs.length} = {}) {
  if (!(nearbyMeters >= 0 && nearbyMeters <= 2000)) throw new Error('Nearby radius must be between 0 and 2000 meters.');
  const source = [...inputs].sort((a, b) => lexical(a.id, b.id));
  if (new Set(source.map(route => route.id)).size !== source.length) throw new Error('Duplicate trail identity.');
  const segments = [], segmentIds = new Map(), vertices = new Map();
  const routes = source.map(input => {
    const geometry = normalizeTrailGeometry(input.geometry);
    if (!geometry.parts.length) throw new Error(`No usable source lines for ${input.id}.`);
    return {...input, ...geometry, vertexEdges: new Map(), prefixes: geometry.parts.map(part => {
      const lengths = [0]; for (let i = 1; i < part.length; i++) lengths.push(lengths[i - 1] + distanceMeters(part[i - 1], part[i])); return lengths;
    })};
  });
  routes.forEach((route, routeIndex) => {
    route.parts.forEach((part, partIndex) => {
      for (let i = 0; i < part.length - 1; i++) {
        const fromKey = coordinateKey(part[i]), toKey = coordinateKey(part[i + 1]);
        const forward = lexical(fromKey, toKey) < 0, key = forward ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
        let id = segmentIds.get(key);
        if (id === undefined) {id = segments.length; segmentIds.set(key, id); segments.push({a: forward ? part[i] : part[i + 1], b: forward ? part[i + 1] : part[i], aKey: forward ? fromKey : toKey, bKey: forward ? toKey : fromKey, members: new Map()});}
        const segment = segments[id];
        if (!segment.members.has(routeIndex)) segment.members.set(routeIndex, {part: partIndex, segment: i, forward});
        for (const pointKey of [fromKey, toKey]) {
          if (!route.vertexEdges.has(pointKey)) route.vertexEdges.set(pointKey, new Set());
          route.vertexEdges.get(pointKey).add(id);
          if (!vertices.has(pointKey)) vertices.set(pointKey, new Map());
          if (!vertices.get(pointKey).has(routeIndex)) vertices.get(pointKey).set(routeIndex, {segment: id, t: pointKey === segment.aKey ? 0 : 1});
        }
      }
    });
  });
  const pairs = new Map();
  const pairFor = (a, b) => {
    const first = Math.min(a, b), second = Math.max(a, b), key = `${first}:${second}`;
    if (!pairs.has(key)) pairs.set(key, {key, a: first, b: second, points: new Set(), shared: new Set()});
    return pairs.get(key);
  };
  for (const [key, members] of vertices) for (const [a, b] of combinations([...members.keys()])) pairFor(a, b).points.add(key);
  segments.forEach((segment, i) => {for (const [a, b] of combinations([...segment.members.keys()])) pairFor(a, b).shared.add(i);});
  function pointAt(route, part, position) {
    const line = route.parts[part], segment = Math.min(line.length - 2, Math.floor(position));
    return interpolatePoint(line[segment], line[segment + 1], position - segment);
  }
  function anchor(routeIndex, segmentIndex, fraction) {
    const member = segments[segmentIndex].members.get(routeIndex), route = routes[routeIndex];
    let t = Math.round((member.forward ? fraction : 1 - fraction) * 1e10) / 1e10;
    t = Math.max(0, Math.min(1, t));
    const position = member.segment + t;
    return {part: member.part, segment: member.segment, t: position - member.segment, point: pointAt(route, member.part, position), node: -1};
  }
  const candidates = new Map(), connectedPairs = new Set();
  function addCandidate(pair, a, b, kind, evidence, sharedLengthM = 0) {
    const sourceVertex = pair.points.has(coordinateKey(a.point)) && coordinateKey(a.point) === coordinateKey(b.point);
    const pointKey = point => point.map(number => number.toFixed(7)).join(',');
    const key = `${pair.key}|${pointKey(a.point)}|${pointKey(b.point)}`;
    const previous = candidates.get(key);
    if (previous) {if (sharedLengthM > (previous.sharedLengthM || 0)) previous.sharedLengthM = roundM(sharedLengthM); return;}
    const value = {id: 'join-' + digest(key).slice(0, 16), trailA: routes[pair.a].id, trailB: routes[pair.b].id, kind, a, b,
      gapM: kind === 'nearby' ? roundM(distanceMeters(a.point, b.point)) : 0, ...(sharedLengthM > 0 ? {sharedLengthM: roundM(sharedLengthM)} : {}), evidence, sourceVertex, reviewRequired: true};
    candidates.set(key, value); connectedPairs.add(pair.key);
  }
  function sourceCandidate(pair, key, kind, sharedLengthM = 0) {
    const a = vertices.get(key).get(pair.a), b = vertices.get(key).get(pair.b);
    addCandidate(pair, anchor(pair.a, a.segment, a.t), anchor(pair.b, b.segment, b.t), kind, kind === 'shared' ? 'shared_geometry' : 'shared_vertex', sharedLengthM);
  }
  for (const pair of pairs.values()) {
    const adjacency = new Map();
    for (const id of pair.shared) for (const key of [segments[id].aKey, segments[id].bKey]) {
      if (!adjacency.has(key)) adjacency.set(key, []); adjacency.get(key).push(id);
    }
    const breaks = new Set([...adjacency.keys()].filter(key => adjacency.get(key).length !== 2 || routes[pair.a].vertexEdges.get(key).size !== 2 || routes[pair.b].vertexEdges.get(key).size !== 2));
    const seen = new Set();
    function walk(start, first) {
      const points = [start], lengths = [0]; let key = start, edge = first;
      while (!seen.has(edge)) {
        seen.add(edge); const segment = segments[edge], next = segment.aKey === key ? segment.bKey : segment.aKey;
        points.push(next); lengths.push(lengths[lengths.length - 1] + distanceMeters(segment.a, segment.b)); key = next;
        if (breaks.has(key) || key === start) break;
        const onward = adjacency.get(key).find(id => !seen.has(id)); if (onward === undefined) break; edge = onward;
      }
      return {points, lengths};
    }
    for (const start of [...breaks].sort(lexical)) for (const edge of adjacency.get(start)) {
      if (seen.has(edge)) continue;
      const chain = walk(start, edge), length = chain.lengths.at(-1);
      sourceCandidate(pair, start, 'shared', length); sourceCandidate(pair, chain.points.at(-1), 'shared', length);
    }
    for (const edge of pair.shared) {
      if (seen.has(edge)) continue;
      const chain = walk(segments[edge].aKey, edge), length = chain.lengths.at(-1);
      const middle = chain.lengths.findIndex(value => value >= length / 2);
      sourceCandidate(pair, chain.points[0], 'shared', length); sourceCandidate(pair, chain.points[Math.min(middle, chain.points.length - 2)], 'shared', length);
    }
    for (const key of [...pair.points].sort(lexical)) if (!adjacency.has(key)) sourceCandidate(pair, key, 'intersection');
  }

  // A geographic grid wraps at the antimeridian. Its latitude-aware query is only a candidate filter.
  const cellDegrees = .01, columns = 360 / cellDegrees, grid = new Map(), nearest = new Map();
  const box = segment => {
    const end = segment.a[0] + longitudeDelta(segment.a[0], segment.b[0]);
    return [Math.min(segment.a[0], end), Math.min(segment.a[1], segment.b[1]), Math.max(segment.a[0], end), Math.max(segment.a[1], segment.b[1])];
  };
  const boxes = segments.map(box);
  function cells(bounds, meters) {
    const latitudeMargin = meters / 110574;
    const longitudeMargin = meters / (111195 * Math.max(.00001, Math.cos(Math.min(89.99999, Math.max(Math.abs(bounds[1]), Math.abs(bounds[3])) + latitudeMargin) * Math.PI / 180)));
    const left = Math.floor((bounds[0] - longitudeMargin + 180) / cellDegrees), right = Math.floor((bounds[2] + longitudeMargin + 180) / cellDegrees);
    const bottom = Math.floor((bounds[1] - latitudeMargin + 90) / cellDegrees), top = Math.floor((bounds[3] + latitudeMargin + 90) / cellDegrees);
    if (right - left > columns || (right - left + 1) * (top - bottom + 1) > 100000) throw new Error('A segment is too broad for the local trail index; split the source or inspect its coordinates.');
    const result = []; for (let x = left; x <= right; x++) for (let y = bottom; y <= top; y++) result.push(`${((x % columns) + columns) % columns}:${y}`); return result;
  }
  segments.forEach((segment, id) => {
    const visited = new Set();
    for (const cell of cells(boxes[id], nearbyMeters)) for (const otherId of grid.get(cell) || []) {
      if (visited.has(otherId)) continue; visited.add(otherId);
      const other = segments[otherId], relevant = new Map();
      for (const a of segment.members.keys()) for (const b of other.members.keys()) {
        if (a === b) continue;
        // Both physical edges already belong to both trails: the common corridor covers this pair.
        if (segment.members.has(b) && other.members.has(a)) continue;
        const pair = pairFor(a, b); relevant.set(pair.key, {pair, a, b});
      }
      if (!relevant.size) continue;
      const relation = closestSegmentPoints(segment.a, segment.b, other.a, other.b);
      if (relation.gapM > nearbyMeters) continue;
      for (const {pair, a, b} of relevant.values()) {
        const orient = (ta, tb) => {const first = anchor(a, id, ta), second = anchor(b, otherId, tb); return a === pair.a ? [first, second] : [second, first];};
        if (relation.gapM === 0) {
          if (relation.overlap) {
            const overlap = relation.overlap;
            const ends = [orient(overlap.aFrom, overlap.bFrom), orient(overlap.aTo, overlap.bTo)];
            for (const [first, second] of ends) addCandidate(pair, first, second, 'shared', 'geometric_overlap', overlap.lengthM);
          } else {
            const [first, second] = orient(relation.a.t, relation.b.t);
            // Exact shared vertices were reduced above; do not turn every interior corridor vertex into another join.
            if (pair.points.has(coordinateKey(first.point)) && coordinateKey(first.point) === coordinateKey(second.point)) continue;
            addCandidate(pair, first, second, 'intersection', 'geometric_crossing');
          }
        } else if (!connectedPairs.has(pair.key) && (!nearest.has(pair.key) || relation.gapM < nearest.get(pair.key).distance)) {
          nearest.set(pair.key, {pair, anchors: orient(relation.a.t, relation.b.t), distance: relation.gapM});
        }
      }
    }
    for (const cell of cells(boxes[id], 0)) {if (!grid.has(cell)) grid.set(cell, []); grid.get(cell).push(id);}
  });
  for (const {pair, anchors} of nearest.values()) if (!connectedPairs.has(pair.key)) addCandidate(pair, ...anchors, 'nearby', 'proximity');
  const connections = [...candidates.values()].sort((a, b) => lexical(a.trailA, b.trailA) || lexical(a.trailB, b.trailB) || lexical(a.id, b.id));
  const routeAnchors = routes.map(() => []), indices = new Map(routes.map((route, i) => [route.id, i]));
  for (const connection of connections) {routeAnchors[indices.get(connection.trailA)].push(connection.a); routeAnchors[indices.get(connection.trailB)].push(connection.b);}
  const topology = {};
  routes.forEach((route, routeIndex) => {
    const runs = [], breakKeys = new Set([...route.vertexEdges].filter(([, edges]) => edges.size !== 2).map(([key]) => key));
    for (const anchor of routeAnchors[routeIndex]) breakKeys.add(coordinateKey(anchor.point));
    route.parts.forEach((part, partIndex) => {
      let start = null;
      const finish = end => {
        if (start === null) return;
        runs.push({part: partIndex, start, end}); breakKeys.add(coordinateKey(part[start])); breakKeys.add(coordinateKey(part[end]));
        if (coordinateKey(part[start]) === coordinateKey(part[end]) && end - start > 1) breakKeys.add(coordinateKey(part[Math.floor((start + end) / 2)]));
        start = null;
      };
      for (let i = 0; i < part.length - 1; i++) {
        const ka = coordinateKey(part[i]), kb = coordinateKey(part[i + 1]), key = lexical(ka, kb) < 0 ? `${ka}|${kb}` : `${kb}|${ka}`;
        const owner = segments[segmentIds.get(key)].members.get(routeIndex);
        if (owner.part === partIndex && owner.segment === i) {if (start === null) start = i;} else finish(i);
      }
      finish(part.length - 1);
    });
    const cuts = new Map();
    for (const anchor of routeAnchors[routeIndex]) {
      if (!cuts.has(anchor.part)) cuts.set(anchor.part, new Set()); cuts.get(anchor.part).add(anchor.segment + anchor.t);
    }
    const nodes = [], nodeIds = new Map(), edges = [];
    // Equal XY on two unrelated parts is not an observed junction. Only original
    // vertices share coordinate identities; fractional cuts belong to their source edge.
    const nodeKey = (part, position) => Number.isInteger(position) ? `v:${coordinateKey(pointAt(route, part, position))}` : `p:${part}:${position}`;
    const getNode = (part, position) => {const point = pointAt(route, part, position), key = nodeKey(part, position); if (!nodeIds.has(key)) {nodeIds.set(key, nodes.length); nodes.push([point[0], point[1], -1, 0]);} return nodeIds.get(key);};
    const along = (part, position) => {const prefix = route.prefixes[part], i = Math.floor(position); return i === prefix.length - 1 ? prefix[i] : prefix[i] + (prefix[i + 1] - prefix[i]) * (position - i);};
    for (const run of runs) {
      const positions = new Set([run.start, run.end]);
      for (let i = run.start + 1; i < run.end; i++) if (breakKeys.has(coordinateKey(route.parts[run.part][i]))) positions.add(i);
      for (const value of cuts.get(run.part) || []) if (value > run.start && value < run.end) positions.add(value);
      const ordered = [...positions].sort((a, b) => a - b);
      for (let i = 1; i < ordered.length; i++) {
        const from = ordered[i - 1], to = ordered[i], first = getNode(run.part, from), last = getNode(run.part, to);
        const length = roundM(along(run.part, to) - along(run.part, from));
        if (length <= 0) continue;
        edges.push([first, last, length, run.part, from, to]); nodes[first][3]++; nodes[last][3]++;
      }
    }
    const adjacency = nodes.map(() => []); for (const edge of edges) {adjacency[edge[0]].push(edge[1]); adjacency[edge[1]].push(edge[0]);}
    let componentCount = 0;
    nodes.forEach((node, first) => {
      if (node[2] !== -1) return;
      const queue = [first]; node[2] = componentCount;
      for (let i = 0; i < queue.length; i++) for (const next of adjacency[queue[i]]) if (nodes[next][2] === -1) {nodes[next][2] = componentCount; queue.push(next);}
      componentCount++;
    });
    for (const anchor of routeAnchors[routeIndex]) {anchor.node = nodeIds.get(nodeKey(anchor.part, anchor.segment + anchor.t)); if (anchor.node === undefined) throw new Error(`Unresolved connection anchor for ${route.id}.`);}
    const retrievedAt = route.geometry?.features?.find(feature => feature.properties?.retrievedAt)?.properties.retrievedAt;
    topology[route.id] = {geometryUrl: route.geometryUrl, sha256: route.sha256, geometryFingerprint: geometryFingerprint(route.parts), checkedAt: route.checkedAt,
      ...(retrievedAt ? {geometryRetrievedAt: retrievedAt} : {}), quality: 'reference_geometry', accessStatus: route.accessStatus || 'unknown', partCount: route.parts.length,
      componentCount, lengthM: roundM(edges.reduce((sum, edge) => sum + edge[2], 0)), invalidPositions: route.invalidPositions, nodes, edges};
  });
  const provenance = source.map(route => ({id: route.id, geometryUrl: route.geometryUrl, sha256: route.sha256, checkedAt: route.checkedAt, accessStatus: route.accessStatus || 'unknown'}));
  return {schemaVersion: 1, sourceDigest: digest(JSON.stringify({schemaVersion: 1, parameters: {nearbyMeters, coordinateJoin: 'exact', crossingPolicy: 'review_only'}, provenance, topology, connections})),
    parameters: {nearbyMeters, coordinateJoin: 'exact', crossingPolicy: 'review_only'}, stats: {catalogueRoutes, geometryRoutes: routes.length, missingGeometryRoutes: catalogueRoutes - routes.length, connections: connections.length}, routes: topology, connections};
}

export async function readCatalogueInputs() {
  const require = createRequire(resolve(web, 'package.json')), ts = require('typescript');
  const source = await readFile(resolve(web, 'lib/content.ts'), 'utf8');
  const catalogueModule = {exports: {}}, imports = new Map();
  const tree = ts.createSourceFile('content.ts', source, ts.ScriptTarget.Latest, true);
  for (const node of tree.statements) if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
    const id = node.moduleSpecifier.text;
    if (!id.endsWith('.json')) throw new Error(`Unexpected catalogue runtime import: ${id}`);
    const path = id.startsWith('@/') ? resolve(web, id.slice(2)) : resolve(web, 'lib', id);
    if (!path.startsWith(web + sep)) throw new Error('Catalogue import escaped web.');
    imports.set(id, JSON.parse(await readFile(path, 'utf8')));
  }
  const code = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true}}).outputText;
  new Function('require', 'module', 'exports', code)(id => {if (!imports.has(id)) throw new Error('Unexpected catalogue import.'); return imports.get(id);}, catalogueModule, catalogueModule.exports);
  const trails = catalogueModule.exports.trails;
  const inputs = await Promise.all(trails.filter(trail => trail.geometryUrl).map(async trail => {
    const path = resolve(web, 'public', trail.geometryUrl.slice(1));
    if (!path.startsWith(resolve(web, 'public/data') + sep)) throw new Error('Route geometry escaped the public data directory.');
    const bytes = await readFile(path);
    return {id: trail.id, geometryUrl: trail.geometryUrl, checkedAt: trail.checkedAt, accessStatus: trail.accessStatus, sha256: digest(bytes), geometry: JSON.parse(bytes)};
  }));
  return {trails, inputs};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {trails, inputs} = await readCatalogueInputs();
  const index = buildTrailConnectionIndex(inputs, {catalogueRoutes: trails.length});
  const text = JSON.stringify(index) + '\n', output = resolve(web, 'lib/trail-connections.generated.json');
  if (process.argv.includes('--check')) {
    if (await readFile(output, 'utf8') !== text) throw new Error('The checked-in trail connection index is stale. Rebuild it.');
  } else await writeFile(output, text);
  console.log(JSON.stringify({...index.stats, bytes: Buffer.byteLength(text), sourceDigest: index.sourceDigest, relations: Object.fromEntries(['shared', 'intersection', 'nearby'].map(kind => [kind, index.connections.filter(connection => connection.kind === kind).length]))}, null, 2));
}
