/** Display coordinates follow the pinned, sourced coverage in /data/russia-boundaries-provenance.json. */
export const RUSSIA_BOUNDS = [[19.6389282, 41.1858711], [191.0026658, 81.858721]];
export const RUSSIA_AREA_URL = '/data/russia-display-area.geojson';
export const RUSSIA_MASK_URL = '/data/russia-outside-mask.geojson';
export const RUSSIA_CANONICAL_MASK_URL = '/data/russia-canonical-mask.geojson';
export const MAP_OUTSIDE_COLOR = '#e7ebe2';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mercatorY = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
const latitude = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;

/** Put eastern Chukotka beside the rest of the country, across the antimeridian. */
export function russiaLongitude(lng) {
  if (!Number.isFinite(lng)) return NaN;
  return lng + 360 * Math.round((105 - lng) / 360);
}

export function russiaPadding(width, height, coveredBottom = 0) {
  const narrow = width < 700;
  const top = Math.min(narrow ? 88 : 96, height * .2);
  const bottom = Math.min(Math.max(narrow ? 64 : 96, coveredBottom + 24), Math.max(0, height - top - 96));
  return {top, bottom, left: narrow ? 24 : 40, right: narrow ? 80 : 88};
}

/** Independent of the renderer's world-height clamp, so portrait screens can show all of Russia. */
export function russiaCamera(width, height, padding = russiaPadding(width, height), tileSize = 512) {
  const [[west, south], [east, north]] = RUSSIA_BOUNDS;
  const usableWidth = Math.max(32, width - padding.left - padding.right);
  const usableHeight = Math.max(32, height - padding.top - padding.bottom);
  const dx = (east - west) / 360, dy = mercatorY(south) - mercatorY(north);
  const zoom = Math.log2(Math.min(usableWidth / (tileSize * dx), usableHeight / (tileSize * dy)));
  const world = tileSize * 2 ** zoom;
  const lng = (west + east) / 2 + (padding.right - padding.left) * 180 / world;
  const y = (mercatorY(south) + mercatorY(north)) / 2 + (padding.bottom - padding.top) / (2 * world);
  return {center: [lng, latitude(y)], zoom, pitch: 0, bearing: 0};
}

/** Restrict the camera centre without forcing the complete viewport into a narrow bounding rectangle. */
export function constrainRussiaCamera(lng, lat, zoom, overview) {
  const [[west, south], [east, north]] = RUSSIA_BOUNDS;
  // At the full overview a covered mobile viewport needs an offset centre.
  // Once zoomed in, converge to the geographic bounds instead of allowing blank distant panning.
  const overviewAllowance=clamp(1-(zoom-overview.zoom)/2,0,1);
  const southLimit=south+Math.min(0,overview.center[1]-south)*overviewAllowance;
  const northLimit=north+Math.max(0,overview.center[1]-north)*overviewAllowance;
  return {
    center: [clamp(russiaLongitude(lng), Math.min(west, overview.center[0]), Math.max(east, overview.center[0])),
      clamp(lat,southLimit,northLimit)],
    zoom: clamp(zoom, Math.min(overview.zoom, 18), 18),
  };
}

/** Convert a canonical polygon/route into the same continuous longitude space as the overview. */
export function displayGeoJSON(value) {
  const mapCoordinates = value => Array.isArray(value)
    ? typeof value[0] === 'number' ? [russiaLongitude(value[0]), ...value.slice(1)] : value.map(mapCoordinates)
    : value;
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'FeatureCollection') return {...value, features: value.features.map(displayGeoJSON)};
  if (value.type === 'Feature') return {...value, geometry: displayGeoJSON(value.geometry)};
  if (value.type === 'GeometryCollection') return {...value, geometries: value.geometries.map(displayGeoJSON)};
  return {...value, coordinates: mapCoordinates(value.coordinates)};
}

function onSegment(x, y, a, b) {
  const cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
  return Math.abs(cross) < 1e-10 && x >= Math.min(a[0], b[0]) - 1e-10 && x <= Math.max(a[0], b[0]) + 1e-10
    && y >= Math.min(a[1], b[1]) - 1e-10 && y <= Math.max(a[1], b[1]) + 1e-10;
}
const COVERAGE_EPSILON = 1e-10;
const coverageIndexes = new WeakMap();
const inBounds = (x, y, bounds) => x >= bounds[0] - COVERAGE_EPSILON && x <= bounds[2] + COVERAGE_EPSILON
  && y >= bounds[1] - COVERAGE_EPSILON && y <= bounds[3] + COVERAGE_EPSILON;

function ringIndex(points) {
  if (!points.length) return null;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
  }
  const count = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(points.length) * 2)));
  const scale = bounds[3] > bounds[1] ? count / (bounds[3] - bounds[1]) : 0;
  const bucket = y => clamp(Math.floor((y - bounds[1]) * scale), 0, count - 1);
  const buckets = Array.from({length: count}, () => []);
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const low = bucket(Math.min(points[i][1], points[j][1]) - COVERAGE_EPSILON);
    const high = bucket(Math.max(points[i][1], points[j][1]) + COVERAGE_EPSILON);
    for (let row = low; row <= high; row++) buckets[row].push(i);
  }
  return {points, bounds, buckets, bucket};
}

function inIndexedRing(x, y, ring) {
  if (!ring || !inBounds(x, y, ring.bounds)) return false;
  let inside = false;
  for (const i of ring.buckets[ring.bucket(y)]) {
    const a = ring.points[i], b = ring.points[i === 0 ? ring.points.length - 1 : i - 1];
    if (y < Math.min(a[1], b[1]) - COVERAGE_EPSILON || y > Math.max(a[1], b[1]) + COVERAGE_EPSILON
      || x > Math.max(a[0], b[0]) + COVERAGE_EPSILON) continue;
    const crosses = (a[1] > y) !== (b[1] > y);
    if (x < Math.min(a[0], b[0]) - COVERAGE_EPSILON) {if (crosses) inside = !inside; continue;}
    if (onSegment(x, y, a, b)) return true;
    if (crosses && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** The immutable, fetched coverage is indexed once. Latitude buckets only
 * discard edges that cannot intersect the query ray; the exact boundary and
 * hole checks remain unchanged. Dense route fitting must not rescan all
 * 46,000+ country vertices for every route vertex on the UI thread. */
function coverageIndex(area) {
  const polygons = [];
  const visit = value => {
    if (!value) return;
    if (value.type === 'FeatureCollection') {value.features.forEach(visit); return;}
    if (value.type === 'Feature') {visit(value.geometry); return;}
    if (value.type === 'GeometryCollection') {value.geometries.forEach(visit); return;}
    for (const rings of value.type === 'Polygon' ? [value.coordinates] : value.type === 'MultiPolygon' ? value.coordinates : []) {
      const outer = ringIndex(rings[0] || []);
      if (outer) polygons.push({outer, holes: rings.slice(1).map(ringIndex).filter(Boolean)});
    }
  };
  visit(area);
  if (!polygons.length) return {polygons, buckets: []};
  const south = Math.min(...polygons.map(polygon => polygon.outer.bounds[1]));
  const north = Math.max(...polygons.map(polygon => polygon.outer.bounds[3]));
  const count = 256, scale = north > south ? count / (north - south) : 0;
  const bucket = y => clamp(Math.floor((y - south) * scale), 0, count - 1);
  const buckets = Array.from({length: count}, () => []);
  for (const polygon of polygons) {
    const low = bucket(polygon.outer.bounds[1] - COVERAGE_EPSILON), high = bucket(polygon.outer.bounds[3] + COVERAGE_EPSILON);
    for (let row = low; row <= high; row++) buckets[row].push(polygon);
  }
  return {south, north, bucket, buckets};
}

/** Coverage is cartographic, not evidence of access, trail safety or legal permission.
 * Pass a new geometry object if replacing the pinned coverage snapshot. */
export function inRussiaCoverage(lng, lat, area) {
  const x = russiaLongitude(lng);
  if (!Number.isFinite(x) || !Number.isFinite(lat) || !area || typeof area !== 'object') return false;
  let index = coverageIndexes.get(area);
  if (!index) {index = coverageIndex(area); coverageIndexes.set(area, index);}
  if (!index.buckets.length || lat < index.south - COVERAGE_EPSILON || lat > index.north + COVERAGE_EPSILON) return false;
  return index.buckets[index.bucket(lat)].some(polygon => inIndexedRing(x, lat, polygon.outer)
    && !polygon.holes.some(ring => inIndexedRing(x, lat, ring)));
}

/** Exact camera bounds of covered vertices. If the four extrema are covered,
 * no other vertex can change the answer, so dense in-country tracks need only
 * four polygon queries. Otherwise test only candidates that can expand the
 * already verified bounds; the rendered route itself is never simplified. */
export function coveredRussiaBounds(positions, area) {
  let extent = null;
  const extrema = [];
  for (const point of positions) {
    const x = russiaLongitude(point[0]), y = point[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!extent) {extent = [x, y, x, y]; extrema.push([x, y], [x, y], [x, y], [x, y]);}
    else {
      if (x < extent[0]) {extent[0] = x; extrema[0] = [x, y];}
      if (y < extent[1]) {extent[1] = y; extrema[1] = [x, y];}
      if (x > extent[2]) {extent[2] = x; extrema[2] = [x, y];}
      if (y > extent[3]) {extent[3] = y; extrema[3] = [x, y];}
    }
  }
  if (!extent) return null;
  const verified = extrema.filter(point => inRussiaCoverage(point[0], point[1], area));
  if (verified.length === extrema.length) return extent;
  let bounds = null;
  const extend = (x, y) => {
    if (!bounds) bounds = [x, y, x, y];
    else {bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);}
  };
  for (const [x, y] of verified) extend(x, y);
  for (const point of positions) {
    const x = russiaLongitude(point[0]), y = point[1];
    if (!Number.isFinite(x) || !Number.isFinite(y) || bounds && x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3]) continue;
    if (inRussiaCoverage(x, y, area)) extend(x, y);
  }
  return bounds;
}

/** Leaflet does not repeat GeoJSON with raster/vector tiles. Cover the adjacent world copies explicitly. */
export function leafletRussiaMask(mask) {
  const shift = (value, offset) => {
    if (Array.isArray(value)) return typeof value[0] === 'number' ? [value[0] + offset, ...value.slice(1)] : value.map(v => shift(v, offset));
    return value;
  };
  const features = mask.type === 'FeatureCollection' ? mask.features : [mask.type === 'Feature' ? mask : {type: 'Feature', properties: {}, geometry: mask}];
  return {type: 'FeatureCollection', features: [-360, 0, 360].flatMap(offset => features.map(feature => ({...feature,
    geometry: {...feature.geometry, coordinates: shift(feature.geometry.coordinates, offset)}})))};
}
