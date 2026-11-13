import {cache} from 'react';
import type {Envelope, Route} from './contract';
import {publishedTrail, readPublishedRouteGeometry} from './route-adapter.ts';
import {API_TRANSPORT_LIMITS, apiResponseBytes, readBoundedJSON, requestDeadline, type ResponseByteBudget} from './api-transport.ts';
import {collectPublishedRoutes} from './route-catalogue.ts';

// An unavailable configured API must never be mistaken for a missing route.
async function read<T>(path: string, signal: AbortSignal, budget?: ResponseByteBudget): Promise<Envelope<T> | null> {
  const base = process.env.TROPA_API_URL;
  if (!base) return null;
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]', 'api'].includes(url.hostname)) throw new Error('Invalid API configuration');
  const [pathname, query = ''] = path.split('?', 2);
  url.pathname = url.pathname.replace(/\/$/, '') + '/api/v1/' + pathname;
  url.search = query;
  const response = await fetch(url, {headers: {Accept: 'application/json'}, cache: 'no-store', redirect: 'error', signal});
  signal.throwIfAborted();
  if (response.status === 404 && /^routes\/[\w-]{1,128}$/.test(pathname)) return null;
  if (!response.ok) throw new Error('Route service temporarily unavailable');
  const body = await readBoundedJSON(response, apiResponseBytes(path), signal, budget);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('data' in body)) throw new Error('Incomplete route response');
  return body as Envelope<T>;
}

export const getPublishedTrails = cache(async () => {
  const deadline = requestDeadline(API_TRANSPORT_LIMITS.serverTimeoutMs);
  try {
    const routes = await collectPublishedRoutes((path, signal, budget) => read<Route[]>(path, signal, budget), deadline.signal);
    return routes.map(publishedTrail);
  } finally { deadline.dispose(); }
});

export const getPublishedTrail = cache(async (id: string) => {
  if (!/^[\w-]{1,128}$/.test(id)) return undefined;
  const deadline = requestDeadline(API_TRANSPORT_LIMITS.serverTimeoutMs);
  try {
    const result = await read<Route>(`routes/${encodeURIComponent(id)}`, deadline.signal);
    if (result) readPublishedRouteGeometry(result.data, id, undefined, true);
    return result ? publishedTrail(result.data) : undefined;
  } finally { deadline.dispose(); }
});
