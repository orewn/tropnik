import {MAP_RESOURCE_LIMITS} from './map-config.ts';

/** One bounded pool shared by every preview. It never marks an offline pack complete. */
type Entry = {promise: Promise<ArrayBuffer>; priority: number; bytes: number; settled: boolean; resolve: (value: ArrayBuffer) => void; reject: (error: unknown) => void; json?: unknown; persistent: boolean; consumers: number; controller?: AbortController};
type Options = {concurrency?: number; maxBytes?: number; maxResourceBytes?: number; maxQueued?: number; timeoutMs?: number; fetcher?: typeof fetch};

/** Preserve the actual HTTP status for source-coverage decisions. A failed
 * fetch, timeout or decoder error must never be mistaken for a missing tile. */
export class MapResourceHTTPError extends Error {
  readonly status: number;
  constructor(status: number) {super(`Preview resource unavailable (${status})`); this.name = 'MapResourceHTTPError'; this.status = status;}
}

export class MapResourcePool {
  private entries = new Map<string, Entry>();
  private queue: string[] = [];
  private active = 0;
  private bytes = 0;
  private options: Required<Options>;
  constructor(options: Options = {}) {
    this.options = {...MAP_RESOURCE_LIMITS, fetcher: (...args) => fetch(...args), ...options};
    for (const key of ['concurrency', 'maxBytes', 'maxResourceBytes', 'maxQueued', 'timeoutMs'] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) throw new RangeError(`Invalid map resource limit: ${key}`);
    }
  }
  get(url: string, priority = 1, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Map request cancelled', 'AbortError'));
    const existing = this.entries.get(url);
    if (existing) {existing.priority = Math.min(existing.priority, priority); this.entries.delete(url); this.entries.set(url, existing); return this.consume(url, existing, signal);}
    if (this.queue.length >= this.options.maxQueued) {
      // An opened map takes precedence over speculative cards still in the queue.
      const victim = this.queue.findLast(key => (this.entries.get(key)?.priority ?? 0) > priority);
      if (!victim) return Promise.reject(new Error('Preview queue is full'));
      this.queue.splice(this.queue.indexOf(victim), 1);
      this.entries.get(victim)?.reject(new Error('Preview superseded by an opened map'));
      this.remove(victim);
    }
    let resolve!: Entry['resolve'], reject!: Entry['reject'];
    const promise = new Promise<ArrayBuffer>((yes, no) => {resolve = yes; reject = no;});
    const entry: Entry = {promise, resolve, reject, priority, bytes: 0, settled: false, persistent: false, consumers: 0};
    this.entries.set(url, entry);
    const consumed = this.consume(url, entry, signal);
    this.queue.push(url); this.pump(); return consumed;
  }
  /** Each map view leases a shared read. Cancelling one view cannot abort the
   * same source still used by another map or a non-cancellable prefetch. */
  private consume(url: string, entry: Entry, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!signal) {entry.persistent = true; return entry.promise;}
    entry.consumers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true; signal.removeEventListener('abort', cancel); entry.consumers--; return true;
      };
      const cancel = () => {
        if (!release()) return;
        const error = signal.reason ?? new DOMException('Map request cancelled', 'AbortError');
        reject(error);
        if (!entry.settled && !entry.persistent && !entry.consumers && this.entries.get(url) === entry) {
          this.queue = this.queue.filter(key => key !== url);
          this.remove(url); entry.controller?.abort(); entry.reject(error);
        }
      };
      signal.addEventListener('abort', cancel, {once: true});
      entry.promise.then(value => {if (release()) resolve(value);}, error => {if (release()) reject(error);});
      // Covers a custom signal aborting while the listener is installed.
      if (signal.aborted) cancel();
    });
  }
  has(url: string) {return this.entries.has(url);}
  /** Discard invalid content after validation without interrupting another consumer's active request. */
  invalidate(url: string) {if (this.entries.get(url)?.settled) this.remove(url);}
  async json<T>(url: string, priority = 1): Promise<T> {
    const bytes = await this.get(url, priority), entry = this.entries.get(url);
    if (entry?.json !== undefined) return entry.json as T;
    try {const value = JSON.parse(new TextDecoder().decode(bytes)) as T; if (entry) entry.json = value; return value;}
    catch (error) {this.remove(url); throw error;}
  }
  private remove(url: string) {const entry = this.entries.get(url); if (entry) {this.bytes -= entry.bytes; this.entries.delete(url);}}
  private pump() {
    this.queue.sort((a, b) => (this.entries.get(a)?.priority ?? 9) - (this.entries.get(b)?.priority ?? 9));
    while (this.active < this.options.concurrency && this.queue.length) {
      const url = this.queue.shift()!, entry = this.entries.get(url); if (!entry) continue; this.active++;
      const controller = new AbortController(); entry.controller = controller;
      this.read(url, controller).then(bytes => {
        if (this.entries.get(url) !== entry) return;
        entry.bytes = bytes.byteLength; entry.settled = true; this.bytes += entry.bytes;
        for (const [key, candidate] of this.entries) {if (this.bytes <= this.options.maxBytes) break; if (candidate.settled && key !== url) this.remove(key);}
        entry.resolve(bytes);
      }, error => {if (this.entries.get(url) === entry) this.remove(url); entry.reject(error);}).finally(() => {entry.controller = undefined; this.active--; this.pump();});
    }
  }
  private async read(url: string, controller: AbortController) {
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Regional manifests and checked extracts can be updated at the same URL.
      // Revalidate the browser cache on a new pool read; the bounded in-memory
      // pool still shares bytes across views. Otherwise a new release can keep
      // selecting an old coverage manifest or reject a stale material checksum.
      const regional = /(?:^|\/)terrain-regions\//.test(url);
      const response = await this.options.fetcher(url, {cache: regional ? 'no-cache' : 'force-cache', credentials: url.startsWith('/') ? 'same-origin' : 'omit', signal: controller.signal});
      if (!response.ok) throw new MapResourceHTTPError(response.status);
      if (Number(response.headers.get('content-length') || 0) > this.options.maxResourceBytes) throw new Error('Preview resource exceeds the byte budget');
      reader = response.body?.getReader(); if (!reader) return new ArrayBuffer(0);
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {const {value, done} = await reader.read(); if (done) break; length += value.byteLength; if (length > this.options.maxResourceBytes) throw new Error('Preview resource exceeds the byte budget'); chunks.push(value);}
      const output = new Uint8Array(length); let offset = 0; for (const chunk of chunks) {output.set(chunk, offset); offset += chunk.length;} return output.buffer;
    } finally {clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {});}
  }
  stats() {return {active: this.active, queued: this.queue.length, cached: this.entries.size, bytes: this.bytes};}
}

export type Tile = {z: number; x: number; y: number};
const toTile = (lng: number, lat: number, z: number) => {
  const n = 2 ** z, phi = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return [Math.min(n - 1, Math.max(0, Math.floor((lng + 180) / 360 * n))), Math.min(n - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n)))];
};
/** Covers the actual route bounds at the best zoom within a preview budget. */
export function routeTilePlan(bounds: number[], budget = 18, maxZoom = 12): Tile[] {
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[1] > bounds[3] || bounds[1] < -90 || bounds[3] > 90 || bounds[0] < -180 || bounds[0] > 180 || bounds[2] < -180 || bounds[2] > 180 || budget < 2) return [];
  const boxes = bounds[0] <= bounds[2] ? [bounds] : [[bounds[0], bounds[1], 180, bounds[3]], [-180, bounds[1], bounds[2], bounds[3]]];
  for (let z = maxZoom; z >= 0; z--) {
    const extents = boxes.map(b => {const [x0, y0] = toTile(b[0], b[3], z), [x1, y1] = toTile(b[2], b[1], z); return {x0, y0, x1, y1};});
    if (extents.reduce((n, r) => n + (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1), 0) > budget) continue;
    const tiles = new Map<string, Tile>();
    for (const r of extents) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) tiles.set(`${z}/${x}/${y}`, {z, x, y});
    return [...tiles.values()];
  }
  return [];
}
