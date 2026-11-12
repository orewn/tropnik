'use client';
/* eslint-disable @next/next/no-img-element */
import {memo,useEffect,useMemo,useState,useRef,useId} from 'react';
import type {KeyboardEvent as ReactKeyboardEvent,PointerEvent as ReactPointerEvent} from 'react';
import {ArrowRight,CaretLeft,CaretRight,Pause,Play,Compass,X} from '@/components/TropnikIcons';
import {factsForPlace,type PlaceFact} from '@/lib/facts';

export const PlaceStories=memo(function PlaceStories({regionId,routeId,onPlace}:{regionId?:string;routeId?:string;onPlace:(f:PlaceFact)=>void}){
 const facts=useMemo(()=>factsForPlace(regionId,routeId),[regionId,routeId]);
 const [index,setIndex]=useState(0),[paused,setPaused]=useState(false),[hovered,setHovered]=useState(false),[hidden,setHidden]=useState(false),[dismissed,setDismissed]=useState(Boolean(routeId)),[reduced,setReduced]=useState(false),[expanded,setExpanded]=useState(false),[narrow,setNarrow]=useState(false),[failedPhoto,setFailedPhoto]=useState(''),[canHover,setCanHover]=useState(false),[inViewport,setInViewport]=useState(true);
 const storyId=useId(),overview=!regionId,collapsible=overview||narrow,compact=collapsible&&!expanded;
 const [selection,setSelection]=useState({regionId,routeId});
 const swipe=useRef<{x:number;y:number;id:number}|null>(null),card=useRef<HTMLElement|null>(null);
 const fact=facts.length?facts[index%facts.length]:undefined;

 useEffect(()=>{const media=window.matchMedia('(max-width: 1024px), (max-height: 620px)');const sync=()=>setNarrow(media.matches);sync();media.addEventListener('change',sync);return()=>media.removeEventListener('change',sync);},[]);
 useEffect(()=>{const media=window.matchMedia('(max-width: 700px) and (max-height: 720px), (max-width: 900px) and (max-height: 620px)');const sync=()=>{if(media.matches)setDismissed(true);};sync();media.addEventListener('change',sync);return()=>media.removeEventListener('change',sync);},[]);
 useEffect(()=>{const media=window.matchMedia('(hover: hover) and (pointer: fine)');const sync=()=>setCanHover(media.matches);sync();media.addEventListener('change',sync);return()=>media.removeEventListener('change',sync);},[]);
 useEffect(()=>{const media=window.matchMedia('(prefers-reduced-motion: reduce)');const sync=()=>setReduced(media.matches);sync();media.addEventListener('change',sync);const visibility=()=>setHidden(document.hidden);visibility();document.addEventListener('visibilitychange',visibility);return()=>{media.removeEventListener('change',sync);document.removeEventListener('visibilitychange',visibility);};},[]);
 useEffect(()=>{
  const node=card.current;
  if(dismissed||!node||!('IntersectionObserver' in window))return;
  const observer=new IntersectionObserver(entries=>setInViewport(entries.some(entry=>entry.isIntersecting&&entry.intersectionRatio>=.12)),{threshold:[0,.12,.5],rootMargin:'96px'});
  observer.observe(node);
  return()=>observer.disconnect();
 },[dismissed]);
 useEffect(()=>{
  if(!fact||dismissed||hidden||!inViewport||facts.length<2)return;
  const connection=(navigator as Navigator&{connection?:{saveData?:boolean;effectiveType?:string}}).connection;
  if(connection?.saveData||/(?:^|-)2g$/.test(connection?.effectiveType||''))return;
  let cancelled=false,idle=0,timer=0;
  const preload=()=>{if(cancelled)return;for(const offset of [-1,1]){const nearby=facts[(index+offset+facts.length)%facts.length];const image=new window.Image();image.decoding='async';image.src=nearby.imageUrl;}};
  const target=window as Window&{requestIdleCallback?:(callback:()=>void,options?:{timeout:number})=>number;cancelIdleCallback?:(handle:number)=>void};
  if(target.requestIdleCallback)idle=target.requestIdleCallback(preload,{timeout:1800});else timer=window.setTimeout(preload,600);
  return()=>{cancelled=true;if(idle)target.cancelIdleCallback?.(idle);if(timer)clearTimeout(timer);};
 },[fact,facts,index,dismissed,hidden,inViewport]);

 const stopped=paused||hovered||hidden||reduced||dismissed||!inViewport||(collapsible&&expanded);
 useEffect(()=>{if(stopped||facts.length<2)return;const timer=setTimeout(()=>setIndex(i=>(i+1)%facts.length),16000);return()=>clearTimeout(timer);},[index,stopped,facts]);

 // Adjust selection before committing its DOM: a changed place must never
 // briefly show the previous story index or expand a route's story overlay.
 if(selection.regionId!==regionId||selection.routeId!==routeId){
  setSelection({regionId,routeId});setIndex(0);setExpanded(false);setPaused(false);
  if(routeId&&selection.routeId!==routeId)setDismissed(true);
 }
 if(!fact)return null;
 function manual(delta:number){setPaused(true);setIndex(i=>(i+delta+facts.length)%facts.length);}
 function releaseTouchFocus(button:HTMLButtonElement,clickCount:number){
  // Keyboard and assistive activations have no pointer click count. Keep
  // their focus even on a phone with an external keyboard.
  if(clickCount>0&&window.matchMedia('(hover:none), (pointer:coarse)').matches)requestAnimationFrame(()=>button.blur());
 }
 function beginSwipe(event:ReactPointerEvent<HTMLElement>){
  if(event.pointerType==='mouse'||(event.target as HTMLElement).closest('button,a'))return;
  swipe.current={x:event.clientX,y:event.clientY,id:event.pointerId};
 }
 function finishSwipe(event:ReactPointerEvent<HTMLElement>){
  const start=swipe.current;swipe.current=null;
  if(!start||start.id!==event.pointerId)return;
  const dx=event.clientX-start.x,dy=event.clientY-start.y;
  if(Math.abs(dx)>=44&&Math.abs(dx)>Math.abs(dy)*1.2){event.preventDefault();manual(dx>0?-1:1);}
 }
 function storyKey(event:ReactKeyboardEvent<HTMLElement>){
  if(event.target!==event.currentTarget)return;
  if(event.key==='ArrowLeft'){event.preventDefault();manual(-1);}
  if(event.key==='ArrowRight'){event.preventDefault();manual(1);}
 }
 function togglePlayback(){if(!reduced)setPaused(value=>!value);}
 if(dismissed)return <button type="button" className="fact-closed" onClick={()=>setDismissed(false)}><Compass size={17}/>Истории мест</button>;
 const photoFailed=failedPhoto===fact.id;
 return <aside
  ref={card}
  className={`fact-card ${overview?'overview-fact':''} ${compact?'fact-card--compact':'fact-card--expanded'}`}
  aria-label="Истории мест на карте"
  tabIndex={0}
  onKeyDown={storyKey}
  onPointerDown={beginSwipe}
  onPointerUp={finishSwipe}
  onPointerCancel={()=>{swipe.current=null;}}
  onMouseEnter={()=>{if(canHover)setHovered(true);}}
  onMouseLeave={()=>{if(canHover)setHovered(false);}}
  onFocusCapture={()=>setHovered(true)}
  onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setHovered(false);}}
 >
  <figure className={`fact-photo ${photoFailed?'is-fallback':''}`}>
   {!photoFailed&&<img key={fact.imageUrl} className="fact-photo-image" src={fact.imageUrl} alt={fact.imageAlt} loading={overview?'eager':'lazy'} decoding="async" referrerPolicy="no-referrer" style={{objectPosition:fact.imagePosition||'50% 50%'}} onLoad={()=>setFailedPhoto(current=>current===fact.id?'':current)} onError={()=>setFailedPhoto(fact.id)}/>}
   <span className="fact-photo-fallback" aria-hidden={!photoFailed}><Compass size={22}/><span>Фото временно недоступно</span></span>
   <figcaption>{fact.imageCredit}<span>{fact.imageLicense}</span></figcaption>
  </figure>
  <div className="fact-card-inner">
   <div className="fact-topline"><Compass size={15}/><span className="eyebrow">{regionId?'Ближе к месту':'Открывайте Россию'}</span><span className="fact-count">{String(index%facts.length+1).padStart(2,'0')} / {String(facts.length).padStart(2,'0')}</span><button type="button" className="fact-dismiss" onClick={()=>setDismissed(true)} aria-label="Свернуть истории"><X size={14}/></button></div>
   <div className="fact-copy" key={fact.id} aria-live={paused?'polite':'off'}>
    <h3 className={compact?'title-2':undefined}>{fact.title}</h3>
    <div className="fact-story-body" id={storyId} hidden={compact}><p>{fact.body}</p>{collapsible&&<button className="fact-place" onClick={()=>{setPaused(true);onPlace(fact);}} title="Открыть направление на карте">{fact.place}<ArrowRight size={12}/></button>}</div>
   </div>
  </div>
  <div className="fact-card-footer">
   {collapsible?<button type="button" className="fact-story-toggle button-sm" aria-expanded={expanded} aria-controls={storyId} onClick={event=>{setExpanded(value=>!value);releaseTouchFocus(event.currentTarget,event.detail);}}>{expanded?'Свернуть':'Читать историю'}<CaretRight size={14}/></button>:<button className="fact-place" onClick={()=>{setPaused(true);onPlace(fact);}} title="Открыть направление на карте">{fact.place.length>24?fact.place.split(' · ')[0]:fact.place}<ArrowRight size={12}/></button>}
   <div className="fact-controls">
    <button type="button" aria-label="Предыдущая история" onClick={event=>{manual(-1);releaseTouchFocus(event.currentTarget,event.detail);}}><CaretLeft size={15}/></button>
    {compact&&<span className="fact-count caption-5">{String(index%facts.length+1).padStart(2,'0')} / {String(facts.length).padStart(2,'0')}</span>}
    <button type="button" disabled={reduced} title={reduced?'Автосмена отключена системной настройкой уменьшения движения':undefined} aria-label={reduced?'Автосмена отключена системной настройкой':paused?'Включить смену историй':'Остановить смену историй'} aria-pressed={paused||reduced} onClick={event=>{togglePlayback();releaseTouchFocus(event.currentTarget,event.detail);}}>{paused||reduced?<Play size={13}/>:<Pause size={13}/>}</button>
    <button type="button" aria-label="Следующая история" onClick={event=>{manual(1);releaseTouchFocus(event.currentTarget,event.detail);}}><CaretRight size={15}/></button>
   </div>
  </div>
  <div className={`fact-progress ${stopped?'paused':''}`} aria-hidden="true"><span key={`${fact.id}-${paused}`}/></div>
 </aside>;
});
