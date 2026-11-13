'use client';
import type * as GeoJSON from 'geojson';
import {memo,useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {MapIcon} from './MapIcon';
import {MapAttribution,MapFooter} from './MapAttribution';
import {MapRouteContext} from './MapRouteContext';
import {CustomMapEngine,type CustomMapMarker,type CustomMapMode,type CustomMapState} from '@/lib/custom-map-engine';
import {hitGeometry,mercatorProject,mercatorUnproject,type GeographicBounds} from '@/lib/custom-map-camera';
import {regions,routeCountLabel,type Trail} from '@/lib/content';
import {mapDirectionCounts} from '@/lib/map-catalog';
import {territoryForMapPoint} from '@/lib/territories';
import {russiaView} from '@/lib/russia-map';
import {loadPublicBytes,invalidatePublicMapResource} from '@/lib/map-preload';
import {loadVerifiedRouteGeometry} from '@/lib/route-source-integrity';
import {loadPublishedRouteGeometry} from '@/lib/published-route';
import {TrailOverlayLoader} from '@/lib/map-trail-overlay';
import trailOverlayMetadata from '@/lib/trail-overlay.generated.json';
import {verifyReviewedCoastalRoute} from '@/lib/reviewed-coastal-routes';
import {mapTrailPointEntries} from '@/lib/map-trail-points';
import {readRouteGeometry,routeGeometryPositions} from '@/lib/route-geometry';
import {coveredRussiaBounds,inRussiaCoverage} from '@/public/maps/russia-viewport.js';
import {MapFrameRefit,bindMapFrameRefit,prepareMapFrameControl} from '@/lib/map-framing';
import {bindMapLabelReflow,constrainDirectionLabels,mapLabelObstacleRects} from '@/lib/map-direction-layout';
import {MAP_CONFIG,viewportRegionId} from '@/lib/map-config';
import {overviewContextCaption,ROUTE_PRESENTATION} from '@/lib/map-route-presentation';
import {EMPTY_MAP_TRAILS,type AtlasProps} from '@/lib/map-types';
import {mapDistanceScale} from '@/lib/custom-map-scale';
import {reliefContourIntervals} from '@/lib/custom-map-relief';

const INITIAL:CustomMapState={ready:false,loading:false,mode:'detail',committedMode:'overview',imageryLoading:false,reliefReady:false,localDetail:false,error:'',residentTiles:0,pendingTiles:0};

export const CustomAtlas=memo(function CustomAtlas(props:AtlasProps){
  const {region,trail,visibleTrails=EMPTY_MAP_TRAILS,planning=false,planPoints}=props;
  const container=useRef<HTMLDivElement>(null),engine=useRef<CustomMapEngine|null>(null),latest=useRef(props);
  const scaleValue=useRef<HTMLSpanElement>(null),scaleLine=useRef<HTMLSpanElement>(null);
  const frame=useRef<MapFrameRefit|null>(null),navigation=useRef(0),manual=useRef(false),fullView=useRef(!region),fitCurrent=useRef<(animate?:boolean)=>void>(()=>{});
  const shown=useRef<{trail?:Trail;geometry?:GeoJSON.GeoJSON;bounds?:GeographicBounds}>({});
  const overlay=useRef<TrailOverlayLoader|null>(null),refreshOverlay=useRef<()=>void>(()=>{});
  const selectedInput=useRef<{region:typeof region;trail:typeof trail}|undefined>(undefined);
  const pendingRouteFit=useRef<{region:typeof region;trail:Trail;revision:number}|undefined>(undefined);
  const locationEpoch=useRef(0),locating=useRef(false),position=useRef<[number,number]|null>(null);
  const [state,setState]=useState(INITIAL),[zoom,setZoom]=useState(2),[status,setStatus]=useState(''),[layers,setLayers]=useState(false);
  const [paths,setPaths]=useState(true),[boundaries,setBoundaries]=useState(true),[relief,setRelief]=useState(true);
  const [offline,setOffline]=useState(false);
  const [dismissedError,setDismissedError]=useState('');
  const [routeAttempt,setRouteAttempt]=useState(0),[routeError,setRouteError]=useState(''),[overlayError,setOverlayError]=useState(''),[rasterError,setRasterError]=useState(''),[routeLoading,setRouteLoading]=useState(false);
  useLayoutEffect(()=>{latest.current=props;},[props]);
  const note=useCallback((text:string)=>{setStatus(text);latest.current.onMapNote?.(text);},[]);
  const cancelLocation=useCallback(()=>{locationEpoch.current++;if(locating.current){locating.current=false;note('');}},[note]);
  useLayoutEffect(()=>{
    refreshOverlay.current=()=>{
      const map=engine.current,current=latest.current;if(!map?.getState().ready)return;
      overlay.current?.update({ids:current.planning||!paths?[]:(current.visibleTrails??EMPTY_MAP_TRAILS).map(item=>item.id),selectedId:current.trail?.id,bounds:[...map.getBounds()],zoom:map.getCamera().zoom});
    };
    fitCurrent.current=(animate=false)=>{
      const map=engine.current,element=container.current;if(!map||!element)return;
      const current=latest.current,{camera,padding}=russiaView(element,256);map.setFloor(camera);map.setPadding(padding);
      if(fullView.current||!current.region&&!current.trail){map.setPitch(0);map.setCamera(camera,animate);return;}
      if(shown.current.bounds&&shown.current.trail?.id===current.trail?.id){map.fit(shown.current.bounds,padding,current.planning?MAP_CONFIG.planMaxZoom:MAP_CONFIG.routeMaxZoom,animate);return;}
      if(current.region?.bounds){map.fit(current.region.bounds,padding,MAP_CONFIG.territoryMaxZoom,animate);return;}
      if(current.region){
        const target={center:current.region.center,zoom:Math.max(current.region.zoom,camera.zoom)},scale=256*2**target.zoom,c=mercatorProject(target.center);
        map.setCamera({...target,center:mercatorUnproject({x:c.x+(padding.right-padding.left)/(2*scale),y:c.y+(padding.bottom-padding.top)/(2*scale)})},animate);
      }
    };
  });
  useEffect(()=>{
    const element=container.current;if(!element)return;
    let alive=true,layoutFrame=0;const navigationEpoch=navigation,locationRevision=locationEpoch;
    const panel=element.closest('.explore-layout')?.querySelector('.explore-panel')||null;
    const map=new CustomMapEngine(element,{
      camera:russiaView(element,256).camera,
      onReady:()=>{if(alive)setState(map.getState());},
      onState:value=>{if(alive)setState(value);},
      onOverlayError:message=>{if(alive)setRasterError(message);},
      onBeforeZoom:()=>{if(frame.current)prepareMapFrameControl(panel,frame.current);},
      onGesture:()=>{manual.current=true;fullView.current=false;navigation.current++;cancelLocation();frame.current?.cancel();},
      onSettled:camera=>{
        if(!alive)return;
        setZoom(camera.zoom);latest.current.onViewportRegion?.(viewportRegionId(camera.center[0],camera.center[1],camera.zoom));
        refreshOverlay.current();
        // The ruler describes the settled view. Keep its DOM layout/paint out
        // of the map's drag and zoom frames, including hidden mobile legends.
        const scale=mapDistanceScale(camera.center[1],camera.zoom),value=scaleValue.current,line=scaleLine.current;if(!scale||!value||!line)return;
        if(value.textContent!==scale.label)value.textContent=scale.label;
        const width=`${scale.pixels.toFixed(2)}px`;if(line.style.width!==width)line.style.width=width;
      },
      onMarker:id=>{
        const current=latest.current,plan=current.planPoints?.find(point=>point.id===id);
        if(plan){plan.onSelect?.();return;}
        const route=current.visibleTrails?.find(item=>item.id===id);if(route){current.onTrail?.(route);return;}
        const direction=regions.find(item=>item.id===id);if(direction&&!current.planning)current.onRegion(direction);
      },
      onClick:(point,coordinate)=>{
        const current=latest.current,coverage=map.getCoverage();if(current.planning||!coverage)return;
        const routeId=map.pickTrail(point,MAP_CONFIG.trailHitRadiusPx);
        const route=routeId&&(current.trail?.id===routeId?current.trail:current.visibleTrails?.find(item=>item.id===routeId));
        if(route){current.onTrail?.(route);return;}
        if(!inRussiaCoverage(...coordinate,coverage.area))return;
        const hit=(geometry:GeoJSON.GeoJSON|null|undefined):boolean=>{
          if(!geometry)return false;if(geometry.type==='FeatureCollection')return geometry.features.some(feature=>hit(feature));
          if(geometry.type==='Feature')return hit(geometry.geometry);
          return hitGeometry(point,geometry,map.getCamera(),map.getSize(),MAP_CONFIG.trailHitRadiusPx);
        };
        const names=coverage.territories.features.filter(feature=>hit(feature.geometry)).map(feature=>String(feature.properties?.shapeName||''));
        const selected=territoryForMapPoint(names,coordinate);if(selected)current.onRegion(selected);
      },
    });engine.current=map;
    const routeOverlay=new TrailOverlayLoader({url:trailOverlayMetadata.url,sha256:trailOverlayMetadata.sha256,load:loadPublicBytes,invalidate:invalidatePublicMapResource,
      onChange:entries=>{if(alive)map.setTrailOverlay(entries);},onError:message=>{if(alive)setOverlayError(message);}});overlay.current=routeOverlay;
    const refit=new MapFrameRefit({allowed:()=>!manual.current,refit:()=>fitCurrent.current(false)});frame.current=refit;refit.select('country');
    const refreshGeometry=()=>{
      if(!alive||layoutFrame)return;
      layoutFrame=requestAnimationFrame(()=>{
        layoutFrame=0;
        map.setObstacles(mapLabelObstacleRects(element));map.setPadding(russiaView(element,256).padding);
        constrainDirectionLabels(new Map([...element.querySelectorAll<HTMLButtonElement>('.region-marker')].map(button=>[button.dataset.regionId!,button])),element);
      });
    };
    const unbindFrame=bindMapFrameRefit(element,panel,refit,refreshGeometry),unbindLabels=bindMapLabelReflow(element,refreshGeometry);
    const resize=new ResizeObserver(()=>{refreshGeometry();refit.resized();});resize.observe(element);
    const connection=()=>{
      setOffline(!navigator.onLine);
      if(navigator.onLine){routeOverlay.retry();const current=shown.current;if(current.trail&&(current.trail.geometry||current.trail.geometryUrl)&&!current.geometry)setRouteAttempt(value=>value+1);}
    };connection();window.addEventListener('online',connection);window.addEventListener('offline',connection);
    return()=>{alive=false;cancelAnimationFrame(layoutFrame);navigationEpoch.current++;locationRevision.current++;resize.disconnect();unbindFrame();unbindLabels();refit.dispose();frame.current=null;routeOverlay.destroy();if(overlay.current===routeOverlay)overlay.current=null;map.destroy();if(engine.current===map)engine.current=null;window.removeEventListener('online',connection);window.removeEventListener('offline',connection);};
  },[cancelLocation]);
  useLayoutEffect(()=>{
    if(!state.ready||!engine.current)return;
    const map=engine.current,changed=selectedInput.current?.region!==region||selectedInput.current?.trail!==trail;
    selectedInput.current={region,trail};
    if(changed){navigation.current++;cancelLocation();manual.current=false;fullView.current=!region;frame.current?.select(JSON.stringify([region?.id,trail?.id,trail?.geometryUrl]));map.setRegion(region?.shapeNames||[]);}
    const revision=navigation.current;
    if(changed)pendingRouteFit.current=trail&&(trail.geometry||trail.geometryUrl)?{region,trail,revision}:undefined;
    // Clear before paint and before I/O: a newly selected card cannot inherit
    // another route's line, click target or frame.
    setStatus('');setRouteError('');setRouteLoading(false);shown.current={trail};map.setRoute(undefined);
    if(!trail?.geometry&&!trail?.geometryUrl){if(changed)fitCurrent.current(!!region);return;}
    setRouteLoading(true);
    const controller=new AbortController();
    const load=trail.publicationStatus==='published'?loadPublishedRouteGeometry(trail,controller.signal):trail.geometry?Promise.resolve(trail.geometry):loadVerifiedRouteGeometry(trail.geometryUrl!,trailOverlayMetadata.sourceHashes,{load:loadPublicBytes,invalidate:invalidatePublicMapResource,signal:controller.signal});
    let active=true;
    const ownsSelection=()=>active&&map===engine.current&&latest.current.trail===trail&&latest.current.region===region;
    void load.then(async payload=>{
      if(!ownsSelection())return;
      let geometry:GeoJSON.GeoJSON;try{geometry=readRouteGeometry(payload);}catch(error){if(trail.geometryUrl)invalidatePublicMapResource(trail.geometryUrl);throw error;}
      const coastal=await verifyReviewedCoastalRoute(trail.geometryUrl,geometry);if(!ownsSelection())return;
      const coverage=map.getCoverage();if(!coverage)return;
      const bounds=coastal?coastal.bounds:coveredRussiaBounds(routeGeometryPositions(geometry),coverage.area) as GeographicBounds|null;
      shown.current={trail,geometry,bounds:bounds??undefined};map.setRoute(geometry,trail.id,coastal);
      setRouteLoading(false);setRouteError('');
      const pending=pendingRouteFit.current;pendingRouteFit.current=undefined;
      if(!bounds){note('У этой линии нет точек внутри доступного покрытия России. Карточка остаётся доступной.');return;}
      if(pending?.trail===trail&&pending.region===region&&pending.revision===navigation.current&&!manual.current){fullView.current=false;fitCurrent.current(true);}
    }).catch(()=>{if(ownsSelection()){
      shown.current={trail};setRouteLoading(false);
      const message='Линия маршрута не загрузилась. Проверьте подключение и повторите загрузку.';setRouteError(message);latest.current.onMapNote?.(message);
    }});
    return()=>{active=false;controller.abort();};
  },[region,trail,state.ready,routeAttempt,cancelLocation,note]);
  useEffect(()=>{refreshOverlay.current();},[visibleTrails,planning,paths,trail?.id,state.ready]);
  useEffect(()=>{
    const map=engine.current,coverage=map?.getCoverage();if(!map||!coverage||!state.ready)return;
    const counts=mapDirectionCounts(visibleTrails),markers:CustomMapMarker[]=planning?[]:regions.filter(item=>inRussiaCoverage(...item.center,coverage.area)).map(item=>({id:item.id,coordinate:item.center,label:item.name,kind:'direction',count:counts.get(item.id)||0,active:item.id===region?.id}));
    if(region&&!planning)markers.push(...mapTrailPointEntries(visibleTrails,(lng,lat)=>inRussiaCoverage(lng,lat,coverage.area),region,trail?.id).map(item=>({id:item.id,coordinate:item.center,label:item.title,kind:'trail' as const,active:item.selected})));
    if(planning&&planPoints)markers.push(...planPoints.map(point=>({id:point.id,coordinate:point.point,label:point.label,kind:'plan' as const,active:point.kind==='choice'})));
    if(position.current)markers.push({id:'current-position',coordinate:position.current,label:'Моё местоположение',kind:'position'});
    map.setMarkers(markers);
  },[visibleTrails,region,trail?.id,planPoints,planning,state.ready]);
  const changeMode=(mode:Extract<CustomMapMode,'detail'|'satellite'>)=>{
    const map=engine.current;if(!map)return;
    setDismissedError('');setStatus('');map.setPitch(0);
    if(mode==='detail'){setRelief(true);map.setLayers({relief:true});}
    map.setMode(mode);
  };
  const fitAll=()=>{navigation.current++;cancelLocation();manual.current=false;if(!planning||!shown.current.bounds)fullView.current=true;frame.current?.select(`fit-${navigation.current}`);fitCurrent.current(true);};
  const locate=()=>{
    const map=engine.current,coverage=map?.getCoverage();if(!map||!coverage)return;
    if(!navigator.geolocation){note('Геолокация не поддерживается.');return;}
    const epoch=++locationEpoch.current;locating.current=true;note('Определяем местоположение…');
    navigator.geolocation.getCurrentPosition(result=>{
      if(epoch!==locationEpoch.current||map!==engine.current)return;
      locating.current=false;
      const {longitude,latitude,accuracy}=result.coords;
      if(!inRussiaCoverage(longitude,latitude,coverage.area)){note('Местоположение находится за пределами доступной карты России.');return;}
      position.current=[longitude,latitude];map.setPosition(position.current);manual.current=true;fullView.current=false;frame.current?.cancel();map.setCamera({center:position.current,zoom:13},true);note(`Точность около ${Math.round(accuracy)} м. Позиция никому не передаётся.`);
    },()=>{if(epoch===locationEpoch.current&&map===engine.current){locating.current=false;note('Позиция недоступна. Проверьте разрешение и сигнал.');}},{enableHighAccuracy:true,timeout:MAP_CONFIG.geolocationTimeoutMs,maximumAge:MAP_CONFIG.geolocationMaximumAgeMs});
  };
  const retry=()=>{setDismissedError('');setStatus('');overlay.current?.retry();const current=shown.current;if(current.trail&&(current.trail.geometry||current.trail.geometryUrl)&&!current.geometry)setRouteAttempt(value=>value+1);engine.current?.retry();};
  const satellite=state.mode==='satellite',satelliteVisible=state.committedMode==='satellite',mapError=state.error!==dismissedError?state.error:'',error=mapError||routeError||overlayError||rasterError,message=error||status;
  const retryLabel=mapError?'Повторить загрузку карты':routeError?'Повторить загрузку маршрута':'Повторить загрузку троп',retryBusy=mapError?state.loading:routeError?routeLoading:false;
  const contours=!satellite&&relief&&state.reliefReady&&!state.loading?reliefContourIntervals(Math.min(18,Math.ceil(zoom))):null;
  // The imagery mode marker also covers a requested satellite layer. Source
  // identity and attribution describe only the ground actually on screen.
  return <div className="atlas-wrap tropnik-custom-atlas" data-map-renderer="tropnik" data-map-base-committed={state.committedMode} data-map-base-target={state.mode} data-map-base-state={state.loading||state.imageryLoading?'loading':'ready'} data-map-imagery={satellite||satelliteVisible?'satellite':undefined} data-map-imagery-source={satelliteVisible?state.imagerySource:undefined} data-map-imagery-target={satellite?state.imageryTarget:undefined} data-map-imagery-state={satellite||satelliteVisible?(state.imageryLoading?'loading':satelliteVisible?'ready':'loading'):undefined} data-map-detail={zoom>=ROUTE_PRESENTATION.closeZoom?'close':undefined} data-map-route={trail&&!planning?'selected':undefined}>
    <div ref={container} className="atlas-canvas tropnik-map-surface" role="region" aria-label="Интерактивная карта России"/>
    {!state.ready&&!message&&<div className="map-skeleton"><MapIcon name="compass" size={38}/><span>Открываем карту России</span></div>}
    {trail&&!planning?<MapRouteContext title={trail.title} caption={overviewContextCaption(state.mode,zoom,false)}/>:<div className="map-context"><span className="live-dot"/><span>{planning?'План похода':region?.name||'Россия'}</span><span className="context-divider"/><span>{satellite?'Спутник':planning?'Выбранные участки':region?'Рельеф':routeCountLabel(visibleTrails.length)}</span></div>}
    <div className="map-style-switch"><button aria-label="Рельеф" aria-pressed={!satellite} disabled={!state.ready} className={!satellite?'active':''} onClick={()=>changeMode('detail')} title="Рельеф, тропы и линии высот"><MapIcon name="terrain" size={19}/>Рельеф</button><button aria-label="Спутник" aria-pressed={satellite} disabled={offline||!state.ready} className={satellite?'active':''} onClick={()=>changeMode('satellite')} title={offline?'Спутниковые снимки доступны при подключении к интернету':'Спутниковые снимки с маршрутами'}><MapIcon name="satellite" size={18}/>Спутник</button></div>
    <div className="map-controls"><button aria-label="Увеличить масштаб" disabled={!state.ready} onClick={()=>engine.current?.zoomBy(1)}><MapIcon name="plus" size={20}/></button><button aria-label="Уменьшить масштаб" disabled={!state.ready} onClick={()=>engine.current?.zoomBy(-1)}><MapIcon name="minus" size={20}/></button><span/><button aria-label="Север сверху" onClick={()=>engine.current?.north()}><MapIcon name="compass" size={22}/></button><button aria-label="Моё местоположение" disabled={!state.ready} onClick={locate}><MapIcon name="location" size={21}/></button><button aria-label={planning&&trail?'Показать поход целиком':'Показать Россию целиком'} disabled={!state.ready} onClick={fitAll}><MapIcon name="fit" size={19}/></button></div>
    <div className="layer-control"><button className={layers?'layer-button active':'layer-button'} aria-expanded={layers} onClick={()=>setLayers(!layers)}><MapIcon name="layers" size={20}/>Слои</button>{layers&&<div className="layer-menu"><strong>Ваша карта</strong><label><input type="checkbox" checked={paths} onChange={event=>{setPaths(event.target.checked);engine.current?.setLayers({paths:event.target.checked});}}/>Тропы и грунтовые дороги</label><label><input type="checkbox" checked={relief} onChange={event=>{setRelief(event.target.checked);engine.current?.setLayers({relief:event.target.checked});}}/>Рельеф и линии высот</label><label><input type="checkbox" checked={boundaries} onChange={event=>{setBoundaries(event.target.checked);engine.current?.setLayers({boundaries:event.target.checked});}}/>Границы территорий</label><a href="/offline">Подробная офлайн-карта</a><a href="/sources">Источники карты</a></div>}</div>
    {message&&(!planning||error)&&<div className={`map-message${error?' map-message--error':''}`} role="status"><MapIcon name="info" size={18}/>{error?<div className="map-message-copy"><p>{message}</p><div className="map-message-actions"><button type="button" onClick={retry} disabled={retryBusy} aria-label={retryLabel}>{retryBusy?'Загружаем…':'Повторить загрузку'}</button>{state.ready&&<button type="button" onClick={()=>{setDismissedError(state.error);setRouteError('');setOverlayError('');setRasterError('');}}>Закрыть</button>}</div></div>:<><span>{message}</span><button type="button" onClick={()=>setStatus('')}>Понятно</button></>}</div>}
    <MapFooter loading={state.loading&&state.ready&&!message}>
      {!planning&&<div className="map-legend"><span className="map-scale" title="Расстояние у центра карты"><span ref={scaleValue}/><span ref={scaleLine} className="map-scale-line"/></span><span className="map-legend-key"><span className="legend-line"/>Маршрут</span>{contours?<span className="map-legend-key" title={`Основные линии высот — через ${contours.indexM} м`}><span className="map-contour-key"/>Горизонтали · {contours.minorM} м</span>:<span className="map-legend-key"><span className="legend-region"/>Направление</span>}</div>}
      <MapAttribution ready={state.ready} terrain={state.reliefReady} satellite={satelliteVisible} satelliteSource={state.imagerySource??'eox-s2'} satelliteLoading={satellite&&state.imageryLoading} zoom={zoom}/>
    </MapFooter>
  </div>;
});
