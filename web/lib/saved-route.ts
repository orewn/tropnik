import type {Trail} from './content';
import type {SavedPack} from './local';
import {readRouteGeometry} from './route-geometry.ts';

/** A saved card carries its own line and source identity. A card without a
 * saved line must not silently substitute a later network geometry. */
export function savedTrailSnapshot(pack: Pick<SavedPack, 'trail' | 'geometry'>): Trail {
  const geometry = pack.geometry == null ? undefined : readRouteGeometry(pack.geometry);
  return {
    ...pack.trail, geometry, geometryUrl: geometry ? pack.trail.geometryUrl : undefined,
    ...(geometry && pack.trail.publicationStatus === 'published' ? {geometryDetail: 'full' as const} : {}),
  };
}
