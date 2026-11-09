import type {Canvas, RendererOptions} from 'leaflet';

type ScheduledCanvas = Canvas & {
  _redrawRequest?: number | null;
  _ctx?: CanvasRenderingContext2D;
  _redraw: () => void;
};

/** Leaflet 1.9.4 can run _redraw synchronously from _updatePaths while an
 * earlier redraw RAF is still queued. That clears the saved request ID, so
 * onRemove cannot cancel the old callback before destroying its context.
 * Keep this compatibility fix on our renderer instances, not the SDK
 * prototype. Re-adding a renderer creates a new context and still works. */
export function createLeafletCanvas(L: typeof import('leaflet'), options?: RendererOptions): Canvas {
  const renderer = L.canvas(options) as ScheduledCanvas;
  const redraw = renderer._redraw;
  renderer._redraw = function (this: ScheduledCanvas): void {
    if (this._redrawRequest != null) L.Util.cancelAnimFrame(this._redrawRequest);
    this._redrawRequest = null;
    if (this._ctx) redraw.call(this);
  };
  return renderer;
}
