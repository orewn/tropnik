'use client';
import {useRouter} from 'next/navigation';
import {useState,useEffect,useLayoutEffect,useCallback,useMemo,useRef,useSyncExternalStore,useId,useDeferredValue,type FormEvent} from 'react';
import {MagnifyingGlass,ArrowRight,ArrowLeft,Mountains,Tree,WaveSine,MapPin,SlidersHorizontal,BookmarkSimple,CheckCircle,Info,X,Path,Clock,UsersThree,ArrowSquareOut,ShieldCheck,MapTrifold,List} from '@/components/TropnikIcons';
import {trails,type Trail} from '@/lib/content';
import {savedPackIds,savedPack,saveReference,type SavedPack} from '@/lib/local';
import {savedTrailSnapshot} from '@/lib/saved-route';
import {Offline} from './Offline';
import {MOBILE_NAVIGATION_EVENT,announceMobileDestination,closeMapOverlays,type MobileDestination} from '@/lib/mobile-navigation';
import {api,ApiError,errorText} from '@/lib/api';
import {publishedTrail} from '@/lib/route-adapter';
import {loadPublishedRoutes} from '@/lib/published-route';
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
import {DEFAULT_EXPLORE_FILTERS,exploreFiltersForRegion,exploreParentSelection,exploreTrailSelection,writeExploreHistory,writeExploreContext,readExploreContext,type ExploreListContext,type ExploreSelection,type ExploreFilters,type ExploreUiContext} from '@/lib/explore-navigation';
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
 const panelContent=useRef<HTMLDivElement>(null),searchInput=useRef<HTMLInputElement>(null);
 const scrollPositions=useRef(new Map<string,number>()),locationSequence=useRef(0);
 const [panelView,setPanelView]=useState<'map'|'saved'>('map'),[savedVisited,setSavedVisited]=useState(false);
 const [routeOrigin,setRouteOrigin]=useState<'catalog'|'saved'>('catalog'),[savedSnapshot,setSavedSnapshot]=useState(false);
 const [listOrigin,setListOrigin]=useState<ExploreListContext|undefined>();
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
 useEffect(()=>{const controller=new AbortController();let active=true;loadPublishedRoutes(controller.signal).then(r=>{if(active)setLiveTrails(r.map(publishedTrail));}).catch(()=>{});return()=>{active=false;controller.abort();};},[]);
 useLayoutEffect(()=>{
  if(window.location.pathname!=='/')return;
  return bindExploreScrollRestoration();
 },[]);
 const [region,setRegion]=useState<MapRegion|undefined>(mapRegionById(initialRegion||catalogById.get(initialTrail||'')?.regionId||''));
 const [trail,setTrail]=useState<Trail|undefined>(catalogById.get(initialTrail||''));
 const [query,setQuery]=useState(''),[filters,setFilters]=useState(DEFAULT_EXPLORE_FILTERS);
 const {expanded:filter,duration,onlySaved,difficulty}=exploreFiltersForRegion(region?.id,filters);
 const deferredQuery=useDeferredValue(query),searchPending=query!==deferredQuery;
 const [saved,setSaved]=useState<string[]>([]),[notice,setNotice]=useState(''),[saving,setSaving]=useState(''),[offline,setOffline]=useState(false),[sheetOpen,setSheetOpen]=useState(false);
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
 const contentKey=panelView==='saved'?'saved':trail?`route:${trail.id}`:`list:${listKey}`;
 useLayoutEffect(()=>{
  panelContent.current?.scrollTo({top:scrollPositions.current.get(contentKey)??0,behavior:'instant'});
  const previous=pendingPanelFocus.current;pendingPanelFocus.current=null;
  const active=document.activeElement;
  if(previous&&!previous.isConnected&&(!active||active===document.body||active===document.documentElement))panelHeading.current?.focus({preventScroll:true});
 },[contentKey]);
 const rememberScroll=()=>{
  if(!panelContent.current)return;
  scrollPositions.current.set(contentKey,panelContent.current.scrollTop);
  if(scrollPositions.current.size>40)scrollPositions.current.delete(scrollPositions.current.keys().next().value!);
 };
 const [page,setPage]=useState({key:'',limit:12});
 const limit=page.key===listKey?page.limit:12;
 const workspace=panelView==='saved'||routeOrigin==='saved'?'saved':'map';
 const mapContext=useRef<{region?:MapRegion;trail?:Trail;query:string;filters:ExploreFilters;listOrigin?:ExploreListContext;sheetOpen:boolean;viewportRegion?:string;page:typeof page}|undefined>(undefined);
 useEffect(()=>{
  if(workspace==='map')mapContext.current={region,trail,query,filters,listOrigin,sheetOpen,viewportRegion,page};
 },[workspace,region,trail,query,filters,listOrigin,sheetOpen,viewportRegion,page]);
 useEffect(()=>{let active=true;savedPackIds().then(ids=>{if(active)setSaved(ids);}).catch(()=>{});const sync=()=>setOffline(navigator.onLine===false);sync();window.addEventListener('online',sync);window.addEventListener('offline',sync);return()=>{active=false;window.removeEventListener('online',sync);window.removeEventListener('offline',sync);};},[]);
 useEffect(()=>{if(!notice)return;const id=setTimeout(()=>setNotice(''),7000);return()=>clearTimeout(id);},[notice]);
 const closeRequest=requestSession.close;
 const writeExploreState=useCallback((selection:ExploreSelection,mode:'push'|'replace'='push')=>{
  if(window.location.pathname!=='/')return;
  writeExploreHistory(window,selection,mode);
 },[]);
 const applyExploreLocation=useCallback(()=>{
  if(window.location.pathname!=='/')return;
  const sequence=++locationSequence.current,params=new URLSearchParams(location.search);
  const trailId=params.get('route')||'',nextTrail=catalogById.get(trailId),nextView=params.get('view')==='saved'?'saved':'map';
  const fromSaved=params.get('from')==='saved',context=readExploreContext(history.state);
  for(const position of context?.scroll??[])if(!scrollPositions.current.has(position.key))scrollPositions.current.set(position.key,position.top);
  if(context?.page)setPage(context.page);
  if(context?.mapContext){const retained=context.mapContext;mapContext.current={region:mapRegionById(retained.regionId||''),trail:catalogById.get(retained.trailId||''),query:retained.query,filters:retained.filters,listOrigin:retained.listOrigin,sheetOpen:retained.sheetOpen,page:retained.page};}
  const regionId=params.get('region')||nextTrail?.regionId||'',nextRegion=mapRegionById(regionId);
  closeMapOverlays();requestSession.select(nextTrail?.id,true);setAuth(false);
  setPanelView(nextView);if(nextView==='saved'||fromSaved)setSavedVisited(true);
  setRouteOrigin(fromSaved?'saved':'catalog');setSavedSnapshot(false);
  setQuery(context?.query??'');setFilters(context?.filters??DEFAULT_EXPLORE_FILTERS);setListOrigin(context?.listOrigin);
  setRegion(nextRegion);setTrail(nextTrail);setSheetOpen(context?.sheetOpen??Boolean(nextView==='saved'||nextRegion||nextTrail));setViewportRegion(undefined);
  if(fromSaved&&trailId)void savedPack(trailId).then(pack=>{
   if(sequence!==locationSequence.current)return;
   if(!pack){setNotice('Сохранённая карточка на этом устройстве не найдена.');return;}
   setTrail(savedTrailSnapshot(pack));setSavedSnapshot(true);
  }).catch(()=>{if(sequence===locationSequence.current)setNotice('Не удалось открыть сохранённую карточку. Проверьте доступ к хранилищу.');});
 },[catalogById,requestSession]);
 const initialLocation=useRef(false);
 useEffect(()=>{
  if(window.location.pathname!=='/')return;
  if(!initialLocation.current){initialLocation.current=true;applyExploreLocation();}
  window.addEventListener('popstate',applyExploreLocation);
  return()=>window.removeEventListener('popstate',applyExploreLocation);
 },[applyExploreLocation]);
 const currentUi=useRef<ExploreUiContext>({query:'',filters:DEFAULT_EXPLORE_FILTERS,sheetOpen:false});
 useLayoutEffect(()=>{currentUi.current={query,filters:{...filters,expanded:false},sheetOpen,listOrigin,page};},[query,filters,sheetOpen,listOrigin,page]);
 const persistContext=useCallback(()=>{
  if(window.location.pathname!=='/')return;
  const retained=mapContext.current;
  writeExploreContext(window,{...currentUi.current,scroll:[...scrollPositions.current].map(([key,top])=>({key,top})),mapContext:retained?{regionId:retained.region?.id,trailId:retained.trail?.id,query:retained.query,filters:{...retained.filters,expanded:false},listOrigin:retained.listOrigin,sheetOpen:retained.sheetOpen,page:retained.page}:undefined});
 },[]);
 useEffect(()=>{if(initialLocation.current)persistContext();},[persistContext,query,filters,sheetOpen,listOrigin,page,panelView,trail?.id,region?.id]);
 useEffect(()=>{
  const leave=(event:MouseEvent)=>{const link=event.target instanceof Element?event.target.closest<HTMLAnchorElement>('a[href]'):null;if(link&&new URL(link.href).pathname!==location.pathname)persistContext();};
  window.addEventListener('pagehide',persistContext);document.addEventListener('click',leave,true);
  return()=>{window.removeEventListener('pagehide',persistContext);document.removeEventListener('click',leave,true);};
 },[persistContext]);
 useEffect(()=>{announceMobileDestination(workspace);},[workspace]);
 useEffect(()=>{if(savedSnapshot||!trail?.id)return;const current=catalogById.get(trail.id);if(current&&current!==trail)queueMicrotask(()=>setTrail(previous=>previous?.id===current.id?current:previous));},[catalogById,trail,savedSnapshot]);
 const selectRegion=useCallback((r:MapRegion)=>{
  ++locationSequence.current;closeMapOverlays();requestSession.select();setAuth(false);setRegion(r);setViewportRegion(undefined);setTrail(undefined);setSavedSnapshot(false);setRouteOrigin('catalog');setPanelView('map');setListOrigin(undefined);setSheetOpen(true);setQuery('');setFilters(DEFAULT_EXPLORE_FILTERS);writeExploreState({regionId:r.id});
 },[writeExploreState,requestSession]);
 const selectTrail=useCallback((t:Trail,destination?:MapRegion)=>{
  ++locationSequence.current;closeMapOverlays();void preloadTrail(t);requestSession.select(t.id);setAuth(false);
  if(!trail||destination)setListOrigin({regionId:destination?.id??region?.id,query:destination?'':query,filters:destination?DEFAULT_EXPLORE_FILTERS:filters});
  setTrail(t);setSavedSnapshot(false);setRouteOrigin('catalog');setPanelView('map');
  const selection=exploreTrailSelection(t,region?.id,destination?.id);
  if(destination){setRegion(destination);setViewportRegion(undefined);setQuery('');}else if(!region)setRegion(mapRegionById(t.regionId));
  setSheetOpen(true);writeExploreState(selection);
 },[region,trail,query,filters,writeExploreState,requestSession]);
 const openSaved=useCallback((pack:SavedPack)=>{
  let snapshot:Trail;try{snapshot=savedTrailSnapshot(pack);}catch{setNotice('Сохранённая геометрия повреждена. Откройте источник и сохраните карточку заново.');return;}
  ++locationSequence.current;rememberPanelFocus();closeMapOverlays();requestSession.select(pack.id);setAuth(false);
  setTrail(snapshot);setRegion(mapRegionById(pack.regionId));setSavedSnapshot(true);setRouteOrigin('saved');setPanelView('map');setSheetOpen(true);
  writeExploreState({regionId:pack.regionId,trailId:pack.id,from:'saved'});
 },[rememberPanelFocus,requestSession,writeExploreState]);
 const navigateWorkspace=useCallback((next:MobileDestination)=>{
  if(next==='map'&&workspace==='map'||next==='saved'&&panelView==='saved')return;
  ++locationSequence.current;rememberPanelFocus();closeMapOverlays();requestSession.close();setAuth(false);
  if(next==='map'){
   const context=mapContext.current;
   setPanelView('map');setRouteOrigin('catalog');setSavedSnapshot(false);
   setRegion(context?.region);setTrail(context?.trail);setQuery(context?.query??'');setFilters(context?.filters??DEFAULT_EXPLORE_FILTERS);setListOrigin(context?.listOrigin);setSheetOpen(context?.sheetOpen??false);setViewportRegion(context?.viewportRegion);if(context)setPage(context.page);
   writeExploreState({regionId:context?.region?.id,trailId:context?.trail?.id});
  }else{
   setPanelView('saved');setSheetOpen(true);setSavedVisited(true);setFilters(current=>({...current,expanded:false}));
   writeExploreState({regionId:region?.id,trailId:trail?.id,view:'saved'});
  }
 },[workspace,panelView,rememberPanelFocus,requestSession,region?.id,trail?.id,writeExploreState]);
 useEffect(()=>{
  const navigate=(event:Event)=>{const next=(event as CustomEvent<MobileDestination>).detail;if(next!=='map'&&next!=='saved')return;event.preventDefault();navigateWorkspace(next);};
  window.addEventListener(MOBILE_NAVIGATION_EVENT,navigate);
  return()=>window.removeEventListener(MOBILE_NAVIGATION_EVENT,navigate);
 },[navigateWorkspace]);
 const backToParent=useCallback(()=>{
  ++locationSequence.current;rememberPanelFocus();closeMapOverlays();requestSession.select();setAuth(false);setSheetOpen(true);
  if(trail&&routeOrigin==='saved'){setPanelView('saved');writeExploreState({regionId:region?.id,trailId:trail.id,view:'saved'});return;}
  const parent=trail&&listOrigin?{regionId:listOrigin.regionId}:exploreParentSelection({regionId:region?.id,trailId:trail?.id});
  setTrail(undefined);setSavedSnapshot(false);setRegion(mapRegionById(parent.regionId||''));setViewportRegion(undefined);
  if(trail&&listOrigin){setQuery(listOrigin.query);setFilters(listOrigin.filters);}else if(!parent.regionId){setQuery('');setFilters(DEFAULT_EXPLORE_FILTERS);}
  setListOrigin(undefined);writeExploreState(parent);
 },[region?.id,trail,routeOrigin,listOrigin,writeExploreState,requestSession,rememberPanelFocus]);
 const openSearch=useCallback(()=>{
  ++locationSequence.current;closeMapOverlays();requestSession.select();setAuth(false);setPanelView('map');setRouteOrigin('catalog');setTrail(undefined);setSavedSnapshot(false);setSheetOpen(true);
  if(workspace==='saved'){const context=mapContext.current;setRegion(context?.region);setQuery(context?.query??'');setFilters({...context?.filters??DEFAULT_EXPLORE_FILTERS,expanded:false});setListOrigin(undefined);if(context)setPage(context.page);writeExploreState({regionId:context?.region?.id});}
  else if(trail&&listOrigin){setRegion(mapRegionById(listOrigin.regionId||''));setQuery(listOrigin.query);setFilters({...listOrigin.filters,expanded:false});writeExploreState({regionId:listOrigin.regionId});}
  else{setFilters(current=>({...current,expanded:false}));writeExploreState({regionId:region?.id});}
  requestAnimationFrame(()=>{const input=searchInput.current,panel=panelContent.current;if(!input||!panel)return;panel.scrollTop+=input.getBoundingClientRect().top-panel.getBoundingClientRect().top-12;input.focus({preventScroll:true});});
 },[workspace,requestSession,trail,listOrigin,region?.id,writeExploreState]);
 const submitSearch=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();closeMapOverlays();setSheetOpen(true);searchInput.current?.blur();};
 const showMap=()=>{closeMapOverlays();setSheetOpen(false);if(document.activeElement instanceof HTMLElement)document.activeElement.blur();};
 const save=useCallback(async(t:Trail)=>{setSaving(t.id);try{await saveReference(t);setSaved(await savedPackIds());setNotice('Карточка сохранена на этом устройстве. Дата проверки и источник сохранены вместе с ней.');}catch(e){setNotice(errorText(e, 'storage'));}finally{setSaving('');}},[]);
 const restoreSavedScroll=useCallback(()=>{requestAnimationFrame(()=>{if(sheetLayout.current?.dataset.panelView==='saved')panelContent.current?.scrollTo({top:scrollPositions.current.get('saved')??0,behavior:'instant'});});},[]);
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
 const savedIds=useMemo(()=>new Set(saved),[saved]);
 const regionalTrails=useMemo(()=>region?regionCatalog.get(region.id)??[]:catalog,[catalog,region,regionCatalog]);
 const routeSearch=useMemo(()=>deferredQuery.trim()?searchRoutes(deferredQuery):null,[deferredQuery,searchRoutes]);
 const shownTrails=useMemo(()=>{
  const ranks=routeSearch?new Map(routeSearch.results.map((hit,index)=>[hit.id,index])):null;
  const selected=filterMapTrails(regionalTrails,{query:'',difficulty,duration,onlySaved,savedIds});
  return ranks?selected.filter(item=>ranks.has(item.id)).sort((a,b)=>ranks.get(a.id)!-ranks.get(b.id)!):selected;
 },[regionalTrails,routeSearch,difficulty,duration,onlySaved,savedIds]);
 const sheetPreviewKind=panelView==='saved'?'На устройстве':trail?'Маршрут':region?'Направление':'Каталог';
 const routeStatus=trail?.accessStatus==='closed'?'Посещение закрыто по сведениям источника.':trail?.accessStatus==='restricted'?'Есть ограничения доступа. Уточните разрешённый путь перед выходом.':trail?.publicationStatus==='reference'?'Справочные данные. Условия выхода ещё не подтверждены.':'Проверьте текущие условия перед выходом.';
 const sheetPreviewTitle=panelView==='saved'?'Сохранённые маршруты':trail?.title??region?.name??'Маршруты и направления';
 const sheetPreviewMeta=panelView==='saved'?'Карточки и доступные офлайн-пакеты':trail
  ?[trail.distanceKm!=null?`${trail.distanceKm.toLocaleString('ru')} км${trail.distanceNote ? ' · '+trail.distanceNote : ''}`:undefined,trail.duration].filter(Boolean).join(' · ')||'Открыть карточку маршрута'
  :routeCountPreview(region?shownTrails.length:catalog.length);
 return <><MapResourceHints/><section ref={sheetLayout} className={`explore-layout ${sheetOpen?'sheet-open':'sheet-closed'}`} data-sheet-state={sheetOpen?'open':'closed'} data-panel-view={panelView} data-route-origin={routeOrigin} data-route-detail={panelView==='map'&&trail?'true':undefined} aria-label="Поиск маршрутов"><aside ref={sheetPanel} id={sheetPanelId} className={`explore-panel ${sheetOpen?'expanded':'collapsed'}`}>
 <div className="mobile-sheet-toolbar"><button className="mobile-search-launch" type="button" onClick={openSearch}><MagnifyingGlass size={20}/><span>{query||'Найти маршрут'}</span></button>
 <button ref={sheetHandle} className="sheet-handle" type="button" onClick={event=>{closeMapOverlays();setSheetOpen(open=>!open);if(event.detail>0&&window.matchMedia('(pointer:coarse)').matches)event.currentTarget.blur();}} aria-controls={sheetPanelId} aria-expanded={sheetOpen} aria-label={sheetOpen?'Показать карту':'Открыть список'}><span className="sheet-grip"/>{sheetOpen?<MapTrifold size={20}/>:<List size={20}/>}<span className="sheet-view-label">{sheetOpen?'Карта':'Список'}</span></button></div>
 <div className="sheet-peek-row" hidden={sheetOpen}><button ref={sheetPreview} className="sheet-peek-summary" type="button" hidden={sheetOpen} onClick={event=>{setSheetOpen(true);if(event.detail>0&&window.matchMedia('(pointer:coarse)').matches)event.currentTarget.blur();}} aria-label={`Открыть: ${sheetPreviewTitle}`}>
  <span className="sheet-peek-copy"><small>{sheetPreviewKind}</small><strong>{sheetPreviewTitle}</strong><span data-overview-count="sheet">{sheetPreviewMeta}</span></span><ArrowRight size={20}/>
 </button>{trail&&panelView==='map'&&<button className="mobile-peek-save" type="button" disabled={saving===trail.id} aria-busy={saving===trail.id} aria-label={savedIds.has(trail.id)?'Обновить сохранённую карточку':'Сохранить карточку офлайн'} onClick={()=>save(trail)}><BookmarkSimple size={22} weight={savedIds.has(trail.id)?'fill':'regular'}/><span>{saving===trail.id?'…':savedIds.has(trail.id)?'Сохранено':'Сохранить'}</span></button>}</div>
 <div className="explore-panel-content" ref={panelContent} onScroll={rememberScroll} aria-busy={searchPending}>
 {savedVisited&&<div className="saved-workspace" hidden={panelView!=='saved'}><h1 ref={panelView==='saved'?panelHeading:undefined} tabIndex={-1} className="heading-4">Сохранено</h1><p className="muted">Карточки и пакеты на этом устройстве</p><Offline compact active={panelView==='saved'} onOpenSaved={openSaved} onChooseRoute={()=>navigateWorkspace('map')} onSavedChange={setSaved} onContentReady={restoreSavedScroll}/></div>}
 {panelView==='map'&&(trail?<><button type="button" className="back-link" onClick={backToParent}><ArrowLeft size={17}/>{routeOrigin==='saved'?'Сохранённые':listOrigin&&!listOrigin.regionId?'Результаты поиска':'Маршруты направления'}</button><div className="eyebrow">{mapRegionById(trail.regionId)?.name}</div><h1 ref={panelHeading} tabIndex={-1} className="route-title heading-4">{trail.title}</h1><p className="panel-intro body-6">{trail.subtitle}</p><div className="route-status"><Info size={18}/><span>{routeStatus}</span></div>{trail.operatingNotice&&<div className="route-restriction"><strong>{trail.operatingNotice.title}</strong>{trail.operatingNotice.body}<a href={trail.operatingNotice.url} target="_blank" rel="noreferrer">Официальное сообщение <ArrowSquareOut size={12}/></a></div>}<div className="route-summary"><div><Path size={20}/><strong>{trail.distanceKm?.toLocaleString('ru')??'—'}<small> км</small></strong><span>{trail.distanceNote || 'длина по источнику'}</span></div><div><Clock size={20}/><strong>{trail.duration??'—'}</strong><span>время по источнику</span></div></div><div className="route-section"><h3>О маршруте</h3><p>{trail.description}</p>{!trail.geometryUrl&&!trail.geometry&&<p className="source-note">{trailGeometryDescription(trail)}</p>}<span className={`difficulty difficulty-${trail.difficulty}`}>{trail.difficultyLabel}</span><SourceDifficulty trail={trail}/></div><div className="route-section"><h3>Условия посещения</h3><ul className="check-list">{trail.notes.map(n=><li key={n}><CheckCircle size={17}/><span>{n}</span></li>)}</ul></div><div className="route-section source-block"><ShieldCheck size={23}/><div><strong>{trail.sourceName}</strong><span>{sourceDateLabel(trail.sourceKind)} {formatEvidenceDate(trail.checkedAt)}</span><a href={trail.sourceUrl} target="_blank" rel="noreferrer">Открыть описание <ArrowSquareOut size={13}/></a></div></div>{trail.officialEvidence&&<div className="route-section"><h3>Что подтвердил официальный источник</h3><p>{trail.officialEvidence.summary}</p>{trail.officialEvidence.scope&&<p className="source-scope">{trail.officialEvidence.scope}</p>}<a className="text-link" href={trail.officialEvidence.url} target="_blank" rel="noreferrer">Читать первоисточник <ArrowSquareOut size={12}/></a><p className="source-note">Описание прочитано {trail.officialEvidence.checkedAt}. Линия маршрута и условия на местности требуют отдельной проверки.</p></div>}<div className="route-actions"><h3>Планирование похода</h3><button className="button secondary full" data-route-action="request" disabled={trail.accessStatus==='closed'} onClick={()=>requestSession.open(trail.id)}><UsersThree size={20}/>{trail.accessStatus==='closed'?'Маршрут закрыт':trail.publicationStatus==='published'?'Открыть набор на маршрут':'Подготовить запрос на поход'}</button>{!!(trail.geometryUrl||trail.geometry)&&<a href={`/planner?route=${encodeURIComponent(trail.id)}`} className="button secondary full"><Path size={18}/>Составить поход из троп</a>}<a href={`/routes/${trail.id}`} className="text-link">Подробная страница маршрута <ArrowRight size={16}/></a></div></>:
 <><div className="catalog-introduction" data-region={region?'selected':'overview'}><div className="panel-title-row">{region?<button type="button" className="back-link" onClick={backToParent}><ArrowLeft size={17}/>Все направления</button>:<span className="eyebrow">Место встречи — природа</span>}</div><h1 ref={panelHeading} tabIndex={-1} className="heading-4">{region?region.name:<>Найдите<br/>{' '}свою тропу<span className="heading-dot">.</span></>}</h1><p className="panel-intro body-6">{region?region.caption:'Маршруты по России. Походы с гидом. Люди, которым по пути.'}</p></div><form className="map-search-form" role="search" onSubmit={submitSearch}><label className="search-field"><MagnifyingGlass size={20}/><input ref={searchInput} data-map-search-input disabled={!hydrated} type="search" maxLength={160} autoComplete="off" enterKeyHint="search" aria-label={region?'Поиск маршрута':'Поиск маршрута или направления'} placeholder={region?'Название маршрута':'Куда хочется отправиться?'} value={query} onFocus={()=>{closeMapOverlays();setSheetOpen(true);}} onChange={e=>setQuery(e.target.value)}/>{query&&<button type="button" onClick={()=>setQuery('')} aria-label="Очистить поиск"><X size={16}/></button>}</label><button className="map-search-submit" type="submit" aria-label="Показать результаты поиска"><ArrowRight size={20}/></button></form><span className="sr-only" role="status">{searchPending?'Обновляем результаты маршрутов.':''}</span>
 {query.trim()&&<a className="text-link" href={`/search?q=${encodeURIComponent(query)}`}>Искать по всему сайту <ArrowRight size={16}/></a>}
 {region&&<div className="filter-row"><button className={filter?'filter-button selected':'filter-button'} data-filter-action="expand" aria-expanded={filter} onClick={()=>{closeMapOverlays();setFilters(current=>({...current,expanded:!current.expanded}));}}><SlidersHorizontal size={18}/>Фильтры{(difficulty!=='all'||duration!=='any')&&<span className="filter-count">{Number(difficulty!=='all')+Number(duration!=='any')}</span>}</button><button className={onlySaved?'filter-button selected':'filter-button'} data-filter-action="saved" aria-pressed={onlySaved} onClick={()=>setFilters(current=>({...current,onlySaved:!current.onlySaved}))}><BookmarkSimple size={17} weight={onlySaved?'fill':'regular'}/>Сохранённые</button></div>}

 {!region?<><TerritoryBrowser query={deferredQuery} catalogByRegion={regionCatalog} onSelect={selectRegionFromPanel} onClear={clearQuery}/>{query.trim()&&<section aria-label="Найденные маршруты"><div className="section-heading"><h2 className="title-3">Маршруты по запросу</h2><span data-result-count>{shownTrails.length}</span></div>{shownTrails.length?<><div className="trail-list">{shownTrails.slice(0,limit).map(t=><TrailCard key={t.id} trail={t} onSelect={selectTrailFromPanel} saved={savedIds.has(t.id)} onSave={save}/>)}</div>{shownTrails.length>limit&&<button className="button secondary full" onClick={()=>setPage({key:listKey,limit:limit+12})}>Ещё маршруты</button>}</>:<p className="muted">Попробуйте название тропы, озера или горы.</p>}</section>}</>:
 <><div className="section-heading"><h2 className="title-3">{region.territory?'Тропы из источников':'Маршруты'}</h2><span data-result-count>{shownTrails.length}</span></div>{shownTrails.length?<div className="trail-list">{shownTrails.slice(0,limit).map(t=><TrailCard key={t.id} trail={t} onSelect={selectTrailFromPanel} saved={savedIds.has(t.id)} onSave={save}/>)}</div>:<div className="catalog-empty"><div className="empty-landscape">{terrainIcon(region.id,48)}</div><h3>{onlySaved?'Здесь пока ничего не сохранено':query||difficulty!=='all'||duration!=='any'||onlySaved?'Подходящих маршрутов не найдено':region.territory?'Справочных маршрутов пока нет':'Готовим каталог этого направления'}</h3><p>{query||difficulty!=='all'||duration!=='any'||onlySaved?'Измените фильтры или попробуйте другое название.':'Территория доступна на карте. Маршруты появятся после добавления источников; набор — после проверки маршрута и допуска гида.'}</p>{query||difficulty!=='all'||duration!=='any'||onlySaved?<button className="button secondary" onClick={()=>{setQuery('');setFilters(current=>({...DEFAULT_EXPLORE_FILTERS,expanded:current.expanded}));}}>Сбросить фильтры</button>:<a className="button secondary" href="/guides">Я гид в этом регионе <ArrowRight size={17}/></a>}</div>}{shownTrails.length>limit&&<button className="button secondary full" style={{marginTop:15}} onClick={()=>setPage({key:listKey,limit:limit+12})}>Показать ещё · осталось {shownTrails.length-limit}</button>}{region.territory&&liveTrails.length>0&&<a className="region-detail-link" href="/trips"><UsersThree size={18}/><span>Походы с гидом</span><ArrowRight size={17}/></a>}{!region.territory&&<a className="region-detail-link" href={`/regions/${region.id}`}><MapPin size={18}/><span>Об этом направлении</span><ArrowRight size={17}/></a>}<div className="info-compact"><Info size={18}/><p>Тропа на карте может быть закрыта или требовать разрешения. Актуальный статус проверяется отдельно.</p></div></>}
 </>)}
 </div>{panelView==='map'&&trail&&<div className="route-primary-actions"><button className="button primary" type="button" data-route-action="save" aria-label={savedIds.has(trail.id)?'Обновить сохранённую карточку':'Сохранить карточку офлайн'} aria-pressed={savedIds.has(trail.id)} disabled={saving===trail.id} aria-busy={saving===trail.id} onClick={()=>save(trail)}><BookmarkSimple size={20} weight={savedIds.has(trail.id)?'fill':'regular'}/>{saving===trail.id?'Сохраняем…':savedIds.has(trail.id)?'Обновить':'Сохранить'}</button><button className="button secondary" type="button" data-route-action="map" onClick={showMap}><MapTrifold size={20}/>На карте</button></div>}<div className="panel-foot caption-4"><span className={offline?'connection-dot offline':'connection-dot'}/>{offline?'Без сети · сохранённые данные':'Планируйте онлайн, берите маршрут с собой'}<a href="/offline" aria-label="Возможности офлайн"><ArrowRight size={16}/></a></div></aside>
 <Atlas workspace={workspace} region={region} trail={trail} visibleTrails={shownTrails} catalogTrails={catalog} onTrail={selectTrail} onRegion={selectRegion} onMapNote={setNotice} onViewportRegion={setViewportRegion}/>
 <PlaceStories regionId={viewportRegion||region?.id} routeId={trail?.id} onPlace={selectStoryPlace}/>
 {notice&&<div className="toast" role="status"><CheckCircle size={20}/><span>{notice}</span><button aria-label="Закрыть уведомление" onClick={()=>setNotice('')}><X size={17}/></button></div>}
 {filter&&region&&panelView==='map'&&!trail&&<Modal title="Фильтры маршрутов" onClose={()=>setFilters(current=>({...current,expanded:false}))}><div className="filters"><label>Сложность<select data-filter-field="difficulty" value={difficulty} onChange={e=>setFilters(current=>({...current,difficulty:e.target.value}))}><option value="all">Любая, включая непроверенную</option><option value="easy">Для начинающих</option><option value="moderate">Нужен опыт</option><option value="hard">Технически сложный</option><option value="unknown">Ещё не оценена</option></select></label><label>Продолжительность<select data-filter-field="duration" value={duration} onChange={e=>setFilters(current=>({...current,duration:e.target.value}))}><option value="any">Любая</option><option value="day">Есть почасовая оценка</option></select></label><button className="text-link" data-filter-action="reset" onClick={()=>{setFilters(current=>({...DEFAULT_EXPLORE_FILTERS,expanded:current.expanded}));}}>Сбросить фильтры</button></div><button className="button primary full" data-filter-action="apply" type="button" onClick={()=>setFilters(current=>({...current,expanded:false}))}>Показать маршруты · {shownTrails.length}</button></Modal>}
 {request&&!auth&&trail&&<Modal title={draftSaved?'Запрос сохранён на устройстве':'Какой поход планируете?'} onClose={closeRequest}>{draftSaved?<div className="success-panel"><CheckCircle size={44}/><p>Это личный черновик. Он ещё не опубликован, гид не назначен и место в группе не забронировано.</p><button className="button primary" onClick={closeRequest}>Понятно</button></div>:<form className="stack" onSubmit={submitRequest}><p className="muted">{trail.title}</p><label>Желаемая дата<input type="date" required value={date} min={new Date().toISOString().slice(0,10)} onChange={e=>requestSession.edit('date',e.target.value)}/></label><label>Что важно для вас<textarea value={note} onChange={e=>requestSession.edit('note',e.target.value)} maxLength={1000} rows={4} placeholder="Опыт, удобные даты, пожелания к группе"/></label><div className="inline-note"><Info size={20}/><span>{trail.publicationStatus==='published'?'Откроется обсуждение с набором желающих. Подходящий гид назначит выход; участие в конкретной дате нужно подтвердить отдельно.':'Сейчас можно подготовить личный черновик. Для реального набора нужен опубликованный маршрут и подходящий гид.'}</span></div>{requestError&&<p className="error-message" role="alert">{requestError}</p>}<button className="button primary full" disabled={requestBusy}>{requestBusy?'Подождите…':trail.publicationStatus==='published'?'Открыть обсуждение':'Сохранить черновик'}</button></form>}</Modal>}
 {auth&&<AuthDialog onClose={closeAuth} onUser={()=>setAuth(false)}/>}
 </section></>;
}
