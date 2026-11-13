/** Collapse on a map gesture or timeout. Credit, controls and adjacent-panel
 * interaction cancel the idle timer so their geometry stays stable, but leave
 * the next map gesture active. Cleanup is also safe after a collapse. */
export function bindMapAttributionCollapse(host: EventTarget | null, credit: EventTarget | null, collapse: () => void, layout: EventTarget | null = null) {
  let active = true;
  const engagementEvents = ['pointerdown', 'wheel', 'keydown', 'focusin'] as const;
  const preservesControlGeometry = (path: EventTarget[]) => (credit && path.includes(credit)) || path.some(target => {
    const element = target as Element;
    return typeof element.matches === 'function' && element.matches('button,a,input,select,textarea,label,summary,[role="button"],[role="checkbox"],[role="switch"],[role="slider"],[role="menuitem"],.map-controls,.map-style-switch,.layer-control,.layer-menu,.map-message');
  });
  const cleanup = () => {
    active = false;
    clearTimeout(timer);
    host?.removeEventListener('pointerdown', interaction);
    host?.removeEventListener('wheel', interaction);
    for (const type of engagementEvents) layout?.removeEventListener(type, engagement, {capture: true});
  };
  const finish = () => {if (!active) return; cleanup(); collapse();};
  const interaction = (event: Event) => {
    // Collapsing on a control's press shrinks the footer and moves Layers
    // before release, preventing its native click from reaching the button.
    if (preservesControlGeometry(event.composedPath())) {clearTimeout(timer); return;}
    finish();
  };
  const engagement = (event: Event) => {
    const path = event.composedPath();
    if (!host || !path.includes(host) || preservesControlGeometry(path)) clearTimeout(timer);
  };
  const timer = setTimeout(finish, 5000);
  host?.addEventListener('pointerdown', interaction, {passive: true});
  host?.addEventListener('wheel', interaction, {passive: true});
  // Capture sees drawer gestures even when React stops their propagation.
  for (const type of engagementEvents) layout?.addEventListener(type, engagement, {capture: true, passive: true});
  return cleanup;
}
