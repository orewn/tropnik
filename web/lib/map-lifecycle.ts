export type MapBaseMode = 'detail' | 'overview' | 'satellite';

type RouteCameraIdentity = {id?: string; url?: string; geometry?: unknown};

/** New styles need fresh overlays, but only new selections own navigation.
 * Remember the last applied selection across style and connectivity changes. */
export class MapSelectionCamera {
  private regionInitialized = false;
  private regionId: string | undefined;
  private route: RouteCameraIdentity | undefined;

  regionChanged(id: string | undefined): boolean {
    if (this.regionInitialized && id === this.regionId) return false;
    this.regionInitialized = true;
    this.regionId = id;
    return true;
  }

  routeChanged(identity: RouteCameraIdentity | undefined): boolean {
    const previous = this.route;
    this.route = identity;
    return previous?.id !== identity?.id || previous?.url !== identity?.url || previous?.geometry !== identity?.geometry;
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
