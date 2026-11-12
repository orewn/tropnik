import type {TerrainGeographicView, TerrainViewInput, TerrainViewportInsets} from '../public/terrain/terrain-renderer.js';
import type {GeographicBounds, MapViewport} from './custom-map-camera.ts';
import {continuousBounds, longitudeNear} from './custom-map-camera.ts';

/** Continuous eastern longitudes are intentional: Chukotka is adjacent to the dateline. */
export const TERRAIN_DISPLAY_BOUNDS: GeographicBounds = [19.6389282, 41.1858711, 191.0026658, 81.858721];
const RADIANS = Math.PI / 180;
const METRES_PER_DEGREE = 6371008.8 * RADIANS;
const HALF_FOV = 21 * RADIANS;
const GUARD = .22;
const MIN_SOURCE_SPACING_M = 30;
const DEFAULT_GRID_INTERVALS = 512;
const MIN_REQUEST_SPAN_M = MIN_SOURCE_SPACING_M * 64;
const MAX_CAMERA_DISTANCE_M = 40075016.68557849;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
export type TerrainNavigationPlan = {bounds: [number, number, number, number]; view: TerrainViewInput};
export type TerrainNavigationViewport = MapViewport & {insets?: TerrainViewportInsets};

function viewportSize(viewport: TerrainNavigationViewport) {
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new RangeError('Terrain navigation viewport must have positive finite dimensions');
  const {width, height} = viewport, inset = (key: keyof TerrainViewportInsets) => {
    const value = viewport.insets?.[key]; return Number.isFinite(value) ? Math.max(0, value!) : 0;
  };
  // Match the renderer's physical projection, including its minimum clear band.
  // Insets move the camera target within the canvas; they do not crop rendering.
  const rawLeft = inset('left'), rawRight = inset('right'), rawTop = inset('top'), rawBottom = inset('bottom');
  const horizontal = rawLeft + rawRight, vertical = rawTop + rawBottom;
  const sx = horizontal ? Math.min(1, width * .88 / horizontal) : 1, sy = vertical ? Math.min(1, height * .88 / vertical) : 1;
  const left = rawLeft * sx, right = rawRight * sx, top = rawTop * sy, bottom = rawBottom * sy;
  const usableW = Math.max(1, width - left - right), usableH = Math.max(1, height - top - bottom);
  return {width, height, left, right, top, bottom, usableW, usableH, aspect: usableW / usableH};
}
function displayBounds(input: GeographicBounds): [number, number, number, number] {
  const bounds = continuousBounds(input);
  if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3] || bounds[2] - bounds[0] > 360 || bounds[1] < -85 || bounds[3] > 85) throw new RangeError('Invalid terrain navigation bounds');
  const center = longitudeNear((bounds[0] + bounds[2]) / 2, (TERRAIN_DISPLAY_BOUNDS[0] + TERRAIN_DISPLAY_BOUNDS[2]) / 2), half = (bounds[2] - bounds[0]) / 2;
  const clipped: [number, number, number, number] = [Math.max(TERRAIN_DISPLAY_BOUNDS[0], center - half), Math.max(TERRAIN_DISPLAY_BOUNDS[1], bounds[1]), Math.min(TERRAIN_DISPLAY_BOUNDS[2], center + half), Math.min(TERRAIN_DISPLAY_BOUNDS[3], bounds[3])];
  if (clipped[0] >= clipped[2] || clipped[1] >= clipped[3]) throw new RangeError('Terrain navigation bounds do not intersect the display area');
  return clipped;
}
function geographicView(input: TerrainViewInput): TerrainViewInput {
  if (!input || !['longitude', 'latitude', 'yaw', 'pitch', 'distanceM'].every(key => Number.isFinite(input[key as keyof TerrainViewInput])) || input.distanceM <= 0) throw new RangeError('Invalid terrain geographic view');
  const longitude = longitudeNear(input.longitude, (TERRAIN_DISPLAY_BOUNDS[0] + TERRAIN_DISPLAY_BOUNDS[2]) / 2);
  return {longitude: clamp(longitude, TERRAIN_DISPLAY_BOUNDS[0], TERRAIN_DISPLAY_BOUNDS[2]), latitude: clamp(input.latitude, TERRAIN_DISPLAY_BOUNDS[1], TERRAIN_DISPLAY_BOUNDS[3]),
    yaw: ((input.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI,
    pitch: clamp(input.pitch, .28, 1.32), distanceM: clamp(input.distanceM, 30, MAX_CAMERA_DISTANCE_M)};
}
function metricSize(bounds: GeographicBounds, latitude: number) {
  return {width: (bounds[2] - bounds[0]) * METRES_PER_DEGREE * Math.cos(latitude * RADIANS), height: (bounds[3] - bounds[1]) * METRES_PER_DEGREE};
}
function contains(outer: GeographicBounds, inner: GeographicBounds) {
  const tolerance = 1e-8;
  return inner[0] >= outer[0] - tolerance && inner[1] >= outer[1] - tolerance && inner[2] <= outer[2] + tolerance && inner[3] <= outer[3] + tolerance;
}
function sameBounds(a: GeographicBounds, b: GeographicBounds) {return a.every((value, index) => Math.abs(value - b[index]) < 1e-8);}

/** Camera target stays at the 2D context's centre. Distance preserves its ground
 * scale at that centre, accounting for oblique foreshortening and viewport aspect.
 * The actual source window can be larger; pass this view through the planner
 * before the initial load when the whole tilted frustum must already be covered. */
export function openingTerrainView(bounds: GeographicBounds, viewport: TerrainNavigationViewport): TerrainViewInput {
  const b = displayBounds(bounds), {aspect} = viewportSize(viewport), latitude = (b[1] + b[3]) / 2, size = metricSize(b, latitude), pitch = .85;
  const distanceM = Math.max(size.width / (2 * Math.tan(HALF_FOV) * aspect), size.height * Math.sin(pitch) / (2 * Math.tan(HALF_FOV)));
  return geographicView({longitude: (b[0] + b[2]) / 2, latitude, yaw: 0, pitch, distanceM});
}

/** Ground-plane intersections of the renderer's 42° frustum, in metres relative
 * to its geographic target. At low pitch the upper screen is sky; horizon rays
 * use a finite eight-distance budget, never an infinite tile request. This is a
 * source-coverage envelope, not a claim that the terrain itself is a flat plane. */
function frustum(view: TerrainViewInput, viewport: ReturnType<typeof viewportSize>) {
  const tan = Math.tan(HALF_FOV), sin = Math.sin(view.pitch), cos = Math.cos(view.pitch), cr = Math.cos(view.yaw), sr = Math.sin(view.yaw);
  const {width, height, left, right, top, bottom, usableH} = viewport;
  // Full-canvas rays use the same projection offset as cameraFor. Using only
  // the unobscured rectangle would leave holes around a moved sheet or HUD.
  const horizontal = [(-width - left + right) * tan / usableH, (width - left + right) * tan / usableH];
  const vertical = [(-height - bottom + top) * tan / usableH, (height - bottom + top) * tan / usableH];
  let west = 0, east = 0, south = 0, north = 0;
  for (const sy of vertical) for (const sx of horizontal) {
    const denominator = sin - sy * cos;
    const rayDistance = denominator > 0 ? Math.min(view.distanceM * 8, view.distanceM * sin / denominator) : view.distanceM * 8;
    const across = rayDistance * sx;
    const away = rayDistance * (cos + sin * sy) - view.distanceM * cos;
    const x = across * cr - away * sr, y = across * sr + away * cr;
    west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y);
  }
  return {west, east, south, north};
}
function requestBounds(view: TerrainViewInput, footprint: ReturnType<typeof frustum>, guard: number): [number, number, number, number] {
  const width = Math.max(MIN_REQUEST_SPAN_M, footprint.east - footprint.west), height = Math.max(MIN_REQUEST_SPAN_M, footprint.north - footprint.south);
  const x = (footprint.east + footprint.west) / 2, y = (footprint.north + footprint.south) / 2, longitudeMetres = METRES_PER_DEGREE * Math.cos(view.latitude * RADIANS);
  return [Math.max(TERRAIN_DISPLAY_BOUNDS[0], view.longitude + (x - width * (.5 + guard)) / longitudeMetres),
    Math.max(TERRAIN_DISPLAY_BOUNDS[1], view.latitude + (y - height * (.5 + guard)) / METRES_PER_DEGREE),
    Math.min(TERRAIN_DISPLAY_BOUNDS[2], view.longitude + (x + width * (.5 + guard)) / longitudeMetres),
    Math.min(TERRAIN_DISPLAY_BOUNDS[3], view.latitude + (y + height * (.5 + guard)) / METRES_PER_DEGREE)];
}

/** Pure window planner. The host keeps its current rendered frame while loading
 * this result and calls renderer.setTerrain only after the replacement is ready.
 * sourceSpacingM is the effective coarsest source/grid spacing, not a fabricated
 * accuracy figure. A native 30 m region is reused at closer zooms even when its
 * returned bounds are much larger than a requested window. */
export function planTerrainNavigation(input: TerrainGeographicView | TerrainViewInput, currentGridBounds: GeographicBounds, viewport: TerrainNavigationViewport, sourceSpacingM?: number): TerrainNavigationPlan | null {
  const projection = viewportSize(viewport), current = displayBounds(currentGridBounds), view = geographicView(input);
  if (sourceSpacingM !== undefined && (!Number.isFinite(sourceSpacingM) || sourceSpacingM <= 0)) throw new RangeError('Terrain source spacing must be positive and finite');
  const footprint = frustum(view, projection), required = requestBounds(view, footprint, 0), desired = requestBounds(view, footprint, GUARD);
  const currentSize = metricSize(current, view.latitude), desiredSize = metricSize(desired, view.latitude);
  const effectiveSpacing = sourceSpacingM ?? Math.max(currentSize.width, currentSize.height) / DEFAULT_GRID_INTERVALS;
  const resolutionAvailable = effectiveSpacing > MIN_SOURCE_SPACING_M * 1.05;
  const refinementRatio = Math.max(currentSize.width, currentSize.height) / Math.max(desiredSize.width, desiredSize.height);
  const refine = resolutionAvailable && refinementRatio >= 2;
  const moved = Math.abs((desired[0] + desired[2]) - (current[0] + current[2])) / 2 > (current[2] - current[0]) * .2 ||
    Math.abs((desired[1] + desired[3]) - (current[1] + current[3])) / 2 > (current[3] - current[1]) * .2;
  // Small movement stays within the guard. Native detail already covers any
  // contained footprint: do not recentre/reload the same regional package.
  const recenter = resolutionAvailable && moved && !contains(current, desired);
  const outside = !contains(current, required);
  const adjusted = ['longitude', 'latitude', 'yaw', 'pitch', 'distanceM'].some(key => Math.abs(view[key as keyof TerrainViewInput] - input[key as keyof TerrainViewInput]) > 1e-8);
  if (!outside && !refine && !recenter) return adjusted ? {bounds: current, view} : null;
  if (sameBounds(desired, current)) return adjusted ? {bounds: current, view} : null;
  return {bounds: desired, view};
}
