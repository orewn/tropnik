import type {ReviewedCoastalAllowance} from '../../web/lib/reviewed-coastal-routes';

/** A route belongs to the current native card, even while its bytes load. */
export type NativeMapRoute = {url?: string; id?: string; version: number};
export class NativeMapRouteLoader {
  private version = 0;
  private pending?: AbortController;
  private disposed = false;
  private readonly request: typeof fetch;
  constructor(private readonly origin: string,
    private readonly setRoute: (geometry?: GeoJSON.GeoJSON, id?: string, coastal?: ReviewedCoastalAllowance) => void,
    request: typeof fetch = fetch,
    private readonly verify?: (bytes: ArrayBuffer, geometry: GeoJSON.GeoJSON, id?: string) => Promise<ReviewedCoastalAllowance | undefined>) {
    // The controller also passes fetch explicitly; neither path may call the
    // browser function with this loader as its receiver.
    this.request = (...args) => request(...args);
  }

  async update(payload: NativeMapRoute): Promise<void> {
    if (this.disposed || !Number.isSafeInteger(payload.version) || payload.version <= this.version) return;
    this.version = payload.version;this.pending?.abort();this.pending = undefined;
    // Clearing precedes validation and I/O. A failure must never leave another
    // card's old route visible behind the current card's title or fit bounds.
    this.setRoute(undefined);
    if (!payload.url) return;
    const url = new URL(payload.url, this.origin);
    if (url.origin !== this.origin || url.username || url.password || !/^\/native-route\/\d+-\d+\.geojson$/.test(url.pathname) || url.search || url.hash) throw new Error('Invalid route resource');
    const abort = new AbortController();this.pending = abort;
    try {
      const response = await this.request(url, {signal: abort.signal, credentials: 'omit', cache: 'no-store'});
      if (!response.ok) throw new Error('Route resource unavailable');
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024) throw new Error('Invalid route resource length');
      const geometry = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as GeoJSON.GeoJSON;
      if (this.disposed || this.version !== payload.version || abort.signal.aborted) return;
      if (!geometry || !['FeatureCollection', 'Feature', 'LineString', 'MultiLineString', 'GeometryCollection'].includes(geometry.type)) throw new Error('Invalid route geometry');
      const coastal = await this.verify?.(bytes, geometry, payload.id);
      // A digest or catalogue lookup can finish after a different card opens.
      if (this.disposed || this.version !== payload.version || abort.signal.aborted) return;
      this.setRoute(geometry, payload.id, coastal);
    } catch (error) {
      if (!this.disposed && this.version === payload.version && !abort.signal.aborted) throw error;
    } finally {if (this.pending === abort) this.pending = undefined;}
  }

  dispose(): void {this.disposed = true;this.pending?.abort();this.pending = undefined;}
}
