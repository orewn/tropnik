/** A direction is a native button even when its visible label extends beyond
 * the map engine's 44px anchor. Keep its gestures out of the map without
 * cancelling browser focus, touch activation, or Enter/Space. */
export function bindMapDirectionButton(
  button: HTMLButtonElement,
  activate: () => void,
  press: () => void,
) {
  const stop = (event: Event) => event.stopPropagation();
  const pointerDown = (event: PointerEvent) => {
    event.stopPropagation();
    if (event.isPrimary !== false && event.button === 0) press();
  };
  const click = (event: MouseEvent) => {
    event.stopPropagation();
    if (button.disabled || button.hidden || !button.isConnected) return;
    // Keyboard activation has no pointerdown; cancel stale camera/GPS work
    // here as well, before the selection or cluster expansion starts.
    press();
    activate();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  };
  button.addEventListener('pointerdown', pointerDown, {passive: true});
  button.addEventListener('mousedown', stop, {passive: true});
  button.addEventListener('touchstart', stop, {passive: true});
  button.addEventListener('dblclick', stop);
  button.addEventListener('keydown', keyDown);
  button.addEventListener('keyup', keyDown);
  button.addEventListener('click', click);
  return () => {
    button.removeEventListener('pointerdown', pointerDown);
    button.removeEventListener('mousedown', stop);
    button.removeEventListener('touchstart', stop);
    button.removeEventListener('dblclick', stop);
    button.removeEventListener('keydown', keyDown);
    button.removeEventListener('keyup', keyDown);
    button.removeEventListener('click', click);
  };
}
