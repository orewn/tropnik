/** Geographic camera math for our renderers. All screen coordinates are CSS
 * pixels; devicePixelRatio belongs exclusively to the drawing surface. */
export const CUSTOM_MAP_TILE_SIZE = 256;
export const MERCATOR_MAX_LATITUDE = 85.0511287798066;

export type MapPoint = {x: number; y: number};
export type MapViewport = {width: number; height: number};
export type MapInsets = {top: number; right: number; bottom: number; left: number};
export type GeographicPosition = readonly number[];
export type GeographicBounds = readonly [west: number, south: number, east: number, north: number];
export type CustomMapCamera = {center: readonly [number, number]; zoom: number; bearingDegrees?: number};
export type MapZoomLimits = {minZoom?: number; maxZoom?: number};
export type MapFitOptions = MapZoomLimits & {
  padding?: number | Partial<MapInsets>;
  bearingDegrees?: number;
  referenceLongitude?: number;
};
export type MapProjectionOptions = {wrapLongitude?: boolean};
type Transform = {center: MapPoint; scale: number; cosine: number; sine: number; viewport: MapViewport};

const radians = Math.PI / 180;
// A fit behind asymmetric overlays can place its centre beyond the visible
// tile world. Constraining that centre to 85.05 degrees clips high-latitude
// features when the camera is rotated. Geometry itself keeps the tile limit.
const MAX_CAMERA_LATITUDE = 89.999999;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const finite = (value: number, name: string) => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
};
function validPoint(point: MapPoint) {
  finite(point.x, 'x'); finite(point.y, 'y');
}
function validViewport(viewport: MapViewport) {
  if (!(finite(viewport.width, 'width') > 0) || !(finite(viewport.height, 'height') > 0)) throw new RangeError('Viewport must have positive dimensions');
}
function worldSize(zoom: number) {
  const size = CUSTOM_MAP_TILE_SIZE * 2 ** finite(zoom, 'zoom');
  if (!Number.isFinite(size) || size <= 0) throw new RangeError('Zoom exceeds numeric projection range');
  return size;
}
export function normalizeBearing(bearingDegrees = 0) {
  return ((finite(bearingDegrees, 'bearing') + 180) % 360 + 360) % 360 - 180;
}
/** Keep a longitude in the closest continuous world, including eastern Russia
 * beyond 180 degrees. Do not normalize the camera to [-180,180] on every move. */
export function longitudeNear(longitude: number, referenceLongitude: number) {
  finite(longitude, 'longitude'); finite(referenceLongitude, 'reference longitude');
  return longitude + 360 * Math.round((referenceLongitude - longitude) / 360);
}
/** Unit Web Mercator coordinates. x is deliberately not wrapped. */
function projectMercatorPosition(coordinate: GeographicPosition, maximumLatitude: number): MapPoint {
  const longitude = finite(coordinate[0], 'longitude');
  const latitude = clamp(finite(coordinate[1], 'latitude'), -maximumLatitude, maximumLatitude);
  return {x: (longitude + 180) / 360, y: (1 - Math.asinh(Math.tan(latitude * radians)) / Math.PI) / 2};
}
export function mercatorProject(coordinate: GeographicPosition): MapPoint {
  return projectMercatorPosition(coordinate, MERCATOR_MAX_LATITUDE);
}
export function mercatorUnproject(point: MapPoint): [number, number] {
  validPoint(point);
  return [point.x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * point.y))) / radians];
}
function transform(camera: CustomMapCamera, viewport: MapViewport): Transform {
  validViewport(viewport);
  const bearing = normalizeBearing(camera.bearingDegrees) * radians;
  return {center: projectMercatorPosition(camera.center, MAX_CAMERA_LATITUDE), scale: worldSize(camera.zoom), cosine: Math.cos(bearing), sine: Math.sin(bearing), viewport};
}
function worldToScreen(value: MapPoint, view: Transform): MapPoint {
  const x = (value.x - view.center.x) * view.scale, y = (value.y - view.center.y) * view.scale;
  // Bearing is the clockwise geographic direction at the top of the screen.
  // At bearing 90, east is up and north is left.
  return {x: view.viewport.width / 2 + view.cosine * x + view.sine * y,
    y: view.viewport.height / 2 - view.sine * x + view.cosine * y};
}
function screenToWorld(point: MapPoint, view: Transform): MapPoint {
  const x = point.x - view.viewport.width / 2, y = point.y - view.viewport.height / 2;
  return {x: view.center.x + (view.cosine * x - view.sine * y) / view.scale,
    y: view.center.y + (view.sine * x + view.cosine * y) / view.scale};
}
export function project(camera: CustomMapCamera, viewport: MapViewport, coordinate: GeographicPosition, options: MapProjectionOptions = {}): MapPoint {
  const point = mercatorProject(coordinate), view = transform(camera, viewport);
  if (options.wrapLongitude !== false) point.x += Math.round(view.center.x - point.x);
  return worldToScreen(point, view);
}
export function unproject(camera: CustomMapCamera, viewport: MapViewport, point: MapPoint): [number, number] {
  validPoint(point);
  return mercatorUnproject(screenToWorld(point, transform(camera, viewport)));
}
export const geographicToScreen = project;
export const screenToGeographic = unproject;

/** Preserve a path across the dateline instead of choosing each vertex's world
 * independently. Pass wrapLongitude:false for already unwrapped global masks. */
export function projectPath(camera: CustomMapCamera, viewport: MapViewport, coordinates: readonly GeographicPosition[], options: MapProjectionOptions = {}, referenceLongitude = camera.center[0]): MapPoint[] {
  const view = transform(camera, viewport), wrap = options.wrapLongitude !== false;
  let reference = finite(referenceLongitude, 'reference longitude');
  return coordinates.map(coordinate => {
    const longitude = wrap ? longitudeNear(coordinate[0], reference) : finite(coordinate[0], 'longitude');
    reference = longitude;
    return worldToScreen(mercatorProject([longitude, coordinate[1]]), view);
  });
}

function limitZoom(zoom: number, limits: MapZoomLimits) {
  const minimum = limits.minZoom ?? -Infinity, maximum = limits.maxZoom ?? Infinity;
  if (Number.isNaN(minimum) || Number.isNaN(maximum) || minimum > maximum) throw new RangeError('Invalid zoom limits');
  const result = clamp(finite(zoom, 'zoom'), minimum, maximum);
  worldSize(result);
  return result;
}
function cameraAtWorld(center: MapPoint, zoom: number, bearingDegrees: number): CustomMapCamera {
  const north = projectMercatorPosition([0, MAX_CAMERA_LATITUDE], MAX_CAMERA_LATITUDE).y;
  return {center: mercatorUnproject({x: center.x, y: clamp(center.y, north, 1 - north)}), zoom, bearingDegrees: normalizeBearing(bearingDegrees)};
}
/** Move the drawn map by delta: dragging right moves its geographic centre west. */
export function pan(camera: CustomMapCamera, delta: MapPoint): CustomMapCamera {
  validPoint(delta);
  const bearing = normalizeBearing(camera.bearingDegrees) * radians, scale = worldSize(camera.zoom), center = projectMercatorPosition(camera.center, MAX_CAMERA_LATITUDE);
  return cameraAtWorld({x: center.x - (Math.cos(bearing) * delta.x - Math.sin(bearing) * delta.y) / scale,
    y: center.y - (Math.sin(bearing) * delta.x + Math.cos(bearing) * delta.y) / scale}, camera.zoom, camera.bearingDegrees ?? 0);
}
function anchoredCamera(anchor: MapPoint, screen: MapPoint, viewport: MapViewport, zoom: number, bearingDegrees: number): CustomMapCamera {
  const bearing = normalizeBearing(bearingDegrees) * radians, scale = worldSize(zoom);
  const x = screen.x - viewport.width / 2, y = screen.y - viewport.height / 2;
  return cameraAtWorld({x: anchor.x - (Math.cos(bearing) * x - Math.sin(bearing) * y) / scale,
    y: anchor.y - (Math.sin(bearing) * x + Math.cos(bearing) * y) / scale}, zoom, bearingDegrees);
}
/** Keep the geographic point under the pointer fixed, even when zoom is clamped. */
export function zoomAt(camera: CustomMapCamera, viewport: MapViewport, targetZoom: number, anchor: MapPoint = {x: viewport.width / 2, y: viewport.height / 2}, limits: MapZoomLimits = {}): CustomMapCamera {
  validPoint(anchor);
  return anchoredCamera(screenToWorld(anchor, transform(camera, viewport)), anchor, viewport, limitZoom(targetZoom, limits), camera.bearingDegrees ?? 0);
}
export function rotateAt(camera: CustomMapCamera, viewport: MapViewport, bearingDegrees: number, anchor: MapPoint = {x: viewport.width / 2, y: viewport.height / 2}): CustomMapCamera {
  validPoint(anchor);
  return anchoredCamera(screenToWorld(anchor, transform(camera, viewport)), anchor, viewport, camera.zoom, normalizeBearing(bearingDegrees));
}
function insets(value: MapFitOptions['padding']): MapInsets {
  const source = typeof value === 'number' ? {top: value, right: value, bottom: value, left: value} : value ?? {};
  const result = {top: source.top ?? 0, right: source.right ?? 0, bottom: source.bottom ?? 0, left: source.left ?? 0};
  for (const [name, amount] of Object.entries(result)) if (finite(amount, name) < 0) throw new RangeError('Map insets cannot be negative');
  return result;
}
/** west > east explicitly crosses the dateline. west <= east retains its
 * declared span, including a deliberately wide/global frame. */
export function continuousBounds(bounds: GeographicBounds, referenceLongitude?: number): GeographicBounds {
  let [west, south, east, north] = bounds;
  for (const value of bounds) finite(value, 'bounds');
  if (south > north) throw new RangeError('South must not exceed north');
  if (east < west) east += 360 * Math.ceil((west - east) / 360);
  if (referenceLongitude !== undefined) {
    const shift = longitudeNear((west + east) / 2, referenceLongitude) - (west + east) / 2;
    west += shift; east += shift;
  }
  south = clamp(south, -MERCATOR_MAX_LATITUDE, MERCATOR_MAX_LATITUDE);
  north = clamp(north, -MERCATOR_MAX_LATITUDE, MERCATOR_MAX_LATITUDE);
  return [west, south, east, north];
}
export function fitBounds(bounds: GeographicBounds, viewport: MapViewport, options: MapFitOptions = {}): CustomMapCamera {
  validViewport(viewport);
  const padding = insets(options.padding), width = viewport.width - padding.left - padding.right, height = viewport.height - padding.top - padding.bottom;
  if (width <= 0 || height <= 0) throw new RangeError('Insets leave no map viewport');
  const [west, south, east, north] = continuousBounds(bounds, options.referenceLongitude), sw = mercatorProject([west, south]), ne = mercatorProject([east, north]);
  const center = {x: (sw.x + ne.x) / 2, y: (sw.y + ne.y) / 2}, bearing = normalizeBearing(options.bearingDegrees), angle = bearing * radians;
  const spanX = Math.abs(Math.cos(angle)) * (ne.x - sw.x) + Math.abs(Math.sin(angle)) * (sw.y - ne.y);
  const spanY = Math.abs(Math.sin(angle)) * (ne.x - sw.x) + Math.abs(Math.cos(angle)) * (sw.y - ne.y);
  const scale = Math.min(spanX > 0 ? width / spanX : Infinity, spanY > 0 ? height / spanY : Infinity);
  const maximum = options.maxZoom ?? 18;
  const zoom = limitZoom(Number.isFinite(scale) ? Math.log2(scale / CUSTOM_MAP_TILE_SIZE) : maximum, {...options, maxZoom: maximum});
  return anchoredCamera(center, {x: padding.left + width / 2, y: padding.top + height / 2}, viewport, zoom, bearing);
}
/** Envelope of four screen corners, optionally excluding the same insets used
 * for framing. The camera stays fixed, in one continuous longitude domain. */
export function cameraBounds(camera: CustomMapCamera, viewport: MapViewport, padding?: MapFitOptions['padding']): GeographicBounds {
  const view = transform(camera, viewport), inset = insets(padding);
  const left = inset.left, right = viewport.width - inset.right, top = inset.top, bottom = viewport.height - inset.bottom;
  if (right <= left || bottom <= top) throw new RangeError('Insets leave no map viewport');
  const corners = [{x: left, y: top}, {x: right, y: top}, {x: right, y: bottom}, {x: left, y: bottom}];
  const points = corners.map(point => mercatorUnproject(screenToWorld(point, view)));
  return [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])), Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
}

type PointPair = readonly [MapPoint, MapPoint];
const midpoint = (points: PointPair): MapPoint => ({x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2});
const separation = (points: PointPair) => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
/** Simultaneous two-finger translation and zoom. Optional twist rotates the map
 * with the fingers; it never changes terrain pitch. */
export function pinch(camera: CustomMapCamera, viewport: MapViewport, start: PointPair, current: PointPair, limits: MapZoomLimits = {}, rotate = false): CustomMapCamera {
  [...start, ...current].forEach(validPoint);
  const original = midpoint(start), anchor = screenToWorld(original, transform(camera, viewport));
  const from = separation(start), to = separation(current), ratio = from >= 1 && to >= 1 ? to / from : 1;
  const zoom = limitZoom(camera.zoom + Math.log2(ratio), limits);
  const turn = rotate && from >= 1 && to >= 1 ? normalizeBearing((Math.atan2(current[1].y - current[0].y, current[1].x - current[0].x) - Math.atan2(start[1].y - start[0].y, start[1].x - start[0].x)) / radians) : 0;
  return anchoredCamera(anchor, midpoint(current), viewport, zoom, (camera.bearingDegrees ?? 0) - turn);
}

type PointerBasis = {camera: CustomMapCamera; viewport: MapViewport; contacts: {id: number; point: MapPoint}[]};
export type MapPointerOptions = MapZoomLimits & {rotate?: boolean};
/** DOM-free pointer ownership. Rebase when fingers are added/removed so the
 * remaining finger continues from the displayed camera without a jump. */
export class CustomMapPointerSession {
  private contacts = new Map<number, MapPoint>();
  private basis?: PointerBasis;
  private current?: CustomMapCamera;
  private viewport?: MapViewport;
  private options: MapPointerOptions;
  constructor(options: MapPointerOptions = {}) {this.options = {...options};}
  get activePointers() {return this.contacts.size;}
  begin(id: number, point: MapPoint, camera: CustomMapCamera, viewport: MapViewport) {
    finite(id, 'pointer id'); validPoint(point); transform(camera, viewport);
    this.contacts.set(id, {...point});
    this.current = {...camera, center: [...camera.center]}; this.viewport = {...viewport};
    this.rebase();
  }
  move(id: number, point: MapPoint): CustomMapCamera | undefined {
    if (!this.contacts.has(id) || !this.basis) return;
    validPoint(point); this.contacts.set(id, {...point});
    const {camera, viewport, contacts} = this.basis;
    if (!contacts.some(contact => contact.id === id)) return;
    if (contacts.length === 1) {
      const previous = contacts[0].point, next = this.contacts.get(contacts[0].id)!;
      this.current = pan(camera, {x: next.x - previous.x, y: next.y - previous.y});
    } else {
      this.current = pinch(camera, viewport, [contacts[0].point, contacts[1].point], [this.contacts.get(contacts[0].id)!, this.contacts.get(contacts[1].id)!], this.options, this.options.rotate);
    }
    return {...this.current, center: [...this.current.center]};
  }
  end(id: number) {
    if (!this.contacts.delete(id)) return;
    if (!this.contacts.size) {this.cancel(); return;}
    this.rebase();
  }
  /** Cancel on navigation, resize, lost ownership, blur, or teardown. */
  cancel() {this.contacts.clear(); this.basis = undefined; this.current = undefined; this.viewport = undefined;}
  private rebase() {
    if (!this.current || !this.viewport) return;
    this.basis = {camera: {...this.current, center: [...this.current.center]}, viewport: {...this.viewport}, contacts: [...this.contacts].slice(0, 2).map(([id, point]) => ({id, point: {...point}}))};
  }
}

/** DOM_DELTA_PIXEL/LINE/PAGE normalized without assuming one wheel device. */
export function normalizeWheelDelta(deltaY: number, deltaMode = 0, viewportHeight = 800, lineHeight = 16) {
  finite(deltaY, 'wheel delta');
  if (deltaMode === 0) return deltaY;
  const amount = deltaMode === 1 ? lineHeight : deltaMode === 2 ? viewportHeight : NaN;
  if (!Number.isFinite(amount) || amount <= 0) throw new RangeError('Invalid wheel mode or dimensions');
  return deltaY * amount;
}
export function wheelZoomDelta(deltaY: number, deltaMode = 0, viewportHeight = 800, pixelsPerZoom = 480) {
  if (!(finite(pixelsPerZoom, 'pixels per zoom') > 0)) throw new RangeError('Wheel zoom sensitivity must be positive');
  return -normalizeWheelDelta(deltaY, deltaMode, viewportHeight) / pixelsPerZoom;
}
export function keyboardCameraAction(camera: CustomMapCamera, viewport: MapViewport, key: string, options: MapZoomLimits & {panPixels?: number; zoomStep?: number; anchor?: MapPoint} = {}): CustomMapCamera | undefined {
  const distance = finite(options.panPixels ?? 80, 'keyboard pan'), step = finite(options.zoomStep ?? 1, 'keyboard zoom');
  if (distance < 0 || step < 0) throw new RangeError('Keyboard steps cannot be negative');
  const delta: Record<string, MapPoint> = {ArrowLeft: {x: distance, y: 0}, ArrowRight: {x: -distance, y: 0}, ArrowUp: {x: 0, y: distance}, ArrowDown: {x: 0, y: -distance}};
  if (delta[key]) return pan(camera, delta[key]);
  if (['+', '=', 'Add', 'PageUp'].includes(key)) return zoomAt(camera, viewport, camera.zoom + step, options.anchor, options);
  if (['-', '−', 'Subtract', 'PageDown'].includes(key)) return zoomAt(camera, viewport, camera.zoom - step, options.anchor, options);
}

export type MapLineHit = {distance: number; segmentIndex: number; fraction: number; point: MapPoint};
export function pointToSegment(point: MapPoint, start: MapPoint, end: MapPoint): Omit<MapLineHit, 'segmentIndex'> {
  const dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy;
  const fraction = length ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0, 1) : 0;
  const nearest = {x: start.x + dx * fraction, y: start.y + dy * fraction};
  return {distance: Math.hypot(point.x - nearest.x, point.y - nearest.y), fraction, point: nearest};
}
export function hitPolyline(point: MapPoint, line: readonly MapPoint[], tolerance = 8): MapLineHit | undefined {
  if (finite(tolerance, 'hit tolerance') < 0) throw new RangeError('Hit tolerance cannot be negative');
  let nearest: MapLineHit | undefined;
  for (let index = 1; index < line.length; index++) {
    const hit = pointToSegment(point, line[index - 1], line[index]);
    if (hit.distance <= tolerance && (!nearest || hit.distance < nearest.distance)) nearest = {...hit, segmentIndex: index - 1};
  }
  return nearest;
}
export function pointInRing(point: MapPoint, ring: readonly MapPoint[]): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[previous], b = ring[index];
    if (pointToSegment(point, a, b).distance <= 1e-7) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
/** Holes (including their edges) do not select the filled polygon. */
export function hitPolygon(point: MapPoint, rings: readonly (readonly MapPoint[])[]): boolean {
  return !!rings.length && pointInRing(point, rings[0]) && !rings.slice(1).some(ring => pointInRing(point, ring));
}
export type MapHitGeometry =
  | {type: 'Point'; coordinates: GeographicPosition}
  | {type: 'MultiPoint' | 'LineString'; coordinates: readonly GeographicPosition[]}
  | {type: 'MultiLineString' | 'Polygon'; coordinates: readonly (readonly GeographicPosition[])[]}
  | {type: 'MultiPolygon'; coordinates: readonly (readonly (readonly GeographicPosition[])[])[]}
  | {type: 'GeometryCollection'; geometries: readonly MapHitGeometry[]};
/** Hit source geometry in CSS pixels. Disconnected route parts stay separate;
 * polygons use their real rings, never an administrative bounding box. */
export function hitGeometry(point: MapPoint, geometry: MapHitGeometry | null, camera: CustomMapCamera, viewport: MapViewport, tolerance = 8): boolean {
  if (!geometry) return false;
  validPoint(point);
  if (finite(tolerance, 'hit tolerance') < 0) throw new RangeError('Hit tolerance cannot be negative');
  const line = (coordinates: readonly GeographicPosition[]) => !!hitPolyline(point, projectPath(camera, viewport, coordinates), tolerance);
  const polygon = (coordinates: readonly (readonly GeographicPosition[])[]) => {
    const reference = coordinates[0]?.[0]?.[0];
    if (reference === undefined) return false;
    const longitude = longitudeNear(reference, camera.center[0]);
    return hitPolygon(point, coordinates.map(ring => projectPath(camera, viewport, ring, {}, longitude)));
  };
  switch (geometry.type) {
    case 'Point': {const screen = project(camera, viewport, geometry.coordinates); return Math.hypot(screen.x - point.x, screen.y - point.y) <= tolerance;}
    case 'MultiPoint': return geometry.coordinates.some(coordinate => hitGeometry(point, {type: 'Point', coordinates: coordinate}, camera, viewport, tolerance));
    case 'LineString': return line(geometry.coordinates);
    case 'MultiLineString': return geometry.coordinates.some(line);
    case 'Polygon': return polygon(geometry.coordinates);
    case 'MultiPolygon': return geometry.coordinates.some(polygon);
    case 'GeometryCollection': return geometry.geometries.some(child => hitGeometry(point, child, camera, viewport, tolerance));
  }
}
