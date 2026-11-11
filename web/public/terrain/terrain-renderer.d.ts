export type TerrainGrid = {
  schemaVersion: number;
  /** Continuous [west,south,east,north], east > west and span <= 360 degrees.
   * Dateline grids may extend beyond 180; source routes are wrapped to that world. */
  bounds: [number, number, number, number];
  width: number;
  height: number;
  elevations: number[];
  minElevation: number;
  maxElevation: number;
  units?: 'meters';
  rowOrder?: 'north-to-south';
  columnOrder?: 'west-to-east';
  sampleSpacingApproxM?: { eastWest: number; northSouth: number };
  source: { name: string; url: string; license: string; checkedAt: string; [key: string]: unknown };
  attribution?: string;
};
/** Prepared buffers are shared read-only after preparation; do not transfer them again from a cache. */
export type TerrainModel = {
  grid: TerrainGrid;
  widthM: number;
  heightM: number;
  width: number;
  height: number;
  scale: number;
  base: number;
  min: number;
  max: number;
  cellX: number;
  cellY: number;
  heights: Float32Array;
  normals: Float32Array;
  normalTexture: Uint8Array;
  shadowPyramid?: Array<{width: number; height: number; data: Float32Array}>;
};
export type TerrainPoint = [number, number, number];
/** Cartographic colour only. Pixels are georeferenced samples at the grid bounds,
 * with transparent coverage where the source has no available vector tile. */
export type TerrainCartography = {
  width: number; height: number; pixels: Uint8ClampedArray;
  source: {name: string; bounds: [number, number, number, number];
    projection: 'regular-longitude-latitude'; sampleLayout: 'grid-nodes';
    rowOrder: 'north-to-south'; columnOrder: 'west-to-east';
    requestedTiles: number; loadedTiles: number; [key: string]: unknown};
};
export function validateTerrainCartography(surface: TerrainCartography, grid: Pick<TerrainGrid, 'bounds'>): TerrainCartography;
export function sampleTerrainCartography(surface: TerrainCartography | null, u: number, v: number, output?: number[]): number[];
export type TerrainSegment = [TerrainPoint, TerrainPoint];
export type TerrainMesh = {uv: Float32Array; sampleIds: Uint32Array; indices: Uint16Array | Uint32Array; count: number; step: number; triangles: number};
export function validateTerrainGrid(grid: TerrainGrid): {min: number; max: number};
export function createTerrainModel(grid: TerrainGrid): TerrainModel;
export function createTerrainModelAsync(grid: TerrainGrid, options?: {signal?: AbortSignal}): Promise<TerrainModel>;
export function validatePreparedTerrainModel(grid: TerrainGrid, model: unknown): TerrainModel;
export function sampleElevation(model: TerrainModel, eastMetres: number, northMetres: number): number | null;
export function sampleTerrainMeshElevation(model: TerrainModel, eastMetres: number, northMetres: number, step: number): number | null;
export function buildTerrainMesh(model: TerrainModel, step: number): TerrainMesh;
export function selectTerrainMeshStride(grid: Pick<TerrainGrid, 'width' | 'height'>, budget: number, previous?: number, hardLimit?: number): number;
export function drapeTerrainRoute(model: TerrainModel, segments: TerrainSegment[], step: number): TerrainSegment[];
export function terrainRoute(model: TerrainModel, data: unknown): {segments: TerrainSegment[]; clipped: boolean; sourceSegments: number};
export function terrainLight(yaw: number, pitch: number): TerrainPoint;
export function clipTerrainSegment(a: number[], b: number[], bounds: number[]): [number[], number[]] | null;
export function sampleTerrainShadow(model: TerrainModel, eastMetres: number, northMetres: number, height: number, light: TerrainPoint, budget?: number, stats?: {queries?: number; limitReached?: boolean}): number;
export type TerrainRenderInfo = {
  /** CPU submission/drawing time. This is not a GPU duration or a phone FPS result. */
  ms: number;
  triangles: number;
  quality: 'motion' | 'full';
  renderer: 'webgl2' | 'canvas2d';
  pixelRatio: number;
  meshStride: number;
  sourceVertices: number;
  view: {yaw: number; pitch: number; zoom: number; offset: [number, number]};
  cartography: {loadedTiles: number; requestedTiles: number; width: number; height: number} | null;
};
export type TerrainViewportInsets = Partial<{top: number; right: number; bottom: number; left: number}>;
export type TerrainRendererOptions = {
  compactViewport?: boolean;
  preparedModel?: TerrainModel;
  /** Overlays in CSS pixels. Unspecified sides are zero; null uses compactViewport's legacy fallback. */
  viewportInsets?: TerrainViewportInsets | null;
  forceCanvas?: boolean;
  onRender?: (data: TerrainRenderInfo) => void;
  /** A recoverable context notification or a nonfatal route-data problem. */
  onError?: (message: string) => void;
  /** Graphics resources have been released. Invalidate readiness and recreate on retry. */
  onFatal?: (message: string) => void;
};
export class TerrainRenderer {
  constructor(canvas: HTMLCanvasElement, grid: TerrainGrid, options?: TerrainRendererOptions);
  readonly failed: boolean;
  setGeometry(data: unknown): { segments: number; clipped: boolean } | undefined;
  /** Retains an owned pixel copy; null clears cover colours. Heights never change. */
  setCartography(surface: TerrainCartography | null): void;
  setVisible(visible: boolean): void;
  setViewportInsets(insets: TerrainViewportInsets | null): void;
  /** Schedules one actual frame even while setVisible(false); repeated calls coalesce and do not start an idle loop. */
  warmup(): void;
  heightAt(eastMetres: number, northMetres: number): number | null;
  rotate(delta: number): void;
  zoomBy(factor: number): void;
  reset(): void;
  destroy(): void;
}
