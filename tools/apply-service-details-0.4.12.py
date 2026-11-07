from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    target.write_text(text.replace(old, new, 1))


# Place stories: use a real image element, respect reduced motion, pause outside
# the viewport and never let synthetic touch hover keep autoplay stuck.
(ROOT / "web/components/PlaceStories.tsx").write_text(r''''use client';
import {useEffect,useMemo,useState,useRef,useId} from 'react';
import type {KeyboardEvent as ReactKeyboardEvent,PointerEvent as ReactPointerEvent} from 'react';
import {ArrowRight,CaretLeft,CaretRight,Pause,Play,Compass,X} from '@/components/TropnikIcons';
import {factsForPlace,type PlaceFact} from '@/lib/facts';

export function PlaceStories({regionId,routeId,onPlace}:{regionId?:string;routeId?:string;onPlace:(f:PlaceFact)=>void}){
 const facts=useMemo(()=>factsForPlace(regionId,routeId),[regionId,routeId]);
 const [index,setIndex]=useState(0),[paused,setPaused]=useState(false),[hovered,setHovered]=useState(false),[hidden,setHidden]=useState(false),[dismissed,setDismissed]=useState(Boolean(routeId)),[reduced,setReduced]=useState(false),[expanded,setExpanded]=useState(false),[narrow,setNarrow]=useState(false),[failedPhoto,setFailedPhoto]=useState(''),[canHover,setCanHover]=useState(false),[inViewport,setInViewport]=useState(true);
 const storyId=useId(),overview=!regionId,collapsible=overview||narrow,compact=collapsible&&!expanded;
 const regionKey=useRef(''),swipe=useRef<{x:number;y:number;id:number}|null>(null),card=useRef<HTMLElement|null>(null);
 const fact=facts.length?facts[index%facts.length]:undefined;

 useEffect(()=>{const media=window.matchMedia('(max-width: 700px)');const sync=()=>setNarrow(media.matches);sync();media.addEventListener('change',sync);return()=>media.removeEventListener('change',sync);},[]);
 useEffect(()=>{const media=window.matchMedia('(hover: hover) and (pointer: fine)');const sync=()=>setCanHover(media.matches);sync();media.addEventListener('change',sync);return()=>media.removeEventListener('change',sync);},[]);
 useEffect(()=>{const key=`${regionId||'all'}:${routeId||''}`;if(key!==regionKey.current){setIndex(0);setExpanded(false);setPaused(false);regionKey.current=key;}},[regionId,routeId]);
 useEffect(()=>{if(routeId)queueMicrotask(()=>setDismissed(true));},[routeId]);
 useEffect(()=>{const media=window.matchMedia('(prefers-reduced-motion: reduce)');const sync=()=>setReduced(media.matches);sync();media.addEventListener('change',sync);const visibility=()=>setHidden(document.hidden);visibility();document.addEventListener('visibilitychange',visibility);return()=>{media.removeEventListener('change',sync);document.removeEventListener('visibilitychange',visibility);};},[]);
 useEffect(()=>{
  if(dismissed){setInViewport(false);return;}
  const node=card.current;
  if(!node||!('IntersectionObserver' in window)){setInViewport(true);return;}
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
 useEffect(()=>{if(stopped||facts.length<2)return;const timer=setTimeout(()=>setIndex(i=>(i+1)%facts.length),16000);return()=>clearTimeout(timer);},[index,stopped,facts.length]);

 if(!fact)return null;
 function manual(delta:number){setPaused(true);setIndex(i=>(i+delta+facts.length)%facts.length);}
 function releaseTouchFocus(button:HTMLButtonElement){
  if(window.matchMedia('(hover:none), (pointer:coarse)').matches)requestAnimationFrame(()=>button.blur());
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
    <span className="fact-source-label caption-5" title={`Материал проверен ${fact.checkedAt}`}>{fact.source}</span>
   </div>
  </div>
  <div className="fact-card-footer">
   {collapsible?<button type="button" className="fact-story-toggle button-sm" aria-expanded={expanded} aria-controls={storyId} onClick={event=>{setExpanded(value=>!value);releaseTouchFocus(event.currentTarget);}}>{expanded?'Свернуть':'Читать историю'}<CaretRight size={14}/></button>:<button className="fact-place" onClick={()=>{setPaused(true);onPlace(fact);}} title="Открыть направление на карте">{fact.place.length>24?fact.place.split(' · ')[0]:fact.place}<ArrowRight size={12}/></button>}
   <div className="fact-controls">
    <button type="button" aria-label="Предыдущая история" onClick={event=>{manual(-1);releaseTouchFocus(event.currentTarget);}}><CaretLeft size={15}/></button>
    {compact&&<span className="fact-count caption-5">{String(index%facts.length+1).padStart(2,'0')} / {String(facts.length).padStart(2,'0')}</span>}
    <button type="button" disabled={reduced} title={reduced?'Автосмена отключена системной настройкой уменьшения движения':undefined} aria-label={reduced?'Автосмена отключена системной настройкой':paused?'Включить смену историй':'Остановить смену историй'} aria-pressed={paused||reduced} onClick={event=>{togglePlayback();releaseTouchFocus(event.currentTarget);}}>{paused||reduced?<Play size={13}/>:<Pause size={13}/>}</button>
    <button type="button" aria-label="Следующая история" onClick={event=>{manual(1);releaseTouchFocus(event.currentTarget);}}><CaretRight size={15}/></button>
   </div>
  </div>
  <div className={`fact-progress ${stopped?'paused':''}`} aria-hidden="true"><span key={`${fact.id}-${paused}`}/></div>
 </aside>;
}
''')

# Updates are discovered on long-lived tabs as well as at first registration.
(ROOT / "web/components/ServiceWorker.tsx").write_text(r''''use client';

import {useEffect, useRef, useState} from 'react';

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: {timeout: number}) => number;
  cancelIdleCallback?: (handle: number) => void;
};
type NetworkNavigator = Navigator & {
  connection?: {saveData?: boolean; effectiveType?: string};
};

const UPDATE_INTERVAL = 30 * 60 * 1000;

export function ServiceWorker() {
  const [updateReady, setUpdateReady] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const refreshRequested = useRef(false);
  const lastUpdateCheck = useRef(0);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const target = window as IdleWindow;
    const idleHandles = new Set<number>();
    const timers = new Set<number>();
    let disposed = false;
    let controllerKnown = !!navigator.serviceWorker.controller;
    let checkUpdate = () => {};
    const controllerChanged = () => {
      if (refreshRequested.current) { location.reload(); return; }
      if (controllerKnown && !disposed) setUpdateReady(true);
      controllerKnown = true;
    };
    const wake = () => { if (!document.hidden) checkUpdate(); };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);

    const schedule = (task: () => void, timeout: number) => {
      if (target.requestIdleCallback) {
        const handle = target.requestIdleCallback(() => {
          idleHandles.delete(handle);
          if (!disposed) task();
        }, {timeout});
        idleHandles.add(handle);
        return;
      }
      const handle = window.setTimeout(() => {
        timers.delete(handle);
        if (!disposed) task();
      }, Math.min(timeout, 1400));
      timers.add(handle);
    };

    const register = () => schedule(() => {
      void navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'}).then(registration => {
        registrationRef.current = registration;
        lastUpdateCheck.current = Date.now();
        checkUpdate = () => {
          if (disposed || document.hidden || !navigator.onLine || !registrationRef.current) return;
          const now = Date.now();
          if (now - lastUpdateCheck.current < UPDATE_INTERVAL) return;
          lastUpdateCheck.current = now;
          void registrationRef.current.update().catch(() => {});
        };
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
        if (disposed || !document.querySelector('.explore-layout')) return;
        const connection = (navigator as NetworkNavigator).connection;
        if (connection?.saveData || /(?:^|-)2g$/.test(connection?.effectiveType || '')) return;
        schedule(() => {
          const worker = registration.active || registration.waiting || registration.installing;
          worker?.postMessage({
            type: 'warm-map',
            engine: window.matchMedia('(pointer: coarse)').matches ? 'canvas' : 'webgl',
          });
        }, 4200);
      }).catch(() => {});
    }, 2800);

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, {once: true});

    return () => {
      disposed = true;
      window.removeEventListener('load', register);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      for (const handle of idleHandles) target.cancelIdleCallback?.(handle);
      for (const handle of timers) window.clearTimeout(handle);
    };
  }, []);

  function activateUpdate() {
    const waiting = registrationRef.current?.waiting;
    if (!waiting) { location.reload(); return; }
    refreshRequested.current = true;
    waiting.postMessage({type: 'skip-waiting'});
  }

  if (!updateReady) return null;
  return <div className="app-update" role="region" aria-label="Обновление Тропника">
    <span role="status" aria-live="polite"><strong>Доступна свежая версия.</strong> Обновите страницу, когда будете готовы получить последние исправления.</span>
    <div><button type="button" className="button primary small" onClick={activateUpdate}>Обновить</button><button type="button" className="button secondary small" onClick={()=>setUpdateReady(false)}>Позже</button></div>
  </div>;
}
''')

(ROOT / "web/components/MapResourceHints.tsx").write_text(r'''export function MapResourceHints() {
  return <>
    <link rel="preconnect" href="https://tiles.openfreemap.org" crossOrigin="anonymous"/>
    <link rel="preconnect" href="https://tiles.mapterhorn.com" crossOrigin="anonymous"/>
    <link rel="preload" href="/data/russia-display-area.geojson" as="fetch" crossOrigin="anonymous"/>
    <link rel="preload" href="/maps/tropa-style.json" as="fetch" crossOrigin="anonymous" media="(hover: hover) and (pointer: fine)"/>
  </>;
}
''')

# Mobile navigation behaves like a bounded disclosure: no background scroll and
# keyboard focus cannot escape behind the open menu.
header_path = ROOT / "web/components/Header.tsx"
header = header_path.read_text()
header = header.replace(
    "  const navigation = useRef<HTMLElement>(null);",
    "  const navigation = useRef<HTMLElement>(null);\n  const header = useRef<HTMLElement>(null);",
    1,
)
old_header_effect = r'''  useEffect(() => {
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
  }, [menu]);'''
new_header_effect = r'''  useEffect(() => {
    if (!menu) return;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    const media = window.matchMedia('(max-width: 700px)');
    const mobile = media.matches;
    if (mobile) { document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden'; }
    const focusable = () => [...(header.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [])]
      .filter(element => element.offsetParent !== null && !element.hasAttribute('aria-hidden'));
    requestAnimationFrame(() => navigation.current?.querySelector<HTMLElement>('a[href]')?.focus({preventScroll: true}));
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenu(false);
        requestAnimationFrame(() => menuButton.current?.focus({preventScroll: true}));
        return;
      }
      if (event.key !== 'Tab' || !mobile) return;
      const items = focusable();
      const first = items[0], last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({preventScroll: true}); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus({preventScroll: true}); }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || navigation.current?.contains(target) || menuButton.current?.contains(target)) return;
      setMenu(false);
    };
    const resize = () => { if (!media.matches) setMenu(false); };
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    media.addEventListener('change', resize);
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      window.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
      media.removeEventListener('change', resize);
    };
  }, [menu]);'''
if old_header_effect not in header:
    raise SystemExit("Header.tsx: mobile menu effect anchor missing")
header = header.replace(old_header_effect, new_header_effect, 1)
header = header.replace(
    '    <header className={`site-header ${styles.header}`}>',
    '    <header ref={header} className={`site-header ${styles.header}`}>',
    1,
)
header_path.write_text(header)

# Snapshot logic belongs in the pure policy module and must preserve nested
# participant values while ignoring only the volatile timestamp.
policy_path = ROOT / "web/lib/safety-passport.ts"
policy = policy_path.read_text()
anchor = "}\n\nexport function safetyReadiness(passport: SafetyPassport): SafetyReadiness {"
insert = "}\n\nexport function safetyPassportSnapshot(passport: SafetyPassport): string {\n  return JSON.stringify(passport, (key, value) => key === 'updatedAt' ? undefined : value);\n}\n\nexport function safetyReadiness(passport: SafetyPassport): SafetyReadiness {"
if policy.count(anchor) != 1:
    raise SystemExit("safety-passport.ts: readiness anchor missing")
policy_path.write_text(policy.replace(anchor, insert, 1))

safety_path = ROOT / "web/components/SafetyRegistration.tsx"
safety = safety_path.read_text()
safety = safety.replace("  safetyReadiness,\n", "  safetyReadiness,\n  safetyPassportSnapshot,\n", 1)
old_snapshot = r'''function passportSnapshot(passport: SafetyPassport): string {
  return JSON.stringify(passport, key => key === 'updatedAt' ? undefined : passport[key as keyof SafetyPassport]);
}

'''
if old_snapshot not in safety:
    raise SystemExit("SafetyRegistration.tsx: snapshot helper anchor missing")
safety = safety.replace(old_snapshot, "", 1).replace("passportSnapshot(", "safetyPassportSnapshot(")
old_persist = r'''  function persist(next = passport, message = 'Черновик сохранён только на этом устройстве.') {
    const value = next.id === 'new' ? {...next, id: id('passport'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()} : {...next, updatedAt: new Date().toISOString()};
    const list = [value, ...saved.filter(item => item.id !== value.id)].slice(0, 20);
    localStorage.setItem(SAFETY_STORAGE_KEY, JSON.stringify(list));
    setSavedSnapshot(safetyPassportSnapshot(value));
    setPassport(value);
    setSaved(list);
    setNotice(message);
    return value;
  }

  function removeCurrent() {
    if (passport.id === 'new') { const next = initialPassport(); setSavedSnapshot(safetyPassportSnapshot(next)); setPassport(next); return; }
    if (!window.confirm('Удалить этот паспорт безопасности с устройства?')) return;
    const list = saved.filter(item => item.id !== passport.id);
    localStorage.setItem(SAFETY_STORAGE_KEY, JSON.stringify(list));
    setSaved(list);
    const next = initialPassport();
    setSavedSnapshot(safetyPassportSnapshot(next));
    setPassport(next);
    setNotice('Локальная копия удалена.');
  }'''
new_persist = r'''  function writeSavedPassports(list: SafetyPassport[]): boolean {
    try { localStorage.setItem(SAFETY_STORAGE_KEY, JSON.stringify(list)); return true; }
    catch { setNotice('Не удалось записать данные в браузер. Скачайте JSON-копию и проверьте свободное место.'); return false; }
  }

  function persist(next = passport, message = 'Черновик сохранён только на этом устройстве.') {
    const value = next.id === 'new' ? {...next, id: id('passport'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()} : {...next, updatedAt: new Date().toISOString()};
    const list = [value, ...saved.filter(item => item.id !== value.id)].slice(0, 20);
    if (!writeSavedPassports(list)) return undefined;
    setSavedSnapshot(safetyPassportSnapshot(value));
    setPassport(value);
    setSaved(list);
    setNotice(message);
    return value;
  }

  function removeCurrent() {
    if (passport.id === 'new') { const next = initialPassport(); setSavedSnapshot(safetyPassportSnapshot(next)); setPassport(next); return; }
    if (!window.confirm('Удалить этот паспорт безопасности с устройства?')) return;
    const list = saved.filter(item => item.id !== passport.id);
    if (!writeSavedPassports(list)) return;
    setSaved(list);
    const next = initialPassport();
    setSavedSnapshot(safetyPassportSnapshot(next));
    setPassport(next);
    setNotice('Локальная копия удалена.');
  }'''
if old_persist not in safety:
    raise SystemExit("SafetyRegistration.tsx: persistence anchor missing")
safety = safety.replace(old_persist, new_persist, 1)
safety, notice_count = re.subn(
    r'\{notice && <div className=\{styles\.notice\}>\{notice\}</div>\}',
    '{notice && <div className={styles.notice} role="status" aria-live="polite">{notice}</div>}',
    safety,
    count=1,
)
if notice_count != 1:
    raise SystemExit("SafetyRegistration.tsx: notice live-region anchor missing")
safety_path.write_text(safety)

# Static Pages must not add map connections to every route before React has
# decided that the current surface contains a map.
build_path = ROOT / "tools/pages-preview/build.mjs"
build = build_path.read_text()
build, removed = re.subn(
    r'<link rel="preconnect" href="https://tiles\.openfreemap\.org" crossorigin><link rel="preconnect" href="https://tiles\.mapterhorn\.com" crossorigin>',
    '',
    build,
    count=1,
)
if removed != 1:
    raise SystemExit("tools/pages-preview/build.mjs: global map preconnect anchor missing")
build_path.write_text(build)

# Final cross-platform details for real images and disabled autoplay.
css_path = ROOT / "web/app/final-polish.css"
css = css_path.read_text()
old_image = ".fact-photo-image{display:block;width:100%;height:100%;min-height:inherit;background-size:cover;background-repeat:no-repeat;background-color:#dfe7d8}"
new_image = ".fact-photo-image{display:block;width:100%;height:100%;min-height:inherit;object-fit:cover;object-position:50% 50%;background:#dfe7d8}.fact-controls button:disabled{opacity:.52;transform:none;cursor:not-allowed}.top-nav.open{overscroll-behavior:contain}"
if old_image not in css:
    raise SystemExit("final-polish.css: story image anchor missing")
css_path.write_text(css.replace(old_image, new_image, 1))

replace_once("web/package.json", '"version": "0.4.11"', '"version": "0.4.12"')
replace_once("web/public/sw.js", "const VERSION='tropnik-shell-v18';", "const VERSION='tropnik-shell-v19';")

# Regression coverage for nested safety data, motion preferences, static-shell
# hints, long-lived update checks and keyboard focus containment.
safety_test_path = ROOT / "web/tests/safety-passport.test.mjs"
safety_test = safety_test_path.read_text()
safety_test = safety_test.replace(
    "  safetyReadiness,\n",
    "  safetyReadiness,\n  safetyPassportSnapshot,\n",
    1,
)
anchor_test = r'''test('stored values are parsed defensively', () => {'''
new_test = r'''test('dirty snapshots preserve nested participant edits and ignore only the volatile timestamp', () => {
  const passport = completePassport();
  const timestampOnly = {...passport, updatedAt: '2030-01-01T00:00:00.000Z'};
  assert.equal(safetyPassportSnapshot(passport), safetyPassportSnapshot(timestampOnly));
  const participantChanged = {...passport, participants: [{...passport.participants[0], name: 'Другой участник'}]};
  assert.notEqual(safetyPassportSnapshot(passport), safetyPassportSnapshot(participantChanged));
});

test('stored values are parsed defensively', () => {'''
if anchor_test not in safety_test:
    raise SystemExit("safety-passport.test.mjs: insertion anchor missing")
safety_test = safety_test.replace(anchor_test, new_test, 1)
safety_test = safety_test.replace(
    "  assert.match(component, /localStorage\\.setItem\\(SAFETY_STORAGE_KEY/);",
    "  assert.match(component, /localStorage\\.setItem\\(SAFETY_STORAGE_KEY/);\n  assert.match(component, /Не удалось записать данные в браузер/);\n  assert.match(component, /aria-live=\"polite\"/);",
    1,
)
safety_test_path.write_text(safety_test)

stories_test_path = ROOT / "web/tests/place-stories.test.mjs"
stories_test = stories_test_path.read_text()
stories_test = stories_test.replace(
    "  assert.doesNotMatch(stories, /href=\\{fact\\.sourceUrl\\}/, 'external source sites must not be exposed in the story card');",
    "  assert.doesNotMatch(stories, /href=\\{fact\\.sourceUrl\\}/, 'external source sites must not be exposed in the story card');\n  assert.match(stories, /<img key=\\{fact\\.imageUrl\\}/, 'stories must use a native image element');\n  assert.match(stories, /IntersectionObserver/, 'off-screen stories must pause background work');\n  assert.match(stories, /disabled=\\{reduced\\}/, 'system reduced-motion must disable autoplay');\n  assert.doesNotMatch(stories, /setReduced\\(false\\)/, 'the UI must not override the operating-system motion preference');",
    1,
)
stories_test_path.write_text(stories_test)

startup_test_path = ROOT / "web/tests/startup-polish.test.mjs"
startup_test = startup_test_path.read_text()
startup_test = startup_test.replace(
    " const [layout,explore,hints]=await Promise.all([read('app/layout.tsx'),read('components/Explore.tsx'),read('components/MapResourceHints.tsx')]);",
    " const [layout,explore,hints,staticBuild]=await Promise.all([read('app/layout.tsx'),read('components/Explore.tsx'),read('components/MapResourceHints.tsx'),read('../tools/pages-preview/build.mjs')]);",
    1,
)
startup_test = startup_test.replace(
    " assert.match(hints,/tropa-style\\.json/);",
    " assert.match(hints,/tropa-style\\.json/);\n assert.match(hints,/media=\"\\(hover: hover\\) and \\(pointer: fine\\)\"/);\n assert.doesNotMatch(staticBuild,/<link rel=\"preconnect\" href=\"https:\\/\\/tiles\\./);",
    1,
)
startup_test = startup_test.replace(
    " assert.match(client,/type: 'warm-map'/);",
    " assert.match(client,/type: 'warm-map'/);\n assert.match(client,/registrationRef\\.current\\.update/);\n assert.match(client,/visibilitychange/);\n assert.match(client,/controllerchange/);",
    1,
)
startup_test = startup_test.replace("assert.match(worker,/tropnik-shell-v18/);", "assert.match(worker,/tropnik-shell-v19/);")
startup_test = startup_test.replace("assert.equal(JSON.parse(pkg).version,'0.4.11');", "assert.equal(JSON.parse(pkg).version,'0.4.12');")
startup_test += r'''

test('mobile navigation traps focus and restores both document scroll containers',async()=>{
 const header=await read('components/Header.tsx');
 assert.match(header,/event\.key !== 'Tab'/);
 assert.match(header,/document\.documentElement\.style\.overflow = 'hidden'/);
 assert.match(header,/querySelectorAll<HTMLElement>\('a\[href\],button:not\(\[disabled\]\)/);
 assert.match(header,/media\.addEventListener\('change', resize\)/);
});
'''
startup_test_path.write_text(startup_test)

doc_path = ROOT / "docs/MAP-VISUAL-SYSTEM.md"
doc = doc_path.read_text()
section = r'''

## 0.4.12 — детали долгоживущего сервиса

- Статическая оболочка больше не устанавливает соединения с тайловыми серверами на каждой странице; ресурсные подсказки появляются только вместе с картой, а WebGL-стиль предзагружается только для точного указателя.
- Истории используют нативные изображения с `alt`, `loading` и `decoding`, останавливают таймеры вне viewport и не позволяют кнопке воспроизведения отменять системный `prefers-reduced-motion`.
- Мобильное меню удерживает клавиатурный фокус внутри открытого заголовка, блокирует оба контейнера прокрутки и закрывается при переходе на широкий layout.
- Долгоживущая вкладка периодически проверяет обновление service worker после возвращения в приложение или восстановления сети; активация новой версии остаётся явным действием пользователя.
- Снимок паспорта безопасности сохраняет вложенные данные участников и исключает только изменяемую служебную дату. Ошибка localStorage не выдаётся за успешное сохранение и оставляет пользователю путь экспорта JSON.
'''
if "## 0.4.12 — детали долгоживущего сервиса" not in doc:
    doc_path.write_text(doc.rstrip()+section.rstrip()+"\n")

# Release-only machinery must not enter the product commit.
(ROOT / ".github/workflows/service-details-0.4.12.yml").unlink(missing_ok=True)
(ROOT / "tools/apply-service-details-0.4.12.py").unlink(missing_ok=True)
