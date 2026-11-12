/** Collapse on a map gesture or timeout. Credit and adjacent-panel interaction
 * cancel the idle timer so their geometry stays stable, but leave the next map
 * gesture active. Cleanup is also safe after a collapse. */
export function bindMapAttributionCollapse(host: EventTarget | null, credit: EventTarget | null, collapse: () => void, layout: EventTarget | null = null) {
  let active = true;
  const engagementEvents = ['pointerdown', 'wheel', 'keydown', 'focusin'] as const;
  const cleanup = () => {
    active = false;
    clearTimeout(timer);
    host?.removeEventListener('pointerdown', interaction);
    host?.removeEventListener('wheel', interaction);
    for (const type of engagementEvents) layout?.removeEventListener(type, engagement, {capture: true});
  };
  const finish = () => {if (!active) return; cleanup(); collapse();};
  const interaction = (event: Event) => {
    if (credit && event.composedPath().includes(credit)) {clearTimeout(timer); return;}
    finish();
  };
  const engagement = (event: Event) => {
    const path = event.composedPath();
    if (!host || !path.includes(host) || (credit && path.includes(credit))) clearTimeout(timer);
  };
  const timer = setTimeout(finish, 5000);
  host?.addEventListener('pointerdown', interaction, {passive: true});
  host?.addEventListener('wheel', interaction, {passive: true});
  // Capture sees drawer gestures even when React stops their propagation.
  for (const type of engagementEvents) layout?.addEventListener(type, engagement, {capture: true, passive: true});
  return cleanup;
}
