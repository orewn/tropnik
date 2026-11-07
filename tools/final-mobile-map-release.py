#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(path: str, old: str, new: str, label: str) -> None:
    text = read(path)
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: {label}: expected one anchor, found {count}")
    write(path, text.replace(old, new, 1))


def append_once(path: str, marker: str, addition: str) -> None:
    text = read(path)
    if marker in text:
        return
    write(path, text.rstrip() + "\n\n" + addition.strip() + "\n")


# ---------------------------------------------------------------------------
# Shared native point data. HTML labels remain for editorial region markers;
# route points are rendered by the map engines themselves, so CSS can never
# detach a route dot from its geographic coordinate during zoom animation.
# ---------------------------------------------------------------------------
write("web/lib/map-trail-points.ts", r'''import type {Trail} from './content';
import type {MapRegion} from './territories';
import {resolveTrailCenter} from './map-coordinate';

export type MapTrailPoint = {
  id:string;
  title:string;
  center:[number,number];
  selected:boolean;
};

export function mapTrailPointEntries(
  trails:readonly Trail[],
  isCovered:(lng:number,lat:number)=>boolean,
  region:MapRegion|undefined,
  selectedId:string|undefined,
):MapTrailPoint[]{
  const result:MapTrailPoint[]=[];
  const seen=new Set<string>();
  for(const trail of trails){
    if(seen.has(trail.id)||!trail.center)continue;
    const center=resolveTrailCenter(trail.center,isCovered,region);
    if(!center)continue;
    seen.add(trail.id);
    result.push({id:trail.id,title:trail.title,center,selected:trail.id===selectedId});
  }
  return result;
}

export function mapTrailPointFeatureCollection(
  trails:readonly Trail[],
  isCovered:(lng:number,lat:number)=>boolean,
  region:MapRegion|undefined,
  selectedId:string|undefined,
  normalizeLongitude:(lng:number)=>number=(lng=>lng),
):GeoJSON.FeatureCollection<GeoJSON.Point,{id:string;title:string;selected:boolean}>{
  return {
    type:'FeatureCollection',
    features:mapTrailPointEntries(trails,isCovered,region,selectedId).map(item=>({
      type:'Feature',
      geometry:{type:'Point',coordinates:[normalizeLongitude(item.center[0]),item.center[1]]},
      properties:{id:item.id,title:item.title,selected:item.selected},
    })),
  };
}
''')

# ---------------------------------------------------------------------------
# Label layout: use the actual mobile visual viewport, dynamic widths and
# collision ordering. This covers browser chrome, pinch zoom, split view,
# notches, the bottom sheet and every visible overlay.
# ---------------------------------------------------------------------------
layout = "web/lib/map-direction-layout.ts"
replace_once(layout,
'''export const MAP_LABEL_SAFE_AREA = {
  wide: {edge: 18, top: 72, right: 78, bottom: 60},
  compact: {edge: 12, top: 62, right: 58, bottom: 12},
} as const;''',
'''export const MAP_LABEL_SAFE_AREA = {
  // Fixed controls are measured as obstacles. The base rectangle protects only
  // the physical viewport edges, so narrow phones do not lose usable space to
  // guessed control dimensions.
  wide: {edge: 18, top: 18, right: 18, bottom: 18},
  compact: {edge: 12, top: 12, right: 12, bottom: 12},
} as const;''',
"edge-only safe area")

replace_once(layout,
'''function viewportLabelLayout(viewport:HTMLElement){
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
}''',
'''function effectiveVisualRect(bounds:MapLabelRect):MapLabelRect{
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
}''',
"visual viewport safe area")

replace_once(layout,
'''function constrainLabel(
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
}''',
'''function constrainLabel(
  button:HTMLButtonElement,label:HTMLElement,preferred:MapLabelPlacement,
  safe:MapLabelSafeRect,obstacles:readonly MapLabelRect[],
){
  button.dataset.mapLabelPlacement=preferred;
  delete button.dataset.mapLabelHidden;
  const available=Math.max(48,safe.right-safe.left-12);
  const maximum=Math.max(48,Math.min(preferred==='top'?230:168,available));
  label.style.setProperty('--map-label-max-width',`${Math.floor(maximum)}px`);
  label.style.setProperty('--map-label-shift-x','0px');
  label.style.setProperty('--map-label-shift-y','0px');
  const marker=button.getBoundingClientRect();
  let rect=label.getBoundingClientRect();
  if(rect.width<2||rect.height<2)return{hidden:true,rect};
  const placement=mapLabelPlacement(preferred,marker,rect.bottom-rect.top,safe);
  if(placement!==preferred){button.dataset.mapLabelPlacement=placement;rect=label.getBoundingClientRect();}
  const shift=mapLabelAvoidObstacles(rect,safe,obstacles);
  const x=Math.round(shift.x),y=Math.round(shift.y);
  label.style.setProperty('--map-label-shift-x',`${x}px`);
  label.style.setProperty('--map-label-shift-y',`${y}px`);
  if(shift.hidden)button.dataset.mapLabelHidden='true';
  button.classList.toggle('map-label-shifted',x!==0||y!==0||placement!==preferred);
  return{hidden:shift.hidden,rect:translateRect(rect,x,y)};
}''',
"dynamic label width")

replace_once(layout,
'''export function constrainDirectionLabels(buttons:ReadonlyMap<string,HTMLButtonElement>,viewport:HTMLElement){
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
}''',
'''export function constrainDirectionLabels(buttons:ReadonlyMap<string,HTMLButtonElement>,viewport:HTMLElement){
  const {safe,obstacles}=viewportLabelLayout(viewport),placed:MapLabelRect[]=[];
  const ordered=[...buttons.values()].filter(button=>!button.hidden&&button.isConnected).sort((a,b)=>{
    const priority=(button:HTMLButtonElement)=>button.classList.contains('is-selected')?0:button.classList.contains('direction-cluster')?1:2;
    return priority(a)-priority(b)||(a.dataset.regionId??'').localeCompare(b.dataset.regionId??'','en');
  });
  for(const button of ordered){
    const label=button.querySelector<HTMLElement>('.region-marker-label');
    if(!label)continue;
    const result=constrainLabel(button,label,'bottom',safe,[...obstacles,...placed]);
    if(!result.hidden)placed.push(result.rect);
  }
  for(const button of viewport.querySelectorAll<HTMLButtonElement>('.trail-marker')){
    if(!button.isConnected)continue;
    const label=button.querySelector<HTMLElement>('.trail-marker-label');
    if(!label)continue;
    const active=button.classList.contains('is-selected')||button.matches(':hover,:focus-visible,:focus-within');
    if(!active){delete button.dataset.mapLabelHidden;label.style.setProperty('--map-label-shift-x','0px');label.style.setProperty('--map-label-shift-y','0px');continue;}
    const result=constrainLabel(button,label,'top',safe,[...obstacles,...placed]);
    if(!result.hidden)placed.push(result.rect);
  }
}''',
"ordered label collision pass")

replace_once(layout,
'''  const fonts=document.fonts;
  void fonts.ready.then(schedule).catch(()=>undefined);
  fonts.addEventListener('loadingdone',eventSchedule);
  schedule();
  return()=>{
    resize.disconnect();mutation.disconnect();
    root.removeEventListener('pointerover',eventSchedule,true);
    root.removeEventListener('focusin',eventSchedule,true);
    root.removeEventListener('transitionend',eventSchedule,true);
    fonts.removeEventListener('loadingdone',eventSchedule);
  };''',
'''  const fonts=document.fonts,visual=window.visualViewport;
  void fonts.ready.then(schedule).catch(()=>undefined);
  fonts.addEventListener('loadingdone',eventSchedule);
  window.addEventListener('resize',eventSchedule,{passive:true});
  window.addEventListener('orientationchange',eventSchedule,{passive:true});
  visual?.addEventListener('resize',eventSchedule,{passive:true});
  visual?.addEventListener('scroll',eventSchedule,{passive:true});
  schedule();
  return()=>{
    resize.disconnect();mutation.disconnect();
    root.removeEventListener('pointerover',eventSchedule,true);
    root.removeEventListener('focusin',eventSchedule,true);
    root.removeEventListener('transitionend',eventSchedule,true);
    fonts.removeEventListener('loadingdone',eventSchedule);
    window.removeEventListener('resize',eventSchedule);
    window.removeEventListener('orientationchange',eventSchedule);
    visual?.removeEventListener('resize',eventSchedule);
    visual?.removeEventListener('scroll',eventSchedule);
  };''',
"visual viewport reflow listeners")

# ---------------------------------------------------------------------------
# MapLibre route points: native GeoJSON/circle layers, not DOM markers.
# ---------------------------------------------------------------------------
atlas = "web/components/Atlas.tsx"
replace_once(atlas,
"import {resolveTrailCenter} from '@/lib/map-coordinate';\n",
"import {mapTrailPointFeatureCollection} from '@/lib/map-trail-points';\n",
"native route point import")
replace_once(atlas,
"const ROUTE_COVERAGE_MESSAGE='У этой линии нет точек внутри доступного покрытия России. Карточка остаётся доступной.';\n",
"const ROUTE_COVERAGE_MESSAGE='У этой линии нет точек внутри доступного покрытия России. Карточка остаётся доступной.';\nconst TRAIL_POINTS='trail-points',TRAIL_POINT_HALO='trail-point-halo',TRAIL_POINT_DOT='trail-point-dot',TRAIL_POINT_HIT='trail-point-hit';\n",
"route point ids")
replace_once(atlas,
'''function highlightRegion(map:MapInstance,region?:MapRegion){
 const filter:import('maplibre-gl').FilterSpecification=region?['in',['get','shapeName'],['literal',region.shapeNames]]:['==',['get','shapeName'],'__none'];
 for(const id of ['region-selected','region-selected-outline'])if(map.getLayer(id))map.setFilter(id,filter);
}''',
'''function highlightRegion(map:MapInstance,region?:MapRegion){
 const filter:import('maplibre-gl').FilterSpecification=region?['in',['get','shapeName'],['literal',region.shapeNames]]:['==',['get','shapeName'],'__none'];
 for(const id of ['region-selected','region-selected-outline'])if(map.getLayer(id))map.setFilter(id,filter);
}
function ensureTrailPointLayers(map:MapInstance){
 if(!map.getSource(TRAIL_POINTS))map.addSource(TRAIL_POINTS,{type:'geojson',data:EMPTY});
 if(!map.getLayer(TRAIL_POINT_HALO))map.addLayer({id:TRAIL_POINT_HALO,type:'circle',source:TRAIL_POINTS,paint:{
  'circle-radius':['case',['==',['get','selected'],true],11,9],
  'circle-color':'#FFFEFA','circle-opacity':.98,'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport',
 }});
 if(!map.getLayer(TRAIL_POINT_DOT))map.addLayer({id:TRAIL_POINT_DOT,type:'circle',source:TRAIL_POINTS,paint:{
  'circle-radius':['case',['==',['get','selected'],true],7.5,6],
  'circle-color':['case',['==',['get','selected'],true],'#244D3C','#A56736'],
  'circle-stroke-color':['case',['==',['get','selected'],true],'#A56736','#876A43'],
  'circle-stroke-width':['case',['==',['get','selected'],true],2,1],
  'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport',
 }});
 if(!map.getLayer(TRAIL_POINT_HIT))map.addLayer({id:TRAIL_POINT_HIT,type:'circle',source:TRAIL_POINTS,paint:{
  'circle-radius':18,'circle-color':'#000000','circle-opacity':.001,'circle-stroke-opacity':0,
  'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport',
 }});
}''',
"native route point layers")
replace_once(atlas,
"let cancelled=false,geographyPainted=false,overviewFallback=false,directionLayoutFrame=0,tileStatus:ReturnType<typeof setTimeout>|undefined,resize:ResizeObserver|undefined,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined;",
"let cancelled=false,geographyPainted=false,overviewFallback=false,trailPointEventsBound=false,directionLayoutFrame=0,tileStatus:ReturnType<typeof setTimeout>|undefined,resize:ResizeObserver|undefined,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined;",
"route point event state")
replace_once(atlas,
'''     highlightRegion(map,regionRef.current);
     applyMapLayerVisibility(map,layerVisibility.current);
    });''',
'''     highlightRegion(map,regionRef.current);
     applyMapLayerVisibility(map,layerVisibility.current);
     ensureTrailPointLayers(map);
     if(!trailPointEventsBound){
      trailPointEventsBound=true;
      map.on('mouseenter',TRAIL_POINT_HIT,event=>{
       map.getCanvas().style.cursor='pointer';
       const id=String(event.features?.[0]?.properties?.id??'');
       const item=visibleTrailsRef.current.find(candidate=>candidate.id===id);if(item)void preloadTrail(item);
      });
      map.on('mouseleave',TRAIL_POINT_HIT,()=>{map.getCanvas().style.cursor='';});
      map.on('click',TRAIL_POINT_HIT,event=>{
       const id=String(event.features?.[0]?.properties?.id??'');
       const item=visibleTrailsRef.current.find(candidate=>candidate.id===id);
       if(item){map.stop();frameRefit.current?.cancel();onTrailRef.current?.(item);}
      });
     }
    });''',
"bind native point events")
replace_once(atlas,
'''    map.on('click','region-fill',event=>{
     if(map.getZoom()>7||!inRussiaCoverage(event.lngLat.lng,event.lngLat.lat,coverage.area))return;
     const point=event.point,nearby=map.queryRenderedFeatures([[point.x-4,point.y-4],[point.x+4,point.y+4]],{layers:['region-fill']});
     const names=[...new Set([...(event.features??[]),...nearby].map(feature=>feature.properties?.shapeName).filter((name):name is string=>typeof name==='string'))];
     const territory=territoryForMapPoint(names,[russiaLongitude(event.lngLat.lng),event.lngLat.lat]);
     if(territory){map.stop();frameRefit.current?.cancel();onRegionRef.current(territory);}
    });''',
'''    map.on('click','region-fill',event=>{
     if(map.getZoom()>7||!inRussiaCoverage(event.lngLat.lng,event.lngLat.lat,coverage.area))return;
     const direct=[...new Set((event.features??[]).map(feature=>feature.properties?.shapeName).filter((name):name is string=>typeof name==='string'))];
     const point=event.point,nearby=direct.length?[]:map.queryRenderedFeatures([[point.x-3,point.y-3],[point.x+3,point.y+3]],{layers:['region-fill']});
     const fallback=[...new Set(nearby.map(feature=>feature.properties?.shapeName).filter((name):name is string=>typeof name==='string'))];
     const territory=territoryForMapPoint(direct.length?direct:fallback,[russiaLongitude(event.lngLat.lng),event.lngLat.lat]);
     if(territory){map.stop();frameRefit.current?.cancel();onRegionRef.current(territory);}
    });''',
"exact rendered region first")
replace_once(atlas,
''' useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!loaded||!coverage||!region)return;
  let removed=false;const routeMarkers:Marker[]=[];
  import('maplibre-gl').then(ml=>{
   if(removed)return;
   for(const t of visibleTrails){
    if(!t.center)continue;
    const center=resolveTrailCenter(t.center,(lng,lat)=>inRussiaCoverage(lng,lat,coverage.area),regionRef.current);
    if(!center)continue;
    const button=document.createElement('button');button.type='button';button.className='trail-marker';button.dataset.trailId=t.id;button.classList.toggle('is-selected',trailRef.current?.id===t.id);button.setAttribute('aria-label',`Открыть маршрут ${t.title}`);
    const label=document.createElement('span');label.className='trail-marker-label';label.setAttribute('aria-hidden','true');label.textContent=t.title;button.appendChild(label);
    const warm=()=>{void preloadTrail(t);};button.addEventListener('pointerenter',warm,{once:true});button.addEventListener('focus',warm,{once:true});
    button.addEventListener('click',event=>{event.stopPropagation();map.stop();requestAnimationFrame(()=>onTrailRef.current?.(t));});
    routeMarkers.push(new ml.Marker({element:button,anchor:'center'}).setLngLat([russiaLongitude(center[0]),center[1]]).addTo(map));
   }
   requestAnimationFrame(()=>{if(!removed)updateDirections.current?.();});
  });
  return()=>{removed=true;routeMarkers.forEach(marker=>marker.remove());};
 },[visibleTrails,region?.id,loaded]);
 useEffect(()=>{
  for(const button of container.current?.querySelectorAll<HTMLButtonElement>('.trail-marker')??[])button.classList.toggle('is-selected',button.dataset.trailId===trail?.id);
 },[trail?.id,loaded]);''',
''' useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!loaded||!coverage)return;
  const source=map.getSource(TRAIL_POINTS) as GeoJSONSource|undefined;if(!source)return;
  source.setData(mapTrailPointFeatureCollection(region?visibleTrails:[],(lng,lat)=>inRussiaCoverage(lng,lat,coverage.area),regionRef.current,trail?.id,russiaLongitude));
 },[visibleTrails,region?.id,trail?.id,loaded,styleRevision]);''',
"replace HTML route markers")

# ---------------------------------------------------------------------------
# Leaflet fallback: native vector circles in a dedicated pane. Tooltips are
# desktop-only and Leaflet auto-anchors them; mobile taps open the route panel.
# ---------------------------------------------------------------------------
canvas = "web/components/Atlas2D.tsx"
replace_once(canvas,
"import type {Map as LeafletMap,Marker as LeafletMarker,Layer,LayerGroup,GeoJSON as LeafletGeoJSON,Path as LeafletPath,PathOptions} from 'leaflet';",
"import type {Map as LeafletMap,Marker as LeafletMarker,CircleMarker as LeafletCircleMarker,Layer,LayerGroup,GeoJSON as LeafletGeoJSON,Path as LeafletPath,PathOptions} from 'leaflet';",
"Leaflet circle type")
replace_once(canvas,
"import {resolveTrailCenter} from '@/lib/map-coordinate';\n",
"import {mapTrailPointEntries} from '@/lib/map-trail-points';\n",
"Leaflet native route helper")
replace_once(canvas,
" const directionButtons=useRef(new Map<string,HTMLButtonElement>());\n",
" const directionButtons=useRef(new Map<string,HTMLButtonElement>()),routePointLayers=useRef(new Map<string,LeafletCircleMarker>());\n",
"Leaflet route point registry")
replace_once(canvas,
"    map.createPane('russia-mask');Object.assign(map.getPane('russia-mask')!.style,{zIndex:'450',pointerEvents:'none'});\n",
"    map.createPane('russia-mask');Object.assign(map.getPane('russia-mask')!.style,{zIndex:'450',pointerEvents:'none'});\n    map.createPane('trail-points');Object.assign(map.getPane('trail-points')!.style,{zIndex:'650',pointerEvents:'auto'});\n",
"Leaflet route point pane")
replace_once(canvas,
"L.tileLayer('/maps/russia-relief/{z}/{x}/{y}.png',{pane:'russia-overview-relief',minZoom:0,maxNativeZoom:4,maxZoom:6,tileSize:256,keepBuffer:2,updateWhenIdle:true,updateWhenZooming:false}).addTo(map);",
"L.tileLayer('/maps/russia-relief/{z}/{x}/{y}.png',{pane:'russia-overview-relief',minZoom:0,maxNativeZoom:4,maxZoom:6,tileSize:256,keepBuffer:4,updateWhenIdle:false,updateWhenZooming:true}).addTo(map);",
"stable overview relief zoom")
replace_once(canvas,
''' useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage||!loaded)return;
  if(!region){points.current?.clearLayers();return;}
  let stale=false;
  void import('leaflet').then(L=>{
   if(stale||map!==mapRef.current)return;points.current?.clearLayers();
   for(const item of visibleTrails){
    if(!item.center)continue;
    const center=resolveTrailCenter(item.center,(lng,lat)=>inRussiaCoverage(lng,lat,coverage.area),regionRef.current);
    if(!center)continue;
    const button=document.createElement('button');button.type='button';button.className='trail-marker';button.dataset.trailId=item.id;button.classList.toggle('is-selected',trailRef.current?.id===item.id);button.setAttribute('aria-label',`Открыть маршрут ${item.title}`);
    const label=document.createElement('span');label.className='trail-marker-label';label.setAttribute('aria-hidden','true');label.textContent=item.title;button.appendChild(label);
    const warm=()=>{void preloadTrail(item);};button.addEventListener('pointerenter',warm,{once:true});button.addEventListener('focus',warm,{once:true});
    button.addEventListener('click',event=>{event.stopPropagation();map.stop();requestAnimationFrame(()=>callbacks.current.onTrail?.(item));});
    const marker=L.marker([center[1],russiaLongitude(center[0])],{icon:L.divIcon({html:button,className:'leaflet-route-marker',iconSize:[32,32],iconAnchor:[16,16]}),keyboard:false});
    points.current?.addLayer(marker);
   }
   requestAnimationFrame(()=>{if(!stale)updateDirections.current?.();});
  });
  return()=>{stale=true;};
 },[visibleTrails,region?.id,loaded]);
 useEffect(()=>{
  for(const button of container.current?.querySelectorAll<HTMLButtonElement>('.trail-marker')??[])button.classList.toggle('is-selected',button.dataset.trailId===trail?.id);
 },[trail?.id,loaded]);''',
''' useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current,L=leafletRef.current;if(!map||!coverage||!L||!loaded)return;
  points.current?.clearLayers();routePointLayers.current.clear();
  if(!region)return;
  const finePointer=window.matchMedia('(hover:hover) and (pointer:fine)').matches;
  for(const item of mapTrailPointEntries(visibleTrails,(lng,lat)=>inRussiaCoverage(lng,lat,coverage.area),regionRef.current,trailRef.current?.id)){
   const marker=L.circleMarker([item.center[1],russiaLongitude(item.center[0])],{
    pane:'trail-points',radius:item.selected?8:6.5,color:item.selected?'#A56736':'#876A43',weight:item.selected?2:1,
    fillColor:item.selected?'#244D3C':'#A56736',fillOpacity:1,opacity:1,interactive:true,
   });
   marker.on('mouseover',()=>void preloadTrail(visibleTrailsRef.current.find(candidate=>candidate.id===item.id)!));
   marker.on('click',()=>{map.stop();frameRefit.current?.cancel();const selected=visibleTrailsRef.current.find(candidate=>candidate.id===item.id);if(selected)callbacks.current.onTrail?.(selected);});
   if(finePointer)marker.bindTooltip(item.title,{direction:'auto',offset:[0,-12],opacity:1,className:'leaflet-route-tooltip'});
   points.current?.addLayer(marker);routePointLayers.current.set(item.id,marker);
  }
 },[visibleTrails,region?.id,loaded]);
 useEffect(()=>{
  for(const [id,marker] of routePointLayers.current){
   const active=id===trail?.id;marker.setRadius(active?8:6.5);marker.setStyle({color:active?'#A56736':'#876A43',weight:active?2:1,fillColor:active?'#244D3C':'#A56736'});if(active)marker.bringToFront();
  }
 },[trail?.id,loaded]);''',
"replace Leaflet HTML route markers")
replace_once(canvas,
"directionButtons.current.clear();leafletRef.current=null;baseRef.current=null;territoryLayer.current=null;points.current=null;selected.current=null;positionMarker.current=null;coverageRef.current=null;window.removeEventListener('online',connection);",
"directionButtons.current.clear();routePointLayers.current.clear();leafletRef.current=null;baseRef.current=null;territoryLayer.current=null;points.current=null;selected.current=null;positionMarker.current=null;coverageRef.current=null;window.removeEventListener('online',connection);",
"clear native Leaflet points")

# Stop canvas relief blanking during animated fractional zoom.
replace_once("web/lib/canvas-relief.ts",
"const layer=new Relief({pane:'russia-relief',className:'tropnik-relief-tiles',tileSize:256,minZoom:5,maxNativeZoom:12,maxZoom:18,keepBuffer:2,updateWhenIdle:true,updateWhenZooming:false,opacity:1}) as Leaflet.GridLayer;",
"const layer=new Relief({pane:'russia-relief',className:'tropnik-relief-tiles',tileSize:256,minZoom:5,maxNativeZoom:12,maxZoom:18,keepBuffer:4,updateWhenIdle:false,updateWhenZooming:true,opacity:1}) as Leaflet.GridLayer;",
"continuous relief tile zoom")

# ---------------------------------------------------------------------------
# Final CSS protections. Dynamic widths come from JS and native route points no
# longer inherit button transforms. Desktop tooltips are bounded; touch devices
# use the route panel instead.
# ---------------------------------------------------------------------------
replace_once("web/app/map-polish.css","max-width:168px;","max-width:var(--map-label-max-width,168px);","dynamic region label width")
replace_once("web/app/map-polish.css","max-width:min(230px,calc(100vw - 40px));","max-width:min(var(--map-label-max-width,230px),calc(100vw - 24px));","dynamic trail label width")
replace_once("web/app/interface-refresh.css","max-width:168px!important;","max-width:var(--map-label-max-width,168px)!important;","override dynamic label width")
append_once("web/app/map-ui-release.css","/* Cross-platform label and native point finalization. */",r'''
/* Cross-platform label and native point finalization. */
.explore-layout .region-marker-label,.explore-layout .trail-marker-label{
  max-width:var(--map-label-max-width,168px)!important;
  overflow-wrap:anywhere!important;
  word-break:normal!important;
  hyphens:auto;
  contain:layout style;
  transition:opacity .1s ease,visibility .1s ease!important;
}
.explore-layout [data-map-label-hidden='true'] :is(.region-marker-label,.trail-marker-label){opacity:0!important;visibility:hidden!important}
.explore-layout .leaflet-route-tooltip{
  max-width:min(230px,calc(100vw - 32px));
  white-space:normal!important;
  overflow-wrap:anywhere;
  text-align:center;
}
.explore-layout .tropnik-relief-tiles .leaflet-tile{opacity:1!important;transition:none!important}
.explore-layout .leaflet-pane.leaflet-trail-points-pane{z-index:650}
@media(max-width:700px){
  .explore-layout .region-marker-label{max-width:var(--map-label-max-width,132px)!important;font-size:11px;line-height:1.3}
  .explore-layout .leaflet-route-tooltip{display:none!important}
}
@media(hover:none),(pointer:coarse){.explore-layout .leaflet-route-tooltip{display:none!important}}
''')

# ---------------------------------------------------------------------------
# Tests and documentation.
# ---------------------------------------------------------------------------
write("web/tests/map-trail-points.test.mjs", r'''import test from 'node:test';
import assert from 'node:assert/strict';
import {mapTrailPointEntries,mapTrailPointFeatureCollection} from '../lib/map-trail-points.ts';

const covered=(lng,lat)=>lng>=19&&lng<=191&&lat>=41&&lat<=82;
const region={id:'south',name:'Юг',center:[40,44],bounds:[32,42,46,48]};
const trails=[
 {id:'direct',title:'Прямая',center:[40.6,43.7]},
 {id:'swapped',title:'Переставленная',center:[43.8,40.7]},
 {id:'outside',title:'Вне карты',center:[1,1]},
];

test('route point entries normalize coordinates once and keep selection metadata',()=>{
 const entries=mapTrailPointEntries(trails,covered,region,'swapped');
 assert.deepEqual(entries.map(item=>item.id),['direct','swapped']);
 assert.deepEqual(entries[0].center,[40.6,43.7]);
 assert.deepEqual(entries[1].center,[40.7,43.8]);
 assert.equal(entries[1].selected,true);
});

test('MapLibre point source is geographic and independent from DOM transforms',()=>{
 const data=mapTrailPointFeatureCollection(trails,covered,region,'direct',lng=>lng<0?lng+360:lng);
 assert.equal(data.features.length,2);
 assert.deepEqual(data.features[0].geometry.coordinates,[40.6,43.7]);
 assert.deepEqual(data.features[0].properties,{id:'direct',title:'Прямая',selected:true});
});
''')

replace_once("web/tests/map-direction-layout.test.mjs",
"  assert.deepEqual(wide,{left:18,right:922,top:72,bottom:740});\n  const compact=mapLabelSafeRect({left:0,right:390,top:0,bottom:772},true,410);\n  assert.deepEqual(compact,{left:12,right:332,top:62,bottom:410});",
"  assert.deepEqual(wide,{left:18,right:982,top:18,bottom:782});\n  const compact=mapLabelSafeRect({left:0,right:390,top:0,bottom:772},true,410);\n  assert.deepEqual(compact,{left:12,right:378,top:12,bottom:410});",
"safe area test expectations")
replace_once("web/tests/map-direction-layout.test.mjs",
"  assert.deepEqual(mapLabelShift({left:900,right:1040,top:710,bottom:770},wide),{x:-118,y:-30});",
"  assert.deepEqual(mapLabelShift({left:900,right:1040,top:710,bottom:770},wide),{x:-58,y:0});",
"wide edge clamp expectation")
replace_once("web/tests/map-polish.test.mjs",
"  assert.match(atlas,/trail-marker-label/);\n  assert.match(canvas,/trail-marker-label/);",
"  assert.match(atlas,/TRAIL_POINT_HIT/);\n  assert.match(atlas,/mapTrailPointFeatureCollection/);\n  assert.match(canvas,/mapTrailPointEntries/);\n  assert.match(canvas,/L\\.circleMarker/);",
"native point assertions")
append_once("web/tests/map-polish.test.mjs","mobile visual viewport and native route points stay cross-platform",r'''

test('mobile visual viewport and native route points stay cross-platform',()=>{
  const layout=read('lib/map-direction-layout.ts');
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const css=read('app/map-ui-release.css');
  assert.match(layout,/window\.visualViewport/);
  assert.match(layout,/visual\?\.addEventListener\('resize'/);
  assert.match(layout,/--map-label-max-width/);
  assert.match(layout,/placed:MapLabelRect\[\]/);
  assert.match(atlas,/type:'circle',source:TRAIL_POINTS/);
  assert.doesNotMatch(atlas,/new ml\.Marker\(\{element:button,anchor:'center'\}\).*visibleTrails/s);
  assert.match(canvas,/pane:'trail-points'/);
  assert.match(canvas,/bindTooltip\(item\.title,\{direction:'auto'/);
  assert.match(css,/tropnik-relief-tiles \.leaflet-tile\{opacity:1!important;transition:none!important\}/);
});
''')

# Documentation and release identity.
replace_once("web/package.json",'"version": "0.4.6"','"version": "0.4.7"',"web release version")
replace_once("docs/MAP-VISUAL-SYSTEM.md","Актуально для веб-релиза **0.4.6**, 7 ноября 2026 года.","Актуально для веб-релиза **0.4.7**, 7 ноября 2026 года.","map documentation version")
append_once("docs/MAP-VISUAL-SYSTEM.md","## Мобильный visual viewport и точки маршрутов",r'''
## Мобильный visual viewport и точки маршрутов

Безопасная область подписей строится по пересечению контейнера карты с `window.visualViewport`. Поэтому браузерная панель, pinch zoom, split view, экранная клавиатура и safe-area устройства учитываются в тех же CSS-пикселях, что и `getBoundingClientRect`. Фиксированные элементы не кодируются приблизительными отступами: их реальные прямоугольники участвуют в collision pass. Ширина подписи ограничивается доступным прямоугольником динамически. Выбранные направления и кластеры получают приоритет; остальные подписи переносятся, меняют сторону или скрываются, но никогда не двигают географический marker.

Точки маршрутов не являются HTML-кнопками поверх карты. В MapLibre это GeoJSON source и три native circle layers: halo, видимая точка и прозрачная hit-area. В Leaflet fallback используются `CircleMarker` в отдельном pane. Поэтому zoom, pitch, дробный масштаб, CSS и адаптивная вёрстка не могут отделить точку от координаты. На touch-устройствах нажатие сразу открывает карточку маршрута; desktop tooltip показывается только для fine pointer и использует автоматический anchor движка.

Рельефные Leaflet tiles обновляются во время zoom с увеличенным buffer и без CSS opacity transition. Это сохраняет готовые тайлы до появления следующего уровня и убирает белое мигание между дробными масштабами.
''')

# One-time machinery never reaches main.
(ROOT / "tools/final-mobile-map-release.py").unlink(missing_ok=True)
(ROOT / ".github/workflows/final-mobile-map-release.yml").unlink(missing_ok=True)
print('final mobile map patch applied')
