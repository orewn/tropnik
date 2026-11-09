export const MAP_ZOOM_BUTTONS = Object.freeze({leafletStep: .75, maplibreStep: 1, durationMs: 200});

type ZoomButtonOptions = {
  zoom: () => number;
  bounds: () => {min: number; max: number};
  busy: () => boolean;
  apply: (zoom: number) => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
};

/** Every button press changes the desired zoom, not the engine's intermediate
 * animation frame. Leaflet drops setZoom while its CSS transition is running;
 * MapLibre zoomIn uses the current interpolated zoom. Park one latest target
 * until zoomend and apply it on the next frame, outside either SDK's callback. */
export class MapZoomButtons {
  private readonly options: ZoomButtonOptions;
  private target: number | undefined;
  private inFlight = false;
  private frame: number | undefined;
  private revision = 0;
  private disposed = false;

  constructor(options: ZoomButtonOptions) {this.options = options;}

  request(delta: number): void {
    if (this.disposed || !Number.isFinite(delta) || delta === 0) return;
    const next = this.clamp((this.target ?? this.options.zoom()) + delta);
    if (next === undefined) return;
    this.target = next;
    this.schedule();
  }

  settled(): void {
    if (this.disposed) return;
    this.inFlight = false;
    this.schedule();
  }

  cancel(): void {
    this.revision++;
    this.target = undefined;
    this.inFlight = false;
    if (this.frame !== undefined) {
      if (this.options.cancelFrame) this.options.cancelFrame(this.frame);
      else cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
  }

  dispose(): void {this.disposed = true; this.cancel();}

  private clamp(zoom: number): number | undefined {
    const {min, max} = this.options.bounds();
    if (![zoom, min, max].every(Number.isFinite) || min > max) return;
    return Math.max(min, Math.min(max, zoom));
  }

  private schedule(): void {
    if (this.disposed || this.target === undefined || this.frame !== undefined) return;
    const revision = this.revision;
    const run = () => {
      if (this.disposed || revision !== this.revision) return;
      this.frame = undefined;
      if (this.target === undefined || this.inFlight || this.options.busy()) return;
      const target = this.clamp(this.target);
      if (target === undefined) {this.cancel(); return;}
      this.target = target;
      if (Math.abs(this.options.zoom() - target) < 1e-7) {this.target = undefined; return;}
      this.inFlight = true;
      this.options.apply(target);
      // Reduced motion and a synchronous SDK reset do not keep an animation
      // running. A CSS zoom scheduled for the next frame still owns inFlight.
      if (!this.options.busy() && this.target === target && Math.abs(this.options.zoom() - target) < 1e-7) {
        this.target = undefined;
        this.inFlight = false;
      }
    };
    this.frame = this.options.requestFrame ? this.options.requestFrame(run) : requestAnimationFrame(run);
  }
}

export function bindZoomButtonCancellation(surface: HTMLElement, zoom: MapZoomButtons): () => void {
  const cancel = () => zoom.cancel();
  const keyboard = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-', '−', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) cancel();
  };
  surface.addEventListener('pointerdown', cancel, {passive: true});
  surface.addEventListener('touchstart', cancel, {passive: true});
  surface.addEventListener('wheel', cancel, {passive: true});
  surface.addEventListener('keydown', keyboard);
  return () => {
    surface.removeEventListener('pointerdown', cancel);
    surface.removeEventListener('touchstart', cancel);
    surface.removeEventListener('wheel', cancel);
    surface.removeEventListener('keydown', keyboard);
  };
}
