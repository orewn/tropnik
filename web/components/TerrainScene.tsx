"use client";
import {MapIcon} from './MapIcon';
import {MapAttribution} from './MapAttribution';
import {ArrowSquareOut} from './TropnikIcons';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {Trail} from '@/lib/content';
import type {TerrainRenderer,TerrainGrid} from '@/public/terrain/terrain-renderer.js';
import {loadTerrain,loadPublicJSON,TERRAIN_BOUNDS} from '@/lib/map-preload';

type SceneRenderer = TerrainRenderer & {setVisible?: (visible: boolean) => void};
const readableSceneError=(message:string)=>message.startsWith('Графический контекст прерван')?'Восстанавливаем изображение…':message.startsWith('Геометрия не помещается')?'Не удалось показать линию маршрута на рельефе. Откройте её на основной карте.':'Не удалось показать рельеф. Попробуйте открыть его заново.';
export function TerrainScene({trail,onClose,visible=true}:{trail?:Trail;onClose:()=>void;visible?:boolean}) {
 const surface=useRef<HTMLElement>(null);
 const canvas=useRef<HTMLCanvasElement>(null),renderer=useRef<SceneRenderer|null>(null),visibility=useRef(visible);
 const [phase,setPhase]=useState('Открываем рельеф…'),[error,setError]=useState(''),[source,setSource]=useState<TerrainGrid['source']|null>(null),[info,setInfo]=useState(false),[ready,setReady]=useState(false),[attempt,setAttempt]=useState(0),[revision,setRevision]=useState(0);
 useLayoutEffect(()=>{visibility.current=visible;},[visible]);
 useEffect(()=>{
  let stale=false,failed=false,first=true,owned:SceneRenderer|null=null;const consumer=new AbortController();
  // Reset the external renderer's lifecycle state before a fresh load/retry.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  setError('');setReady(false);setPhase('Открываем рельеф…');
  loadTerrain(consumer.signal).then(([module,grid,preparedModel])=>{
   if(stale||!canvas.current)return;
   setSource(grid.source);setPhase('Открываем рельеф…');
   owned=new module.TerrainRenderer(canvas.current,grid,{compactViewport:true,preparedModel,onRender:()=>{
    if(stale||failed)return;
    if(first){first=false;setPhase('');setReady(true);}
    setError(current=>current==='Восстанавливаем изображение…'?'':current);
   },onError:message=>{if(!stale&&!failed)setError(readableSceneError(message));},onFatal:message=>{
    if(stale||failed)return;failed=true;setReady(false);setPhase('');setError(readableSceneError(message));
   }});
   renderer.current=owned;
   renderer.current.setVisible?.(visibility.current);
   renderer.current.warmup();
   setRevision(v=>v+1);
  }).catch(()=>{if(!stale)setError('Не удалось открыть рельеф. Проверьте подключение и попробуйте ещё раз.');});
  return()=>{stale=true;consumer.abort();owned?.destroy();if(renderer.current===owned)renderer.current=null;};
 },[attempt]);
 useEffect(()=>{renderer.current?.setVisible?.(visible);},[visible]);
 useEffect(()=>{
  const element=surface.current,target=renderer.current;
  if(!element||!target)return;
  const panel=element.closest('.explore-layout')?.querySelector('.explore-panel');
  let last='';
  const fit=()=>{
   const area=element.getBoundingClientRect(),drawer=panel?.getBoundingClientRect();
   const overlaps=drawer&&drawer.right>area.left&&drawer.left<area.right&&drawer.top<area.bottom&&drawer.bottom>area.top;
   const covered=overlaps?Math.min(area.height,Math.max(0,area.bottom-Math.max(area.top,drawer.top))):0;
   const narrow=area.width<700;
   const insets={top:narrow?192:176,right:narrow?64:80,bottom:covered?covered+16:64,left:narrow?16:32};
   const key=JSON.stringify(insets);
   if(key!==last){last=key;target.setViewportInsets(insets);target.warmup();}
  };
  fit();
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(fit);
  observer?.observe(element);if(panel)observer?.observe(panel);
  window.addEventListener('resize',fit);
  return()=>{observer?.disconnect();window.removeEventListener('resize',fit);};
 },[revision]);
 useEffect(()=>{
  let stale=false;
  const target=renderer.current;if(!target)return;
  target.setGeometry({type:'FeatureCollection',features:[]});
  const geometry=trail?.geometry?Promise.resolve(trail.geometry):trail?.geometryUrl?loadPublicJSON<unknown>(trail.geometryUrl):null;
  geometry?.then((value:unknown)=>{
   if(stale||target!==renderer.current)return;
   const data=value as {data?:{geometry?:unknown}};
   setError(current=>current.startsWith('Нитка маршрута')||current.startsWith('Не удалось показать линию маршрута')?'':current);
   target.setGeometry(data?.data?.geometry||value);
   target.warmup();
  }).catch(()=>{if(!stale)setError('Нитка маршрута не загрузилась. Ландшафт доступен, повторите открытие маршрута при устойчивой связи.');});
  return()=>{stale=true;};
 },[trail?.id,trail?.geometryUrl,trail?.geometry,revision]);
 const b=trail?.bbox;
 const partial=!!b&&(b[0]<TERRAIN_BOUNDS[0]||b[1]<TERRAIN_BOUNDS[1]||b[2]>TERRAIN_BOUNDS[2]||b[3]>TERRAIN_BOUNDS[3]);
 const retry=()=>{
  // Restore any fallback replacement before React replaces its keyed canvas.
  renderer.current?.destroy();renderer.current=null;
  setReady(false);setError('');setAttempt(value=>value+1);
 };
 return <section ref={surface} className={`terrain-scene ${visible?'is-visible':'is-warming'} ${ready?'is-ready':''}`} aria-label="Объёмный ландшафт Бзерпинского района" aria-hidden={!visible} inert={!visible}>
  <canvas key={attempt} ref={canvas} className="terrain-canvas" tabIndex={visible?0:-1} aria-label="Трёхмерный рельеф: поворот перетаскиванием или стрелками, масштаб жестом двумя пальцами, колёсиком или клавишами плюс и минус."/>
  <div className="terrain-heading"><span className="eyebrow caption-3">Западный Кавказ</span><h2 className="heading-2">Бзерпинский<br/>карниз</h2><p className="caption-2">Увидеть маршрут среди гор</p></div>
  <div className="terrain-controls" aria-label="Управление ландшафтом">
   <button onClick={onClose} aria-label="Вернуться к карте" title="Вернуться к карте"><MapIcon name="back"/></button><span/>
   <button aria-label="Приблизить ландшафт" onClick={()=>renderer.current?.zoomBy(1.2)}><MapIcon name="plus"/></button>
   <button aria-label="Отдалить ландшафт" onClick={()=>renderer.current?.zoomBy(1/1.2)}><MapIcon name="minus"/></button>
   <button aria-label="Повернуть ландшафт" onClick={()=>renderer.current?.rotate(.25)}><MapIcon name="rotate"/></button>
   <button aria-label="Вернуть исходный ракурс" onClick={()=>renderer.current?.reset()}><MapIcon name="fit"/></button>
   <button aria-label="О данных рельефа" aria-expanded={info} onClick={()=>setInfo(!info)}><MapIcon name="info"/></button>
  </div>
  {!ready&&!error&&<div className="terrain-loading" role="status"><div className="terrain-loading-contours" aria-hidden="true"><MapIcon name="terrain" size={48}/></div><strong className="title-3">{phase}</strong><span className="caption-2">Можно поворачивать и приближать карту</span><div className="terrain-loading-track" aria-hidden="true"/></div>}
  {error&&<div className="terrain-progress" role="status"><MapIcon name="info"/><span>{error}</span>{!ready&&<button className="text-link" onClick={retry}>Подготовить заново</button>}</div>}
  {info&&<div className="terrain-info"><strong className="title-3">Как устроен этот ландшафт</strong><p className="body-6">Форма гор взята из цифровой модели высот. Цвет и фактура условные: это не спутниковая съёмка. Высоты показаны без преувеличения. Срез по краю — условное оформление границы модели.</p><p className="body-6">Свет и тени меняются автоматически вместе с камерой. Перетаскивайте карту или используйте стрелки. Масштаб — колёсиком, жестом двумя пальцами или кнопками.</p><p className="body-6">Сцена охватывает только Бзерпинский район. Она не определяет проходимость и актуальное состояние троп.</p><a className="caption-2" href={source?.url||'/sources'} target="_blank" rel="noreferrer">{source?.name||'Источник высот'} <ArrowSquareOut size={18}/></a></div>}
  <div className="terrain-bottom"><span className="terrain-live caption-3">{ready?'Бзерпинский карниз':'Открываем рельеф…'}</span><span className="caption-2">{partial?'Показан участок маршрута в пределах сцены':'Поворачивайте и приближайте карту.'}</span></div>
  <MapAttribution ready={ready&&visible} terrain/>
 </section>;
}
