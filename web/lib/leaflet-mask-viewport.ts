import type {Bounds, Canvas, LatLngBounds, Map as LeafletMap, Point, Polygon} from 'leaflet';

type GeographicBounds = {west: number; south: number; east: number; north: number};
type MaskRenderer = {
  _map?: LeafletMap;
  options: {padding?: number};
  _onZoomEnd: () => void;
  _updatePaths: () => void;
  _reset: () => void;
};
type MaskPolygon = Polygon & {
  _project: () => void;
  _update: () => void;
  _rings: Point[][];
  _parts: Point[][];
  _pxBounds?: Bounds;
  _rawPxBounds?: Bounds;
};

function geographicBounds(bounds: LatLngBounds): GeographicBounds | undefined {
  if (!bounds.isValid()) return;
  const west = bounds.getWest(), south = bounds.getSouth(), east = bounds.getEast(), north = bounds.getNorth();
  if (![west, south, east, north].every(Number.isFinite) || west > east || south > north) return;
  return {west, south, east, north};
}

function bufferedViewport(renderer: MaskRenderer): GeographicBounds | undefined {
  const map = renderer._map, padding = renderer.options.padding ?? .1;
  if (!map || !Number.isFinite(padding) || padding < 0) return;
  try {
    const pixels = map.getPixelBounds(), size = map.getSize();
    if (!pixels.min || !pixels.max || ![pixels.min.x, pixels.min.y, pixels.max.x, pixels.max.y, size.x, size.y].every(Number.isFinite) || size.x <= 0 || size.y <= 0) return;
    // Match the Canvas buffer in projected pixels, including Leaflet's 3px
    // polygon clip margin and coordinate rounding. Latitude padding is nonlinear.
    const x = size.x * padding + 4, y = size.y * padding + 4;
    const southwest = map.unproject([pixels.min.x - x, pixels.max.y + y]);
    const northeast = map.unproject([pixels.max.x + x, pixels.min.y - y]);
    const west = southwest.lng, south = southwest.lat, east = northeast.lng, north = northeast.lat;
    if (![west, south, east, north].every(Number.isFinite) || west > east || south > north) return;
    return {west, south, east, north};
  } catch {
    // A renderer can be attached before the host exposes a usable viewport.
    // Preserve Leaflet's ordinary projection until measurement is available.
    return;
  }
}

/** Skip whole off-screen mask cells before Leaflet projects every vertex.
 * Source rings, world copies, pixel clipping and smoothing stay untouched.
 * Hooks belong only to this mask renderer and its polygon instances. */
export function maskViewportCulling(canvas: Canvas): (polygon: Polygon) => void {
  const renderer = canvas as unknown as MaskRenderer;
  let inPass = false, viewport: GeographicBounds | undefined;
  // zoomend projects paths; moveend/resize update clipping; reset can nest both.
  // One shared viewport covers the complete pass, never one read per vertex.
  for (const method of ['_onZoomEnd', '_updatePaths', '_reset'] as const) {
    const original = renderer[method];
    renderer[method] = function (this: MaskRenderer): void {
      if (inPass) {original.call(this); return;}
      viewport = bufferedViewport(this); inPass = true;
      try {original.call(this);} finally {inPass = false; viewport = undefined;}
    };
  }
  return polygon => {
    const layer = polygon as MaskPolygon, project = layer._project, update = layer._update;
    let sourceBounds = layer.getBounds(), extent = geographicBounds(sourceBounds), skipped = false;
    const visible = () => {
      const currentBounds = layer.getBounds();
      if (currentBounds !== sourceBounds) {sourceBounds = currentBounds; extent = geographicBounds(currentBounds);}
      const view = inPass ? viewport : bufferedViewport(renderer);
      // Unknown bounds fail open: restore ordinary projection rather than
      // remove coverage because a camera or geometry state is unavailable.
      return !view || !extent || extent.east >= view.west && extent.west <= view.east && extent.north >= view.south && extent.south <= view.north;
    };
    const skip = () => {
      if (!skipped) {layer._rings = []; layer._parts = []; delete layer._pxBounds; delete layer._rawPxBounds;}
      skipped = true;
    };
    layer._project = function (): void {
      if (!visible()) {skip(); return;}
      project.call(this); skipped = false;
    };
    layer._update = function (): void {
      if (!visible()) {skip(); return;}
      // A pan can reveal a previously culled cell without another zoomend.
      if (skipped) {project.call(this); skipped = false;}
      update.call(this);
    };
  };
}
