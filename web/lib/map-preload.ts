import type {Trail} from './content';
import type {TerrainGrid} from '@/public/terrain/terrain-renderer.js';
import {MapResourcePool, routeTilePlan} from './map-resource-pool';
import {createMapTransport, publicMapResourceKey} from './map-transport';
import {TerrainPreparation} from './terrain-preparation';

export const TERRAIN_BOUNDS = [40.29, 43.64, 40.49, 43.82] as const;
const TERRAIN_VERSION = '20261106-3';
const pool = new MapResourcePool();
const origin = () => typeof location === 'undefined' ? 'https://map-preview.local' : location.origin;
const transport = createMapTransport(pool, origin);
export const mapRequest = transport.transformRequest;
let mapWarm: Promise<unknown> | undefined;
let webglAvailable: boolean | undefined;
let rendererModule: Promise<typeof import('@/public/terrain/terrain-renderer.js')> | undefined;
const terrainKey = `/terrain/terrain-grid.json?v=${TERRAIN_VERSION}`;
const terrainPreparation = new TerrainPreparation({
  loadModule: () => {
    if (!rendererModule) rendererModule = import('@/public/terrain/terrain-renderer.js').catch(error => {rendererModule = undefined; throw error;});
    return rendererModule;
  },
  loadGrid: () => loadPublicJSON<TerrainGrid>(terrainKey),
  createWorker: () => typeof Worker === 'undefined' ? undefined : new Worker(new URL('./terrain-preparation.worker.ts', import.meta.url), {type: 'module', name: 'tropnik-terrain'}),
  onFailure: () => pool.invalidate(terrainKey),
});
let tileTemplate: Promise<string> | undefined;
const trailJobs = new Map<string, Promise<PreviewResult>>();
export type PreviewResult = {state: 'ready' | 'partial'; completed: number; total: number};

function allowed(url: string) {
  return publicMapResourceKey(url, origin());
}
export function preloadPublic(url: string) {
  const key = allowed(url); if (!key) return Promise.resolve(undefined);
  return pool.get(key, 2).catch(() => undefined);
}
export function loadPublicJSON<T>(url: string, priority = 0): Promise<T> {
  const key = allowed(url); if (!key) return Promise.reject(new Error('Unknown public map resource'));
  return pool.json<T>(key, priority);
}
export function loadPublicBytes(url:string,priority=1):Promise<ArrayBuffer>{
  const key=allowed(url);if(!key)return Promise.reject(new Error('Unknown public map resource'));
  return pool.get(key,priority);
}
export function supportsMapWebGL() {
  if(typeof document==='undefined')return false;
  if(webglAvailable===undefined){
    try{const gl=document.createElement('canvas').getContext('webgl2');webglAvailable=!!gl;gl?.getExtension('WEBGL_lose_context')?.loseContext();}
    catch{webglAvailable=false;}
  }
  return webglAvailable;
}

export function preferCanvasMap() {
  if(typeof window==='undefined'||typeof navigator==='undefined')return false;
  const nav=navigator as Navigator&{deviceMemory?:number;connection?:{saveData?:boolean}};
  const coarse=window.matchMedia('(pointer:coarse)').matches||nav.maxTouchPoints>0;
  const constrained=(nav.deviceMemory??8)<=4||(nav.hardwareConcurrency||8)<=4||!!nav.connection?.saveData;
  return coarse&&(window.innerWidth<=900||constrained);
}
export function warmMap() {
  if (typeof window === 'undefined') return;
  const webgl=supportsMapWebGL()&&!preferCanvasMap();
  void preloadPublic('/data/russia-display-area.geojson'); void preloadPublic(webgl?'/data/russia-canonical-mask.geojson':'/data/russia-outside-mask.geojson');
  void preloadPublic('/data/territories.geojson'); void preloadPublic('/maps/tropa-style.json');
  if(!webgl)return Promise.resolve();
  if (!mapWarm) mapWarm = import('maplibre-gl').then(ml => {
    ml.addProtocol('tropnik-map', transport.load);
    ml.setWorkerUrl('/maps/maplibre-worker.js');
    ml.setWorkerCount(Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1))); ml.prewarm();
  }).catch(() => {mapWarm = undefined;});
  return mapWarm;
}
export function loadTerrain(signal?: AbortSignal) {return terrainPreparation.load(signal);}
export function terrainPreparationInfo() {return terrainPreparation.snapshot();}
export function preloadTerrain() {return loadTerrain().catch(() => undefined);}
export function hasTerrainPreview(trail?: Trail, regionId?: string) {
  if (!trail) return regionId === 'krasnodar';
  const b = trail.bbox;
  if (b?.length === 4) return b[0] <= TERRAIN_BOUNDS[2] && b[2] >= TERRAIN_BOUNDS[0] && b[1] <= TERRAIN_BOUNDS[3] && b[3] >= TERRAIN_BOUNDS[1];
  const c = trail.center;
  return !!c && c[0] >= TERRAIN_BOUNDS[0] && c[0] <= TERRAIN_BOUNDS[2] && c[1] >= TERRAIN_BOUNDS[1] && c[1] <= TERRAIN_BOUNDS[3];
}
function template() {
  if (!tileTemplate) tileTemplate = loadPublicJSON<{tiles?: string[]}>('https://tiles.openfreemap.org/planet/latest', 1).then(j => {
    const url = j.tiles?.[0];
    if (!url || !url.startsWith('https://tiles.openfreemap.org/') || !allowed(url)) throw new Error('Unknown tile source');
    return url;
  }).catch(error => {tileTemplate = undefined; throw error;});
  return tileTemplate;
}
export function preloadTrail(trail: Trail): Promise<PreviewResult> {
  const key = `${trail.id}:${trail.revisionId || trail.checkedAt}:${trail.geometryUrl || ''}`;
  const previous = trailJobs.get(key); if (previous) return previous;
  const job = (async () => {
    warmMap();
    const resources: Promise<unknown>[] = [];
    if (trail.geometryUrl?.startsWith('/data/')) resources.push(loadPublicJSON(trail.geometryUrl, 1));
    if (hasTerrainPreview(trail)) resources.push(loadTerrain());
    // A centre warms surroundings only; it never becomes invented route geometry.
    const b = trail.bbox || (trail.center ? [trail.center[0] - .01, trail.center[1] - .01, trail.center[0] + .01, trail.center[1] + .01] : null);
    if (b && typeof navigator !== 'undefined' && navigator.onLine) {
      resources.push((async () => {
        const url = await template();
        const connection = (navigator as Navigator & {connection?: {saveData?: boolean; effectiveType?: string}}).connection;
        const budget = connection?.saveData || connection?.effectiveType === '2g' ? 4 : 12;
        const results = await Promise.allSettled(routeTilePlan(b, budget).flatMap(({z, x, y}) => [
          pool.get(url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), 2),
          pool.get(`https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`, 2),
        ]));
        if (results.some(r => r.status === 'rejected')) throw new Error('Some preview tiles are unavailable');
      })());
    }
    const results = await Promise.allSettled(resources), completed = results.filter(r => r.status === 'fulfilled').length;
    return {state: completed === results.length ? 'ready' : 'partial', completed, total: results.length} as PreviewResult;
  })();
  trailJobs.set(key, job);
  // Readiness is not permanent: a bounded cache can evict completed resources.
  void job.then(() => trailJobs.delete(key), () => trailJobs.delete(key));
  return job;
}
