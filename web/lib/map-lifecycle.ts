export type MapBaseMode = 'detail' | 'overview' | 'satellite';

type RouteCameraIdentity = {id?: string; url?: string; geometry?: unknown};
const sameRouteIdentity = (a: RouteCameraIdentity | undefined, b: RouteCameraIdentity | undefined) =>
  a?.id === b?.id && a?.url === b?.url && a?.geometry === b?.geometry;

/** New styles need fresh overlays, but only new selections own navigation.
 * Remember the last applied selection across style and connectivity changes. */
export class MapSelectionCamera {
  private regionInitialized = false;
  private regionId: string | undefined;
  private regionRouteId: string | undefined;
  private route: RouteCameraIdentity | undefined;
  private navigationRevision = 0;
  private selectedRoute: RouteCameraIdentity | undefined;
  private routeSelectionInitialized = false;
  private routeSelectionRevision = 0;
  private routeNavigationRevision = 0;

  /** Bind camera permission to the visible selection before starting its
   * asynchronous load. Recreating layers/effects cannot revive a cancelled fit. */
  beginRouteSelection(identity: RouteCameraIdentity | undefined): void {
    if (this.routeSelectionInitialized && sameRouteIdentity(this.selectedRoute, identity)) return;
    this.routeSelectionInitialized = true;
    this.selectedRoute = identity;
    this.routeSelectionRevision++;
    this.routeNavigationRevision = this.navigationRevision;
    this.route = undefined;
  }

  /** Geometry can arrive after the visitor has moved the camera. Keep drawing
   * the selected route, but do not replace a newer manual camera position. */
  captureNavigation(): () => boolean {
    const revision = this.routeNavigationRevision, selection = this.routeSelectionRevision;
    return () => revision === this.navigationRevision && selection === this.routeSelectionRevision;
  }

  cancelNavigation(): void {this.navigationRevision++;}

  regionChanged(id: string | undefined, routeId?: string): boolean {
    // A route card is a child view of its region. Closing it is a new camera
    // intent even when the region ID is unchanged. Track the visible card,
    // not the asynchronously applied geometry: users can leave before it loads.
    const changed = !this.regionInitialized || id !== this.regionId
      || (this.regionRouteId !== undefined && routeId === undefined);
    this.regionInitialized = true;
    this.regionId = id;
    this.regionRouteId = routeId;
    return changed;
  }

  routeChanged(identity: RouteCameraIdentity | undefined): boolean {
    const previous = this.route;
    this.route = identity;
    return !sameRouteIdentity(previous, identity);
  }
}

/** Leaflet ignores camera changes during CSS zoom animation. Hold only the
 * newest intent and apply it after zoomend, using current layout measurements.
 * Manual navigation and unmount discard pending work rather than replay it. */
export class LatestMapNavigation {
  private pending: (() => void) | undefined;
  private disposed = false;
  private readonly blocked: () => boolean;

  constructor(blocked: () => boolean) {this.blocked = blocked;}
  request(run: () => void): void {
    if (this.disposed) return;
    this.pending = run;
    this.flush();
  }
  flush(): void {
    if (this.disposed || this.blocked() || !this.pending) return;
    const run = this.pending;
    this.pending = undefined;
    run();
  }
  cancel(): void {this.pending = undefined;}
  dispose(): void {this.disposed = true; this.cancel();}
}

type MapStyleOptions<Style> = {
  online: boolean;
  preference: MapBaseMode;
  currentMode: MapBaseMode;
  detail: () => Promise<Style>;
  satellite?: () => Promise<Style>;
  overview: () => Style;
  apply: (style: Style, mode: MapBaseMode) => void;
  onError: (error: unknown) => void;
};

/** A temporary loss of connectivity must not overwrite the user's map choice.
 * Only the latest request may replace the visible style or report a failure. */
export class MapStyleSession<Style> {
  private options: MapStyleOptions<Style>;
  private online: boolean;
  private preference: MapBaseMode;
  private currentMode: MapBaseMode;
  private revision = 0;
  private disposed = false;

  constructor(options: MapStyleOptions<Style>) {
    this.options = options;
    this.online = options.online;
    this.preference = options.preference;
    this.currentMode = options.currentMode;
  }

  select(mode: MapBaseMode): Promise<boolean> {
    this.preference = mode;
    return this.update();
  }

  connect(online: boolean): Promise<boolean> {
    this.online = online;
    return this.update();
  }

  fallback(): void {
    const revision = ++this.revision;
    if (this.disposed) return;
    this.options.apply(this.options.overview(), 'overview');
    if (!this.disposed && revision === this.revision) this.currentMode = 'overview';
  }

  dispose(): void {this.disposed = true; this.revision++;}

  private async update(): Promise<boolean> {
    const revision = ++this.revision;
    if (this.disposed) return false;
    const mode = this.online ? this.preference : 'overview';
    if (mode === this.currentMode) return false;
    try {
      const style = mode === 'overview' ? this.options.overview()
        : mode === 'satellite' ? await this.requireSatellite() : await this.options.detail();
      if (this.disposed || revision !== this.revision) return false;
      this.options.apply(style, mode);
      // MapLibre may emit a synchronous error while applying a style. Its
      // fallback is a newer choice and must not be overwritten on return.
      if (this.disposed || revision !== this.revision) return false;
      this.currentMode = mode;
      return true;
    } catch (error) {
      if (!this.disposed && revision === this.revision) this.options.onError(error);
      return false;
    }
  }

  private requireSatellite(): Promise<Style> {
    if (!this.options.satellite) throw new Error('Satellite imagery is unavailable.');
    return this.options.satellite();
  }
}

type MapSelectionOptions<Value> = {
  clear: () => void;
  load: () => Promise<Value> | Value;
  current: () => boolean;
  apply: (value: Value) => void;
  onError: (error: unknown) => void;
  clearBeforeLoad?: boolean;
};

/** Keep the previous route visible while a replacement is fetched when the
 * caller opts out of eager clearing. Stale responses still cannot apply, and a
 * failed replacement clears the old line rather than mislabelling it. */
export function loadMapSelection<Value>(options: MapSelectionOptions<Value>): () => void {
  let active = true;
  const current = () => active && options.current();
  if(options.clearBeforeLoad!==false)options.clear();
  void Promise.resolve().then(async () => {
    if (!current()) return;
    const value = await options.load();
    if (current()) options.apply(value);
  }).catch(error => {
    if (current()) {options.clear(); options.onError(error);}
  });
  return () => {active = false;};
}

export function applyMapLayerVisibility(map: {
  getLayer: (id: string) => unknown;
  setLayoutProperty: (id: string, property: 'visibility', value: 'visible' | 'none') => unknown;
  setFilter: (id: string, filter: ['<' | '<=', ['get', 'admin_level'], number]) => unknown;
}, visible: {paths: boolean; boundaries: boolean}): void {
  for (const [id, show] of [['paths', visible.paths], ['tracks', visible.paths], ['path-label', visible.paths], ['region-boundary', visible.boundaries]] as const) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
  }
  // The detailed style also contains administrative borders from vector tiles.
  // Keep national borders while hiding the regional part with its control.
  if (map.getLayer('boundaries')) map.setFilter('boundaries', [visible.boundaries ? '<=' : '<', ['get', 'admin_level'], 4]);
}
