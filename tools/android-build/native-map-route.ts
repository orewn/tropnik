/** A route belongs to the current native card, even while its bytes load. */
export type NativeMapRoute = {url?: string; id?: string; version: number};
export class NativeMapRouteLoader {
  private version = 0;
  private pending?: AbortController;
  private disposed = false;
  constructor(private readonly origin: string,
    private readonly setRoute: (geometry?: GeoJSON.GeoJSON, id?: string) => void,
    private readonly request: typeof fetch = fetch) {}

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
      const geometry = await response.json() as GeoJSON.GeoJSON;
      if (this.disposed || this.version !== payload.version || abort.signal.aborted) return;
      if (!geometry || !['FeatureCollection', 'Feature', 'LineString', 'MultiLineString', 'GeometryCollection'].includes(geometry.type)) throw new Error('Invalid route geometry');
      this.setRoute(geometry, payload.id);
    } catch (error) {
      if (!this.disposed && this.version === payload.version && !abort.signal.aborted) throw error;
    } finally {if (this.pending === abort) this.pending = undefined;}
  }

  dispose(): void {this.disposed = true;this.pending?.abort();this.pending = undefined;}
}
