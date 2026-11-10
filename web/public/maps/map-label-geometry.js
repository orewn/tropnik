import {inRussiaCoverage, russiaLongitude} from './russia-viewport.js';

// Match the sourced coverage predicate's boundary tolerance. The index only
// excludes impossible edge candidates; it never simplifies country geometry.
const EPSILON = 1e-10;
const indexes = new WeakMap();
const projections = new WeakMap();
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const mercatorLatitude = latitude => Math.asinh(Math.tan(latitude * Math.PI / 180)) * 180 / Math.PI;

function position(value) {
  if (!Array.isArray(value) || value.length < 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1])
    || value[1] < -90 || value[1] > 90) return null;
  return [russiaLongitude(value[0]), value[1]];
}

/** Validate once and keep a second exact planar view of the same rings. A
 * MapLibre segment is straight in Mercator, not in latitude. Keeping x in
 * longitude degrees and y in Mercator degrees lets the existing indexed
 * point predicate operate in that plane without changing shared coverage. */
function coverageProjection(area) {
  if (projections.has(area)) return projections.get(area);
  const active = new WeakSet();
  const projectRing = ring => {
    if (!Array.isArray(ring) || ring.length < 4) return null;
    const output = [];
    for (const value of ring) {
      if (!Array.isArray(value) || value.length < 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || value[1] <= -90 || value[1] >= 90) return null;
      output.push([value[0], mercatorLatitude(value[1])]);
    }
    const first = ring[0], last = ring[ring.length - 1];
    return first[0] === last[0] && first[1] === last[1] ? output : null;
  };
  const mapAll = (values, mapper) => {
    if (!Array.isArray(values) || values.length === 0) return null;
    const output = [];
    for (const value of values) {const mapped = mapper(value); if (!mapped) return null; output.push(mapped);}
    return output;
  };
  const visit = value => {
    if (!value || typeof value !== 'object' || active.has(value)) return null;
    active.add(value);
    let result = null;
    if (value.type === 'Polygon') {
      const coordinates = mapAll(value.coordinates, projectRing);
      if (coordinates) result = {type: 'Polygon', coordinates};
    } else if (value.type === 'MultiPolygon') {
      const coordinates = mapAll(value.coordinates, polygon => mapAll(polygon, projectRing));
      if (coordinates) result = {type: 'MultiPolygon', coordinates};
    } else if (value.type === 'Feature') {
      const geometry = visit(value.geometry);
      if (geometry) result = {type: 'Feature', properties: {}, geometry};
    } else if (value.type === 'FeatureCollection') {
      const features = mapAll(value.features, visit);
      if (features) result = {type: 'FeatureCollection', features};
    } else if (value.type === 'GeometryCollection') {
      const geometries = mapAll(value.geometries, visit);
      if (geometries) result = {type: 'GeometryCollection', geometries};
    }
    active.delete(value);
    return result;
  };
  let projection;
  try {projection = visit(area);} catch {projection = null;}
  projections.set(area, projection);
  return projection;
}

function edgeIndex(area) {
  let cached = indexes.get(area);
  if (cached) return cached;
  const edges = [];
  const ring = coordinates => {
    if (!Array.isArray(coordinates)) return;
    for (let index = 0, previous = coordinates.length - 1; index < coordinates.length; previous = index++) {
      const a = coordinates[previous], b = coordinates[index];
      if (!a || !b || ![a[0], a[1], b[0], b[1]].every(Number.isFinite) || a[0] === b[0] && a[1] === b[1]) continue;
      edges.push({a, b, west: Math.min(a[0], b[0]), east: Math.max(a[0], b[0]), south: Math.min(a[1], b[1]), north: Math.max(a[1], b[1])});
    }
  };
  const visit = value => {
    if (!value) return;
    if (value.type === 'FeatureCollection') {value.features.forEach(visit); return;}
    if (value.type === 'Feature') {visit(value.geometry); return;}
    if (value.type === 'GeometryCollection') {value.geometries.forEach(visit); return;}
    const polygons = value.type === 'Polygon' ? [value.coordinates] : value.type === 'MultiPolygon' ? value.coordinates : [];
    for (const polygon of polygons) for (const coordinates of polygon) ring(coordinates);
  };
  visit(area);
  const south = edges.reduce((value, edge) => Math.min(value, edge.south), Infinity);
  const north = edges.reduce((value, edge) => Math.max(value, edge.north), -Infinity);
  const count = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(edges.length) * 2)));
  const scale = north > south ? count / (north - south) : 0;
  const bucket = latitude => clamp(Math.floor((latitude - south) * scale), 0, count - 1);
  const buckets = Array.from({length: count}, () => []);
  for (const [index, edge] of edges.entries()) {
    for (let row = bucket(edge.south - EPSILON); row <= bucket(edge.north + EPSILON); row++) buckets[row].push(index);
  }
  cached = {edges, buckets, bucket};
  indexes.set(area, cached);
  return cached;
}

/** Split a segment at every genuine boundary intersection, including a
 * collinear boundary overlap. Sampling one midpoint or only the vertices
 * would miss a narrow bay/hole between two covered endpoints. */
function intersections(a, b, edge, parameters) {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = edge.b[0] - edge.a[0], sy = edge.b[1] - edge.a[1];
  const qx = edge.a[0] - a[0], qy = edge.a[1] - a[1];
  const denominator = cross(rx, ry, sx, sy);
  if (denominator !== 0) {
    const t = cross(qx, qy, sx, sy) / denominator;
    const u = cross(qx, qy, rx, ry) / denominator;
    const tolerance = 64 * Number.EPSILON;
    if (t >= -tolerance && t <= 1 + tolerance && u >= -tolerance && u <= 1 + tolerance) parameters.push(clamp(t, 0, 1));
    return;
  }
  if (Math.abs(cross(qx, qy, rx, ry)) > EPSILON) return;
  const component = Math.abs(rx) >= Math.abs(ry) ? 0 : 1;
  const delta = b[component] - a[component];
  const first = (edge.a[component] - a[component]) / delta;
  const last = (edge.b[component] - a[component]) / delta;
  const start = Math.max(0, Math.min(first, last)), end = Math.min(1, Math.max(first, last));
  if (start <= end) parameters.push(start, end);
}

function coveredSegment(a, b, area, index) {
  if (a[0] === b[0] && a[1] === b[1]) return true;
  const west = Math.min(a[0], b[0]), east = Math.max(a[0], b[0]);
  const south = Math.min(a[1], b[1]), north = Math.max(a[1], b[1]);
  const parameters = [0, 1], seen = new Set();
  for (let row = index.bucket(south - EPSILON); row <= index.bucket(north + EPSILON); row++) {
    for (const id of index.buckets[row]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const edge = index.edges[id];
      if (edge.east < west - EPSILON || edge.west > east + EPSILON || edge.north < south - EPSILON || edge.south > north + EPSILON) continue;
      intersections(a, b, edge, parameters);
    }
  }
  if (parameters.length === 2) return true;
  parameters.sort((x, y) => x - y);
  const inside = t => inRussiaCoverage(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, area);
  let previous = 0;
  for (const current of parameters) {
    // Check the boundary point as well: a line merely touching a hole is not
    // covered. Outer edges retain inRussiaCoverage's inclusive convention.
    if (!inside(current) || current > previous && !inside((previous + current) / 2)) return false;
    previous = current;
  }
  return true;
}

function coveredLine(coordinates, area, projectedArea) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
  const points = [];
  for (const coordinate of coordinates) {
    const point = position(coordinate);
    if (!point || !inRussiaCoverage(point[0], point[1], area)) return false;
    const projected = [point[0], mercatorLatitude(point[1])];
    if (!inRussiaCoverage(projected[0], projected[1], projectedArea)) return false;
    points.push(projected);
  }
  const index = edgeIndex(projectedArea);
  for (let point = 1; point < points.length; point++) if (!coveredSegment(points[point - 1], points[point], projectedArea, index)) return false;
  return true;
}

/** Whole source geometry eligibility for the MapLibre labels overlay. `area`
 * is the immutable display-space RF coverage (19…191°, not canonical rings).
 * Point anchors and every segment of a line must be covered. We cannot infer
 * a safe label anchor for polygon/unknown geometries, so those fail closed.
 * Longitudes are normalized without moving or mutating the source geometry. */
export function labelGeometryInCoverage(geometry, area) {
  if (!geometry || !area || typeof area !== 'object') return false;
  const projectedArea = coverageProjection(area);
  if (!projectedArea) return false;
  const point = value => {
    const coordinate = position(value);
    return !!coordinate && inRussiaCoverage(coordinate[0], coordinate[1], area)
      && inRussiaCoverage(coordinate[0], mercatorLatitude(coordinate[1]), projectedArea);
  };
  const all = (values, predicate) => {
    if (!Array.isArray(values) || values.length === 0) return false;
    for (const value of values) if (!predicate(value)) return false;
    return true;
  };
  switch (geometry.type) {
    case 'Point': return point(geometry.coordinates);
    case 'MultiPoint': return all(geometry.coordinates, point);
    case 'LineString': return coveredLine(geometry.coordinates, area, projectedArea);
    case 'MultiLineString': return all(geometry.coordinates, line => coveredLine(line, area, projectedArea));
    default: return false;
  }
}
