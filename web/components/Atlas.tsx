'use client';
import {MapIcon} from './MapIcon';
import {MapRouteContext} from './MapRouteContext';
import {MapAttribution} from './MapAttribution';
import {TerrainScene} from './TerrainScene';
import {Atlas2D} from './Atlas2D';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {Map as MapInstance,Marker,StyleSpecification,GeoJSONSource} from 'maplibre-gl';
import {WifiSlash,Check} from '@/components/TropnikIcons';
import {regions,routeCountLabel,type Region} from '@/lib/content';
import {mapDirectionCounts} from '@/lib/map-catalog';
import {groupMapDirections,updateDirectionButtons,reconcileDirectionAnchors,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';
import {createDirectionMarker} from '@/lib/map-direction-marker';
import {bindMapDirectionButton} from '@/lib/map-direction-interaction';
import {territoryForMapPoint,type MapRegion} from '@/lib/territories';
import {warmMap,supportsMapWebGL,preferCanvasMap,preloadTerrain,preloadTrail,hasTerrainPreview,loadPublicJSON,mapRequest} from '@/lib/map-preload';
import {loadRussiaGeometry,russiaView} from '@/lib/russia-map';
import {MapStyleSession,MapSelectionCamera,loadMapSelection,applyMapLayerVisibility,type MapBaseMode} from '@/lib/map-lifecycle';
import {MapSourceLoading,retryMapSourceMetadata,type MapSourceFailure,type MapSourceSignal} from '@/lib/map-source-loading';
import {constrainFramedCamera,MapFrameRefit,bindMapFrameRefit} from '@/lib/map-framing';
import {terrainExaggerationForZoom,terrainPitchForZoom} from '@/lib/map-camera-profile';
import {mapTrailPointFeatureCollection} from '@/lib/map-trail-points';
import {ROUTE_PRESENTATION,OVERVIEW_MESSAGE,overviewContextCaption,routeLineEdges,createRouteEdgeElement,syncRouteEdgeAnnotations,type RouteEdgeAnnotation} from '@/lib/map-route-presentation';
import {EMPTY_MAP_TRAILS,type AtlasProps} from '@/lib/map-types';
import {MAP_CONFIG,viewportRegionId,directionExpansionZoom} from '@/lib/map-config';
import {coalesceMapFrame,publishMapCamera,resolveRenderedTrail} from '@/lib/map-interaction';
import {MapZoomButtons,MAP_ZOOM_BUTTONS,bindZoomButtonCancellation} from '@/lib/map-zoom-buttons';
import {MapTerrainPitch} from '@/lib/map-terrain-pitch';
import {readRouteGeometry,routeGeometryPositions,identifyRouteGeometry,RENDERED_TRAIL_ID} from '@/lib/route-geometry';
import {satelliteStyle,SATELLITE_SOURCE,SATELLITE_ERROR} from '@/lib/map-satellite';
import {displayGeoJSON,inRussiaCoverage,coveredRussiaBounds,russiaLongitude,MAP_OUTSIDE_COLOR,type RussiaCamera} from '@/public/maps/russia-viewport.js';
import 'maplibre-gl/dist/maplibre-gl.css';

type Coverage=Awaited<ReturnType<typeof loadRussiaGeometry>>;
const EMPTY:GeoJSON.FeatureCollection={type:'FeatureCollection',features:[]};
const MASK='russia-outside-mask';
const OFFLINE_MESSAGE='Нет сети. Доступна сохранённая обзорная карта.';
const DETAIL_ERROR='Детальная карта не загрузилась. Обзор остаётся доступен.';
const TERRAIN_ERROR='Рельеф не загрузился. Карта и маршруты доступны.';
const ROUTE_ERROR='Линия маршрута не загрузилась. Попробуйте ещё раз при устойчивой связи.';
const ROUTE_COVERAGE_MESSAGE='У этой линии нет точек внутри доступного покрытия России. Карточка остаётся доступной.';
const TRAIL_POINTS='trail-points',TRAIL_POINT_HALO='trail-point-halo',TRAIL_POINT_DOT='trail-point-dot',TRAIL_POINT_HIT='trail-point-hit';
function overviewStyle(coverage:Coverage):StyleSpecification {
 return {version:8,name:'Тропник · Россия',sources:{
  land:{type:'geojson',data:coverage.area},regions:{type:'geojson',data:'/data/territories.geojson'},
  'russia-relief':{type:'raster',tiles:['/maps/russia-relief/{z}/{x}/{y}.png'],tileSize:256,minzoom:0,maxzoom:4},
  'russia-mask':{type:'geojson',data:coverage.mask},
 },layers:[
  {id:'background',type:'background',paint:{'background-color':MAP_OUTSIDE_COLOR}},
  {id:'land',type:'fill',source:'land',paint:{'fill-color':'#DDE6D5','fill-outline-color':'#A7B69D'}},
  {id:'overview-relief',type:'raster',source:'russia-relief',maxzoom:6,paint:{'raster-opacity':['interpolate',['linear'],['zoom'],0,.92,4,.88,6,0],'raster-contrast':.28,'raster-saturation':-.18,'raster-brightness-min':.08,'raster-brightness-max':.92,'raster-fade-duration':0}},
  {id:'region-fill',type:'fill',source:'regions',paint:{'fill-color':'#D7E0D0','fill-opacity':.18}},
  {id:'region-boundary',type:'line',source:'regions',paint:{'line-color':'#748675','line-width':.7,'line-opacity':.32}},
  {id:'region-selected',type:'fill',source:'regions',filter:['==',['get','shapeName'],'__none'],paint:{'fill-color':'#91AC82','fill-opacity':.34}},
  {id:'region-selected-outline',type:'line',source:'regions',filter:['==',['get','shapeName'],'__none'],paint:{'line-color':'#315B45','line-width':['interpolate',['linear'],['zoom'],5,1.6,11,1],'line-opacity':['interpolate',['linear'],['zoom'],5,.86,11,.2]}},
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
function highlightRegion(map:MapInstance,region?:MapRegion){
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
  'circle-radius':MAP_CONFIG.trailHitRadiusPx,'circle-color':'#000000','circle-opacity':.001,'circle-stroke-opacity':0,
  'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport',
 }});
}
function fitTerritory(map:MapInstance,region:MapRegion,element:HTMLElement,duration:number,frame:{current:RussiaCamera|null}){
 const b=region.bounds;if(!b)return false;
 const bounds:[[number,number],[number,number]]=[[b[0],b[1]],[b[2],b[3]]],padding=russiaView(element).padding;
 const camera=map.cameraForBounds(bounds,{padding,maxZoom:MAP_CONFIG.territoryMaxZoom,pitch:0,bearing:0}),center=camera?.center;
 if(center&&camera?.zoom!==undefined){
  const point=Array.isArray(center)?center:'lng' in center?[center.lng,center.lat]:[center.lon,center.lat];
  frame.current={center:[point[0],point[1]],zoom:camera.zoom};
 }
 map.fitBounds(bounds,{padding,maxZoom:MAP_CONFIG.territoryMaxZoom,pitch:0,bearing:0,duration,essential:false});
 return true;
}
export function Atlas({region,trail,visibleTrails=EMPTY_MAP_TRAILS,onTrail,onRegion,onMapNote,onViewportRegion,planning=false,planPoints}:AtlasProps){
 const container=useRef<HTMLDivElement>(null),mapRef=useRef<MapInstance|null>(null),markers=useRef<Marker[]>([]),positionMarker=useRef<Marker|null>(null);
 const routeEdges=useRef<Marker[]>([]),markerConstructor=useRef<typeof import('maplibre-gl').Marker|null>(null);
 const routeAnnotations=useRef<RouteEdgeAnnotation[]>([]);
 const directionGroups=useRef(new Map<string,MapDirectionGroup<Region>>()),updateDirections=useRef<(()=>void)|null>(null),visibleTrailsRef=useRef(visibleTrails);
 const onRegionRef=useRef(onRegion),onTrailRef=useRef(onTrail),regionRef=useRef(region),trailRef=useRef(trail),viewportRef=useRef(onViewportRegion);
 const displayedTrail=useRef<AtlasProps['trail']>(undefined);
 const coverageRef=useRef<Coverage|null>(null),detailRef=useRef<StyleSpecification|null>(null),fullView=useRef(!region),cameraFloor=useRef<RussiaCamera>({center:[105,62],zoom:0});
 const framedCamera=useRef<RussiaCamera|null>(null),terrainRef=useRef(false);
 const frameRefit=useRef<MapFrameRefit|null>(null),zoomButtons=useRef<MapZoomButtons|null>(null),terrainPitchControl=useRef<MapTerrainPitch|null>(null);
 const locationRevision=useRef(0);
 const styleSession=useRef<MapStyleSession<StyleSpecification>|null>(null),basePreference=useRef<MapBaseMode>('detail'),styleGeneration=useRef(0);
 const sourceLoading=useRef<MapSourceLoading|null>(null),selectionCamera=useRef(new MapSelectionCamera());
 const layerVisibility=useRef({paths:true,boundaries:true});
 const [fallback,setFallback]=useState(false),[scene,setScene]=useState(false);
 const [loaded,setLoaded]=useState(false),[painted,setPainted]=useState(false),[tilesLoading,setTilesLoading]=useState(false),[offline,setOffline]=useState(false);
 const [baseMode,setBaseMode]=useState<MapBaseMode>('detail'),[terrain,setTerrain]=useState(false),[layersOpen,setLayersOpen]=useState(false),[status,setStatus]=useState('');
 const [sourceFailures,setSourceFailures]=useState<MapSourceFailure[]>([]),[styleUnavailable,setStyleUnavailable]=useState(false),[styleRetrying,setStyleRetrying]=useState(false);
 const [pathLayer,setPathLayer]=useState(true),[boundaryLayer,setBoundaryLayer]=useState(true),[mapZoom,setMapZoom]=useState(2),[styleRevision,setStyleRevision]=useState(0);
 const sceneAvailable=hasTerrainPreview(trail,region?.id);
 useLayoutEffect(()=>{
  onRegionRef.current=onRegion;onTrailRef.current=onTrail;regionRef.current=region;trailRef.current=trail;viewportRef.current=onViewportRegion;terrainRef.current=terrain;
  visibleTrailsRef.current=visibleTrails;
  layerVisibility.current={paths:pathLayer,boundaries:boundaryLayer};
 },[onRegion,onTrail,region,trail,onViewportRegion,terrain,visibleTrails,pathLayer,boundaryLayer]);
 useEffect(()=>{locationRevision.current++;zoomButtons.current?.cancel();},[region?.id,trail?.id,trail?.geometryUrl,trail?.geometry]);
 // A selected route owns the imperative 3D scene; close that scene when its owner changes.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{setScene(false);if(sceneAvailable)void preloadTerrain();},[region?.id,trail?.id,sceneAvailable]);
 function zoomBy(delta:number){
  locationRevision.current++;frameRefit.current?.cancel();fullView.current=false;
  setStatus(previous=>previous==='Определяем местоположение…'?'':previous);
  zoomButtons.current?.request(delta);
 }
 function fitRussia(duration=0){
  const map=mapRef.current,element=container.current;if(!map||!element)return;
  frameRefit.current?.cancel();zoomButtons.current?.cancel();terrainPitchControl.current?.reset();
  const {camera}=russiaView(element);cameraFloor.current=camera;framedCamera.current=null;fullView.current=true;
  map.setMinZoom(Math.max(-2,camera.zoom));if(map.getStyle())map.setTerrain(null);map.stop();map.easeTo({...camera,padding:{top:0,right:0,bottom:0,left:0},duration});
  terrainRef.current=false;setTerrain(false);
 }
 useEffect(()=>{
  const containerElement=container.current,locationEpoch=locationRevision,styleEpoch=styleGeneration,displayedSelection=displayedTrail,edgeAnnotations=routeAnnotations.current;
  let cancelled=false,geographyPainted=false,overviewFallback=false,satelliteFailed=false,directionLayoutFrame=0,resize:ResizeObserver|undefined,unbindFrame:(()=>void)|undefined,unbindLabels:(()=>void)|undefined,unbindZoom:(()=>void)|undefined;
  let resizeFrame:ReturnType<typeof coalesceMapFrame>|undefined,hoverFrame:ReturnType<typeof coalesceMapFrame>|undefined,terrainPitch:MapTerrainPitch|undefined;
  let sources:MapSourceLoading|undefined;
  const unbindDirectionButtons:(()=>void)[]=[];
  const disconnect=()=>{
   setOffline(!navigator.onLine);
   setStatus(previous=>!navigator.onLine?OFFLINE_MESSAGE:previous===OFFLINE_MESSAGE?(basePreference.current==='overview'?OVERVIEW_MESSAGE:''):previous);
   void styleSession.current?.connect(navigator.onLine);
  };
  // Initial external browser connectivity is unavailable during server rendering.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  setOffline(!navigator.onLine);setBaseMode(navigator.onLine?'detail':'overview');if(!navigator.onLine)setStatus(OFFLINE_MESSAGE);window.addEventListener('online',disconnect);window.addEventListener('offline',disconnect);
  (async()=>{
   try{
    if(planning||preferCanvasMap()||!supportsMapWebGL()){setFallback(true);return;}
    const [ml,coverage]=await Promise.all([import('maplibre-gl'),loadRussiaGeometry(true)]);
    if(cancelled||!container.current)return;
    coverageRef.current=coverage;markerConstructor.current=ml.Marker;await warmMap();if(cancelled||!container.current)return;
    let initialStyleFailed=false;
    const live=navigator.onLine&&basePreference.current==='detail'?await loadPublicJSON<StyleSpecification>('/maps/tropa-style.json').catch(()=>{initialStyleFailed=true;return null;}):null;
    if(cancelled||!container.current)return;
    setStyleUnavailable(initialStyleFailed);
    detailRef.current=live?detailStyle(live,coverage):null;
    // Connectivity or the user's choice can change while the style is loading.
    const initialMode:MapBaseMode=navigator.onLine&&basePreference.current==='detail'&&detailRef.current?'detail':'overview';
    setBaseMode(initialMode);
    const initial=russiaView(container.current).camera;cameraFloor.current=initial;
    const map=new ml.Map({container:container.current,transformRequest:mapRequest,style:initialMode==='detail'?detailRef.current!:overviewStyle(coverage),...initial,
     minZoom:Math.max(-2,initial.zoom),maxZoom:18,attributionControl:false,renderWorldCopies:true,
     transformConstrain:(point,zoom)=>{const next=constrainFramedCamera(point.lng,point.lat,zoom,cameraFloor.current,framedCamera.current);return{center:new ml.LngLat(...next.center),zoom:next.zoom};},
     dragRotate:true,touchPitch:true,pitchWithRotate:true,maxPitch:75,fadeDuration:0,crossSourceCollisions:true,pixelRatio:Math.min(devicePixelRatio,MAP_CONFIG.maxPixelRatio),maxTileCacheZoomLevels:6,
     // Text and line shaders smooth their own edges. Extra canvas MSAA can
     // back up DEM uploads on constrained GPUs without improving those layers.
     canvasContextAttributes:{antialias:false,preserveDrawingBuffer:false,powerPreference:'high-performance'}});
    mapRef.current=map;
    selectionCamera.current=new MapSelectionCamera();
    setSourceFailures([]);setTilesLoading(false);setStyleRetrying(false);
    sources=new MapSourceLoading({
     getSource:id=>map.getSource(id),isSourceLoaded:id=>map.isSourceLoaded(id),
     metadataSources:['openmaptiles','terrain-dem','hillshade-dem'],
     retryMetadata:(id,source)=>retryMapSourceMetadata(source,map.getStyle()?.sources[id]),
     onLoading:value=>{if(!cancelled)setTilesLoading(value);},onFailures:value=>{if(!cancelled)setSourceFailures(value);},
    });
    sourceLoading.current=sources;
    const zoomControl=new MapZoomButtons({zoom:()=>map.getZoom(),bounds:()=>({min:map.getMinZoom(),max:map.getMaxZoom()}),busy:()=>map.isZooming(),
     apply:target=>map.zoomTo(target,{duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:MAP_ZOOM_BUTTONS.durationMs})});
    terrainPitch=new MapTerrainPitch({camera:map,enabled:()=>!cancelled&&map===mapRef.current&&terrainRef.current&&!!map.getTerrain(),
     focused:()=>!!regionRef.current||!!trailRef.current,reducedMotion:()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches});
    terrainPitchControl.current=terrainPitch;
    zoomButtons.current=zoomControl;unbindZoom=bindZoomButtonCancellation(container.current,zoomControl);
    frameRefit.current=new MapFrameRefit({
     allowed:()=>!cancelled&&map===mapRef.current&&!!map.getStyle()&&!!regionRef.current?.bounds&&!trailRef.current&&!!container.current,
     refit:()=>{if(regionRef.current&&container.current){terrainPitch?.remember(0);fitTerritory(map,regionRef.current,container.current,window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:250,framedCamera);}},
    });
    unbindFrame=bindMapFrameRefit(container.current,container.current.closest('.explore-layout')?.querySelector('.explore-panel')??null,frameRefit.current,()=>{
     if(!cancelled&&map===mapRef.current&&container.current){
      if(fullView.current&&!regionRef.current&&!trailRef.current)fitRussia(0);
      else russiaView(container.current);
     }
    });
    styleSession.current=new MapStyleSession({online:navigator.onLine,preference:basePreference.current,currentMode:initialMode,
     overview:()=>overviewStyle(coverage),
     detail:async()=>detailRef.current??(detailRef.current=detailStyle(await loadPublicJSON<StyleSpecification>('/maps/tropa-style.json'),coverage)),
     satellite:async()=>satelliteStyle(detailRef.current??await loadPublicJSON<StyleSpecification>('/maps/tropa-style.json').then(style=>detailRef.current=detailStyle(style,coverage)).catch(()=>overviewStyle(coverage))),
     apply:(next,mode)=>{
      if(cancelled||map!==mapRef.current)return;
      if(mode==='satellite')satelliteFailed=false;
      if(mode!=='overview')setStyleUnavailable(false);
      sources?.beforeStyleChange();
      zoomControl.cancel();terrainPitch?.reset();styleGeneration.current++;setBaseMode(mode);setLoaded(false);terrainRef.current=false;setTerrain(false);
      map.stop();const center=map.getCenter(),zoom=map.getZoom();
      const hadStyle=!!map.getStyle();
      if(hadStyle)map.setTerrain(null);
      map.jumpTo({center:[center.lng,center.lat],zoom,pitch:0});map.setStyle(next,{diff:hadStyle});
     },
     onError:()=>{if(!cancelled)setStyleUnavailable(true);},
    });
    map.on('sourcedataloading',event=>sources?.loading(event));
    map.on('sourcedata',event=>sources?.data(event));
    map.on('sourcedataabort',event=>sources?.aborted(event));
    map.on('idle',()=>{if(!cancelled){sources?.reconcile();syncRouteEdgeAnnotations(edgeAnnotations);}});
    map.on('render',()=>{
     if(cancelled||geographyPainted)return;
     const land=map.getLayer('overview-land')?'overview-land':map.getLayer('land')?'land':null;
     if(land&&map.isSourceLoaded(land)&&map.getSource('russia-mask')&&map.isSourceLoaded('russia-mask')&&map.queryRenderedFeatures({layers:[land]}).length){geographyPainted=true;setPainted(true);}
    });
    map.addControl(new ml.ScaleControl({maxWidth:100,unit:'metric'}),'bottom-left');
    const directionButtons=new Map<string,HTMLButtonElement>(),directionMarkers=new Map<string,Marker>();
    for(const r of regions){
     if(!inRussiaCoverage(...r.center,coverage.area))continue;
     const el=createDirectionMarker(r);directionButtons.set(r.id,el);
     unbindDirectionButtons.push(bindMapDirectionButton(el,()=>{
      const group=directionGroups.current.get(r.id);
      if(group&&group.members.length>1&&container.current){
       frameRefit.current?.cancel();fullView.current=false;map.setTerrain(null);setTerrain(false);
       const b=group.bounds,padding=russiaView(container.current).padding;
       const fit=map.cameraForBounds([[b[0],b[1]],[b[2],b[3]]],{padding,maxZoom:MAP_CONFIG.territoryMaxZoom,pitch:0,bearing:0});
       const target=directionExpansionZoom(map.getZoom(),fit?.zoom??map.getZoom());
       const duration=window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:450;
       map.stop();
       if(fit?.zoom!==undefined&&fit.zoom>=target-.01)fitTerritory(map,{...group.anchor,bounds:group.bounds},container.current,duration,framedCamera);
       else{framedCamera.current=null;map.easeTo({center:[russiaLongitude(group.anchor.center[0]),group.anchor.center[1]],zoom:target,padding,pitch:0,bearing:0,duration});}
      }else onRegionRef.current(r);
     },()=>{locationRevision.current++;zoomControl.cancel();frameRefit.current?.cancel();setStatus(previous=>previous==='Определяем местоположение…'?'':previous);if(map.isMoving())map.stop();}));
     const marker=new ml.Marker({element:el,anchor:'center'}).setLngLat([russiaLongitude(r.center[0]),r.center[1]]).addTo(map);
     directionMarkers.set(r.id,marker);markers.current.push(marker);
    }
    const directionItems=regions.filter(item=>directionButtons.has(item.id));
    const runDirectionLayout=()=>{
     if(cancelled||map!==mapRef.current||!container.current)return;
     syncRouteEdgeAnnotations(routeAnnotations.current);
     const center=map.getCenter(),screenCenter=map.project(center);publishMapCamera(container.current,{longitude:center.lng,latitude:center.lat,zoom:map.getZoom(),tileSize:512,engine:'maplibre',centerX:screenCenter.x,centerY:screenCenter.y});
     const items=directionItems;
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

    if(regionRef.current&&!fitTerritory(map,regionRef.current,container.current,0,framedCamera))map.jumpTo({center:regionRef.current.center,zoom:regionRef.current.zoom});
    map.on('zoomend',()=>{
     zoomControl.settled();
     terrainPitch?.settled();
     const zoom=map.getZoom();setMapZoom(zoom);
     scheduleDirectionLayout();
     requestAnimationFrame(()=>{if(!cancelled&&map===mapRef.current&&!map.isMoving()&&container.current){delete container.current.dataset.mapCamera;scheduleDirectionLayout();}});
    });
    // The style's viewport-anchored hillshade follows the camera itself.
    // Keep contrast stable instead of restarting a paint transition on each pitch frame.
    map.on('moveend',()=>{
     if(container.current)delete container.current.dataset.mapCamera;
     scheduleDirectionLayout();
     const c=map.getCenter();viewportRef.current?.(viewportRegionId(c.lng,c.lat,map.getZoom()));
    });
    map.on('dragstart',()=>{zoomControl.cancel();fullView.current=false;frameRefit.current?.cancel();});
    map.on('movestart',()=>{terrainPitch?.moving();locationRevision.current++;setStatus(previous=>previous==='Определяем местоположение…'?'':previous);if(container.current)container.current.dataset.mapCamera='moving';});
    map.on('zoomstart',event=>{if(event.originalEvent){zoomControl.cancel();fullView.current=false;frameRefit.current?.cancel();}if(container.current)container.current.dataset.mapCamera='moving';});
    map.on('style.load',()=>{
     if(cancelled)return;displayedTrail.current=undefined;routeEdges.current.forEach(marker=>marker.remove());routeEdges.current=[];routeAnnotations.current.length=0;geographyPainted=false;styleGeneration.current++;setLoaded(true);setStyleRevision(v=>v+1);
     sources?.styleLoaded();
     if(map.getSource('openmaptiles'))overviewFallback=false;
     setStatus(!navigator.onLine?OFFLINE_MESSAGE:satelliteFailed&&basePreference.current==='satellite'?SATELLITE_ERROR:overviewFallback?'Детальная карта недоступна. Показан сохранённый обзор.':basePreference.current==='overview'?OVERVIEW_MESSAGE:'');
     // Keep pitched DEM coverage within the flat-view tile budget; vector
     // labels and trails retain their independent detail budget.
     if(map.getSource('terrain-dem')){map.setSourceTileLodParams(4,1,'terrain-dem');map.setSourceTileLodParams(3,1,'hillshade-dem');map.setSourceTileLodParams(3,2,'openmaptiles');}
     if(!map.getSource('regions'))map.addSource('regions',{type:'geojson',data:'/data/territories.geojson'});
     if(!map.getLayer('region-fill'))map.addLayer({id:'region-fill',type:'fill',source:'regions',paint:{'fill-color':'#9CB48E','fill-opacity':['interpolate',['linear'],['zoom'],2,.1,7,0]}},MASK);
     if(!map.getLayer('region-boundary'))map.addLayer({id:'region-boundary',type:'line',source:'regions',maxzoom:8,paint:{'line-color':'#718371','line-width':.7,'line-opacity':.34}},MASK);
     if(!map.getLayer('region-selected'))map.addLayer({id:'region-selected',type:'fill',source:'regions',filter:['==',['get','shapeName'],'__none'],paint:{'fill-color':'#91AC82','fill-opacity':['interpolate',['linear'],['zoom'],2,.3,8,0]}},MASK);
     if(!map.getLayer('region-selected-outline'))map.addLayer({id:'region-selected-outline',type:'line',source:'regions',filter:['==',['get','shapeName'],'__none'],paint:{'line-color':'#315B45','line-width':['interpolate',['linear'],['zoom'],5,1.6,11,1],'line-opacity':['interpolate',['linear'],['zoom'],5,.86,11,.2]}},MASK);
     highlightRegion(map,regionRef.current);
     applyMapLayerVisibility(map,layerVisibility.current);
     ensureTrailPointLayers(map);
    });
    const hitLayers=()=>[TRAIL_POINT_HIT,'trail-casing','region-fill'].filter(id=>!!map.getLayer(id));
    let hoverPoint:import('maplibre-gl').Point|undefined,hoveredTrail:string|undefined;
    hoverFrame=coalesceMapFrame(()=>{
     if(cancelled||!hoverPoint||!map.getStyle())return;
     const layers=hitLayers(),hits=layers.length?map.queryRenderedFeatures(hoverPoint,{layers}):[];
     const hit=hits.find(feature=>feature.layer.id===TRAIL_POINT_HIT);
     const id=typeof hit?.properties?.id==='string'?hit.properties.id:undefined;
     map.getCanvas().style.cursor=hits.length?'pointer':'';
     if(id&&id!==hoveredTrail){const item=visibleTrailsRef.current.find(candidate=>candidate.id===id);if(item)void preloadTrail(item);}
     hoveredTrail=id;
    });
    map.on('mousemove',event=>{hoverPoint=event.point;hoverFrame?.schedule();});
    map.on('mouseout',()=>{hoverPoint=undefined;hoveredTrail=undefined;map.getCanvas().style.cursor='';});
    // One selection dispatcher: a trail hit must never also select the
    // administrative polygon beneath it and clear the opened trail card.
    map.on('click',event=>{
     if(cancelled||!map.getStyle())return;
     const layers=hitLayers();if(!layers.length)return;
     const hits=map.queryRenderedFeatures(event.point,{layers});
     const hit=hits.find(feature=>feature.layer.id===TRAIL_POINT_HIT);
     const id=typeof hit?.properties?.id==='string'?hit.properties.id:undefined;
     const line=hits.find(feature=>feature.layer.id==='trail-casing');
     const item=id?visibleTrailsRef.current.find(candidate=>candidate.id===id):line?resolveRenderedTrail(line.properties?.[RENDERED_TRAIL_ID],displayedTrail.current,visibleTrailsRef.current):undefined;
     if(item){map.stop();frameRefit.current?.cancel();onTrailRef.current?.(item);return;}
     if(line)return; // A stale/unknown line must not activate the polygon under it.
     if(!inRussiaCoverage(event.lngLat.lng,event.lngLat.lat,coverage.area))return;
     const direct=hits.filter(feature=>feature.layer.id==='region-fill').map(feature=>feature.properties?.shapeName).filter((name):name is string=>typeof name==='string');
     const point=event.point,tolerance=MAP_CONFIG.regionQueryTolerancePx;
     const nearby=direct.length||!map.getLayer('region-fill')?[]:map.queryRenderedFeatures([[point.x-tolerance,point.y-tolerance],[point.x+tolerance,point.y+tolerance]],{layers:['region-fill']});
     const fallback=nearby.map(feature=>feature.properties?.shapeName).filter((name):name is string=>typeof name==='string');
     const territory=territoryForMapPoint(direct.length?direct:fallback,[russiaLongitude(event.lngLat.lng),event.lngLat.lat]);
     if(territory){map.stop();frameRefit.current?.cancel();onRegionRef.current(territory);}
    });
    map.on('webglcontextlost',()=>setStatus('Графический контекст карты прерван. Восстанавливаем отображение.'));
    map.on('webglcontextrestored',()=>setStatus(''));
    map.on('error',event=>{
     if(cancelled)return;const sourceEvent=event as typeof event&MapSourceSignal,sourceId=sourceEvent.sourceId;
     sources?.error(sourceEvent);
     if(sourceId===SATELLITE_SOURCE&&basePreference.current==='satellite'&&map.getSource(SATELLITE_SOURCE)&&!satelliteFailed){satelliteFailed=true;styleSession.current?.fallback();setStatus(SATELLITE_ERROR);}
     else if(!map.getStyle()&&!overviewFallback){overviewFallback=true;setStyleUnavailable(true);styleSession.current?.fallback();setStatus('Детальная карта недоступна. Открываем сохранённый обзор.');}
     else if(['overview-land','land','regions','russia-mask'].includes(sourceId||''))setStatus('Не удалось загрузить географию России. Обновите страницу.');
     else console.warn('Non-critical map detail failed; keeping the rendered overview.');
    });
    resizeFrame=coalesceMapFrame(()=>{
     if(cancelled||!container.current)return;
     map.resize();cameraFloor.current=russiaView(container.current).camera;map.setMinZoom(Math.max(-2,cameraFloor.current.zoom));
     if(fullView.current)map.jumpTo({...cameraFloor.current,padding:{top:0,right:0,bottom:0,left:0}});
     else frameRefit.current?.resized();
     scheduleDirectionLayout();
    });
    resize=new ResizeObserver(()=>resizeFrame?.schedule());
    resize.observe(container.current);const panel=container.current.closest('.explore-layout')?.querySelector('.explore-panel');if(panel)resize.observe(panel);
   }catch(error){
    if(cancelled)return;console.error('Map initialization failed',error);sources?.dispose();if(sourceLoading.current===sources)sourceLoading.current=null;unbindDirectionButtons.splice(0).forEach(unbind=>unbind());unbindZoom?.();zoomButtons.current?.dispose();zoomButtons.current=null;terrainPitch?.dispose();if(terrainPitchControl.current===terrainPitch)terrainPitchControl.current=null;frameRefit.current?.dispose();frameRefit.current=null;unbindFrame?.();styleSession.current?.dispose();styleSession.current=null;markers.current.forEach(marker=>marker.remove());markers.current=[];mapRef.current?.remove();mapRef.current=null;setFallback(true);
   }
  })();
  return()=>{cancelled=true;sources?.dispose();if(sourceLoading.current===sources)sourceLoading.current=null;unbindDirectionButtons.splice(0).forEach(unbind=>unbind());unbindZoom?.();zoomButtons.current?.dispose();zoomButtons.current=null;terrainPitch?.dispose();if(terrainPitchControl.current===terrainPitch)terrainPitchControl.current=null;displayedSelection.current=undefined;locationEpoch.current++;cancelAnimationFrame(directionLayoutFrame);resizeFrame?.dispose();hoverFrame?.dispose();if(containerElement)delete containerElement.dataset.mapCamera;unbindLabels?.();updateDirections.current=null;directionGroups.current.clear();frameRefit.current?.dispose();frameRefit.current=null;unbindFrame?.();styleEpoch.current++;styleSession.current?.dispose();styleSession.current=null;resize?.disconnect();markers.current.forEach(marker=>marker.remove());markers.current=[];routeEdges.current.forEach(marker=>marker.remove());routeEdges.current=[];edgeAnnotations.length=0;markerConstructor.current=null;positionMarker.current?.remove();mapRef.current?.remove();mapRef.current=null;window.removeEventListener('online',disconnect);window.removeEventListener('offline',disconnect);};
 },[planning]);
 useEffect(()=>{
  const map=mapRef.current;if(!map||!loaded)return;
  highlightRegion(map,region);
  if(!selectionCamera.current.regionChanged(region?.id))return;
  frameRefit.current?.select(region?.bounds?region.id:undefined);
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const terrainActive=terrainRef.current&&!!map.getSource('terrain-dem');
  if(region){
   if(region.bounds&&container.current){
    if(frameRefit.current?.active()){fullView.current=false;map.stop();terrainPitchControl.current?.remember(0);fitTerritory(map,region,container.current,reduced?0:450,framedCamera);}
   }else{
    fullView.current=false;framedCamera.current=null;map.stop();
    if(terrainActive&&!map.getTerrain())map.setTerrain({source:'terrain-dem',exaggeration:terrainExaggerationForZoom(region.zoom)});
    if(!terrainActive&&map.getTerrain())map.setTerrain(null);
    const regionPitch=terrainPitchForZoom(region.zoom,true),pitch=terrainActive?(region.id==='karelia'?Math.min(regionPitch,26):regionPitch):0;
    terrainPitchControl.current?.remember(pitch);
    map.flyTo({center:region.center,zoom:region.zoom,pitch,bearing:terrainActive?-8:0,offset:window.innerWidth<=700?[0,-Math.round(container.current!.clientHeight*.23)]:[0,0],duration:reduced?0:650,essential:false});
   }
  }else fitRussia(0);
 },[region,loaded,styleRevision]);
 useEffect(()=>{
  const map=mapRef.current;if(!map)return;
  const clear=()=>{displayedTrail.current=undefined;routeEdges.current.forEach(marker=>marker.remove());routeEdges.current=[];routeAnnotations.current.length=0;if(container.current)delete container.current.dataset.mapRouteId;(map.getSource('selected-trail')as GeoJSONSource|undefined)?.setData(EMPTY);};
  if(!loaded){if(!trail?.id)selectionCamera.current.routeChanged(undefined);clear();return;}
  const generation=styleGeneration.current,identity={id:trail?.id,url:trail?.geometryUrl,geometry:trail?.geometry};
  // Clear the previous SDK request's error before starting a new selection request.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  setStatus(previous=>previous===ROUTE_ERROR||previous===ROUTE_COVERAGE_MESSAGE?'':previous);
  return loadMapSelection({clear,clearBeforeLoad:!trail?.id,
   current:()=>map===mapRef.current&&generation===styleGeneration.current&&identity.id===trailRef.current?.id&&identity.url===trailRef.current?.geometryUrl&&identity.geometry===trailRef.current?.geometry&&!!map.getStyle(),
   load:async()=>identifyRouteGeometry(displayGeoJSON(readRouteGeometry(trail?.geometry??(trail?.geometryUrl?await loadPublicJSON<unknown>(trail.geometryUrl):EMPTY))),trail?.id??''),
   apply:data=>{
   const navigate=selectionCamera.current.routeChanged(trail?.id?identity:undefined);
   routeEdges.current.forEach(marker=>marker.remove());routeEdges.current=[];routeAnnotations.current.length=0;
   displayedTrail.current=trailRef.current;
   if(map.getSource('selected-trail'))(map.getSource('selected-trail')as GeoJSONSource).setData(data);
   else{map.addSource('selected-trail',{type:'geojson',data});
    map.addLayer({id:'trail-casing',type:'line',source:'selected-trail',paint:{'line-color':ROUTE_PRESENTATION.paper,'line-width':['interpolate',['linear'],['zoom'],8,7,14,9],'line-opacity':.96},layout:{'line-join':'round','line-cap':'round'}},MASK);
    map.addLayer({id:'trail-line',type:'line',source:'selected-trail',paint:{'line-color':ROUTE_PRESENTATION.ink,'line-width':['interpolate',['linear'],['zoom'],8,3,14,5],'line-opacity':.98},layout:{'line-join':'round','line-cap':'round'}},MASK);
   }
   const coverageForEdges=coverageRef.current;
   if(coverageForEdges){
    // A source edge is a passive map annotation, never a new hit target.
    const MarkerClass=markerConstructor.current;
    if(MarkerClass)for(const edge of routeLineEdges(data)){
     if(!inRussiaCoverage(...edge.coordinate,coverageForEdges.area))continue;
     const element=createRouteEdgeElement(edge),marker=new MarkerClass({element,anchor:'center'}).setLngLat(edge.coordinate).addTo(map);
     routeEdges.current.push(marker);routeAnnotations.current.push({element,project:()=>map.project(marker.getLngLat())});
    }
   }
   syncRouteEdgeAnnotations(routeAnnotations.current);
   if(container.current){if(trail?.id)container.current.dataset.mapRouteId=trail.id;else delete container.current.dataset.mapRouteId;}
   if(trail?.geometryUrl||trail?.geometry){
    const coordinates=routeGeometryPositions(data);
    const coverage=coverageRef.current,covered=coverage?coveredRussiaBounds(coordinates,coverage.area):null;
    if(covered&&navigate){
     const routeZoom=11;fullView.current=false;const terrainActive=terrainRef.current&&!!map.getTerrain();
     const padding=container.current?russiaView(container.current).padding:80;
     const pitch=terrainActive?terrainPitchForZoom(routeZoom,true):0;
     zoomButtons.current?.cancel();map.stop();terrainPitchControl.current?.remember(pitch);map.fitBounds([[covered[0],covered[1]],[covered[2],covered[3]]],{padding,maxZoom:MAP_CONFIG.routeMaxZoom,pitch,bearing:terrainActive?-12:0,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:450});
    }else if(!covered&&coordinates.length)setStatus(ROUTE_COVERAGE_MESSAGE);
   }
   },onError:()=>setStatus(ROUTE_ERROR),
  });
 },[trail?.id,trail?.geometryUrl,trail?.geometry,loaded,styleRevision]);
 useEffect(()=>{
  if(!loaded)return;
  updateDirections.current?.();
 },[visibleTrails,region,loaded]);
 useEffect(()=>{
  const map=mapRef.current,coverage=coverageRef.current;if(!map||!loaded||!coverage)return;
  const source=map.getSource(TRAIL_POINTS) as GeoJSONSource|undefined;if(!source)return;
  source.setData(mapTrailPointFeatureCollection(region?visibleTrails:[],(lng,lat)=>inRussiaCoverage(lng,lat,coverage.area),regionRef.current,trail?.id,russiaLongitude));
 },[visibleTrails,region,trail?.id,loaded,styleRevision]);
 async function changeBase(mode:MapBaseMode){
  setScene(false);
  basePreference.current=mode;
  if(mode==='overview')setStyleUnavailable(false);
  setStatus(!navigator.onLine?OFFLINE_MESSAGE:mode==='overview'?OVERVIEW_MESSAGE:'');
  if(mode===baseMode&&sourceFailures.length&&!offline){sourceLoading.current?.retry();return;}
  await styleSession.current?.select(mode);
 }
 async function retryMap(){
  if(!navigator.onLine||styleRetrying)return;
  if(!styleUnavailable){sourceLoading.current?.retry();return;}
  const map=mapRef.current;setStyleRetrying(true);
  try{await styleSession.current?.select(basePreference.current);}
  finally{if(map===mapRef.current)setStyleRetrying(false);}
 }
 function updateLayers(kind:'paths'|'boundaries',value:boolean){
  layerVisibility.current={...layerVisibility.current,[kind]:value};
  if(kind==='paths')setPathLayer(value);else setBoundaryLayer(value);
  if(mapRef.current)applyMapLayerVisibility(mapRef.current,layerVisibility.current);
 }
 function setTerrainMode(next:boolean){
  const map=mapRef.current;if(!map||!loaded||(next&&(baseMode==='overview'||offline)))return;
  frameRefit.current?.cancel();zoomButtons.current?.cancel();terrainPitchControl.current?.reset();terrainRef.current=next;map.stop();
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(next){
   if(!map.getSource('terrain-dem'))map.addSource('terrain-dem',{type:'raster-dem',url:'https://tiles.mapterhorn.com/tilejson.json'});
   const zoom=map.getZoom(),pitch=terrainPitchForZoom(zoom,!!regionRef.current||!!trailRef.current);
   map.setTerrain({source:'terrain-dem',exaggeration:terrainExaggerationForZoom(zoom)});
   terrainPitchControl.current?.remember(pitch);map.easeTo({pitch,duration:reduced?0:420});
  }
  else{map.setTerrain(null);map.easeTo({pitch:0,bearing:0,duration:reduced?0:300});}setTerrain(next);
 }
 function locate(){
  frameRefit.current?.cancel();zoomButtons.current?.cancel();
  if(!navigator.geolocation){setStatus('Этот браузер не поддерживает геолокацию.');return;}
  const revision=++locationRevision.current,requestedMap=mapRef.current;
  const current=()=>revision===locationRevision.current&&requestedMap===mapRef.current&&!!requestedMap;
  setStatus('Определяем местоположение…');
  navigator.geolocation.getCurrentPosition(async position=>{
   const map=mapRef.current,coverage=coverageRef.current;if(!current()||!map||!coverage)return;
   const {longitude,latitude,accuracy}=position.coords;
   if(!inRussiaCoverage(longitude,latitude,coverage.area)){setStatus('Местоположение находится за пределами доступной карты России. Выберите направление на карте.');return;}
   const ml=await import('maplibre-gl');if(!current())return;
   fullView.current=false;positionMarker.current?.remove();const center:[number,number]=[russiaLongitude(longitude),latitude];
   positionMarker.current=new ml.Marker({color:'#316B8B'}).setLngLat(center).addTo(map);map.flyTo({center,zoom:13,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:900});
   setStatus(`Точность позиции: около ${Math.round(accuracy)} м. Местоположение никому не передаётся.`);
  },()=>{if(current())setStatus('Позиция недоступна. Проверьте разрешение на геолокацию и наличие сигнала.');},{enableHighAccuracy:true,timeout:MAP_CONFIG.geolocationTimeoutMs,maximumAge:MAP_CONFIG.geolocationMaximumAgeMs});
 }
 if(fallback)return <Atlas2D region={region} trail={trail} visibleTrails={visibleTrails} onTrail={onTrail} onRegion={onRegion} onMapNote={onMapNote} onViewportRegion={onViewportRegion} planning={planning} planPoints={planPoints}/>;
 const availabilityMessage=styleUnavailable||sourceFailures.some(failure=>failure.id==='openmaptiles')?DETAIL_ERROR:sourceFailures.length?TERRAIN_ERROR:'';
 const message=offline?OFFLINE_MESSAGE:availabilityMessage||status,retryAvailable=!!availabilityMessage&&!offline,retrying=styleRetrying||sourceFailures.some(failure=>failure.retrying);
 return <div className={`atlas-wrap ${scene?'showing-terrain':''}`} data-map-imagery={baseMode==='satellite'?'satellite':undefined} data-map-detail={mapZoom>=ROUTE_PRESENTATION.closeZoom?'close':undefined} data-map-route={trail?'selected':undefined}>
  <div ref={container} className="atlas-canvas" style={{visibility:painted?'visible':'hidden'}} role="region" aria-label="Интерактивная карта направлений России"/>
  {!painted&&!message&&<div className="map-skeleton"><MapIcon name="compass" size={38}/><span>Открываем карту России</span></div>}
  {trail?<MapRouteContext title={trail.title} caption={overviewContextCaption(baseMode,mapZoom,scene)}/>:<div className="map-context"><span className="live-dot"/><span>{region?region.name:'Россия'}</span><span className="context-divider"/><span>{baseMode==='satellite'?'Спутник':region?(baseMode==='detail'?'Тропы и местность':'Обзорная карта'):routeCountLabel(visibleTrails.length)}</span></div>}
  {loaded&&tilesLoading&&!scene&&!message&&<div className="map-preload-status" role="status">Подгружаем детали текущего ракурса</div>}
  <div className="map-style-switch"><button aria-label="Карта сверху" className={!terrain&&!scene&&baseMode!=='satellite'?'active':''} onClick={()=>{setScene(false);if(baseMode==='satellite')void changeBase('detail');else setTerrainMode(false);}}><MapIcon name="map" size={18}/>Карта</button><button aria-label="Рельеф всей карты" className={terrain&&!scene?'active':''} onClick={()=>{setScene(false);setTerrainMode(true);}} disabled={offline||baseMode==='overview'} title="Объёмный рельеф на основе данных высот"><MapIcon name="terrain" size={19}/>Рельеф</button>{sceneAvailable&&<button aria-label="3D ландшафт Бзерпинского района" className={scene?'active':''} onPointerEnter={()=>void preloadTerrain()} onFocus={()=>void preloadTerrain()} onClick={()=>setScene(true)}><MapIcon name="peak" size={19}/>3D</button>}</div>
  <div className="map-controls"><button aria-label="Увеличить масштаб" onClick={()=>zoomBy(MAP_ZOOM_BUTTONS.maplibreStep)}><MapIcon name="plus" size={20}/></button><button aria-label="Уменьшить масштаб" onClick={()=>zoomBy(-MAP_ZOOM_BUTTONS.maplibreStep)}><MapIcon name="minus" size={20}/></button><span/><button aria-label="Север сверху" onClick={()=>setTerrainMode(false)}><MapIcon name="compass" size={22}/></button><button aria-label="Моё местоположение" onClick={locate}><MapIcon name="location" size={21}/></button><button aria-label="Показать Россию целиком" onClick={()=>{setScene(false);fitRussia(window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:700);}}><MapIcon name="fit" size={19}/></button></div>
  <div className="layer-control"><button className={layersOpen?'layer-button active':'layer-button'} aria-expanded={layersOpen} onClick={()=>setLayersOpen(!layersOpen)}><MapIcon name="layers" size={20}/>Слои</button>{layersOpen&&<div className="layer-menu"><strong>Ваша карта</strong><button onClick={()=>void changeBase('detail')} disabled={offline}><span>Детальные тропы онлайн</span>{baseMode==='detail'&&<Check size={18}/>}</button><button aria-pressed={baseMode==='satellite'} onClick={()=>void changeBase('satellite')} disabled={offline||!loaded}><span>Спутник</span>{baseMode==='satellite'&&<Check size={18}/>}</button><button onClick={()=>void changeBase('overview')}><span>Сохранённый обзор</span>{baseMode==='overview'&&<Check size={18}/>}</button><label><input type="checkbox" checked={pathLayer} onChange={event=>updateLayers('paths',event.target.checked)}/>Тропы и грунтовые дороги</label><label><input type="checkbox" checked={boundaryLayer} onChange={event=>updateLayers('boundaries',event.target.checked)}/>Границы регионов</label><a href="/sources">Данные и лицензии</a></div>}</div>
  {message&&<div className="map-message" role="status">{offline?<WifiSlash size={18}/>:<MapIcon name="info" size={18}/>}<span>{message}</span>{retryAvailable&&<button onClick={()=>void retryMap()} disabled={retrying}>{retrying?'Загружаем…':'Повторить'}</button>}{baseMode==='detail'&&<button onClick={()=>void changeBase('overview')}>Обзор</button>}</div>}
  <div className="map-legend"><span className="legend-line"/>Тропа на карте<span className="legend-region"/>Направление<span className="legend-hint">{mapZoom<6?'Выберите регион, чтобы приблизить':'Условия и доступ проверяйте в карточке'}</span></div>
  {sceneAvailable&&<TerrainScene trail={trail} visible={scene} onClose={()=>setScene(false)}/>}
  {!scene&&<MapAttribution ready={painted} terrain={terrain||(baseMode==='detail'&&mapZoom>=5)} satellite={baseMode==='satellite'} zoom={mapZoom}/>}
 </div>;
}
