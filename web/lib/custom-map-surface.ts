import type {TerrainGrid, TerrainCartography} from '../public/terrain/terrain-renderer.js';
import {decodeVectorTile, VECTOR_TILE_LIMITS} from './custom-map-vector.ts';
import {paintVectorTile} from './custom-map-painter.ts';

export const LANDSCAPE_SURFACE_SIZE = 1024;
export const LANDSCAPE_TILE_LIMIT = 16;
const TILE_SIZE = 512, CONCURRENCY = 3;
type Bounds = [number, number, number, number];
export type LandscapeTile = {z: number; x: number; y: number; worldX: number};
export type LandscapeTilePlan = {bounds: Bounds; zoom: number; tiles: LandscapeTile[]};
export type LandscapeRaster = {tile: LandscapeTile; width: number; height: number; pixels: Uint8ClampedArray};
export type LandscapeSurface = TerrainCartography & {source: {
  name: string; attribution: string; bounds: Bounds;
  projection: 'regular-longitude-latitude'; sampleLayout: 'grid-nodes';
  rowOrder: 'north-to-south'; columnOrder: 'west-to-east';
  tileZoom: number; requestedTiles: number; loadedTiles: number; localTiles: number; complete: boolean;
  tiles: Array<LandscapeTile & {url: string; local: boolean}>;
}};
type SurfaceOptions = {signal?: AbortSignal};
export type LandscapeSurfaceDependencies = {
  loadBytes: (url: string) => Promise<ArrayBuffer>;
  loadJSON: (url: string) => Promise<unknown>;
  paint: (bytes: ArrayBuffer, tile: LandscapeTile, signal?: AbortSignal) => Promise<Omit<LandscapeRaster, 'tile'>>;
  online?: () => boolean;
  yield?: () => Promise<void>;
};
const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const mercatorY = (latitude: number) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
const abortError = () => new DOMException('Landscape cartography cancelled', 'AbortError');
function checkAbort(signal?: AbortSignal) {if (signal?.aborted) throw abortError();}
function boundedBounds(bounds: readonly number[]): Bounds {
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3] ||
    bounds[2] - bounds[0] > 360 || bounds[1] < -85 || bounds[3] > 85 || Math.abs(bounds[0]) > 1e6 || Math.abs(bounds[2]) > 1e6) {
    throw new RangeError('Invalid landscape cartography bounds');
  }
  return [...bounds] as Bounds;
}

/** Highest source zoom whose entire continuous grid fits the request budget.
 * Only URL x is wrapped: worldX remains continuous across ±180 degrees. */
export function landscapeTilePlan(bounds: readonly number[]): LandscapeTilePlan {
  const b = boundedBounds(bounds);
  for (let zoom = 14; zoom >= 0; zoom--) {
    const n = 2 ** zoom;
    const x0 = Math.floor((b[0] + 180) / 360 * n), x1 = Math.ceil((b[2] + 180) / 360 * n) - 1;
    const y0 = clamp(Math.floor(mercatorY(b[3]) * n), 0, n - 1), y1 = clamp(Math.ceil(mercatorY(b[1]) * n) - 1, 0, n - 1);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > LANDSCAPE_TILE_LIMIT) continue;
    const tiles: LandscapeTile[] = [];
    for (let y = y0; y <= y1; y++) for (let worldX = x0; worldX <= x1; worldX++) tiles.push({z: zoom, x: ((worldX % n) + n) % n, y, worldX});
    if (!tiles.length) throw new RangeError('Landscape bounds are below numeric precision');
    return {bounds: b, zoom, tiles};
  }
  throw new RangeError('Landscape tile budget exceeded');
}

function rasterizer(plan: LandscapeTilePlan, rasters: LandscapeRaster[], width: number, height: number) {
  boundedBounds(plan.bounds);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 1024 || height > 1024 ||
    !Number.isInteger(plan.zoom) || plan.zoom < 0 || plan.zoom > 14 || !plan.tiles.length || plan.tiles.length > LANDSCAPE_TILE_LIMIT || rasters.length > plan.tiles.length) throw new RangeError('Landscape raster budget exceeded');
  const n = 2 ** plan.zoom, requested = new Set<string>();
  for (const t of plan.tiles) {
    const key = `${t.worldX}/${t.y}`;
    if (t.z !== plan.zoom || !Number.isSafeInteger(t.worldX) || !Number.isInteger(t.y) || t.y < 0 || t.y >= n || t.x !== ((t.worldX % n) + n) % n || requested.has(key)) throw new RangeError('Invalid landscape tile coordinates');
    requested.add(key);
  }
  const size = rasters[0]?.width || TILE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > TILE_SIZE) throw new RangeError('Invalid landscape source raster');
  const minX = Math.min(...plan.tiles.map(t => t.worldX)), maxX = Math.max(...plan.tiles.map(t => t.worldX));
  const minY = Math.min(...plan.tiles.map(t => t.y)), maxY = Math.max(...plan.tiles.map(t => t.y));
  if ((maxX - minX + 1) * (maxY - minY + 1) !== plan.tiles.length ||
    minX !== Math.floor((plan.bounds[0] + 180) / 360 * n) || maxX !== Math.ceil((plan.bounds[2] + 180) / 360 * n) - 1 ||
    minY !== Math.floor(mercatorY(plan.bounds[3]) * n) || maxY !== Math.ceil(mercatorY(plan.bounds[1]) * n) - 1) throw new RangeError('Landscape atlas does not cover grid bounds');
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (!rasters.length) return {pixels, rows: () => undefined};
  const atlasWidth = (maxX - minX + 1) * size, atlasHeight = (maxY - minY + 1) * size;
  const atlas = new Uint8ClampedArray(atlasWidth * atlasHeight * 4), seen = new Set<string>();
  for (const raster of rasters) {
    const t = raster.tile, key = `${t.worldX}/${t.y}`;
    if (seen.has(key) || !plan.tiles.some(tile => tile.worldX === t.worldX && tile.y === t.y && tile.z === t.z && tile.x === t.x) ||
      raster.width !== size || raster.height !== size || !(raster.pixels instanceof Uint8ClampedArray) || raster.pixels.length !== size * size * 4) {
      throw new RangeError('Invalid landscape source raster');
    }
    seen.add(key);
    for (let y = 0; y < size; y++) atlas.set(raster.pixels.subarray(y * size * 4, (y + 1) * size * 4),
      (((t.y - minY) * size + y) * atlasWidth + (t.worldX - minX) * size) * 4);
  }
  const xs = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const longitude = plan.bounds[0] + x / (width - 1) * (plan.bounds[2] - plan.bounds[0]);
    xs[x] = clamp(((longitude + 180) / 360 * n - minX) * size - .5, 0, atlasWidth - 1);
  }
  const rows = (start: number, end: number) => {
    for (let y = start; y < end; y++) {
      // DEM rows are equally spaced in latitude, not in Web Mercator y.
      const latitude = plan.bounds[3] - y / (height - 1) * (plan.bounds[3] - plan.bounds[1]);
      const sourceY = clamp((mercatorY(latitude) * n - minY) * size - .5, 0, atlasHeight - 1);
      const y0 = Math.floor(sourceY), y1 = Math.min(y0 + 1, atlasHeight - 1), fy = sourceY - y0;
      for (let x = 0; x < width; x++) {
        const sx = xs[x], x0 = Math.floor(sx), x1 = Math.min(x0 + 1, atlasWidth - 1), fx = sx - x0;
        const a = (y0 * atlasWidth + x0) * 4, b = (y0 * atlasWidth + x1) * 4;
        const c = (y1 * atlasWidth + x0) * 4, d = (y1 * atlasWidth + x1) * 4;
        const wa = (1 - fx) * (1 - fy) * atlas[a + 3], wb = fx * (1 - fy) * atlas[b + 3];
        const wc = (1 - fx) * fy * atlas[c + 3], wd = fx * fy * atlas[d + 3], alpha = wa + wb + wc + wd;
        const out = (y * width + x) * 4; pixels[out + 3] = alpha;
        // Missing tiles are transparent. Premultiplied interpolation avoids dark
        // borders or borrowing the colour of an unavailable neighbouring tile.
        if (alpha) for (let k = 0; k < 3; k++) pixels[out + k] = (atlas[a + k] * wa + atlas[b + k] * wb + atlas[c + k] * wc + atlas[d + k] * wd) / alpha;
      }
    }
  };
  return {pixels, rows};
}

/** Pure, bounded numeric resampling, also used to test latitude and dateline mapping. */
export function resampleLandscapeTiles(plan: LandscapeTilePlan, rasters: LandscapeRaster[], width = LANDSCAPE_SURFACE_SIZE, height = LANDSCAPE_SURFACE_SIZE) {
  const result = rasterizer(plan, rasters, width, height); result.rows(0, height); return result.pixels;
}

function cancellable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError()); signal.addEventListener('abort', abort, {once: true});
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Injectable source/painter boundary keeps the numeric projection independent of DOM
 * and permits a restricted native host to supply its packaged resource transport. */
export function createLandscapeSurfaceLoader(deps: LandscapeSurfaceDependencies) {
  return async (grid: TerrainGrid, {signal}: SurfaceOptions = {}): Promise<LandscapeSurface> => {
    checkAbort(signal);
    const plan = landscapeTilePlan(grid.bounds), rasters: LandscapeRaster[] = [];
    const sources: LandscapeSurface['source']['tiles'] = [];
    let files = new Set<string>();
    try {
      const manifest = await cancellable(deps.loadJSON('/offline-map/manifest.json'), signal) as {files?: Array<{path?: string}>};
      if (Array.isArray(manifest?.files) && manifest.files.length <= 100_000) files = new Set(manifest.files.map(f => f.path).filter((p): p is string => typeof p === 'string'));
    } catch {checkAbort(signal);}
    let next = 0, template: Promise<string> | undefined;
    const remoteTemplate = () => template ??= deps.loadJSON('https://tiles.openfreemap.org/planet/latest').then(value => {
      const url = (value as {tiles?: string[]})?.tiles?.[0];
      if (typeof url !== 'string' || !url.startsWith('https://tiles.openfreemap.org/') || !['{z}', '{x}', '{y}'].every(key => url.includes(key))) throw new Error('Unrecognized landscape vector source');
      return url;
    });
    const worker = async () => {
      while (next < plan.tiles.length) {
        checkAbort(signal); const tile = plan.tiles[next++], path = `localtiles/${tile.z}/${tile.x}/${tile.y}.pbf`, local = files.has(path);
        try {
          if (!local && deps.online?.() === false) continue;
          const url = local ? `/offline-map/${path}` : (await cancellable(remoteTemplate(), signal)).replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
          const bytes = await cancellable(deps.loadBytes(url), signal); checkAbort(signal);
          if (!bytes.byteLength || bytes.byteLength > VECTOR_TILE_LIMITS.bytes) throw new RangeError('Landscape tile exceeds byte budget');
          const raster = await cancellable(deps.paint(bytes, tile, signal), signal); checkAbort(signal);
          // Validate immediately so a broken painter cannot retain an oversized buffer.
          if (raster.width !== TILE_SIZE || raster.height !== TILE_SIZE || !(raster.pixels instanceof Uint8ClampedArray) || raster.pixels.length !== TILE_SIZE * TILE_SIZE * 4) throw new RangeError('Invalid landscape painted tile');
          rasters.push({tile, ...raster}); sources.push({...tile, url, local});
          await (deps.yield || nextTurn)();
        } catch {checkAbort(signal); /* A missing tile stays transparent; it is never invented. */}
      }
    };
    await Promise.all(Array.from({length: Math.min(CONCURRENCY, plan.tiles.length)}, worker));
    checkAbort(signal);
    const result = rasterizer(plan, rasters, LANDSCAPE_SURFACE_SIZE, LANDSCAPE_SURFACE_SIZE);
    rasters.length = 0;
    for (let row = 0; row < LANDSCAPE_SURFACE_SIZE; row += 32) {
      checkAbort(signal); result.rows(row, Math.min(row + 32, LANDSCAPE_SURFACE_SIZE));
      await (deps.yield || nextTurn)();
    }
    checkAbort(signal); sources.sort((a, b) => a.y - b.y || a.worldX - b.worldX);
    return {width: LANDSCAPE_SURFACE_SIZE, height: LANDSCAPE_SURFACE_SIZE, pixels: result.pixels, source: {
      name: 'OpenStreetMap / OpenFreeMap', attribution: 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',
      bounds: plan.bounds, projection: 'regular-longitude-latitude', sampleLayout: 'grid-nodes', rowOrder: 'north-to-south', columnOrder: 'west-to-east',
      tileZoom: plan.zoom, requestedTiles: plan.tiles.length, loadedTiles: sources.length, localTiles: sources.filter(t => t.local).length,
      complete: sources.length === plan.tiles.length, tiles: sources,
    }};
  };
}

async function uncompressed(bytes: ArrayBuffer, signal?: AbortSignal): Promise<ArrayBuffer> {
  const signature = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (signature[0] !== 31 || signature[1] !== 139) return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      checkAbort(signal); const part = await cancellable(reader.read(), signal); if (part.done) break;
      size += part.value.byteLength; if (size > VECTOR_TILE_LIMITS.bytes) throw new RangeError('Decoded landscape tile exceeds byte budget'); chunks.push(part.value);
    }
  } finally {await reader.cancel().catch(() => undefined); reader.releaseLock();}
  const out = new Uint8Array(size); let at = 0; for (const chunk of chunks) {out.set(chunk, at); at += chunk.length;} return out.buffer;
}

async function paint(bytes: ArrayBuffer, tile: LandscapeTile, signal?: AbortSignal) {
  const decoded = decodeVectorTile(await uncompressed(bytes, signal)); checkAbort(signal);
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE) : document.createElement('canvas');
  canvas.width = canvas.height = TILE_SIZE;
  try {
    const context = canvas.getContext('2d', {willReadFrequently: true}) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error('Landscape cartography painter unavailable');
    paintVectorTile(context, decoded, tile.z, TILE_SIZE, true, false);
    return {width: TILE_SIZE, height: TILE_SIZE, pixels: context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data};
  } finally {canvas.width = canvas.height = 0;}
}

const sharedLoader = createLandscapeSurfaceLoader({
  loadBytes: async url => (await import('./map-preload')).loadPublicBytes(url, 0),
  loadJSON: async url => (await import('./map-preload')).loadPublicJSON(url, 0),
  paint, online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
});
export function createLandscapeSurface(grid: TerrainGrid, options: SurfaceOptions = {}): Promise<LandscapeSurface> {
  return sharedLoader(grid, options);
}
