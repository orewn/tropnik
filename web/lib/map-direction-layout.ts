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
export const DIRECTION_CLUSTER_WIDTH = 176;
export const DIRECTION_MARKER_GAP = 12;
const MAX_LABEL_WIDTH = 168;

/** Approximate the rendered label rather than treating every name as a 44px dot.
 * The measured DOM position is subsequently clamped against the actual viewport. */
export function directionLabelWidth(label: string) {
  return Math.min(MAX_LABEL_WIDTH, Math.max(84, Math.ceil([...label].length * 7.1 + 24)));
}

export type MapLabelPlacement = 'top' | 'bottom';
export type MapLabelRect = {left: number; right: number; top: number; bottom: number};
export type MapLabelSafeRect = MapLabelRect;
export type MapLabelAvoidance = {x:number;y:number;hidden:boolean};

/** The label-safe rectangle excludes edge clipping and fixed map controls.
 * The compact bottom edge is additionally capped at the top of the mobile sheet. */
export const MAP_LABEL_SAFE_AREA = {
  wide: {edge: 18, top: 72, right: 78, bottom: 60},
  compact: {edge: 12, top: 62, right: 58, bottom: 12},
} as const;
export const MAP_LABEL_OBSTACLE_SELECTORS = [
  '.map-context','.map-style-switch','.map-controls','.layer-control','.map-message',
  '.map-legend','.map-attribution','.fact-card','.fact-closed','.explore-panel',
] as const;

export function mapLabelSafeRect(viewport: MapLabelRect, compact: boolean, coveredBottom?: number): MapLabelSafeRect {
  const preset = compact ? MAP_LABEL_SAFE_AREA.compact : MAP_LABEL_SAFE_AREA.wide;
  let left = viewport.left + preset.edge;
  let right = viewport.right - preset.right;
  let top = viewport.top + preset.top;
  let bottom = Math.min(viewport.bottom - preset.bottom, coveredBottom ?? Number.POSITIVE_INFINITY);
  // On unusually small embeds preserve a valid rectangle instead of making all
  // labels chase an impossible set of control insets.
  if (right - left < 160) right = viewport.right - preset.edge;
  if (bottom - top < 96) {
    top = viewport.top + preset.edge;
    bottom = Math.min(viewport.bottom - preset.edge, coveredBottom ?? Number.POSITIVE_INFINITY);
  }
  right = Math.max(left + 1, right);
  bottom = Math.max(top + 1, bottom);
  return {left, right, top, bottom};
}

/** Clamp a measured label to all four sides of the already resolved safe area. */
export function mapLabelShift(label: MapLabelRect, safe: MapLabelSafeRect) {
  const values = [...Object.values(label), ...Object.values(safe)];
  if (!values.every(Number.isFinite) || label.right < label.left || label.bottom < label.top) return {x: 0, y: 0};
  const labelWidth = label.right - label.left, labelHeight = label.bottom - label.top;
  const safeWidth = safe.right - safe.left, safeHeight = safe.bottom - safe.top;
  let x = 0, y = 0;
  if (labelWidth >= safeWidth) x = safe.left - label.left;
  else if (label.left < safe.left) x = safe.left - label.left;
  else if (label.right > safe.right) x = safe.right - label.right;
  if (labelHeight >= safeHeight) y = safe.top - label.top;
  else if (label.top < safe.top) y = safe.top - label.top;
  else if (label.bottom > safe.bottom) y = safe.bottom - label.bottom;
  return {x, y};
}
const translateRect=(rect:MapLabelRect,x:number,y:number):MapLabelRect=>({left:rect.left+x,right:rect.right+x,top:rect.top+y,bottom:rect.bottom+y});
const insideSafe=(rect:MapLabelRect,safe:MapLabelSafeRect)=>rect.left>=safe.left-.5&&rect.right<=safe.right+.5&&rect.top>=safe.top-.5&&rect.bottom<=safe.bottom+.5;
const intersects=(a:MapLabelRect,b:MapLabelRect,gap=0)=>a.left<b.right+gap&&a.right>b.left-gap&&a.top<b.bottom+gap&&a.bottom>b.top-gap;

/** Resolve collisions with real overlays after the four-edge clamp. Labels may
 * move, but their geographic marker never does. If no legal position exists,
 * hiding the visual label is safer than drawing it over a control or card; the
 * button keeps its accessible name. */
export function mapLabelAvoidObstacles(label:MapLabelRect,safe:MapLabelSafeRect,obstacles:readonly MapLabelRect[],gap=8):MapLabelAvoidance{
  const initial=mapLabelShift(label,safe);let x=initial.x,y=initial.y,current=translateRect(label,x,y);
  const usable=obstacles.filter(obstacle=>[...Object.values(obstacle)].every(Number.isFinite)&&obstacle.right>obstacle.left&&obstacle.bottom>obstacle.top);
  for(let pass=0;pass<Math.min(16,usable.length+4);pass++){
    const obstacle=usable.find(item=>intersects(current,item,gap));
    if(!obstacle)return{x,y,hidden:Math.hypot(x,y)>180};
    const moves=[
      {dx:obstacle.left-gap-current.right,dy:0},
      {dx:obstacle.right+gap-current.left,dy:0},
      {dx:0,dy:obstacle.top-gap-current.bottom},
      {dx:0,dy:obstacle.bottom+gap-current.top},
    ].map(move=>({...move,rect:translateRect(current,move.dx,move.dy)}))
      .filter(move=>insideSafe(move.rect,safe))
      .sort((a,b)=>(Math.abs(a.dx)+Math.abs(a.dy))-(Math.abs(b.dx)+Math.abs(b.dy)));
    const best=moves[0];if(!best)return{x,y,hidden:true};
    x+=best.dx;y+=best.dy;current=best.rect;
  }
  return{x,y,hidden:true};
}

/** Prefer the semantic side of a marker, but flip before applying translation. */
export function mapLabelPlacement(
  preferred: MapLabelPlacement, marker: MapLabelRect, labelHeight: number,
  safe: MapLabelSafeRect, gap = 8,
): MapLabelPlacement {
  const above = marker.top - safe.top - gap;
  const below = safe.bottom - marker.bottom - gap;
  if (preferred === 'top') return above >= labelHeight || above >= below ? 'top' : 'bottom';
  return below >= labelHeight || below >= above ? 'bottom' : 'top';
}

function visibleObstacleRect(element:Element,viewport:MapLabelRect){
  const style=getComputedStyle(element);
  if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return undefined;
  const rect=element.getBoundingClientRect();
  if(rect.width<2||rect.height<2||!intersects(rect,viewport))return undefined;
  return{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};
}
function viewportLabelLayout(viewport:HTMLElement){
  const bounds=viewport.getBoundingClientRect();
  const root=viewport.closest('.explore-layout')??viewport.parentElement??viewport;
  const panel=root.querySelector<HTMLElement>('.explore-panel');
  let coveredBottom:number|undefined;
  if(panel){
    const covered=panel.getBoundingClientRect();
    const overlaps=covered.left<bounds.right&&covered.right>bounds.left&&covered.top>bounds.top&&covered.top<bounds.bottom;
    if(overlaps)coveredBottom=covered.top-12;
  }
  const safe=mapLabelSafeRect(bounds,viewport.clientWidth<=700,coveredBottom);
  const selector=MAP_LABEL_OBSTACLE_SELECTORS.join(',');
  const obstacles=[...root.querySelectorAll(selector)]
    .filter(element=>element!==viewport&&!element.contains(viewport))
    .map(element=>visibleObstacleRect(element,bounds)).filter((rect):rect is MapLabelRect=>!!rect);
  return{safe,obstacles};
}

function constrainLabel(
  button:HTMLButtonElement,label:HTMLElement,preferred:MapLabelPlacement,
  safe:MapLabelSafeRect,obstacles:readonly MapLabelRect[],
){
  button.dataset.mapLabelPlacement=preferred;
  delete button.dataset.mapLabelHidden;
  label.style.setProperty('--map-label-shift-x','0px');
  label.style.setProperty('--map-label-shift-y','0px');
  const marker=button.getBoundingClientRect();
  let rect=label.getBoundingClientRect();
  const placement=mapLabelPlacement(preferred,marker,rect.bottom-rect.top,safe);
  if(placement!==preferred){button.dataset.mapLabelPlacement=placement;rect=label.getBoundingClientRect();}
  const shift=mapLabelAvoidObstacles(rect,safe,obstacles);
  label.style.setProperty('--map-label-shift-x',`${Math.round(shift.x)}px`);
  label.style.setProperty('--map-label-shift-y',`${Math.round(shift.y)}px`);
  if(shift.hidden)button.dataset.mapLabelHidden='true';
  button.classList.toggle('map-label-shifted',shift.x!==0||shift.y!==0||placement!==preferred);
}

/** Called after marker placement, during camera movement and after sheet resize.
 * Geographic anchors never move: only their visual labels flip and translate. */
export function constrainDirectionLabels(buttons:ReadonlyMap<string,HTMLButtonElement>,viewport:HTMLElement){
  const {safe,obstacles}=viewportLabelLayout(viewport);
  for(const button of buttons.values()){
    if(button.hidden||!button.isConnected)continue;
    const label=button.querySelector<HTMLElement>('.region-marker-label');
    if(label)constrainLabel(button,label,'bottom',safe,obstacles);
  }
  for(const button of viewport.querySelectorAll<HTMLButtonElement>('.trail-marker')){
    if(!button.isConnected)continue;
    const label=button.querySelector<HTMLElement>('.trail-marker-label');
    if(label)constrainLabel(button,label,'top',safe,obstacles);
  }
}

/** Reflow labels when fonts, responsive cards, controls or the mobile sheet
 * change outside the map engine's own move events. Mutations produced by map
 * marker transforms are ignored to avoid a feedback loop. */
export function bindMapLabelReflow(viewport:HTMLElement,schedule:()=>void){
  const root=viewport.closest('.explore-layout')??viewport.parentElement??viewport;
  const selector=MAP_LABEL_OBSTACLE_SELECTORS.join(',');
  const resize=new ResizeObserver(schedule),observed=new Set<Element>();
  const observe=()=>{
    for(const element of [viewport,...root.querySelectorAll(selector)])if(!observed.has(element)){observed.add(element);resize.observe(element);}
  };
  observe();
  const mutation=new MutationObserver(records=>{
    const relevant=records.some(record=>{
      const target=record.target;return !(target instanceof Element)||!target.closest('.atlas-canvas');
    });
    if(relevant){observe();schedule();}
  });
  mutation.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-expanded']});
  const eventSchedule=()=>schedule();
  root.addEventListener('pointerover',eventSchedule,true);
  root.addEventListener('focusin',eventSchedule,true);
  root.addEventListener('transitionend',eventSchedule,true);
  const fonts=document.fonts;
  void fonts.ready.then(schedule).catch(()=>undefined);
  fonts.addEventListener('loadingdone',eventSchedule);
  schedule();
  return()=>{
    resize.disconnect();mutation.disconnect();
    root.removeEventListener('pointerover',eventSchedule,true);
    root.removeEventListener('focusin',eventSchedule,true);
    root.removeEventListener('transitionend',eventSchedule,true);
    fonts.removeEventListener('loadingdone',eventSchedule);
  };
}

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
      width: members.length > 1 ? DIRECTION_CLUSTER_WIDTH : directionLabelWidth(anchor.name),
      height: members.length > 1 || anchor.name.length > 22 ? 68 : 56,
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
    button.removeAttribute('title');
  }
  if (focusedId && !anchors.has(focusedId)) {
    const group = groups.find(item => item.members.some(member => member.id === focusedId));
    if (group) buttons.get(group.anchor.id)?.focus({preventScroll: true});
  }
  return anchors;
}
