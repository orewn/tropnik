export const SHEET_MEDIA_QUERY = '(max-width:700px), (min-width:701px) and (max-width:900px) and (max-height:620px) and (orientation:landscape) and (pointer:coarse)';

type SheetGestureOptions = {
  root: HTMLElement;
  panel: HTMLElement;
  handles: readonly HTMLElement[];
  enabled: () => boolean;
  getOpen: () => boolean;
  setOpen: (open: boolean) => void;
};

type GestureEnvironment = Pick<Window,
  'addEventListener' | 'removeEventListener' | 'requestAnimationFrame' | 'cancelAnimationFrame' |
  'setTimeout' | 'clearTimeout' | 'getComputedStyle' | 'matchMedia'>;

type Gesture = {
  pointerId: number;
  handle: HTMLElement;
  startX: number;
  startY: number;
  startOffset: number;
  maxOffset: number;
  offset: number;
  lastY: number;
  lastMotionTime: number;
  velocity: number;
  dragged: boolean;
};

export type SheetGesture = {sync: () => void; cancel: () => void; dispose: () => void};

const clamp = (value: number, maximum: number) => Math.min(maximum, Math.max(0, value));

/** Only the grab handle and collapsed preview own a drag. The route list keeps
 * native momentum scrolling. Pointer moves update one compositor transform per
 * frame; React and map framing are notified only after the gesture settles. */
export function bindSheetGesture(options: SheetGestureOptions, environment: GestureEnvironment = window): SheetGesture {
  const {root, panel, handles} = options;
  let gesture: Gesture | undefined;
  let frame: number | undefined;
  let settleTimer: number | undefined;
  let settlingOpen: boolean | undefined;
  let revision = 0;
  let disposed = false;
  let suppressPointerClick = false;
  let committedOpen = options.getOpen();

  const cancelFrame = () => {
    revision++;
    if (frame !== undefined) environment.cancelAnimationFrame(frame);
    frame = undefined;
  };
  const clearSettlement = () => {
    if (settleTimer !== undefined) environment.clearTimeout(settleTimer);
    settleTimer = undefined;
    settlingOpen = undefined;
  };
  const clearStyles = () => {
    delete root.dataset.sheetDragging;
    panel.style.removeProperty('transform');
    panel.style.removeProperty('transition');
    panel.style.removeProperty('will-change');
  };
  const settled = (notify: boolean) => {
    clearSettlement();
    clearStyles();
    // A reduced-motion or unchanged transform has no transitionend. Send the
    // same single geometry boundary; never dispatch this from pointermove.
    if (notify && !disposed) panel.dispatchEvent(new Event('tropnik:sheet-settled'));
  };
  const detachActive = () => {
    environment.removeEventListener('pointermove', move);
    environment.removeEventListener('pointerup', up);
    environment.removeEventListener('pointercancel', cancelled);
    environment.removeEventListener('pointerdown', anotherPointer, true);
    const previous = gesture;
    gesture = undefined;
    if (previous?.handle.hasPointerCapture(previous.pointerId)) {
      try {previous.handle.releasePointerCapture(previous.pointerId);} catch { /* Pointer already cancelled by the browser. */ }
    }
  };
  const writeOffset = (offset: number) => {panel.style.transform = `translate3d(0,${offset}px,0)`;};
  const draw = () => {
    if (frame !== undefined) return;
    const current = revision;
    frame = environment.requestAnimationFrame(() => {
      if (disposed || current !== revision) return;
      frame = undefined;
      if (gesture) writeOffset(gesture.offset);
    });
  };
  const finish = (open: boolean, commit: boolean) => {
    const previous = gesture;
    if (!previous) return;
    cancelFrame();
    detachActive();
    writeOffset(previous.offset);
    // Flush only once at release, while transitions are disabled. This also
    // handles a last pointermove delivered immediately before pointerup.
    panel.getBoundingClientRect();
    delete root.dataset.sheetDragging;
    panel.style.removeProperty('transition');
    const destination = open ? 0 : previous.maxOffset;
    settlingOpen = open;
    writeOffset(destination);
    if (commit) options.setOpen(open);
    const immediate = Math.abs(previous.offset - destination) < .5 || environment.matchMedia('(prefers-reduced-motion:reduce)').matches;
    if (immediate) {
      const current = revision;
      frame = environment.requestAnimationFrame(() => {
        if (disposed || current !== revision) return;
        frame = undefined;
        settled(true);
      });
    } else {
      // transitionend is the normal completion. A hidden tab, removed transition
      // or browser interruption must not retain inline styles indefinitely.
      const current = revision;
      settleTimer = environment.setTimeout(() => {
        if (!disposed && current === revision && settlingOpen !== undefined) settled(true);
      }, 360);
    }
  };
  const reset = (notify: boolean) => {
    if (gesture) suppressPointerClick = true;
    detachActive();
    cancelFrame();
    clearSettlement();
    clearStyles();
    if (notify && !disposed) {
      // Resize and external navigation replace the old drag geometry outright.
      // Apply that endpoint before notifying the map, not halfway through an
      // animation toward dimensions captured before the resize.
      panel.style.setProperty('transition', 'none', 'important');
      panel.getBoundingClientRect();
      panel.style.removeProperty('transition');
      const current = revision;
      frame = environment.requestAnimationFrame(() => {
        if (disposed || current !== revision) return;
        frame = undefined;
        panel.dispatchEvent(new Event('tropnik:sheet-settled'));
      });
    }
  };
  const update = (event: PointerEvent) => {
    const current = gesture;
    if (!current) return;
    const difference = event.clientY - current.lastY;
    const elapsed = event.timeStamp - current.lastMotionTime;
    if (difference !== 0) {
      current.velocity = elapsed > 0 && elapsed < 160 ? difference / elapsed : 0;
      current.lastY = event.clientY;
      current.lastMotionTime = event.timeStamp;
    }
    current.offset = clamp(current.startOffset + event.clientY - current.startY, current.maxOffset);
  };
  function move(event: PointerEvent) {
    const current = gesture;
    if (!current || event.pointerId !== current.pointerId) return;
    const x = Math.abs(event.clientX - current.startX), y = Math.abs(event.clientY - current.startY);
    if (!current.dragged) {
      if (x < 6 && y < 6) return;
      if (x > y) {
        suppressPointerClick = true;
        finish(options.getOpen(), false);
        return;
      }
      current.dragged = true;
      root.dataset.sheetDragging = 'true';
    }
    event.preventDefault();
    update(event);
    draw();
  }
  function up(event: PointerEvent) {
    const current = gesture;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.dragged) {
      // A tap is still the button's normal click. Leave no pending snap that
      // could race its React state update or swallow a subsequent keyboard click.
      detachActive();
      cancelFrame();
      clearSettlement();
      clearStyles();
      return;
    }
    update(event);
    suppressPointerClick = true;
    const freshVelocity = event.timeStamp - current.lastMotionTime <= 80 && Math.abs(event.clientY - current.startY) >= 12;
    const open = freshVelocity && Math.abs(current.velocity) >= .5
      ? current.velocity < 0 : current.offset < current.maxOffset / 2;
    finish(open, true);
  }
  function cancelled(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    suppressPointerClick = true;
    finish(options.getOpen(), false);
  }
  function anotherPointer(event: PointerEvent) {
    if (gesture && event.pointerId !== gesture.pointerId) {
      suppressPointerClick = true;
      finish(options.getOpen(), false);
    }
  }
  function down(event: PointerEvent) {
    if (disposed || !options.enabled() || event.isPrimary === false || event.button !== 0) return;
    if (gesture) return;
    const handle = event.currentTarget as HTMLElement;
    const bounds = panel.getBoundingClientRect();
    const rootBounds = root.getBoundingClientRect();
    const peek = Number.parseFloat(environment.getComputedStyle(root).getPropertyValue('--sheet-peek'));
    const maxOffset = bounds.height - peek;
    if (!Number.isFinite(maxOffset) || maxOffset < 8) return;
    suppressPointerClick = false;
    cancelFrame();
    clearSettlement();
    const startOffset = clamp(bounds.bottom - rootBounds.bottom, maxOffset);
    gesture = {pointerId:event.pointerId, handle, startX:event.clientX, startY:event.clientY,
      startOffset, maxOffset, offset:startOffset, lastY:event.clientY, lastMotionTime:event.timeStamp, velocity:0, dragged:false};
    panel.style.setProperty('transition', 'none', 'important');
    panel.style.setProperty('will-change', 'transform');
    writeOffset(startOffset);
    try {handle.setPointerCapture(event.pointerId);} catch { /* Window listeners still release an interrupted pointer. */ }
    environment.addEventListener('pointermove', move, {passive:false});
    environment.addEventListener('pointerup', up);
    environment.addEventListener('pointercancel', cancelled);
    environment.addEventListener('pointerdown', anotherPointer, {capture:true, passive:true});
  }
  function click(event: MouseEvent) {
    // Keyboard and assistive-technology activation stays a normal button click.
    if (suppressPointerClick && event.detail !== 0) {
      suppressPointerClick = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function transitionEnd(event: TransitionEvent) {
    if (event.target === panel && event.propertyName === 'transform' && settlingOpen !== undefined) settled(false);
  }
  const viewportChanged = () => {if (gesture || settlingOpen !== undefined) reset(true);};
  for (const handle of handles) {
    handle.addEventListener('pointerdown', down);
    handle.addEventListener('lostpointercapture', cancelled);
    handle.addEventListener('click', click, true);
  }
  panel.addEventListener('transitionend', transitionEnd);
  environment.addEventListener('resize', viewportChanged, {passive:true});
  environment.addEventListener('blur', viewportChanged);
  environment.addEventListener('pagehide', viewportChanged);
  return {
    sync() {
      if (disposed) return;
      const next = options.getOpen(), changed = next !== committedOpen;
      committedOpen = next;
      // The state commit from this gesture is expected; a navigation or a
      // different state must invalidate the old pointer before it can snap back.
      if (!gesture && settlingOpen === next) return;
      if (gesture || settlingOpen !== undefined) reset(true);
      else if (changed && options.enabled() && environment.matchMedia('(prefers-reduced-motion:reduce)').matches) {
        // Native button/keyboard and route selection can also change the sheet.
        // Reduced motion has no transitionend, so publish its settled geometry.
        reset(true);
      }
    },
    cancel() {if (!disposed) reset(true);},
    dispose() {
      if (disposed) return;
      disposed = true;
      reset(false);
      for (const handle of handles) {
        handle.removeEventListener('pointerdown', down);
        handle.removeEventListener('lostpointercapture', cancelled);
        handle.removeEventListener('click', click, true);
      }
      panel.removeEventListener('transitionend', transitionEnd);
      environment.removeEventListener('resize', viewportChanged);
      environment.removeEventListener('blur', viewportChanged);
      environment.removeEventListener('pagehide', viewportChanged);
    },
  };
}
