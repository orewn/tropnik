type MapCameraState = {
  longitude: number;
  latitude: number;
  zoom: number;
  tileSize: 256 | 512;
  engine: 'leaflet' | 'maplibre';
  centerX?: number;
  centerY?: number;
};

/** A selected card may be ahead of the feature batch still on screen. Never
 * substitute that newer card when a click reports an older rendered ID. */
export function resolveRenderedTrail<T extends {id: string}>(id: unknown, applied: T | undefined, visible: readonly T[]): T | undefined {
  if (typeof id !== 'string' || !id) return;
  return applied?.id === id ? applied : visible.find(trail => trail.id === id);
}

/** Settled camera diagnostics let regression tests use real pointer input at
 * geographic locations without a mutable map instance or synthetic clicks. */
export function publishMapCamera(element: HTMLElement | null, state: MapCameraState): void {
  if (!element || ![state.longitude, state.latitude, state.zoom].every(Number.isFinite)) return;
  element.dataset.mapEngine = state.engine;
  element.dataset.mapLongitude = String(state.longitude);
  element.dataset.mapLatitude = String(state.latitude);
  element.dataset.mapZoom = String(state.zoom);
  element.dataset.mapTileSize = String(state.tileSize);
  if (Number.isFinite(state.centerX) && Number.isFinite(state.centerY)) {
    element.dataset.mapCenterX = String(state.centerX);
    element.dataset.mapCenterY = String(state.centerY);
  } else {
    delete element.dataset.mapCenterX;
    delete element.dataset.mapCenterY;
  }
}

type FrameScheduler = {request: (callback: () => void) => number; cancel: (id: number) => void};

/** Bound high-frequency work to one pending animation frame. Disposal also
 * invalidates callbacks already dequeued by the browser. */
export function coalesceMapFrame(run: () => void, scheduler: FrameScheduler = {
  request: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id),
}) {
  let pending: number | undefined;
  let active = true;
  return {
    schedule() {
      if (!active || pending !== undefined) return;
      pending = scheduler.request(() => {pending = undefined; if (active) run();});
    },
    dispose() {
      active = false;
      if (pending !== undefined) scheduler.cancel(pending);
      pending = undefined;
    },
  };
}
