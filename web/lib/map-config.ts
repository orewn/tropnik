/** Shared interaction and resource budgets for both map renderers.
 * Values are CSS pixels, milliseconds, bytes or map zooms as named. */
export const MAP_CONFIG = Object.freeze({
  trailHitRadiusPx: 22,
  regionQueryTolerancePx: 3,
  detailEnterZoom: 4.6,
  detailExitZoom: 3.8,
  territoryMaxZoom: 11,
  clusterZoomStep: 1,
  routeMaxZoom: 14,
  planMaxZoom: 16,
  viewportRegionMinZoom: 4,
  maxPixelRatio: 2,
  maxWorkers: 3,
  prefetchTiles: 12,
  constrainedPrefetchTiles: 4,
  geolocationTimeoutMs: 15_000,
  geolocationMaximumAgeMs: 10_000,
});

/** A fit of a large cluster can reproduce the same country view on phones.
 * Each activation must make progress even when not all members fit at once. */
export function directionExpansionZoom(currentZoom: number, fittedZoom: number): number {
  return Math.min(MAP_CONFIG.territoryMaxZoom, Math.max(currentZoom + MAP_CONFIG.clusterZoomStep, fittedZoom));
}

export const MAP_RESOURCE_LIMITS = Object.freeze({
  concurrency: 3,
  maxBytes: 24 * 1024 * 1024,
  maxResourceBytes: 8 * 1024 * 1024,
  maxQueued: 72,
  timeoutMs: 15_000,
});

type ViewportRegion = {id: string; bounds: readonly [number, number, number, number]};
// Editorial story areas, not administrative boundaries or route permissions.
const VIEWPORT_REGIONS: readonly ViewportRegion[] = [
  {id: 'altai', bounds: [82, 48, 91, 53]},
  {id: 'krasnodar', bounds: [36, 42.5, 42, 46.8]},
  {id: 'karelia', bounds: [29, 60.7, 37, 67.2]},
  {id: 'krym', bounds: [32, 44, 37, 46]},
  {id: 'baikal', bounds: [103, 50, 113, 56.8]},
  {id: 'kamchatka', bounds: [155, 50, 166, 61]},
];

export function viewportRegionId(longitude: number, latitude: number, zoom: number): string | undefined {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isFinite(zoom) || zoom < MAP_CONFIG.viewportRegionMinZoom) return;
  return VIEWPORT_REGIONS.find(({bounds: b}) => longitude >= b[0] && longitude <= b[2] && latitude >= b[1] && latitude <= b[3])?.id;
}
