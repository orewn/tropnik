from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1))

def append_once(relative: str, marker: str, addition: str) -> None:
    path = ROOT / relative
    text = path.read_text()
    if marker in text:
        return
    path.write_text(text.rstrip() + "\n" + addition.strip() + "\n")

# Explore: keep typing responsive, avoid repeated O(n²) scans, and make browser history real.
replace_once(
    "web/components/Explore.tsx",
    "import {useState,useEffect,useCallback,useMemo,useRef,useSyncExternalStore,useId} from 'react';",
    "import {useState,useEffect,useCallback,useMemo,useRef,useSyncExternalStore,useId,useDeferredValue} from 'react';",
)
replace_once(
    "web/components/Explore.tsx",
    " const catalog=useMemo(()=>[...liveTrails,...trails.filter(t=>!liveTrails.some(x=>x.id===t.id))],[liveTrails]);",
    """ const catalog=useMemo(()=>{const liveIds=new Set(liveTrails.map(item=>item.id));return [...liveTrails,...trails.filter(item=>!liveIds.has(item.id))];},[liveTrails]);
 const catalogById=useMemo(()=>new Map(catalog.map(item=>[item.id,item])),[catalog]);""",
)
replace_once(
    "web/components/Explore.tsx",
    """ const [query,setQuery]=useState(''),[filter,setFilter]=useState(false),[duration,setDuration]=useState('any'),[onlySaved,setOnlySaved]=useState(false),[difficulty,setDifficulty]=useState('all');
 const [saved,setSaved]=useState<SavedPack[]>([]),[notice,setNotice]=useState(''),[saving,setSaving]=useState(''),[request,setRequest]=useState(false),[date,setDate]=useState(''),[note,setNote]=useState(''),[offline,setOffline]=useState(false),[draftSaved,setDraftSaved]=useState(false),[sheetOpen,setSheetOpen]=useState(false);""",
    """ const [query,setQuery]=useState(''),[filter,setFilter]=useState(false),[duration,setDuration]=useState('any'),[onlySaved,setOnlySaved]=useState(false),[difficulty,setDifficulty]=useState('all');
 const deferredQuery=useDeferredValue(query),searchPending=query!==deferredQuery;
 const [saved,setSaved]=useState<SavedPack[]>([]),[notice,setNotice]=useState(''),[saving,setSaving]=useState(''),[request,setRequest]=useState(false),[date,setDate]=useState(''),[note,setNote]=useState(''),[offline,setOffline]=useState(false),[draftSaved,setDraftSaved]=useState(false),[sheetOpen,setSheetOpen]=useState(false);""",
)
replace_once(
    "web/components/Explore.tsx",
    " useEffect(()=>setLimit(12),[region?.id,query,difficulty,duration,onlySaved]);",
    " useEffect(()=>setLimit(12),[region?.id,deferredQuery,difficulty,duration,onlySaved]);",
)
replace_once(
    "web/components/Explore.tsx",
    """ const closeRequest=useCallback(()=>{setRequest(false);setDraftSaved(false);},[]);
 const selectRegion=useCallback((r:MapRegion)=>{setRegion(r);setViewportRegion(undefined);setTrail(undefined);setSheetOpen(true);setQuery('');if(window.location.pathname==='/')history.replaceState(null,'',`/?region=${r.id}`);},[]);
 const selectTrail=useCallback((t:Trail)=>{void preloadTrail(t);setTrail(t);if(!region)setRegion(regionById(t.regionId));setSheetOpen(true);if(window.location.pathname==='/')history.replaceState(null,'',`/?region=${region?.id||t.regionId}&route=${encodeURIComponent(t.id)}`);},[region?.id]);""",
    """ const closeRequest=useCallback(()=>{setRequest(false);setDraftSaved(false);},[]);
 const writeExploreState=useCallback((nextRegion?:string,nextTrail?:string,mode:'push'|'replace'='push')=>{
  if(window.location.pathname!=='/')return;
  const url=new URL(location.href);
  if(nextRegion)url.searchParams.set('region',nextRegion);else url.searchParams.delete('region');
  if(nextTrail)url.searchParams.set('route',nextTrail);else url.searchParams.delete('route');
  const current=history.state&&typeof history.state==='object'?history.state:{};
  const state={...current,tropnikExplore:true,tropnikExploreLevel:nextTrail?2:nextRegion?1:0,tropnikExplorePushed:mode==='push'||current.tropnikExplorePushed===true};
  history[mode==='push'?'pushState':'replaceState'](state,'',url);
 },[]);
 const applyExploreLocation=useCallback(()=>{
  if(window.location.pathname!=='/')return;
  const params=new URLSearchParams(location.search),trailId=params.get('route')||'',nextTrail=catalogById.get(trailId);
  const regionId=params.get('region')||nextTrail?.regionId||'',nextRegion=territoryById(regionId)||regionById(regionId);
  setRegion(nextRegion);setTrail(nextTrail);setSheetOpen(Boolean(nextRegion||nextTrail));setViewportRegion(undefined);
 },[catalogById]);
 useEffect(()=>{
  if(window.location.pathname!=='/')return;
  writeExploreState(region?.id,trail?.id,'replace');
  const onPopState=()=>applyExploreLocation();
  window.addEventListener('popstate',onPopState);
  return()=>window.removeEventListener('popstate',onPopState);
 },[applyExploreLocation,writeExploreState,region?.id,trail?.id]);
 useEffect(()=>{if(!trail?.id)return;const current=catalogById.get(trail.id);if(current&&current!==trail)setTrail(current);},[catalogById,trail?.id]);
 const selectRegion=useCallback((r:MapRegion)=>{setRegion(r);setViewportRegion(undefined);setTrail(undefined);setSheetOpen(true);setQuery('');writeExploreState(r.id);},[writeExploreState]);
 const selectTrail=useCallback((t:Trail)=>{void preloadTrail(t);setTrail(t);const nextRegion=region?.id||t.regionId;if(!region)setRegion(regionById(t.regionId));setSheetOpen(true);writeExploreState(nextRegion,t.id);},[region,writeExploreState]);
 const backToRegion=useCallback(()=>{if(window.location.pathname==='/'&&history.state?.tropnikExplorePushed===true&&history.state?.tropnikExploreLevel===2){history.back();return;}setTrail(undefined);writeExploreState(region?.id,undefined,'replace');},[region?.id,writeExploreState]);
 const backToDirections=useCallback(()=>{if(window.location.pathname==='/'&&history.state?.tropnikExplorePushed===true&&history.state?.tropnikExploreLevel===1){history.back();return;}setRegion(undefined);setTrail(undefined);setQuery('');writeExploreState(undefined,undefined,'replace');},[writeExploreState]);""",
)
replace_once(
    "web/components/Explore.tsx",
    """ async function save(t:Trail){setSaving(t.id);try{await saveReference(t);setSaved(await packs());setNotice('Карточка сохранена на этом устройстве. Дата проверки и источник сохранены вместе с ней.');}catch(e){setNotice(errorText(e));}finally{setSaving('');}}
 const regionalTrails=useMemo(()=>region?catalog.filter(t=>trailBelongsToRegion(t,region)):catalog,[catalog,region?.id]);
 const routeSearch=useMemo(()=>query.trim()?searchSite(query,{kind:'route'}):null,[query]);
 const shownTrails=useMemo(()=>{
  const ranks=routeSearch?new Map(routeSearch.results.map((hit,index)=>[hit.id,index])):null;
  const selected=filterMapTrails(regionalTrails,{query:'',difficulty,duration,onlySaved,savedIds:new Set(saved.map(item=>item.id))});
  return ranks?selected.filter(item=>ranks.has(item.id)).sort((a,b)=>ranks.get(a.id)!-ranks.get(b.id)!):selected;
 },[regionalTrails,routeSearch,difficulty,duration,onlySaved,saved]);""",
    """ async function save(t:Trail){setSaving(t.id);try{await saveReference(t);setSaved(await packs());setNotice('Карточка сохранена на этом устройстве. Дата проверки и источник сохранены вместе с ней.');}catch(e){setNotice(errorText(e));}finally{setSaving('');}}
 const savedIds=useMemo(()=>new Set(saved.map(item=>item.id)),[saved]);
 const regionalTrails=useMemo(()=>region?catalog.filter(t=>trailBelongsToRegion(t,region)):catalog,[catalog,region]);
 const routeSearch=useMemo(()=>deferredQuery.trim()?searchSite(deferredQuery,{kind:'route'}):null,[deferredQuery]);
 const shownTrails=useMemo(()=>{
  const ranks=routeSearch?new Map(routeSearch.results.map((hit,index)=>[hit.id,index])):null;
  const selected=filterMapTrails(regionalTrails,{query:'',difficulty,duration,onlySaved,savedIds});
  return ranks?selected.filter(item=>ranks.has(item.id)).sort((a,b)=>ranks.get(a.id)!-ranks.get(b.id)!):selected;
 },[regionalTrails,routeSearch,difficulty,duration,onlySaved,savedIds]);""",
)
replace_once(
    "web/components/Explore.tsx",
    '<div className="explore-panel-content" ref={panelContent}>',
    '<div className="explore-panel-content" ref={panelContent} aria-busy={searchPending}>',
)
replace_once(
    "web/components/Explore.tsx",
    """{trail?<><button className="back-link" onClick={()=>{setTrail(undefined);if(window.location.pathname==='/')history.replaceState(null,'',region?`/?region=${region.id}`:'/');}}><ArrowLeft size={17}/>Маршруты направления</button>""",
    """{trail?<><button type="button" className="back-link" onClick={backToRegion}><ArrowLeft size={17}/>Маршруты направления</button>""",
)
replace_once(
    "web/components/Explore.tsx",
    """{region?<button className="back-link" onClick={()=>{setRegion(undefined);setQuery('');if(window.location.pathname==='/')history.replaceState(null,'','/');}}><ArrowLeft size={17}/>Все направления</button>""",
    """{region?<button type="button" className="back-link" onClick={backToDirections}><ArrowLeft size={17}/>Все направления</button>""",
)
replace_once(
    "web/components/Explore.tsx",
    """<label className="search-field"><MagnifyingGlass size={20}/><input disabled={!hydrated} aria-label={region?'Поиск маршрута':'Поиск маршрута или направления'} placeholder={region?'Название маршрута':'Куда хочется отправиться?'} value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button onClick={()=>setQuery('')} aria-label="Очистить поиск"><X size={16}/></button>}</label>""",
    """<label className="search-field"><MagnifyingGlass size={20}/><input disabled={!hydrated} type="search" maxLength={160} autoComplete="off" enterKeyHint="search" aria-label={region?'Поиск маршрута':'Поиск маршрута или направления'} placeholder={region?'Название маршрута':'Куда хочется отправиться?'} value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button type="button" onClick={()=>setQuery('')} aria-label="Очистить поиск"><X size={16}/></button>}</label><span className="sr-only" role="status">{searchPending?'Обновляем результаты маршрутов.':''}</span>""",
)
replace_once("web/components/Explore.tsx", "<TerritoryBrowser query={query}", "<TerritoryBrowser query={deferredQuery}")
replace_once("web/components/Explore.tsx", "saved={saved.some(s=>s.id===t.id)}", "saved={savedIds.has(t.id)}")
replace_once("web/components/Explore.tsx", "saved={saved.some(s=>s.id===t.id)}", "saved={savedIds.has(t.id)}")
replace_once("web/components/Explore.tsx", "saved.some(s=>s.id===trail.id)", "savedIds.has(trail.id)")

# Territory catalogue: memoize the expensive route membership matrix and never speculate on touch.
replace_once(
    "web/components/TerritoryBrowser.tsx",
    "import {useEffect, useState} from 'react';",
    "import {useEffect, useMemo, useState} from 'react';",
)
replace_once(
    "web/components/TerritoryBrowser.tsx",
    "import {RegionArtwork} from './RegionArtwork';\n",
    "import {RegionArtwork} from './RegionArtwork';\n\nconst searchableRegions = [...regions, ...territories];\n",
)
replace_once(
    "web/components/TerritoryBrowser.tsx",
    """  const normalized = query.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const all = mode === 'territories' || !!normalized;
  const choices = (normalized ? [...regions, ...territories] : all ? territories : regions).filter(item =>
    `${item.name} ${item.terrain}`.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(normalized));
  useEffect(() => setLimit(18), [mode, query]);""",
    """  const normalized = useMemo(() => query.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е'), [query]);
  const all = mode === 'territories' || !!normalized;
  const choices = useMemo(() => (normalized ? searchableRegions : all ? territories : regions).filter(item =>
    `${item.name} ${item.terrain}`.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(normalized)), [all, normalized]);
  const routeCounts = useMemo(() => new Map(searchableRegions.map(item => [
    item.id,
    catalog.reduce((count, trail) => count + Number(trailBelongsToRegion(trail, item)), 0),
  ])), [catalog]);
  useEffect(() => setLimit(18), [mode, normalized]);""",
)
replace_once(
    "web/components/TerritoryBrowser.tsx",
    """      <button aria-pressed={!all} onClick={() => {setMode('directions'); onClear();}}>Направления <span>{regions.length}</span></button>
      <button aria-pressed={all} onClick={() => setMode('territories')}>Все территории <span>{territories.length}</span></button>""",
    """      <button type="button" aria-pressed={!all} onClick={() => {setMode('directions'); onClear();}}>Направления <span>{regions.length}</span></button>
      <button type="button" aria-pressed={all} onClick={() => setMode('territories')}>Все территории <span>{territories.length}</span></button>""",
)
replace_once(
    "web/components/TerritoryBrowser.tsx",
    """        const count = catalog.filter(trail => trailBelongsToRegion(trail, item)).length;
        const warm = () => {if (item.id === 'krasnodar') void preloadTerrain();};
        return <button className="region-option" key={item.id} onPointerEnter={warm} onFocus={warm} onTouchStart={warm} onClick={() => onSelect(item)}>""",
    """        const count = routeCounts.get(item.id) ?? 0;
        const warm = () => {
          const connection = (navigator as Navigator & {connection?: {saveData?: boolean; effectiveType?: string}}).connection;
          if (item.id === 'krasnodar' && !connection?.saveData && !/(?:^|-)2g$/.test(connection?.effectiveType || '')) void preloadTerrain();
        };
        return <button type="button" className="region-option" key={item.id} onPointerEnter={warm} onFocus={warm} onClick={() => onSelect(item)}>""",
)
replace_once("web/components/TerritoryBrowser.tsx", '<button className="territory-more button secondary full"', '<button type="button" className="territory-more button secondary full"')
replace_once("web/components/TerritoryBrowser.tsx", '<button className="text-link" onClick={onClear}>', '<button type="button" className="text-link" onClick={onClear}>')

# Route cards: do not spend network/CPU on speculative mobile touch work.
replace_once(
    "web/components/TrailCard.tsx",
    "import {useEffect,useRef,useCallback} from 'react';",
    "import {useEffect,useRef,useCallback,useMemo} from 'react';",
)
replace_once(
    "web/components/TrailCard.tsx",
    """ const categories=deriveRouteCategories(trail);
 const warm=useCallback(()=>{void preloadTrail(trail).catch(()=>undefined);},[trail]);
 useEffect(()=>{if(!element.current||typeof IntersectionObserver==='undefined')return;const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){warm();observer.disconnect();}},{rootMargin:'80px',threshold:.1});observer.observe(element.current);return()=>observer.disconnect();},[warm]);
 return <article ref={element} className="trail-card" onPointerEnter={warm} onFocus={warm} onTouchStart={warm}>""",
    """ const categories=useMemo(()=>deriveRouteCategories(trail),[trail]);
 const warm=useCallback(()=>{
  const connection=(navigator as Navigator&{connection?:{saveData?:boolean;effectiveType?:string}}).connection;
  if(window.matchMedia('(pointer:coarse)').matches||connection?.saveData||/(?:^|-)2g$/.test(connection?.effectiveType||''))return;
  void preloadTrail(trail).catch(()=>undefined);
 },[trail]);
 useEffect(()=>{if(!element.current||typeof IntersectionObserver==='undefined'||window.matchMedia('(pointer:coarse)').matches)return;const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){warm();observer.disconnect();}},{rootMargin:'80px',threshold:.1});observer.observe(element.current);return()=>observer.disconnect();},[warm]);
 return <article ref={element} className="trail-card" onPointerEnter={warm} onFocus={warm}>""",
)
replace_once("web/components/TrailCard.tsx", '<button className="trail-card-main"', '<button type="button" className="trail-card-main"')
replace_once(
    "web/components/TrailCard.tsx",
    """<button className={saved?'save-button saved':'save-button'} aria-label={saved?'Маршрут сохранён':'Сохранить маршрут'} onClick={onSave}>""",
    """<button type="button" className={saved?'save-button saved':'save-button'} aria-pressed={Boolean(saved)} aria-label={saved?'Маршрут сохранён':'Сохранить маршрут'} onClick={onSave}>""",
)

# Story photos: preload adjacent photos only when the main thread/network is idle.
replace_once(
    "web/components/PlaceStories.tsx",
    """ useEffect(()=>{if(!fact)return;setFailedPhoto(current=>current===fact.id?'':current);if(facts.length<2)return;for(const offset of [-1,1]){const nearby=facts[(index+offset+facts.length)%facts.length];const image=new window.Image();image.src=nearby.imageUrl;}},[fact?.id,facts,index]);""",
    """ useEffect(()=>{
  if(!fact)return;
  setFailedPhoto(current=>current===fact.id?'':current);
  if(facts.length<2)return;
  const connection=(navigator as Navigator&{connection?:{saveData?:boolean;effectiveType?:string}}).connection;
  if(connection?.saveData||/(?:^|-)2g$/.test(connection?.effectiveType||''))return;
  let cancelled=false,idle=0,timer=0;
  const preload=()=>{if(cancelled)return;for(const offset of [-1,1]){const nearby=facts[(index+offset+facts.length)%facts.length];const image=new window.Image();image.decoding='async';image.src=nearby.imageUrl;}};
  const target=window as Window&{requestIdleCallback?:(callback:()=>void,options?:{timeout:number})=>number;cancelIdleCallback?:(handle:number)=>void};
  if(target.requestIdleCallback)idle=target.requestIdleCallback(preload,{timeout:1800});else timer=window.setTimeout(preload,500);
  return()=>{cancelled=true;if(idle)target.cancelIdleCallback?.(idle);if(timer)clearTimeout(timer);};
 },[fact?.id,facts,index]);""",
)
replace_once(
    "web/components/PlaceStories.tsx",
    """<img key={fact.imageUrl} src={fact.imageUrl} alt={fact.imageAlt} loading="eager" decoding="async" style={{objectPosition:fact.imagePosition||'50% 50%'}}""",
    """<img key={fact.imageUrl} src={fact.imageUrl} alt={fact.imageAlt} loading="eager" fetchPriority="low" decoding="async" draggable={false} style={{objectPosition:fact.imagePosition||'50% 50%'}}""",
)
replace_once("web/components/PlaceStories.tsx", 'return <button className="fact-closed"', 'return <button type="button" className="fact-closed"')
replace_once("web/components/PlaceStories.tsx", '<button className="fact-dismiss"', '<button type="button" className="fact-dismiss"')
replace_once("web/components/PlaceStories.tsx", '<button className="fact-story-toggle button-sm"', '<button type="button" className="fact-story-toggle button-sm"')
replace_once("web/components/PlaceStories.tsx", '<button aria-label="Предыдущая история"', '<button type="button" aria-label="Предыдущая история"')
replace_once("web/components/PlaceStories.tsx", '<button aria-label={paused||reduced?', '<button type="button" aria-label={paused||reduced?')
replace_once("web/components/PlaceStories.tsx", '<button aria-label="Следующая история"', '<button type="button" aria-label="Следующая история"')

# Mobile navigation: focus moves predictably, outside taps close it, and the page cannot scroll behind it.
replace_once(
    "web/components/Header.tsx",
    """  const searchLink = useRef<HTMLAnchorElement>(null);""",
    """  const searchLink = useRef<HTMLAnchorElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);""",
)
replace_once(
    "web/components/Header.tsx",
    """  useEffect(() => {
    if (!menu) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [menu]);""",
    """  useEffect(() => {
    if (!menu) return;
    const bodyOverflow = document.body.style.overflow;
    const mobile = window.matchMedia('(max-width: 700px)').matches;
    if (mobile) document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => navigation.current?.querySelector<HTMLElement>('a[href]')?.focus({preventScroll: true}));
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMenu(false);
      requestAnimationFrame(() => menuButton.current?.focus({preventScroll: true}));
    };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || navigation.current?.contains(target) || menuButton.current?.contains(target)) return;
      setMenu(false);
    };
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.body.style.overflow = bodyOverflow;
      window.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [menu]);""",
)
replace_once(
    "web/components/Header.tsx",
    """      <nav id="main-navigation" aria-label="Основная навигация" className={menu ? 'top-nav open' : 'top-nav'}>""",
    """      <nav ref={navigation} id="main-navigation" aria-label="Основная навигация" className={menu ? 'top-nav open' : 'top-nav'} onClick={event=>{if((event.target as HTMLElement).closest('a[href]'))setMenu(false);}}>""",
)
replace_once(
    "web/components/Header.tsx",
    """<button className="icon-button menu-toggle" aria-label={menu ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={menu} aria-controls="main-navigation" onClick={() => setMenu(!menu)}>""",
    """<button ref={menuButton} type="button" className="icon-button menu-toggle" aria-label={menu ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={menu} aria-controls="main-navigation" onClick={() => setMenu(!menu)}>""",
)
replace_once("web/components/Header.tsx", '<button className="text-link" onClick={() => setNotice(\'\')}>Закрыть</button>', '<button type="button" className="text-link" aria-label="Закрыть уведомление" onClick={() => setNotice(\'\')}>Закрыть</button>')

append_once(
    "web/components/Header.module.css",
    ".top-nav.open service polish",
    """
/* 0.4.11 service polish: the mobile menu is a bounded, safe-area-aware surface. */
@media(max-width:700px){
 .header :global(.top-nav.open){max-height:calc(100dvh - 72px);overflow:auto;overscroll-behavior:contain;padding-bottom:max(18px,env(safe-area-inset-bottom))}
}
""",
)

# Safety passport: explicit dirty state and conditional unload protection.
replace_once(
    "web/components/SafetyRegistration.tsx",
    "import {useEffect, useMemo, useState} from 'react';",
    "import {useEffect, useMemo, useRef, useState} from 'react';",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """function initialPassport(): SafetyPassport {
  const passport = newSafetyPassport('new');
  passport.participants = [blankParticipant()];
  return passport;
}
""",
    """function initialPassport(): SafetyPassport {
  const passport = newSafetyPassport('new');
  passport.participants = [blankParticipant()];
  return passport;
}

function passportSnapshot(passport: SafetyPassport): string {
  const {updatedAt: _updatedAt, ...stable} = passport;
  return JSON.stringify(stable);
}
""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """  const [passport, setPassport] = useState<SafetyPassport>(initialPassport);
  const [saved, setSaved] = useState<SafetyPassport[]>([]);""",
    """  const [passport, setPassport] = useState<SafetyPassport>(initialPassport);
  const savedSnapshot = useRef(passportSnapshot(passport));
  const [saved, setSaved] = useState<SafetyPassport[]>([]);""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """  const readiness = useMemo(() => safetyReadiness(passport), [passport]);
  const deadline = notificationDeadline(passport.startDate);""",
    """  const readiness = useMemo(() => safetyReadiness(passport), [passport]);
  const dirty = useMemo(() => passportSnapshot(passport) !== savedSnapshot.current, [passport]);
  const deadline = notificationDeadline(passport.startDate);""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """      if (existing) { setPassport(existing); return; }""",
    """      if (existing) { savedSnapshot.current = passportSnapshot(existing); setPassport(existing); return; }""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4200);
    return () => clearTimeout(timer);
  }, [notice]);
""",
    """  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """    localStorage.setItem(SAFETY_STORAGE_KEY, JSON.stringify(list));
    setPassport(value);
    setSaved(list);""",
    """    localStorage.setItem(SAFETY_STORAGE_KEY, JSON.stringify(list));
    savedSnapshot.current = passportSnapshot(value);
    setPassport(value);
    setSaved(list);""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """  function removeCurrent() {
    if (passport.id === 'new') { setPassport(initialPassport()); return; }""",
    """  function removeCurrent() {
    if (passport.id === 'new') { const next = initialPassport(); savedSnapshot.current = passportSnapshot(next); setPassport(next); return; }""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """    setSaved(list);
    setPassport(initialPassport());
    setNotice('Локальная копия удалена.');""",
    """    setSaved(list);
    const next = initialPassport();
    savedSnapshot.current = passportSnapshot(next);
    setPassport(next);
    setNotice('Локальная копия удалена.');""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """  function startNew() {
    setPassport(initialPassport());""",
    """  function startNew() {
    const next = initialPassport();
    savedSnapshot.current = passportSnapshot(next);
    setPassport(next);""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """  function loadPassport(item: SafetyPassport) {
    setPassport(item);""",
    """  function loadPassport(item: SafetyPassport) {
    savedSnapshot.current = passportSnapshot(item);
    setPassport(item);""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """                <span className={styles.progressLabel}>{readiness.completed} из {readiness.total} обязательных блоков · {readiness.percent}%</span>""",
    """                <span className={styles.progressLabel}>{readiness.completed} из {readiness.total} обязательных блоков · {readiness.percent}%</span>
                <span className={`${styles.saveState} ${dirty ? styles.unsaved : ''}`} role="status">{dirty ? 'Есть несохранённые изменения' : passport.id === 'new' ? 'Изменений пока нет' : 'Сохранено на этом устройстве'}</span>""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """<button className={styles.miniButton} onClick={() => persist()}><NotePencil size={17}/>Сохранить</button>""",
    """<button type="button" className={styles.miniButton} disabled={!dirty} onClick={() => persist()}><NotePencil size={17}/>{dirty ? 'Сохранить изменения' : 'Сохранено'}</button>""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    """<p>Черновики остаются в localStorage браузера и не отправляются в Tropnik. На общем устройстве удалите их после переноса.</p>""",
    """<p>Черновики остаются только в localStorage этого браузера и не отправляются в Tropnik. Хранилище браузера не является защищённым сейфом: на общем устройстве удалите паспорт после переноса.</p>""",
)

append_once(
    "web/components/SafetyRegistration.module.css",
    ".saveState{",
    """
.saveState{display:inline-flex;align-items:center;min-height:28px;padding:4px 9px;border-radius:999px;background:#eef2e8;color:#60705f;font-size:11px;line-height:18px;font-weight:750}
.saveState.unsaved{background:#fff0dc;color:#7b5129;border:1px solid #e7c493}
.miniButton:disabled{cursor:default;opacity:.62}
""",
)

# Update UX: tell the user when a waiting service worker can be activated.
replace_once(
    "web/components/ServiceWorker.tsx",
    "import {useEffect} from 'react';",
    "import {useEffect, useRef, useState} from 'react';",
)
replace_once(
    "web/components/ServiceWorker.tsx",
    """export function ServiceWorker() {
  useEffect(() => {""",
    """export function ServiceWorker() {
  const [updateReady, setUpdateReady] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const refreshRequested = useRef(false);

  useEffect(() => {""",
)
replace_once(
    "web/components/ServiceWorker.tsx",
    """    let disposed = false;

    const schedule""",
    """    let disposed = false;
    const controllerChanged = () => { if (refreshRequested.current) location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);

    const schedule""",
)
replace_once(
    "web/components/ServiceWorker.tsx",
    """      void navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'}).then(registration => {
        if (disposed || !document.querySelector('.explore-layout')) return;""",
    """      void navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'}).then(registration => {
        registrationRef.current = registration;
        const announceWaiting = () => {
          if (!disposed && registration.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
        };
        announceWaiting();
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed') announceWaiting();
          });
        });
        if (disposed || !document.querySelector('.explore-layout')) return;""",
)
replace_once(
    "web/components/ServiceWorker.tsx",
    """      window.removeEventListener('load', register);
      for (const handle of idleHandles) target.cancelIdleCallback?.(handle);""",
    """      window.removeEventListener('load', register);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
      for (const handle of idleHandles) target.cancelIdleCallback?.(handle);""",
)
replace_once(
    "web/components/ServiceWorker.tsx",
    """  }, []);
  return null;
}""",
    """  }, []);

  function activateUpdate() {
    const waiting = registrationRef.current?.waiting;
    if (!waiting) { location.reload(); return; }
    refreshRequested.current = true;
    waiting.postMessage({type: 'skip-waiting'});
  }

  if (!updateReady) return null;
  return <div className="app-update" role="status" aria-live="polite">
    <span><strong>Тропник обновлён.</strong> Перезагрузите страницу, чтобы получить свежую карту и исправления.</span>
    <div><button type="button" className="button primary small" onClick={activateUpdate}>Обновить</button><button type="button" className="button secondary small" onClick={()=>setUpdateReady(false)}>Позже</button></div>
  </div>;
}""",
)
replace_once(
    "web/public/sw.js",
    "const VERSION='tropnik-shell-v17';",
    "const VERSION='tropnik-shell-v18';",
)
replace_once(
    "web/public/sw.js",
    """self.addEventListener('message',event=>{if(event.data?.type==='warm-map')event.waitUntil(warmMapCache(event.data.engine));});""",
    """self.addEventListener('message',event=>{if(event.data?.type==='skip-waiting')event.waitUntil(self.skipWaiting());else if(event.data?.type==='warm-map')event.waitUntil(warmMapCache(event.data.engine));});""",
)

# Universal visual details, without touching map geometry.
append_once(
    "web/app/final-polish.css",
    ".app-update{",
    """
::selection{background:#cdddbf;color:#142b20}
:where(h1,h2,h3){text-wrap:balance}:where(p,li){text-wrap:pretty}
:where(h1,h2,h3,[id]){scroll-margin-top:92px}
:where(a,button,[role=button]):focus-visible{outline:3px solid #a56736;outline-offset:3px}
:where(button,[role=button]):disabled{cursor:not-allowed;opacity:.58}
.explore-panel-content[aria-busy=true] .trail-list,.explore-panel-content[aria-busy=true] .region-list{opacity:.72;transition:opacity 140ms ease}
.modal,.explore-panel-content{overscroll-behavior:contain}
.app-update{position:fixed;z-index:120;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));width:min(460px,calc(100vw - 32px));display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:14px 16px;border:1px solid #9caf91;border-radius:16px;background:#fffef8;color:#213d30;box-shadow:0 18px 54px #10271c33}
.app-update span{font-size:13px;line-height:20px}.app-update span strong{display:block}.app-update>div{display:flex;gap:8px}
@media(max-width:560px){.app-update{grid-template-columns:1fr}.app-update>div{display:grid;grid-template-columns:1fr 1fr}.app-update .button{width:100%}}
@media(pointer:coarse){.save-button,.region-option{min-height:44px}}
@media(forced-colors:active){:where(a,button,[role=button]):focus-visible{outline:3px solid Highlight}.app-update{border:2px solid CanvasText}}
""",
)

# Version and tests.
replace_once("web/package.json", '"version": "0.4.10"', '"version": "0.4.11"')
replace_once("web/tests/startup-polish.test.mjs", "/tropnik-shell-v17/", "/tropnik-shell-v18/")
replace_once("web/tests/startup-polish.test.mjs", "assert.equal(JSON.parse(pkg).version,'0.4.10');", "assert.equal(JSON.parse(pkg).version,'0.4.11');")
replace_once("web/tests/map-polish.test.mjs", "/tropnik-shell-v17/", "/tropnik-shell-v18/")

(ROOT / "web/tests/service-polish.test.mjs").write_text(r"""import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('route discovery stays responsive and browser history restores map state',async()=>{
  const [explore,browser,card]=await Promise.all([read('components/Explore.tsx'),read('components/TerritoryBrowser.tsx'),read('components/TrailCard.tsx')]);
  assert.match(explore,/useDeferredValue/);
  assert.match(explore,/const liveIds=new Set/);
  assert.match(explore,/const savedIds=useMemo/);
  assert.match(explore,/addEventListener\('popstate'/);
  assert.match(explore,/pushState':'replaceState/);
  assert.match(explore,/aria-busy=\{searchPending\}/);
  assert.match(browser,/const routeCounts = useMemo/);
  assert.doesNotMatch(browser,/catalog\.filter\(trail => trailBelongsToRegion/);
  assert.doesNotMatch(browser,/onTouchStart=\{warm\}/);
  assert.match(card,/pointer:coarse/);
  assert.doesNotMatch(card,/onTouchStart=\{warm\}/);
});

test('mobile navigation is focus managed and cannot scroll behind the menu',async()=>{
  const [header,css]=await Promise.all([read('components/Header.tsx'),read('components/Header.module.css')]);
  assert.match(header,/navigation\.current\?\.querySelector/);
  assert.match(header,/document\.addEventListener\('pointerdown'/);
  assert.match(header,/document\.body\.style\.overflow = 'hidden'/);
  assert.match(header,/menuButton\.current\?\.focus/);
  assert.match(css,/overscroll-behavior:contain/);
  assert.match(css,/safe-area-inset-bottom/);
});

test('story speculation respects idle time and constrained connections',async()=>{
  const stories=await read('components/PlaceStories.tsx');
  assert.match(stories,/requestIdleCallback/);
  assert.match(stories,/saveData/);
  assert.match(stories,/fetchPriority="low"/);
  assert.match(stories,/draggable=\{false\}/);
});

test('safety drafts expose unsaved state and warn only while dirty',async()=>{
  const [component,css]=await Promise.all([read('components/SafetyRegistration.tsx'),read('components/SafetyRegistration.module.css')]);
  assert.match(component,/passportSnapshot/);
  assert.match(component,/addEventListener\('beforeunload'/);
  assert.match(component,/if \(!dirty\) return/);
  assert.match(component,/Есть несохранённые изменения/);
  assert.match(component,/disabled=\{!dirty\}/);
  assert.match(css,/\.saveState\.unsaved/);
});

test('service worker update is visible and user controlled',async()=>{
  const [client,worker,css,pkg]=await Promise.all([read('components/ServiceWorker.tsx'),read('public/sw.js'),read('app/final-polish.css'),read('package.json')]);
  assert.match(client,/registration\.waiting/);
  assert.match(client,/controllerchange/);
  assert.match(client,/skip-waiting/);
  assert.match(worker,/tropnik-shell-v18/);
  assert.match(worker,/self\.skipWaiting/);
  assert.match(css,/\.app-update/);
  assert.match(css,/forced-colors:active/);
  assert.equal(JSON.parse(pkg).version,'0.4.11');
});
""")

append_once(
    "docs/MAP-VISUAL-SYSTEM.md",
    "## 0.4.11 — сервисная полировка",
    """
## 0.4.11 — сервисная полировка

- Поиск маршрутов на карте отделяет срочное обновление поля от тяжёлой фильтрации через deferred rendering; каталоги и сохранённые идентификаторы индексируются один раз, а не сканируются внутри каждой карточки.
- Выбор направления и маршрута создаёт настоящую историю браузера. `Назад` восстанавливает карту, панель и выбранную карточку без полной перезагрузки.
- Предзагрузка треков и соседних фотографий не запускается на touch, при экономии трафика и 2G; фоновые фотографии загружаются только в свободный период.
- Мобильное меню управляет фокусом, закрывается по Escape и внешнему касанию и блокирует прокрутку страницы за открытой поверхностью.
- Паспорт безопасности показывает несохранённые изменения и подключает системное предупреждение о выходе только пока данные действительно отличаются от последней локальной копии.
- Ожидающий service worker больше не обновляет приложение молча: пользователь получает компактное уведомление и сам выбирает момент активации новой версии.
- Финальный визуальный слой добавляет единый focus-visible, forced-colors, безопасные области, состояния ожидания и переносы текста, не вмешиваясь в географические якоря карты.
""",
)

# Release machinery must not enter the product commit.
(ROOT / ".github/workflows/service-polish.yml").unlink(missing_ok=True)
(ROOT / "tools/apply-service-polish.py").unlink(missing_ok=True)
