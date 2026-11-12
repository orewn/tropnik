'use client';
import type * as GeoJSON from 'geojson';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {MapIcon} from './MapIcon';
import {MapAttribution} from './MapAttribution';
import {createCustomLandscapeLoader} from '@/lib/custom-map-landscape';
import {createLandscapeSurface,type LandscapeSurface} from '@/lib/custom-map-surface';
import {prepareLandscapeDisplayMask} from '@/lib/custom-map-mask';
import {openingTerrainView,planTerrainNavigation} from '@/lib/terrain-navigation';
import {observeTerrainViewport,readTerrainViewport,type TerrainViewport} from '@/lib/terrain-viewport';
import type {GeographicBounds} from '@/lib/custom-map-camera';
import type {TerrainRenderer,TerrainGrid,TerrainRenderInfo,TerrainGeographicView,TerrainViewInput} from '@/public/terrain/terrain-renderer.js';

export type LandscapeRouteStatus='loading'|'ready'|'unavailable';
export type LandscapeMarker={id:string;coordinate:readonly number[];label:string;kind:'trail'|'direction';active?:boolean};

type Props={bounds:GeographicBounds;title:string;geometry?:GeoJSON.GeoJSON;routeStatus?:LandscapeRouteStatus;
  markers?:LandscapeMarker[];onMarker?:(id:string)=>void;onViewChange?:(view:TerrainGeographicView)=>void;onClose:()=>void};
const NO_MARKERS:LandscapeMarker[]=[];

export function MapLandscapeScene({bounds,title,geometry,routeStatus,markers=NO_MARKERS,onMarker,onViewChange,onClose}:Props){
  const root=useRef<HTMLElement>(null),canvas=useRef<HTMLCanvasElement>(null),renderer=useRef<TerrainRenderer|null>(null);
  const loader=useRef<ReturnType<typeof createCustomLandscapeLoader>|null>(null);
  const route=useRef({geometry,routeStatus}),syncRoute=useRef<(()=>void)|undefined>(undefined);
  const callbacks=useRef({onViewChange,onMarker}),markerData=useRef(markers),markerElements=useRef(new Map<string,HTMLButtonElement>());
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[routeWarning,setRouteWarning]=useState(''),[info,setInfo]=useState(false);
  const [grid,setGrid]=useState<TerrainGrid|null>(null),[surface,setSurface]=useState<LandscapeSurface['source']|null>(null),[attempt,setAttempt]=useState(0),[updating,setUpdating]=useState(false);
  useLayoutEffect(()=>{callbacks.current={onViewChange,onMarker};markerData.current=markers;renderer.current?.warmup();},[onViewChange,onMarker,markers]);
  // Route changes never rebuild the measured terrain or reset a browsed camera.
  useLayoutEffect(()=>{route.current={geometry,routeStatus};syncRoute.current?.();},[geometry,routeStatus]);
  useEffect(()=>{loader.current=createCustomLandscapeLoader();return()=>{loader.current?.dispose();loader.current=null;};},[]);
  useEffect(()=>{
    let active=true,disposeViewport:(()=>void)|undefined,target:TerrainRenderer|null=null,revision=0;
    let controller:AbortController|null=null,currentGrid:TerrainGrid|null=null,line:{segments:number;clipped:boolean}|undefined,pendingWindow=false;
    const source=loader.current;if(!source)return;
    setReady(false);setError('');setRouteWarning('');setGrid(null);setSurface(null);setUpdating(false);
    let currentViewport:TerrainViewport=root.current?readTerrainViewport(root.current):{width:800,height:600,insets:{top:0,right:0,bottom:0,left:0}};
    const inspection:{schemaVersion:number;engine:string;state:string;navigation:string;contextBounds:number[];requestedBounds:number[];loadedRequestBounds:number[]|null;loadingWindow:boolean;requestedWindowRevision:number;frames:number;frame:TerrainRenderInfo|null;grid?:unknown;provenance?:unknown;cartography?:unknown;route?:unknown;displayMask?:unknown;view?:TerrainGeographicView;windowRevision:number;viewport:TerrainViewport;requestedViewport?:TerrainViewport;loadedViewport?:TerrainViewport}={schemaVersion:2,engine:'tropnik-terrain',state:'loading',navigation:'continuous-map',contextBounds:[...bounds],requestedBounds:[...bounds],loadedRequestBounds:null,loadingWindow:true,requestedWindowRevision:0,frames:0,frame:null,windowRevision:0,displayMask:{state:'loading'},viewport:currentViewport};
    const publish=()=>{if(active&&root.current)root.current.dataset.terrainInspection=JSON.stringify(inspection);};publish();
    const viewport=()=>currentViewport;
    const describeRoute=(renderedSegments?:number)=>{
      const current=route.current,hasLine=!!current.geometry;
      const state=!hasLine?(current.routeStatus||'none'):!line?.segments?'unavailable':renderedSegments===0?'render-failed':line.clipped?'partial':'ready';
      inspection.route={state,preparedSegments:line?.segments??0,renderedSegments:renderedSegments??null,clipped:line?.clipped??false};
      setRouteWarning(state==='loading'?'Линия маршрута загружается. Пока можно осмотреть ландшафт.':
        state==='unavailable'?(hasLine?'Маршрут за пределами текущего ракурса. Верните исходный вид, чтобы увидеть его.':'Линия этого маршрута недоступна. Ландшафт можно осмотреть без неё.'):
        state==='render-failed'?'Не удалось отрисовать линию маршрута. Ландшафт доступен; маршрут можно открыть на основной карте.':
        state==='partial'?'Часть маршрута за пределами текущего участка. Отдалите карту или переместитесь вдоль линии.':'');
    };
    const updateRoute=()=>{if(active&&target){line=target.setGeometry(route.current.geometry);describeRoute();publish();}};
    syncRoute.current=updateRoute;
    const paintMarkers=()=>{
      if(!target)return;
      const {width,height}=viewport(),occupied:Array<{x:number;y:number;w:number}>=[];
      const ordered=[...markerData.current].sort((a,b)=>Number(!!b.active)-Number(!!a.active));
      for(const marker of ordered){
        const element=markerElements.current.get(marker.id);if(!element)continue;
        const point=target.project(marker.coordinate[0],marker.coordinate[1]),w=Math.min(200,36+marker.label.length*7);
        const hidden=!point||point.x<24||point.x>width-w-24||point.y<96||point.y>height-100||occupied.length>=(width<700?8:20)||occupied.some(p=>Math.abs(p.y-point.y)<40&&point.x<p.x+p.w+12&&point.x+w+12>p.x);
        element.hidden=hidden;
        if(!hidden&&point){element.style.transform=`translate(${Math.round(point.x)}px,${Math.round(point.y)}px)`;occupied.push({x:point.x,y:point.y,w});}
      }
    };
    const navigate=(view:TerrainGeographicView)=>{
      if(!active||!currentGrid)return;
      callbacks.current.onViewChange?.(view);inspection.view=view;
      const spacing=Math.max(Number(currentGrid.source?.sourceNominalResolutionM)||30,currentGrid.sampleSpacingApproxM?.eastWest||30,currentGrid.sampleSpacingApproxM?.northSouth||30);
      const next=planTerrainNavigation(view,currentGrid.bounds,viewport(),spacing);
      // A new gesture supersedes a pending window even when the user returns
      // into the already loaded patch and no replacement is now necessary.
      if(pendingWindow){revision++;controller?.abort();pendingWindow=false;inspection.loadingWindow=false;inspection.requestedBounds=[...(inspection.loadedRequestBounds??inspection.contextBounds)];inspection.requestedWindowRevision=inspection.windowRevision;inspection.requestedViewport=inspection.loadedViewport;setUpdating(false);}
      if(next){target?.setView(next.view);void loadWindow(next.bounds,next.view);}else publish();
    };
    const draw=(frame:TerrainRenderInfo)=>{
      if(!active)return;
      const visible=root.current?.querySelector<HTMLCanvasElement>('canvas.terrain-canvas'),rendered=visible?.dataset.routeRenderSegments;
      describeRoute(rendered===undefined?undefined:Number(rendered));if(inspection.state==='recovering')setError('');inspection.state='ready';inspection.frames++;inspection.frame=frame;
      if(frame.viewport)inspection.viewport=frame.viewport;
      if(target){inspection.view=frame.geographicView??target.getView();callbacks.current.onViewChange?.(inspection.view);}
      publish();paintMarkers();setReady(true);
    };
    async function loadWindow(requested:GeographicBounds,view?:TerrainViewInput){
      const job=++revision;controller?.abort();const request=new AbortController();controller=request;
      const owns=()=>active&&job===revision&&!request.signal.aborted;
      const retained=!!target;pendingWindow=retained;setUpdating(retained);setError('');inspection.requestedBounds=[...requested];inspection.requestedViewport=currentViewport;inspection.loadingWindow=true;inspection.requestedWindowRevision=job;publish();
      let maskFailed=false;
      try{
        const result=await source!.load(requested,{signal:request.signal,preferRegional:true});if(!owns())return;
        const [module,data,preparedModel]=result.prepared;
        // A native regional extract can be larger than the requested window.
        // The display mask always refers to the actual DEM, never stale bounds.
        const maskPromise=prepareLandscapeDisplayMask(data.bounds,{signal:request.signal}).catch(error=>{maskFailed=true;throw error;});
        const surfacePromise=createLandscapeSurface(data,{signal:request.signal}).catch(()=>null);
        const displayMask=await maskPromise;if(!owns()||!canvas.current)return;
        if(!displayMask.source.allowedPixels){maskFailed=true;throw new Error('Landscape is outside the display area');}
        const readySurface=retained?await surfacePromise:null;if(!owns())return;
        if(target){target.setTerrain(data,{preparedModel,displayMask});}
        else{
          target=new module.TerrainRenderer(canvas.current,data,{navigation:'map',compactViewport:true,preparedModel,displayMask,viewportInsets:currentViewport.insets,
            initialView:view??openingTerrainView(bounds,viewport()),onViewChange:navigate,onRender:draw,
            onError:message=>{if(active){inspection.state='recovering';publish();setError(message);}},
            onFatal:()=>{if(active){inspection.state='failed';publish();setReady(false);setError('Не удалось показать ландшафт. Повторите открытие.');}}});
          renderer.current=target;
        }
        currentGrid=data;setGrid(data);setSurface(null);updateRoute();
        inspection.loadedRequestBounds=[...requested];inspection.loadedViewport=inspection.requestedViewport;inspection.windowRevision=job;inspection.loadingWindow=false;
        inspection.grid={bounds:data.bounds,width:data.width,height:data.height,minElevation:data.minElevation,maxElevation:data.maxElevation,sampleSpacingApproxM:data.sampleSpacingApproxM,source:data.source};
        inspection.provenance=result.provenance;inspection.cartography={state:'loading'};
        inspection.displayMask={state:'ready',width:displayMask.width,height:displayMask.height,source:displayMask.source};publish();
        const applySurface=(value:LandscapeSurface|null)=>{
          if(!owns()||!target)return;
          if(value&&value.source.complete&&value.source.loadedTiles>0){target.setCartography(value);setSurface(value.source);inspection.cartography={state:'ready',width:value.width,height:value.height,source:value.source};}
          else inspection.cartography={state:'unavailable'};
          publish();target.warmup();
        };
        if(retained)applySurface(readySurface);else void surfacePromise.then(applySurface);
        target.warmup();pendingWindow=false;setUpdating(false);
      }catch{
        if(!owns())return;
        request.abort();pendingWindow=false;
        inspection.state=retained?'ready':'failed';inspection.loadingWindow=false;if(retained){inspection.requestedBounds=[...(inspection.loadedRequestBounds??inspection.contextBounds)];inspection.requestedWindowRevision=inspection.windowRevision;inspection.requestedViewport=inspection.loadedViewport;}if(maskFailed&&!retained)inspection.displayMask={state:'failed'};publish();setUpdating(false);
        setError(retained?'Соседний участок пока не загрузился. Предыдущий ландшафт сохранён. Повторите движение при устойчивой связи.':maskFailed?'Не удалось подготовить границы этого участка. Проверьте сеть и повторите открытие.':'Данные высот этого участка недоступны. Проверьте сеть или откройте заранее сохранённый район.');
      }
    }
    const initial=openingTerrainView(bounds,viewport());
    const loadOpening=()=>{const opening=planTerrainNavigation(initial,bounds,viewport());void loadWindow(opening?.bounds??bounds,opening?.view??initial);};
    let started=false;
    // Observe while the first DEM is loading too. A resized or moved sheet must
    // not let an obsolete source envelope become the first visible frame.
    if(root.current)disposeViewport=observeTerrainViewport(root.current,{setViewportInsets:insets=>target?.setViewportInsets(insets),warmup:()=>target?.warmup()},next=>{
      currentViewport=next;inspection.viewport=next;
      if(!started)return;
      if(target)navigate(target.getView());else loadOpening();
    });
    started=true;loadOpening();
    return()=>{active=false;revision++;syncRoute.current=undefined;controller?.abort();disposeViewport?.();target?.destroy();if(renderer.current===target)renderer.current=null;};
  },[bounds,attempt]);
  const sourceCaption=surface?.kind==='landcover'?'Лес, вода и открытая местность':surface?.kind==='imagery'?'Реальная поверхность и объёмный рельеф':'Рельеф по измеренным высотам';
  return <section ref={root} className={`terrain-scene terrain-map is-visible ${ready?'is-ready':''}`} aria-label={`Объёмный ландшафт: ${title}`}>
    <canvas key={attempt} ref={canvas} className="terrain-canvas" tabIndex={0} aria-label="Трёхмерная карта: перетаскивание перемещает, правая кнопка или Shift поворачивает, колёсико и жест двумя пальцами меняют масштаб."/>
    <div className="terrain-heading"><span className="eyebrow caption-3">Объёмная карта</span><h2 className="title-3">{title}</h2><p className="caption-2">{sourceCaption}</p></div>
    <div className="terrain-map-markers" aria-label="Маршруты на объёмной карте">{markers.map(marker=><button key={marker.id} ref={element=>{if(element)markerElements.current.set(marker.id,element);else markerElements.current.delete(marker.id);}} className={`terrain-map-marker ${marker.kind} ${marker.active?'is-active':''}`} hidden aria-label={marker.label} onClick={()=>callbacks.current.onMarker?.(marker.id)}><MapIcon name={marker.kind==='direction'?'terrain':'compass'} size={20}/><span>{marker.label}</span></button>)}</div>
    <div className="terrain-controls" aria-label="Управление ландшафтом"><button aria-label="Вернуться к карте" onClick={onClose}><MapIcon name="back"/></button><span/><button aria-label="Приблизить ландшафт" onClick={()=>renderer.current?.zoomBy(1.4)}><MapIcon name="plus"/></button><button aria-label="Отдалить ландшафт" onClick={()=>renderer.current?.zoomBy(1/1.4)}><MapIcon name="minus"/></button><button aria-label="Повернуть ландшафт" onClick={()=>renderer.current?.rotate(.25)}><MapIcon name="rotate"/></button><button aria-label="Вернуть исходный ракурс" onClick={()=>setAttempt(value=>value+1)}><MapIcon name="fit"/></button><button aria-label="О данных рельефа" aria-expanded={info} onClick={()=>setInfo(!info)}><MapIcon name="info"/></button></div>
    {!ready&&!error&&<div className="terrain-loading" role="status"><MapIcon name="terrain" size={48}/><strong className="title-3">Открываем объёмную карту</strong><span className="caption-2">Подготавливаем реальные высоты и поверхность</span><div className="terrain-loading-track"/></div>}
    {updating&&ready&&!error&&<div className="terrain-stream-status caption-3" role="status">Подгружаем соседний участок</div>}
    {(error||routeWarning)&&<div className="terrain-progress" data-terrain-status={error?'renderer-error':'route-warning'} role="status"><MapIcon name="info"/><span>{error||routeWarning}</span>{error&&!ready&&<button className="text-link" onClick={()=>setAttempt(value=>value+1)}>Повторить</button>}</div>}
    {info&&<div className="terrain-info"><strong className="title-3">Данные этого ландшафта</strong><p className="body-6">Форма поверхности рассчитана по цифровой модели высот. Масштаб высот 1:1. {surface?.kind==='landcover'?'Цвета показывают классы покрытия земли WorldCover 2021: лес, воду, застройку и открытую поверхность.':surface?.kind==='imagery'?'Поверхность показывает публичную спутниковую мозаику. Съёмка историческая, не в реальном времени.':'Пока доступен только рельеф. Цвета высот не обозначают фактическое покрытие земли.'}</p>{grid&&<p className="body-6">Высоты {Math.round(grid.minElevation)}–{Math.round(grid.maxElevation)} м. {grid.sampleSpacingApproxM&&`Шаг сетки около ${Math.round(grid.sampleSpacingApproxM.eastWest)} × ${Math.round(grid.sampleSpacingApproxM.northSouth)} м.`}</p>}<p className="body-6">Детализация определяется исходными измерениями. Модель не подтверждает проходимость троп.</p><a className="text-link" href="/sources#terrain-public-data">Источники и лицензии</a></div>}
    <div className="terrain-bottom"><span className="terrain-live caption-3">{updating?'Загрузка участка':ready?'3D карта':'Загрузка высот'}</span><span className="caption-2">Перетаскивайте карту · Shift для поворота</span></div>
    <MapAttribution ready={ready} terrain vector={false} routeData={!!geometry} satellite={surface?.kind==='imagery'} satelliteSource={surface?.provider??'eox-s2'} landcover={surface?.kind==='landcover'}/>
  </section>;
}
