/** Inner corners and edge midpoints avoid rounded-border antialiasing while
 * still testing painted areas outside the small geographic anchor. */
export function directionHitGrid(rect, anchor, inset = 8) {
  const dx = Math.min(inset, Math.max(1, (rect.right - rect.left - 1) / 2));
  const dy = Math.min(inset, Math.max(1, (rect.bottom - rect.top - 1) / 2));
  const left = rect.left + dx, right = rect.right - dx;
  const top = rect.top + dy, bottom = rect.bottom - dy;
  const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
  return [
    ['nw', left, top], ['n', x, top], ['ne', right, top], ['e', right, y],
    ['se', right, bottom], ['s', x, bottom], ['sw', left, bottom], ['w', left, y],
  ].map(([name, x, y]) => ({name, x, y,
    outsideAnchor: x < anchor.left || x > anchor.right || y < anchor.top || y > anchor.bottom,
  }));
}

/** Prefer an edge midpoint, then an inner corner. Never substitute the anchor
 * centre when the requested external surface is hidden or intercepted. */
export function directionExternalPoint(grid, kind) {
  const surface = grid?.surfaces?.find(item => item.kind === kind && item.visible);
  const order = kind === 'count' ? ['e', 'n', 's', 'w', 'ne', 'se', 'nw', 'sw'] : ['s', 'e', 'w', 'n', 'se', 'sw', 'ne', 'nw'];
  for (const name of order) {
    const point = surface?.samples.find(item => item.name === name && item.outsideAnchor
      && item.withinViewport && item.owned && !item.hitHidden && item.hitRegionId === grid.anchorId);
    if (point) return {name, kind, x: point.x, y: point.y, anchorId: grid.anchorId, groupKey: grid.groupKey};
  }
  return null;
}

/** Read-only DOM inspection. Serialized with directionHitGrid into the existing
 * CI browser; it neither dispatches events nor changes map/application state. */
export function inspectDirectionHitAreas(regionId, doc = document, win = window) {
  const box = element => {
    const r = element.getBoundingClientRect();
    return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height};
  };
  const atlas = doc.querySelector('.atlas-canvas[data-map-engine]');
  if (!atlas) return {missing: true, reason: 'map'};
  const mapRect = box(atlas);
  const available = {
    left: Math.max(0, mapRect.left), right: Math.min(win.innerWidth, mapRect.right),
    top: Math.max(0, mapRect.top), bottom: Math.min(win.innerHeight, mapRect.bottom),
  };
  const inside = point => point.x >= available.left && point.x < available.right
    && point.y >= available.top && point.y < available.bottom;
  const buttons = [...atlas.querySelectorAll('.region-marker')];
  const button = buttons.find(element => !element.hidden
    && (element.dataset.mapGroupKey || '').split('|').includes(regionId));
  if (!button) return {missing: true, reason: 'direction', regionId};
  const anchorRect = box(button), style = win.getComputedStyle(button);
  const sampleHit = point => {
    const withinViewport = inside(point);
    const hit = withinViewport ? doc.elementFromPoint(point.x, point.y) : null;
    const owner = hit?.closest('.region-marker');
    return {...point, withinViewport, owned: owner === button,
      hitRegionId: owner?.dataset.regionId || null, hitHidden: owner?.hidden === true,
      hitTag: hit?.tagName || null};
  };
  const surfaces = ['label', 'count'].map(kind => {
    const element = button.querySelector(`.region-marker-${kind}`);
    if (!element) return {kind, present: false, visible: false, samples: []};
    const rect = box(element), current = win.getComputedStyle(element);
    const visible = !button.hidden && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
      && current.display !== 'none' && current.visibility !== 'hidden' && Number(current.opacity) > 0
      && rect.width > 1 && rect.height > 1;
    return {kind, present: true, visible, text: element.textContent || '', rect,
      pointerEvents: current.pointerEvents,
      samples: visible ? directionHitGrid(rect, anchorRect, kind === 'count' ? 4 : 8).map(sampleHit) : []};
  });
  const hiddenControls = buttons.filter(element => element.hidden).map(element => {
    const current = win.getComputedStyle(element), wrapper = element.closest('.leaflet-region-marker');
    const wrapperRect = wrapper ? box(wrapper) : null;
    const samples = wrapper && wrapperRect.width > 1 && wrapperRect.height > 1 ? directionHitGrid(wrapperRect, wrapperRect).map(point => {
      const withinViewport = inside(point), hit = withinViewport ? doc.elementFromPoint(point.x, point.y) : null;
      return {...point, withinViewport, captures: !!hit && (hit === wrapper || wrapper.contains(hit)), hitTag: hit?.tagName || null};
    }) : [];
    return {regionId: element.dataset.regionId, hidden: element.hidden, display: current.display,
      rect: box(element), wrapper: wrapper ? {rect: wrapperRect, pointerEvents: win.getComputedStyle(wrapper).pointerEvents, samples} : null};
  });
  return {schemaVersion: 1, engine: atlas.dataset.mapEngine, regionId, anchorId: button.dataset.regionId,
    groupKey: button.dataset.mapGroupKey, cluster: button.classList.contains('direction-cluster'),
    ariaLabel: button.getAttribute('aria-label'), anchorRect, available, surfaces, hiddenControls};
}
