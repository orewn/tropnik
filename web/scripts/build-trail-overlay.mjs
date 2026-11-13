import {createHash} from 'node:crypto';
import {readFile, writeFile, unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readCatalogueInputs} from './build-trail-connections.mjs';
import {readRouteGeometry} from '../lib/route-geometry.ts';
import {encodeOverlayLine, trailOverlayParts, TRAIL_OVERLAY_ERROR_PX, TRAIL_OVERLAY_ZOOMS} from '../lib/map-trail-overlay.ts';
import {reviewedCoastalSource} from '../lib/reviewed-coastal-routes.ts';

const web = resolve(import.meta.dirname, '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const project = line => {
  let reference = 105;
  return line.map(point => {
    const longitude = point[0] + 360 * Math.round((reference - point[0]) / 360); reference = longitude;
    return [(longitude + 180) / 360, (1 - Math.asinh(Math.tan(point[1] * Math.PI / 180)) / Math.PI) / 2];
  });
};
const squareDistance = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denominator)) : 0;
  return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
};

/** Display simplification with a measurable Mercator pixel bound. It selects
 * original vertices in original order; endpoints, short rings and every
 * MultiLineString component remain present. Raw selected tracks stay intact. */
export function simplifyOverlayLine(line, zoom, errorPx = TRAIL_OVERLAY_ERROR_PX) {
  if (line.length <= 2) return line;
  const points = project(line), tolerance = (errorPx / (256 * 2 ** zoom)) ** 2, keep = new Set([0, line.length - 1]);
  const closed = points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1];
  if (closed) {
    let farthest = 0;
    for (let index = 1; index < points.length - 1; index++) if (squareDistance(points[index], points[0], points[0]) > squareDistance(points[farthest], points[0], points[0])) farthest = index;
    keep.add(farthest); let widest = farthest;
    for (let index = 1; index < points.length - 1; index++) if (squareDistance(points[index], points[0], points[farthest]) > squareDistance(points[widest], points[0], points[farthest])) widest = index;
    keep.add(widest);
  }
  const anchors = [...keep].sort((a, b) => a - b), pending = anchors.slice(1).map((last, index) => [anchors[index], last]);
  while (pending.length) {
    const [first, last] = pending.pop(); let maximum = tolerance, selected = -1;
    for (let index = first + 1; index < last; index++) {
      const value = squareDistance(points[index], points[first], points[last]);
      if (value > maximum) {maximum = value; selected = index;}
    }
    if (selected >= 0) {keep.add(selected); pending.push([first, selected], [selected, last]);}
  }
  return [...keep].sort((a, b) => a - b).map(index => line[index]);
}

export function buildTrailOverlay(inputs, catalogueRoutes = inputs.length) {
  const grouped = new Map();
  for (const input of [...inputs].sort((a, b) => a.id.localeCompare(b.id))) {
    const previous = grouped.get(input.geometryUrl);
    if (previous) {
      if (previous.sha256 !== input.sha256) throw new Error('Conflicting geometry source');
      previous.ids.push(input.id); continue;
    }
    const raw = trailOverlayParts(readRouteGeometry(input.geometry));
    if (!raw.length) throw new Error(`No source lines for ${input.id}`);
    const bounds = raw.reduce((box, part) => [Math.min(box[0], part.bounds[0]), Math.min(box[1], part.bounds[1]), Math.max(box[2], part.bounds[2]), Math.max(box[3], part.bounds[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    if(!input.geometryUrl.startsWith('/data/'))throw new Error('Unexpected source geometry path');
    const coastal=reviewedCoastalSource(input.geometryUrl.slice('/data/'.length));
    if(coastal&&coastal.sourceSha256!==input.sha256)throw new Error('A reviewed coastal source changed; review its coordinates and shoreline evidence before updating the allowance');
    grouped.set(input.geometryUrl, {key: input.geometryUrl.slice('/data/'.length), ids: [input.id], sha256: input.sha256, bounds, points: raw.reduce((sum, part) => sum + part.coordinates.length, 0),
      parts: raw.map(part => [part.bounds, ...TRAIL_OVERLAY_ZOOMS.map(zoom => encodeOverlayLine(simplifyOverlayLine(part.coordinates, zoom)))])});
  }
  const sources = [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key));
  return {version: 1, sourceDigest: digest(JSON.stringify(sources.map(source => [source.key, source.ids, source.sha256]))), catalogueRoutes, geometryRoutes: inputs.length, sources};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {trails, inputs} = await readCatalogueInputs(), data = buildTrailOverlay(inputs, trails.length), bytes = JSON.stringify(data) + '\n';
  if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('Trail overview exceeds the shared resource budget');
  const sha256 = digest(bytes), url = `/data/trail-overlay-${sha256.slice(0, 16)}.json`;
  const metadata = {version: 1, url, sha256, sourceDigest: data.sourceDigest, sourceHashes: Object.fromEntries(data.sources.map(source => [source.key, source.sha256])), catalogueRoutes: trails.length, geometryRoutes: inputs.length, uniqueGeometries: data.sources.length,
    sourceParts: data.sources.reduce((sum, source) => sum + source.parts.length, 0), sourcePoints: data.sources.reduce((sum, source) => sum + source.points, 0), bytes: Buffer.byteLength(bytes), levels: TRAIL_OVERLAY_ZOOMS.map(maxZoom => ({maxZoom, maxErrorPx: TRAIL_OVERLAY_ERROR_PX})), coordinateEncoding: 'lossless-polyline7', missingGeometryInvented: false};
  const metadataPath = resolve(web, 'lib/trail-overlay.generated.json'), metadataBytes = JSON.stringify(metadata, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(metadataPath, 'utf8') !== metadataBytes || await readFile(resolve(web, 'public', url.slice(1)), 'utf8') !== bytes) throw new Error('Trail overview is stale; run build-trail-overlay.mjs');
  } else {
    const old = await readFile(metadataPath, 'utf8').then(JSON.parse).catch(() => null);
    await writeFile(resolve(web, 'public', url.slice(1)), bytes); await writeFile(metadataPath, metadataBytes);
    if (old?.url !== url && /^\/data\/trail-overlay-[a-f0-9]{16}\.json$/.test(old?.url ?? '')) await unlink(resolve(web, 'public', old.url.slice(1))).catch(() => {});
  }
  const {sourceHashes, ...summary} = metadata;
  console.log(JSON.stringify({...summary, sourceHashEntries: Object.keys(sourceHashes).length}));
}
