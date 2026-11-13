import type {Envelope, Route} from './contract';
import type {ResponseByteBudget} from './api-transport.ts';

export const ROUTE_CATALOGUE_LIMITS = Object.freeze({pageSize: 100, pages: 100, routes: 10_000, bytes: 16 * 1024 * 1024});
type PageReader = (path: string, signal: AbortSignal, budget: ResponseByteBudget) => Promise<Envelope<Route[]> | null>;

/** Publish the collected catalogue only after every page. A cursor loop, failed later page or budget
 * exhaustion cannot silently replace the catalogue with a partial first page. */
export async function collectPublishedRoutes(readPage: PageReader, signal: AbortSignal): Promise<Route[]> {
  const routes: Route[] = [], ids = new Set<string>(), cursors = new Set<string>();
  const budget = {remainingBytes: ROUTE_CATALOGUE_LIMITS.bytes};
  let cursor: string | undefined;
  for (let page = 0; page < ROUTE_CATALOGUE_LIMITS.pages; page++) {
    signal.throwIfAborted();
    const result = await readPage(`routes?limit=${ROUTE_CATALOGUE_LIMITS.pageSize}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, signal, budget);
    signal.throwIfAborted();
    if (result === null && page === 0) return [];
    if (!result || !Array.isArray(result.data) || result.data.length > ROUTE_CATALOGUE_LIMITS.pageSize || result.meta?.mode !== 'production') throw new Error('Incomplete route catalogue');
    for (const route of result.data) {
      if (!route || typeof route.id !== 'string' || !/^[\w-]{1,128}$/.test(route.id) || ids.has(route.id) || routes.length >= ROUTE_CATALOGUE_LIMITS.routes) throw new Error('Invalid route catalogue page');
      ids.add(route.id); routes.push(route);
    }
    const next = result.meta.nextCursor;
    if (next === undefined) return routes;
    if (typeof next !== 'string' || !next || next.length > 512 || !result.data.length || cursors.has(next)) throw new Error('Invalid route catalogue cursor');
    cursors.add(next); cursor = next;
  }
  throw new Error('Route catalogue exceeds its page budget');
}
