'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {MapIcon} from './MapIcon';

/** Show the data credit on first display, then keep it available through a labelled map control. */
export function MapAttribution({ready=true,terrain=false}:{ready?:boolean;terrain?:boolean}) {
  const [expanded,setExpanded]=useState(true),[pinned,setPinned]=useState(false);
  const ref=useRef<HTMLDivElement>(null),id=useId();
  useEffect(()=>{
    if(!ready||pinned)return;
    const timer=setTimeout(()=>{
      if(ref.current?.matches(':hover')||ref.current?.contains(document.activeElement)){setPinned(true);return;}
      setExpanded(false);
    },8000);
    return()=>clearTimeout(timer);
  },[ready,pinned]);
  return <div ref={ref} className={`map-attribution ${terrain?'terrain-data-credit':''}`} hidden={!ready}>
    {expanded&&<div id={id} className="map-attribution-content">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
      <span> · </span><a href="/sources">Данные и лицензии</a>
      <p>Обзорный рельеф: <a href="/maps/russia-relief/manifest.json">Natural Earth · происхождение данных</a>.</p>
      {terrain&&<p>Высоты: Mapterhorn / Copernicus GLO-30. <a href="/terrain/ATTRIBUTION.txt" target="_blank" rel="noreferrer">Полное уведомление</a></p>}
    </div>}
    <button className="map-attribution-toggle" aria-label={expanded?'Свернуть сведения об источниках':'Данные карты и лицензии'} aria-expanded={expanded} aria-controls={id}
      onClick={()=>{setPinned(true);setExpanded(!expanded);}}><MapIcon name="info" size={20}/></button>
  </div>;
}
