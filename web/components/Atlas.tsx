'use client';
import {MapIcon} from './MapIcon';
import {MapAttribution} from './MapAttribution';
import {TerrainScene} from './TerrainScene';
import {Atlas2D} from './Atlas2D';
import {useEffect,useRef,useState} from 'react';
import type {Map as MapInstance,Marker,StyleSpecification,GeoJSONSource} from 'maplibre-gl';
import {WifiSlash,Check} from '@/components/TropnikIcons';
import {regions,type Region,type Trail} from '@/lib/content';
import {warmMap,supportsMapWebGL,preloadTerrain,hasTerrainPreview,loadPublicJSON,mapRequest} from '@/lib/map-preload';
import {loadRussiaGeometry,russiaView} from '@/lib/russia-map';
import {constrainRussiaCamera,displayGeoJSON,inRussiaCoverage,russiaLongitude,MAP_OUTSIDE_COLOR,type RussiaCamera} from '@/public/maps/russia-viewport.js';
import 'maplibre-gl/dist/maplibre-gl.css';

type Coverage=Awaited<ReturnType<typeof loadRussiaGeometry>>;
const EMPTY:GeoJSON.FeatureCollection={type:'FeatureCollection',features:[]};
const MASK='russia-outside-mask';
function overviewStyle(coverage:Coverage):StyleSpecification {
 return {version:8,name:'Тропник · Россия',sources:{
  land:{type:'geojson',data:coverage.area},regions:{type:'geojson',data:'/data/regions.geojson'},
  'russia-relief':{type:'raster',tiles:['/maps/russia-relief/{z}/{x}/{y}.png'],tileSize:256,minzoom:0,maxzoom:4},
  'russia-mask':{type:'geojson',data:coverage.mask},
 },layers:[
  {id:'background',type:'background',paint:{'background-color':MAP_OUTSIDE_COLOR}},
  {id:'land',type:'fill',source:'land',paint:{'fill-color':'#DBE4CD','fill-outline-color':'#9EAF95'}},
  {id:'overview-relief',type:'raster',source:'russia-relief',maxzoom:6,paint:{'raster-opacity':['interpolate',['linear'],['zoom'],0,1,4,1,6,0],'raster-fade-duration':200}},
  {id:'region-fill',type:'fill',source:'regions',paint:{'fill-color':'#D7E1CB','fill-opacity':.25}},
  {id:'region-boundary',type:'line',source:'regions',paint:{'line-color':'#7E9279','line-width':.8,'line-opacity':.38}},
  {id:'region-selected',type:'fill',source:'regions',filter:['==',['get','shapeName'],'__none'],paint:{'fill-color':'#9BB58E','fill-opacity':.45}},
  {id:MASK,type:'fill',source:'russia-mask',paint:{'fill-color':MAP_OUTSIDE_COLOR,'fill-antialias':false}},
 ]};
}
function detailStyle(style:StyleSpecification,coverage:Coverage):StyleSpecification {
 const next=structuredClone(style);
 next.sources['overview-land']={type:'geojson',data:coverage.area};
 next.sources['russia-mask']={type:'geojson',data:coverage.mask};
 if(!next.layers.some(layer=>layer.id===MASK))next.layers.push({id:MASK,type:'fill',source:'russia-mask',paint:{'fill-color':MAP_OUTSIDE_COLOR,'fill-antialias':false}});
 return next;
}
export type AtlasProps={region?:Region;trail?:Trail;visibleTrails?:Trail[];onTrail?:(trail:Trail)=>void;onRegion:(region:Region)=>void;onMapNote?:(text:string)=>void;onViewportRegion?:(regionId:string|undefined)=>void};
export function Atlas({region,trail,visibleTrails=[],onTrail,onRegion,onMapNote,onViewportRegion}:AtlasProps){
 const container=useRef<HTMLDivElement>(null),mapRef=useRef<MapInstance|null>(null),markers=useRef<Marker[]>([]),positionMarker=useRef<Marker|null>(null);
 const onRegionRef=useRef(onRegion),onNoteRef=useRef(onMapNote),regionRef=useRef(region),trailRef=useRef(trail),viewportRef=useRef(onViewportRegion);
 const coverageRef=useRef<Coverage|null>(null),detailRef=useRef<StyleSpecification|null>(null),fullView=useRef(!region),cameraFloor=useRef<RussiaCamera>({center:[105,62],zoom:0});
 const [fallback,setFallback]=useState(false),[scene,setScene]=useState(false);
 const [loaded,setLoaded]=useState(false),[painted,setPainted]=useState(false),[tilesLoading,setTilesLoading]=useState(false),[offline,setOffline]=useState(false);
 const [baseMode,setBaseMode]=useState<'detail'|'overview'>('detail'),[terrain,setTerrain]=useState(false),[layersOpen,setLayersOpen]=useState(false),[status,setStatus]=useState('');
 const [pathLayer,setPathLayer]=useState(true),[boundaryLayer,setBoundaryLayer]=useState(true),[mapZoom,setMapZoom]=useState(2),[styleRevision,setStyleRevision]=useState(0);
 const sceneAvailable=hasTerrainPreview(trail,region?.id);
 onRegionRef.current=onRegion;onNoteRef.current=onMapNote;regionRef.current=region;trailRef.current=trail;viewportRef.current=onViewportRegion;
 useEffect(()=>{setScene(false);if(sceneAvailable)void preloadTerrain();},[region?.id,trail?.id,sceneAvailable]);
 function fitRussia(duration=0){
  const map=mapRef.current,element=container.current;if(!map||!element)return;
  const {camera}=russiaView(element);cameraFloor.current=camera;fullView.current=true;
  map.setMinZoom(Math.max(-2,camera.zoom));map.setTerrain(null);map.easeTo({...camera,padding:{top:0,right:0,bottom:0,left:0},duration});
  setTerrain(false);
 }
 useEffect(()=>{
  let cancelled=false,geographyPainted=false,overviewFallback=false,tileStatus:ReturnType<typeof setTimeout>|undefined,resize:ResizeObserver|undefined;
  const disconnect=()=>{
   setOffline(!navigator.onLine);
   if(!navigator.onLine&&coverageRef.current){setBaseMode('overview');setTerrain(false);setPainted(false);setStatus('Нет сети. Доступна сохранённая обзорная карта.');mapRef.current?.setStyle(overviewStyle(coverageRef.current));}
  };
  setOffline(!navigator.onLine);setBaseMode(navigator.onLine?'detail':'overview');window.addEventListener('online',disconnect);window.addEventListener('offline',disconnect);
  (async()=>{
   try{
    if(!supportsMapWebGL()){setFallback(true);return;}
    const [ml,coverage]=await Promise.all([import('maplibre-gl'),loadRussiaGeometry(true)]);
    if(cancelled||!container.current)return;
    coverageRef.current=coverage;await warmMap();if(cancelled||!container.current)return;
    const live=navigator.onLine?await loadPublicJSON<StyleSpecification>('/maps/tropa-style.json').catch(()=>null):null;
    if(cancelled||!container.current)return;
    detailRef.current=live?detailStyle(live,coverage):null;
    if(!live)setBaseMode('overview');
    const initial=russiaView(container.current).camera;cameraFloor.current=initial;
    const map=new ml.Map({container:container.current,transformRequest:mapRequest,style:detailRef.current||overviewStyle(coverage),...initial,
     minZoom:Math.max(-2,initial.zoom),maxZoom:18,attributionControl:false,renderWorldCopies:true,
     transformConstrain:(point,zoom)=>{const next=constrainRussiaCamera(point.lng,point.lat,zoom,cameraFloor.current);return{center:new ml.LngLat(...next.center),zoom:next.zoom};},
     dragRotate:true,touchPitch:true,pitchWithRotate:true,maxPitch:75,fadeDuration:160,pixelRatio:Math.min(devicePixelRatio,2),maxTileCacheZoomLevels:4,
     canvasContextAttributes:{antialias:true,preserveDrawingBuffer:false,powerPreference:'high-performance'}});
    mapRef.current=map;
    map.on('dataloading',()=>{if(tileStatus===undefined)tileStatus=setTimeout(()=>{if(!cancelled)setTilesLoading(true);},300);});
    map.on('idle',()=>{clearTimeout(tileStatus);tileStatus=undefined;if(!cancelled)setTilesLoading(false);});
    map.on('render',()=>{
     if(cancelled||geographyPainted)return;
     const land=map.getLayer('overview-land')?'overview-land':map.getLayer('land')?'land':null;
     if(land&&map.isSourceLoaded(land)&&map.getSource('russia-mask')&&map.isSourceLoaded('russia-mask')&&map.queryRenderedFeatures({layers:[land]}).length){geographyPainted=true;setPainted(true);}
    });
    map.addControl(new ml.ScaleControl({maxWidth:100,unit:'metric'}),'bottom-left');
    for(const r of regions){
     if(!inRussiaCoverage(...r.center,coverage.area))continue;
     const el=document.createElement('button');el.className='region-marker region-marker-'+r.id;el.setAttribute('aria-label',`Открыть ${r.name}`);
     const dot=document.createElement('span');dot.className='region-marker-dot';const label=document.createElement('span');label.className='region-marker-label';label.textContent=r.name;el.appendChild(dot);el.appendChild(label);
     el.addEventListener('click',e=>{e.stopPropagation();onRegionRef.current(r);});markers.current.push(new ml.Marker({element:el,anchor:'bottom'}).setLngLat(r.center).addTo(map));
    }
    if(regionRef.current)map.jumpTo({center:regionRef.current.center,zoom:regionRef.current.zoom});
    map.on('zoomend',()=>setMapZoom(map.getZoom()));
    map.on('pitch',()=>{if(map.getLayer('terrain-shading'))map.setPaintProperty('terrain-shading','hillshade-exaggeration',.42+map.getPitch()/250);});
    map.on('moveend',()=>{
     const c=map.getCenter();const boxes:Record<string,number[]>={altai:[82,48,91,53],krasnodar:[36,42.5,42,46.8],karelia:[29,60.7,37,67.2],krym:[32,44,37,46],baikal:[103,50,113,56.8],kamchatka:[155,50,166,61]};
     const found=map.getZoom()>=4?Object.entries(boxes).find(([,b])=>c.lng>=b[0]&&c.lng<=b[2]&&c.lat>=b[1]&&c.lat<=b[3]):undefined;viewportRef.current?.(found?.[0]);
    });
    map.on('dragstart',()=>{fullView.current=false;});map.on('zoomstart',event=>{if(event.originalEvent)fullView.current=false;});
    map.on('style.load',()=>{
     if(cancelled)return;geographyPainted=false;setPainted(false);setLoaded(true);setStyleRevision(v=>v+1);
     if(map.getSource('openmaptiles'))overviewFallback=false;
     setStatus(overviewFallback?'Детальная карта недоступна. Показан сохранённый обзор.':'');
     if(map.getSource('terrain-dem')){map.setSourceTileLodParams(4,2,'terrain-dem');map.setSourceTileLodParams(3,2,'hillshade-dem');map.setSourceTileLodParams(3,2,'openmaptiles');}
     if(!map.getSource('regions'))map.addSource('regions',{type:'geojson',data:'/data/regions.geojson'});
     if(!map.getLayer('region-fill'))map.addLayer({id:'region-fill',type:'fill',source:'regions',paint:{'fill-color':'#A2BC8E','fill-opacity':['interpolate',['linear'],['zoom'],2,.12,7,0]}},MASK);
     if(!map.getLayer('region-boundary'))map.addLayer({id:'region-boundary',type:'line',source:'regions',maxzoom:8,paint:{'line-color':'#758E70','line-width':.8,'line-opacity':.42}},MASK);
     if(!map.getLayer('region-selected'))map.addLayer({id:'region-selected',type:'fill',source:'regions',filter:['==',['get','shapeName'],'__none'],paint:{'fill-color':'#91AE80','fill-opacity':['interpolate',['linear'],['zoom'],2,.35,8,0]}},MASK);
     const current=regionRef.current;if(current)map.setFilter('region-selected',['in',['get','shapeName'],['literal',current.shapeNames]]);
    });
    map.on('mouseenter','region-fill',()=>{if(map.getZoom()<7)map.getCanvas().style.cursor='pointer';});
    map.on('mouseleave','region-fill',()=>{map.getCanvas().style.cursor='';});
    map.on('click','region-fill',event=>{
     if(map.getZoom()>7||!inRussiaCoverage(event.lngLat.lng,event.lngLat.lat,coverage.area))return;
     const name=event.features?.[0]?.properties?.shapeName;const r=regions.find(item=>item.shapeNames.includes(name));
     if(r)onRegionRef.current(r);else if(name)onNoteRef.current?.('Для этой территории каталог ещё не опубликован. Выберите одно из направлений в списке.');
    });
    map.on('webglcontextlost',()=>setStatus('Графический контекст карты прерван. Восстанавливаем отображение.'));
    map.on('webglcontextrestored',()=>setStatus(''));
    map.on('error',event=>{
     if(cancelled)return;const sourceId=(event as typeof event&{sourceId?:string}).sourceId;
     if(!map.getStyle()&&!overviewFallback){overviewFallback=true;setBaseMode('overview');setTerrain(false);setLoaded(false);setPainted(false);map.setStyle(overviewStyle(coverage));setStatus('Детальная карта недоступна. Открываем сохранённый обзор.');}
     else if(['overview-land','land','regions','russia-mask'].includes(sourceId||''))setStatus('Не удалось загрузить географию России. Обновите страницу.');
     else setStatus('Часть деталей карты не загрузилась. Можно перейти к сохранённому обзору.');
    });
    resize=new ResizeObserver(()=>{
     if(cancelled||!container.current)return;
     map.resize();cameraFloor.current=russiaView(container.current).camera;map.setMinZoom(Math.max(-2,cameraFloor.current.zoom));
     if(fullView.current)map.jumpTo({...cameraFloor.current,padding:{top:0,right:0,bottom:0,left:0}});
    });
    resize.observe(container.current);const panel=container.current.closest('.explore-layout')?.querySelector('.explore-panel');if(panel)resize.observe(panel);
   }catch(error){
    if(cancelled)return;console.error('Map initialization failed',error);markers.current.forEach(marker=>marker.remove());markers.current=[];mapRef.current?.remove();mapRef.current=null;setFallback(true);
   }
  })();
  return()=>{cancelled=true;clearTimeout(tileStatus);resize?.disconnect();markers.current.forEach(marker=>marker.remove());markers.current=[];positionMarker.current?.remove();mapRef.current?.remove();mapRef.current=null;window.removeEventListener('online',disconnect);window.removeEventListener('offline',disconnect);};
 },[]);
 useEffect(()=>{
  const map=mapRef.current;if(!map||!loaded)return;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(region){
   fullView.current=false;if(map.getSource('terrain-dem'))map.setTerrain({source:'terrain-dem',exaggeration:1});
   map.flyTo({center:region.center,zoom:region.zoom,pitch:region.id==='karelia'?22:42,offset:window.innerWidth<=700?[0,-Math.round(container.current!.clientHeight*.23)]:[0,0],duration:reduced?0:1100,essential:false});
   if(map.getLayer('region-selected'))map.setFilter('region-selected',['in',['get','shapeName'],['literal',region.shapeNames]]);
   setTerrain(!!map.getSource('terrain-dem'));
  }else{fitRussia(0);if(map.getLayer('region-selected'))map.setFilter('region-selected',['==',['get','shapeName'],'__none']);}
 },[region?.id,loaded]);
 useEffect(()=>{
  const map=mapRef.current;if(!map||!loaded)return;let cancelled=false;
  async function draw(){
   if(!map)return;
   const raw:any=trail?.geometry??(trail?.geometryUrl?await loadPublicJSON<any>(trail.geometryUrl).then(value=>value?.data?.geometry||value):EMPTY);
   const data=displayGeoJSON(raw);if(cancelled||!map.getStyle())return;
   if(map.getSource('selected-trail'))(map.getSource('selected-trail')as GeoJSONSource).setData(data);
   else{map.addSource('selected-trail',{type:'geojson',data});
    map.addLayer({id:'trail-casing',type:'line',source:'selected-trail',paint:{'line-color':'#FFFEFA','line-width':8,'line-opacity':.96},layout:{'line-join':'round','line-cap':'round'}},MASK);
    map.addLayer({id:'trail-line',type:'line',source:'selected-trail',paint:{'line-color':'#244D3C','line-width':4,'line-dasharray':[3,1]},layout:{'line-join':'round','line-cap':'round'}},MASK);
   }
   if(trail?.geometryUrl||trail?.geometry){
    const coordinates:number[][]=[];const walk=(value:unknown)=>{if(Array.isArray(value)){if(typeof value[0]==='number'&&typeof value[1]==='number')coordinates.push(value as number[]);else value.forEach(walk);}};
    if(data.type==='FeatureCollection')data.features.forEach((feature:{geometry:{coordinates:unknown}})=>walk(feature.geometry.coordinates));else if(data.type==='Feature')walk(data.geometry.coordinates);else walk(data.coordinates);
    if(coordinates.length){
     fullView.current=false;if(map.getSource('terrain-dem')){map.setTerrain({source:'terrain-dem',exaggeration:1});setTerrain(true);}
     const lng=coordinates.map(point=>point[0]),lat=coordinates.map(point=>point[1]);
     const padding=container.current?russiaView(container.current).padding:80;
     map.fitBounds([[Math.min(...lng),Math.min(...lat)],[Math.max(...lng),Math.max(...lat)]],{padding,maxZoom:14,pitch:55,bearing:-20,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:900});
    }
   }
  }
  draw().catch(()=>setStatus('Геометрия маршрута не загрузилась. Попробуйте ещё раз при устойчивой связи.'));return()=>{cancelled=true;};
 },[trail?.id,trail?.geometryUrl,loaded,styleRevision]);
 useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!loaded||!coverage)return;
  let removed=false;const routeMarkers:Marker[]=[];
  import('maplibre-gl').then(ml=>{if(removed)return;for(const t of visibleTrails){
   if(!t.center||!inRussiaCoverage(...t.center,coverage.area))continue;
   const button=document.createElement('button');button.className='trail-marker';button.setAttribute('aria-label',`Открыть маршрут ${t.title}`);button.title=t.title;
   button.addEventListener('click',event=>{event.stopPropagation();onTrail?.(t);});routeMarkers.push(new ml.Marker({element:button}).setLngLat([russiaLongitude(t.center[0]),t.center[1]]).addTo(map));
  }});
  return()=>{removed=true;routeMarkers.forEach(marker=>marker.remove());};
 },[visibleTrails,loaded,onTrail]);
 async function changeBase(mode:'detail'|'overview'){
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage)return;
  let next:StyleSpecification;
  try{next=mode==='overview'?overviewStyle(coverage):detailRef.current||detailStyle(await loadPublicJSON<StyleSpecification>('/maps/tropa-style.json'),coverage);}
  catch{setStatus('Детальная карта не загрузилась. Обзор России остаётся доступен.');return;}
  if(mode==='detail')detailRef.current=next;
  setBaseMode(mode);setLoaded(false);setPainted(false);setTerrain(false);map.setTerrain(null);map.setPitch(0);map.setStyle(next);
  setStatus(mode==='overview'?'Обзорные границы. Для ориентирования по тропе нужен детальный пакет.':'');
 }
 function setTerrainMode(next:boolean){
  const map=mapRef.current;if(!map||!loaded||(next&&(baseMode==='overview'||offline)))return;
  if(next){if(!map.getSource('terrain-dem'))map.addSource('terrain-dem',{type:'raster-dem',url:'https://tiles.mapterhorn.com/tilejson.json'});map.setTerrain({source:'terrain-dem',exaggeration:1});map.easeTo({pitch:55,duration:650});}
  else{map.setTerrain(null);map.easeTo({pitch:0,bearing:0,duration:500});}setTerrain(next);
 }
 function locate(){
  if(!navigator.geolocation){setStatus('Этот браузер не поддерживает геолокацию.');return;}
  setStatus('Определяем местоположение…');
  navigator.geolocation.getCurrentPosition(async position=>{
   const map=mapRef.current,coverage=coverageRef.current;if(!map||!coverage)return;
   const {longitude,latitude,accuracy}=position.coords;
   if(!inRussiaCoverage(longitude,latitude,coverage.area)){setStatus('Местоположение находится за пределами доступной карты России. Выберите направление на карте.');return;}
   const ml=await import('maplibre-gl');if(map!==mapRef.current)return;
   fullView.current=false;positionMarker.current?.remove();const center:[number,number]=[russiaLongitude(longitude),latitude];
   positionMarker.current=new ml.Marker({color:'#316B8B'}).setLngLat(center).addTo(map);map.flyTo({center,zoom:13});
   setStatus(`Точность позиции: около ${Math.round(accuracy)} м. Местоположение никому не передаётся.`);
  },()=>setStatus('Позиция недоступна. Проверьте разрешение на геолокацию и наличие сигнала.'),{enableHighAccuracy:true,timeout:15000,maximumAge:10000});
 }
 if(fallback)return <Atlas2D region={region} trail={trail} visibleTrails={visibleTrails} onTrail={onTrail} onRegion={onRegion} onMapNote={onMapNote} onViewportRegion={onViewportRegion}/>;
 return <div className={`atlas-wrap ${scene?'showing-terrain':''}`}>
  <div ref={container} className="atlas-canvas" style={{visibility:painted?'visible':'hidden'}} role="region" aria-label="Интерактивная карта направлений России"/>
  {(!loaded||!painted)&&!status&&<div className="map-skeleton"><MapIcon name="compass" size={38}/><span>Открываем карту России</span></div>}
  <div className="map-context"><span className="live-dot"/><span>{region?region.name:'Россия'}</span><span className="context-divider"/><span>{baseMode==='detail'?'Тропы и местность':'Обзорная карта'}</span></div>
  {loaded&&tilesLoading&&!scene&&!status&&<div className="map-preload-status" role="status">Подгружаем детали текущего ракурса</div>}
  <div className="map-style-switch"><button aria-label="Карта сверху" className={!terrain&&!scene?'active':''} onClick={()=>{setScene(false);setTerrainMode(false);}}><MapIcon name="map" size={18}/>Карта</button><button aria-label="Рельеф всей карты" className={terrain&&!scene?'active':''} onClick={()=>{setScene(false);setTerrainMode(true);}} disabled={offline||baseMode==='overview'} title="Объёмный рельеф на основе данных высот"><MapIcon name="terrain" size={19}/>Рельеф</button>{sceneAvailable&&<button aria-label="3D ландшафт Бзерпинского района" className={scene?'active':''} onPointerEnter={()=>void preloadTerrain()} onFocus={()=>void preloadTerrain()} onClick={()=>setScene(true)}><MapIcon name="peak" size={19}/>3D</button>}</div>
  <div className="map-controls"><button aria-label="Увеличить масштаб" onClick={()=>mapRef.current?.zoomIn()}><MapIcon name="plus" size={20}/></button><button aria-label="Уменьшить масштаб" onClick={()=>mapRef.current?.zoomOut()}><MapIcon name="minus" size={20}/></button><span/><button aria-label="Север сверху" onClick={()=>setTerrainMode(false)}><MapIcon name="compass" size={22}/></button><button aria-label="Моё местоположение" onClick={locate}><MapIcon name="location" size={21}/></button><button aria-label="Показать Россию целиком" onClick={()=>{setScene(false);fitRussia(window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:700);}}><MapIcon name="fit" size={19}/></button></div>
  <div className="layer-control"><button className={layersOpen?'layer-button active':'layer-button'} aria-expanded={layersOpen} onClick={()=>setLayersOpen(!layersOpen)}><MapIcon name="layers" size={20}/>Слои</button>{layersOpen&&<div className="layer-menu"><strong>Ваша карта</strong><button onClick={()=>void changeBase('detail')} disabled={offline}><span>Детальные тропы онлайн</span>{baseMode==='detail'&&<Check size={18}/>}</button><button onClick={()=>void changeBase('overview')}><span>Сохранённый обзор</span>{baseMode==='overview'&&<Check size={18}/>}</button><label><input type="checkbox" checked={pathLayer} onChange={event=>{setPathLayer(event.target.checked);const map=mapRef.current;['paths','tracks'].forEach(id=>{if(map?.getLayer(id))map.setLayoutProperty(id,'visibility',event.target.checked?'visible':'none');});}}/>Тропы и грунтовые дороги</label><label><input type="checkbox" checked={boundaryLayer} onChange={event=>{setBoundaryLayer(event.target.checked);const map=mapRef.current;if(map?.getLayer('region-boundary'))map.setLayoutProperty('region-boundary','visibility',event.target.checked?'visible':'none');}}/>Границы регионов</label><a href="/sources">Данные и лицензии</a></div>}</div>
  {status&&<div className="map-message" role="status">{offline?<WifiSlash size={18}/>:<MapIcon name="info" size={18}/>}<span>{status}</span>{baseMode==='detail'&&<button onClick={()=>void changeBase('overview')}>Обзор</button>}</div>}
  <div className="map-legend"><span className="legend-line"/>Тропа на карте<span className="legend-region"/>Направление<span className="legend-hint">{mapZoom<6?'Выберите регион, чтобы приблизить':'Условия и доступ проверяйте в карточке'}</span></div>
  {sceneAvailable&&<TerrainScene trail={trail} visible={scene} onClose={()=>setScene(false)}/>}
  <MapAttribution ready={painted} terrain={terrain||(baseMode==='detail'&&mapZoom>=5)}/>
 </div>;
}
