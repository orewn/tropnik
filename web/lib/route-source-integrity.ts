import type * as GeoJSON from 'geojson';
import {readRouteGeometry} from './route-geometry.ts';

export const ROUTE_SOURCE_DATA_ROOT = '/data/';
type SourceHashes = Readonly<Record<string, string>>;
type SourceReadOptions = {
  load: (url: string, priority: number, signal: AbortSignal) => Promise<ArrayBuffer>;
  invalidate: (url: string) => void;
  signal: AbortSignal;
};

/** The small, build-generated index lets an opened route load independently
 * of the country overview, while both paths require the same source bytes. */
export function versionedRouteSource(url: string, sources: SourceHashes): {url: string; sha256: string} {
  const key = url.startsWith(ROUTE_SOURCE_DATA_ROOT) ? url.slice(ROUTE_SOURCE_DATA_ROOT.length) : '';
  const sha256 = Object.hasOwn(sources, key) ? sources[key] : undefined;
  if (!/^[\w-][\w./-]*\.geojson$/.test(key) || key.includes('..') || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Route source is absent from the current catalogue');
  }
  return {url: `${url}?v=${sha256.slice(0, 16)}`, sha256};
}

export async function loadVerifiedRouteGeometry(url: string, sources: SourceHashes, options: SourceReadOptions): Promise<GeoJSON.GeoJSON> {
  const {load, invalidate, signal} = options;
  signal.throwIfAborted();
  const source = versionedRouteSource(url, sources);
  const bytes = await load(source.url, 0, signal);
  signal.throwIfAborted();
  try {
    const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    signal.throwIfAborted();
    if (digest !== source.sha256) throw new Error('Selected route source integrity mismatch');
    return readRouteGeometry(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (!signal.aborted) invalidate(source.url);
    throw error;
  }
}
