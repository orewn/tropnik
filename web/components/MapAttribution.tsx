'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {MapIcon} from './MapIcon';

const SESSION_KEY='tropnik-map-attribution-seen';

/**
 * Required map credit is visible on the first display, then collapses after
 * five seconds or the first map interaction. A labelled one-click control
 * always remains in the map corner and opens the full licence information.
 */
export function MapAttribution({ready=true,terrain=false}:{ready?:boolean;terrain?:boolean}) {
  const [expanded,setExpanded]=useState(true),[pinned,setPinned]=useState(false);
  const ref=useRef<HTMLDivElement>(null),id=useId();
  useEffect(()=>{
    if(!ready||pinned)return;
    try{if(sessionStorage.getItem(SESSION_KEY)==='1'){setExpanded(false);return;}}catch{}
    const collapse=()=>{
      setExpanded(false);
      try{sessionStorage.setItem(SESSION_KEY,'1');}catch{}
    };
    const host=ref.current?.closest('.atlas-wrap');
    host?.addEventListener('pointerdown',collapse,{once:true});
    host?.addEventListener('wheel',collapse,{once:true,passive:true});
    const timer=setTimeout(collapse,5000);
    return()=>{
      clearTimeout(timer);
      host?.removeEventListener('pointerdown',collapse);
      host?.removeEventListener('wheel',collapse);
    };
  },[ready,pinned]);
  return <div ref={ref} className={`map-attribution ${terrain?'terrain-data-credit':''}`} hidden={!ready}>
    {expanded&&<div id={id} className="map-attribution-content">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
      <span> · </span><a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a>
      <span> · </span><a href="/sources">Данные и лицензии</a>
      {terrain&&<p>Рельеф и высоты: <a href="/terrain/ATTRIBUTION.txt" target="_blank" rel="noreferrer">полное уведомление</a></p>}
    </div>}
    <button className="map-attribution-toggle" title="Данные карты и лицензии" aria-label={expanded?'Свернуть сведения об источниках':'Данные карты и лицензии'} aria-expanded={expanded} aria-controls={id}
      onClick={()=>{setPinned(true);setExpanded(!expanded);}}><MapIcon name="info" size={18}/></button>
  </div>;
}
