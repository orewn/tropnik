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
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (onSegment(x, y, a, b)) return true;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Coverage is cartographic, not evidence of access, trail safety or legal permission. */
export function inRussiaCoverage(lng, lat, area) {
  const x = russiaLongitude(lng);
  if (!Number.isFinite(x) || !Number.isFinite(lat)) return false;
  const geometry = value => {
    if (!value) return false;
    if (value.type === 'FeatureCollection') return value.features.some(geometry);
    if (value.type === 'Feature') return geometry(value.geometry);
    if (value.type === 'GeometryCollection') return value.geometries.some(geometry);
    const polygons = value.type === 'Polygon' ? [value.coordinates] : value.type === 'MultiPolygon' ? value.coordinates : [];
    return polygons.some(rings => inRing(x, lat, rings[0]) && !rings.slice(1).some(ring => inRing(x, lat, ring)));
  };
  return geometry(area);
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
