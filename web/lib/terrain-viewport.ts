export type TerrainViewport = {width: number; height: number; insets: {top: number; right: number; bottom: number; left: number}};
type TerrainViewportTarget = {
  setViewportInsets: (insets: {top: number; right: number; bottom: number; left: number}) => void;
  warmup: () => void;
};

/** Shared by source planning before the first DEM request and by the renderer.
 * Read all rectangles before either the source planner or renderer is updated. */
export function readTerrainViewport(element: HTMLElement): TerrainViewport {
  const panel = element.closest('.explore-layout')?.querySelector('.explore-panel');
  const atlas = element.closest('.atlas-wrap');
  const area = element.getBoundingClientRect(), drawer = panel?.getBoundingClientRect();
  const overlaps = drawer && drawer.right > area.left && drawer.left < area.right && drawer.top < area.bottom && drawer.bottom > area.top;
  const covered = overlaps ? Math.min(area.height, Math.max(0, area.bottom - Math.max(area.top, drawer.top))) : 0;
  const narrow = area.width < 700;
  const visibleRect = (node: globalThis.Element | null | undefined) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > area.left && rect.left < area.right && rect.top < area.bottom && rect.bottom > area.top ? rect : null;
  };
  const heading = visibleRect(element.querySelector('.terrain-heading'));
  const context = visibleRect(atlas?.querySelector('.map-context'));
  const controls = visibleRect(element.querySelector('.terrain-controls'));
  const footer = visibleRect(element.querySelector('.terrain-bottom'));
  const horizontalControls = !!controls && controls.width > controls.height;
  // Top HUDs reserve only the space they actually occupy. A horizontal rail
  // owns the lower edge; a vertical rail stays in the right-hand gutter.
  const top = heading || context ? Math.max(heading?.bottom ?? area.top, context?.bottom ?? area.top) - area.top + 16 : narrow ? 192 : 176;
  const bottom = Math.max(covered ? covered + 16 : 64,
    horizontalControls ? area.bottom - controls.top + 16 : 0,
    footer ? area.bottom - footer.top + 16 : 0);
  const insets = {top, right: narrow ? horizontalControls ? 16 : 64 : 80, bottom, left: narrow ? 16 : 32};
  return {width: Math.max(1, area.width), height: Math.max(1, area.height), insets};
}

/** A translated sheet keeps its layout size. Measure its final visible overlap
 * at the same settle boundary as the map, without tracking drag-frame styles. */
export function observeTerrainViewport(element: HTMLElement, target: TerrainViewportTarget, onChange?: (viewport: TerrainViewport) => void): () => void {
  const panel = element.closest('.explore-layout')?.querySelector('.explore-panel');
  let last = '', disposed = false, frame: number | null = null;
  const fit = () => {
    if (disposed) return;
    const viewport = readTerrainViewport(element), key = JSON.stringify(viewport);
    if (key !== last) {last = key; target.setViewportInsets(viewport.insets); onChange?.(viewport); target.warmup();}
  };
  // ResizeObserver, window resize and sheet-settled can describe the same
  // change. Read every rectangle together once before the next paint, then
  // update the renderer; never alternate layout reads and writes per event.
  const queue = () => {
    if (disposed || frame !== null) return;
    frame = window.requestAnimationFrame(() => {frame = null; fit();});
  };
  const settled = (event: Event) => {if (event.target === panel) queue();};
  const transition = (event: Event) => {
    const property = (event as TransitionEvent).propertyName;
    if (property === 'transform' || property === 'height') settled(event);
  };
  fit();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queue);
  observer?.observe(element); if (panel) observer?.observe(panel);
  window.addEventListener('resize', queue, {passive: true});
  panel?.addEventListener('transitionend', transition);
  // Reduced motion, interrupted gestures and instant sheet changes settle
  // without a native CSS transitionend.
  panel?.addEventListener('tropnik:sheet-settled', settled);
  return () => {
    disposed = true;
    if (frame !== null) {window.cancelAnimationFrame(frame); frame = null;}
    observer?.disconnect();
    window.removeEventListener('resize', queue);
    panel?.removeEventListener('transitionend', transition);
    panel?.removeEventListener('tropnik:sheet-settled', settled);
  };
}
