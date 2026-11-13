import {verifyReviewedCoastalRoute, type ReviewedCoastalAllowance} from '../../web/lib/reviewed-coastal-routes';

type Resource = {url: string; sha256: string; sizeBytes: number};
type Source = Resource & {ids: string[]};
export type NativeMapCatalogueManifest = {schemaVersion: 1; overlay: Resource; sources: Source[]; referenceRouteIds: string[]};
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const digest = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9-]{1,128}$/.test(value);

/** The native broker hashes this manifest and every fixed asset. The adapter
 * accepts only its canonical source URLs; a web cache revision is removed only
 * after matching the full source record. The broker's no-query rule remains. */
export class NativeMapCatalogue {
  private pending?: Promise<NativeMapCatalogueManifest>;
  private readonly lifetime = new AbortController();
  constructor(private readonly origin: string, private readonly request: typeof fetch = fetch) {}

  manifest(): Promise<NativeMapCatalogueManifest> {
    if (this.lifetime.signal.aborted) return Promise.reject(new DOMException('Map disposed', 'AbortError'));
    if (!this.pending) this.pending = this.readManifest().catch(error => {this.pending = undefined;throw error;});
    return this.pending;
  }

  private async readManifest(): Promise<NativeMapCatalogueManifest> {
    const response = await this.request(this.origin + '/custom-map/catalogue.json', {signal: this.lifetime.signal, credentials: 'omit', cache: 'no-store'});
    if (!response.ok) throw new Error('Native catalogue unavailable');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('Native catalogue manifest exceeds budget');
    const manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as NativeMapCatalogueManifest;
    const resource = (value: Resource) => value && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= MAX_RESOURCE_BYTES && /^[a-f0-9]{64}$/.test(value.sha256);
    if (manifest.schemaVersion !== 1 || !resource(manifest.overlay) || !/^\/data\/trail-overlay-[a-f0-9]{16}\.json$/.test(manifest.overlay.url) ||
      manifest.overlay.url !== `/data/trail-overlay-${manifest.overlay.sha256.slice(0, 16)}.json` ||
      !Array.isArray(manifest.referenceRouteIds) || manifest.referenceRouteIds.length > 100000 || manifest.referenceRouteIds.some(id => !validId(id)) ||
      new Set(manifest.referenceRouteIds).size !== manifest.referenceRouteIds.length || !Array.isArray(manifest.sources) || manifest.sources.length > manifest.referenceRouteIds.length) throw new Error('Invalid native catalogue manifest');
    const references = new Set(manifest.referenceRouteIds), urls = new Set<string>(), ids = new Set<string>();
    for (const source of manifest.sources) {
      if (!resource(source) || !/^\/data\/(routes|imported)\/[a-z0-9-]+\.geojson$/.test(source.url) || urls.has(source.url) ||
        !Array.isArray(source.ids) || !source.ids.length || new Set(source.ids).size !== source.ids.length || source.ids.some(id => !references.has(id) || ids.has(id))) throw new Error('Invalid native catalogue source');
      urls.add(source.url);for (const id of source.ids) ids.add(id);
    }
    this.lifetime.signal.throwIfAborted();
    return manifest;
  }

  async load(value: string, _priority: number, signal: AbortSignal): Promise<ArrayBuffer> {
    signal.throwIfAborted();this.lifetime.signal.throwIfAborted();
    const manifest = await this.manifest();
    signal.throwIfAborted();this.lifetime.signal.throwIfAborted();
    const url = new URL(value, this.origin);
    const canonical = url.pathname + url.search;
    if (url.origin !== this.origin || url.username || url.password || url.hash || (value !== canonical && value !== this.origin + canonical)) throw new Error('Invalid catalogue resource URL');
    const record = url.pathname === manifest.overlay.url ? manifest.overlay : manifest.sources.find(source => source.url === url.pathname);
    if (!record || (url.search && (record === manifest.overlay || url.search !== '?v=' + record.sha256.slice(0, 16)))) throw new Error('Unlisted catalogue resource');
    const response = await this.request(this.origin + record.url, {signal, credentials: 'omit', cache: 'no-store'});
    if (!response.ok) throw new Error('Catalogue resource unavailable');
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();this.lifetime.signal.throwIfAborted();
    if (bytes.byteLength !== record.sizeBytes) throw new Error('Catalogue resource length mismatch');
    // TrailOverlayLoader verifies the original overview/source SHA before use.
    return bytes;
  }

  async verifyRoute(bytes: ArrayBuffer, geometry: GeoJSON.GeoJSON, id?: string): Promise<ReviewedCoastalAllowance | undefined> {
    if (!id) return;
    const manifest = await this.manifest(), source = manifest.sources.find(item => item.ids.includes(id));
    if (!source) return; // API routes never inherit a reference track's exception.
    if (bytes.byteLength !== source.sizeBytes || await digest(bytes) !== source.sha256) throw new Error('Selected native route integrity mismatch');
    this.lifetime.signal.throwIfAborted();
    return verifyReviewedCoastalRoute(source.url, geometry);
  }

  dispose(): void {this.lifetime.abort();this.pending = undefined;}
}
