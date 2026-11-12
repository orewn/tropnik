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
/** A display restriction, independent of DEM values and cartographic opacity.
 * Each pixel is an entire geographic cell: 0 excludes it and 255 permits it. */
export type TerrainDisplayMask={width:number;height:number;pixels:Uint8Array;source:{
  scope:'russia-display-area';coverageVersion:string;lod:'overview'|'regional'|'local'|'source';cells:string[];
  bounds:[number,number,number,number];projection:'regular-longitude-latitude';sampleLayout:'pixel-cells';
  rowOrder:'north-to-south';columnOrder:'west-to-east';boundaryRule:'exclude-intersecting-texels';allowedPixels:number;
}};
export function validateTerrainDisplayMask(mask:TerrainDisplayMask,grid:Pick<TerrainGrid,'bounds'>):TerrainDisplayMask;
export function sampleTerrainDisplayMask(mask:TerrainDisplayMask|null,u:number,v:number):boolean;
/** Cartographic colour only. Pixels are georeferenced samples at the grid bounds,
 * with transparent coverage where the source has no available sample. */
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
export type TerrainMesh = {uv: Float32Array; sampleIds: Uint32Array; indices: Uint16Array | Uint32Array; count: number; step: number; triangles: number; window?:[number,number,number,number]};
export function validateTerrainGrid(grid: TerrainGrid): {min: number; max: number};
export function createTerrainModel(grid: TerrainGrid): TerrainModel;
export function createTerrainModelAsync(grid: TerrainGrid, options?: {signal?: AbortSignal}): Promise<TerrainModel>;
export function validatePreparedTerrainModel(grid: TerrainGrid, model: unknown): TerrainModel;
export function sampleElevation(model: TerrainModel, eastMetres: number, northMetres: number): number | null;
export function sampleTerrainMeshElevation(model: TerrainModel, eastMetres: number, northMetres: number, step: number): number | null;
export function buildTerrainMesh(model: TerrainModel, step: number, window?:[number,number,number,number]|null): TerrainMesh;
export function visibleTerrainSampleWindow(model: TerrainModel, camera:{matrix:ArrayLike<number>;offset:number[]}):[number,number,number,number]|null;
export function selectVisibleTerrainMesh(model: TerrainModel, camera:{matrix:ArrayLike<number>;offset:number[]}, budget:number, previous?:number):{step:number;range:[number,number,number,number];count:number};
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
  /** Bounded diagnostic evidence; a compatible software frame can still be ready. */
  graphicsFallback?:{stage:'context-create'|'initialization'|'context-timeout'|'context-restoration'|'cartography'|'render';reason:string}|null;
  pixelRatio: number;
  meshStride: number;
  sourceVertices: number;
  view: {yaw: number; pitch: number; zoom: number; offset: [number, number]};
  /** Geographic state of this completed frame, including its actual camera distance. */
  geographicView: TerrainGeographicView;
  viewport:{width:number;height:number;insets:{top:number;right:number;bottom:number;left:number}};
  /** Source-grid sample bounds for a visible map window; null is legacy full-grid rendering. */
  meshWindow:[number,number,number,number]|null;
  renderedVertices:number;
  cartography: {loadedTiles: number; requestedTiles: number; width: number; height: number} | null;
  displayMask:{width:number;height:number;allowedPixels:number;coverageVersion:string}|null;
};
export type TerrainViewportInsets = Partial<{top: number; right: number; bottom: number; left: number}>;
export type TerrainGeographicView = {
  /** Longitude stays continuous near the current grid, including across the dateline. */
  longitude: number; latitude: number; yaw: number; pitch: number; distanceM: number;
  zoom: number; bounds: [number,number,number,number];
};
export type TerrainViewInput = Pick<TerrainGeographicView,'longitude'|'latitude'|'yaw'|'pitch'|'distanceM'>;
export type TerrainViewReason = 'gesture'|'wheel'|'keyboard'|'rotate'|'zoom'|'reset';
export type TerrainRendererOptions = {
  /** Map: primary drag pans; Shift/right drag orbits. Existing orbit mode is unchanged. */
  navigation?: 'orbit'|'map';
  initialView?: TerrainViewInput;
  /** One event after navigation settles. setView/setTerrain do not emit it. */
  onViewChange?: (view: TerrainGeographicView, reason: TerrainViewReason) => void;
  compactViewport?: boolean;
  preparedModel?: TerrainModel;
  /** Validated and copied before the first frame; preserved across context recovery. */
  displayMask?:TerrainDisplayMask;
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
  getView(): TerrainGeographicView;
  setView(view: TerrainViewInput): void;
  /** Validates/allocates before replacement; retains geographic camera distance and last completed canvas.
   * Cartography and routes are reset; the host supplies those for the new bounds.
   * An omitted displayMask clears the old mask; do not omit it for a restricted display area. */
  setTerrain(grid: TerrainGrid, options?: {preparedModel?: TerrainModel; displayMask?: TerrainDisplayMask|null}): void;
  /** CSS pixels relative to canvas; depth is clip-space. Does not test intervening ridge occlusion. */
  project(longitude:number, latitude:number, elevationM?:number): {x:number;y:number;depth:number}|null;
  /** Exact active LOD triangle hit; null for sky, uncovered area, or outside the canvas. */
  unproject(x:number,y:number): {longitude:number;latitude:number;elevationM:number}|null;
  panBy(dx:number,dy:number): void;
  setGeometry(data: unknown): { segments: number; clipped: boolean } | undefined;
  /** Retains an owned pixel copy; null clears cover colours. Heights never change. */
  setCartography(surface: TerrainCartography | null): void;
  setVisible(visible: boolean): void;
  /** Map mode preserves physical distance across overlay and canvas-size changes. */
  setViewportInsets(insets: TerrainViewportInsets | null): void;
  /** Schedules one actual frame even while setVisible(false); repeated calls coalesce and do not start an idle loop. */
  warmup(): void;
  heightAt(eastMetres: number, northMetres: number): number | null;
  rotate(delta: number): void;
  zoomBy(factor: number): void;
  reset(): void;
  destroy(): void;
}
