'use client';
import {useRouter} from 'next/navigation';
import {useState,useEffect,useLayoutEffect,useCallback,useMemo,useRef,useSyncExternalStore,useId,useDeferredValue,type FormEvent} from 'react';
import {MagnifyingGlass,ArrowRight,ArrowLeft,Mountains,Tree,WaveSine,MapPin,SlidersHorizontal,BookmarkSimple,CheckCircle,Info,X,Path,Clock,UsersThree,ArrowDown,ArrowSquareOut,ShieldCheck} from '@/components/TropnikIcons';
import {trails,type Trail} from '@/lib/content';
import {packs,saveReference,type SavedPack} from '@/lib/local';
import {api,ApiError,errorText,type Route} from '@/lib/api';
import {publishedTrail} from '@/lib/route-adapter';
import {AuthDialog} from './AuthDialog';
import {CustomAtlas as Atlas} from './CustomAtlas';
import {PlaceStories} from './PlaceStories';
import type {PlaceFact} from '@/lib/facts';
import {warmMap,preloadTrail} from '@/lib/map-preload';
import {SourceDifficulty} from './SourceDifficulty';
import {sourceDateLabel,formatEvidenceDate,trailGeometryDescription} from '@/lib/trail-evidence';
import {TrailCard} from './TrailCard';
import {TerritoryBrowser} from './TerritoryBrowser';
import {mapRegionById, createTrailRegionIndex, type MapRegion} from '@/lib/territories';
import {filterMapTrails} from '@/lib/map-catalog';
import {createRouteSearch} from '@/lib/route-search';
import {Modal} from './Modal';
import {MapResourceHints} from './MapResourceHints';
import {bindSheetGesture,SHEET_MEDIA_QUERY,type SheetGesture} from '@/lib/sheet-gesture';
import {bindExploreScrollRestoration} from '@/lib/explore-scroll-restoration';
import {DEFAULT_EXPLORE_FILTERS,exploreFiltersForRegion,exploreParentSelection,exploreTrailSelection,writeExploreHistory} from '@/lib/explore-navigation';
import {ExploreRequestSession} from '@/lib/explore-request';

const terrainIcon=(id:string,size=24)=>id==='karelia'?<Tree size={size}/>:id==='baikal'?<WaveSine size={size}/>:<Mountains size={size}/>;
const routeCountPreview=(count:number)=>{
 const mod100=count%100,mod10=count%10;
 const noun=mod100>=11&&mod100<=14?'маршрутов':mod10===1?'маршрут':mod10>=2&&mod10<=4?'маршрута':'маршрутов';
 return `${count.toLocaleString('ru')} ${noun}`;
};
const subscribeHydration=()=>()=>{};
const hydratedSnapshot=()=>true,serverHydrationSnapshot=()=>false;
export function Explore({initialRegion,initialTrail,initialPublished=[]}:{initialRegion?:string;initialTrail?:string;initialPublished?:Trail[]}){
 const router=useRouter();
 const hydrated=useSyncExternalStore(subscribeHydration,hydratedSnapshot,serverHydrationSnapshot);
 const sheetPanelId=useId();
 const panelContent=useRef<HTMLDivElement>(null);
 const panelHeading=useRef<HTMLHeadingElement>(null),pendingPanelFocus=useRef<HTMLElement|null>(null);
 const rememberPanelFocus=useCallback(()=>{
  const active=document.activeElement;
  pendingPanelFocus.current=active instanceof HTMLElement&&panelContent.current?.contains(active)?active:null;
 },[]);
 const sheetLayout=useRef<HTMLElement>(null),sheetPanel=useRef<HTMLElement>(null),sheetHandle=useRef<HTMLButtonElement>(null),sheetPreview=useRef<HTMLButtonElement>(null);
 const sheetGesture=useRef<SheetGesture|null>(null),committedSheetOpen=useRef(false);
 const [liveTrails,setLiveTrails]=useState<Trail[]>(initialPublished);
 const [auth,setAuth]=useState(false);
 const catalog=useMemo(()=>{if(!liveTrails.length)return trails;const liveIds=new Set(liveTrails.map(item=>item.id));return [...liveTrails,...trails.filter(item=>!liveIds.has(item.id))];},[liveTrails]);
 const catalogById=useMemo(()=>new Map(catalog.map(item=>[item.id,item])),[catalog]);
 const regionCatalog=useMemo(()=>createTrailRegionIndex(catalog),[catalog]);
 const searchRoutes=useMemo(()=>createRouteSearch(catalog),[catalog]);
 useEffect(()=>{warmMap();},[]);
 const closeAuth=useCallback(()=>setAuth(false),[]);
 useEffect(()=>{api<Route[]>('routes').then(r=>setLiveTrails(r.map(publishedTrail))).catch(()=>{});},[]);
 useLayoutEffect(()=>{
  if(window.location.pathname!=='/')return;
  return bindExploreScrollRestoration();
 },[]);
 const [region,setRegion]=useState<MapRegion|undefined>(mapRegionById(initialRegion||catalogById.get(initialTrail||'')?.regionId||''));
 const [trail,setTrail]=useState<Trail|undefined>(catalogById.get(initialTrail||''));
 useLayoutEffect(()=>{
  panelContent.current?.scrollTo({top:0,behavior:'instant'});
  const previous=pendingPanelFocus.current;pendingPanelFocus.current=null;
  // Catalogue buttons disappear when their destination replaces the panel.
  // Restore only that lost focus, never steal it from a map control or dialog.
  const active=document.activeElement;
  if(previous&&!previous.isConnected&&(!active||active===document.body||active===document.documentElement))panelHeading.current?.focus({preventScroll:true});
 },[trail?.id,region?.id]);
 const [query,setQuery]=useState(''),[filters,setFilters]=useState(DEFAULT_EXPLORE_FILTERS);
 const {expanded:filter,duration,onlySaved,difficulty}=exploreFiltersForRegion(region?.id,filters);
 const deferredQuery=useDeferredValue(query),searchPending=query!==deferredQuery;
 const [saved,setSaved]=useState<SavedPack[]>([]),[notice,setNotice]=useState(''),[saving,setSaving]=useState(''),[offline,setOffline]=useState(false),[sheetOpen,setSheetOpen]=useState(false);
 const [requestSession]=useState(()=>new ExploreRequestSession(trail?.id));
 const requestState=useSyncExternalStore(requestSession.subscribe,requestSession.getSnapshot,requestSession.getSnapshot);
 const {date,note,error:requestError,busy:requestBusy,saved:draftSaved}=requestState;
 const request=requestState.open&&requestState.routeId===trail?.id;
 useLayoutEffect(()=>requestSession.cancelPending,[requestSession]);
 const [viewportRegion,setViewportRegion]=useState<string|undefined>();
 useLayoutEffect(()=>{committedSheetOpen.current=sheetOpen;sheetGesture.current?.sync();},[sheetOpen,region?.id,trail?.id]);
 useEffect(()=>{
  const root=sheetLayout.current,panel=sheetPanel.current,handle=sheetHandle.current,preview=sheetPreview.current;
  if(!root||!panel||!handle||!preview)return;
  const media=window.matchMedia(SHEET_MEDIA_QUERY);
  const controller=bindSheetGesture({root,panel,handles:[handle,preview],enabled:()=>media.matches,getOpen:()=>committedSheetOpen.current,setOpen:setSheetOpen});
  sheetGesture.current=controller;
  const cancel=()=>controller.cancel();
  media.addEventListener('change',cancel);
  return()=>{media.removeEventListener('change',cancel);controller.dispose();if(sheetGesture.current===controller)sheetGesture.current=null;};
 },[]);
 const listKey=`${region?.id||'all'}:${deferredQuery}:${difficulty}:${duration}:${onlySaved}`;
 const [page,setPage]=useState({key:'',limit:12});
 const limit=page.key===listKey?page.limit:12;
 useEffect(()=>{packs().then(setSaved).catch(()=>{});const sync=()=>setOffline(navigator.onLine===false);sync();window.addEventListener('online',sync);window.addEventListener('offline',sync);return()=>{window.removeEventListener('online',sync);window.removeEventListener('offline',sync);};},[]);
 useEffect(()=>{if(!notice)return;const id=setTimeout(()=>setNotice(''),7000);return()=>clearTimeout(id);},[notice]);
 const closeRequest=requestSession.close;
 const writeExploreState=useCallback((nextRegion?:string,nextTrail?:string,mode:'push'|'replace'='push')=>{
  if(window.location.pathname!=='/')return;
  writeExploreHistory(window,{regionId:nextRegion,trailId:nextTrail},mode);
 },[]);
 const applyExploreLocation=useCallback(()=>{
  if(window.location.pathname!=='/')return;
  const params=new URLSearchParams(location.search),trailId=params.get('route')||'',nextTrail=catalogById.get(trailId);
  const regionId=params.get('region')||nextTrail?.regionId||'',nextRegion=mapRegionById(regionId);
  requestSession.select(nextTrail?.id,true);setAuth(false);
  if(!nextRegion)setFilters(DEFAULT_EXPLORE_FILTERS);
  setRegion(nextRegion);setTrail(nextTrail);setSheetOpen(Boolean(nextRegion||nextTrail));setViewportRegion(undefined);
 },[catalogById,requestSession]);
 useEffect(()=>{
  if(window.location.pathname!=='/')return;
  writeExploreState(region?.id,trail?.id,'replace');
  const onPopState=()=>applyExploreLocation();
  window.addEventListener('popstate',onPopState);
  return()=>window.removeEventListener('popstate',onPopState);
 },[applyExploreLocation,writeExploreState,region?.id,trail?.id]);
 useEffect(()=>{if(!trail?.id)return;const current=catalogById.get(trail.id);if(current&&current!==trail)queueMicrotask(()=>setTrail(previous=>previous?.id===current.id?current:previous));},[catalogById,trail]);
 const selectRegion=useCallback((r:MapRegion)=>{requestSession.select();setAuth(false);setRegion(r);setViewportRegion(undefined);setTrail(undefined);setSheetOpen(true);setQuery('');writeExploreState(r.id);},[writeExploreState,requestSession]);
 const selectTrail=useCallback((t:Trail,destination?:MapRegion)=>{
  void preloadTrail(t);requestSession.select(t.id);setAuth(false);setTrail(t);
  const selection=exploreTrailSelection(t,region?.id,destination?.id);
  if(destination){setRegion(destination);setViewportRegion(undefined);setQuery('');}else if(!region)setRegion(mapRegionById(t.regionId));
  setSheetOpen(true);writeExploreState(selection.regionId,selection.trailId);
 },[region,writeExploreState,requestSession]);
 const backToParent=useCallback(()=>{
  rememberPanelFocus();
  const parent=exploreParentSelection({regionId:region?.id,trailId:trail?.id});
  requestSession.select();setAuth(false);setTrail(undefined);
  if(!parent.regionId){setRegion(undefined);setViewportRegion(undefined);setQuery('');setFilters(DEFAULT_EXPLORE_FILTERS);}
  writeExploreState(parent.regionId,parent.trailId);
 },[region?.id,trail?.id,writeExploreState,requestSession,rememberPanelFocus]);
 const save=useCallback(async(t:Trail)=>{setSaving(t.id);try{await saveReference(t);setSaved(await packs());setNotice('Карточка сохранена на этом устройстве. Дата проверки и источник сохранены вместе с ней.');}catch(e){setNotice(errorText(e));}finally{setSaving('');}},[]);
 const clearQuery=useCallback(()=>setQuery(''),[]);
 const selectRegionFromPanel=useCallback((value:MapRegion)=>{rememberPanelFocus();selectRegion(value);},[rememberPanelFocus,selectRegion]);
 const selectTrailFromPanel=useCallback((value:Trail)=>{rememberPanelFocus();selectTrail(value);},[rememberPanelFocus,selectTrail]);
 const selectStoryPlace=useCallback((fact:PlaceFact)=>{const destination=mapRegionById(fact.regionId);if(!destination)return;const selected=fact.routeIds?.length?catalogById.get(fact.routeIds[0]):undefined;if(selected)selectTrail(selected,destination);else selectRegion(destination);},[catalogById,selectTrail,selectRegion]);
 async function submitRequest(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!trail)return;
  const attempt=requestSession.begin(trail.id);if(!attempt)return;
  try{
   if(trail.publicationStatus==='published'){
    const created=await api<{id:string}>('recruitment-requests',{method:'POST',body:JSON.stringify({routeId:attempt.routeId,preferredDate:attempt.date,body:attempt.note||'Хочу пройти этот маршрут с гидом.'})});
    requestSession.accept(attempt,()=>router.push('/trips?request='+encodeURIComponent(created.id)));
   }else{
    const requests=JSON.parse(localStorage.getItem('tropa-requests')||'[]');
    requests.push({id:crypto.randomUUID(),routeId:attempt.routeId,title:trail.title,preferredDate:attempt.date,note:attempt.note,status:'local_draft',createdAt:new Date().toISOString()});
    localStorage.setItem('tropa-requests',JSON.stringify(requests));requestSession.succeed(attempt);
   }
  }catch(error){
   requestSession.fail(attempt,trail.publicationStatus==='published'?errorText(error):'Не удалось сохранить черновик. Проверьте свободное место.');
   requestSession.accept(attempt,()=>{if(error instanceof ApiError&&error.status===401)setAuth(true);});
  }finally{requestSession.finish(attempt);}
 }
 const savedIds=useMemo(()=>new Set(saved.map(item=>item.id)),[saved]);
 const regionalTrails=useMemo(()=>region?regionCatalog.get(region.id)??[]:catalog,[catalog,region,regionCatalog]);
 const routeSearch=useMemo(()=>deferredQuery.trim()?searchRoutes(deferredQuery):null,[deferredQuery,searchRoutes]);
 const shownTrails=useMemo(()=>{
  const ranks=routeSearch?new Map(routeSearch.results.map((hit,index)=>[hit.id,index])):null;
  const selected=filterMapTrails(regionalTrails,{query:'',difficulty,duration,onlySaved,savedIds});
  return ranks?selected.filter(item=>ranks.has(item.id)).sort((a,b)=>ranks.get(a.id)!-ranks.get(b.id)!):selected;
 },[regionalTrails,routeSearch,difficulty,duration,onlySaved,savedIds]);
 const sheetPreviewKind=trail?'Маршрут':region?'Направление':'Каталог';
 const routeStatus=trail?.accessStatus==='closed'?'Посещение закрыто по сведениям источника.':trail?.accessStatus==='restricted'?'Есть ограничения доступа. Уточните разрешённый путь перед выходом.':trail?.publicationStatus==='reference'?'Справочные данные. Условия выхода ещё не подтверждены.':'Проверьте текущие условия перед выходом.';
 const sheetPreviewTitle=trail?.title??region?.name??'Все направления';
 const sheetPreviewMeta=trail
  ?[trail.distanceKm!=null?`${trail.distanceKm.toLocaleString('ru')} км${trail.distanceNote ? ' · '+trail.distanceNote : ''}`:undefined,trail.duration].filter(Boolean).join(' · ')||'Открыть карточку маршрута'
  :routeCountPreview(region?shownTrails.length:catalog.length);
 return <><MapResourceHints/><section ref={sheetLayout} className={`explore-layout ${sheetOpen?'sheet-open':'sheet-closed'}`} data-sheet-state={sheetOpen?'open':'closed'} aria-label="Поиск маршрутов"><aside ref={sheetPanel} id={sheetPanelId} className={`explore-panel ${sheetOpen?'expanded':'collapsed'}`}>
 <button ref={sheetHandle} className="sheet-handle" type="button" onClick={event=>{setSheetOpen(open=>!open);if(window.matchMedia('(pointer:coarse)').matches)event.currentTarget.blur();}} aria-controls={sheetPanelId} aria-expanded={sheetOpen} aria-label={sheetOpen?'Свернуть список':'Открыть список'}><span/></button>
 <button ref={sheetPreview} className="sheet-peek-summary" type="button" hidden={sheetOpen} onClick={event=>{setSheetOpen(true);if(window.matchMedia('(pointer:coarse)').matches)event.currentTarget.blur();}} aria-label={`Открыть: ${sheetPreviewTitle}`}>
  <span className="sheet-peek-copy"><small>{sheetPreviewKind}</small><strong>{sheetPreviewTitle}</strong><span>{sheetPreviewMeta}</span></span><ArrowRight size={20}/>
 </button>
 <div className="explore-panel-content" ref={panelContent} aria-busy={searchPending}>
 {trail?<><button type="button" className="back-link" onClick={backToParent}><ArrowLeft size={17}/>Маршруты направления</button><div className="eyebrow">{mapRegionById(trail.regionId)?.name}</div><h1 ref={panelHeading} tabIndex={-1} className="route-title heading-4">{trail.title}</h1><p className="panel-intro body-6">{trail.subtitle}</p><div className="route-status"><Info size={18}/><span>{routeStatus}</span></div>{trail.operatingNotice&&<div className="route-restriction"><strong>{trail.operatingNotice.title}</strong>{trail.operatingNotice.body}<a href={trail.operatingNotice.url} target="_blank" rel="noreferrer">Официальное сообщение <ArrowSquareOut size={12}/></a></div>}<div className="route-summary"><div><Path size={20}/><strong>{trail.distanceKm?.toLocaleString('ru')??'—'}<small> км</small></strong><span>{trail.distanceNote || 'длина по источнику'}</span></div><div><Clock size={20}/><strong>{trail.duration??'—'}</strong><span>время по источнику</span></div></div><div className="route-section"><h3>О маршруте</h3><p>{trail.description}</p>{!trail.geometryUrl&&!trail.geometry&&<p className="source-note">{trailGeometryDescription(trail)}</p>}<span className={`difficulty difficulty-${trail.difficulty}`}>{trail.difficultyLabel}</span><SourceDifficulty trail={trail}/></div><div className="route-section"><h3>Условия посещения</h3><ul className="check-list">{trail.notes.map(n=><li key={n}><CheckCircle size={17}/><span>{n}</span></li>)}</ul></div><div className="route-section source-block"><ShieldCheck size={23}/><div><strong>{trail.sourceName}</strong><span>{sourceDateLabel(trail.sourceKind)} {formatEvidenceDate(trail.checkedAt)}</span><a href={trail.sourceUrl} target="_blank" rel="noreferrer">Открыть описание <ArrowSquareOut size={13}/></a></div></div>{trail.officialEvidence&&<div className="route-section"><h3>Что подтвердил официальный источник</h3><p>{trail.officialEvidence.summary}</p>{trail.officialEvidence.scope&&<p className="source-scope">{trail.officialEvidence.scope}</p>}<a className="text-link" href={trail.officialEvidence.url} target="_blank" rel="noreferrer">Читать первоисточник <ArrowSquareOut size={12}/></a><p className="source-note">Описание прочитано {trail.officialEvidence.checkedAt}. Линия маршрута и условия на местности требуют отдельной проверки.</p></div>}<div className="route-actions"><button className="button primary full" disabled={trail.accessStatus==='closed'} onClick={()=>requestSession.open(trail.id)}><UsersThree size={20}/>{trail.accessStatus==='closed'?'Маршрут закрыт':trail.publicationStatus==='published'?'Открыть набор на маршрут':'Подготовить запрос на поход'}</button><button className="button secondary full" disabled={saving===trail.id} onClick={()=>save(trail)}><ArrowDown size={18}/>{saving===trail.id?'Сохраняем…':savedIds.has(trail.id)?'Обновить сохранённую карточку':'Сохранить карточку офлайн'}</button>{!!(trail.geometryUrl||trail.geometry)&&<a href={`/planner?route=${encodeURIComponent(trail.id)}`} className="button secondary full"><Path size={18}/>Составить поход из троп</a>}<a href={`/routes/${trail.id}`} className="text-link">Подробная страница маршрута <ArrowRight size={16}/></a></div></>:
 <><div className="panel-title-row">{region?<button type="button" className="back-link" onClick={backToParent}><ArrowLeft size={17}/>Все направления</button>:<span className="eyebrow">Место встречи — природа</span>}</div><h1 ref={panelHeading} tabIndex={-1} className="heading-4">{region?region.name:<>Найдите<br/>{' '}свою тропу<span className="heading-dot">.</span></>}</h1><p className="panel-intro body-6">{region?region.caption:'Маршруты по России. Походы с гидом. Люди, которым по пути.'}</p><label className="search-field"><MagnifyingGlass size={20}/><input disabled={!hydrated} type="search" maxLength={160} autoComplete="off" enterKeyHint="search" aria-label={region?'Поиск маршрута':'Поиск маршрута или направления'} placeholder={region?'Название маршрута':'Куда хочется отправиться?'} value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button type="button" onClick={()=>setQuery('')} aria-label="Очистить поиск"><X size={16}/></button>}</label><span className="sr-only" role="status">{searchPending?'Обновляем результаты маршрутов.':''}</span>
 {query.trim()&&<a className="text-link" href={`/search?q=${encodeURIComponent(query)}`}>Искать по всему сайту <ArrowRight size={16}/></a>}
 {region&&<div className="filter-row"><button className={filter?'filter-button selected':'filter-button'} aria-expanded={filter} onClick={()=>setFilters(current=>({...current,expanded:!current.expanded}))}><SlidersHorizontal size={18}/>Фильтры{(difficulty!=='all'||duration!=='any')&&<span className="filter-count">{Number(difficulty!=='all')+Number(duration!=='any')}</span>}</button><button className={onlySaved?'filter-button selected':'filter-button'} aria-pressed={onlySaved} onClick={()=>setFilters(current=>({...current,onlySaved:!current.onlySaved}))}><BookmarkSimple size={17} weight={onlySaved?'fill':'regular'}/>Сохранённые</button></div>}
 {filter&&region&&<div className="filters"><label>Сложность<select value={difficulty} onChange={e=>setFilters(current=>({...current,difficulty:e.target.value}))}><option value="all">Любая, включая непроверенную</option><option value="easy">Для начинающих</option><option value="moderate">Нужен опыт</option><option value="hard">Технически сложный</option><option value="unknown">Ещё не оценена</option></select></label><label>Продолжительность<select value={duration} onChange={e=>setFilters(current=>({...current,duration:e.target.value}))}><option value="any">Любая</option><option value="day">Есть почасовая оценка</option></select></label><button className="text-link" onClick={()=>{setFilters(current=>({...DEFAULT_EXPLORE_FILTERS,expanded:current.expanded}));}}>Сбросить фильтры</button></div>}
 {!region?<><TerritoryBrowser query={deferredQuery} catalogByRegion={regionCatalog} onSelect={selectRegionFromPanel} onClear={clearQuery}/>{query.trim()&&<section aria-label="Найденные маршруты"><div className="section-heading"><h2 className="title-3">Маршруты по запросу</h2><span>{shownTrails.length}</span></div>{shownTrails.length?<><div className="trail-list">{shownTrails.slice(0,limit).map(t=><TrailCard key={t.id} trail={t} onSelect={selectTrailFromPanel} saved={savedIds.has(t.id)} onSave={save}/>)}</div>{shownTrails.length>limit&&<button className="button secondary full" onClick={()=>setPage({key:listKey,limit:limit+12})}>Ещё маршруты</button>}</>:<p className="muted">Попробуйте название тропы, озера или горы.</p>}</section>}</>:
 <><div className="section-heading"><h2 className="title-3">{region.territory?'Тропы из источников':'Маршруты'}</h2><span>{shownTrails.length}</span></div>{shownTrails.length?<div className="trail-list">{shownTrails.slice(0,limit).map(t=><TrailCard key={t.id} trail={t} onSelect={selectTrailFromPanel} saved={savedIds.has(t.id)} onSave={save}/>)}</div>:<div className="catalog-empty"><div className="empty-landscape">{terrainIcon(region.id,48)}</div><h3>{onlySaved?'Здесь пока ничего не сохранено':query||difficulty!=='all'||duration!=='any'||onlySaved?'Подходящих маршрутов не найдено':region.territory?'Справочных маршрутов пока нет':'Готовим каталог этого направления'}</h3><p>{query||difficulty!=='all'||duration!=='any'||onlySaved?'Измените фильтры или попробуйте другое название.':'Территория доступна на карте. Маршруты появятся после добавления источников; набор — после проверки маршрута и допуска гида.'}</p>{query||difficulty!=='all'||duration!=='any'||onlySaved?<button className="button secondary" onClick={()=>{setQuery('');setFilters(current=>({...DEFAULT_EXPLORE_FILTERS,expanded:current.expanded}));}}>Сбросить фильтры</button>:<a className="button secondary" href="/guides">Я гид в этом регионе <ArrowRight size={17}/></a>}</div>}{shownTrails.length>limit&&<button className="button secondary full" style={{marginTop:15}} onClick={()=>setPage({key:listKey,limit:limit+12})}>Показать ещё · осталось {shownTrails.length-limit}</button>}{region.territory&&liveTrails.length>0&&<a className="region-detail-link" href="/trips"><UsersThree size={18}/><span>Походы с гидом</span><ArrowRight size={17}/></a>}{!region.territory&&<a className="region-detail-link" href={`/regions/${region.id}`}><MapPin size={18}/><span>Об этом направлении</span><ArrowRight size={17}/></a>}<div className="info-compact"><Info size={18}/><p>Тропа на карте может быть закрыта или требовать разрешения. Актуальный статус проверяется отдельно.</p></div></>}
 </>}
 </div><div className="panel-foot caption-4"><span className={offline?'connection-dot offline':'connection-dot'}/>{offline?'Без сети · сохранённые данные':'Планируйте онлайн, берите маршрут с собой'}<a href="/offline" aria-label="Возможности офлайн"><ArrowRight size={16}/></a></div></aside>
 <Atlas region={region} trail={trail} visibleTrails={shownTrails} onTrail={selectTrail} onRegion={selectRegion} onMapNote={setNotice} onViewportRegion={setViewportRegion}/>
 <PlaceStories regionId={viewportRegion||region?.id} routeId={trail?.id} onPlace={selectStoryPlace}/>
 {notice&&<div className="toast" role="status"><CheckCircle size={20}/><span>{notice}</span><button aria-label="Закрыть уведомление" onClick={()=>setNotice('')}><X size={17}/></button></div>}
 {request&&!auth&&trail&&<Modal title={draftSaved?'Запрос сохранён на устройстве':'Какой поход планируете?'} onClose={closeRequest}>{draftSaved?<div className="success-panel"><CheckCircle size={44}/><p>Это личный черновик. Он ещё не опубликован, гид не назначен и место в группе не забронировано.</p><button className="button primary" onClick={closeRequest}>Понятно</button></div>:<form className="stack" onSubmit={submitRequest}><p className="muted">{trail.title}</p><label>Желаемая дата<input type="date" required value={date} min={new Date().toISOString().slice(0,10)} onChange={e=>requestSession.edit('date',e.target.value)}/></label><label>Что важно для вас<textarea value={note} onChange={e=>requestSession.edit('note',e.target.value)} maxLength={1000} rows={4} placeholder="Опыт, удобные даты, пожелания к группе"/></label><div className="inline-note"><Info size={20}/><span>{trail.publicationStatus==='published'?'Откроется обсуждение с набором желающих. Подходящий гид назначит выход; участие в конкретной дате нужно подтвердить отдельно.':'Сейчас можно подготовить личный черновик. Для реального набора нужен опубликованный маршрут и подходящий гид.'}</span></div>{requestError&&<p className="error-message" role="alert">{requestError}</p>}<button className="button primary full" disabled={requestBusy}>{requestBusy?'Подождите…':trail.publicationStatus==='published'?'Открыть обсуждение':'Сохранить черновик'}</button></form>}</Modal>}
 {auth&&<AuthDialog onClose={closeAuth} onUser={()=>setAuth(false)}/>}
 </section></>;
}
