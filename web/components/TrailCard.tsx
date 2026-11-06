'use client';
import {ArrowUpRight,Clock,Path,BookmarkSimple,ArrowUp} from '@/components/TropnikIcons';
import {useEffect,useRef,useCallback} from 'react';
import {preloadTrail} from '@/lib/map-preload';
import type {Trail} from '@/lib/content';
import {deriveRouteCategories} from '@/lib/event-categories';
import {EventCategoryIcon, RouteCategoryBadges} from './EventCategoryIcon';
export function TrailCard({trail,onSelect,saved,onSave}:{trail:Trail;onSelect:()=>void;saved?:boolean;onSave?:()=>void}){
const element=useRef<HTMLElement>(null);
 const categories=deriveRouteCategories(trail);
 const warm=useCallback(()=>{void preloadTrail(trail).catch(()=>undefined);},[trail]);
 useEffect(()=>{if(!element.current||typeof IntersectionObserver==='undefined')return;const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){warm();observer.disconnect();}},{rootMargin:'80px',threshold:.1});observer.observe(element.current);return()=>observer.disconnect();},[warm]);
 return <article ref={element} className="trail-card" onPointerEnter={warm} onFocus={warm} onTouchStart={warm}><button className="trail-card-main" onClick={onSelect}><div className="trail-card-top"><span className="trail-card-theme">{categories[0]&&<EventCategoryIcon category={categories[0]} size={32}/>}<span className={`difficulty caption-3 difficulty-${trail.difficulty}`}>{trail.difficultyLabel}</span></span><ArrowUpRight size={20}/></div><h3 className="title-2">{trail.title}</h3><p className="body-6">{trail.subtitle.replace('Данные OpenStreetMap','Описание маршрута')}</p><RouteCategoryBadges categories={categories} limit={2}/><div className="trail-facts caption-4"><span><Path size={15}/>{trail.distanceKm===null?'Длина уточняется':`${trail.distanceKm.toLocaleString('ru')} км${trail.distanceNote ? ' · ' + trail.distanceNote : ''}`}</span>{trail.duration&&<span><Clock size={15}/>{trail.duration}</span>}{trail.ascentM!==null&&<span><ArrowUp size={14}/>{trail.ascentM} м</span>}</div></button><div className="trail-card-bottom"><span className="source-status caption-4"><span className="tiny-dot"/>{trail.accessStatus==='closed'?'Закрыт для посещения':trail.publicationStatus==='published'?'Маршрут':'Описание из источника'}</span>{onSave&&<button className={saved?'save-button saved':'save-button'} aria-label={saved?'Маршрут сохранён':'Сохранить маршрут'} onClick={onSave}><BookmarkSimple size={20} weight={saved?'fill':'regular'}/></button>}</div></article>;
}
