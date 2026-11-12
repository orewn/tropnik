'use client';
import {useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {MapIcon} from './MapIcon';
import {SATELLITE_MAX_ZOOM,SATELLITE_OVERVIEW_MAX_ZOOM,type SatelliteSourceId} from '@/lib/map-satellite';
import {bindMapAttributionCollapse} from '@/lib/map-attribution';

const SESSION_KEY='tropnik-map-attribution-seen';

/** Share the measured footer height with the adjacent desktop actions. The
 * footer itself never consumes this value, so a size notification cannot
 * create a layout loop. Camera frames do not read or update this geometry. */
export function MapFooter({loading=false,children}:{loading?:boolean;children:ReactNode}) {
  const ref=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const footer=ref.current,layout=footer?.closest<HTMLElement>('.explore-layout'),atlas=footer?.closest<HTMLElement>('.atlas-wrap');if(!footer||!layout||!atlas)return;
    let alive=true,elements:Record<string,HTMLElement|null>={footer};
    const sizes=new Map<HTMLElement,{width:number;height:number}>(),written=new Map<string,string>();
    const dimension=(key:string,axis:'width'|'height')=>{const element=elements[key];return element?sizes.get(element)?.[axis]??0:0;};
    const publish=()=>{
      if(!alive)return;
      const values:Record<string,number>={
        '--map-footer-height':dimension('footer','height'),
        '--map-footer-notice-height':dimension('notice','height'),
        '--map-footer-credit-height':Math.max(44,dimension('credit','height'),dimension('toggle','height')),
        '--map-mode-switch-width':dimension('modes','width'),
        '--map-leading-ui-width':Math.max(dimension('context','width'),dimension('stories','width')),
      };
      for(const [name,size]of Object.entries(values)){const value=`${Math.ceil(size)}px`;if(written.get(name)!==value){written.set(name,value);layout.style.setProperty(name,value);}}
    };
    const observer=new ResizeObserver(entries=>{
      if(!alive)return;
      for(const entry of entries){const element=entry.target as HTMLElement;if(!sizes.has(element))continue;const border=entry.borderBoxSize?.[0],rect=border?{width:border.inlineSize,height:border.blockSize}:element.getBoundingClientRect();sizes.set(element,{width:rect.width,height:rect.height});}
      publish();
    });
    const sync=()=>{
      if(!alive)return;
      elements={footer,notice:footer.querySelector('.map-preload-status'),credit:footer.querySelector('.map-satellite-credit'),toggle:footer.querySelector('.map-attribution-toggle'),modes:atlas.querySelector('.map-style-switch'),context:atlas.querySelector('.map-context,.map-route-context'),stories:layout.querySelector(':scope>.fact-closed')};
      const current=new Set(Object.values(elements).filter((element):element is HTMLElement=>!!element));
      for(const element of sizes.keys())if(!current.has(element)){observer.unobserve(element);sizes.delete(element);}
      for(const element of current)if(!sizes.has(element)){const rect=element.getBoundingClientRect();sizes.set(element,{width:rect.width,height:rect.height});observer.observe(element);}
      publish();
    };
    // Only these seven UI boxes are retained. Direct sibling mutations detect
    // a story launcher appearing; footer mutations detect source-card changes.
    // Map canvas markers and camera transforms are outside these observers.
    const mutation=new MutationObserver(sync);mutation.observe(layout,{childList:true});mutation.observe(atlas,{childList:true});mutation.observe(footer,{childList:true,subtree:true});sync();
    return()=>{alive=false;mutation.disconnect();observer.disconnect();sizes.clear();for(const [name,value]of written)if(layout.style.getPropertyValue(name)===value)layout.style.removeProperty(name);};
  },[]);
  return <div ref={ref} className="map-footer">
    <div className="map-preload-status" role="status" aria-hidden={!loading}>Подгружаем детали текущего ракурса</div>
    <div className="map-footer-meta">{children}</div>
  </div>;
}

/**
 * Required map credit is visible on the first display, then collapses after
 * five seconds or the first map interaction. A labelled one-click control
 * always remains in the map corner and opens the full licence information.
 */
export function MapAttribution({ready=true,terrain=false,satellite=false,satelliteSource='eox-s2',satelliteLoading=false,zoom=0,vector=true,routeData=false,landcover=false}:{ready?:boolean;terrain?:boolean;satellite?:boolean;satelliteSource?:SatelliteSourceId;satelliteLoading?:boolean;zoom?:number;vector?:boolean;routeData?:boolean;landcover?:boolean}) {
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
      {/* Keep the status text's intrinsic footprint across tile requests. */}
      <span className="map-satellite-detail map-satellite-status" aria-hidden={!satelliteLoading}>Загружаем снимки…</span>
    </div>}
    {expanded&&<div id={id} className="map-attribution-content">
      {(vector||routeData)&&<><span>{!vector?'Маршруты: ':''}</span><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a><span> · </span></>}
      {vector&&<><a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a><span> · </span></>}
      <a href="/sources">Данные и лицензии</a>
      {terrain&&<p>Рельеф и высоты: <a href="/terrain/ATTRIBUTION.txt" target="_blank" rel="noreferrer">полное уведомление</a></p>}
      {landcover&&<p>Покрытие земли: ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021), processed by ESA WorldCover consortium. <a href="https://esa-worldcover.org/en/data-access" target="_blank" rel="noreferrer">CC BY 4.0</a></p>}
      {satellite&&(satelliteSource==='eox-bluemarble'?<p>NASA Earth Observatory · Blue Marble · EOX::Maps. В районе Чукотки и Врангеля подробная мозаика имеет пробелы; показан обзорный спутниковый снимок. При сильном увеличении заметны стыки исходной мозаики. <a href="/sources#satellite-attribution">Источники и детализация</a></p>:<p><a href="https://cloudless.eox.at" target="_blank" rel="noreferrer">EOxCloudless</a> by <a href="https://eox.at" target="_blank" rel="noreferrer">EOX IT Services GmbH</a>. <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a> · <a href="/sources#satellite-attribution">Полное уведомление об авторстве</a></p>)}
    </div>}
    <button className="map-attribution-toggle" title="Данные карты и лицензии" aria-label={expanded?'Свернуть сведения об источниках':'Данные карты и лицензии'} aria-expanded={expanded} aria-controls={id}
      onClick={()=>{setPinned(true);setExpanded(!expanded);}}><MapIcon name="info" size={18}/></button>
  </div>;
}
