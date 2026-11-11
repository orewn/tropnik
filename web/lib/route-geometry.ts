import type * as GeoJSON from 'geojson';
type ObjectValue = Record<string, unknown>;
export const RENDERED_TRAIL_ID = '__tropnikTrailId';
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const position = (value: unknown): boolean => Array.isArray(value) && value.length >= 2 && value.every(item => typeof item === 'number' && Number.isFinite(item));

function coordinates(value: unknown, depth: number): boolean {
  if (depth === 0) return position(value);
  return Array.isArray(value) && value.every(item => coordinates(item, depth - 1));
}
function geometry(value: unknown, depth = 0): boolean {
  if (!object(value) || depth > 16) return false;
  switch (value.type) {
    case 'Point': return coordinates(value.coordinates, 0);
    case 'MultiPoint':
    case 'LineString': return coordinates(value.coordinates, 1);
    case 'MultiLineString':
    case 'Polygon': return coordinates(value.coordinates, 2);
    case 'MultiPolygon': return coordinates(value.coordinates, 3);
    case 'GeometryCollection': return Array.isArray(value.geometries) && value.geometries.every(item => geometry(item, depth + 1));
    default: return false;
  }
}
function feature(value: unknown): boolean {
  return object(value) && value.type === 'Feature' && (value.geometry === null || geometry(value.geometry)) &&
    (value.properties === undefined || value.properties === null || object(value.properties));
}

/** One checked boundary for static GeoJSON and the API's data.geometry
 * envelope. Retains coordinates and properties by reference, with no cloned
 * vertex array and no reordering/simplification of the source track. */
export function readRouteGeometry(payload: unknown): GeoJSON.GeoJSON {
  const value = object(payload) && object(payload.data) && 'geometry' in payload.data ? payload.data.geometry : payload;
  if (!object(value)) throw new Error('Invalid route geometry');
  const valid = value.type === 'FeatureCollection' ? Array.isArray(value.features) && value.features.every(feature)
    : value.type === 'Feature' ? feature(value) : geometry(value);
  if (!valid) throw new Error('Invalid route geometry');
  return value as unknown as GeoJSON.GeoJSON;
}

/** Tag the actual SDK feature batch, including while setData is still being
 * processed by its worker. Preserve source geometry and vertex references. */
export function identifyRouteGeometry(data: GeoJSON.GeoJSON, trailId: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = data.type === 'FeatureCollection' ? data.features
    : data.type === 'Feature' ? [data] : [{type: 'Feature', properties: {}, geometry: data}];
  return {
    ...(data.type === 'FeatureCollection' ? data : {type: 'FeatureCollection' as const}),
    features: features.map(feature => ({...feature, properties: {...feature.properties, [RENDERED_TRAIL_ID]: trailId}})),
  };
}

/** Collect references only: bounds computation may make two passes, but does
 * not need a newly allocated [lng,lat] array for every original vertex. */
export function routeGeometryPositions(data: GeoJSON.GeoJSON): GeoJSON.Position[] {
  const result: GeoJSON.Position[] = [];
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') result.push(value as GeoJSON.Position);
    else for (const part of value) walk(part);
  };
  const visit = (value: GeoJSON.GeoJSON | null): void => {
    if (!value) return;
    if (value.type === 'FeatureCollection') for (const part of value.features) visit(part);
    else if (value.type === 'Feature') visit(value.geometry);
    else if (value.type === 'GeometryCollection') for (const part of value.geometries) visit(part);
    else walk(value.coordinates);
  };
  visit(data);
  return result;
}
