import type * as GeoJSON from 'geojson';
import {readRouteGeometry} from './route-geometry.ts';
import {isReviewedCoastalAllowance,reviewedCoastalSource,verifyReviewedCoastalRoute,type ReviewedCoastalAllowance} from './reviewed-coastal-routes.ts';
import {pointToSegment,type MapPoint} from './custom-map-camera.ts';

export type OverlayBounds = [number, number, number, number];
export type TrailOverlayPart = {bounds: OverlayBounds; lines: GeoJSON.Position[][]; encoded?: string[]};
export type TrailOverlayEntry = {key: string; ids: string[]; parts: TrailOverlayPart[]; detail?: TrailOverlayPart[]; coastal?: ReviewedCoastalAllowance};
type EncodedPart = [bounds: OverlayBounds, overview: string, close: string];
export type EncodedOverlaySource = {key: string; ids: string[]; sha256: string; bounds: OverlayBounds; points: number; parts: EncodedPart[]};
export type EncodedTrailOverlay = {version: 1; sourceDigest: string; catalogueRoutes: number; geometryRoutes: number; sources: EncodedOverlaySource[]};
type PreparedSource = EncodedOverlaySource & {prepared: TrailOverlayEntry};
export const TRAIL_OVERLAY_ZOOMS = [8, 12] as const;
export const TRAIL_OVERLAY_ERROR_PX = .65;
const PRECISION = 10_000_000;
export const TRAIL_OVERLAY_DATA_ROOT = '/data/';
const MAX_DETAIL_POINTS = 180_000, MAX_DETAIL_SOURCES = 64, DETAIL_CONCURRENCY = 2;
const PREPARATION_BUDGET_MS = 5, VALIDATION_CHUNK_POINTS = 256;

/** Every original part stays separate. Longitudes are unwrapped only for
 * bounds/projection; coordinates in the source are not moved or joined. */
export function trailOverlayParts(data: GeoJSON.GeoJSON): {coordinates: GeoJSON.Position[]; bounds: OverlayBounds}[] {
  const parts: {coordinates: GeoJSON.Position[]; bounds: OverlayBounds}[] = [];
  const add = (coordinates: GeoJSON.Position[]) => {
    if (coordinates.length < 2) return;
    const bounds: OverlayBounds = [Infinity, Infinity, -Infinity, -Infinity];
    let reference = 105;
    for (const point of coordinates) {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[1]) > 85.05112878) throw new Error('Invalid trail overlay coordinate');
      const longitude = point[0] + 360 * Math.round((reference - point[0]) / 360); reference = longitude;
      bounds[0] = Math.min(bounds[0], longitude); bounds[1] = Math.min(bounds[1], point[1]);
      bounds[2] = Math.max(bounds[2], longitude); bounds[3] = Math.max(bounds[3], point[1]);
    }
    parts.push({coordinates, bounds});
  };
  const visit = (value: GeoJSON.GeoJSON | null): void => {
    if (!value) return;
    if (value.type === 'FeatureCollection') value.features.forEach(visit);
    else if (value.type === 'Feature') visit(value.geometry);
    else if (value.type === 'GeometryCollection') value.geometries.forEach(visit);
    else if (value.type === 'LineString') add(value.coordinates);
    else if (value.type === 'MultiLineString') value.coordinates.forEach(add);
  };
  visit(data); return parts;
}

/** An exact integer codec for the source's seven-decimal coordinates. It is
 * compression, not quantisation: the builder rejects any coordinate it would
 * change. Arithmetic avoids signed-32-bit overflow at the antimeridian. */
export function encodeOverlayLine(line: readonly GeoJSON.Position[]): string {
  let output = ''; const previous = [0, 0];
  for (const point of line) for (let axis = 0; axis < 2; axis++) {
    const value = Math.round(point[axis] * PRECISION);
    if (!Number.isSafeInteger(value) || value / PRECISION !== point[axis]) throw new Error('Trail coordinate cannot be encoded without loss');
    let delta = value - previous[axis]; previous[axis] = value;
    delta = delta < 0 ? -delta * 2 - 1 : delta * 2;
    while (delta >= 32) {output += String.fromCharCode(delta % 32 + 95); delta = Math.floor(delta / 32);}
    output += String.fromCharCode(delta + 63);
  }
  return output;
}

function* readOverlayLineChunks(encoded: string, emit?: (longitude: number, latitude: number) => void): Generator<void, number> {
  const previous = [0, 0];
  let cursor = 0, count = 0;
  while (cursor < encoded.length) {
    for (let axis = 0; axis < 2; axis++) {
      let value = 0, multiplier = 1, complete = false;
      for (let count = 0; count < 8 && cursor < encoded.length; count++) {
        const byte = encoded.charCodeAt(cursor++) - 63;
        if (byte < 0 || byte > 63) throw new Error('Invalid trail coordinate encoding');
        value += byte % 32 * multiplier;
        if (byte < 32) {complete = true; break;} multiplier *= 32;
      }
      if (!complete || !Number.isSafeInteger(value)) throw new Error('Truncated trail coordinate encoding');
      previous[axis] += value % 2 ? -(value + 1) / 2 : value / 2;
    }
    const longitude = previous[0] / PRECISION, latitude = previous[1] / PRECISION;
    if (Math.abs(longitude) > 540 || Math.abs(latitude) > 85.05112878) throw new Error('Invalid decoded trail coordinate');
    emit?.(longitude, latitude); count++;
    if (count % VALIDATION_CHUNK_POINTS === 0) yield;
  }
  if (count < 2) throw new Error('Empty trail overlay line');
  return count;
}

function readOverlayLine(encoded: string, emit?: (longitude: number, latitude: number) => void): number {
  const chunks = readOverlayLineChunks(encoded, emit);
  for (;;) {const result = chunks.next(); if (result.done) return result.value;}
}

export function decodeOverlayLine(encoded: string): GeoJSON.Position[] {
  const line: GeoJSON.Position[] = []; readOverlayLine(encoded, (longitude, latitude) => line.push([longitude, latitude]));
  return line;
}

/** Decode only the level of a part that actually intersects the buffered
 * viewport. The retained coordinate array is the renderer's cache identity. */
export function overlayPartLine(part: TrailOverlayPart, level: number): GeoJSON.Position[] {
  const index = Math.min(level, (part.encoded?.length ?? part.lines.length) - 1);
  if (!part.lines[index] && part.encoded) part.lines[index] = decodeOverlayLine(part.encoded[index]);
  return part.lines[index];
}

export function overlayBoundsIntersect(a: readonly number[], b: readonly number[]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

type TrailOverlayHitOptions = {
  point: MapPoint;
  bounds: OverlayBounds;
  zoom: number;
  tolerance: number;
  project: (longitude: number, latitude: number) => MapPoint;
  unproject: (point: MapPoint) => readonly number[];
  insideCoverage: (longitude: number, latitude: number) => boolean;
  pointerInsideCoverage: boolean;
  skipId?: string;
};
const coastalHitParts = new WeakMap<ReviewedCoastalAllowance, TrailOverlayPart[]>();

/** Pick the line actually painted at this LOD, not an invisible straight chord
 * or a future detail response. Called only for a click: geographic bounds cull
 * parts and segments before projection, with no full-country screen index. */
export function hitTrailOverlay(entries: readonly TrailOverlayEntry[], options: TrailOverlayHitOptions): {id: string; distance: number} | undefined {
  const {point, bounds, tolerance} = options;
  if (![point.x, point.y, options.zoom, tolerance, ...bounds].every(Number.isFinite) || tolerance < 0) return;
  const level = options.zoom <= TRAIL_OVERLAY_ZOOMS[0] ? 0 : options.zoom <= TRAIL_OVERLAY_ZOOMS[1] ? 1 : 2;
  let nearest: {id: string; distance: number} | undefined;
  for (const entry of entries) {
    if (!entry.ids.length || options.skipId && entry.ids.includes(options.skipId)) continue;
    const coastal = isReviewedCoastalAllowance(entry.coastal) && entry.key === entry.coastal.key ? entry.coastal : undefined;
    if (!coastal && !options.pointerInsideCoverage) continue;
    let parts = level === 2 && entry.detail ? entry.detail : entry.parts;
    if (coastal) {
      let cached = coastalHitParts.get(coastal);
      if (!cached) {
        cached = trailOverlayParts(coastal.geometry).map(part => ({bounds: part.bounds, lines: [part.coordinates]}));
        coastalHitParts.set(coastal, cached);
      }
      parts = cached;
    }
    for (const part of parts) {
      if (!overlayBoundsIntersect(part.bounds, bounds)) continue;
      const line = overlayPartLine(part, level);
      let previous: {longitude: number; latitude: number} | undefined, reference = 105;
      for (const coordinate of line) {
        const longitude = coordinate[0] + 360 * Math.round((reference - coordinate[0]) / 360), latitude = coordinate[1]; reference = longitude;
        if (previous && Math.min(previous.longitude, longitude) <= bounds[2] && Math.max(previous.longitude, longitude) >= bounds[0] &&
          Math.min(previous.latitude, latitude) <= bounds[3] && Math.max(previous.latitude, latitude) >= bounds[1]) {
          const hit = pointToSegment(point, options.project(previous.longitude, previous.latitude), options.project(longitude, latitude));
          if (hit.distance <= tolerance && (!nearest || hit.distance < nearest.distance)) {
            const coordinate = options.unproject(hit.point);
            // A visible pointer near a masked segment cannot select the hidden
            // route. Only the exact issued coastal snapshot bypasses the mask.
            if (coastal || options.insideCoverage(coordinate[0], coordinate[1])) nearest = {id: entry.ids[0], distance: hit.distance};
          }
        }
        previous = {longitude, latitude};
      }
    }
  }
  return nearest;
}

function bounds(value: unknown): value is OverlayBounds {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[0] <= value[2] && value[1] <= value[3];
}

function* prepareTrailOverlayChunks(value: unknown): Generator<void, PreparedSource[]> {
  const data = value as EncodedTrailOverlay;
  if (!data || data.version !== 1 || !Array.isArray(data.sources) || data.sources.length > 5000) throw new Error('Invalid trail overlay catalogue');
  const keys = new Set<string>(); let partCount = 0;
  const prepared: PreparedSource[] = [];
  for (const source of data.sources) {
    if (typeof source.key !== 'string' || !/^[\w-][\w./-]*\.geojson$/.test(source.key) || source.key.includes('..') || keys.has(source.key) ||
      !Array.isArray(source.ids) || !source.ids.length || source.ids.some(id => typeof id !== 'string' || !id || id.length > 160) ||
      !/^[a-f0-9]{64}$/.test(source.sha256) || !bounds(source.bounds) || !Number.isSafeInteger(source.points) || source.points < 2 ||
      !Array.isArray(source.parts) || !source.parts.length || (partCount += source.parts.length) > 100000) throw new Error('Invalid trail overlay source');
    keys.add(source.key);
    const parts: TrailOverlayPart[] = [];
    for (const part of source.parts) {
      if (!Array.isArray(part) || part.length !== 3 || !bounds(part[0]) || typeof part[1] !== 'string' || typeof part[2] !== 'string') throw new Error('Invalid trail overlay part');
      // Validate every encoded coordinate without allocating offscreen arrays.
      yield* readOverlayLineChunks(part[1]); yield* readOverlayLineChunks(part[2]);
      parts.push({bounds: part[0], lines: [], encoded: [part[1], part[2]]});
      yield;
    }
    prepared.push({...source, prepared: {key: source.key, ids: source.ids, parts}});
  }
  return prepared;
}

/** Synchronous validation is retained for build tools and deterministic tests. */
export function prepareTrailOverlay(value: unknown): PreparedSource[] {
  const chunks = prepareTrailOverlayChunks(value);
  for (;;) {const result = chunks.next(); if (result.done) return result.value;}
}

type PreparationOptions = {
  signal?: AbortSignal;
  budgetMs?: number;
  now?: () => number;
  yieldControl?: () => Promise<void>;
};
function yieldPreparation(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {scheduler?: {yield?: () => Promise<void>}}).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0));
}

/** Validate a country catalogue without monopolising an input frame. Even a
 * single long part yields checkpoints every 256 points; no offscreen coordinate
 * arrays are decoded or published before the complete validation succeeds. */
export async function prepareTrailOverlayAsync(value: unknown, options: PreparationOptions = {}): Promise<PreparedSource[]> {
  const budget = options.budgetMs ?? PREPARATION_BUDGET_MS;
  if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid trail preparation budget');
  const now = options.now ?? (() => performance.now()), yieldControl = options.yieldControl ?? yieldPreparation;
  const chunks = prepareTrailOverlayChunks(value);
  let started = now();
  for (;;) {
    options.signal?.throwIfAborted();
    const result = chunks.next();
    if (result.done) return result.value;
    if (now() - started >= budget) {
      await yieldControl();
      options.signal?.throwIfAborted();
      started = now();
    }
  }
}

type OverlayView = {ids: readonly string[]; selectedId?: string; bounds: OverlayBounds; zoom: number};
type OverlayOptions = {
  url: string;
  sha256?: string;
  load: (url: string, priority: number, signal: AbortSignal) => Promise<ArrayBuffer>;
  onChange: (entries: TrailOverlayEntry[]) => void;
  onError: (message: string) => void;
  invalidate?: (url: string) => void;
};
type Detail = {parts: TrailOverlayPart[]; points: number; coastal?: ReviewedCoastalAllowance};

/** One compressed overview request, then at most two cancellable source reads
 * for the settled close view. Rendering the catalogue never waits for DEM or
 * imagery and a failed detail read retains its truthful overview geometry. */
export class TrailOverlayLoader {
  private options: OverlayOptions;
  private sources?: PreparedSource[];
  private view?: OverlayView;
  private overview?: AbortController;
  private jobs = new Map<string, AbortController>();
  private details = new Map<string, Detail>();
  private failed = new Set<string>();
  private wanted: PreparedSource[] = [];
  private disposed = false;
  private error = '';
  constructor(options: OverlayOptions) {this.options = options;}
  update(view: OverlayView) {
    if (this.disposed) return;
    this.view = {...view, ids: [...view.ids], bounds: [...view.bounds]};
    if (!view.ids.length) {this.wanted = []; this.cancelUnwanted(); this.report(''); this.options.onChange([]); return;}
    if (!this.sources) {this.start(); return;}
    this.refresh();
  }
  retry() {
    if (this.disposed) return;
    this.failed.clear(); this.report('');
    if (this.sources) this.refresh(); else this.start();
  }
  private report(message: string) {if (message !== this.error) {this.error = message; this.options.onError(message);}}
  private start() {
    if (this.overview || this.disposed || !this.view?.ids.length || this.failed.has('overview')) return;
    const controller = new AbortController(); this.overview = controller;
    void this.options.load(this.options.url, 1, controller.signal).then(async bytes => {
      if (this.disposed || controller.signal.aborted) return;
      let sources: PreparedSource[];
      try {
        if (this.options.sha256 !== undefined) {
          if (!/^[a-f0-9]{64}$/.test(this.options.sha256)) throw new Error('Invalid trail overlay digest');
          const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (this.disposed || controller.signal.aborted) return;
          if (digest !== this.options.sha256) throw new Error('Trail overlay integrity mismatch');
        }
        sources = await prepareTrailOverlayAsync(JSON.parse(new TextDecoder().decode(bytes)), {signal: controller.signal});
      }
      catch (error) {if (!controller.signal.aborted) this.options.invalidate?.(this.options.url); throw error;}
      if (this.disposed || controller.signal.aborted) return;
      this.sources = sources;
      this.report(''); this.refresh();
    }).catch(() => {
      if (!this.disposed && !controller.signal.aborted) {this.failed.add('overview'); this.report('Линии троп не загрузились. Повторите загрузку карты.');}
    }).finally(() => {if (this.overview === controller) this.overview = undefined;});
  }
  private selected() {
    const ids = new Set(this.view?.ids);
    return this.sources?.filter(source => source.ids.some(id => ids.has(id))) ?? [];
  }
  private refresh() {
    if (!this.sources || !this.view || this.disposed) return;
    const selected = this.selected(), view = this.view, ids = new Set(view.ids);
    let points = 0;
    this.wanted = selected.filter(source => (view.zoom > TRAIL_OVERLAY_ZOOMS[1] || reviewedCoastalSource(source.key,source.sha256)) && !source.ids.includes(view.selectedId ?? '') &&
      overlayBoundsIntersect(source.bounds, view.bounds) && source.parts.some(part => overlayBoundsIntersect(part[0], view.bounds)))
      .sort((a, b) => {
        const cx = (view.bounds[0] + view.bounds[2]) / 2, cy = (view.bounds[1] + view.bounds[3]) / 2;
        const distance = (s: PreparedSource) => Math.hypot((s.bounds[0] + s.bounds[2]) / 2 - cx, (s.bounds[1] + s.bounds[3]) / 2 - cy);
        return distance(a) - distance(b) || a.key.localeCompare(b.key);
      }).filter(source => {if (points + source.points > MAX_DETAIL_POINTS) return false; points += source.points; return true;}).slice(0, MAX_DETAIL_SOURCES);
    this.cancelUnwanted();
    this.report(this.wanted.some(source => this.failed.has(source.key)) ? 'Часть подробных линий троп не загрузилась. Повторите загрузку.' : '');
    const wanted = new Set(this.wanted.map(source => source.key));
    let cachedPoints = [...this.details.values()].reduce((sum, item) => sum + item.points, 0);
    for (const [key, item] of this.details) {
      if (cachedPoints <= MAX_DETAIL_POINTS && this.details.size <= MAX_DETAIL_SOURCES) break;
      if (!wanted.has(key)) {this.details.delete(key); cachedPoints -= item.points;}
    }
    this.options.onChange(selected.map(source => ({...source.prepared, ids: source.ids.filter(id => ids.has(id)), detail: this.details.get(source.key)?.parts, coastal:this.details.get(source.key)?.coastal})));
    this.pump();
  }
  private cancelUnwanted() {
    const wanted = new Set(this.wanted.map(source => source.key));
    for (const [key, controller] of this.jobs) if (!wanted.has(key)) {controller.abort(); this.jobs.delete(key);}
  }
  private pump() {
    if (this.disposed) return;
    for (const source of this.wanted) {
      if (this.jobs.size >= DETAIL_CONCURRENCY) break;
      if (this.details.has(source.key) || this.jobs.has(source.key) || this.failed.has(source.key)) continue;
      const controller = new AbortController(); this.jobs.set(source.key, controller);
      const url=`${TRAIL_OVERLAY_DATA_ROOT}${source.key}?v=${source.sha256.slice(0, 16)}`;
      void this.options.load(url, 2, controller.signal).then(async bytes => {
        if (this.disposed || controller.signal.aborted || this.jobs.get(source.key) !== controller) return;
        let parts,raw;
        try {
          const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (this.disposed || controller.signal.aborted || this.jobs.get(source.key) !== controller) return;
          if (digest !== source.sha256) throw new Error('Detailed trail source integrity mismatch');
          raw = readRouteGeometry(JSON.parse(new TextDecoder().decode(bytes))); parts = trailOverlayParts(raw); if (!parts.length) throw new Error('Empty detailed trail geometry');
        }
        catch (error) {this.options.invalidate?.(url); throw error;}
        const coastal=reviewedCoastalSource(source.key,source.sha256)?await verifyReviewedCoastalRoute(TRAIL_OVERLAY_DATA_ROOT+source.key,raw):undefined;
        if (this.disposed || controller.signal.aborted || this.jobs.get(source.key) !== controller) return;
        this.details.delete(source.key);
        this.details.set(source.key, {parts: parts.map(part => ({bounds: part.bounds, lines: [part.coordinates]})), points: parts.reduce((sum, part) => sum + part.coordinates.length, 0),coastal});
      }).catch(() => {if (!this.disposed && !controller.signal.aborted) this.failed.add(source.key);})
        .finally(() => {
          if (this.jobs.get(source.key) === controller) this.jobs.delete(source.key);
          if (!this.disposed && !controller.signal.aborted) this.refresh();
        });
    }
  }
  inspect() {return {sources: this.sources?.length ?? 0, visibleSources: this.selected().length, pending: this.jobs.size, detailSources: this.details.size, detailPoints: [...this.details.values()].reduce((sum, item) => sum + item.points, 0)};}
  destroy() {this.disposed = true; this.overview?.abort(); for (const controller of this.jobs.values()) controller.abort(); this.jobs.clear(); this.details.clear(); this.sources = undefined; this.view = undefined;}
}
