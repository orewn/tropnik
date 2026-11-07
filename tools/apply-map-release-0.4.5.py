#!/usr/bin/env python3
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def replace_once(path:str,old:str,new:str,label:str)->None:
    target=ROOT/path
    text=target.read_text()
    if new in text:
        return
    count=text.count(old)
    if count!=1:
        raise RuntimeError(f'{path}: {label}: expected one anchor, found {count}')
    target.write_text(text.replace(old,new,1))

def append_once(path:str,marker:str,addition:str)->None:
    target=ROOT/path
    text=target.read_text()
    if marker in text:return
    target.write_text(text.rstrip()+'\n\n'+addition.strip()+'\n')

# WebGL atlas -----------------------------------------------------------------
atlas='web/components/Atlas.tsx'
replace_once(atlas,
"import {groupMapDirections,updateDirectionButtons,constrainDirectionLabels,type MapDirectionGroup} from '@/lib/map-direction-layout';",
"import {groupMapDirections,updateDirectionButtons,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';",'label reflow import')
replace_once(atlas,
"import {territoryForShape,type MapRegion} from '@/lib/territories';",
"import {territoryForMapPoint,type MapRegion} from '@/lib/territories';",'territory selector import')
replace_once(atlas,
"import {warmMap,supportsMapWebGL,preloadTerrain,hasTerrainPreview,loadPublicJSON,mapRequest} from '@/lib/map-preload';",
"import {warmMap,supportsMapWebGL,preloadTerrain,preloadTrail,hasTerrainPreview,loadPublicJSON,mapRequest} from '@/lib/map-preload';",'trail preload import')
replace_once(atlas,
"import {terrainExaggerationForZoom,terrainPitchForZoom} from '@/lib/map-camera-profile';",
"import {terrainExaggerationForZoom,terrainPitchForZoom} from '@/lib/map-camera-profile';\nimport {resolveTrailCenter} from '@/lib/map-coordinate';",'centre resolver import')
replace_once(atlas,
"const onRegionRef=useRef(onRegion),regionRef=useRef(region),trailRef=useRef(trail),viewportRef=useRef(onViewportRegion);",
"const onRegionRef=useRef(onRegion),onTrailRef=useRef(onTrail),regionRef=useRef(region),trailRef=useRef(trail),viewportRef=useRef(onViewportRegion);",'stable callback ref')
replace_once(atlas,
"const framedCamera=useRef<RussiaCamera|null>(null);",
"const framedCamera=useRef<RussiaCamera|null>(null),terrainRef=useRef(false);",'terrain state ref')
replace_once(atlas,
"onRegionRef.current=onRegion;regionRef.current=region;trailRef.current=trail;viewportRef.current=onViewportRegion;",
"onRegionRef.current=onRegion;onTrailRef.current=onTrail;regionRef.current=region;trailRef.current=trail;viewportRef.current=onViewportRegion;terrainRef.current=terrain;",'refresh refs')
replace_once(atlas,
"map.setMinZoom(Math.max(-2,camera.zoom));if(map.getStyle())map.setTerrain(null);map.easeTo({...camera,padding:{top:0,right:0,bottom:0,left:0},duration});\n  setTerrain(false);",
"map.setMinZoom(Math.max(-2,camera.zoom));if(map.getStyle())map.setTerrain(null);map.stop();map.easeTo({...camera,padding:{top:0,right:0,bottom:0,left:0},duration});\n  terrainRef.current=false;setTerrain(false);",'stable country fit')
replace_once(atlas,
"let cancelled=false,geographyPainted=false,overviewFallback=false,labelClampFrame=0,tileStatus:ReturnType<typeof setTimeout>|undefined,resize:ResizeObserver|undefined,unbindFrame:(()=>void)|undefined;",
"let cancelled=false,geographyPainted=false,overviewFallback=false,labelClampFrame=0,tileStatus:ReturnType<typeof setTimeout>|undefined,resize:ResizeObserver|undefined,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined;",'label cleanup handle')
replace_once(atlas,
"dragRotate:true,touchPitch:true,pitchWithRotate:true,maxPitch:75,fadeDuration:160,pixelRatio:Math.min(devicePixelRatio,2),maxTileCacheZoomLevels:4,",
"dragRotate:true,touchPitch:true,pitchWithRotate:true,maxPitch:75,fadeDuration:80,pixelRatio:Math.min(devicePixelRatio,2),maxTileCacheZoomLevels:6,",'stable tile cache')
replace_once(atlas,
"styleGeneration.current++;setBaseMode(mode);setLoaded(false);setTerrain(false);",
"styleGeneration.current++;setBaseMode(mode);setLoaded(false);terrainRef.current=false;setTerrain(false);",'style terrain reset')
replace_once(atlas,
"""    const scheduleLabelClamp=()=>{
     if(cancelled||labelClampFrame)return;
     labelClampFrame=requestAnimationFrame(()=>{
      labelClampFrame=0;
      if(!cancelled&&map===mapRef.current&&container.current)constrainDirectionLabels(directionButtons,container.current);
     });
    };
    updateDirections.current=()=>{""",
"""    const scheduleLabelClamp=()=>{
     if(cancelled||labelClampFrame)return;
     labelClampFrame=requestAnimationFrame(()=>{
      labelClampFrame=0;
      if(!cancelled&&map===mapRef.current&&container.current)constrainDirectionLabels(directionButtons,container.current);
     });
    };
    unbindLabels=bindMapLabelReflow(container.current,scheduleLabelClamp);
    updateDirections.current=()=>{""",'bind dynamic labels')
replace_once(atlas,
"""    map.on('zoomend',()=>{
     const zoom=map.getZoom();setMapZoom(zoom);
     if(map.getTerrain()){
      map.setTerrain({source:'terrain-dem',exaggeration:terrainExaggerationForZoom(zoom)});
      if(!trailRef.current)map.easeTo({pitch:terrainPitchForZoom(zoom,!!regionRef.current),duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:300});
     }
    });""",
"""    map.on('zoomend',()=>{
     const zoom=map.getZoom();setMapZoom(zoom);
     if(terrainRef.current&&map.getTerrain()&&!trailRef.current){
      const pitch=terrainPitchForZoom(zoom,!!regionRef.current);
      if(Math.abs(map.getPitch()-pitch)>1.5)map.easeTo({pitch,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:180});
     }
    });""",'do not rebuild terrain on zoom')
replace_once(atlas,
"""    map.on('click','region-fill',event=>{
     if(map.getZoom()>7||!inRussiaCoverage(event.lngLat.lng,event.lngLat.lat,coverage.area))return;
     const name=event.features?.[0]?.properties?.shapeName;const territory=typeof name==='string'?territoryForShape(name):undefined;
     if(territory)onRegionRef.current(territory);
    });""",
"""    map.on('click','region-fill',event=>{
     if(map.getZoom()>7||!inRussiaCoverage(event.lngLat.lng,event.lngLat.lat,coverage.area))return;
     const point=event.point,nearby=map.queryRenderedFeatures([[point.x-4,point.y-4],[point.x+4,point.y+4]],{layers:['region-fill']});
     const names=[...new Set([...(event.features??[]),...nearby].map(feature=>feature.properties?.shapeName).filter((name):name is string=>typeof name==='string'))];
     const territory=territoryForMapPoint(names,[russiaLongitude(event.lngLat.lng),event.lngLat.lat]);
     if(territory){map.stop();frameRefit.current?.cancel();onRegionRef.current(territory);}
    });""",'deterministic rendered territory')
replace_once(atlas,
"return()=>{cancelled=true;cancelAnimationFrame(labelClampFrame);updateDirections.current=null;",
"return()=>{cancelled=true;cancelAnimationFrame(labelClampFrame);unbindLabels?.();updateDirections.current=null;",'dispose label observers')
old_region=""" useEffect(()=>{
  const map=mapRef.current;if(!map||!loaded)return;
  frameRefit.current?.select(region?.bounds?region.id:undefined);
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(region){
   if(region.bounds&&container.current){
    if(frameRefit.current?.active()){fullView.current=false;map.setTerrain(null);setTerrain(false);fitTerritory(map,region,container.current,reduced?0:900,framedCamera);}
   }else{
    fullView.current=false;framedCamera.current=null;
    const regionPitch=terrainPitchForZoom(region.zoom,true);
    if(map.getSource('terrain-dem'))map.setTerrain({source:'terrain-dem',exaggeration:terrainExaggerationForZoom(region.zoom)});
    map.flyTo({center:region.center,zoom:region.zoom,pitch:region.id==='karelia'?Math.min(regionPitch,26):regionPitch,offset:window.innerWidth<=700?[0,-Math.round(container.current!.clientHeight*.23)]:[0,0],duration:reduced?0:1100,essential:false});
    setTerrain(!!map.getSource('terrain-dem'));
   }
  }else fitRussia(0);
  highlightRegion(map,region);
 },[region?.id,loaded,styleRevision]);"""
new_region=""" useEffect(()=>{
  const map=mapRef.current;if(!map||!loaded)return;
  frameRefit.current?.select(region?.bounds?region.id:undefined);
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const terrainActive=terrainRef.current&&!!map.getSource('terrain-dem');
  if(region){
   if(region.bounds&&container.current){
    if(frameRefit.current?.active()){fullView.current=false;map.stop();fitTerritory(map,region,container.current,reduced?0:450,framedCamera);}
   }else{
    fullView.current=false;framedCamera.current=null;map.stop();
    if(terrainActive&&!map.getTerrain())map.setTerrain({source:'terrain-dem',exaggeration:terrainExaggerationForZoom(region.zoom)});
    if(!terrainActive&&map.getTerrain())map.setTerrain(null);
    const regionPitch=terrainPitchForZoom(region.zoom,true);
    map.flyTo({center:region.center,zoom:region.zoom,pitch:terrainActive?(region.id==='karelia'?Math.min(regionPitch,26):regionPitch):0,bearing:terrainActive?-8:0,offset:window.innerWidth<=700?[0,-Math.round(container.current!.clientHeight*.23)]:[0,0],duration:reduced?0:650,essential:false});
   }
  }else fitRussia(0);
  highlightRegion(map,region);
 },[region?.id,loaded,styleRevision]);"""
replace_once(atlas,old_region,new_region,'region camera without implicit terrain')
replace_once(atlas,
"return loadMapSelection({clear,",
"return loadMapSelection({clear,clearBeforeLoad:!trail?.id,",'preserve previous trail while loading')
replace_once(atlas,
"""     const routeZoom=11;fullView.current=false;if(map.getSource('terrain-dem')){map.setTerrain({source:'terrain-dem',exaggeration:terrainExaggerationForZoom(routeZoom)});setTerrain(true);}
     const padding=container.current?russiaView(container.current).padding:80;
     map.fitBounds([[covered[0],covered[1]],[covered[2],covered[3]]],{padding,maxZoom:14,pitch:terrainPitchForZoom(routeZoom,true),bearing:-18,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:900});""",
"""     const routeZoom=11;fullView.current=false;const terrainActive=terrainRef.current&&!!map.getTerrain();
     const padding=container.current?russiaView(container.current).padding:80;
     map.stop();map.fitBounds([[covered[0],covered[1]],[covered[2],covered[3]]],{padding,maxZoom:14,pitch:terrainActive?terrainPitchForZoom(routeZoom,true):0,bearing:terrainActive?-12:0,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:450});""",'responsive route fit')
old_markers=""" useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!loaded||!coverage||!region)return;
  let removed=false;const routeMarkers:Marker[]=[];
  import('maplibre-gl').then(ml=>{
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
  return()=>{removed=true;routeMarkers.forEach(marker=>marker.remove());};
 },[visibleTrails,region?.id,loaded,onTrail]);"""
new_markers=""" useEffect(()=>{
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
 },[trail?.id,loaded]);"""
replace_once(atlas,old_markers,new_markers,'stable normalized route markers')
old_terrain=""" function setTerrainMode(next:boolean){
  const map=mapRef.current;if(!map||!loaded||(next&&(baseMode==='overview'||offline)))return;
  frameRefit.current?.cancel();
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(next){
   if(!map.getSource('terrain-dem'))map.addSource('terrain-dem',{type:'raster-dem',url:'https://tiles.mapterhorn.com/tilejson.json'});
   const zoom=map.getZoom();
   map.setTerrain({source:'terrain-dem',exaggeration:terrainExaggerationForZoom(zoom)});
   map.easeTo({pitch:terrainPitchForZoom(zoom,!!regionRef.current||!!trailRef.current),duration:reduced?0:650});
  }
  else{map.setTerrain(null);map.easeTo({pitch:0,bearing:0,duration:reduced?0:500});}setTerrain(next);
 }"""
new_terrain=""" function setTerrainMode(next:boolean){
  const map=mapRef.current;if(!map||!loaded||(next&&(baseMode==='overview'||offline)))return;
  frameRefit.current?.cancel();terrainRef.current=next;map.stop();
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(next){
   if(!map.getSource('terrain-dem'))map.addSource('terrain-dem',{type:'raster-dem',url:'https://tiles.mapterhorn.com/tilejson.json'});
   const zoom=map.getZoom();
   map.setTerrain({source:'terrain-dem',exaggeration:terrainExaggerationForZoom(zoom)});
   map.easeTo({pitch:terrainPitchForZoom(zoom,!!regionRef.current||!!trailRef.current),duration:reduced?0:420});
  }
  else{map.setTerrain(null);map.easeTo({pitch:0,bearing:0,duration:reduced?0:300});}setTerrain(next);
 }"""
replace_once(atlas,old_terrain,new_terrain,'explicit terrain mode only')

# Canvas/Leaflet atlas ----------------------------------------------------------
canvas='web/components/Atlas2D.tsx'
replace_once(canvas,
"import {hasTerrainPreview,preloadTerrain,loadPublicJSON} from '@/lib/map-preload';",
"import {hasTerrainPreview,preloadTerrain,preloadTrail,loadPublicJSON} from '@/lib/map-preload';",'canvas trail preload')
replace_once(canvas,
"import {groupMapDirections,updateDirectionButtons,constrainDirectionLabels,type MapDirectionGroup} from '@/lib/map-direction-layout';",
"import {groupMapDirections,updateDirectionButtons,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';",'canvas label reflow')
replace_once(canvas,
"import {territoryForShape,type MapRegion} from '@/lib/territories';",
"import {territoryForMapPoint,type MapRegion} from '@/lib/territories';",'canvas territory selector')
replace_once(canvas,
"import {constrainFramedCamera,MapFrameRefit,bindMapFrameRefit} from '@/lib/map-framing';",
"import {constrainFramedCamera,MapFrameRefit,bindMapFrameRefit} from '@/lib/map-framing';\nimport {resolveTrailCenter} from '@/lib/map-coordinate';",'canvas centre resolver')
replace_once(canvas,
"const DETAIL_MIN_ZOOM=4;",
"const DETAIL_ENTER_ZOOM=4.6,DETAIL_EXIT_ZOOM=3.8;",'detail hysteresis constants')
replace_once(canvas,
"const map=mapRef.current;if(!map||!navigator.onLine||!wantsDetail.current||map.getZoom()<DETAIL_MIN_ZOOM)return false;",
"const map=mapRef.current;if(!map||!navigator.onLine||!wantsDetail.current||map.getZoom()<DETAIL_ENTER_ZOOM)return false;",'detail enter threshold')
replace_once(canvas,
"const current=()=>map===mapRef.current&&request===detailRequest.current&&navigator.onLine&&wantsDetail.current&&map.getZoom()>=DETAIL_MIN_ZOOM;",
"const current=()=>map===mapRef.current&&request===detailRequest.current&&navigator.onLine&&wantsDetail.current&&map.getZoom()>=DETAIL_EXIT_ZOOM;",'detail request hysteresis')
replace_once(canvas,
"""  if(map.getZoom()<DETAIL_MIN_ZOOM){
   if(baseRef.current||detailLoading.current){""",
"""  const zoom=map.getZoom();
  if(zoom<DETAIL_EXIT_ZOOM){
   if(baseRef.current||detailLoading.current){""",'detail exit threshold')
replace_once(canvas,
"""   return;
  }
  if(!navigator.onLine||!wantsDetail.current||baseRef.current||detailLoading.current)return;""",
"""   return;
  }
  if(zoom<DETAIL_ENTER_ZOOM||!navigator.onLine||!wantsDetail.current||baseRef.current||detailLoading.current)return;""",'detail enter guard')
replace_once(canvas,
"let cancelled=false,resize:ResizeObserver|undefined,panelChanges:MutationObserver|undefined,resizeFrame=0,paintFrame=0,labelClampFrame=0,clamping=false,unbindFrame:(()=>void)|undefined;",
"let cancelled=false,resize:ResizeObserver|undefined,panelChanges:MutationObserver|undefined,resizeFrame=0,paintFrame=0,labelClampFrame=0,clamping=false,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined;",'canvas label cleanup')
replace_once(canvas,
"L.tileLayer('/maps/russia-relief/{z}/{x}/{y}.png',{pane:'russia-overview-relief',minZoom:0,maxNativeZoom:4,maxZoom:6,tileSize:256,keepBuffer:1,updateWhenIdle:true}).addTo(map);",
"L.tileLayer('/maps/russia-relief/{z}/{x}/{y}.png',{pane:'russia-overview-relief',minZoom:0,maxNativeZoom:4,maxZoom:6,tileSize:256,keepBuffer:2,updateWhenIdle:true,updateWhenZooming:false}).addTo(map);",'canvas overview tile stability')
replace_once(canvas,
"const territory=territoryForShape(feature.properties?.shapeName);if(territory)callbacks.current.onRegion(territory);",
"const shape=feature.properties?.shapeName;const territory=typeof shape==='string'?territoryForMapPoint([shape],[russiaLongitude(event.latlng.lng),event.latlng.lat]):undefined;if(territory){map.stop();frameRefit.current?.cancel();callbacks.current.onRegion(territory);}", 'canvas deterministic territory')
replace_once(canvas,
"""    const scheduleLabelClamp=()=>{
     if(cancelled||labelClampFrame)return;
     labelClampFrame=requestAnimationFrame(()=>{
      labelClampFrame=0;
      if(!cancelled&&map===mapRef.current&&container.current)constrainDirectionLabels(directionButtons.current,container.current);
     });
    };
    updateDirections.current=()=>{""",
"""    const scheduleLabelClamp=()=>{
     if(cancelled||labelClampFrame)return;
     labelClampFrame=requestAnimationFrame(()=>{
      labelClampFrame=0;
      if(!cancelled&&map===mapRef.current&&container.current)constrainDirectionLabels(directionButtons.current,container.current);
     });
    };
    unbindLabels=bindMapLabelReflow(container.current,scheduleLabelClamp);
    updateDirections.current=()=>{""",'canvas bind labels')
replace_once(canvas,
"return()=>{cancelled=true;updateDirections.current=null;",
"return()=>{cancelled=true;unbindLabels?.();updateDirections.current=null;",'canvas dispose labels')
old_canvas_markers="""   for(const item of visibleTrails){
    if(!item.center||!inRussiaCoverage(...item.center,coverage.area))continue;
    const button=document.createElement('button');button.type='button';button.className='trail-marker';button.setAttribute('aria-label',`Открыть маршрут ${item.title}`);
    const label=document.createElement('span');label.className='trail-marker-label';label.setAttribute('aria-hidden','true');label.textContent=item.title;button.appendChild(label);
    button.addEventListener('click',event=>{event.stopPropagation();callbacks.current.onTrail?.(item);});
    const marker=L.marker([item.center[1],russiaLongitude(item.center[0])],{icon:L.divIcon({html:button,className:'leaflet-route-marker',iconSize:[32,32],iconAnchor:[16,16]}),keyboard:false});
    points.current?.addLayer(marker);
   }"""
new_canvas_markers="""   for(const item of visibleTrails){
    if(!item.center)continue;
    const center=resolveTrailCenter(item.center,(lng,lat)=>inRussiaCoverage(lng,lat,coverage.area),regionRef.current);
    if(!center)continue;
    const button=document.createElement('button');button.type='button';button.className='trail-marker';button.dataset.trailId=item.id;button.classList.toggle('is-selected',trailRef.current?.id===item.id);button.setAttribute('aria-label',`Открыть маршрут ${item.title}`);
    const label=document.createElement('span');label.className='trail-marker-label';label.setAttribute('aria-hidden','true');label.textContent=item.title;button.appendChild(label);
    const warm=()=>{void preloadTrail(item);};button.addEventListener('pointerenter',warm,{once:true});button.addEventListener('focus',warm,{once:true});
    button.addEventListener('click',event=>{event.stopPropagation();map.stop();requestAnimationFrame(()=>callbacks.current.onTrail?.(item));});
    const marker=L.marker([center[1],russiaLongitude(center[0])],{icon:L.divIcon({html:button,className:'leaflet-route-marker',iconSize:[32,32],iconAnchor:[16,16]}),keyboard:false});
    points.current?.addLayer(marker);
   }"""
replace_once(canvas,old_canvas_markers,new_canvas_markers,'canvas normalized markers')
replace_once(canvas,
"""  return()=>{stale=true;};
 },[visibleTrails,region?.id,loaded]);
 useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage||!loaded)return;""",
"""  return()=>{stale=true;};
 },[visibleTrails,region?.id,loaded]);
 useEffect(()=>{
  for(const button of container.current?.querySelectorAll<HTMLButtonElement>('.trail-marker')??[])button.classList.toggle('is-selected',button.dataset.trailId===trail?.id);
 },[trail?.id,loaded]);
 useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage||!loaded)return;""",'canvas selected marker state')
replace_once(canvas,
"return loadMapSelection({clear,",
"return loadMapSelection({clear,clearBeforeLoad:!trail?.id,",'canvas preserve old route')
replace_once(canvas,
"map.fitBounds(bounds,{paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom:14,animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches});",
"map.stop();map.fitBounds(bounds,{paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom:14,animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches,duration:.45,easeLinearity:.25});",'canvas responsive route fit')

# Style generator --------------------------------------------------------------
style='web/scripts/create-map-style.mjs'
replace_once(style,
"const name=['coalesce',['get','name:ru'],['get','name:latin'],['get','name'],''];",
"const name=['coalesce',['get','name:ru'],['get','name'],['get','name:latin'],''];",'label language order')
replace_once(style,
"layout:{'text-field':name,'text-font':font,'text-size':size,'text-max-width':10,'text-padding':7,'text-variable-anchor':['top','bottom','left','right'],'text-justify':'auto','text-radial-offset':.45}",
"layout:{'text-field':name,'text-font':font,'text-size':size,'text-max-width':9,'text-padding':10,'text-variable-anchor':['top','bottom','left','right'],'text-justify':'auto','text-radial-offset':.55,'symbol-avoid-edges':true,'text-allow-overlap':false,'text-ignore-placement':false}",'collision-safe map labels')
replace_once(style,"'raster-fade-duration':180","'raster-fade-duration':0",'overview raster crossfade')
replace_once(style,"'hillshade-illumination-anchor':'viewport'","'hillshade-illumination-anchor':'map'",'stable hillshade light')
replace_once(style,
"layout:{'text-field':name,'text-font':font,'text-size':12,'text-offset':[0,1.4],'text-anchor':'top','text-max-width':11}",
"layout:{'text-field':name,'text-font':font,'text-size':12,'text-offset':[0,1.4],'text-anchor':'top','text-max-width':10,'text-padding':10,'symbol-avoid-edges':true}",'POI label edges')
replace_once(style,
"layout:{'symbol-placement':'line','text-field':name,'text-font':font,'text-size':11,'text-padding':20}",
"layout:{'symbol-placement':'line','text-field':name,'text-font':font,'text-size':11,'text-padding':24,'symbol-avoid-edges':true}",'path label edges')

# Tests ------------------------------------------------------------------------
relief_test='web/tests/canvas-relief.test.mjs'
replace_once(relief_test,
"""test('switching to a detailed base redraws and submits transparent shading mode',async()=>{
  const env=fixture();env.add();await tick();env.resolvePending();await tick();
  assert.equal(env.workers[0].messages[0].overview,true);env.workers[0].reply();await tick();
  env.relief.setOverview(false);assert.equal(env.relief.layer.redraws,1);
  env.add();await tick();env.resolvePending();await tick();assert.equal(env.workers[0].messages[1].overview,false);
  env.relief.destroy();assert.equal(env.timers.size,0);
});""",
"""test('switching base mode keeps decoded relief visible and applies the new shading to future tiles',async()=>{
  const env=fixture();env.add();await tick();env.resolvePending();await tick();
  assert.equal(env.workers[0].messages[0].overview,true);env.workers[0].reply();await tick();
  env.relief.setOverview(false);assert.equal(env.relief.layer.redraws,0);
  env.add();await tick();env.resolvePending();await tick();assert.equal(env.workers[0].messages[1].overview,false);
  env.relief.destroy();assert.equal(env.timers.size,0);
});""",'relief no-redraw regression')
polish='web/tests/map-polish.test.mjs'
replace_once(polish,"assert.match(sw,/tropnik-shell-v12/);","assert.match(sw,/tropnik-shell-v13/);",'service worker generation')
append_once(polish,"map stability release keeps terrain explicit and text collision-aware",r'''
test('map stability release keeps terrain explicit and text collision-aware',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const generator=read('scripts/create-map-style.mjs');
  const style=JSON.parse(read('public/maps/tropa-style.json'));
  const layout=read('app/layout.tsx');
  assert.match(layout,/interface-refresh\.css/);
  assert.match(atlas,/terrainRef\.current/);
  assert.match(atlas,/territoryForMapPoint/);
  assert.match(atlas,/resolveTrailCenter/);
  assert.doesNotMatch(atlas,/map\.on\('zoomend'[\s\S]{0,300}map\.setTerrain/);
  assert.match(canvas,/DETAIL_ENTER_ZOOM=4\.6,DETAIL_EXIT_ZOOM=3\.8/);
  assert.match(canvas,/bindMapLabelReflow/);
  assert.match(generator,/symbol-avoid-edges/);
  assert.match(generator,/hillshade-illumination-anchor':'map'/);
  assert.equal(style.layers.find(layer=>layer.id==='overview-relief').paint['raster-fade-duration'],0);
  for(const layer of style.layers.filter(layer=>layer.type==='symbol'&&layer.layout?.['text-field'])){
    if(layer.layout['symbol-placement']!=='line')assert.equal(layer.layout['symbol-avoid-edges'],true,layer.id);
  }
});
''')

# Documentation and version narrative -----------------------------------------
readme='README.md'
replace_once(readme,
"**Срез исходников 0.4.4 от 6 ноября 2026 года:** 306 справочных маршрутов в 15 туристических направлениях. Для 277 маршрутов сохранены исходные линии; 29 новых карточек содержат рассмотренные описания и ссылки без придуманной геометрии. Ни одна справочная запись не получает статус полевой проверки или готовой навигации.\n\nЛокальные проверки и статическая сборка выполнены. **Этот срез не заявляет новую публичную публикацию, новый собранный APK или подключённый социальный backend.** Статический Pages работает без Go/PostGIS. В кнопке загрузки пока остаётся проверенный APK **0.4.2-preview**; исходники Android подготовлены как **0.4.4-preview, versionCode 7**, их сборка и испытания требуют отдельного результата CI. Подробности: [журнал 0.4.4](docs/release-0.4.4.md), [приёмка](docs/acceptance.md), [машинный receipt локальных проверок](docs/verification/release-0.4.4-local.json).",
"**Веб-релиз 0.4.5 от 7 ноября 2026 года:** 306 справочных маршрутов в 15 туристических направлениях. Для 277 маршрутов сохранены исходные линии; 29 карточек содержат рассмотренные описания и ссылки без придуманной геометрии. Ни одна справочная запись не получает статус полевой проверки или готовой навигации.\n\nВ 0.4.5 завершён картографический стабилизационный проход: точки маршрутов нормализуются относительно выбранной территории, подписи учитывают реальные панели и края карты, область под курсором выбирается независимо от порядка отрисовки, а рельеф не пересобирается на каждом шаге zoom. Статический Pages работает без Go/PostGIS. Android остаётся отдельным проверенным preview 0.4.4; веб-изменения не приписываются старому APK. Подробности: [журнал 0.4.5](docs/release-0.4.5.md), [приёмка](docs/acceptance.md) и [визуальная система карты](docs/MAP-VISUAL-SYSTEM.md).",'README release header')
replace_once(readme,"## Что добавлено в 0.4.4","## Что исправлено в 0.4.5\n\n- **Подписи без наложений.** Четырёхсторонняя безопасная область дополнена фактическими прямоугольниками карточки историй, панели, сообщений, легенды, credits и органов управления. После загрузки шрифтов и изменения панелей выполняется повторный расчёт; при отсутствии допустимого места визуальная подпись скрывается, но доступное имя кнопки сохраняется.\n- **Стабильный рельеф.** WebGL terrain включается только явным действием пользователя и не пересоздаётся после каждого zoom. В Canvas сохранены уже декодированные тайлы, увеличен буфер и введён раздельный порог входа/выхода из детального режима.\n- **Точки и области.** Смешанный порядок координат центра маршрута исправляется по покрытию и выбранной территории. Клик по административной области оценивает все отрисованные кандидаты, а не случайный первый feature.\n- **Интерфейс.** Финальный слой `interface-refresh.css` сводит поверхности, обводки, состояния кнопок, карточек, полей и карты к одной природной палитре.\n\n## Что добавлено в 0.4.4",'README 0.4.5 section')
acceptance='docs/acceptance.md'
replace_once(acceptance,"# Приёмка Тропника 0.4.4","# Приёмка Тропника 0.4.4\n\n> Актуальный картографический веб-релиз: [0.4.5](release-0.4.5.md). Ниже сохранена подробная историческая приёмка функционального среза 0.4.4; её числа не переименовываются в результаты нового релиза.",'acceptance current release banner')
design='docs/design-system.md'
replace_once(design,"Срез исходников: **6 ноября 2026 года**.","Срез исходников: **7 ноября 2026 года**.",'design system date')
replace_once(design,
"| Бумага | `#f3f2e7` | `#f5f3e8` |\n| Поверхность | `#fffef7` | `#fffefa` |\n| Основной лесной цвет | `#234c39` | `#244d3c` |\n| Основной текст | `#172e23` | `#14271e` |\n| Вторичный текст | `#596c5d` | `#667569` |\n| Тёплый акцент | `#b47a43` | `#a56736` |",
"| Бумага | `#F5F3EB` | `#f5f3e8` |\n| Поверхность | `#FFFEFA` | `#fffefa` |\n| Мягкая поверхность | `#EEF2E8` | платформенный вариант |\n| Основной лесной цвет | `#244D3C` | `#244d3c` |\n| Основной текст | `#1D3026` | `#14271e` |\n| Вторичный текст | `#59685D` | `#667569` |\n| Тёплый акцент | `#A56736` | `#a56736` |\n| Тихая / функциональная граница | `#D5DCCE` / `#738570` | платформенный вариант |",'design palette')
append_once(design,"## 10. Обновление интерфейса 0.4.5",r'''
## 10. Обновление интерфейса 0.4.5

Финальный каскад `web/app/interface-refresh.css` загружается после `map-polish.css`. Он не вводит вторую тему: файл закрепляет семантические роли общей палитры и единые состояния для кнопок, полей, карточек, панели карты и выбранного маршрута. Обычная граница имеет толщину 1 px; усиление применяется для focus и выбранного объекта. Цвет не является единственным носителем статуса.

Подписи HTML-маркеров рассчитываются после загрузки шрифтов, движения камеры, изменения мобильного листа и размеров плавающих карточек. В расчёт входят реальные препятствия интерфейса. Встроенные подписи векторной карты используют русский атрибут, затем локальное имя и только затем латиницу, переменные якоря, увеличенный collision padding и запрет выхода символа через края тайла. Эти правила уменьшают обрезание, но не превращают сторонние подписи в источник юридических или навигационных данных.

Рельефный режим является явным состоянием пользователя. Выбор направления или тропы сам по себе не включает terrain. Уже декодированные Canvas-тайлы не очищаются при смене цветового режима; вход и выход из подробной подложки разделены гистерезисом, чтобы дробный zoom не переключал слои туда-обратно.
''')

release_doc=ROOT/'docs/release-0.4.5.md'
release_doc.write_text('''# Тропник 0.4.5 — стабильность карты и финальный интерфейс\n\nДата выпуска: **7 ноября 2026 года**.\n\n## Состав\n\n- нормализация центров маршрутов с учётом покрытия РФ и выбранной территории;\n- детерминированный выбор административной области из всех features под курсором;\n- четырёхсторонняя раскладка подписей с учётом плавающих карточек, панели, controls, сообщений, легенды и credits;\n- повторная раскладка после загрузки шрифта, изменения размеров и состояния мобильной панели;\n- русский → локальный → латинский порядок картографических названий;\n- стабильный terrain без автоматического включения при выборе маршрута и без пересборки на каждом zoom;\n- гистерезис подробного Canvas-слоя, сохранение декодированных рельефных тайлов и увеличенный tile buffer;\n- единая палитра и состояния компонентов в `interface-refresh.css`;\n- service worker `tropnik-shell-v13` с проверенной повторной упаковкой manifest обзорного рельефа.\n\n## Правила приёмки\n\nРелиз допускается в `main` только после полного набора `web/tests/*.test.mjs`, TypeScript `pages-preview/tsconfig.json --noEmit`, проверки изменённых файлов ESLint, production build и успешного Pages deploy того же commit. Отдельно проверяются обе реализации карты: MapLibre WebGL и Leaflet/Canvas fallback.\n\n## Не заявляется\n\nКарта не подтверждает доступность тропы, разрешение на посещение или фактическое состояние местности. Полный детальный офлайн-пакет РФ не заявляется. Веб-релиз 0.4.5 не переименовывает и не переподписывает существующий Android preview 0.4.4.\n''')

map_doc=ROOT/'docs/MAP-VISUAL-SYSTEM.md'
map_doc.write_text('''# Визуальная система карты Тропника\n\nАктуально для веб-релиза **0.4.5**, 7 ноября 2026 года.\n\n## Палитра\n\n| Роль | Значение |\n| --- | --- |\n| Бумажный фон | `#F5F3EB` |\n| Основная поверхность | `#FFFEFA` |\n| Мягкая поверхность | `#EEF2E8` |\n| Лесной основной | `#244D3C` |\n| Основной текст | `#1D3026` |\n| Вторичный текст | `#59685D` |\n| Тихая граница | `#D5DCCE` |\n| Функциональная граница | `#738570` |\n| Акцент маршрута | `#A56736` |\n| Усиленный акцент / focus | `#8E4F2D` |\n\nКарточки и controls используют одну границу 1 px. Более сильный контур применяется только для клавиатурного focus и выбранного объекта.\n\n## Подписи\n\nHTML-подписи направлений и маршрутов используют безопасный прямоугольник по четырём сторонам. Дополнительно алгоритм получает реальные прямоугольники панели, карточки историй, переключателя карты, controls, меню слоёв, сообщений, легенды и attribution. Подпись сначала меняет сторону относительно точки, затем получает минимальный допустимый сдвиг. Географический marker не перемещается. Если свободного места нет, визуальная подпись скрывается; `aria-label` остаётся доступным.\n\nПерерасчёт выполняется при движении карты, resize, изменении панели, появлении/скрытии overlays, focus/hover и после загрузки шрифтов. Нативные browser tooltips для маркеров запрещены.\n\nВекторные подписи выбирают `name:ru`, затем локальное `name`, затем `name:latin`. Point labels имеют переменные anchors, увеличенный collision padding и `symbol-avoid-edges`. Canvas fallback использует тот же языковой приоритет и более короткий перенос строки.\n\n## Рельеф и zoom\n\nНациональный ракурс остаётся близким к виду сверху. Terrain включается только кнопкой пользователя. Выбор направления или тропы не включает его автоматически. Exaggeration задаётся при включении, но не пересобирается на каждом `zoomend`; меняется только pitch камеры.\n\nВ Leaflet/Canvas подробная подложка включается после zoom 4.6 и сохраняется до выхода ниже 3.8. Раздельные пороги предотвращают дребезг на дробном масштабе. Уже декодированные relief tiles остаются на экране при смене обзорного/детального режима; новые tiles получают актуальный режим shading. Tile buffer равен двум экранам.\n\nОбзорный raster не использует cross-fade, а hillshade закреплён относительно карты. Это уменьшает вспышки при смене уровня детализации.\n\n## Выбор территории\n\nMapLibre запрашивает все административные features в небольшой области вокруг курсора. Кандидаты дедуплицируются, затем выбирается самая специфичная территория, содержащая координату клика; при равенстве используются площадь bounds, расстояние до центра и стабильный id. Порядок слоёв renderer больше не определяет результат. Leaflet fallback использует тот же selector.\n\n## Источники и credits\n\nOpenStreetMap/OpenMapTiles credit показывается при первом открытии и остаётся доступным через подписанную кнопку информации. Полные уведомления находятся на `/sources` и в attribution-файлах. Credits нельзя скрывать способом, нарушающим применимые лицензии.\n''')

# Temporary release scaffolding from earlier attempts must not remain in main.
for relative in [
 '.github/workflows/fix-map-points.yml','scripts/fix-map-points.py','scripts/fix-map-callback.py',
 'scripts/fix-offline-package.py','scripts/fix-overview-cache.py',
 '.github/workflows/apply-map-release-0.4.5.yml','tools/apply-map-release-0.4.5.py',
]:
    (ROOT/relative).unlink(missing_ok=True)

print('Tropnik 0.4.5 map release patch applied')
