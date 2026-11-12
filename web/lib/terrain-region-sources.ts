import type {TerrainGrid} from '../public/terrain/terrain-renderer.js';
import {longitudeNear, type GeographicBounds} from './custom-map-camera.ts';

export type TerrainRegionSource = {
  id: string; bounds: [number, number, number, number]; gridUrl: string; materialUrl: string;
  gridSha256: string; materialSha256: string; gridBytes: number; materialBytes: number;
  material: {width: number; height: number; bounds: [number, number, number, number]; source: string; nominalResolutionM: number; [key: string]: unknown};
  provenance: Record<string, unknown>;
};
const MAX_BYTES = 8 * 1024 * 1024;
const resource = (value: unknown): value is string => typeof value === 'string' && /^\/terrain-regions\/[a-z0-9][a-z0-9/_-]*\.(json|png)$/.test(value);
// Manifests and their checked asset bytes retain logical source URLs. The
// Pages transform changes only this replacement literal, never the validator.
const resourceURL = (value: string) => value.replace(/^\/terrain-regions\//, '/terrain-regions/');
const boundsOK = (b: unknown): b is [number, number, number, number] => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[2] - b[0] <= 360 && b[1] < b[3] && b[1] >= -85 && b[3] <= 85;
export function regionContainsBounds(outer: GeographicBounds, inner: GeographicBounds): boolean {
  const west = longitudeNear(inner[0], (outer[0] + outer[2]) / 2), east = inner[2] + (west - inner[0]), epsilon = 1e-9;
  return west >= outer[0] - epsilon && east <= outer[2] + epsilon && inner[1] >= outer[1] - epsilon && inner[3] <= outer[3] + epsilon;
}
export function parseTerrainRegions(input: unknown): TerrainRegionSource[] {
  const value = input as {schemaVersion?: number; regions?: TerrainRegionSource[]} | null;
  if (value?.schemaVersion !== 1 || !Array.isArray(value.regions) || value.regions.length > 128) throw new Error('Invalid regional terrain manifest');
  const ids = new Set<string>();
  return value.regions.map(region => {
    if (!region || !/^[a-z0-9-]+$/.test(region.id) || ids.has(region.id) || !boundsOK(region.bounds) || !resource(region.gridUrl) || !resource(region.materialUrl) ||
      !/^[a-f0-9]{64}$/.test(region.gridSha256) || !/^[a-f0-9]{64}$/.test(region.materialSha256) ||
      ![region.gridBytes, region.materialBytes].every(n => Number.isSafeInteger(n) && n > 0 && n <= MAX_BYTES) ||
      !region.material || !boundsOK(region.material.bounds) || JSON.stringify(region.material.bounds) !== JSON.stringify(region.bounds) ||
      ![region.material.width, region.material.height].every(n => Number.isInteger(n) && n >= 2 && n <= 2048)) throw new Error('Invalid regional terrain entry');
    ids.add(region.id); return region;
  });
}
export async function verifyRegionalBytes(bytes: ArrayBuffer, expectedBytes: number, sha256: string): Promise<void> {
  if (bytes.byteLength !== expectedBytes || bytes.byteLength > MAX_BYTES || !globalThis.crypto?.subtle) throw new Error('Regional terrain size or integrity verification unavailable');
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (actual !== sha256) throw new Error('Regional terrain checksum differs');
}
export function createTerrainRegionReader(deps: {loadJSON: (url: string) => Promise<unknown>; loadBytes: (url: string) => Promise<ArrayBuffer>}) {
  let manifest: Promise<TerrainRegionSource[]> | undefined;
  const find = async (bounds: GeographicBounds) => {
    manifest ??= deps.loadJSON('/terrain-regions/manifest.json').then(parseTerrainRegions).catch(error => {manifest = undefined; throw error;});
    let regions: TerrainRegionSource[];
    try {regions = await manifest;} catch {return undefined;}
    return regions.filter(region => regionContainsBounds(region.bounds, bounds)).sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]))[0];
  };
  return {find, async grid(region: TerrainRegionSource): Promise<TerrainGrid> {
    const bytes = await deps.loadBytes(resourceURL(region.gridUrl)); await verifyRegionalBytes(bytes, region.gridBytes, region.gridSha256);
    const grid = JSON.parse(new TextDecoder().decode(bytes)) as TerrainGrid;
    if (JSON.stringify(grid.bounds) !== JSON.stringify(region.bounds)) throw new Error('Regional DEM and manifest bounds differ');
    const {validateTerrainGrid} = await import('../public/terrain/terrain-renderer.js'); validateTerrainGrid(grid);
    return grid;
  }, async material(region: TerrainRegionSource) {
    const bytes = await deps.loadBytes(resourceURL(region.materialUrl)); await verifyRegionalBytes(bytes, region.materialBytes, region.materialSha256); return bytes;
  }};
}
