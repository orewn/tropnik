'use client';
import {MapIcon} from './MapIcon';
import {MapRouteContext} from './MapRouteContext';
import {MapAttribution} from './MapAttribution';
import {TerrainScene} from './TerrainScene';
import {hasTerrainPreview,preloadTerrain,preloadTrail,loadPublicJSON} from '@/lib/map-preload';
import {loadRussiaGeometry,russiaView} from '@/lib/russia-map';
import {displayGeoJSON,inRussiaCoverage,coveredRussiaBounds,leafletRussiaMask,russiaLongitude,MAP_OUTSIDE_COLOR,type RussiaCamera} from '@/public/maps/russia-viewport.js';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {Map as LeafletMap,Marker as LeafletMarker,CircleMarker as LeafletCircleMarker,TileLayer,Layer,LayerGroup,GeoJSON as LeafletGeoJSON,Path as LeafletPath,PathOptions} from 'leaflet';
import {Check} from '@/components/TropnikIcons';
import {regions,routeCountLabel,type Region} from '@/lib/content';
import {mapDirectionCounts} from '@/lib/map-catalog';
import {DIRECTION_MARKER_SIZE,groupMapDirections,updateDirectionButtons,reconcileDirectionAnchors,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';
import {territoryForMapPoint,type MapRegion} from '@/lib/territories';
import {EMPTY_MAP_TRAILS,type AtlasProps} from '@/lib/map-types';
import {readRouteGeometry,routeGeometryPositions} from '@/lib/route-geometry';
import {MAP_CONFIG,directionExpansionZoom,viewportRegionId} from '@/lib/map-config';
import {publishMapCamera} from '@/lib/map-interaction';
import {MapZoomButtons,MAP_ZOOM_BUTTONS} from '@/lib/map-zoom-buttons';
import {canvasStyle} from '@/public/maps/canvas-style.js';
import {createCanvasRelief} from '@/lib/canvas-relief';
import {createLeafletCanvas} from '@/lib/leaflet-canvas';
import {maskViewportCulling} from '@/lib/leaflet-mask-viewport';
import {LatestMapNavigation,loadMapSelection} from '@/lib/map-lifecycle';
import {constrainFramedCamera,MapFrameRefit,bindMapFrameRefit} from '@/lib/map-framing';
import {mapTrailPointEntries,type MapTrailPoint} from '@/lib/map-trail-points';
import {ROUTE_PRESENTATION,ROUTE_EDGE_LAYOUT,overviewContextCaption,overviewModeStatus,routeStrokeWidth,territoryDetailOpacity,routeLineEdges,createRouteEdgeElement,syncRouteEdgeAnnotations,type RouteEdgeAnnotation} from '@/lib/map-route-presentation';
import {SATELLITE_TILES,SATELLITE_MAX_ZOOM,SATELLITE_ERROR} from '@/lib/map-satellite';
import 'leaflet/dist/leaflet.css';

type Coverage=Awaited<ReturnType<typeof loadRussiaGeometry>>;
type CanvasDetailLayer=Layer&{paintRules:ReturnType<typeof canvasStyle>['paintRules'];backgroundColor?:string;rerenderTiles:()=>void};
type CanvasTrailPointLayers={marker:LeafletCircleMarker;hit:LeafletCircleMarker};
export function createCanvasRussiaMask(L:typeof import('leaflet'),mask:GeoJSON.GeoJsonObject){
 // These published cells already share a simplified boundary. Leaflet's
 // per-ring simplifier can cut a shared corner and open a long visible slit.
 const renderer=createLeafletCanvas(L,{pane:'russia-mask',padding:.15}),cull=maskViewportCulling(renderer);
 const style:import('leaflet').PolylineOptions={renderer,smoothFactor:0,stroke:false,fillColor:MAP_OUTSIDE_COLOR,fillOpacity:1,fillRule:'evenodd'};
 return L.geoJSON(leafletRussiaMask(mask),{pane:'russia-mask',interactive:false,style,onEachFeature:(_feature,layer)=>{if(layer instanceof L.Polygon)cull(layer);}});
}
export function createCanvasTrailPoint(L:typeof import('leaflet'),item:MapTrailPoint,onSelect:()=>void,onHover:()=>void):CanvasTrailPointLayers{
 const center:[number,number]=[item.center[1],russiaLongitude(item.center[0])];
 // Use the same default renderer as the territories. A separate Canvas pane
 // intercepts the entire viewport, including its transparent, empty areas.
 const hit=L.circleMarker(center,{radius:MAP_CONFIG.trailHitRadiusPx,stroke:false,fill:true,fillOpacity:0,interactive:true,bubblingMouseEvents:false});
 const marker=L.circleMarker(center,{radius:item.selected?8:6.5,color:item.selected?'#A56736':'#876A43',weight:item.selected?2:1,
  fillColor:item.selected?'#244D3C':'#A56736',fillOpacity:1,opacity:1,interactive:false});
 hit.on('mouseover',onHover);hit.on('click',onSelect);
 return{marker,hit};
}
export function raiseCanvasTrailPoints(points:ReadonlyMap<string,CanvasTrailPointLayers>,selectedId?:string){
 const raise=({marker,hit}:CanvasTrailPointLayers)=>{hit.bringToFront();marker.bringToFront();};
 for(const point of points.values())raise(point);
 const selected=selectedId?points.get(selectedId):undefined;if(selected)raise(selected);
}
export function createCanvasTrailLine(L:typeof import('leaflet'),data:GeoJSON.GeoJsonObject,planning:boolean,onSelect?:()=>void,zoom=11){
 const weight=routeStrokeWidth(zoom);
 const layers:Layer[]=[
  L.geoJSON(data,{style:{color:ROUTE_PRESENTATION.paper,weight:weight+4,opacity:.96},interactive:false}),
  L.geoJSON(data,{style:feature=>({color:planning?(feature?.properties?.preview?'#8d9b8a':['#244d3c','#b16c38','#486c97','#785781'][Number(feature?.properties?.stage??0)%4]):ROUTE_PRESENTATION.ink,weight,opacity:.98,dashArray:planning&&feature?.properties?.preview?'9 4':undefined}),interactive:false}),
 ];
 if(!planning&&onSelect){
  const hit=L.geoJSON(data,{style:{weight:24,opacity:0,fill:false},interactive:true,bubblingMouseEvents:false});
  hit.on('click',onSelect);layers.push(hit);
 }
 return L.layerGroup(layers);
}

export function Atlas2D({region,trail,visibleTrails=EMPTY_MAP_TRAILS,onTrail,onRegion,onMapNote,onViewportRegion,planning=false,planPoints}:AtlasProps){
 const container=useRef<HTMLDivElement>(null),mapRef=useRef<LeafletMap|null>(null),baseRef=useRef<CanvasDetailLayer|null>(null);
 const points=useRef<LayerGroup|null>(null),selected=useRef<LayerGroup|null>(null),positionMarker=useRef<Layer|null>(null);
 const planningMarkers=useRef<LayerGroup|null>(null),routeEdges=useRef<LayerGroup|null>(null);
 const routeAnnotations=useRef<RouteEdgeAnnotation[]>([]);
 const planningRef=useRef(planning),planFrame=useRef<{bounds:number[];selection:NonNullable<AtlasProps['trail']>}|null>(null);
 const planFrameRevision=useRef(0),zooming=useRef(false),navigationRef=useRef<LatestMapNavigation|null>(null),zoomButtons=useRef<MapZoomButtons|null>(null);
 const directionButtons=useRef(new Map<string,HTMLButtonElement>()),routePointLayers=useRef(new Map<string,CanvasTrailPointLayers>());
 const directionGroups=useRef(new Map<string,MapDirectionGroup<Region>>()),updateDirections=useRef<(()=>void)|null>(null),visibleTrailsRef=useRef(visibleTrails);
 const territoryLayer=useRef<LeafletGeoJSON|null>(null),regionRef=useRef(region);
 const coverageRef=useRef<Coverage|null>(null),cameraFloor=useRef<RussiaCamera|null>(null),fullView=useRef(true),detailRequest=useRef(0);
 const framedCamera=useRef<RussiaCamera|null>(null);
 const frameRefit=useRef<MapFrameRefit|null>(null);
 const leafletRef=useRef<typeof import('leaflet')|null>(null);
 const callbacks=useRef({onRegion,onTrail,onMapNote,onViewportRegion});
 const wantsDetail=useRef(true),detailLoading=useRef(false),pathVisibility=useRef(true);
 const protomapsRef=useRef<typeof import('protomaps-leaflet')|null>(null),ensureReliefRef=useRef<(()=>void)|null>(null),trailRef=useRef(trail);
 const reliefRef=useRef<ReturnType<typeof createCanvasRelief>|null>(null);
 const locationRevision=useRef(0);
 const satelliteLayer=useRef<TileLayer|null>(null),wantsSatellite=useRef(false),satelliteActive=useRef(false);
 const [satellite,setSatellite]=useState(false),[mapZoom,setMapZoom]=useState(2);
 const [reliefReady,setReliefReady]=useState(false);
 const [scene,setScene]=useState(false),[loaded,setLoaded]=useState(false),[tilesLoading,setTilesLoading]=useState(false);
 const [status,setStatus]=useState(''),[layers,setLayers]=useState(false),[mode,setMode]=useState<'detail'|'overview'>('overview');
 const [showPaths,setShowPaths]=useState(true),[offline,setOffline]=useState(false);
 const sceneAvailable=!planning&&hasTerrainPreview(trail,region?.id);

 const cancelLocation=useCallback(()=>{
  locationRevision.current++;
  setStatus(previous=>previous==='Определяем местоположение…'?'':previous);
 },[]);
 const cancelNavigation=useCallback(()=>{cancelLocation();navigationRef.current?.cancel();zoomButtons.current?.cancel();},[cancelLocation]);
 const zoomBy=useCallback((delta:number)=>{
  cancelLocation();navigationRef.current?.cancel();frameRefit.current?.cancel();fullView.current=false;
  zoomButtons.current?.request(delta);
 },[cancelLocation]);

 const territoryStyle=useCallback((feature?:GeoJSON.Feature):PathOptions=>{
  const selected=regionRef.current?.shapeNames.includes(feature?.properties?.shapeName);
  const opacity=territoryDetailOpacity(mapRef.current?.getZoom()??2);
  return selected?{color:'#486b45',weight:opacity+1,opacity:.86*opacity,fillColor:'#91ae80',fillOpacity:.13*opacity}
   :{color:'#879d78',weight:.65,opacity:.45*opacity,fillColor:'#b6c9a2',fillOpacity:.04*opacity};
 },[]);

 const fitRussia=useCallback((animate=false)=>{
  cancelLocation();zoomButtons.current?.cancel();
  frameRefit.current?.cancel();
  navigationRef.current?.request(()=>{
  const map=mapRef.current,element=container.current;if(!map||!element)return;
  const {camera}=russiaView(element,256);cameraFloor.current=camera;framedCamera.current=null;fullView.current=true;
  map.setMinZoom(camera.zoom);map.setView([camera.center[1],camera.center[0]],camera.zoom,{animate});fullView.current=true;
  });
 },[cancelLocation]);
 const fitTerritoryBounds=useCallback((selection:MapRegion,animate:boolean,expand=false)=>{
  zoomButtons.current?.cancel();
  navigationRef.current?.request(()=>{
  const map=mapRef.current,element=container.current,L=leafletRef.current,b=selection.bounds;if(!map||!element||!L||!b)return;
  const {padding}=russiaView(element,256),bounds:[[number,number],[number,number]]=[[b[1],b[0]],[b[3],b[2]]];
  const fittedZoom=Math.min(MAP_CONFIG.territoryMaxZoom,map.getBoundsZoom(bounds,false,L.point(padding.left+padding.right,padding.top+padding.bottom)));
  const zoom=expand?directionExpansionZoom(map.getZoom(),fittedZoom):fittedZoom;
  const anchor=expand&&fittedZoom<zoom
   ?map.project([selection.center[1],russiaLongitude(selection.center[0])],zoom)
   :map.project(bounds[0],zoom).add(map.project(bounds[1],zoom)).divideBy(2);
  const center=map.unproject(anchor.add([(padding.right-padding.left)/2,(padding.bottom-padding.top)/2]),zoom);
  framedCamera.current={center:[center.lng,center.lat],zoom};fullView.current=false;
  if(expand&&fittedZoom<zoom)map.setView(center,zoom,{animate});
  else map.fitBounds(bounds,{paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom:MAP_CONFIG.territoryMaxZoom,animate});
  });
 },[]);
 const hasPlanFrame=useCallback(()=>{
  const frame=planFrame.current,current=trailRef.current;
  return !!(planningRef.current&&frame&&current&&frame.selection.id===current.id&&frame.selection.geometryUrl===current.geometryUrl&&frame.selection.geometry===current.geometry);
 },[]);
 const fitPlanFrame=useCallback(()=>{
  zoomButtons.current?.cancel();
  navigationRef.current?.request(()=>{
  const map=mapRef.current,element=container.current,L=leafletRef.current,frame=planFrame.current;
  if(!map||!element||!L||!frame||!hasPlanFrame())return;
  map.stop();map.invalidateSize({pan:false});
  const b=frame.bounds,bounds=L.latLngBounds([[b[1],b[0]],[b[3],b[2]]]),{padding}=russiaView(element,256);
  const zoom=Math.min(MAP_CONFIG.planMaxZoom,map.getBoundsZoom(bounds,false,L.point(padding.left+padding.right,padding.top+padding.bottom)));
  const center=map.unproject(map.project(bounds.getSouthWest(),zoom).add(map.project(bounds.getNorthEast(),zoom)).divideBy(2).add([(padding.right-padding.left)/2,(padding.bottom-padding.top)/2]),zoom);
  framedCamera.current={center:[center.lng,center.lat],zoom};fullView.current=false;
  map.fitBounds(bounds,{paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom:MAP_CONFIG.planMaxZoom,animate:false});
  });
 },[hasPlanFrame]);
 const requestPlanFit=useCallback(()=>{
  if(!hasPlanFrame())return false;
  fullView.current=false;
  frameRefit.current?.select(`plan:${++planFrameRevision.current}`);
  frameRefit.current?.settled();return true;
 },[hasPlanFrame]);
 const addDetail=useCallback(async ()=>{
  const map=mapRef.current;if(!map||!navigator.onLine||!wantsDetail.current||map.getZoom()<MAP_CONFIG.detailEnterZoom)return false;
  const request=++detailRequest.current;
  const current=()=>map===mapRef.current&&request===detailRequest.current&&navigator.onLine&&wantsDetail.current&&map.getZoom()>=MAP_CONFIG.detailExitZoom;
  detailLoading.current=true;
  try{
   const p=protomapsRef.current??await import('protomaps-leaflet');protomapsRef.current=p;
   if(!current())return false;
   if(baseRef.current){
    // Preserve the canvases, labels and decoded tile cache. Redrawing the whole
    // Leaflet layer removed the ready map while the replacement was still loading.
    const style=canvasStyle(p,pathVisibility.current,satelliteActive.current);
    baseRef.current.paintRules=style.paintRules;baseRef.current.backgroundColor=style.backgroundColor;
    baseRef.current.rerenderTiles();return true;
   }
   const tilejson=await loadPublicJSON<{tiles:string[]}>('https://tiles.openfreemap.org/planet/latest');
   if(!current())return false;
   if(!tilejson.tiles?.[0]?.startsWith('https://tiles.openfreemap.org/'))throw new Error('Источник карты не подтверждён.');
   const detail=p.leafletLayer({url:tilejson.tiles[0],...canvasStyle(p,pathVisibility.current,satelliteActive.current),attribution:'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',devicePixelRatio:Math.min(window.devicePixelRatio,MAP_CONFIG.maxPixelRatio)}) as unknown as CanvasDetailLayer;
   const attached=()=>map===mapRef.current&&baseRef.current===detail;
   detail.on('loading',()=>{if(attached())setTilesLoading(true);});
   detail.on('load',()=>{if(attached())setTilesLoading(false);});
   detail.on('tileerror',()=>{if(attached())setTilesLoading(false);});
   baseRef.current=detail;detail.addTo(map);reliefRef.current?.setOverview(false);return true;
  }catch(error){if(current())throw error;return false;}
  finally{if(request===detailRequest.current)detailLoading.current=false;}
 },[]);
 const ensureDetail=useCallback(()=>{
  const map=mapRef.current;
  if(!map)return;
  const zoom=map.getZoom();
  if(zoom<MAP_CONFIG.detailExitZoom){
   if(baseRef.current||detailLoading.current){
    ++detailRequest.current;detailLoading.current=false;
    if(baseRef.current)map.removeLayer(baseRef.current);baseRef.current=null;
    setTilesLoading(false);setMode('overview');reliefRef.current?.setOverview(true);
   }
   return;
  }
  if(zoom<MAP_CONFIG.detailEnterZoom||!navigator.onLine||!wantsDetail.current||baseRef.current||detailLoading.current)return;
  void addDetail().then(added=>{if(added&&map===mapRef.current&&baseRef.current&&wantsDetail.current&&navigator.onLine)setMode('detail');}).catch(()=>{if(map===mapRef.current)setStatus('Детали не загрузились. Обзор России доступен.');});
 },[addDetail]);
 const refreshGround=useCallback(()=>{
  const detail=baseRef.current,p=protomapsRef.current;if(!detail||!p)return;
  const style=canvasStyle(p,pathVisibility.current,satelliteActive.current);
  detail.paintRules=style.paintRules;detail.backgroundColor=style.backgroundColor;detail.rerenderTiles();
 },[]);
 const removeSatellite=useCallback(()=>{
  satelliteLayer.current?.remove();satelliteLayer.current=null;satelliteActive.current=false;setSatellite(false);refreshGround();
 },[refreshGround]);
 const showSatellite=useCallback(()=>{
  const map=mapRef.current,L=leafletRef.current;if(!map||!L||!navigator.onLine||satelliteLayer.current)return;
  const layer=L.tileLayer(SATELLITE_TILES,{pane:'russia-satellite',minZoom:0,maxNativeZoom:SATELLITE_MAX_ZOOM,maxZoom:18,tileSize:256,keepBuffer:1,updateWhenIdle:true,updateWhenZooming:false,crossOrigin:'anonymous'});
  satelliteLayer.current=layer;satelliteActive.current=true;setSatellite(true);
  reliefRef.current?.layer.remove();setReliefReady(false);refreshGround();
  layer.on('tileerror',()=>{
   if(map!==mapRef.current||layer!==satelliteLayer.current)return;
   removeSatellite();setTilesLoading(false);setStatus(SATELLITE_ERROR);ensureReliefRef.current?.();ensureDetail();
  });
  layer.addTo(map);ensureDetail();
 },[refreshGround,removeSatellite,ensureDetail]);
 function chooseSatellite(){
  if(!navigator.onLine)return;
  wantsSatellite.current=true;wantsDetail.current=true;setScene(false);setStatus('');showSatellite();
 }
 useLayoutEffect(()=>{
  pathVisibility.current=showPaths;trailRef.current=trail;regionRef.current=region;
  visibleTrailsRef.current=visibleTrails;planningRef.current=planning;
  callbacks.current={onRegion,onTrail,onMapNote,onViewportRegion};
 },[showPaths,trail,region,visibleTrails,planning,onRegion,onTrail,onMapNote,onViewportRegion]);
 useEffect(()=>{if(planning)onMapNote?.(status);},[planning,status,onMapNote]);
 // A new selection ends the external 3D scene lifecycle before optional warmup.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{setScene(false);if(sceneAvailable)void preloadTerrain();},[region?.id,trail?.id,sceneAvailable]);
 // Invalidate external GPS/camera work and clear its pending status for a new selection.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{cancelNavigation();},[region?.id,trail?.id,trail?.geometryUrl,trail?.geometry,cancelNavigation]);
 useEffect(()=>{
  const routePointRegistry=routePointLayers.current,buttonRegistry=directionButtons.current,edgeAnnotations=routeAnnotations.current;
  const locationEpoch=locationRevision,detailEpoch=detailRequest,mountElement=container.current;
  let cancelled=false,resize:ResizeObserver|undefined,resizeFrame=0,paintFrame=0,directionLayoutFrame=0,clamping=false,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined,unbindLocationGestures:(()=>void)|undefined;
  const navigation=new LatestMapNavigation(()=>zooming.current);navigationRef.current=navigation;
  const directionMarkers=new Map<string,LeafletMarker>();
  let leaflet:typeof import('leaflet')|undefined;
  const ensureRelief=()=>{
   const map=mapRef.current;if(cancelled||!leaflet||!map||!navigator.onLine||satelliteActive.current||!wantsDetail.current||typeof Worker==='undefined'||typeof OffscreenCanvas==='undefined')return;
   if(!reliefRef.current)reliefRef.current=createCanvasRelief(leaflet,ready=>{if(!cancelled){setReliefReady(ready);setStatus(previous=>ready?(previous==='Рельеф пока не загрузился. Доступна основная карта.'?'':previous):(previous||'Рельеф пока не загрузился. Доступна основная карта.'));}});
   reliefRef.current.setOverview(!baseRef.current);reliefRef.current.layer.addTo(map);
  };
  ensureReliefRef.current=ensureRelief;
  const connection=()=>{
   setOffline(!navigator.onLine);
   if(!navigator.onLine){++detailRequest.current;detailLoading.current=false;setTilesLoading(false);if(baseRef.current&&mapRef.current)mapRef.current.removeLayer(baseRef.current);baseRef.current=null;removeSatellite();reliefRef.current?.layer.remove();reliefRef.current?.setOverview(true);setReliefReady(false);setMode('overview');setStatus('Без сети: обзор. Скачанные подробные карты открываются в разделе «Офлайн».');}
   else{setStatus(previous=>previous==='Без сети: обзор. Скачанные подробные карты открываются в разделе «Офлайн».'?'':previous);if(wantsSatellite.current)showSatellite();ensureRelief();ensureDetail();}
  };
  // Hydrate connectivity and reset readiness while the external map mounts.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  window.addEventListener('online',connection);window.addEventListener('offline',connection);setOffline(!navigator.onLine);setLoaded(false);
  (async()=>{
   try{
    const [L,coverage,admin]=await Promise.all([import('leaflet'),loadRussiaGeometry(),loadPublicJSON<GeoJSON.GeoJsonObject>('/data/territories.geojson')]);
    if(cancelled||!container.current)return;
    leaflet=L;leafletRef.current=L;
    if(!coverage.area.features?.length||!coverage.mask.features?.length)throw new Error('Coverage geometry missing');
    (window as unknown as {L:typeof L}).L=L;coverageRef.current=coverage;
    const element=container.current,{camera}=russiaView(element,256);cameraFloor.current=camera;
    const map=L.map(element,{center:[camera.center[1],camera.center[0]],zoom:camera.zoom,zoomControl:false,attributionControl:false,minZoom:camera.zoom,maxZoom:18,zoomSnap:0,zoomDelta:MAP_ZOOM_BUTTONS.leafletStep,renderer:createLeafletCanvas(L),preferCanvas:true,scrollWheelZoom:true,worldCopyJump:false,zoomAnimation:true,markerZoomAnimation:true,fadeAnimation:false});
    mapRef.current=map;element.style.background=MAP_OUTSIDE_COLOR;
    const zoomControl=new MapZoomButtons({zoom:()=>map.getZoom(),bounds:()=>({min:map.getMinZoom(),max:map.getMaxZoom()}),busy:()=>zooming.current,
     apply:target=>map.setZoom(target,{animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches})});
    zoomButtons.current=zoomControl;
    element.addEventListener('pointerdown',cancelNavigation,{passive:true});
    element.addEventListener('wheel',cancelNavigation,{passive:true});
    const keyboardNavigation=(event:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','+','=','-','−','Home','End','PageUp','PageDown'].includes(event.key))cancelNavigation();};
    element.addEventListener('keydown',keyboardNavigation);
    unbindLocationGestures=()=>{element.removeEventListener('pointerdown',cancelNavigation);element.removeEventListener('wheel',cancelNavigation);element.removeEventListener('keydown',keyboardNavigation);};
    frameRefit.current=new MapFrameRefit({
     allowed:()=>!cancelled&&map===mapRef.current&&!!container.current&&(hasPlanFrame()||!!regionRef.current?.bounds&&!trailRef.current),
     refit:()=>{if(hasPlanFrame())fitPlanFrame();else if(regionRef.current)fitTerritoryBounds(regionRef.current,!planningRef.current&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches);},
    });
    unbindFrame=bindMapFrameRefit(element,element.closest('.explore-layout')?.querySelector('.explore-panel')??null,frameRefit.current,()=>{
     if(cancelled||map!==mapRef.current)return;
     if(fullView.current&&!regionRef.current&&!trailRef.current)fitRussia(false);
     else russiaView(element,256);
    });
    map.on('dragstart',()=>{navigation.cancel();frameRefit.current?.cancel();});
    map.createPane('russia-land');map.getPane('russia-land')!.style.zIndex='150';
    map.createPane('russia-overview-relief');Object.assign(map.getPane('russia-overview-relief')!.style,{zIndex:'160',pointerEvents:'none'});
    map.createPane('russia-satellite');Object.assign(map.getPane('russia-satellite')!.style,{zIndex:'180',pointerEvents:'none'});
    map.createPane('russia-relief');Object.assign(map.getPane('russia-relief')!.style,{zIndex:'350',pointerEvents:'none'});
    map.createPane('russia-mask');Object.assign(map.getPane('russia-mask')!.style,{zIndex:'450',pointerEvents:'none'});
    L.geoJSON(coverage.area,{pane:'russia-land',style:{renderer:createLeafletCanvas(L,{pane:'russia-land',padding:.15}),color:'#aebda2',weight:.65,fillColor:'#dbe4cd',fillOpacity:1},interactive:false}).addTo(map);
    L.tileLayer('/maps/russia-relief/{z}/{x}/{y}.png',{pane:'russia-overview-relief',minZoom:0,maxNativeZoom:4,maxZoom:6,tileSize:256,keepBuffer:4,updateWhenIdle:false,updateWhenZooming:true}).addTo(map);
    ensureRelief();
    territoryLayer.current=L.geoJSON(displayGeoJSON(admin),{style:territoryStyle,onEachFeature:(feature,layer)=>{
     layer.on('click',(event:{latlng?:{lng:number;lat:number}})=>{
      if(planning||!event.latlng||!inRussiaCoverage(event.latlng.lng,event.latlng.lat,coverage.area))return;
      const shape=feature.properties?.shapeName;const territory=typeof shape==='string'?territoryForMapPoint([shape],[russiaLongitude(event.latlng.lng),event.latlng.lat]):undefined;if(territory){map.stop();frameRefit.current?.cancel();callbacks.current.onRegion(territory);}
     });
    }}).addTo(map);
    // The non-interactive mask sits above tiles and route paths; validated marker labels stay above it. Leaflet
    // does not repeat GeoJSON, so its two adjacent world copies are covered too.
    createCanvasRussiaMask(L,coverage.mask).addTo(map);
    for(const item of planning?[]:regions){
     if(!inRussiaCoverage(...item.center,coverage.area))continue;
     const button=document.createElement('button');button.type='button';button.className='region-marker region-marker-'+item.id;button.setAttribute('aria-label',`Открыть ${item.name}`);directionButtons.current.set(item.id,button);
     const dot=document.createElement('span');dot.className='region-marker-dot';const label=document.createElement('span');label.className='region-marker-label';label.textContent=item.name;button.appendChild(dot);button.appendChild(label);
     button.addEventListener('click',event=>{
      event.stopPropagation();const group=directionGroups.current.get(item.id);
      if(group&&group.members.length>1){
       frameRefit.current?.cancel();fitTerritoryBounds({...group.anchor,bounds:group.bounds},!window.matchMedia('(prefers-reduced-motion: reduce)').matches,true);
      }else callbacks.current.onRegion(item);
     });
     const marker=L.marker([item.center[1],russiaLongitude(item.center[0])],{icon:L.divIcon({html:button,className:'leaflet-region-marker',iconSize:[DIRECTION_MARKER_SIZE,DIRECTION_MARKER_SIZE],iconAnchor:[DIRECTION_MARKER_SIZE/2,DIRECTION_MARKER_SIZE/2]}),keyboard:false}).addTo(map);
     directionMarkers.set(item.id,marker);
    }
    const runDirectionLayout=()=>{
     if(cancelled||map!==mapRef.current||!container.current)return;
     syncRouteEdgeAnnotations(routeAnnotations.current);
     const center=map.getCenter();
     publishMapCamera(container.current,{longitude:center.lng,latitude:center.lat,zoom:map.getZoom(),tileSize:256,engine:'leaflet'});
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
    map.on('movestart',()=>{element.dataset.mapCamera='moving';});
    map.on('zoomstart',()=>{zooming.current=true;element.dataset.mapCamera='moving';});
    map.on('zoomend',()=>{zooming.current=false;zoomControl.settled();navigation.flush();setMapZoom(map.getZoom());territoryLayer.current?.setStyle(territoryStyle);
     const width=routeStrokeWidth(map.getZoom());selected.current?.getLayers().slice(0,2).forEach((layer,index)=>(layer as LeafletGeoJSON).setStyle({weight:width+(index===0?4:0)}));
     scheduleDirectionLayout();requestAnimationFrame(()=>{if(!cancelled){delete element.dataset.mapCamera;scheduleDirectionLayout();}});});
    points.current=L.layerGroup().addTo(map);
    const clampCamera=()=>{
     const floor=cameraFloor.current;if(cancelled||clamping||!floor)return;
     const before=map.getCenter(),next=constrainFramedCamera(before.lng,before.lat,map.getZoom(),floor,framedCamera.current);
     if(Math.abs(before.lng-next.center[0])>1e-7||Math.abs(before.lat-next.center[1])>1e-7||Math.abs(map.getZoom()-next.zoom)>1e-7){
      clamping=true;map.setView([next.center[1],next.center[0]],next.zoom,{animate:false});clamping=false;
     }
     const center=map.getCenter();
     fullView.current=Math.abs(map.getZoom()-floor.zoom)<1e-5&&Math.abs(center.lng-floor.center[0])<1e-4&&Math.abs(center.lat-floor.center[1])<1e-4;
     callbacks.current.onViewportRegion?.(viewportRegionId(center.lng,center.lat,map.getZoom()));
    };
    map.on('moveend',()=>{delete element.dataset.mapCamera;clampCamera();ensureDetail();scheduleDirectionLayout();});
    const queueResize=()=>{
     cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{
      if(cancelled||!container.current)return;
      const wasOverview=fullView.current;
      map.invalidateSize({pan:false});const {camera:next}=russiaView(container.current,256);cameraFloor.current=next;map.setMinZoom(next.zoom);
      if(wasOverview&&!hasPlanFrame())fitRussia(false);else{clampCamera();frameRefit.current?.resized();}
      scheduleDirectionLayout();
     });
    };
    resize=new ResizeObserver(queueResize);resize.observe(element);
    const panel=element.closest('.explore-layout')?.querySelector('.explore-panel');
    // Transforms do not resize the map. Real size changes use this observer;
    // the sheet's transitionend/instant-settle signal updates insets once.
    // Watching inline styles would reframe the map on every drag movement.
    if(panel)resize.observe(panel);
    paintFrame=requestAnimationFrame(()=>{if(!cancelled){setLoaded(true);}});
    ensureDetail();
   }catch(error){if(!cancelled){zoomButtons.current?.dispose();zoomButtons.current=null;frameRefit.current?.dispose();frameRefit.current=null;unbindFrame?.();setStatus('Не удалось загрузить географию России. Карточки маршрутов доступны в списке.');console.error('Russia canvas map failed',error);}}
  })();
  return()=>{cancelled=true;zoomButtons.current?.dispose();zoomButtons.current=null;navigation.dispose();if(navigationRef.current===navigation)navigationRef.current=null;locationEpoch.current++;unbindLocationGestures?.();unbindLabels?.();updateDirections.current=null;directionGroups.current.clear();frameRefit.current?.dispose();frameRefit.current=null;planFrame.current=null;zooming.current=false;unbindFrame?.();++detailEpoch.current;detailLoading.current=false;ensureReliefRef.current=null;cancelAnimationFrame(resizeFrame);cancelAnimationFrame(paintFrame);cancelAnimationFrame(directionLayoutFrame);if(mountElement)delete mountElement.dataset.mapCamera;directionMarkers.clear();resize?.disconnect();reliefRef.current?.destroy();reliefRef.current=null;mapRef.current?.remove();mapRef.current=null;buttonRegistry.clear();routePointRegistry.clear();leafletRef.current=null;baseRef.current=null;satelliteLayer.current=null;satelliteActive.current=false;territoryLayer.current=null;points.current=null;selected.current=null;routeEdges.current=null;edgeAnnotations.length=0;positionMarker.current=null;coverageRef.current=null;window.removeEventListener('online',connection);window.removeEventListener('offline',connection);};
 },[planning,cancelNavigation,ensureDetail,fitPlanFrame,fitRussia,fitTerritoryBounds,hasPlanFrame,removeSatellite,showSatellite,territoryStyle]);
 useEffect(()=>{
  const map=mapRef.current,element=container.current,L=leafletRef.current;if(!map||!element||!L||!loaded)return;
  const animate=!planning&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  territoryLayer.current?.setStyle(territoryStyle);
  territoryLayer.current?.eachLayer(layer=>{
   const path=layer as LeafletPath&{feature?:GeoJSON.Feature};
   if(region?.shapeNames.includes(path.feature?.properties?.shapeName))path.bringToFront();
  });
  if(planning&&trailRef.current)return;
  frameRefit.current?.select(region?.bounds?region.id:undefined);
  // Returning to the overview cancels an external GPS request and its pending status.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  if(!region){fitRussia(animate);return;}
  if(region.bounds){
   if(frameRefit.current?.active())fitTerritoryBounds(region,animate);
   return;
  }
  navigationRef.current?.request(()=>{
  framedCamera.current=null;fullView.current=false;
  const {padding}=russiaView(element,256);
  const zoom=Math.max(region.zoom,cameraFloor.current?.zoom??region.zoom);
  const pixel=map.project([region.center[1],russiaLongitude(region.center[0])],zoom).add([(padding.right-padding.left)/2,(padding.bottom-padding.top)/2]);
  map.setView(map.unproject(pixel,zoom),zoom,{animate});
  });
 },[region,loaded,planning,fitRussia,fitTerritoryBounds,territoryStyle]);
 useEffect(()=>{
  if(!loaded)return;
  updateDirections.current?.();
 },[visibleTrails,region?.id,loaded]);
 useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current,L=leafletRef.current;if(!map||!coverage||!L||!loaded)return;
  points.current?.clearLayers();routePointLayers.current.clear();
  if(!region)return;
  const finePointer=window.matchMedia('(hover:hover) and (pointer:fine)').matches;
  for(const item of mapTrailPointEntries(visibleTrails,(lng,lat)=>inRussiaCoverage(lng,lat,coverage.area),regionRef.current,trailRef.current?.id)){
   const point=createCanvasTrailPoint(L,item,
    ()=>{map.stop();frameRefit.current?.cancel();const selected=visibleTrailsRef.current.find(candidate=>candidate.id===item.id);if(selected)callbacks.current.onTrail?.(selected);},
    ()=>{const selected=visibleTrailsRef.current.find(candidate=>candidate.id===item.id);if(selected)void preloadTrail(selected);});
   if(finePointer)point.hit.bindTooltip(item.title,{direction:'auto',offset:[0,-12],opacity:1,className:'leaflet-route-tooltip'});
   points.current?.addLayer(point.hit).addLayer(point.marker);routePointLayers.current.set(item.id,point);
  }
  raiseCanvasTrailPoints(routePointLayers.current,trailRef.current?.id);
 },[visibleTrails,region,loaded]);
 useEffect(()=>{
  for(const [id,{marker}] of routePointLayers.current){
   const active=id===trail?.id;marker.setRadius(active?8:6.5);marker.setStyle({color:active?'#A56736':'#876A43',weight:active?2:1,fillColor:active?'#244D3C':'#A56736'});
  }
  raiseCanvasTrailPoints(routePointLayers.current,trail?.id);
 },[trail?.id,loaded]);
 useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage||!loaded)return;
  const trail=trailRef.current;
  const identity={id:trail?.id,url:trail?.geometryUrl,geometry:trail?.geometry};
  const clear=()=>{if(selected.current){map.removeLayer(selected.current);selected.current=null;}routeEdges.current?.remove();routeEdges.current=null;routeAnnotations.current.length=0;if(container.current)delete container.current.dataset.mapRouteId;planFrame.current=null;};
  setStatus(previous=>previous==='Линия маршрута не загрузилась. Проверьте подключение.'||previous==='У этой линии нет точек внутри доступного покрытия России. Карточка остаётся доступной.'?'':previous);
  return loadMapSelection({clear,clearBeforeLoad:!trail?.id,
   current:()=>map===mapRef.current&&identity.id===trailRef.current?.id&&identity.url===trailRef.current?.geometryUrl&&identity.geometry===trailRef.current?.geometry,
   load:async()=>{
    if(!trail?.geometryUrl&&!trail?.geometry)return null;
    const [L,fetched]=await Promise.all([import('leaflet'),trail.geometry??loadPublicJSON<unknown>(trail.geometryUrl!)]);
    return{L,data:displayGeoJSON(readRouteGeometry(fetched))};
   },apply:result=>{
   clear();
   if(!result)return;
   const {L,data}=result;
   selected.current=createCanvasTrailLine(L,data,planning,trail?()=>{
    map.stop();frameRefit.current?.cancel();callbacks.current.onTrail?.(trail);
   }:undefined,map.getZoom()).addTo(map);
   if(!planning){
    const edges=L.layerGroup().addTo(map);routeEdges.current=edges;
    for(const edge of routeLineEdges(data)){
     if(!inRussiaCoverage(...edge.coordinate,coverage.area))continue;
     const element=createRouteEdgeElement(edge),size=ROUTE_EDGE_LAYOUT.badgeSize;
     const marker=L.marker([edge.coordinate[1],russiaLongitude(edge.coordinate[0])],{icon:L.divIcon({html:element,className:'route-edge-marker',iconSize:[size,size],iconAnchor:[size/2,size/2]}),interactive:false,keyboard:false}).addTo(edges);
     routeAnnotations.current.push({element,project:()=>map.latLngToContainerPoint(marker.getLatLng())});
    }
   }
   syncRouteEdgeAnnotations(routeAnnotations.current);
   if(container.current&&trail)container.current.dataset.mapRouteId=trail.id;
   raiseCanvasTrailPoints(routePointLayers.current,trailRef.current?.id);
   const covered=coveredRussiaBounds(routeGeometryPositions(data),coverage.area);
   if(!covered){setStatus('У этой линии нет точек внутри доступного покрытия России. Карточка остаётся доступной.');return;}
   if(planning&&trail){planFrame.current={bounds:covered,selection:trail};requestPlanFit();return;}
   navigationRef.current?.request(()=>{
   const bounds=L.latLngBounds([[covered[1],covered[0]],[covered[3],covered[2]]]),element=container.current;if(!element)return;
   const {padding}=russiaView(element,256);fullView.current=false;
   zoomButtons.current?.cancel();map.stop();map.fitBounds(bounds,{paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom:MAP_CONFIG.routeMaxZoom,animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches,duration:.45,easeLinearity:.25});
   });
   },onError:()=>setStatus('Линия маршрута не загрузилась. Проверьте подключение.'),
  });
 },[trail?.id,trail?.geometryUrl,trail?.geometry,loaded,planning,requestPlanFit]);
 useEffect(()=>{
  const map=mapRef.current,L=leafletRef.current;if(!map||!L||!loaded||!planning)return;
  planningMarkers.current?.remove();
  const group=L.layerGroup().addTo(map);planningMarkers.current=group;
  for(const point of planPoints??[]){
   const button=document.createElement(point.onSelect?'button':'span');if(button instanceof HTMLButtonElement)button.type='button';else button.setAttribute('role','img');button.className=`planner-map-point planner-map-point--${point.kind}`;button.setAttribute('aria-label',point.label);button.title=point.label;
   button.textContent=point.kind==='start'?'С':point.kind==='finish'?'Ф':point.kind==='via'?'•':point.kind==='join'?'↔':'+';
   button.addEventListener('click',event=>{event.stopPropagation();point.onSelect?.();});
   L.marker([point.point[1],russiaLongitude(point.point[0])],{icon:L.divIcon({html:button,className:'planner-map-marker',iconSize:[44,44],iconAnchor:[22,22]}),keyboard:false,zIndexOffset:point.kind==='choice'?1000:100}).addTo(group);
  }
  return()=>{group.remove();if(planningMarkers.current===group)planningMarkers.current=null;};
 },[planning,planPoints,loaded]);
 async function changeMode(next:'overview'|'detail'){
  wantsSatellite.current=false;removeSatellite();setScene(false);
  setStatus(previous=>overviewModeStatus(previous,next));
  if(next==='overview'){wantsDetail.current=false;++detailRequest.current;detailLoading.current=false;setTilesLoading(false);if(baseRef.current&&mapRef.current)mapRef.current.removeLayer(baseRef.current);baseRef.current=null;setMode(next);reliefRef.current?.layer.remove();reliefRef.current?.setOverview(true);setReliefReady(false);}
  else try{wantsDetail.current=true;ensureReliefRef.current?.();if(await addDetail()&&baseRef.current&&wantsDetail.current&&navigator.onLine)setMode(next);}catch(error){setStatus(error instanceof Error?error.message:'Карта недоступна.');}
 }
 function locate(){
  cancelNavigation();frameRefit.current?.cancel();
  const request=++locationRevision.current,map=mapRef.current,coverage=coverageRef.current;
  if(!map||!coverage)return;
  const current=()=>request===locationRevision.current&&map===mapRef.current;
  if(!navigator.geolocation){setStatus('Геолокация не поддерживается.');return;}
  setStatus('Определяем местоположение…');
  navigator.geolocation.getCurrentPosition(async position=>{
   if(!current())return;
   const {longitude,latitude,accuracy}=position.coords;
   if(!inRussiaCoverage(longitude,latitude,coverage.area)){setStatus('Местоположение находится за пределами доступной карты России. Переход к нему отключён.');return;}
   const L=await import('leaflet');if(!current())return;
   if(positionMarker.current)map.removeLayer(positionMarker.current);
   positionMarker.current=L.circleMarker([latitude,russiaLongitude(longitude)],{radius:7,color:'#fff',weight:2,fillColor:'#367b9f',fillOpacity:1,interactive:false}).addTo(map);
   navigationRef.current?.request(()=>{if(current()){fullView.current=false;map.setView([latitude,russiaLongitude(longitude)],13);}});setStatus(`Точность около ${Math.round(accuracy)} м. Позиция никому не передаётся.`);
  },()=>{if(current())setStatus('Позиция недоступна. Проверьте разрешение и сигнал.');},{enableHighAccuracy:true,timeout:MAP_CONFIG.geolocationTimeoutMs,maximumAge:MAP_CONFIG.geolocationMaximumAgeMs});
 }
 return <div className={`atlas-wrap ${scene?'showing-terrain':''}`} data-map-imagery={satellite?'satellite':undefined} data-map-detail={mapZoom>=ROUTE_PRESENTATION.closeZoom?'close':undefined} data-map-route={trail&&!planning?'selected':undefined}>
  <div className="atlas-canvas" ref={container} style={{visibility:loaded?'visible':'hidden'}} role="region" aria-label="Интерактивная плоская карта России"/>
  {!loaded&&!status&&<div className="map-skeleton"><MapIcon name="compass" size={38}/><span>Открываем карту России</span></div>}
  {trail&&!planning?<MapRouteContext title={trail.title} caption={overviewContextCaption(satellite?'satellite':mode,mapZoom,scene)}/>:<div className="map-context"><span className="live-dot"/><span>{planning?'План похода':region?.name||'Россия'}</span><span className="context-divider"/><span>{satellite?'Спутник':planning?'Выбранные участки':region?(mode==='detail'?'Тропы и местность':'Обзор'):routeCountLabel(visibleTrails.length)}</span></div>}
  {tilesLoading&&!scene&&!status&&<div className="map-preload-status" role="status">Подгружаем детали текущего ракурса</div>}
  <div className="map-style-switch"><button aria-label="Карта сверху" className={!scene&&!satellite?'active':''} onClick={()=>{setScene(false);if(satellite)void changeMode('detail');}}><MapIcon name="map" size={18}/>Карта</button>{sceneAvailable&&<button aria-label="3D ландшафт Бзерпинского района" className={scene?'active':''} onClick={()=>setScene(true)} onPointerEnter={()=>void preloadTerrain()} title="Объёмная сцена Бзерпинского района"><MapIcon name="terrain" size={19}/>3D</button>}</div>
  <div className="map-controls"><button aria-label="Увеличить масштаб" disabled={!loaded} onClick={()=>zoomBy(MAP_ZOOM_BUTTONS.leafletStep)}><MapIcon name="plus" size={20}/></button><button aria-label="Уменьшить масштаб" disabled={!loaded} onClick={()=>zoomBy(-MAP_ZOOM_BUTTONS.leafletStep)}><MapIcon name="minus" size={20}/></button><span/><button aria-label="Север сверху" title="На плоской карте север всегда сверху" disabled><MapIcon name="compass" size={22}/></button><button aria-label="Моё местоположение" disabled={!loaded} onClick={locate}><MapIcon name="location" size={21}/></button><button aria-label={planning&&trail?'Показать поход целиком':'Показать Россию целиком'} disabled={!loaded} onClick={()=>{cancelNavigation();setScene(false);if(!planning||!requestPlanFit())fitRussia(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);}}><MapIcon name="fit" size={19}/></button></div>
  <div className="layer-control"><button className={layers?'layer-button active':'layer-button'} aria-expanded={layers} onClick={()=>setLayers(!layers)}><MapIcon name="layers" size={20}/>Слои</button>{layers&&<div className="layer-menu"><strong>Ваша карта</strong><button disabled={offline||!loaded} onClick={()=>changeMode('detail')}>Детальные тропы онлайн{mode==='detail'&&!satellite&&<Check size={17}/>}</button><button disabled={offline||!loaded} aria-pressed={satellite} onClick={chooseSatellite}>Спутник{satellite&&<Check size={17}/>}</button><button disabled={!loaded} onClick={()=>changeMode('overview')}>Сохранённый обзор{mode==='overview'&&!satellite&&<Check size={17}/>}</button><label><input type="checkbox" checked={showPaths} onChange={event=>{pathVisibility.current=event.target.checked;setShowPaths(event.target.checked);if(mode==='detail')void addDetail().catch(()=>setStatus('Не удалось обновить слой.'));}}/>Тропы и грунтовые дороги</label><a href="/offline">Подробная офлайн-карта</a><span className="source-note">Плоский режим · без объёмного рельефа</span><a href="/sources">Источники карты</a></div>}</div>
  {status&&!planning&&<div className="map-message" role="status"><MapIcon name="info" size={18}/><span>{status}</span><button onClick={()=>setStatus('')}>Понятно</button></div>}
  {!planning&&<div className="map-legend"><span className="legend-line"/>Тропа<span className="legend-region"/>Направление<span className="legend-hint">{region?'Нажмите на маршрут':'Выберите регион, чтобы приблизить'}</span></div>}
  {sceneAvailable&&<TerrainScene trail={trail} visible={scene} onClose={()=>setScene(false)}/>}
  {!scene&&<MapAttribution ready={loaded} terrain={reliefReady} satellite={satellite} zoom={mapZoom}/>}
 </div>;
}
