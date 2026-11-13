import type {Route} from './contract';
import type {Trail} from './content';
import {api, apiEnvelope} from './api.ts';
import {API_TRANSPORT_LIMITS, requestDeadline} from './api-transport.ts';
import {collectPublishedRoutes} from './route-catalogue.ts';
import {readPublishedRouteGeometry} from './route-adapter.ts';

const PUBLISHED_ROUTE_ROOT = '/api/backend/routes/';

export async function loadPublishedRoutes(signal?: AbortSignal): Promise<Route[]> {
  const deadline = requestDeadline(API_TRANSPORT_LIMITS.browserTimeoutMs, signal);
  try { return await collectPublishedRoutes((path, signal, budget) => apiEnvelope<Route[]>(path, {signal}, budget), deadline.signal); }
  finally { deadline.dispose(); }
}

/** Only full geometry from the selected immutable revision may be displayed or
 * saved. The list's overview supplies a centre, never a navigation track. */
export async function loadPublishedRouteGeometry(trail: Trail, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (trail.publicationStatus !== 'published' || !/^[\w-]{1,128}$/.test(trail.id) ||
      !trail.revisionId || !/^[\w-]{1,128}$/.test(trail.revisionId) || trail.geometryUrl !== PUBLISHED_ROUTE_ROOT + encodeURIComponent(trail.id)) throw new Error('Invalid published route identity');
  if (trail.geometryDetail === 'full' && trail.geometry != null) return readPublishedRouteGeometry(trail, trail.id, trail.revisionId);
  const route = await api<Route>('routes/' + encodeURIComponent(trail.id), {signal});
  signal?.throwIfAborted();
  return readPublishedRouteGeometry(route, trail.id, trail.revisionId);
}
