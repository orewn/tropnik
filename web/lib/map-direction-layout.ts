/** Screen-space direction grouping shared by the WebGL and canvas maps.
 * Anchors and zoom bounds use catalogue direction centres, never route points. */
export type MapDirection = {id: string; name: string; center: [number, number]};
export type DirectionScreenPoint = {x: number; y: number};
export type MapDirectionGroup<T extends MapDirection = MapDirection> = {
  key: string;
  members: T[];
  anchor: T;
  point: DirectionScreenPoint;
  bounds: [number, number, number, number];
  width: number;
  height: number;
};

export const DIRECTION_MARKER_SIZE = 44;
export const DIRECTION_CLUSTER_WIDTH = 144;
export const DIRECTION_MARKER_GAP = 8;

export function directionCountLabel(count: number) {
  const mod100 = count % 100, mod10 = count % 10;
  const noun = mod100 >= 11 && mod100 <= 14 ? 'направлений'
    : mod10 === 1 ? 'направление' : mod10 >= 2 && mod10 <= 4 ? 'направления' : 'направлений';
  return `${count} ${noun}`;
}

export function directionGroupsOverlap(a: Pick<MapDirectionGroup, 'point' | 'width' | 'height'>, b: Pick<MapDirectionGroup, 'point' | 'width' | 'height'>) {
  return Math.abs(a.point.x - b.point.x) < (a.width + b.width) / 2 + DIRECTION_MARKER_GAP
    && Math.abs(a.point.y - b.point.y) < (a.height + b.height) / 2 + DIRECTION_MARKER_GAP;
}

/** Recompute after settled camera changes. The small catalogue needs no worker
 * or per-frame DOM churn; merging also accounts for the wider cluster label. */
export function groupMapDirections<T extends MapDirection>(directions: readonly T[], project: (center: [number, number]) => DirectionScreenPoint): MapDirectionGroup<T>[] {
  const points = new Map<string, DirectionScreenPoint>();
  const unique = [...new Map(directions.map(item => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const item of unique) points.set(item.id, project(item.center));
  const group = (members: T[]): MapDirectionGroup<T> => {
    members.sort((a, b) => a.id.localeCompare(b.id));
    const average = members.reduce((sum, item) => {
      const p = points.get(item.id)!;
      return {x: sum.x + p.x / members.length, y: sum.y + p.y / members.length};
    }, {x: 0, y: 0});
    // Keep the symbol on a real member centre. A deterministic medoid avoids
    // suggesting a new destination between the actual catalogue directions.
    const anchor = members.reduce((best, item) => {
      const a = points.get(best.id)!, b = points.get(item.id)!;
      return Math.hypot(b.x - average.x, b.y - average.y) < Math.hypot(a.x - average.x, a.y - average.y) ? item : best;
    });
    const longitudes = members.map(item => item.center[0] < 0 ? item.center[0] + 360 : item.center[0]);
    const latitudes = members.map(item => item.center[1]);
    return {
      key: members.map(item => item.id).join('|'), members, anchor, point: points.get(anchor.id)!,
      bounds: [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)],
      width: members.length > 1 ? DIRECTION_CLUSTER_WIDTH : DIRECTION_MARKER_SIZE,
      height: DIRECTION_MARKER_SIZE,
    };
  };
  const groups = unique.filter(item => {
    const p = points.get(item.id)!;
    return Number.isFinite(p.x) && Number.isFinite(p.y);
  }).map(item => group([item]));
  // Each merge removes one group, so the fixed point takes at most n-1 merges.
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (!directionGroupsOverlap(groups[i], groups[j])) continue;
      groups[i] = group([...groups[i].members, ...groups[j].members]);
      groups.splice(j, 1);
      i = -1;
      break;
    }
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

export function directionMarkerContent(group: MapDirectionGroup, routeCount: number, overview: boolean) {
  const cluster = group.members.length > 1;
  return {
    cluster,
    label: cluster ? directionCountLabel(group.members.length) : group.anchor.name,
    count: !cluster && overview ? String(routeCount) : '',
    ariaLabel: cluster ? `Приблизить ${directionCountLabel(group.members.length)}: ${group.members.map(item => item.name).join(', ')}`
      : `Открыть ${group.anchor.name}${overview ? `, маршрутов в каталоге: ${routeCount}` : ''}`,
  };
}

/** Keep the same buttons while groups change, including their keyboard focus. */
export function updateDirectionButtons<T extends MapDirection>(
  buttons: ReadonlyMap<string, HTMLButtonElement>, groups: readonly MapDirectionGroup<T>[],
  counts: ReadonlyMap<string, number>, overview: boolean, selectedId?: string,
) {
  const anchors = new Map(groups.map(group => [group.anchor.id, group]));
  const focusedId = [...buttons].find(([, button]) => button.ownerDocument.activeElement === button)?.[0];
  for (const [id, button] of buttons) {
    const group = anchors.get(id);
    button.hidden = !group;
    if (!group) continue;
    const content = directionMarkerContent(group, counts.get(id) || 0, overview);
    button.classList.toggle('direction-cluster', content.cluster);
    button.classList.toggle('is-overview', overview);
    button.classList.toggle('is-selected', group.members.some(item => item.id === selectedId));
    const dot = button.querySelector('.region-marker-dot'), label = button.querySelector('.region-marker-label');
    if (dot) dot.textContent = content.count;
    if (label) label.textContent = content.label;
    button.setAttribute('aria-label', content.ariaLabel);
    button.title = content.cluster ? content.ariaLabel : group.anchor.name;
  }
  if (focusedId && !anchors.has(focusedId)) {
    const group = groups.find(item => item.members.some(member => member.id === focusedId));
    if (group) buttons.get(group.anchor.id)?.focus({preventScroll: true});
  }
  return anchors;
}
