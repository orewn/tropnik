import {continuousBounds, longitudeNear, mercatorProject, type GeographicBounds} from './custom-map-camera.ts';
import {TerrainPreparation, type PreparedTerrain} from './terrain-preparation.ts';
import type {TerrainGrid} from '../public/terrain/terrain-renderer.js';
import terrainPreparationWorkerURL from './terrain-preparation.worker.ts?worker&url';
import {createTerrainRegionReader} from './terrain-region-sources.ts';
import {MapResourceHTTPError} from './map-resource-pool.ts';

export const LANDSCAPE_MAX_SOURCE_ZOOM = 12;
export const LANDSCAPE_MAX_TILES = 16;
const EARTH_CIRCUMFERENCE_M = 40075016.68557849;
const PILOT_BOUNDS: GeographicBounds = [40.29, 43.64, 40.49, 43.82];
const MAX_TILE_BYTES = 4 * 1024 * 1024;
const sourceMetadata = {
  name: 'Mapterhorn / Copernicus GLO-30', url: 'https://mapterhorn.com/data-access/',
  attributionUrl: 'https://mapterhorn.com/attribution/',
  license: 'Copernicus WorldDEM-30 Full, Free & Open licence (included)',
  licensePath: '/offline-map/terrain/sources/Copernicus-GLO30-LICENSE.pdf', checkedAt: '2026-11-06',
  sourceNominalResolutionM: 30,
  sourceAcquisitionPeriod: 'TanDEM-X 2011–2015; some infill elevations can be older',
  datasetType: 'DSM (surface, including vegetation and structures)',
  verticalDatum: 'Copernicus GLO-30 source: EGM2008; no independent datum transformation validated',
  sourceSelectionNote: 'Global GLO-30 source inferred from published coverage; endpoint does not expose per-pixel source IDs.',
};
const attribution = 'Terrain © Mapterhorn; produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';

export type LandscapeTile = {z: number; x: number; y: number};
export type LandscapeTileResource = LandscapeTile & {url: string; tileSize: number; sha256?: string; bytes?: number};
export type DecodedTerrainTile = {width: number; height: number; elevations: Float32Array};
export type LandscapeTilePlan = {bounds: [number, number, number, number]; zoom: number; tileSize: number; tiles: LandscapeTile[]};
export type LandscapeLoadOptions = {
  signal?: AbortSignal;
  gridSize?: 257 | 513;
  maxTiles?: 9 | 16;
  maxSourceZoom?: number;
  /** Prefer the packaged, finite offline coverage. Online is otherwise WEBP512. */
  preferLocal?: boolean;
  /** Prefer checked, native public DEM extracts when the entire view is covered. */
  preferRegional?: boolean;
};
export type LandscapeProvenance = {
  provider: string;
  kind: 'remote-terrarium' | 'local-terrarium' | 'local-grid';
  requestedBounds: [number, number, number, number];
  sourceZoom: number | null;
  sourceTileSize: number | null;
  sourceUrls: string[];
  sourceNominalResolutionM: number;
  sourcePixelSpacingApproxM: number | null;
  sourceGridSpacingApproxM: {eastWest: number; northSouth: number} | null;
  outputSpacingApproxM: {eastWest: number; northSouth: number};
  interpolation: string;
  missingDataFilled: false;
  measurementAccuracyClaimedM: null;
  fallbackReason: string | null;
};
export type CustomLandscape = {grid: TerrainGrid; prepared: PreparedTerrain; provenance: LandscapeProvenance};
export type LandscapeLoaderDependencies = {
  loadBytes?: (url: string, priority: number) => Promise<ArrayBuffer>;
  loadJSON?: (url: string, priority: number) => Promise<unknown>;
  decodeTile?: (bytes: ArrayBuffer, resource: LandscapeTileResource, signal: AbortSignal) => Promise<DecodedTerrainTile>;
  prepare?: (grid: TerrainGrid) => Promise<PreparedTerrain>;
  online?: () => boolean;
  yieldControl?: () => Promise<void>;
};

const wrap = (x: number, count: number) => ((x % count) + count) % count;
const tileKey = (tile: LandscapeTile) => `${tile.z}/${tile.x}/${tile.y}`;
const abortError = (signal?: AbortSignal) => signal?.reason ?? new DOMException('Landscape request cancelled', 'AbortError');
const checkAbort = (signal?: AbortSignal) => {if (signal?.aborted) throw abortError(signal);};
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function validBounds(input: GeographicBounds): [number, number, number, number] {
  const bounds = continuousBounds(input);
  if (!(bounds[2] > bounds[0]) || bounds[2] - bounds[0] > 360 || !(bounds[3] > bounds[1]) || bounds[1] < -85 || bounds[3] > 85) {
    throw new RangeError('Landscape bounds must have positive area, longitude span ≤ 360°, and latitude within ±85°');
  }
  return [...bounds];
}
function spacing(bounds: GeographicBounds, width: number, height: number) {
  const latitude = (bounds[1] + bounds[3]) / 2 * Math.PI / 180;
  return {eastWest: (bounds[2] - bounds[0]) / 360 * EARTH_CIRCUMFERENCE_M * Math.cos(latitude) / (width - 1),
    northSouth: (bounds[3] - bounds[1]) / 360 * EARTH_CIRCUMFERENCE_M / (height - 1)};
}

/** Include the real neighbouring pixels needed by bilinear interpolation. The
 * count is bounded before enumerating, so a continental request cannot build a
 * temporary million-tile list. Wrapped worlds share one canonical tile. */
export function planLandscapeTiles(input: GeographicBounds, options: {
  maxTiles?: number; maxSourceZoom?: number; tileSize?: number; availableTileKeys?: ReadonlySet<string>;
} = {}): LandscapeTilePlan {
  const bounds = validBounds(input), maxTiles = options.maxTiles ?? LANDSCAPE_MAX_TILES;
  const maxZoom = Math.min(LANDSCAPE_MAX_SOURCE_ZOOM, options.maxSourceZoom ?? LANDSCAPE_MAX_SOURCE_ZOOM), tileSize = options.tileSize ?? 512;
  if (!Number.isInteger(maxTiles) || maxTiles < 1 || maxTiles > LANDSCAPE_MAX_TILES || !Number.isInteger(maxZoom) || maxZoom < 0 || !Number.isInteger(tileSize) || tileSize < 2 || tileSize > 512) throw new RangeError('Invalid landscape tile budget');
  for (let zoom = maxZoom; zoom >= 0; zoom--) {
    const count = 2 ** zoom, size = count * tileSize;
    const northWest = mercatorProject([bounds[0], bounds[3]]), southEast = mercatorProject([bounds[2], bounds[1]]);
    const left = Math.floor(Math.floor(northWest.x * size - .5) / tileSize);
    const right = Math.floor((Math.floor(southEast.x * size - .5) + 1) / tileSize);
    const top = Math.floor(Math.floor(northWest.y * size - .5) / tileSize);
    const bottom = Math.floor((Math.floor(southEast.y * size - .5) + 1) / tileSize);
    const across = Math.min(count, right - left + 1), down = bottom - top + 1;
    if (top < 0 || bottom >= count || across * down > maxTiles) continue;
    const tiles: LandscapeTile[] = [];
    for (let y = top; y <= bottom; y++) for (let offset = 0; offset < across; offset++) tiles.push({z: zoom, x: wrap(left + offset, count), y});
    if (options.availableTileKeys && tiles.some(tile => !options.availableTileKeys!.has(tileKey(tile)))) continue;
    return {bounds, zoom, tileSize, tiles};
  }
  throw new Error('No complete elevation coverage within the landscape tile budget');
}

/** Decode scalar metres first: interpolating Terrarium RGB creates false
 * cliffs at channel carries. Alpha or out-of-range pixels fail the tile. */
export function decodeTerrariumPixels(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): DecodedTerrainTile {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 512 || height > 512 || rgba.length !== width * height * 4) throw new RangeError('Invalid Terrarium image dimensions');
  const elevations = new Float32Array(width * height);
  decodePixelRows(rgba, elevations, 0, elevations.length);
  return {width, height, elevations};
}
function decodePixelRows(rgba: Uint8Array | Uint8ClampedArray, elevations: Float32Array, start: number, end: number) {
  for (let index = start; index < end; index++) {
    const at = index * 4, elevation = rgba[at] * 256 + rgba[at + 1] + rgba[at + 2] / 256 - 32768;
    if (rgba[at + 3] !== 255 || elevation < -12000 || elevation > 10000) throw new Error('Terrarium tile contains unavailable or invalid elevations');
    elevations[index] = elevation;
  }
}
async function decodeTileImage(bytes: ArrayBuffer, resource: LandscapeTileResource, signal: AbortSignal, yieldControl: () => Promise<void>): Promise<DecodedTerrainTile> {
  checkAbort(signal);
  if (typeof createImageBitmap === 'undefined') throw new Error('Terrain image decoding is unavailable');
  const bitmap = await createImageBitmap(new Blob([bytes], {type: resource.url.endsWith('.png') ? 'image/png' : 'image/webp'}), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
  let rgba: Uint8ClampedArray;
  try {
    if (bitmap.width !== resource.tileSize || bitmap.height !== resource.tileSize) throw new Error('Unexpected elevation tile dimensions');
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bitmap.width, bitmap.height) : typeof document !== 'undefined' ? document.createElement('canvas') : undefined;
    if (!canvas) throw new Error('Terrain image decoding canvas is unavailable');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', {willReadFrequently: true}) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new Error('Terrain image decoding context is unavailable');
    context.drawImage(bitmap, 0, 0);
    rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  } finally {bitmap.close();}
  const elevations = new Float32Array(resource.tileSize * resource.tileSize);
  for (let offset = 0; offset < elevations.length; offset += resource.tileSize * 16) {
    checkAbort(signal); decodePixelRows(rgba, elevations, offset, Math.min(elevations.length, offset + resource.tileSize * 16));
    if (offset + resource.tileSize * 16 < elevations.length) await yieldControl();
  }
  return {width: resource.tileSize, height: resource.tileSize, elevations};
}

/** Real cross-tile neighbours, including x=last ↔ x=0 at the dateline. No edge
 * clamping, generated values, or sea-level fill is used for missing data. */
export function sampleLandscapeElevation(plan: LandscapeTilePlan, tiles: ReadonlyMap<string, DecodedTerrainTile>, longitude: number, latitude: number): number {
  const world = mercatorProject([longitude, latitude]), count = 2 ** plan.zoom, size = count * plan.tileSize;
  const x = world.x * size - .5, y = world.y * size - .5, x0 = Math.floor(x), y0 = Math.floor(y), fractionX = x - x0, fractionY = y - y0;
  const sample = (px: number, py: number) => {
    const tx = wrap(Math.floor(px / plan.tileSize), count), ty = Math.floor(py / plan.tileSize);
    const tile = tiles.get(`${plan.zoom}/${tx}/${ty}`);
    if (!tile || tile.width !== plan.tileSize || tile.height !== plan.tileSize || tile.elevations.length !== tile.width * tile.height) throw new Error('Missing elevation tile or neighbour');
    const height = tile.elevations[wrap(py, plan.tileSize) * plan.tileSize + wrap(px, plan.tileSize)];
    if (!Number.isFinite(height) || height < -12000 || height > 10000) throw new Error('Invalid source elevation');
    return height;
  };
  const north = sample(x0, y0) * (1 - fractionX) + sample(x0 + 1, y0) * fractionX;
  const south = sample(x0, y0 + 1) * (1 - fractionX) + sample(x0 + 1, y0 + 1) * fractionX;
  return north * (1 - fractionY) + south * fractionY;
}

type NormalizedOptions = {gridSize: 257 | 513; maxTiles: 9 | 16; maxSourceZoom: number; preferLocal: boolean; preferRegional: boolean};
type ManifestEntry = {path: string; bytes: number; sha256: string};
type TileManifest = {tiles: Map<string, ManifestEntry>; source: Record<string, unknown>};
function normalizeOptions(options: LandscapeLoadOptions): NormalizedOptions {
  const gridSize = options.gridSize ?? 513, maxTiles = options.maxTiles ?? 16, maxSourceZoom = Math.min(12, options.maxSourceZoom ?? 12);
  if (![257, 513].includes(gridSize) || ![9, 16].includes(maxTiles) || !Number.isInteger(maxSourceZoom) || maxSourceZoom < 0) throw new RangeError('Invalid landscape resolution or budget');
  return {gridSize, maxTiles, maxSourceZoom, preferLocal: !!options.preferLocal, preferRegional: !!options.preferRegional};
}
function parseManifest(input: unknown): TileManifest {
  if (!input || typeof input !== 'object' || !Array.isArray((input as {files?: unknown}).files)) throw new Error('Offline elevation manifest is unavailable');
  const data = input as {files: unknown[]; terrainSource?: Record<string, unknown>}, tiles = new Map<string, ManifestEntry>();
  if (data.files.length > 10000) throw new Error('Offline elevation manifest exceeds its resource budget');
  for (const entry of data.files) {
    if (!entry || typeof entry !== 'object') continue;
    const file = entry as ManifestEntry, match = typeof file.path === 'string' && /^terrain\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(file.path);
    if (!match) continue;
    const z = Number(match[1]), x = Number(match[2]), y = Number(match[3]);
    if (z > 12 || x >= 2 ** z || y >= 2 ** z || !Number.isInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_TILE_BYTES || !/^[a-f\d]{64}$/i.test(file.sha256)) throw new Error('Invalid offline elevation manifest entry');
    tiles.set(`${z}/${x}/${y}`, {path: file.path, bytes: file.bytes, sha256: file.sha256.toLowerCase()});
  }
  return {tiles, source: data.terrainSource ?? {}};
}
async function verifyBytes(bytes: ArrayBuffer, resource: LandscapeTileResource) {
  if (!bytes.byteLength || bytes.byteLength > MAX_TILE_BYTES || resource.bytes !== undefined && resource.bytes !== bytes.byteLength) throw new Error('Unexpected elevation tile byte length');
  if (resource.sha256) {
    if (!globalThis.crypto?.subtle) throw new Error('Offline elevation integrity validation unavailable');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== resource.sha256) throw new Error('Offline elevation tile hash mismatch');
  }
}
function containsBounds(outer: GeographicBounds, inner: GeographicBounds) {
  const west = longitudeNear(inner[0], (outer[0] + outer[2]) / 2), east = inner[2] + (west - inner[0]), epsilon = 1e-9;
  return west >= outer[0] - epsilon && east <= outer[2] + epsilon && inner[1] >= outer[1] - epsilon && inner[3] <= outer[3] + epsilon;
}
function localGridSampler(grid: TerrainGrid) {
  return (longitude: number, latitude: number) => {
    const west = grid.bounds[0], east = grid.bounds[2], wrapped = longitudeNear(longitude, (west + east) / 2);
    const x = (wrapped - west) / (east - west) * (grid.width - 1), y = (grid.bounds[3] - latitude) / (grid.bounds[3] - grid.bounds[1]) * (grid.height - 1);
    if (x < -1e-8 || y < -1e-8 || x > grid.width - 1 + 1e-8 || y > grid.height - 1 + 1e-8) throw new Error('Requested landscape exceeds the packaged elevation grid');
    const x0 = Math.min(grid.width - 2, Math.max(0, Math.floor(x))), y0 = Math.min(grid.height - 2, Math.max(0, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
    const a = grid.elevations[y0 * grid.width + x0], b = grid.elevations[y0 * grid.width + x0 + 1], c = grid.elevations[(y0 + 1) * grid.width + x0], d = grid.elevations[(y0 + 1) * grid.width + x0 + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

type Job = {
  key: string; bounds: [number, number, number, number]; options: NormalizedOptions; priority: number;
  controller: AbortController; consumers: number; promise: Promise<CustomLandscape>;
  resolve: (value: CustomLandscape) => void; reject: (reason: unknown) => void;
};

/** One active pipeline, two queued view requests and two cached preparations.
 * Consumer cancellation never terminates another consumer's work. The shared
 * resource pool may finish an in-flight transfer; no stale result is published. */
export function createCustomLandscapeLoader(dependencies: LandscapeLoaderDependencies = {}) {
  const loadBytes = dependencies.loadBytes ?? (async (url: string, priority: number) => (await import('./map-preload.ts')).loadPublicBytes(url, priority));
  const loadJSON = dependencies.loadJSON ?? (async (url: string, priority: number) => dependencies.loadBytes ? JSON.parse(new TextDecoder().decode(await loadBytes(url, priority))) as unknown : (await import('./map-preload.ts')).loadPublicJSON<unknown>(url, priority));
  const yieldControl = dependencies.yieldControl ?? yieldTask;
  const decode = dependencies.decodeTile ?? ((bytes: ArrayBuffer, resource: LandscapeTileResource, signal: AbortSignal) => decodeTileImage(bytes, resource, signal, yieldControl));
  const prepare = dependencies.prepare ?? (async (grid: TerrainGrid) => new TerrainPreparation({
    loadGrid: async () => grid, loadModule: () => import('../public/terrain/terrain-renderer.js'),
    createWorker: () => typeof Worker === 'undefined' ? undefined : new Worker(new URL(terrainPreparationWorkerURL, location.href), {type: 'module', name: 'tropnik-landscape'}),
  }).load());
  const online = dependencies.online ?? (() => typeof navigator === 'undefined' || navigator.onLine);
  const regional = createTerrainRegionReader({loadJSON: url => loadJSON(url, 0), loadBytes: url => loadBytes(url, 0)});
  const jobs = new Map<string, Job>(), queue: Job[] = [], cache = new Map<string, CustomLandscape>();
  let active: Job | undefined, disposed = false, manifest: Promise<TileManifest> | undefined;
  let completed = 0, failed = 0;
  const getManifest = (priority: number) => {
    if (!manifest) manifest = loadJSON('/offline-map/manifest.json', priority).then(parseManifest).catch(error => {manifest = undefined; throw error;});
    return manifest;
  };

  async function tileSource(job: Job, local: boolean) {
    const archive = local ? await getManifest(job.priority) : undefined;
    checkAbort(job.controller.signal);
    let remaining = job.options.maxTiles, maxSourceZoom = job.options.maxSourceZoom;
    const missingZooms: number[] = [];
    // Sparse remote pyramids may omit an all-sea tile at one zoom while a
    // coarser tile really exists. All attempts share the original request
    // budget; never fill missing elevations or combine different source LODs.
    for (let attempt = 0; attempt < 3; attempt++) {
    const plan = planLandscapeTiles(job.bounds, {...job.options, maxSourceZoom, maxTiles: remaining, tileSize: local ? 256 : 512, availableTileKeys: archive && new Set(archive.tiles.keys())});
    const resources: LandscapeTileResource[] = plan.tiles.map(tile => {
      const entry = archive?.tiles.get(tileKey(tile));
      return {...tile, tileSize: plan.tileSize, url: entry ? `/offline-map/${entry.path}` : `https://tiles.mapterhorn.com/${tileKey(tile)}.webp`, sha256: entry?.sha256, bytes: entry?.bytes};
    });
    const tiles = new Map<string, DecodedTerrainTile>();
    let error: unknown;
    const missing = (value: unknown) => value instanceof MapResourceHTTPError && value.status === 404;
    const failed = (value: unknown) => {if (error === undefined || missing(error) && !missing(value)) error = value;};
    // Do not enqueue the entire 16-tile region into the shared request pool.
    const load = async (batch: LandscapeTileResource[]) => {
    let next = 0;
    const workers = Array.from({length: Math.min(3, batch.length)}, async () => {
      while (next < batch.length && error === undefined) {
        checkAbort(job.controller.signal);
        const resource = batch[next++]; remaining--;
        try {
          const bytes = await loadBytes(resource.url, job.priority);
          checkAbort(job.controller.signal); await verifyBytes(bytes, resource); checkAbort(job.controller.signal);
          const tile = await decode(bytes, resource, job.controller.signal);
          checkAbort(job.controller.signal);
          if (tile.width !== resource.tileSize || tile.height !== resource.tileSize || tile.elevations.length !== tile.width * tile.height) throw new Error('Unexpected decoded elevation tile dimensions');
          tiles.set(tileKey(resource), tile);
        } catch (caught) {failed(caught);}
      }
    });
    const results = await Promise.allSettled(workers);
    for (const result of results) if (result.status === 'rejected') failed(result.reason);
    if (error) throw error;
    };
    try {
      // Check three outer source tiles before admitting the rest. A missing
      // Arctic/dateline corner then leaves enough of the same budget for a
      // complete coarser window instead of downloading most of a doomed LOD.
      const probes = local ? [] : [...new Set([resources[0], resources.findLast(resource => resource.y === resources[0].y)!, resources.at(-1)!])];
      await load(probes); await load(resources.filter(resource => !probes.includes(resource)));
    } catch (caught) {
      checkAbort(job.controller.signal); tiles.clear();
      if (local || !missing(caught) || !remaining || plan.zoom === 0 || attempt === 2) throw caught;
      missingZooms.push(plan.zoom); maxSourceZoom = plan.zoom - 1; continue;
    }
    checkAbort(job.controller.signal);
    return {sample: (longitude: number, latitude: number) => sampleLandscapeElevation(plan, tiles, longitude, latitude),
      source: {...sourceMetadata, ...archive?.source, sourceTileZoom: plan.zoom, sourceTileSize: plan.tileSize},
      kind: local ? 'local-terrarium' as const : 'remote-terrarium' as const,
      sourceZoom: plan.zoom, sourceTileSize: plan.tileSize, sourceUrls: resources.map(resource => resource.url),
      sourceGridSpacingApproxM: null,
      sourcePixelSpacingApproxM: EARTH_CIRCUMFERENCE_M * Math.cos((job.bounds[1] + job.bounds[3]) / 2 * Math.PI / 180) / (2 ** plan.zoom * plan.tileSize),
      coverageFallbackReason: missingZooms.length ? `Remote elevation coverage missing at zoom ${missingZooms.join(', ')} (HTTP 404); using complete zoom ${plan.zoom} coverage from ${resources.length} real tiles.` : null,
      interpolation: 'Bilinear on decoded scalar metres with actual neighbours across Terrarium tile seams; no generated or filled elevations.'};
    }
    throw new Error('No complete elevation coverage within the request budget');
  }

  async function gridSource(job: Job) {
    if (!containsBounds(PILOT_BOUNDS, job.bounds)) throw new Error('No packaged elevation grid covers this area');
    let error: unknown;
    for (const url of ['/terrain/terrain-grid.json', '/offline-map/terrain/terrain-grid.json']) {
      try {
        const grid = await loadJSON(url, job.priority) as TerrainGrid;
        checkAbort(job.controller.signal);
        const renderer = await import('../public/terrain/terrain-renderer.js'); renderer.validateTerrainGrid(grid);
        if (!grid.source || typeof grid.source.name !== 'string' || typeof grid.source.url !== 'string' || typeof grid.source.license !== 'string' || typeof grid.source.checkedAt !== 'string') throw new Error('Packaged elevation grid is missing source metadata');
        if (!containsBounds(grid.bounds, job.bounds)) throw new Error('Packaged elevation grid does not cover the requested area');
        return {sample: localGridSampler(grid), source: grid.source,
          kind: 'local-grid' as const, sourceZoom: typeof grid.source.sourceTileZoom === 'number' ? grid.source.sourceTileZoom : null,
          sourceTileSize: typeof grid.source.sourceTileSize === 'number' ? grid.source.sourceTileSize : null, sourceUrls: [url],
          sourceGridSpacingApproxM: spacing(grid.bounds, grid.width, grid.height), sourcePixelSpacingApproxM: null,
          interpolation: 'Bilinear on a packaged numeric elevation grid; output density does not increase source detail or measurement accuracy.'};
      } catch (caught) {checkAbort(job.controller.signal); error = caught;}
    }
    throw error;
  }

  async function build(job: Job): Promise<CustomLandscape> {
    checkAbort(job.controller.signal);
    const useLocal = job.options.preferLocal || !online();
    let source: Awaited<ReturnType<typeof tileSource>> | Awaited<ReturnType<typeof gridSource>> | undefined, fallbackReason: string | null = null;
    if (job.options.preferRegional) {
      const region = await regional.find(job.bounds); checkAbort(job.controller.signal);
      if (region) try {
        const native = await regional.grid(region); checkAbort(job.controller.signal);
        const outputSpacingApproxM = spacing(native.bounds, native.width, native.height);
        const provenance: LandscapeProvenance = {provider: native.source.name, kind: 'local-grid', requestedBounds: [...job.bounds],
          sourceZoom: null, sourceTileSize: null, sourceUrls: [region.gridUrl], sourceNominalResolutionM: Number(native.source.sourceNominalResolutionM) || 30,
          sourcePixelSpacingApproxM: null, sourceGridSpacingApproxM: outputSpacingApproxM, outputSpacingApproxM,
          interpolation: 'Runtime preserves the public DEM extract grid. Extractor locates source pixel centres, bilinearly samples geographic output nodes, and rounds to 0.01 m for encoding; rounding is not an accuracy claim.',
          missingDataFilled: false, measurementAccuracyClaimedM: null, fallbackReason: null};
        const grid: TerrainGrid = {...native, source: {...native.source, regionId: region.id, landscape: provenance}};
        const prepared = await prepare(grid); checkAbort(job.controller.signal); return {grid, prepared, provenance};
      } catch (error) {checkAbort(job.controller.signal); fallbackReason = error instanceof Error ? error.message : 'Regional elevation source unavailable';}
    }
    const attempts = useLocal ? [() => tileSource(job, true), () => gridSource(job), ...online() ? [() => tileSource(job, false)] : []]
      : [() => tileSource(job, false), () => tileSource(job, true), () => gridSource(job)];
    for (const attempt of attempts) {
      try {source = await attempt(); break;}
      catch (error) {checkAbort(job.controller.signal); fallbackReason = error instanceof Error ? error.message : 'Elevation source unavailable';}
    }
    if (!source) throw new Error(fallbackReason ?? 'Elevation data unavailable for this area');
    if ('coverageFallbackReason' in source && source.coverageFallbackReason) fallbackReason = source.coverageFallbackReason;
    const size = job.options.gridSize, elevations = new Array<number>(size * size), bounds = job.bounds;
    let minElevation = Infinity, maxElevation = -Infinity;
    for (let row = 0; row < size; row++) {
      checkAbort(job.controller.signal);
      const latitude = bounds[3] + (bounds[1] - bounds[3]) * row / (size - 1);
      for (let column = 0; column < size; column++) {
        const height = source.sample(bounds[0] + (bounds[2] - bounds[0]) * column / (size - 1), latitude);
        if (!Number.isFinite(height) || height < -12000 || height > 10000) throw new Error('Invalid sampled elevation');
        elevations[row * size + column] = height; minElevation = Math.min(minElevation, height); maxElevation = Math.max(maxElevation, height);
      }
      if (row % 8 === 7) await yieldControl();
    }
    const outputSpacingApproxM = spacing(bounds, size, size);
    const provenance: LandscapeProvenance = {provider: 'Mapterhorn / Copernicus GLO-30', kind: source.kind,
      requestedBounds: [...bounds], sourceZoom: source.sourceZoom, sourceTileSize: source.sourceTileSize,
      sourceUrls: source.sourceUrls, sourceNominalResolutionM: typeof source.source.sourceNominalResolutionM === 'number' ? source.source.sourceNominalResolutionM : 30,
      sourcePixelSpacingApproxM: source.sourcePixelSpacingApproxM, sourceGridSpacingApproxM: source.sourceGridSpacingApproxM,
      outputSpacingApproxM, interpolation: source.interpolation, missingDataFilled: false, measurementAccuracyClaimedM: null, fallbackReason};
    const grid: TerrainGrid = {schemaVersion: 1, bounds: [...bounds], width: size, height: size, elevations, minElevation, maxElevation,
      units: 'meters', rowOrder: 'north-to-south', columnOrder: 'west-to-east', sampleSpacingApproxM: outputSpacingApproxM,
      source: {...source.source, landscape: provenance}, attribution};
    checkAbort(job.controller.signal);
    // Await the entire preparation even if its only consumer leaves. This keeps
    // cancelled worker/cooperative jobs from overlapping a new preparation.
    const prepared = await prepare(grid); checkAbort(job.controller.signal);
    return {grid, prepared, provenance};
  }

  function pump() {
    if (active || disposed) return;
    const job = queue.shift(); if (!job) return;
    active = job;
    void build(job).then(result => {
      checkAbort(job.controller.signal);
      if (disposed) throw abortError();
      cache.set(job.key, result);
      while (cache.size > 2) cache.delete(cache.keys().next().value!);
      completed++; job.resolve(result);
    }).catch(error => {failed++; job.reject(error);}).finally(() => {
      if (jobs.get(job.key) === job) jobs.delete(job.key);
      active = undefined; pump();
    });
  }
  function cancelUnused(job: Job) {
    if (job.consumers || job.controller.signal.aborted) return;
    job.controller.abort();
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    const index = queue.indexOf(job);
    if (index >= 0) {queue.splice(index, 1); job.reject(abortError(job.controller.signal));}
  }
  function consume(job: Job, signal?: AbortSignal): Promise<CustomLandscape> {
    job.consumers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, result?: CustomLandscape) => {
        if (settled) return; settled = true;
        signal?.removeEventListener('abort', abort); job.consumers--;
        if (error !== undefined) reject(error); else resolve(result!);
        cancelUnused(job);
      };
      const abort = () => finish(abortError(signal));
      signal?.addEventListener('abort', abort, {once: true});
      job.promise.then(result => finish(undefined, result), error => finish(error));
      if (signal?.aborted) abort();
    });
  }
  function request(input: GeographicBounds, options: LandscapeLoadOptions = {}, priority = 0): Promise<CustomLandscape> {
    try {
      checkAbort(options.signal);
      if (disposed) throw new Error('Landscape loader disposed');
      const bounds = validBounds(input), normalized = normalizeOptions(options);
      const key = JSON.stringify([bounds, normalized, online()]);
      const cached = cache.get(key);
      if (cached) {cache.delete(key); cache.set(key, cached); return Promise.resolve(cached);}
      let job = jobs.get(key);
      if (!job) {
        if (queue.length >= 2) {
          const evict = priority === 0 ? queue.find(candidate => candidate.priority > priority) : undefined;
          if (!evict) throw new Error('Landscape request queue is full');
          queue.splice(queue.indexOf(evict), 1); jobs.delete(evict.key); evict.controller.abort(); evict.reject(abortError(evict.controller.signal));
        }
        let resolve!: Job['resolve'], reject!: Job['reject'];
        const promise = new Promise<CustomLandscape>((success, failure) => {resolve = success; reject = failure;});
        job = {key, bounds, options: normalized, priority, controller: new AbortController(), consumers: 0, promise, resolve, reject};
        jobs.set(key, job); queue.push(job);
      } else if (priority < job.priority) job.priority = priority;
      queue.sort((a, b) => a.priority - b.priority);
      const result = consume(job, options.signal); pump(); return result;
    } catch (error) {return Promise.reject(error);}
  }
  return {
    load: (bounds: GeographicBounds, options?: LandscapeLoadOptions) => request(bounds, options),
    /** Best-effort warming obeys exactly the same concurrency and memory bounds. */
    prefetch: (bounds: GeographicBounds, options?: LandscapeLoadOptions): Promise<CustomLandscape | undefined> => request(bounds, options, 2).catch(() => undefined),
    snapshot: () => ({active: active ? 1 : 0, queued: queue.length, cached: cache.size, consumers: [...jobs.values()].reduce((sum, job) => sum + job.consumers, 0), completed, failed, disposed}),
    dispose: () => {
      if (disposed) return; disposed = true; cache.clear(); manifest = undefined;
      for (const job of jobs.values()) {job.controller.abort(); job.reject(abortError(job.controller.signal));}
      jobs.clear(); queue.length = 0;
    },
  };
}
export type CustomLandscapeLoader = ReturnType<typeof createCustomLandscapeLoader>;
