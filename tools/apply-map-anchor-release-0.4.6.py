#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one anchor for {label}, found {count}")
    target.write_text(text.replace(old, new, 1))


def append_once(path: str, marker: str, addition: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if marker in text:
        return
    target.write_text(text.rstrip() + "\n\n" + addition.strip() + "\n")


# ---------------------------------------------------------------------------
# Shared direction layout: stable cluster anchors plus pixel-exact reconciliation
# between an engine projection and the actual DOM control centre.
# ---------------------------------------------------------------------------
layout = "web/lib/map-direction-layout.ts"
replace_once(
    layout,
    "export type MapLabelAvoidance = {x:number;y:number;hidden:boolean};\n",
    """export type MapLabelAvoidance = {x:number;y:number;hidden:boolean};
export type MapAnchorShift = {x:number;y:number};

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
  const bounds=viewport.getBoundingClientRect();let aligned=0;
  for(const [id,button] of buttons){
    if(button.hidden||!button.isConnected)continue;
    const point=points.get(id);if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))continue;
    const rect=button.getBoundingClientRect();if(rect.width<8||rect.height<8)continue;
    const current={x:Number(button.dataset.mapAnchorShiftX||0),y:Number(button.dataset.mapAnchorShiftY||0)};
    const next=directionAnchorCorrection({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},point,{left:bounds.left,top:bounds.top},current);
    if(Math.abs(next.x)>Math.max(bounds.width,256)||Math.abs(next.y)>Math.max(bounds.height,256))continue;
    const x=Math.round(next.x*4)/4,y=Math.round(next.y*4)/4;
    button.dataset.mapAnchorShiftX=String(x);button.dataset.mapAnchorShiftY=String(y);
    button.style.setProperty('--map-anchor-shift-x',`${x}px`);
    button.style.setProperty('--map-anchor-shift-y',`${y}px`);
    aligned++;
  }
  return aligned;
}
""",
    "anchor reconciliation helpers",
)
replace_once(
    layout,
    """/** Recompute after settled camera changes. The small catalogue needs no worker
 * or per-frame DOM churn; merging also accounts for the wider cluster label. */
export function groupMapDirections<T extends MapDirection>(directions: readonly T[], project: (center: [number, number]) => DirectionScreenPoint): MapDirectionGroup<T>[] {
""",
    """function stableDirectionAnchor<T extends MapDirection>(members:readonly T[],preferred:ReadonlySet<string>){
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
""",
    "stable group signature",
)
replace_once(
    layout,
    """    const average = members.reduce((sum, item) => {
      const p = points.get(item.id)!;
      return {x: sum.x + p.x / members.length, y: sum.y + p.y / members.length};
    }, {x: 0, y: 0});
    // Keep the symbol on a real member centre. A deterministic medoid avoids
    // suggesting a new destination between the actual catalogue directions.
    const anchor = members.reduce((best, item) => {
      const a = points.get(best.id)!, b = points.get(item.id)!;
      return Math.hypot(b.x - average.x, b.y - average.y) < Math.hypot(a.x - average.x, a.y - average.y) ? item : best;
    });
""",
    """    // Preserve a surviving anchor across adjacent zoom frames. When a group
    // is new, use a geographic medoid independent of projection and pitch.
    const anchor = stableDirectionAnchor(members,preferredAnchorIds);
""",
    "stable group anchor",
)
replace_once(
    layout,
    "count: !cluster && overview ? String(routeCount) : '',",
    "count: cluster ? String(group.members.length) : overview ? String(routeCount) : '',",
    "cluster fallback count",
)
replace_once(
    layout,
    """    button.hidden = !group;
    if (!group) continue;
""",
    """    button.hidden = !group;
    if (!group) {
      button.removeAttribute('data-map-anchor-region-id');
      button.removeAttribute('data-map-group-key');
      continue;
    }
    button.setAttribute('data-map-anchor-region-id',group.anchor.id);
    button.setAttribute('data-map-group-key',group.key);
""",
    "semantic anchor attributes",
)

# ---------------------------------------------------------------------------
# WebGL map: recalculate grouping, anchor correction and labels on every camera
# frame. Disable symbol/raster cross-fade that can show two placements at once.
# ---------------------------------------------------------------------------
atlas = "web/components/Atlas.tsx"
replace_once(
    atlas,
    "import {groupMapDirections,updateDirectionButtons,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';",
    "import {groupMapDirections,updateDirectionButtons,reconcileDirectionAnchors,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';",
    "WebGL layout import",
)
replace_once(atlas,"'raster-fade-duration':180","'raster-fade-duration':0","overview raster fade")
replace_once(
    atlas,
    "dragRotate:true,touchPitch:true,pitchWithRotate:true,maxPitch:75,fadeDuration:80,pixelRatio:Math.min(devicePixelRatio,2),maxTileCacheZoomLevels:6,",
    "dragRotate:true,touchPitch:true,pitchWithRotate:true,maxPitch:75,fadeDuration:0,crossSourceCollisions:true,pixelRatio:Math.min(devicePixelRatio,2),maxTileCacheZoomLevels:6,",
    "MapLibre symbol fade",
)
replace_once(
    atlas,
    "let cancelled=false,geographyPainted=false,overviewFallback=false,labelClampFrame=0,tileStatus:ReturnType<typeof setTimeout>|undefined,resize:ResizeObserver|undefined,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined;",
    "let cancelled=false,geographyPainted=false,overviewFallback=false,directionLayoutFrame=0,tileStatus:ReturnType<typeof setTimeout>|undefined,resize:ResizeObserver|undefined,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined;",
    "WebGL layout frame variable",
)
old_webgl = """    const directionButtons=new Map<string,HTMLButtonElement>();
    for(const r of regions){
     if(!inRussiaCoverage(...r.center,coverage.area))continue;
     const el=document.createElement('button');el.type='button';el.className='region-marker region-marker-'+r.id;el.dataset.regionId=r.id;el.setAttribute('aria-label',`Открыть ${r.name}`);directionButtons.set(r.id,el);
     const dot=document.createElement('span');dot.className='region-marker-dot';const label=document.createElement('span');label.className='region-marker-label';label.textContent=r.name;el.appendChild(dot);el.appendChild(label);
     el.addEventListener('click',e=>{
      e.stopPropagation();const group=directionGroups.current.get(r.id);
      if(group&&group.members.length>1&&container.current){
       frameRefit.current?.cancel();fullView.current=false;map.setTerrain(null);setTerrain(false);
       fitTerritory(map,{...group.anchor,bounds:group.bounds},container.current,window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:600,framedCamera);
      }else onRegionRef.current(r);
     });markers.current.push(new ml.Marker({element:el,anchor:'center'}).setLngLat([russiaLongitude(r.center[0]),r.center[1]]).addTo(map));
    }
    const scheduleLabelClamp=()=>{
     if(cancelled||labelClampFrame)return;
     labelClampFrame=requestAnimationFrame(()=>{
      labelClampFrame=0;
      if(!cancelled&&map===mapRef.current&&container.current)constrainDirectionLabels(directionButtons,container.current);
     });
    };
    unbindLabels=bindMapLabelReflow(container.current,scheduleLabelClamp);
    updateDirections.current=()=>{
     if(cancelled||map!==mapRef.current)return;
     const groups=groupMapDirections(regions.filter(item=>directionButtons.has(item.id)),center=>map.project([russiaLongitude(center[0]),center[1]]));
     directionGroups.current=updateDirectionButtons(directionButtons,groups,mapDirectionCounts(visibleTrailsRef.current),!regionRef.current,regionRef.current?.id);
     scheduleLabelClamp();
    };
    updateDirections.current();
    map.on('move',scheduleLabelClamp);
"""
new_webgl = """    const directionButtons=new Map<string,HTMLButtonElement>(),directionMarkers=new Map<string,Marker>();
    for(const r of regions){
     if(!inRussiaCoverage(...r.center,coverage.area))continue;
     const el=document.createElement('button');el.type='button';el.className='region-marker region-marker-'+r.id;el.dataset.regionId=r.id;el.setAttribute('aria-label',`Открыть ${r.name}`);directionButtons.set(r.id,el);
     const dot=document.createElement('span');dot.className='region-marker-dot';const label=document.createElement('span');label.className='region-marker-label';label.textContent=r.name;el.appendChild(dot);el.appendChild(label);
     el.addEventListener('click',e=>{
      e.stopPropagation();const group=directionGroups.current.get(r.id);
      if(group&&group.members.length>1&&container.current){
       frameRefit.current?.cancel();fullView.current=false;map.setTerrain(null);setTerrain(false);
       fitTerritory(map,{...group.anchor,bounds:group.bounds},container.current,window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:600,framedCamera);
      }else onRegionRef.current(r);
     });
     const marker=new ml.Marker({element:el,anchor:'center'}).setLngLat([russiaLongitude(r.center[0]),r.center[1]]).addTo(map);
     directionMarkers.set(r.id,marker);markers.current.push(marker);
    }
    const runDirectionLayout=()=>{
     if(cancelled||map!==mapRef.current||!container.current)return;
     const items=regions.filter(item=>directionButtons.has(item.id));
     const projected=new Map(items.map(item=>{const point=map.project([russiaLongitude(item.center[0]),item.center[1]]);return[item.id,{x:point.x,y:point.y}] as const;}));
     for(const item of items){
      const marker=directionMarkers.get(item.id),lng=russiaLongitude(item.center[0]);if(!marker)continue;
      const current=marker.getLngLat();if(Math.abs(current.lng-lng)>1e-9||Math.abs(current.lat-item.center[1])>1e-9)marker.setLngLat([lng,item.center[1]]);
     }
     const groups=groupMapDirections(items,center=>map.project([russiaLongitude(center[0]),center[1]]),new Set(directionGroups.current.keys()));
     directionGroups.current=updateDirectionButtons(directionButtons,groups,mapDirectionCounts(visibleTrailsRef.current),!regionRef.current,regionRef.current?.id);
     reconcileDirectionAnchors(directionButtons,projected,container.current);
     constrainDirectionLabels(directionButtons,container.current);
    };
    const scheduleDirectionLayout=()=>{
     if(cancelled||directionLayoutFrame)return;
     directionLayoutFrame=requestAnimationFrame(()=>{directionLayoutFrame=0;runDirectionLayout();});
    };
    updateDirections.current=runDirectionLayout;
    unbindLabels=bindMapLabelReflow(container.current,scheduleDirectionLayout);
    scheduleDirectionLayout();
    map.on('move',scheduleDirectionLayout);
"""
replace_once(atlas,old_webgl,new_webgl,"WebGL direction frame layout")
replace_once(
    atlas,
    """    map.on('zoomend',()=>{
     const zoom=map.getZoom();setMapZoom(zoom);
     if(terrainRef.current&&map.getTerrain()&&!trailRef.current){
      const pitch=terrainPitchForZoom(zoom,!!regionRef.current);
      if(Math.abs(map.getPitch()-pitch)>1.5)map.easeTo({pitch,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:180});
     }
    });
""",
    """    map.on('zoomend',()=>{
     const zoom=map.getZoom();setMapZoom(zoom);
     if(terrainRef.current&&map.getTerrain()&&!trailRef.current){
      const pitch=terrainPitchForZoom(zoom,!!regionRef.current);
      if(Math.abs(map.getPitch()-pitch)>1.5)map.easeTo({pitch,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:180});
     }
     scheduleDirectionLayout();
     requestAnimationFrame(()=>{if(!cancelled&&container.current){delete container.current.dataset.mapCamera;scheduleDirectionLayout();}});
    });
""",
    "WebGL zoom completion",
)
replace_once(atlas,"     updateDirections.current?.();\n     const c=map.getCenter();","     scheduleDirectionLayout();\n     const c=map.getCenter();","WebGL moveend layout")
replace_once(
    atlas,
    "map.on('dragstart',()=>{fullView.current=false;frameRefit.current?.cancel();});map.on('zoomstart',event=>{if(event.originalEvent){fullView.current=false;frameRefit.current?.cancel();}});",
    "map.on('dragstart',()=>{fullView.current=false;frameRefit.current?.cancel();});map.on('zoomstart',event=>{if(event.originalEvent){fullView.current=false;frameRefit.current?.cancel();}if(container.current)container.current.dataset.mapCamera='zooming';scheduleDirectionLayout();});",
    "WebGL zoom start",
)
replace_once(atlas,"     updateDirections.current?.();\n    });\n    resize=new ResizeObserver", "     scheduleDirectionLayout();\n    });\n    resize=new ResizeObserver", "WebGL style load layout")
replace_once(atlas,"     updateDirections.current?.();\n    });\n    resize.observe", "     scheduleDirectionLayout();\n    });\n    resize.observe", "WebGL resize layout")
replace_once(
    atlas,
    "return()=>{cancelled=true;cancelAnimationFrame(labelClampFrame);unbindLabels?.();",
    "return()=>{cancelled=true;cancelAnimationFrame(directionLayoutFrame);if(container.current)delete container.current.dataset.mapCamera;unbindLabels?.();",
    "WebGL layout cleanup",
)

# ---------------------------------------------------------------------------
# Leaflet/Canvas map: same per-frame grouping and DOM anchor reconciliation.
# ---------------------------------------------------------------------------
canvas = "web/components/Atlas2D.tsx"
replace_once(
    canvas,
    "import type {Map as LeafletMap,Layer,LayerGroup,GeoJSON as LeafletGeoJSON,Path as LeafletPath,PathOptions} from 'leaflet';",
    "import type {Map as LeafletMap,Marker as LeafletMarker,Layer,LayerGroup,GeoJSON as LeafletGeoJSON,Path as LeafletPath,PathOptions} from 'leaflet';",
    "Leaflet marker type",
)
replace_once(
    canvas,
    "import {DIRECTION_MARKER_SIZE,groupMapDirections,updateDirectionButtons,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';",
    "import {DIRECTION_MARKER_SIZE,groupMapDirections,updateDirectionButtons,reconcileDirectionAnchors,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';",
    "Leaflet layout import",
)
replace_once(
    canvas,
    "let cancelled=false,resize:ResizeObserver|undefined,panelChanges:MutationObserver|undefined,resizeFrame=0,paintFrame=0,labelClampFrame=0,clamping=false,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined;",
    "let cancelled=false,resize:ResizeObserver|undefined,panelChanges:MutationObserver|undefined,resizeFrame=0,paintFrame=0,directionLayoutFrame=0,clamping=false,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined;",
    "Leaflet layout frame variable",
)
replace_once(
    canvas,
    "zoomSnap:0,zoomDelta:.75,preferCanvas:true,scrollWheelZoom:true,worldCopyJump:false});",
    "zoomSnap:0,zoomDelta:.75,preferCanvas:true,scrollWheelZoom:true,worldCopyJump:false,zoomAnimation:true,markerZoomAnimation:true,fadeAnimation:false});",
    "Leaflet animation contract",
)
old_leaflet = """    for(const item of regions){
     if(!inRussiaCoverage(...item.center,coverage.area))continue;
     const button=document.createElement('button');button.type='button';button.className='region-marker region-marker-'+item.id;button.setAttribute('aria-label',`Открыть ${item.name}`);directionButtons.current.set(item.id,button);
     const dot=document.createElement('span');dot.className='region-marker-dot';const label=document.createElement('span');label.className='region-marker-label';label.textContent=item.name;button.appendChild(dot);button.appendChild(label);
     button.addEventListener('click',event=>{
      event.stopPropagation();const group=directionGroups.current.get(item.id);
      if(group&&group.members.length>1){
       frameRefit.current?.cancel();fitTerritoryBounds({...group.anchor,bounds:group.bounds},!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      }else callbacks.current.onRegion(item);
     });
     L.marker([item.center[1],russiaLongitude(item.center[0])],{icon:L.divIcon({html:button,className:'leaflet-region-marker',iconSize:[DIRECTION_MARKER_SIZE,DIRECTION_MARKER_SIZE],iconAnchor:[DIRECTION_MARKER_SIZE/2,DIRECTION_MARKER_SIZE/2]}),keyboard:false}).addTo(map);
    }
    const scheduleLabelClamp=()=>{
     if(cancelled||labelClampFrame)return;
     labelClampFrame=requestAnimationFrame(()=>{
      labelClampFrame=0;
      if(!cancelled&&map===mapRef.current&&container.current)constrainDirectionLabels(directionButtons.current,container.current);
     });
    };
    unbindLabels=bindMapLabelReflow(container.current,scheduleLabelClamp);
    updateDirections.current=()=>{
     if(cancelled||map!==mapRef.current)return;
     const groups=groupMapDirections(regions.filter(item=>directionButtons.current.has(item.id)),center=>map.latLngToContainerPoint([center[1],russiaLongitude(center[0])]));
     directionGroups.current=updateDirectionButtons(directionButtons.current,groups,mapDirectionCounts(visibleTrailsRef.current),!regionRef.current,regionRef.current?.id);
     scheduleLabelClamp();
    };
    updateDirections.current();
    map.on('move',scheduleLabelClamp);
"""
new_leaflet = """    const directionMarkers=new Map<string,LeafletMarker>();
    for(const item of regions){
     if(!inRussiaCoverage(...item.center,coverage.area))continue;
     const button=document.createElement('button');button.type='button';button.className='region-marker region-marker-'+item.id;button.setAttribute('aria-label',`Открыть ${item.name}`);directionButtons.current.set(item.id,button);
     const dot=document.createElement('span');dot.className='region-marker-dot';const label=document.createElement('span');label.className='region-marker-label';label.textContent=item.name;button.appendChild(dot);button.appendChild(label);
     button.addEventListener('click',event=>{
      event.stopPropagation();const group=directionGroups.current.get(item.id);
      if(group&&group.members.length>1){
       frameRefit.current?.cancel();fitTerritoryBounds({...group.anchor,bounds:group.bounds},!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      }else callbacks.current.onRegion(item);
     });
     const marker=L.marker([item.center[1],russiaLongitude(item.center[0])],{icon:L.divIcon({html:button,className:'leaflet-region-marker',iconSize:[DIRECTION_MARKER_SIZE,DIRECTION_MARKER_SIZE],iconAnchor:[DIRECTION_MARKER_SIZE/2,DIRECTION_MARKER_SIZE/2]}),keyboard:false}).addTo(map);
     directionMarkers.set(item.id,marker);
    }
    const runDirectionLayout=()=>{
     if(cancelled||map!==mapRef.current||!container.current)return;
     const items=regions.filter(item=>directionButtons.current.has(item.id));
     const projected=new Map(items.map(item=>{const point=map.latLngToContainerPoint([item.center[1],russiaLongitude(item.center[0])]);return[item.id,{x:point.x,y:point.y}] as const;}));
     for(const item of items){
      const marker=directionMarkers.get(item.id),lng=russiaLongitude(item.center[0]);if(!marker)continue;
      const current=marker.getLatLng();if(Math.abs(current.lng-lng)>1e-9||Math.abs(current.lat-item.center[1])>1e-9)marker.setLatLng([item.center[1],lng]);
     }
     const groups=groupMapDirections(items,center=>{const point=map.latLngToContainerPoint([center[1],russiaLongitude(center[0])]);return{x:point.x,y:point.y};},new Set(directionGroups.current.keys()));
     directionGroups.current=updateDirectionButtons(directionButtons.current,groups,mapDirectionCounts(visibleTrailsRef.current),!regionRef.current,regionRef.current?.id);
     reconcileDirectionAnchors(directionButtons.current,projected,container.current);
     constrainDirectionLabels(directionButtons.current,container.current);
    };
    const scheduleDirectionLayout=()=>{
     if(cancelled||directionLayoutFrame)return;
     directionLayoutFrame=requestAnimationFrame(()=>{directionLayoutFrame=0;runDirectionLayout();});
    };
    updateDirections.current=runDirectionLayout;
    unbindLabels=bindMapLabelReflow(container.current,scheduleDirectionLayout);
    scheduleDirectionLayout();
    map.on('move',scheduleDirectionLayout);map.on('zoom',scheduleDirectionLayout);
    map.on('zoomstart',()=>{element.dataset.mapCamera='zooming';scheduleDirectionLayout();});
    map.on('zoomend',()=>{scheduleDirectionLayout();requestAnimationFrame(()=>{if(!cancelled){delete element.dataset.mapCamera;scheduleDirectionLayout();}});});
"""
replace_once(canvas,old_leaflet,new_leaflet,"Leaflet direction frame layout")
replace_once(canvas,"map.on('moveend',()=>{clampCamera();ensureDetail();updateDirections.current?.();});","map.on('moveend',()=>{clampCamera();ensureDetail();scheduleDirectionLayout();});","Leaflet moveend layout")
replace_once(canvas,"      updateDirections.current?.();\n     });","      scheduleDirectionLayout();\n     });","Leaflet resize layout")
replace_once(
    canvas,
    "cancelAnimationFrame(resizeFrame);cancelAnimationFrame(paintFrame);cancelAnimationFrame(labelClampFrame);",
    "cancelAnimationFrame(resizeFrame);cancelAnimationFrame(paintFrame);cancelAnimationFrame(directionLayoutFrame);delete element.dataset.mapCamera;directionMarkers.clear();",
    "Leaflet layout cleanup",
)

# ---------------------------------------------------------------------------
# Final CSS: the engine's transform and the reconciliation translate are kept
# separate. During a live zoom labels disappear, while exact number badges stay
# on their region and cluster controls expose a compact numeric fallback.
# ---------------------------------------------------------------------------
css = "web/app/interface-refresh.css"
append_once(
    css,
    "/* Exact camera-frame marker anchoring. */",
    """/* Exact camera-frame marker anchoring. */
.explore-layout .region-marker,
.explore-layout .leaflet-region-marker .region-marker{
  translate:var(--map-anchor-shift-x,0px) var(--map-anchor-shift-y,0px)!important;
  transition:none!important;
  will-change:translate;
}
.explore-layout .region-marker .region-marker-dot,
.explore-layout .leaflet-region-marker .region-marker .region-marker-dot{
  position:absolute!important;
  left:50%!important;
  top:50%!important;
  transform:translate(-50%,-50%)!important;
  transform-origin:center!important;
}
.explore-layout .region-marker:hover .region-marker-dot,
.explore-layout .region-marker:focus-visible .region-marker-dot{
  transform:translate(-50%,-50%) scale(1.16)!important;
}
.explore-layout .atlas-canvas[data-map-camera='zooming'] .region-marker-label,
.explore-layout .atlas-canvas[data-map-camera='zooming'] .trail-marker-label{
  opacity:0!important;
  visibility:hidden!important;
  transition:none!important;
}
.explore-layout .atlas-canvas[data-map-camera='zooming'] .region-marker.direction-cluster .region-marker-dot{
  display:grid!important;
  place-items:center;
  min-width:28px;
  width:auto;
  height:24px;
  padding:0 5px;
  border-radius:8px;
  color:var(--surface);
  font:var(--caption-3);
  font-variant-numeric:tabular-nums;
}
""",
)

# ---------------------------------------------------------------------------
# Regression coverage.
# ---------------------------------------------------------------------------
tests = "web/tests/map-direction-layout.test.mjs"
replace_once(
    tests,
    "import {groupMapDirections,directionGroupsOverlap,directionMarkerContent,directionCountLabel,directionLabelWidth,mapLabelPlacement,mapLabelSafeRect,mapLabelShift,mapLabelAvoidObstacles,updateDirectionButtons} from '../lib/map-direction-layout.ts';",
    "import {groupMapDirections,directionGroupsOverlap,directionMarkerContent,directionCountLabel,directionLabelWidth,directionAnchorCorrection,mapLabelPlacement,mapLabelSafeRect,mapLabelShift,mapLabelAvoidObstacles,updateDirectionButtons} from '../lib/map-direction-layout.ts';",
    "direction test imports",
)
replace_once(tests,"  assert.equal(content.count,'');","  assert.equal(content.count,'5');","cluster fallback count assertion")
append_once(
    tests,
    "cluster anchors remain stable while the projection changes",
    """test('cluster anchors remain stable while the projection changes',()=>{
  const south=regions.filter(item=>southIds.includes(item.id));
  const first=groupMapDirections(south,([lng,lat])=>({x:lng*.1,y:lat*.1}));
  assert.equal(first.length,1);
  const preferred=new Set(first.map(group=>group.anchor.id));
  const second=groupMapDirections(south,([lng,lat])=>({x:lng*.15+20,y:lat*.15-10}),preferred);
  assert.equal(second.length,1);
  assert.equal(second[0].anchor.id,first[0].anchor.id);
  assert.ok(second[0].members.some(item=>item.id===second[0].anchor.id));
});

test('DOM anchor correction is idempotent across repeated camera frames',()=>{
  const viewport={left:10,top:20};
  const first=directionAnchorCorrection({left:100,right:144,top:200,bottom:244},{x:130,y:250},viewport);
  assert.deepEqual(first,{x:18,y:48});
  const moved={left:118,right:162,top:248,bottom:292};
  assert.deepEqual(directionAnchorCorrection(moved,{x:130,y:250},viewport,first),first);
});
""",
)
polish = "web/tests/map-polish.test.mjs"
replace_once(polish,"assert.match(sw,/tropnik-shell-v13/);","assert.match(sw,/tropnik-shell-v14/);","service worker generation test")
replace_once(
    polish,
    """  assert.match(css,/Only the label shifts;[\s\S]*the dot and the map engine's anchor never move/);
});""",
    """  assert.match(css,/Only the label shifts;[\s\S]*the dot and the map engine's anchor never move/);
  assert.match(css,/--map-anchor-shift-x/);
  assert.match(css,/data-map-camera='zooming'/);
  assert.match(atlas,/reconcileDirectionAnchors/);
  assert.match(canvas,/reconcileDirectionAnchors/);
  assert.match(atlas,/map\.on\('move',scheduleDirectionLayout\)/);
  assert.match(canvas,/map\.on\('move',scheduleDirectionLayout\)/);
});""",
    "anchor frame static regression",
)

# ---------------------------------------------------------------------------
# Cache generation, release metadata and documentation.
# ---------------------------------------------------------------------------
replace_once("web/public/sw.js","const VERSION='tropnik-shell-v13';","const VERSION='tropnik-shell-v14';","service worker generation")
replace_once("web/package.json",'"version": "0.4.5"','"version": "0.4.6"',"web version")
replace_once("README.md","**Веб-релиз 0.4.5 от 7 ноября 2026 года:**","**Веб-релиз 0.4.6 от 7 ноября 2026 года:**","README release heading")
replace_once(
    "README.md",
    "В 0.4.5 завершён картографический стабилизационный проход:",
    "В 0.4.6 завершён дополнительный проход по camera-frame anchor: плашки направлений сверяются с фактической проекцией движка на каждом кадре zoom и pan, а группировка сохраняет стабильный реальный регион-якорь. В 0.4.5 завершён картографический стабилизационный проход:",
    "README anchor release summary",
)
replace_once(
    "README.md",
    "Подробности: [журнал 0.4.5](docs/release-0.4.5.md),",
    "Подробности: [журнал 0.4.6](docs/release-0.4.6.md), [журнал 0.4.5](docs/release-0.4.5.md),",
    "README release links",
)
replace_once("docs/MAP-VISUAL-SYSTEM.md","Актуально для веб-релиза **0.4.5**, 7 ноября 2026 года.","Актуально для веб-релиза **0.4.6**, 7 ноября 2026 года.","visual system version")
replace_once(
    "docs/MAP-VISUAL-SYSTEM.md",
    "Маркер направления имеет фиксированный географический anchor 44×44 px в обоих движках. В Leaflet центр иконки `[22, 22]` совпадает с координатой, а cluster/label остаются абсолютно позиционированными и не участвуют в размере anchor.\n",
    "Маркер направления имеет фиксированный географический anchor 44×44 px в обоих движках. В Leaflet центр иконки `[22, 22]` совпадает с координатой, а cluster/label остаются абсолютно позиционированными и не участвуют в размере anchor. На каждом camera frame фактический центр DOM-control сверяется с `project/latLngToContainerPoint`; корректировка идемпотентна и хранится отдельно от transform движка. Группа сохраняет прежний реальный регион-якорь, пока он остаётся её участником. Во время активного zoom скрывается только текст, а компактная цифровая плашка остаётся на координате региона.\n",
    "visual system camera anchor rules",
)
release = ROOT / "docs/release-0.4.6.md"
release.write_text("""# Тропник 0.4.6 — точные якоря карты при zoom и pan

Дата выпуска: **7 ноября 2026 года**.

## Исправлено

- направление и цифровая плашка имеют один фиксированный географический control 44×44 px;
- MapLibre `project` и Leaflet `latLngToContainerPoint` сверяются с реальным центром DOM-marker на каждом animation frame;
- корректировка anchor идемпотентна и не накапливает смещение при серии wheel-zoom;
- кластер сохраняет стабильный реальный регион-якорь при изменении проекции и не перескакивает между участниками без необходимости;
- полная группировка, anchor reconciliation и safe-area раскладка выполняются во время `move/zoom`, а не только после `moveend`;
- на время активного zoom скрывается текстовая подпись, но цифровой badge остаётся на регионе; у кластера используется компактный числовой fallback;
- MapLibre symbol/raster cross-fade отключён, service worker обновлён до `tropnik-shell-v14`.

## Проверка

Релиз допускается после полного web regression suite, TypeScript `pages-preview/tsconfig.json --noEmit`, production build и успешной публичной Pages-проверки итогового merge commit. Отдельные регрессии проверяют стабильность cluster-anchor при разных проекциях и идемпотентность pixel correction.

## Границы

Цифровая плашка показывает число карточек каталога направления, а не число фактически проверенных троп. Центр направления служит навигационным якорем и не является стартовой точкой маршрута.
""")

# One-time delivery machinery never enters the release tree.
for relative in ['.github/workflows/apply-map-anchor-release-0.4.6.yml','tools/apply-map-anchor-release-0.4.6.py']:
    (ROOT/relative).unlink(missing_ok=True)

print('Tropnik 0.4.6 anchor reflow patch applied')
