/** Collapse on a map gesture or timeout. Pressing a credit link must leave that
 * link mounted until its click completes; ignored gestures must not consume the
 * next map interaction. Cleanup is also safe after a collapse. */
export function bindMapAttributionCollapse(host: EventTarget | null, credit: EventTarget | null, collapse: () => void) {
  let active = true;
  const cleanup = () => {
    active = false;
    clearTimeout(timer);
    host?.removeEventListener('pointerdown', interaction);
    host?.removeEventListener('wheel', interaction);
  };
  const finish = () => {if (!active) return; cleanup(); collapse();};
  const interaction = (event: Event) => {
    if (credit && event.composedPath().includes(credit)) {clearTimeout(timer); return;}
    finish();
  };
  const timer = setTimeout(finish, 5000);
  host?.addEventListener('pointerdown', interaction, {passive: true});
  host?.addEventListener('wheel', interaction, {passive: true});
  return cleanup;
}
