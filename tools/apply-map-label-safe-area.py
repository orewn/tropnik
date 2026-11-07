#!/usr/bin/env python3
"""Apply the reviewed four-edge map label rules.

This is a one-time, strict migration helper. It fails when the reviewed source
anchors move and is removed before merge.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
changed: list[str] = []


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if new in text:
        return
    if old not in text:
        raise RuntimeError(f"{path}: missing patch anchor: {label}")
    target.write_text(text.replace(old, new, 1))
    changed.append(path)


def append_once(path: str, marker: str, addition: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if marker in text:
        return
    target.write_text(text.rstrip() + "\n\n" + addition.strip() + "\n")
    changed.append(path)


layout = "web/lib/map-direction-layout.ts"
old_layout = '''/** A pure, deterministic edge clamp so border and narrow-screen cases can be tested. */
export function directionLabelShift(labelLeft: number, labelRight: number, viewLeft: number, viewRight: number, inset = 16) {
  const values = [labelLeft, labelRight, viewLeft, viewRight, inset];
  if (!values.every(Number.isFinite) || labelRight < labelLeft || viewRight - viewLeft <= inset * 2) return 0;
  const min = viewLeft + inset, max = viewRight - inset;
  if (labelRight - labelLeft >= max - min) return min - labelLeft;
  if (labelLeft < min) return min - labelLeft;
  if (labelRight > max) return max - labelRight;
  return 0;
}

/** Called after the map places its DOM markers, including after resizing the map.
 * Visual labels move inside the atlas; the marker's geographic anchor never moves. */
export function constrainDirectionLabels(buttons: ReadonlyMap<string, HTMLButtonElement>, viewport: HTMLElement) {
  const bounds = viewport.getBoundingClientRect();
  const inset = viewport.clientWidth <= 600 ? 12 : 18;
  for (const button of buttons.values()) {
    if (button.hidden || !button.isConnected) continue;
    const label = button.querySelector<HTMLElement>('.region-marker-label');
    if (!label) continue;
    label.style.setProperty('--map-label-shift', '0px');
    const rect = label.getBoundingClientRect();
    const shift = directionLabelShift(rect.left, rect.right, bounds.left, bounds.right, inset);
    label.style.setProperty('--map-label-shift', String(Math.round(shift)) + 'px');
  }
}
'''
new_layout = '''export type MapLabelPlacement = 'top' | 'bottom';
export type MapLabelRect = {left: number; right: number; top: number; bottom: number};
export type MapLabelSafeRect = MapLabelRect;

/** The label-safe rectangle excludes edge clipping and fixed map controls.
 * The compact bottom edge is additionally capped at the top of the mobile sheet. */
export const MAP_LABEL_SAFE_AREA = {
  wide: {edge: 18, top: 72, right: 78, bottom: 60},
  compact: {edge: 12, top: 62, right: 58, bottom: 12},
} as const;

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

function viewportSafeRect(viewport: HTMLElement) {
  const bounds = viewport.getBoundingClientRect();
  const panel = viewport.closest('.explore-layout')?.querySelector<HTMLElement>('.explore-panel');
  let coveredBottom: number | undefined;
  if (panel) {
    const covered = panel.getBoundingClientRect();
    const overlaps = covered.left < bounds.right && covered.right > bounds.left
      && covered.top > bounds.top && covered.top < bounds.bottom;
    if (overlaps) coveredBottom = covered.top - 12;
  }
  return mapLabelSafeRect(bounds, viewport.clientWidth <= 700, coveredBottom);
}

function constrainLabel(
  button: HTMLButtonElement, label: HTMLElement, viewport: HTMLElement,
  preferred: MapLabelPlacement,
) {
  const safe = viewportSafeRect(viewport);
  button.dataset.mapLabelPlacement = preferred;
  label.style.setProperty('--map-label-shift-x', '0px');
  label.style.setProperty('--map-label-shift-y', '0px');
  const marker = button.getBoundingClientRect();
  let rect = label.getBoundingClientRect();
  const placement = mapLabelPlacement(preferred, marker, rect.bottom - rect.top, safe);
  if (placement !== preferred) {
    button.dataset.mapLabelPlacement = placement;
    rect = label.getBoundingClientRect();
  }
  const shift = mapLabelShift(rect, safe);
  label.style.setProperty('--map-label-shift-x', `${Math.round(shift.x)}px`);
  label.style.setProperty('--map-label-shift-y', `${Math.round(shift.y)}px`);
  button.classList.toggle('map-label-shifted', shift.x !== 0 || shift.y !== 0 || placement !== preferred);
}

/** Called after marker placement, during camera movement and after sheet resize.
 * Geographic anchors never move: only their visual labels flip and translate. */
export function constrainDirectionLabels(buttons: ReadonlyMap<string, HTMLButtonElement>, viewport: HTMLElement) {
  for (const button of buttons.values()) {
    if (button.hidden || !button.isConnected) continue;
    const label = button.querySelector<HTMLElement>('.region-marker-label');
    if (label) constrainLabel(button, label, viewport, 'bottom');
  }
  for (const button of viewport.querySelectorAll<HTMLButtonElement>('.trail-marker')) {
    if (!button.isConnected) continue;
    const label = button.querySelector<HTMLElement>('.trail-marker-label');
    if (label) constrainLabel(button, label, viewport, 'top');
  }
}
'''
replace_once(layout, old_layout, new_layout, "four-edge label layout")
replace_once(
    layout,
    "    button.title = content.cluster ? content.ariaLabel : group.anchor.name;\n",
    "    button.removeAttribute('title');\n",
    "remove native direction tooltip",
)

atlas = "web/components/Atlas.tsx"
replace_once(
    atlas,
    "    updateDirections.current();\n    if(regionRef.current&&!fitTerritory",
    "    updateDirections.current();\n    map.on('move',scheduleLabelClamp);\n    if(regionRef.current&&!fitTerritory",
    "clamp WebGL labels during camera movement",
)
old_webgl_routes = '''  import('maplibre-gl').then(ml=>{if(removed)return;for(const t of visibleTrails){
   if(!t.center||!inRussiaCoverage(...t.center,coverage.area))continue;
   const button=document.createElement('button');button.className='trail-marker';button.setAttribute('aria-label',`Открыть маршрут ${t.title}`);button.title=t.title;
   button.addEventListener('click',event=>{event.stopPropagation();onTrail?.(t);});routeMarkers.push(new ml.Marker({element:button}).setLngLat([russiaLongitude(t.center[0]),t.center[1]]).addTo(map));
  }});
'''
new_webgl_routes = '''  import('maplibre-gl').then(ml=>{
   if(removed)return;
   for(const t of visibleTrails){
    if(!t.center||!inRussiaCoverage(...t.center,coverage.area))continue;
    const button=document.createElement('button');button.type='button';button.className='trail-marker';button.setAttribute('aria-label',`Открыть маршрут ${t.title}`);
    const label=document.createElement('span');label.className='trail-marker-label';label.setAttribute('aria-hidden','true');label.textContent=t.title;button.appendChild(label);
    button.addEventListener('click',event=>{event.stopPropagation();onTrail?.(t);});
    routeMarkers.push(new ml.Marker({element:button,anchor:'center'}).setLngLat([russiaLongitude(t.center[0]),t.center[1]]).addTo(map));
   }
   requestAnimationFrame(()=>{if(!removed)updateDirections.current?.();});
  });
'''
replace_once(atlas, old_webgl_routes, new_webgl_routes, "controlled WebGL route labels")

canvas = "web/components/Atlas2D.tsx"
replace_once(
    canvas,
    "    updateDirections.current();\n    points.current=L.layerGroup().addTo(map);",
    "    updateDirections.current();\n    map.on('move',scheduleLabelClamp);\n    points.current=L.layerGroup().addTo(map);",
    "clamp Leaflet labels during camera movement",
)
old_leaflet_routes = '''   for(const item of visibleTrails){
    if(!item.center||!inRussiaCoverage(...item.center,coverage.area))continue;
    const marker=L.circleMarker([item.center[1],russiaLongitude(item.center[0])],{radius:5.5,color:'#fffefa',weight:2,fillColor:'#a47842',fillOpacity:1,opacity:1});
    const label=document.createElement('span');label.textContent=item.title;marker.bindTooltip(label,{direction:'top',offset:[0,-5]});marker.on('click',()=>callbacks.current.onTrail?.(item));points.current?.addLayer(marker);
   }
'''
new_leaflet_routes = '''   for(const item of visibleTrails){
    if(!item.center||!inRussiaCoverage(...item.center,coverage.area))continue;
    const button=document.createElement('button');button.type='button';button.className='trail-marker';button.setAttribute('aria-label',`Открыть маршрут ${item.title}`);
    const label=document.createElement('span');label.className='trail-marker-label';label.setAttribute('aria-hidden','true');label.textContent=item.title;button.appendChild(label);
    button.addEventListener('click',event=>{event.stopPropagation();callbacks.current.onTrail?.(item);});
    const marker=L.marker([item.center[1],russiaLongitude(item.center[0])],{icon:L.divIcon({html:button,className:'leaflet-route-marker',iconSize:[32,32],iconAnchor:[16,16]}),keyboard:false});
    points.current?.addLayer(marker);
   }
   requestAnimationFrame(()=>{if(!stale)updateDirections.current?.();});
'''
replace_once(canvas, old_leaflet_routes, new_leaflet_routes, "controlled Leaflet route labels")

css = "web/app/map-polish.css"
append_once(css, "/* Four-edge map label safe area. */", r'''
/* Four-edge map label safe area.
 * JS keeps every label inside the same explicit safe rectangle; overflow
 * clipping remains the final defence, never the primary placement strategy. */
.explore-layout .atlas-wrap,
.explore-layout .atlas-canvas{overflow:hidden}
.explore-layout .region-marker{
  position:relative;
  display:block;
  width:44px;
  height:44px;
  min-width:44px;
  min-height:44px;
  padding:0;
  overflow:visible;
}
.explore-layout .region-marker-dot{
  position:absolute;
  left:50%;
  top:50%;
  z-index:2;
  transform:translate(-50%,-50%);
}
.explore-layout .region-marker:hover .region-marker-dot{
  transform:translate(-50%,-50%) scale(1.3);
}
.explore-layout .region-marker-label{
  position:absolute;
  left:50%;
  top:calc(50% + 11px);
  width:max-content;
  max-width:168px;
  min-width:0;
  pointer-events:none;
  transform:translate(calc(-50% + var(--map-label-shift-x,0px)),var(--map-label-shift-y,0px));
  transform-origin:50% 0;
  will-change:transform;
}
.explore-layout .region-marker[data-map-label-placement='top'] .region-marker-label{
  top:auto;
  bottom:calc(50% + 11px);
  transform-origin:50% 100%;
}
.explore-layout .direction-cluster .region-marker-label{min-width:132px}
.explore-layout .trail-marker{
  position:relative;
  display:grid;
  place-items:center;
  width:32px;
  height:32px;
  padding:0;
  border:0!important;
  border-radius:50%;
  background:transparent;
  box-shadow:none;
  overflow:visible;
}
.explore-layout .trail-marker::before{
  content:'';
  width:15px;
  height:15px;
  border:2px solid var(--surface);
  border-radius:50%;
  background:var(--ochre);
  box-shadow:0 0 0 1px rgba(135,106,67,.38),0 2px 7px rgba(39,64,38,.21);
  transition:transform .16s ease,background .16s ease;
}
.explore-layout .trail-marker:hover,
.explore-layout .trail-marker:focus-visible{background:transparent}
.explore-layout .trail-marker:hover::before,
.explore-layout .trail-marker:focus-visible::before{
  background:var(--forest);
  transform:scale(1.16);
}
.explore-layout .trail-marker-label{
  position:absolute;
  left:50%;
  bottom:calc(50% + 12px);
  z-index:12;
  width:max-content;
  max-width:min(230px,calc(100vw - 40px));
  padding:7px 10px;
  border:1px solid rgba(76,99,79,.56);
  border-radius:8px;
  background:rgba(255,254,250,.98);
  color:var(--forest);
  box-shadow:0 7px 20px rgba(29,48,38,.14);
  font:600 11px/1.4 Manrope,system-ui,sans-serif;
  text-align:center;
  white-space:normal;
  overflow-wrap:break-word;
  pointer-events:none;
  opacity:0;
  visibility:hidden;
  transform:translate(calc(-50% + var(--map-label-shift-x,0px)),var(--map-label-shift-y,0px));
  transform-origin:50% 100%;
  transition:opacity .12s ease;
}
.explore-layout .trail-marker[data-map-label-placement='bottom'] .trail-marker-label{
  top:calc(50% + 12px);
  bottom:auto;
  transform-origin:50% 0;
}
.explore-layout .trail-marker:hover .trail-marker-label,
.explore-layout .trail-marker:focus-visible .trail-marker-label{
  opacity:1;
  visibility:visible;
}
.explore-layout .leaflet-route-marker{background:none;border:0}
@media(max-width:700px){
  .explore-layout .region-marker{width:38px;height:38px;min-width:38px;min-height:38px}
  .explore-layout .region-marker-label{max-width:138px}
  .explore-layout .direction-cluster .region-marker-label{min-width:108px}
  .explore-layout .trail-marker-label{max-width:min(190px,calc(100vw - 32px));font-size:10px}
}
''')

unit = "web/tests/map-direction-layout.test.mjs"
replace_once(
    unit,
    "import {groupMapDirections,directionGroupsOverlap,directionMarkerContent,directionCountLabel,directionLabelShift,directionLabelWidth,updateDirectionButtons} from '../lib/map-direction-layout.ts';\n",
    "import {groupMapDirections,directionGroupsOverlap,directionMarkerContent,directionCountLabel,directionLabelWidth,mapLabelPlacement,mapLabelSafeRect,mapLabelShift,updateDirectionButtons} from '../lib/map-direction-layout.ts';\n",
    "safe-area unit imports",
)
replace_once(
    unit,
    "      setAttribute:(name,value)=>attributes.set(name,value),\n      focus:options=>{assert.equal(options.preventScroll,true);ownerDocument.activeElement=buttons.get(id);},\n",
    "      setAttribute:(name,value)=>attributes.set(name,value),\n      removeAttribute:name=>attributes.delete(name),\n      focus:options=>{assert.equal(options.preventScroll,true);ownerDocument.activeElement=buttons.get(id);},\n",
    "fake button title removal",
)
old_edge_test = '''test('edge clamp keeps every map label inside the visible atlas',()=>{
  assert.equal(directionLabelShift(-30,110,0,1000,18),48);
  assert.equal(directionLabelShift(920,1040,0,1000,18),-58);
  assert.equal(directionLabelShift(200,320,0,1000,18),0);
  assert.ok(directionLabelWidth('Петропавловск-Камчатский')<=168);
  assert.ok(directionLabelWidth('Алтай')>=84);
});'''
new_edge_test = '''test('safe-area rules keep labels inside all four map edges',()=>{
  const wide=mapLabelSafeRect({left:0,right:1000,top:0,bottom:800},false);
  assert.deepEqual(wide,{left:18,right:922,top:72,bottom:740});
  const compact=mapLabelSafeRect({left:0,right:390,top:0,bottom:772},true,410);
  assert.deepEqual(compact,{left:12,right:332,top:62,bottom:410});
  assert.deepEqual(mapLabelShift({left:-30,right:110,top:90,bottom:130},wide),{x:48,y:0});
  assert.deepEqual(mapLabelShift({left:900,right:1040,top:710,bottom:770},wide),{x:-118,y:-30});
  assert.equal(mapLabelPlacement('bottom',{left:100,right:132,top:700,bottom:732},40,wide),'top');
  assert.equal(mapLabelPlacement('top',{left:100,right:132,top:75,bottom:107},40,wide),'bottom');
  assert.ok(directionLabelWidth('Петропавловск-Камчатский')<=168);
  assert.ok(directionLabelWidth('Алтай')>=84);
});'''
replace_once(unit, old_edge_test, new_edge_test, "four-edge unit test")

polish = "web/tests/map-polish.test.mjs"
append_once(polish, "map marker labels never delegate edge placement to native browser tooltips", r'''
test('map marker labels never delegate edge placement to native browser tooltips',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const layout=read('lib/map-direction-layout.ts');
  const css=read('app/map-polish.css');
  assert.match(layout,/MAP_LABEL_SAFE_AREA/);
  assert.match(layout,/mapLabelPlacement/);
  assert.match(layout,/coveredBottom/);
  assert.match(atlas,/trail-marker-label/);
  assert.match(canvas,/trail-marker-label/);
  assert.doesNotMatch(atlas,/button\.title=t\.title/);
  assert.doesNotMatch(canvas,/bindTooltip/);
  assert.match(layout,/removeAttribute\('title'\)/);
  assert.match(css,/data-map-label-placement='top'/);
  assert.match(css,/--map-label-shift-x/);
  assert.match(css,/--map-label-shift-y/);
  assert.match(css,/atlas-canvas\{overflow:hidden\}/);
});
''')

doc = "docs/MAP-VISUAL-SYSTEM.md"
append_once(doc, "## Label boundaries", r'''
## Label boundaries

Map labels use an explicit safe rectangle rather than the browser's native `title` tooltip placement.

- Desktop safe area: 18 px from the left edge, 72 px below the top controls, 78 px before the right control rail, and 60 px above the bottom legend/credits.
- Compact safe area: 12 px from the left/bottom edge, 62 px below the top controls, and 58 px before the right controls.
- When the mobile route sheet overlaps the map, its top edge minus 12 px becomes the hard lower boundary.
- Direction labels prefer the side below their geographic point; route labels prefer the side above it. A label flips first, then receives the smallest required horizontal and vertical translation.
- The marker remains on the real geographic coordinate. Only its label may move.
- Browser-native marker tooltips are forbidden because the browser may position them outside the map. Accessible names remain on the buttons through `aria-label`.
- The map canvas clips overflow only as a final defence. A correctly placed label must already fit inside the safe rectangle.
''')

print({"changed": sorted(set(changed))})
