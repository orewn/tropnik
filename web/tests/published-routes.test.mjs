import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPublishedRoutes, ROUTE_CATALOGUE_LIMITS} from '../lib/route-catalogue.ts';
import {loadPublishedRoutes, loadPublishedRouteGeometry} from '../lib/published-route.ts';
import {publishedTrail} from '../lib/route-adapter.ts';
import {getPublishedTrails, getPublishedTrail} from '../lib/server.ts';
import {API_TRANSPORT_LIMITS, BodyLimitError} from '../lib/api-transport.ts';

const route = (id = 'route-1', extra = {}) => ({
  id, slug: id, regionId: 'krasnodar', title: 'Source route', description: 'Reviewed description',
  distanceKm: 3, ascentM: 150, durationMin: 180, difficulty: 'easy', revisionId: 'revision-' + id,
  geometryDetail: 'overview', geometry: {type: 'LineString', coordinates: [[40, 43], [40.01, 43.01]]},
  verifiedAt: null, source: {url: 'https://source.example/route', name: 'Reviewed', retrievedAt: '2026-11-13T00:00:00Z'},
  ...extra,
});
const page = (data, nextCursor) => ({data, meta: {mode: 'production', ...(nextCursor === undefined ? {} : {nextCursor})}});
const configured = t => {
  const previous = process.env.TROPA_API_URL;
  process.env.TROPA_API_URL = 'https://api.example.invalid';
  t.after(() => {if (previous === undefined) delete process.env.TROPA_API_URL; else process.env.TROPA_API_URL = previous;});
};

test('an overview supplies only a centre, while known full inline geometry retains every original coordinate by identity', async t => {
  const source = route(), overview = publishedTrail(source);
  assert.deepEqual(overview.center, [40.01, 43.01]); assert.equal(overview.geometry, undefined);
  const points = Array.from({length: 1002}, (_, i) => [40 + i / 100000, 43 + i / 100000]);
  const geometry = {type: 'LineString', coordinates: points};
  const full = publishedTrail(route('route-1', {geometryDetail: 'full', geometry}));
  t.mock.method(globalThis, 'fetch', () => assert.fail('Known full geometry must not be replaced by another revision'));
  assert.equal(await loadPublishedRouteGeometry(full), geometry);
  assert.equal((await loadPublishedRouteGeometry(full)).coordinates, points);
});

test('a selected overview fetches one bounded full detail, preserving all original vertices', async t => {
  const full = route('route-1', {geometryDetail: 'full', geometry: {type: 'LineString', coordinates: Array.from({length: 1002}, (_, i) => [40 + i / 100000, 43 + i / 100000])}});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls++; assert.equal(path, '/api/backend/routes/route-1'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store');
    return Response.json(page(full));
  });
  assert.deepEqual(await loadPublishedRouteGeometry(publishedTrail(route())), full.geometry); assert.equal(calls, 1);
});

test('full geometry rejects a stale route, revision, overview, malformed line or cancelled selection', async t => {
  for (const mismatch of [{id: 'another-route'}, {revisionId: 'revision-2'}, {geometryDetail: 'overview'}, {geometry: {type: 'LineString', coordinates: []}}, {geometry: {type: 'Point', coordinates: [40, 43]}}]) {
    await t.test(JSON.stringify(mismatch), async t => {
      t.mock.method(globalThis, 'fetch', async () => Response.json(page(route('route-1', {geometryDetail: 'full', ...mismatch}))));
      await assert.rejects(loadPublishedRouteGeometry(publishedTrail(route())));
    });
  }
  const caller = new AbortController(), reason = new Error('Different selected card'); caller.abort(reason);
  t.mock.method(globalThis, 'fetch', () => assert.fail('An abandoned card must not fetch'));
  await assert.rejects(loadPublishedRouteGeometry(publishedTrail(route()), caller.signal), error => error === reason);
  await assert.rejects(loadPublishedRouteGeometry({...publishedTrail(route()), geometryUrl: '/api/backend/routes/wrong-route'}), /identity/);
});

test('the browser follows every cursor even when the byte-bounded page is shorter than the requested count', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async path => {
    paths.push(path);
    return Response.json(paths.length === 1 ? page([route('a')], 'opaque+/=cursor') : page([route('b'), route('c')]));
  });
  assert.deepEqual((await loadPublishedRoutes()).map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(paths, ['/api/backend/routes?limit=100', '/api/backend/routes?limit=100&cursor=opaque%2B%2F%3Dcursor']);
});

test('cursor loops, repeated routes and failed later pages reject the whole traversal', async t => {
  for (const kind of ['cursor', 'duplicate', 'failure', 'empty-next', 'invalid-cursor', 'invalid-mode']) await t.test(kind, async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      if (calls === 1) return page([route('a')], 'next');
      if (kind === 'failure') throw new Error('Second page unavailable');
      if (kind === 'duplicate') return page([route('a')]);
      if (kind === 'empty-next') return page([], 'later');
      if (kind === 'invalid-cursor') return page([route('b')], 17);
      if (kind === 'invalid-mode') return {data: [route('b')], meta: {mode: 'preview'}};
      return page([route('b')], 'next');
    };
    await assert.rejects(collectPublishedRoutes(read, new AbortController().signal)); assert.equal(calls, 2);
  });
});

test('the catalogue has a finite page budget and cancellation cannot start another page', async () => {
  let calls = 0;
  await assert.rejects(collectPublishedRoutes(async () => {calls++; return page([route('r-' + calls)], 'cursor-' + calls);}, new AbortController().signal), /page budget/);
  assert.equal(calls, ROUTE_CATALOGUE_LIMITS.pages);
  const caller = new AbortController(), reason = new Error('Catalogue left'); calls = 0;
  await assert.rejects(collectPublishedRoutes(async () => {calls++; caller.abort(reason); return page([route()], 'next');}, caller.signal), error => error === reason);
  assert.equal(calls, 1);
});

test('multiple individually valid pages also share a 16 MiB decoded budget', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json(page([route('route-' + calls, {description: 'x'.repeat(900000)})], 'next-' + calls));
  });
  await assert.rejects(loadPublishedRoutes(), error => error.code === 'response_too_large');
  assert.equal(calls, 19);
});

test('SSR uses the same full catalogue traversal and an encoded query rather than a question mark in the pathname', async t => {
  configured(t); const paths = [], signals = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    paths.push(url.pathname + url.search); signals.push(init.signal); assert.equal(init.redirect, 'error');
    return Response.json(paths.length === 1 ? page([route('a')], 'next+cursor') : page([route('b')]));
  });
  const trails = await getPublishedTrails();
  assert.deepEqual(trails.map(trail => trail.id), ['a', 'b']); assert.ok(trails.every(trail => trail.geometry === undefined));
  assert.deepEqual(paths, ['/api/v1/routes?limit=100', '/api/v1/routes?limit=100&cursor=next%2Bcursor']);
  assert.equal(signals[0], signals[1]); assert.equal(signals[0].aborted, true, 'The complete traversal releases its deadline');
});

test('SSR keeps an unavailable catalogue distinct from a route 404 and an unconfigured service', async t => {
  configured(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('', {status: 404}));
  await assert.rejects(getPublishedTrails(), /temporarily unavailable/);
  assert.equal(await getPublishedTrail('missing'), undefined);
  delete process.env.TROPA_API_URL;
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unconfigured SSR must not fetch'));
  assert.deepEqual(await getPublishedTrails(), []);
});

test('SSR limits list responses to 1 MiB but retains a legitimate full detail above that budget', async t => {
  configured(t);
  const geometry = {type: 'LineString', coordinates: Array.from({length: 100000}, () => [40.1234567, 43.1234567])};
  const full = route('large', {geometryDetail: 'full', geometry});
  assert.ok(Buffer.byteLength(JSON.stringify(page(full))) > API_TRANSPORT_LIMITS.responseBytes);
  t.mock.method(globalThis, 'fetch', async () => Response.json(page(full)));
  assert.equal((await getPublishedTrail('large')).geometry.coordinates.length, geometry.coordinates.length);
  t.mock.method(globalThis, 'fetch', async () => Response.json(page([full])));
  await assert.rejects(getPublishedTrails(), BodyLimitError);
});

test('SSR detail validates the requested identity and full geometry while retaining exact public-slug lookup', async t => {
  configured(t);
  for (const value of [route('another', {geometryDetail: 'full'}), route('requested'), route('requested', {geometryDetail: 'full', revisionId: ''})]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(page(value)));
    await assert.rejects(getPublishedTrail('requested'), /full geometry/);
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json(page(route('canonical-id', {slug: 'public-slug', geometryDetail: 'full'}))));
  assert.equal((await getPublishedTrail('public-slug')).id, 'canonical-id');
});

test('SSR deadline covers a stalled JSON body and discards a partial catalogue', {timeout: 1000}, async t => {
  configured(t); const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => timer(callback, delay === API_TRANSPORT_LIMITS.serverTimeoutMs ? 15 : delay, ...args));
  let calls = 0, cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; if (calls === 1) return Response.json(page([route('a')], 'next'));
    return new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('{"data":'));}, cancel() {cancelled++;}}));
  });
  await assert.rejects(getPublishedTrails(), error => error.name === 'TimeoutError'); assert.equal(calls, 2); assert.equal(cancelled, 1);
});
