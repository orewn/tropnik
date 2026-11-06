'use client';
import {MapIcon} from './MapIcon';
import {MapAttribution} from './MapAttribution';
import {TerrainScene} from './TerrainScene';
import {hasTerrainPreview,preloadTerrain,loadPublicJSON} from '@/lib/map-preload';
import {loadRussiaGeometry,russiaView} from '@/lib/russia-map';
import {constrainRussiaCamera,displayGeoJSON,inRussiaCoverage,leafletRussiaMask,russiaLongitude,MAP_OUTSIDE_COLOR,type RussiaCamera} from '@/public/maps/russia-viewport.js';
import {useEffect,useRef,useState} from 'react';
import type {Map as LeafletMap,Layer,LayerGroup,GeoJSON as LeafletGeoJSON} from 'leaflet';
import {Check} from '@/components/TropnikIcons';
import {regions} from '@/lib/content';
import type {AtlasProps} from './Atlas';
import {canvasStyle} from '@/public/maps/canvas-style.js';
import {createCanvasRelief} from '@/lib/canvas-relief';
import 'leaflet/dist/leaflet.css';

type Coverage=Awaited<ReturnType<typeof loadRussiaGeometry>>;
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
const DETAIL_MIN_ZOOM=4;
const regionBoxes:Record<string,number[]>={altai:[82,48,91,53],krasnodar:[36,42.5,42,46.8],karelia:[29,60.7,37,67.2],krym:[32,44,37,46],baikal:[103,50,113,56.8],kamchatka:[155,50,166,61]};

export function Atlas2D({region,trail,visibleTrails=[],onTrail,onRegion,onMapNote,onViewportRegion}:AtlasProps){
 const container=useRef<HTMLDivElement>(null),mapRef=useRef<LeafletMap|null>(null),baseRef=useRef<Layer|null>(null);
 const points=useRef<LayerGroup|null>(null),selected=useRef<LeafletGeoJSON|null>(null),positionMarker=useRef<Layer|null>(null);
 const coverageRef=useRef<Coverage|null>(null),cameraFloor=useRef<RussiaCamera|null>(null),fullView=useRef(true),detailRequest=useRef(0);
 const callbacks=useRef({onRegion,onTrail,onMapNote,onViewportRegion});
 const wantsDetail=useRef(true),detailLoading=useRef(false),pathVisibility=useRef(true);
 const reliefRef=useRef<ReturnType<typeof createCanvasRelief>|null>(null);
 const [reliefReady,setReliefReady]=useState(false);
 const [scene,setScene]=useState(false),[loaded,setLoaded]=useState(false),[tilesLoading,setTilesLoading]=useState(false);
 const [status,setStatus]=useState(''),[layers,setLayers]=useState(false),[mode,setMode]=useState<'detail'|'overview'>('overview');
 const [showPaths,setShowPaths]=useState(true),[offline,setOffline]=useState(false);
 pathVisibility.current=showPaths;
 const sceneAvailable=hasTerrainPreview(trail,region?.id);
 callbacks.current={onRegion,onTrail,onMapNote,onViewportRegion};
 useEffect(()=>{setScene(false);if(sceneAvailable)void preloadTerrain();},[region?.id,trail?.id,sceneAvailable]);

 function fitRussia(animate=false){
  const map=mapRef.current,element=container.current;if(!map||!element)return;
  const {camera}=russiaView(element,256);cameraFloor.current=camera;fullView.current=true;
  map.setMinZoom(camera.zoom);map.setView([camera.center[1],camera.center[0]],camera.zoom,{animate});fullView.current=true;
 }
 async function addDetail(paths=true){
  const map=mapRef.current;if(!map||!navigator.onLine)return false;
  const request=++detailRequest.current;
  const [p,tilejson]=await Promise.all([import('protomaps-leaflet'),loadPublicJSON<{tiles:string[]}>('https://tiles.openfreemap.org/planet/latest')]);
  if(!tilejson.tiles?.[0]?.startsWith('https://tiles.openfreemap.org/'))throw new Error('Источник карты не подтверждён.');
  if(map!==mapRef.current||request!==detailRequest.current||!navigator.onLine)return false;
  const detail=p.leafletLayer({url:tilejson.tiles[0],...canvasStyle(p,paths),attribution:'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',devicePixelRatio:Math.min(window.devicePixelRatio,2)}) as unknown as Layer;
  const current=()=>map===mapRef.current&&baseRef.current===detail;
  detail.on('loading',()=>{if(current())setTilesLoading(true);});
  detail.on('load',()=>{if(current())setTilesLoading(false);});
  detail.on('tileerror',()=>{if(current()){setTilesLoading(false);setStatus('Часть карты не загрузилась. Проверьте подключение.');}});
  if(baseRef.current)map.removeLayer(baseRef.current);baseRef.current=detail;detail.addTo(map);reliefRef.current?.setOverview(false);return true;
 }
 function ensureDetail(){
  const map=mapRef.current;
  if(!map)return;
  if(map.getZoom()<DETAIL_MIN_ZOOM){
   if(baseRef.current||detailLoading.current){
    ++detailRequest.current;detailLoading.current=false;
    if(baseRef.current)map.removeLayer(baseRef.current);baseRef.current=null;
    setTilesLoading(false);setMode('overview');reliefRef.current?.setOverview(true);
   }
   return;
  }
  if(!navigator.onLine||!wantsDetail.current||baseRef.current||detailLoading.current)return;
  detailLoading.current=true;
  void addDetail(pathVisibility.current).then(added=>{if(added&&map===mapRef.current)setMode('detail');}).catch(()=>{if(map===mapRef.current)setStatus('Детали не загрузились. Обзор России доступен.');}).finally(()=>{detailLoading.current=false;});
 }
 useEffect(()=>{
  let cancelled=false,resize:ResizeObserver|undefined,panelChanges:MutationObserver|undefined,resizeFrame=0,paintFrame=0,clamping=false;
  let leaflet:typeof import('leaflet')|undefined;
  const ensureRelief=()=>{
   const map=mapRef.current;if(cancelled||!leaflet||!map||!navigator.onLine||typeof Worker==='undefined'||typeof OffscreenCanvas==='undefined')return;
   if(!reliefRef.current)reliefRef.current=createCanvasRelief(leaflet,ready=>{if(!cancelled){setReliefReady(ready);setStatus(previous=>ready?(previous==='Рельеф пока не загрузился. Доступна основная карта.'?'':previous):(previous||'Рельеф пока не загрузился. Доступна основная карта.'));}});
   reliefRef.current.setOverview(!baseRef.current);reliefRef.current.layer.addTo(map);
  };
  const connection=()=>{
   setOffline(!navigator.onLine);
   if(!navigator.onLine){++detailRequest.current;setTilesLoading(false);if(baseRef.current&&mapRef.current)mapRef.current.removeLayer(baseRef.current);baseRef.current=null;reliefRef.current?.layer.remove();reliefRef.current?.setOverview(true);setReliefReady(false);setMode('overview');setStatus('Без сети: обзор. Скачанные подробные карты открываются в разделе «Офлайн».');}
   else{setStatus(previous=>previous==='Без сети: обзор. Скачанные подробные карты открываются в разделе «Офлайн».'?'':previous);ensureRelief();ensureDetail();}
  };
  window.addEventListener('online',connection);window.addEventListener('offline',connection);setOffline(!navigator.onLine);setLoaded(false);
  (async()=>{
   try{
    const [L,coverage,admin]=await Promise.all([import('leaflet'),loadRussiaGeometry(),loadPublicJSON<GeoJSON.GeoJsonObject>('/data/regions.geojson')]);
    if(cancelled||!container.current)return;
    leaflet=L;
    if(!coverage.area.features?.length||!coverage.mask.features?.length)throw new Error('Coverage geometry missing');
    (window as unknown as {L:typeof L}).L=L;coverageRef.current=coverage;
    const element=container.current,{camera}=russiaView(element,256);cameraFloor.current=camera;
    const map=L.map(element,{center:[camera.center[1],camera.center[0]],zoom:camera.zoom,zoomControl:false,attributionControl:false,minZoom:camera.zoom,maxZoom:18,zoomSnap:0,zoomDelta:.75,preferCanvas:true,scrollWheelZoom:true,worldCopyJump:false});
    mapRef.current=map;element.style.background=MAP_OUTSIDE_COLOR;
    map.createPane('russia-land');map.getPane('russia-land')!.style.zIndex='150';
    map.createPane('russia-overview-relief');Object.assign(map.getPane('russia-overview-relief')!.style,{zIndex:'160',pointerEvents:'none'});
    map.createPane('russia-relief');Object.assign(map.getPane('russia-relief')!.style,{zIndex:'350',pointerEvents:'none'});
    map.createPane('russia-mask');Object.assign(map.getPane('russia-mask')!.style,{zIndex:'450',pointerEvents:'none'});
    L.geoJSON(coverage.area,{pane:'russia-land',style:{renderer:L.canvas({pane:'russia-land',padding:.15}),color:'#aebda2',weight:.65,fillColor:'#dbe4cd',fillOpacity:1},interactive:false}).addTo(map);
    L.tileLayer('/maps/russia-relief/{z}/{x}/{y}.png',{pane:'russia-overview-relief',minZoom:0,maxNativeZoom:4,maxZoom:6,tileSize:256,keepBuffer:1,updateWhenIdle:true}).addTo(map);
    ensureRelief();
    L.geoJSON(displayGeoJSON(admin),{style:{color:'#879d78',weight:.65,opacity:.6,fillColor:'#b6c9a2',fillOpacity:.07},onEachFeature:(feature,layer)=>{
     layer.on('click',(event:{latlng?:{lng:number;lat:number}})=>{
      if(map.getZoom()>7||!event.latlng||!inRussiaCoverage(event.latlng.lng,event.latlng.lat,coverage.area))return;
      const found=regions.find(item=>item.shapeNames.includes(feature.properties?.shapeName));if(found)callbacks.current.onRegion(found);
     });
    }}).addTo(map);
    // The non-interactive mask sits above tiles and route paths; validated marker labels stay above it. Leaflet
    // does not repeat GeoJSON, so its two adjacent world copies are covered too.
    L.geoJSON(leafletRussiaMask(coverage.mask),{pane:'russia-mask',interactive:false,style:{renderer:L.canvas({pane:'russia-mask',padding:.15}),stroke:false,fillColor:MAP_OUTSIDE_COLOR,fillOpacity:1,fillRule:'evenodd'}}).addTo(map);
    for(const item of regions){
     if(!inRussiaCoverage(...item.center,coverage.area))continue;
     const button=document.createElement('button');button.className='region-marker region-marker-'+item.id;button.setAttribute('aria-label',`Открыть ${item.name}`);
     const dot=document.createElement('span');dot.className='region-marker-dot';const label=document.createElement('span');label.className='region-marker-label';label.textContent=item.name;button.appendChild(dot);button.appendChild(label);
     button.addEventListener('click',event=>{event.stopPropagation();callbacks.current.onRegion(item);});
     L.marker([item.center[1],russiaLongitude(item.center[0])],{icon:L.divIcon({html:button,className:'leaflet-region-marker',iconSize:[1,1],iconAnchor:[0,0]}),keyboard:false}).addTo(map);
    }
    points.current=L.layerGroup().addTo(map);
    const clampCamera=()=>{
     const floor=cameraFloor.current;if(cancelled||clamping||!floor)return;
     const before=map.getCenter(),next=constrainRussiaCamera(before.lng,before.lat,map.getZoom(),floor);
     if(Math.abs(before.lng-next.center[0])>1e-7||Math.abs(before.lat-next.center[1])>1e-7||Math.abs(map.getZoom()-next.zoom)>1e-7){
      clamping=true;map.setView([next.center[1],next.center[0]],next.zoom,{animate:false});clamping=false;
     }
     const center=map.getCenter();
     fullView.current=Math.abs(map.getZoom()-floor.zoom)<1e-5&&Math.abs(center.lng-floor.center[0])<1e-4&&Math.abs(center.lat-floor.center[1])<1e-4;
     const found=map.getZoom()>=4?Object.entries(regionBoxes).find(([,b])=>center.lng>=b[0]&&center.lng<=b[2]&&center.lat>=b[1]&&center.lat<=b[3]):undefined;
     callbacks.current.onViewportRegion?.(found?.[0]);
    };
    map.on('moveend',()=>{clampCamera();ensureDetail();});
    const queueResize=()=>{
     cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{
      if(cancelled||!container.current)return;
      const wasOverview=fullView.current;
      map.invalidateSize({pan:false});const {camera:next}=russiaView(container.current,256);cameraFloor.current=next;map.setMinZoom(next.zoom);
      if(wasOverview)fitRussia(false);else clampCamera();
     });
    };
    resize=new ResizeObserver(queueResize);resize.observe(element);
    const panel=element.closest('.explore-layout')?.querySelector('.explore-panel');
    if(panel){resize.observe(panel);panelChanges=new MutationObserver(queueResize);panelChanges.observe(panel,{attributes:true,attributeFilter:['class','style']});}
    paintFrame=requestAnimationFrame(()=>{if(!cancelled){setLoaded(true);}});
    ensureDetail();
   }catch(error){if(!cancelled){setStatus('Не удалось загрузить географию России. Карточки маршрутов доступны в списке.');console.error('Russia canvas map failed',error);}}
  })();
  return()=>{cancelled=true;++detailRequest.current;cancelAnimationFrame(resizeFrame);cancelAnimationFrame(paintFrame);resize?.disconnect();panelChanges?.disconnect();reliefRef.current?.destroy();reliefRef.current=null;mapRef.current?.remove();mapRef.current=null;baseRef.current=null;points.current=null;selected.current=null;positionMarker.current=null;coverageRef.current=null;window.removeEventListener('online',connection);window.removeEventListener('offline',connection);};
 },[]);
 useEffect(()=>{
  const map=mapRef.current,element=container.current;if(!map||!element||!loaded)return;
  const animate=!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!region){fitRussia(animate);return;}
  const {padding}=russiaView(element,256),zoom=Math.max(region.zoom,cameraFloor.current?.zoom??region.zoom);
  const pixel=map.project([region.center[1],russiaLongitude(region.center[0])],zoom).add([(padding.right-padding.left)/2,(padding.bottom-padding.top)/2]);
  fullView.current=false;map.setView(map.unproject(pixel,zoom),zoom,{animate});
 },[region?.id,loaded]);
 useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage||!loaded)return;
  let stale=false;
  void import('leaflet').then(L=>{
   if(stale||map!==mapRef.current)return;points.current?.clearLayers();
   for(const item of visibleTrails){
    if(!item.center||!inRussiaCoverage(...item.center,coverage.area))continue;
    const marker=L.circleMarker([item.center[1],russiaLongitude(item.center[0])],{radius:5.5,color:'#fffefa',weight:2,fillColor:'#a47842',fillOpacity:1,opacity:1});
    const label=document.createElement('span');label.textContent=item.title;marker.bindTooltip(label,{direction:'top',offset:[0,-5]});marker.on('click',()=>callbacks.current.onTrail?.(item));points.current?.addLayer(marker);
   }
  });
  return()=>{stale=true;};
 },[visibleTrails,loaded]);
 useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage||!loaded)return;
  let stale=false;
  const draw=async()=>{
   const L=await import('leaflet');if(stale)return;
   if(selected.current){map.removeLayer(selected.current);selected.current=null;}
   if(!trail?.geometryUrl&&!trail?.geometry)return;
   const fetched=trail.geometry??await loadPublicJSON<any>(trail.geometryUrl!).then(value=>value?.data?.geometry||value);
   if(stale||map!==mapRef.current)return;
   const data=displayGeoJSON(fetched) as GeoJSON.GeoJsonObject;
   selected.current=L.geoJSON(data,{style:{color:'#244d3c',weight:4,opacity:.95,dashArray:'9 4'},interactive:false}).addTo(map);
   const inside=positions(data).filter(([lng,lat])=>inRussiaCoverage(lng,lat,coverage.area));
   if(!inside.length){setStatus('У этой линии нет точек внутри доступного покрытия России. Карточка остаётся доступной.');return;}
   const bounds=L.latLngBounds(inside.map(([lng,lat])=>L.latLng(lat,lng))),element=container.current;if(!element)return;
   const {padding}=russiaView(element,256);fullView.current=false;
   map.fitBounds(bounds,{paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom:14,animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches});
  };
  void draw().catch(()=>{if(!stale)setStatus('Геометрия не загрузилась. Проверьте подключение.');});
  return()=>{stale=true;};
 },[trail?.id,trail?.geometryUrl,loaded]);
 async function changeMode(next:'overview'|'detail'){
  setStatus('');
  if(next==='overview'){wantsDetail.current=false;++detailRequest.current;setTilesLoading(false);if(baseRef.current&&mapRef.current)mapRef.current.removeLayer(baseRef.current);baseRef.current=null;setMode(next);reliefRef.current?.setOverview(true);}
  else try{wantsDetail.current=true;if(await addDetail(showPaths))setMode(next);}catch(error){setStatus(error instanceof Error?error.message:'Карта недоступна.');}
 }
 function locate(){
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
  <div className="map-context"><span className="live-dot"/><span>{region?.name||'Россия'}</span><span className="context-divider"/><span>{mode==='detail'?'Тропы и местность':'Обзор'}</span></div>
  {tilesLoading&&!scene&&!status&&<div className="map-preload-status" role="status">Подгружаем детали текущего ракурса</div>}
  <div className="map-style-switch"><button aria-label="Карта сверху" className={!scene?'active':''} onClick={()=>setScene(false)}><MapIcon name="map" size={18}/>Карта</button>{sceneAvailable&&<button aria-label="3D ландшафт Бзерпинского района" className={scene?'active':''} onClick={()=>setScene(true)} onPointerEnter={()=>void preloadTerrain()} title="Объёмная сцена Бзерпинского района"><MapIcon name="terrain" size={19}/>3D</button>}</div>
  <div className="map-controls"><button aria-label="Увеличить масштаб" disabled={!loaded} onClick={()=>mapRef.current?.zoomIn()}><MapIcon name="plus" size={20}/></button><button aria-label="Уменьшить масштаб" disabled={!loaded} onClick={()=>mapRef.current?.zoomOut()}><MapIcon name="minus" size={20}/></button><span/><button aria-label="Север сверху" title="На плоской карте север всегда сверху" disabled><MapIcon name="compass" size={22}/></button><button aria-label="Моё местоположение" disabled={!loaded} onClick={locate}><MapIcon name="location" size={21}/></button><button aria-label="Показать Россию целиком" disabled={!loaded} onClick={()=>{setScene(false);fitRussia(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);}}><MapIcon name="fit" size={19}/></button></div>
  <div className="layer-control"><button className={layers?'layer-button active':'layer-button'} aria-expanded={layers} onClick={()=>setLayers(!layers)}><MapIcon name="layers" size={20}/>Слои</button>{layers&&<div className="layer-menu"><strong>Ваша карта</strong><button disabled={offline||!loaded} onClick={()=>changeMode('detail')}>Детальные тропы онлайн{mode==='detail'&&<Check size={17}/>}</button><button disabled={!loaded} onClick={()=>changeMode('overview')}>Сохранённый обзор{mode==='overview'&&<Check size={17}/>}</button><label><input type="checkbox" checked={showPaths} onChange={event=>{setShowPaths(event.target.checked);if(mode==='detail')void addDetail(event.target.checked).catch(()=>setStatus('Не удалось обновить слой.'));}}/>Тропы и грунтовые дороги</label><a href="/offline">Подробная офлайн-карта</a><span className="source-note">Плоский режим · без объёмного рельефа</span><a href="/sources">Источники карты</a></div>}</div>
  {status&&<div className="map-message" role="status"><MapIcon name="info" size={18}/><span>{status}</span><button onClick={()=>setStatus('')}>Понятно</button></div>}
  <div className="map-legend"><span className="legend-line"/>Тропа<span className="legend-region"/>Направление<span className="legend-hint">{region?'Нажмите на маршрут':'Выберите регион, чтобы приблизить'}</span></div>
  {sceneAvailable&&<TerrainScene trail={trail} visible={scene} onClose={()=>setScene(false)}/>}
  {!scene&&<MapAttribution ready={loaded} terrain={reliefReady}/>}
 </div>;
}
