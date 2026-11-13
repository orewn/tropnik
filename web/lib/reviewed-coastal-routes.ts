import type * as GeoJSON from 'geojson';
import {readRouteGeometry} from './route-geometry.ts';

/** One reviewed disagreement between an official walking track and the land
 * shoreline. This is not a buffer, a country-boundary change, or a permission
 * for other official/database routes to paint outside the display mask. */
export const REVIEWED_COASTAL_SOURCES = Object.freeze([Object.freeze({
  key: 'routes/kolyma-black-creek.geojson',
  sourceUrl: 'https://greatkolymatrail.ru/upload/iblock/bc2/7jp03f3v0yqp8z36gjiz4o3ahdhkyxu2/1601848705912.gpx',
  descriptionUrl: 'https://greatkolymatrail.ru/routes/chernyy-klyuch/',
  rawGpxSha256: '5acdd2bd5a08d5f13f680f5d398d24f2822d3c3fe15bbcce10f2acce5f209cda',
  // The rendered GeoJSON is a separate, deterministic conversion of the GPX.
  sourceSha256: 'de9dcb7a128b037e8000558efc83c926ac3e581473b62e41fdb725c73dddc46b',
  coordinateSha256: '378fd342c7fe68801764c6edb440d8e355730c6271409ab74d164577a4b402d3',
  reviewedAt: '2026-11-13',
  measuredMaximumShorelineDisagreementM: 32.22,
  originalParts: 1,
  originalPoints: 788,
})]);
const DATA_ROOT = '/data/';

export function reviewedCoastalSource(key: string, sourceSha256?: string) {
  return REVIEWED_COASTAL_SOURCES.find(source => source.key === key && (sourceSha256 === undefined || sourceSha256 === source.sourceSha256));
}

export type ReviewedCoastalAllowance = Readonly<{
  key: string;
  sourceGeometry: GeoJSON.GeoJSON;
  geometry: GeoJSON.MultiLineString;
  bounds: readonly [number, number, number, number];
  coordinateSha256: string;
}>;
const issued = new WeakSet<ReviewedCoastalAllowance>();

export function isReviewedCoastalAllowance(value: ReviewedCoastalAllowance | undefined, sourceGeometry?: GeoJSON.GeoJSON): value is ReviewedCoastalAllowance {
  return !!value && issued.has(value) && (sourceGeometry === undefined || value.sourceGeometry === sourceGeometry);
}

/** Copy the measured lines before the asynchronous digest. The issued token
 * owns an immutable snapshot, so later caller mutations cannot enlarge the
 * reviewed exception. Non-line objects fail closed instead of being ignored. */
export async function verifyReviewedCoastalRoute(url: string | undefined, data: GeoJSON.GeoJSON): Promise<ReviewedCoastalAllowance | undefined> {
  const source = REVIEWED_COASTAL_SOURCES.find(item => url === DATA_ROOT + item.key);
  if (!source || !globalThis.crypto?.subtle) return;
  const lines: GeoJSON.Position[][] = [];
  let valid = true;
  const visit = (value: GeoJSON.GeoJSON | null): void => {
    if (!value) return;
    if (value.type === 'FeatureCollection') value.features.forEach(visit);
    else if (value.type === 'Feature') visit(value.geometry);
    else if (value.type === 'GeometryCollection') value.geometries.forEach(visit);
    else if (value.type === 'LineString') lines.push(value.coordinates.map(point => [...point]));
    else if (value.type === 'MultiLineString') value.coordinates.forEach(line => lines.push(line.map(point => [...point])));
    else valid = false;
  };
  try {visit(readRouteGeometry(data));} catch {return;}
  if (!valid || lines.length !== source.originalParts || lines.reduce((sum, line) => sum + line.length, 0) !== source.originalPoints) return;
  const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(lines))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== source.coordinateSha256) return;
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const line of lines) {let reference = 105; for (const point of line) {
    const longitude = point[0] + 360 * Math.round((reference - point[0]) / 360); reference = longitude;
    bounds[0] = Math.min(bounds[0], longitude); bounds[1] = Math.min(bounds[1], point[1]); bounds[2] = Math.max(bounds[2], longitude); bounds[3] = Math.max(bounds[3], point[1]);
  }} Object.freeze(bounds);
  for (const line of lines) {for (const point of line) Object.freeze(point); Object.freeze(line);} Object.freeze(lines);
  const geometry = Object.freeze({type: 'MultiLineString' as const, coordinates: lines});
  const allowance = Object.freeze({key: source.key, sourceGeometry: data, geometry, bounds, coordinateSha256: digest});
  issued.add(allowance); return allowance;
}
