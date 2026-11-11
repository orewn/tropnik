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
export type MapAnchorShift = {x:number;y:number};

function setInlineProperty(element:HTMLElement,name:string,value:string){
  if(element.style.getPropertyValue(name)!==value)element.style.setProperty(name,value);
}

/** Resolve the correction from the engine's projected coordinate to the actual
 * 44×44 DOM control centre. The current correction is removed before the next
 * value is calculated, so repeated zoom frames are idempotent rather than
 * cumulative. */
export function directionAnchorCorrection(
  rect:MapLabelRect,point:DirectionScreenPoint,viewport:Pick<MapLabelRect,'left'|'top'>,
  current:MapAnchorShift={x:0,y:0},
):MapAnchorShift{
  const values=[...Object.values(rect),point.x,point.y,viewport.left,viewport.top,current.x,current.y];
  if(!values.every(Number.isFinite)||rect.right<=rect.left||rect.bottom<=rect.top)return{x:0,y:0};
  const baseX=(rect.left+rect.right)/2-current.x;
  const baseY=(rect.top+rect.bottom)/2-current.y;
  const x=viewport.left+point.x-baseX,y=viewport.top+point.y-baseY;
  return{x:Math.abs(x)<.25?0:x,y:Math.abs(y)<.25?0:y};
}

/** Keep the visible control centred on the map engine coordinate even when
 * legacy CSS, browser zoom or an animated map pane changes its measured box.
 * Only the inner control receives a CSS `translate`; the source longitude and
 * latitude remain untouched. */
export function reconcileDirectionAnchors(
  buttons:ReadonlyMap<string,HTMLButtonElement>,points:ReadonlyMap<string,DirectionScreenPoint>,viewport:HTMLElement,
){
  const bounds=viewport.getBoundingClientRect(),corrections:{button:HTMLButtonElement;x:number;y:number}[]=[];
  // Measure every anchor before changing any transform: a correction must not
  // force the next marker to synchronously lay out the map again.
  for(const [id,button] of buttons){
    if(button.hidden||!button.isConnected)continue;
    const point=points.get(id);if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))continue;
    const rect=button.getBoundingClientRect();if(rect.width<8||rect.height<8)continue;
    const current={x:Number(button.dataset.mapAnchorShiftX||0),y:Number(button.dataset.mapAnchorShiftY||0)};
    const next=directionAnchorCorrection({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},point,{left:bounds.left,top:bounds.top},current);
    if(Math.abs(next.x)>Math.max(bounds.width,256)||Math.abs(next.y)>Math.max(bounds.height,256))continue;
    const x=Math.round(next.x*4)/4,y=Math.round(next.y*4)/4;
    corrections.push({button,x,y});
  }
  for(const {button,x,y} of corrections){
    if(button.dataset.mapAnchorShiftX!==String(x))button.dataset.mapAnchorShiftX=String(x);
    if(button.dataset.mapAnchorShiftY!==String(y))button.dataset.mapAnchorShiftY=String(y);
    setInlineProperty(button,'--map-anchor-shift-x',`${x}px`);
    setInlineProperty(button,'--map-anchor-shift-y',`${y}px`);
  }
  return corrections.length;
}

/** The label-safe rectangle excludes edge clipping and fixed map controls.
 * The compact bottom edge is additionally capped at the top of the mobile sheet. */
export const MAP_LABEL_SAFE_AREA = {
  // Fixed controls are measured as obstacles. The base rectangle protects only
  // the physical viewport edges, so narrow phones do not lose usable space to
  // guessed control dimensions.
  wide: {edge: 18, top: 18, right: 18, bottom: 18},
  compact: {edge: 12, top: 12, right: 12, bottom: 12},
} as const;
export const MAP_LABEL_OBSTACLE_SELECTORS = [
  '.map-context','.map-style-switch','.map-controls','.layer-control','.map-message','.map-preload-status',
  '.map-legend','.map-attribution','.fact-card','.fact-closed','.explore-panel',
] as const;

export function mapLabelSafeRect(viewport: MapLabelRect, compact: boolean, coveredBottom?: number): MapLabelSafeRect {
  const preset = compact ? MAP_LABEL_SAFE_AREA.compact : MAP_LABEL_SAFE_AREA.wide;
  const left = viewport.left + preset.edge;
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
function effectiveVisualRect(bounds:MapLabelRect):MapLabelRect{
  if(typeof window==='undefined'||!window.visualViewport)return bounds;
  const visual=window.visualViewport;
  const candidate={
    left:Math.max(bounds.left,visual.offsetLeft),
    right:Math.min(bounds.right,visual.offsetLeft+visual.width),
    top:Math.max(bounds.top,visual.offsetTop),
    bottom:Math.min(bounds.bottom,visual.offsetTop+visual.height),
  };
  return candidate.right-candidate.left>=80&&candidate.bottom-candidate.top>=80?candidate:bounds;
}
function viewportLabelLayout(viewport:HTMLElement){
  const bounds=viewport.getBoundingClientRect(),visible=effectiveVisualRect(bounds);
  const root=viewport.closest('.explore-layout')??viewport.parentElement??viewport;
  const panel=root.querySelector<HTMLElement>('.explore-panel');
  let coveredBottom:number|undefined;
  if(panel){
    const covered=panel.getBoundingClientRect();
    const overlaps=covered.left<visible.right&&covered.right>visible.left&&covered.top>visible.top&&covered.top<visible.bottom;
    if(overlaps)coveredBottom=Math.max(visible.top+72,covered.top-12);
  }
  const compact=Math.min(viewport.clientWidth,visible.right-visible.left)<=700;
  const safe=mapLabelSafeRect(visible,compact,coveredBottom);
  const selector=MAP_LABEL_OBSTACLE_SELECTORS.join(',');
  const obstacles=[...root.querySelectorAll(selector)]
    .filter(element=>element!==viewport&&!element.contains(viewport))
    .map(element=>visibleObstacleRect(element,visible)).filter((rect):rect is MapLabelRect=>!!rect);
  return{safe,obstacles,compact};
}

type MeasuredMapLabel={
  button:HTMLButtonElement;label:HTMLElement;preferred:MapLabelPlacement;placement:MapLabelPlacement;
  rect?:DOMRect;shift?:MapLabelAvoidance;
};

/** Reflow settled markers without one forced layout per label. Prepare all
 * labels, measure all, apply side flips together, then measure only the flipped
 * labels. Collision resolution uses those snapshots, so its final writes never
 * alternate with DOM measurements. Geographic anchors and priority stay intact. */
export function constrainDirectionLabels(buttons:ReadonlyMap<string,HTMLButtonElement>,viewport:HTMLElement){
  const {safe,obstacles}=viewportLabelLayout(viewport),labels:MeasuredMapLabel[]=[];
  const ordered=[...buttons.values()].filter(button=>!button.hidden&&button.isConnected).sort((a,b)=>{
    const priority=(button:HTMLButtonElement)=>button.classList.contains('is-selected')?0:button.classList.contains('direction-cluster')?1:2;
    return priority(a)-priority(b)||(a.dataset.regionId??'').localeCompare(b.dataset.regionId??'','en');
  });
  for(const button of ordered){
    const label=button.querySelector<HTMLElement>('.region-marker-label');
    if(!label)continue;
    labels.push({button,label,preferred:'bottom',placement:'bottom'});
  }
  for(const button of viewport.querySelectorAll<HTMLButtonElement>('.trail-marker')){
    if(!button.isConnected)continue;
    const label=button.querySelector<HTMLElement>('.trail-marker-label');
    if(!label)continue;
    const active=button.classList.contains('is-selected')||button.matches(':hover,:focus-visible,:focus-within');
    if(!active){delete button.dataset.mapLabelHidden;setInlineProperty(label,'--map-label-shift-x','0px');setInlineProperty(label,'--map-label-shift-y','0px');continue;}
    labels.push({button,label,preferred:'top',placement:'top'});
  }
  const available=Math.max(48,safe.right-safe.left-12);
  for(const {button,label,preferred} of labels){
    if(button.dataset.mapLabelPlacement!==preferred)button.dataset.mapLabelPlacement=preferred;
    delete button.dataset.mapLabelHidden;
    const maximum=Math.max(48,Math.min(preferred==='top'?230:168,available));
    setInlineProperty(label,'--map-label-max-width',`${Math.floor(maximum)}px`);
    setInlineProperty(label,'--map-label-shift-x','0px');
    setInlineProperty(label,'--map-label-shift-y','0px');
  }
  for(const item of labels){
    const marker=item.button.getBoundingClientRect(),rect=item.label.getBoundingClientRect();
    if(rect.width<2||rect.height<2)continue;
    item.rect=rect;item.placement=mapLabelPlacement(item.preferred,marker,rect.height,safe);
  }
  for(const item of labels)if(item.rect&&item.placement!==item.preferred)item.button.dataset.mapLabelPlacement=item.placement;
  for(const item of labels)if(item.rect&&item.placement!==item.preferred)item.rect=item.label.getBoundingClientRect();
  // Reuse one obstacle list; every accepted label becomes an obstacle only for
  // the lower-priority labels that follow it, as in the previous sequential flow.
  for(const item of labels){
    if(!item.rect)continue;
    const shift=mapLabelAvoidObstacles(item.rect,safe,obstacles);
    item.shift={x:Math.round(shift.x),y:Math.round(shift.y),hidden:shift.hidden};
    if(!shift.hidden)obstacles.push(translateRect(item.rect,item.shift.x,item.shift.y));
  }
  for(const {button,label,preferred,placement,shift} of labels){
    if(!shift)continue;
    setInlineProperty(label,'--map-label-shift-x',`${shift.x}px`);
    setInlineProperty(label,'--map-label-shift-y',`${shift.y}px`);
    if(shift.hidden)button.dataset.mapLabelHidden='true';
    button.classList.toggle('map-label-shifted',shift.x!==0||shift.y!==0||placement!==preferred);
  }
}

/** Reflow labels when fonts, responsive cards, controls or the mobile sheet
 * change outside the map engine's own move events. Mutations produced by map
 * marker transforms are ignored to avoid a feedback loop. */
export function bindMapLabelReflow(viewport:HTMLElement,schedule:()=>void){
  const root=viewport.closest('.explore-layout')??viewport.parentElement??viewport;
  const selector=MAP_LABEL_OBSTACLE_SELECTORS.join(',');
  const innerObstacleSelector=MAP_LABEL_OBSTACLE_SELECTORS.filter(value=>value!=='.explore-panel').join(',');
  let frame=0,disposed=false;
  const queue=()=>{
    if(disposed||frame)return;
    frame=requestAnimationFrame(()=>{frame=0;if(!disposed)schedule();});
  };
  const resize=new ResizeObserver(queue),observed=new Set<Element>();
  const observe=()=>{
    const current=new Set<Element>([viewport,...root.querySelectorAll(selector)]);
    for(const element of observed)if(!current.has(element)){resize.unobserve(element);observed.delete(element);}
    for(const element of current)if(!observed.has(element)){observed.add(element);resize.observe(element);}
  };
  observe();
  const containsObstacle=(node:Node)=>node instanceof Element&&(observed.has(node)||node.matches(selector)||!!node.querySelector(selector));
  const mutation=new MutationObserver(records=>{
    if(disposed)return;
    const relevant=records.some(record=>{
      const target=record.target;
      if(!(target instanceof Element))return true;
      if(target.closest('.atlas-canvas'))return false;
      // The fixed-size drawer, rather than each route row, is the obstacle.
      // Search replaces cards and their classes on every keystroke, but none
      // of that changes the drawer's outer rectangle. Its ResizeObserver and
      // own class/visibility/settled-transform signals still request reflow.
      if(!target.closest('.explore-panel-content,.panel-foot'))return true;
      // Preserve real overlays even if a future layout nests one in the list.
      if(target.closest(innerObstacleSelector))return true;
      if(record.type==='attributes')return !!target.querySelector(selector);
      if(record.type==='childList')return [...record.addedNodes,...record.removedNodes].some(containsObstacle);
      return false;
    });
    if(relevant){observe();queue();}
  });
  mutation.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-expanded','data-sheet-state']});
  const relevantEvent=(event:Event)=>{
    const target=event.target;
    if(!(target instanceof Element))return;
    // Native pointer focus does not change region-label geometry. Avoid a
    // redundant regroup between down/up; keyboard focus still requests reflow.
    if(event.type==='focusin'&&target.closest('.region-marker')?.matches(':active'))return;
    if(target===root||target.matches('.explore-panel')||target.closest('.region-marker,.trail-marker,.fact-card,.fact-closed,.map-style-switch,.map-controls,.layer-control,.map-message'))queue();
  };
  root.addEventListener('focusin',relevantEvent,true);
  root.addEventListener('transitionend',relevantEvent,true);
  const fonts=document.fonts,visual=window.visualViewport;
  void fonts.ready.then(queue).catch(()=>undefined);
  fonts.addEventListener('loadingdone',queue);
  window.addEventListener('resize',queue,{passive:true});
  window.addEventListener('orientationchange',queue,{passive:true});
  visual?.addEventListener('resize',queue,{passive:true});
  visual?.addEventListener('scroll',queue,{passive:true});
  queue();
  return()=>{
    disposed=true;
    if(frame)cancelAnimationFrame(frame);
    resize.disconnect();mutation.disconnect();observed.clear();
    root.removeEventListener('focusin',relevantEvent,true);
    root.removeEventListener('transitionend',relevantEvent,true);
    fonts.removeEventListener('loadingdone',queue);
    window.removeEventListener('resize',queue);
    window.removeEventListener('orientationchange',queue);
    visual?.removeEventListener('resize',queue);
    visual?.removeEventListener('scroll',queue);
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

function stableDirectionAnchor<T extends MapDirection>(members:readonly T[],preferred:ReadonlySet<string>){
  const preferredMembers=members.filter(item=>preferred.has(item.id));
  const candidates=preferredMembers.length?preferredMembers:members;
  const latitude=members.reduce((sum,item)=>sum+item.center[1],0)/members.length;
  const scale=Math.max(.15,Math.cos(latitude*Math.PI/180));
  const longitude=(value:number)=>value<0?value+360:value;
  const score=(candidate:T)=>members.reduce((sum,item)=>{
    const dx=(longitude(candidate.center[0])-longitude(item.center[0]))*scale;
    const dy=candidate.center[1]-item.center[1];return sum+dx*dx+dy*dy;
  },0);
  return [...candidates].sort((a,b)=>score(a)-score(b)||a.id.localeCompare(b.id))[0];
}

/** Recompute on camera frames. Group membership follows screen-space overlap,
 * while the visible anchor stays on a stable real region centre. */
export function groupMapDirections<T extends MapDirection>(
  directions: readonly T[], project: (center: [number, number]) => DirectionScreenPoint,
  preferredAnchorIds:ReadonlySet<string>=new Set<string>(),
): MapDirectionGroup<T>[] {
  const points = new Map<string, DirectionScreenPoint>();
  const unique = [...new Map(directions.map(item => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const item of unique) points.set(item.id, project(item.center));
  const group = (members: T[]): MapDirectionGroup<T> => {
    members.sort((a, b) => a.id.localeCompare(b.id));
    // Preserve a surviving anchor across adjacent zoom frames. When a group
    // is new, use a geographic medoid independent of projection and pitch.
    const anchor = stableDirectionAnchor(members,preferredAnchorIds);
    const longitudes = members.map(item => item.center[0] < 0 ? item.center[0] + 360 : item.center[0]);
    const latitudes = members.map(item => item.center[1]);
    return {
      key: members.map(item => item.id).join('|'), members, anchor, point: points.get(anchor.id)!,
      bounds: [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)],
      width: members.length > 1 ? DIRECTION_CLUSTER_WIDTH : directionLabelWidth(anchor.name),
      // A 28px pennant and the padded, potentially wrapped label share the
      // control. Reserve their full height before deciding which regions group.
      height: members.length > 1 || anchor.name.length > 22 ? 88 : 72,
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
    count: cluster ? String(group.members.length) : overview ? String(routeCount) : '',
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
    if (button.hidden !== !group) button.hidden = !group;
    if (!group) {
      button.removeAttribute('data-map-anchor-region-id');
      button.removeAttribute('data-map-group-key');
      continue;
    }
    if (button.getAttribute('data-map-anchor-region-id') !== group.anchor.id) button.setAttribute('data-map-anchor-region-id',group.anchor.id);
    if (button.getAttribute('data-map-group-key') !== group.key) button.setAttribute('data-map-group-key',group.key);
    const content = directionMarkerContent(group, counts.get(id) || 0, overview);
    button.classList.toggle('direction-cluster', content.cluster);
    button.classList.toggle('is-overview', overview);
    button.classList.toggle('is-selected', group.members.some(item => item.id === selectedId));
    const count = button.querySelector('.region-marker-count'), label = button.querySelector('.region-marker-label');
    if (count && count.textContent !== content.count) count.textContent = content.count;
    if (label && label.textContent !== content.label) label.textContent = content.label;
    if (button.getAttribute('aria-label') !== content.ariaLabel) button.setAttribute('aria-label', content.ariaLabel);
    button.removeAttribute('title');
  }
  if (focusedId && !anchors.has(focusedId)) {
    const group = groups.find(item => item.members.some(member => member.id === focusedId));
    if (group) buttons.get(group.anchor.id)?.focus({preventScroll: true});
  }
  return anchors;
}
