'use client';
import {MapIcon} from './MapIcon';
import {MapAttribution} from './MapAttribution';
import {TerrainScene} from './TerrainScene';
import {hasTerrainPreview,preloadTerrain,preloadTrail,loadPublicJSON} from '@/lib/map-preload';
import {loadRussiaGeometry,russiaView} from '@/lib/russia-map';
import {displayGeoJSON,inRussiaCoverage,coveredRussiaBounds,leafletRussiaMask,russiaLongitude,MAP_OUTSIDE_COLOR,type RussiaCamera} from '@/public/maps/russia-viewport.js';
import {useEffect,useRef,useState} from 'react';
import type {Map as LeafletMap,Marker as LeafletMarker,Layer,LayerGroup,GeoJSON as LeafletGeoJSON,Path as LeafletPath,PathOptions} from 'leaflet';
import {Check} from '@/components/TropnikIcons';
import {regions,routeCountLabel,type Region} from '@/lib/content';
import {mapDirectionCounts} from '@/lib/map-catalog';
import {DIRECTION_MARKER_SIZE,groupMapDirections,updateDirectionButtons,reconcileDirectionAnchors,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';
import {territoryForMapPoint,type MapRegion} from '@/lib/territories';
import type {AtlasProps} from './Atlas';
import {canvasStyle} from '@/public/maps/canvas-style.js';
import {createCanvasRelief} from '@/lib/canvas-relief';
import {loadMapSelection} from '@/lib/map-lifecycle';
import {constrainFramedCamera,MapFrameRefit,bindMapFrameRefit} from '@/lib/map-framing';
import {resolveTrailCenter} from '@/lib/map-coordinate';
import 'leaflet/dist/leaflet.css';

type Coverage=Awaited<ReturnType<typeof loadRussiaGeometry>>;
type CanvasDetailLayer=Layer&{paintRules:ReturnType<typeof canvasStyle>['paintRules'];rerenderTiles:()=>void};
function positions(data: unknown): [number,number][] {
 const result:[number,number][]=[];
 const walk=(value:unknown):void=>{
  if(Array.isArray(value)){
   if(typeof value[0]==='number'&&typeof value[1]==='number'&&Number.isFinite(value[0])&&Number.isFinite(value[1]))result.push([value[0],value[1]]);
   else value.forEach(walk);
  }else if(value&&typeof value==='object'){
   const object=value as {features?:unknown;geometry?:unknown;geometries?:unknown;coordinates?:unknown};
   walk(object.features??object.geometry??object.geometries??object.coordinates);
  }
 };
 walk(data);return result;
}
const DETAIL_ENTER_ZOOM=4.6,DETAIL_EXIT_ZOOM=3.8;
const regionBoxes:Record<string,number[]>={altai:[82,48,91,53],krasnodar:[36,42.5,42,46.8],karelia:[29,60.7,37,67.2],krym:[32,44,37,46],baikal:[103,50,113,56.8],kamchatka:[155,50,166,61]};

export function Atlas2D({region,trail,visibleTrails=[],onTrail,onRegion,onMapNote,onViewportRegion}:AtlasProps){
 const container=useRef<HTMLDivElement>(null),mapRef=useRef<LeafletMap|null>(null),baseRef=useRef<CanvasDetailLayer|null>(null);
 const points=useRef<LayerGroup|null>(null),selected=useRef<LeafletGeoJSON|null>(null),positionMarker=useRef<Layer|null>(null);
 const directionButtons=useRef(new Map<string,HTMLButtonElement>());
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
 const [reliefReady,setReliefReady]=useState(false);
 const [scene,setScene]=useState(false),[loaded,setLoaded]=useState(false),[tilesLoading,setTilesLoading]=useState(false);
 const [status,setStatus]=useState(''),[layers,setLayers]=useState(false),[mode,setMode]=useState<'detail'|'overview'>('overview');
 const [showPaths,setShowPaths]=useState(true),[offline,setOffline]=useState(false);
 pathVisibility.current=showPaths;
 trailRef.current=trail;
 regionRef.current=region;
 visibleTrailsRef.current=visibleTrails;
 const sceneAvailable=hasTerrainPreview(trail,region?.id);
 callbacks.current={onRegion,onTrail,onMapNote,onViewportRegion};
 useEffect(()=>{setScene(false);if(sceneAvailable)void preloadTerrain();},[region?.id,trail?.id,sceneAvailable]);

 function territoryStyle(feature?:GeoJSON.Feature):PathOptions{
  const selected=regionRef.current?.shapeNames.includes(feature?.properties?.shapeName);
  return selected?{color:'#486b45',weight:2,opacity:.95,fillColor:'#91ae80',fillOpacity:.13}
   :{color:'#879d78',weight:.65,opacity:.6,fillColor:'#b6c9a2',fillOpacity:.07};
 }

 function fitRussia(animate=false){
  const map=mapRef.current,element=container.current;if(!map||!element)return;
  frameRefit.current?.cancel();
  const {camera}=russiaView(element,256);cameraFloor.current=camera;framedCamera.current=null;fullView.current=true;
  map.setMinZoom(camera.zoom);map.setView([camera.center[1],camera.center[0]],camera.zoom,{animate});fullView.current=true;
 }
 function fitTerritoryBounds(selection:MapRegion,animate:boolean){
  const map=mapRef.current,element=container.current,L=leafletRef.current,b=selection.bounds;if(!map||!element||!L||!b)return;
  const {padding}=russiaView(element,256),bounds:[[number,number],[number,number]]=[[b[1],b[0]],[b[3],b[2]]];
  const zoom=Math.min(11,map.getBoundsZoom(bounds,false,L.point(padding.left+padding.right,padding.top+padding.bottom)));
  const center=map.unproject(map.project(bounds[0],zoom).add(map.project(bounds[1],zoom)).divideBy(2).add([(padding.right-padding.left)/2,(padding.bottom-padding.top)/2]),zoom);
  framedCamera.current={center:[center.lng,center.lat],zoom};fullView.current=false;
  map.fitBounds(bounds,{paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom:11,animate});
 }
 async function addDetail(){
  const map=mapRef.current;if(!map||!navigator.onLine||!wantsDetail.current||map.getZoom()<DETAIL_ENTER_ZOOM)return false;
  const request=++detailRequest.current;
  const current=()=>map===mapRef.current&&request===detailRequest.current&&navigator.onLine&&wantsDetail.current&&map.getZoom()>=DETAIL_EXIT_ZOOM;
  detailLoading.current=true;
  try{
   const p=protomapsRef.current??await import('protomaps-leaflet');protomapsRef.current=p;
   if(!current())return false;
   if(baseRef.current){
    // Preserve the canvases, labels and decoded tile cache. Redrawing the whole
    // Leaflet layer removed the ready map while the replacement was still loading.
    baseRef.current.paintRules=canvasStyle(p,pathVisibility.current).paintRules;
    baseRef.current.rerenderTiles();return true;
   }
   const tilejson=await loadPublicJSON<{tiles:string[]}>('https://tiles.openfreemap.org/planet/latest');
   if(!current())return false;
   if(!tilejson.tiles?.[0]?.startsWith('https://tiles.openfreemap.org/'))throw new Error('Источник карты не подтверждён.');
   const detail=p.leafletLayer({url:tilejson.tiles[0],...canvasStyle(p,pathVisibility.current),attribution:'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',devicePixelRatio:Math.min(window.devicePixelRatio,2)}) as unknown as CanvasDetailLayer;
   const attached=()=>map===mapRef.current&&baseRef.current===detail;
   detail.on('loading',()=>{if(attached())setTilesLoading(true);});
   detail.on('load',()=>{if(attached())setTilesLoading(false);});
   detail.on('tileerror',()=>{if(attached())setTilesLoading(false);});
   baseRef.current=detail;detail.addTo(map);reliefRef.current?.setOverview(false);return true;
  }catch(error){if(current())throw error;return false;}
  finally{if(request===detailRequest.current)detailLoading.current=false;}
 }
 function ensureDetail(){
  const map=mapRef.current;
  if(!map)return;
  const zoom=map.getZoom();
  if(zoom<DETAIL_EXIT_ZOOM){
   if(baseRef.current||detailLoading.current){
    ++detailRequest.current;detailLoading.current=false;
    if(baseRef.current)map.removeLayer(baseRef.current);baseRef.current=null;
    setTilesLoading(false);setMode('overview');reliefRef.current?.setOverview(true);
   }
   return;
  }
  if(zoom<DETAIL_ENTER_ZOOM||!navigator.onLine||!wantsDetail.current||baseRef.current||detailLoading.current)return;
  void addDetail().then(added=>{if(added&&map===mapRef.current&&baseRef.current&&wantsDetail.current&&navigator.onLine)setMode('detail');}).catch(()=>{if(map===mapRef.current)setStatus('Детали не загрузились. Обзор России доступен.');});
 }
 useEffect(()=>{
  let cancelled=false,resize:ResizeObserver|undefined,panelChanges:MutationObserver|undefined,resizeFrame=0,paintFrame=0,directionLayoutFrame=0,clamping=false,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined;
  const directionMarkers=new Map<string,LeafletMarker>();
  let leaflet:typeof import('leaflet')|undefined;
  const ensureRelief=()=>{
   const map=mapRef.current;if(cancelled||!leaflet||!map||!navigator.onLine||!wantsDetail.current||typeof Worker==='undefined'||typeof OffscreenCanvas==='undefined')return;
   if(!reliefRef.current)reliefRef.current=createCanvasRelief(leaflet,ready=>{if(!cancelled){setReliefReady(ready);setStatus(previous=>ready?(previous==='Рельеф пока не загрузился. Доступна основная карта.'?'':previous):(previous||'Рельеф пока не загрузился. Доступна основная карта.'));}});
   reliefRef.current.setOverview(!baseRef.current);reliefRef.current.layer.addTo(map);
  };
  ensureReliefRef.current=ensureRelief;
  const connection=()=>{
   setOffline(!navigator.onLine);
   if(!navigator.onLine){++detailRequest.current;detailLoading.current=false;setTilesLoading(false);if(baseRef.current&&mapRef.current)mapRef.current.removeLayer(baseRef.current);baseRef.current=null;reliefRef.current?.layer.remove();reliefRef.current?.setOverview(true);setReliefReady(false);setMode('overview');setStatus('Без сети: обзор. Скачанные подробные карты открываются в разделе «Офлайн».');}
   else{setStatus(previous=>previous==='Без сети: обзор. Скачанные подробные карты открываются в разделе «Офлайн».'?'':previous);ensureRelief();ensureDetail();}
  };
  window.addEventListener('online',connection);window.addEventListener('offline',connection);setOffline(!navigator.onLine);setLoaded(false);
  (async()=>{
   try{
    const [L,coverage,admin]=await Promise.all([import('leaflet'),loadRussiaGeometry(),loadPublicJSON<GeoJSON.GeoJsonObject>('/data/territories.geojson')]);
    if(cancelled||!container.current)return;
    leaflet=L;leafletRef.current=L;
    if(!coverage.area.features?.length||!coverage.mask.features?.length)throw new Error('Coverage geometry missing');
    (window as unknown as {L:typeof L}).L=L;coverageRef.current=coverage;
    const element=container.current,{camera}=russiaView(element,256);cameraFloor.current=camera;
    const map=L.map(element,{center:[camera.center[1],camera.center[0]],zoom:camera.zoom,zoomControl:false,attributionControl:false,minZoom:camera.zoom,maxZoom:18,zoomSnap:0,zoomDelta:.75,preferCanvas:true,scrollWheelZoom:true,worldCopyJump:false,zoomAnimation:true,markerZoomAnimation:true,fadeAnimation:false});
    mapRef.current=map;element.style.background=MAP_OUTSIDE_COLOR;
    frameRefit.current=new MapFrameRefit({
     allowed:()=>!cancelled&&map===mapRef.current&&!!regionRef.current?.bounds&&!trailRef.current&&!!container.current,
     refit:()=>{if(regionRef.current)fitTerritoryBounds(regionRef.current,!window.matchMedia('(prefers-reduced-motion: reduce)').matches);},
    });
    unbindFrame=bindMapFrameRefit(element,element.closest('.explore-layout')?.querySelector('.explore-panel')??null,frameRefit.current);
    map.on('dragstart',()=>frameRefit.current?.cancel());
    map.createPane('russia-land');map.getPane('russia-land')!.style.zIndex='150';
    map.createPane('russia-overview-relief');Object.assign(map.getPane('russia-overview-relief')!.style,{zIndex:'160',pointerEvents:'none'});
    map.createPane('russia-relief');Object.assign(map.getPane('russia-relief')!.style,{zIndex:'350',pointerEvents:'none'});
    map.createPane('russia-mask');Object.assign(map.getPane('russia-mask')!.style,{zIndex:'450',pointerEvents:'none'});
    L.geoJSON(coverage.area,{pane:'russia-land',style:{renderer:L.canvas({pane:'russia-land',padding:.15}),color:'#aebda2',weight:.65,fillColor:'#dbe4cd',fillOpacity:1},interactive:false}).addTo(map);
    L.tileLayer('/maps/russia-relief/{z}/{x}/{y}.png',{pane:'russia-overview-relief',minZoom:0,maxNativeZoom:4,maxZoom:6,tileSize:256,keepBuffer:2,updateWhenIdle:true,updateWhenZooming:false}).addTo(map);
    ensureRelief();
    territoryLayer.current=L.geoJSON(displayGeoJSON(admin),{style:territoryStyle,onEachFeature:(feature,layer)=>{
     layer.on('click',(event:{latlng?:{lng:number;lat:number}})=>{
      if(map.getZoom()>7||!event.latlng||!inRussiaCoverage(event.latlng.lng,event.latlng.lat,coverage.area))return;
      const shape=feature.properties?.shapeName;const territory=typeof shape==='string'?territoryForMapPoint([shape],[russiaLongitude(event.latlng.lng),event.latlng.lat]):undefined;if(territory){map.stop();frameRefit.current?.cancel();callbacks.current.onRegion(territory);}
     });
    }}).addTo(map);
    // The non-interactive mask sits above tiles and route paths; validated marker labels stay above it. Leaflet
    // does not repeat GeoJSON, so its two adjacent world copies are covered too.
    L.geoJSON(leafletRussiaMask(coverage.mask),{pane:'russia-mask',interactive:false,style:{renderer:L.canvas({pane:'russia-mask',padding:.15}),stroke:false,fillColor:MAP_OUTSIDE_COLOR,fillOpacity:1,fillRule:'evenodd'}}).addTo(map);
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
    points.current=L.layerGroup().addTo(map);
    const clampCamera=()=>{
     const floor=cameraFloor.current;if(cancelled||clamping||!floor)return;
     const before=map.getCenter(),next=constrainFramedCamera(before.lng,before.lat,map.getZoom(),floor,framedCamera.current);
     if(Math.abs(before.lng-next.center[0])>1e-7||Math.abs(before.lat-next.center[1])>1e-7||Math.abs(map.getZoom()-next.zoom)>1e-7){
      clamping=true;map.setView([next.center[1],next.center[0]],next.zoom,{animate:false});clamping=false;
     }
     const center=map.getCenter();
     fullView.current=Math.abs(map.getZoom()-floor.zoom)<1e-5&&Math.abs(center.lng-floor.center[0])<1e-4&&Math.abs(center.lat-floor.center[1])<1e-4;
     const found=map.getZoom()>=4?Object.entries(regionBoxes).find(([,b])=>center.lng>=b[0]&&center.lng<=b[2]&&center.lat>=b[1]&&center.lat<=b[3]):undefined;
     callbacks.current.onViewportRegion?.(found?.[0]);
    };
    map.on('moveend',()=>{clampCamera();ensureDetail();scheduleDirectionLayout();});
    const queueResize=()=>{
     cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{
      if(cancelled||!container.current)return;
      const wasOverview=fullView.current;
      map.invalidateSize({pan:false});const {camera:next}=russiaView(container.current,256);cameraFloor.current=next;map.setMinZoom(next.zoom);
      if(wasOverview)fitRussia(false);else{clampCamera();frameRefit.current?.resized();}
      scheduleDirectionLayout();
     });
    };
    resize=new ResizeObserver(queueResize);resize.observe(element);
    const panel=element.closest('.explore-layout')?.querySelector('.explore-panel');
    if(panel){resize.observe(panel);panelChanges=new MutationObserver(queueResize);panelChanges.observe(panel,{attributes:true,attributeFilter:['class','style']});}
    paintFrame=requestAnimationFrame(()=>{if(!cancelled){setLoaded(true);}});
    ensureDetail();
   }catch(error){if(!cancelled){frameRefit.current?.dispose();frameRefit.current=null;unbindFrame?.();setStatus('Не удалось загрузить географию России. Карточки маршрутов доступны в списке.');console.error('Russia canvas map failed',error);}}
  })();
  return()=>{cancelled=true;unbindLabels?.();updateDirections.current=null;directionGroups.current.clear();frameRefit.current?.dispose();frameRefit.current=null;unbindFrame?.();++detailRequest.current;detailLoading.current=false;ensureReliefRef.current=null;cancelAnimationFrame(resizeFrame);cancelAnimationFrame(paintFrame);cancelAnimationFrame(directionLayoutFrame);if(container.current)delete container.current.dataset.mapCamera;directionMarkers.clear();resize?.disconnect();panelChanges?.disconnect();reliefRef.current?.destroy();reliefRef.current=null;mapRef.current?.remove();mapRef.current=null;directionButtons.current.clear();leafletRef.current=null;baseRef.current=null;territoryLayer.current=null;points.current=null;selected.current=null;positionMarker.current=null;coverageRef.current=null;window.removeEventListener('online',connection);window.removeEventListener('offline',connection);};
 },[]);
 useEffect(()=>{
  const map=mapRef.current,element=container.current,L=leafletRef.current;if(!map||!element||!L||!loaded)return;
  frameRefit.current?.select(region?.bounds?region.id:undefined);
  const animate=!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  territoryLayer.current?.setStyle(territoryStyle);
  territoryLayer.current?.eachLayer(layer=>{
   const path=layer as LeafletPath&{feature?:GeoJSON.Feature};
   if(region?.shapeNames.includes(path.feature?.properties?.shapeName))path.bringToFront();
  });
  if(!region){fitRussia(animate);return;}
  const {padding}=russiaView(element,256);
  if(region.bounds){
   if(frameRefit.current?.active())fitTerritoryBounds(region,animate);
   return;
  }
  framedCamera.current=null;fullView.current=false;
  const zoom=Math.max(region.zoom,cameraFloor.current?.zoom??region.zoom);
  const pixel=map.project([region.center[1],russiaLongitude(region.center[0])],zoom).add([(padding.right-padding.left)/2,(padding.bottom-padding.top)/2]);
  map.setView(map.unproject(pixel,zoom),zoom,{animate});
 },[region?.id,loaded]);
 useEffect(()=>{
  if(!loaded)return;
  updateDirections.current?.();
 },[visibleTrails,region?.id,loaded]);
 useEffect(()=>{
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
 },[trail?.id,loaded]);
 useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage||!loaded)return;
  const identity={id:trail?.id,url:trail?.geometryUrl,geometry:trail?.geometry};
  const clear=()=>{if(selected.current){map.removeLayer(selected.current);selected.current=null;}};
  setStatus(previous=>previous==='Линия маршрута не загрузилась. Проверьте подключение.'||previous==='У этой линии нет точек внутри доступного покрытия России. Карточка остаётся доступной.'?'':previous);
  return loadMapSelection({clear,clearBeforeLoad:!trail?.id,
   current:()=>map===mapRef.current&&identity.id===trailRef.current?.id&&identity.url===trailRef.current?.geometryUrl&&identity.geometry===trailRef.current?.geometry,
   load:async()=>{
    if(!trail?.geometryUrl&&!trail?.geometry)return null;
    const [L,fetched]=await Promise.all([import('leaflet'),trail.geometry??loadPublicJSON<any>(trail.geometryUrl!).then(value=>value?.data?.geometry||value)]);
    return{L,data:displayGeoJSON(fetched) as GeoJSON.GeoJsonObject};
   },apply:result=>{
   if(!result)return;
   const {L,data}=result;
   selected.current=L.geoJSON(data,{style:{color:'#244d3c',weight:4,opacity:.95,dashArray:'9 4'},interactive:false}).addTo(map);
   const covered=coveredRussiaBounds(positions(data),coverage.area);
   if(!covered){setStatus('У этой линии нет точек внутри доступного покрытия России. Карточка остаётся доступной.');return;}
   const bounds=L.latLngBounds([[covered[1],covered[0]],[covered[3],covered[2]]]),element=container.current;if(!element)return;
   const {padding}=russiaView(element,256);fullView.current=false;
   map.stop();map.fitBounds(bounds,{paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom:14,animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches,duration:.45,easeLinearity:.25});
   },onError:()=>setStatus('Линия маршрута не загрузилась. Проверьте подключение.'),
  });
 },[trail?.id,trail?.geometryUrl,trail?.geometry,loaded]);
 async function changeMode(next:'overview'|'detail'){
  setStatus('');
  if(next==='overview'){wantsDetail.current=false;++detailRequest.current;detailLoading.current=false;setTilesLoading(false);if(baseRef.current&&mapRef.current)mapRef.current.removeLayer(baseRef.current);baseRef.current=null;setMode(next);reliefRef.current?.layer.remove();reliefRef.current?.setOverview(true);setReliefReady(false);}
  else try{wantsDetail.current=true;ensureReliefRef.current?.();if(await addDetail()&&baseRef.current&&wantsDetail.current&&navigator.onLine)setMode(next);}catch(error){setStatus(error instanceof Error?error.message:'Карта недоступна.');}
 }
 function locate(){
  frameRefit.current?.cancel();
  if(!navigator.geolocation){setStatus('Геолокация не поддерживается.');return;}
  setStatus('Определяем местоположение…');
  navigator.geolocation.getCurrentPosition(async position=>{
   const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage)return;
   const {longitude,latitude,accuracy}=position.coords;
   if(!inRussiaCoverage(longitude,latitude,coverage.area)){setStatus('Местоположение находится за пределами доступной карты России. Переход к нему отключён.');return;}
   const L=await import('leaflet');if(map!==mapRef.current)return;
   if(positionMarker.current)map.removeLayer(positionMarker.current);
   positionMarker.current=L.circleMarker([latitude,russiaLongitude(longitude)],{radius:7,color:'#fff',weight:2,fillColor:'#367b9f',fillOpacity:1}).addTo(map);
   fullView.current=false;map.setView([latitude,russiaLongitude(longitude)],13);setStatus(`Точность около ${Math.round(accuracy)} м. Позиция никому не передаётся.`);
  },()=>setStatus('Позиция недоступна. Проверьте разрешение и сигнал.'),{enableHighAccuracy:true,timeout:15000});
 }
 return <div className={`atlas-wrap ${scene?'showing-terrain':''}`}>
  <div className="atlas-canvas" ref={container} style={{visibility:loaded?'visible':'hidden'}} role="region" aria-label="Интерактивная плоская карта России"/>
  {!loaded&&!status&&<div className="map-skeleton"><MapIcon name="compass" size={38}/><span>Открываем карту России</span></div>}
  <div className="map-context"><span className="live-dot"/><span>{region?.name||'Россия'}</span><span className="context-divider"/><span>{region?(mode==='detail'?'Тропы и местность':'Обзор'):routeCountLabel(visibleTrails.length)}</span></div>
  {tilesLoading&&!scene&&!status&&<div className="map-preload-status" role="status">Подгружаем детали текущего ракурса</div>}
  <div className="map-style-switch"><button aria-label="Карта сверху" className={!scene?'active':''} onClick={()=>setScene(false)}><MapIcon name="map" size={18}/>Карта</button>{sceneAvailable&&<button aria-label="3D ландшафт Бзерпинского района" className={scene?'active':''} onClick={()=>setScene(true)} onPointerEnter={()=>void preloadTerrain()} title="Объёмная сцена Бзерпинского района"><MapIcon name="terrain" size={19}/>3D</button>}</div>
  <div className="map-controls"><button aria-label="Увеличить масштаб" disabled={!loaded} onClick={()=>{frameRefit.current?.cancel();mapRef.current?.zoomIn();}}><MapIcon name="plus" size={20}/></button><button aria-label="Уменьшить масштаб" disabled={!loaded} onClick={()=>{frameRefit.current?.cancel();mapRef.current?.zoomOut();}}><MapIcon name="minus" size={20}/></button><span/><button aria-label="Север сверху" title="На плоской карте север всегда сверху" disabled><MapIcon name="compass" size={22}/></button><button aria-label="Моё местоположение" disabled={!loaded} onClick={locate}><MapIcon name="location" size={21}/></button><button aria-label="Показать Россию целиком" disabled={!loaded} onClick={()=>{setScene(false);fitRussia(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);}}><MapIcon name="fit" size={19}/></button></div>
  <div className="layer-control"><button className={layers?'layer-button active':'layer-button'} aria-expanded={layers} onClick={()=>setLayers(!layers)}><MapIcon name="layers" size={20}/>Слои</button>{layers&&<div className="layer-menu"><strong>Ваша карта</strong><button disabled={offline||!loaded} onClick={()=>changeMode('detail')}>Детальные тропы онлайн{mode==='detail'&&<Check size={17}/>}</button><button disabled={!loaded} onClick={()=>changeMode('overview')}>Сохранённый обзор{mode==='overview'&&<Check size={17}/>}</button><label><input type="checkbox" checked={showPaths} onChange={event=>{pathVisibility.current=event.target.checked;setShowPaths(event.target.checked);if(mode==='detail')void addDetail().catch(()=>setStatus('Не удалось обновить слой.'));}}/>Тропы и грунтовые дороги</label><a href="/offline">Подробная офлайн-карта</a><span className="source-note">Плоский режим · без объёмного рельефа</span><a href="/sources">Источники карты</a></div>}</div>
  {status&&<div className="map-message" role="status"><MapIcon name="info" size={18}/><span>{status}</span><button onClick={()=>setStatus('')}>Понятно</button></div>}
  <div className="map-legend"><span className="legend-line"/>Тропа<span className="legend-region"/>Направление<span className="legend-hint">{region?'Нажмите на маршрут':'Выберите регион, чтобы приблизить'}</span></div>
  {sceneAvailable&&<TerrainScene trail={trail} visible={scene} onClose={()=>setScene(false)}/>}
  {!scene&&<MapAttribution ready={loaded} terrain={reliefReady}/>}
 </div>;
}
