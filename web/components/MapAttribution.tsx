'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {MapIcon} from './MapIcon';
import {SATELLITE_MAX_ZOOM,SATELLITE_OVERVIEW_MAX_ZOOM,type SatelliteSourceId} from '@/lib/map-satellite';
import {bindMapAttributionCollapse} from '@/lib/map-attribution';

const SESSION_KEY='tropnik-map-attribution-seen';

/**
 * Required map credit is visible on the first display, then collapses after
 * five seconds or the first map interaction. A labelled one-click control
 * always remains in the map corner and opens the full licence information.
 */
export function MapAttribution({ready=true,terrain=false,satellite=false,satelliteSource='eox-s2',satelliteLoading=false,zoom=0}:{ready?:boolean;terrain?:boolean;satellite?:boolean;satelliteSource?:SatelliteSourceId;satelliteLoading?:boolean;zoom?:number}) {
  const [expanded,setExpanded]=useState(true),[pinned,setPinned]=useState(false);
  const ref=useRef<HTMLDivElement>(null),id=useId();
  useEffect(()=>{
    if(!ready||pinned)return;
    // Hydrate the browser-only credit preference after SSR/initial paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try{if(sessionStorage.getItem(SESSION_KEY)==='1'){setExpanded(false);return;}}catch{}
    const collapse=()=>{
      setExpanded(false);
      try{sessionStorage.setItem(SESSION_KEY,'1');}catch{}
    };
    const host=ref.current?.closest('.atlas-wrap');
    return bindMapAttributionCollapse(host??null,ref.current,collapse);
  },[ready,pinned]);
  return <div ref={ref} className={`map-attribution ${terrain?'terrain-data-credit':''}`} hidden={!ready}>
    {satellite&&<div className="map-satellite-credit" data-imagery-source={satelliteSource}>
      {satelliteSource==='eox-bluemarble'?<><a href="https://science.nasa.gov/earth/earth-observatory/" target="_blank" rel="noreferrer">NASA Blue Marble</a><span> · </span><a href="https://maps.eox.at/#data" target="_blank" rel="noreferrer">EOX</a><span className="map-satellite-detail">Обзорный снимок · детализация ниже</span>{zoom>SATELLITE_OVERVIEW_MAX_ZOOM&&<span className="map-satellite-detail">Увеличен обзорный снимок</span>}</>:<><a href="https://cloudless.eox.at" target="_blank" rel="noreferrer">EOxCloudless</a><span> · </span><a href="https://eox.at" target="_blank" rel="noreferrer">EOX</a>{zoom>SATELLITE_MAX_ZOOM&&<span className="map-satellite-detail">Достигнута детализация снимка</span>}</>}
      {satelliteLoading&&<span className="map-satellite-detail">Загружаем снимки…</span>}
    </div>}
    {expanded&&<div id={id} className="map-attribution-content">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
      <span> · </span><a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a>
      <span> · </span><a href="/sources">Данные и лицензии</a>
      {terrain&&<p>Рельеф и высоты: <a href="/terrain/ATTRIBUTION.txt" target="_blank" rel="noreferrer">полное уведомление</a></p>}
      {satellite&&(satelliteSource==='eox-bluemarble'?<p>NASA Earth Observatory · Blue Marble · EOX::Maps. В районе Чукотки и Врангеля подробная мозаика имеет пробелы; показан обзорный спутниковый снимок. При сильном увеличении заметны стыки исходной мозаики. <a href="/sources#satellite-attribution">Источники и детализация</a></p>:<p><a href="https://cloudless.eox.at" target="_blank" rel="noreferrer">EOxCloudless</a> by <a href="https://eox.at" target="_blank" rel="noreferrer">EOX IT Services GmbH</a>. <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a> · <a href="/sources#satellite-attribution">Полное уведомление об авторстве</a></p>)}
    </div>}
    <button className="map-attribution-toggle" title="Данные карты и лицензии" aria-label={expanded?'Свернуть сведения об источниках':'Данные карты и лицензии'} aria-expanded={expanded} aria-controls={id}
      onClick={()=>{setPinned(true);setExpanded(!expanded);}}><MapIcon name="info" size={18}/></button>
  </div>;
}
