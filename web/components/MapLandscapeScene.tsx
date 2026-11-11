'use client';
import type * as GeoJSON from 'geojson';
import {useEffect,useRef,useState} from 'react';
import {MapIcon} from './MapIcon';
import {MapAttribution} from './MapAttribution';
import {createCustomLandscapeLoader} from '@/lib/custom-map-landscape';
import {createLandscapeSurface} from '@/lib/custom-map-surface';
import {observeTerrainViewport} from '@/lib/terrain-viewport';
import type {GeographicBounds} from '@/lib/custom-map-camera';
import type {TerrainRenderer,TerrainGrid,TerrainRenderInfo} from '@/public/terrain/terrain-renderer.js';

export function MapLandscapeScene({bounds,title,geometry,onClose}:{bounds:GeographicBounds;title:string;geometry?:GeoJSON.GeoJSON;onClose:()=>void}){
  const root=useRef<HTMLElement>(null),canvas=useRef<HTMLCanvasElement>(null),renderer=useRef<TerrainRenderer|null>(null);
  const loader=useRef<ReturnType<typeof createCustomLandscapeLoader>|null>(null);
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[info,setInfo]=useState(false),[grid,setGrid]=useState<TerrainGrid|null>(null),[surfaceReady,setSurfaceReady]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{loader.current=createCustomLandscapeLoader();return()=>{loader.current?.dispose();loader.current=null;};},[]);
  useEffect(()=>{
    let active=true,disposeViewport:(()=>void)|undefined;const controller=new AbortController(),source=loader.current;
    if(!source)return;
    // Each area owns a bounded source/model lifecycle, including retries.
    setReady(false);setError('');setSurfaceReady(false);
    const inspection:{schemaVersion:number;engine:string;state:string;requestedBounds:number[];frames:number;frame:TerrainRenderInfo|null;grid?:unknown;provenance?:unknown;cartography?:unknown}={schemaVersion:1,engine:'tropnik-terrain',state:'loading',requestedBounds:[...bounds],frames:0,frame:null};
    const publish=()=>{if(active&&root.current)root.current.dataset.terrainInspection=JSON.stringify(inspection);};publish();
    void source.load(bounds,{signal:controller.signal}).then(async result=>{
      if(!active||!canvas.current)return;
      const [module,data,preparedModel]=result.prepared;setGrid(data);
      inspection.grid={bounds:data.bounds,width:data.width,height:data.height,minElevation:data.minElevation,maxElevation:data.maxElevation,sampleSpacingApproxM:data.sampleSpacingApproxM,source:data.source};inspection.provenance=result.provenance;inspection.cartography={state:'loading'};publish();
      const target=new module.TerrainRenderer(canvas.current,data,{compactViewport:true,preparedModel,onRender:frame=>{if(active){inspection.state='ready';inspection.frames++;inspection.frame=frame;publish();setReady(true);setError('');}},onError:()=>{if(active){inspection.state='recovering';publish();setError('Восстанавливаем изображение…');}},onFatal:()=>{if(active){inspection.state='failed';publish();setReady(false);setError('Не удалось показать ландшафт. Повторите открытие.');}}});
      renderer.current=target;if(geometry)target.setGeometry(geometry);if(root.current)disposeViewport=observeTerrainViewport(root.current,target);target.warmup();
      try{
        const surface=await createLandscapeSurface(data,{signal:controller.signal});
        if(active&&renderer.current===target){target.setCartography(surface);inspection.cartography={state:surface.source.loadedTiles>0?'ready':'unavailable',width:surface.width,height:surface.height,source:surface.source};publish();setSurfaceReady(surface.source.loadedTiles>0);target.warmup();}
      }catch{if(active){inspection.cartography={state:'unavailable'};publish();}/* Real relief remains useful when thematic source tiles are unavailable. */}
    }).catch(()=>{if(active){inspection.state='failed';publish();setError('Данные высот этого участка недоступны. Проверьте сеть или откройте заранее сохранённый район.');}});
    return()=>{active=false;controller.abort();disposeViewport?.();renderer.current?.destroy();renderer.current=null;};
  },[bounds,geometry,attempt]);
  return <section ref={root} className={`terrain-scene is-visible ${ready?'is-ready':''}`} aria-label={`Объёмный ландшафт: ${title}`}>
    <canvas key={attempt} ref={canvas} className="terrain-canvas" tabIndex={0} aria-label="Трёхмерный ландшафт: перетаскивание поворачивает, колёсико и жест двумя пальцами меняют масштаб."/>
    <div className="terrain-heading"><span className="eyebrow caption-3">Рельеф местности</span><h2 className="heading-2">{title}</h2><p className="caption-2">{surfaceReady?'Лес, вода и тропы на реальном рельефе':'Форма местности по данным высот'}</p></div>
    <div className="terrain-controls" aria-label="Управление ландшафтом"><button aria-label="Вернуться к карте" onClick={onClose}><MapIcon name="back"/></button><span/><button aria-label="Приблизить ландшафт" onClick={()=>renderer.current?.zoomBy(1.2)}><MapIcon name="plus"/></button><button aria-label="Отдалить ландшафт" onClick={()=>renderer.current?.zoomBy(1/1.2)}><MapIcon name="minus"/></button><button aria-label="Повернуть ландшафт" onClick={()=>renderer.current?.rotate(.25)}><MapIcon name="rotate"/></button><button aria-label="Вернуть исходный ракурс" onClick={()=>renderer.current?.reset()}><MapIcon name="fit"/></button><button aria-label="О данных рельефа" aria-expanded={info} onClick={()=>setInfo(!info)}><MapIcon name="info"/></button></div>
    {!ready&&!error&&<div className="terrain-loading" role="status"><MapIcon name="terrain" size={48}/><strong className="title-3">Собираем ландшафт этого участка</strong><span className="caption-2">Высоты, освещение и линия маршрута</span><div className="terrain-loading-track"/></div>}
    {error&&<div className="terrain-progress" role="status"><MapIcon name="info"/><span>{error}</span>{!ready&&<button className="text-link" onClick={()=>setAttempt(value=>value+1)}>Повторить</button>}</div>}
    {info&&<div className="terrain-info"><strong className="title-3">Данные этого ландшафта</strong><p className="body-6">Форма поверхности рассчитана по цифровой модели высот. Высоты не преувеличены. Цвет лесов, воды и дорог берётся из картографических данных там, где они доступны; это не спутниковая съёмка.</p>{grid&&<p className="body-6">Сетка {grid.width} × {grid.height}. Высоты {Math.round(grid.minElevation)}–{Math.round(grid.maxElevation)} м. {grid.sampleSpacingApproxM&&`Шаг отображения около ${Math.round(grid.sampleSpacingApproxM.eastWest)} × ${Math.round(grid.sampleSpacingApproxM.northSouth)} м.`}</p>}<p className="body-6">Детализация зависит от исходных данных. Модель не подтверждает проходимость и текущее состояние троп.</p><a className="text-link" href="/sources">Источники и лицензии</a></div>}
    <div className="terrain-bottom"><span className="terrain-live caption-3">{ready?'Ландшафт готов':'Загрузка высот'}</span><span className="caption-2">Поворачивайте и приближайте карту</span></div><MapAttribution ready={ready} terrain/>
  </section>;
}
