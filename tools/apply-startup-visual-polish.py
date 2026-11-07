#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    target.write_text(text.replace(old, new, 1))


# Keep map resource hints on map surfaces rather than every article and form.
replace_once(
    "web/app/layout.tsx",
    'import "./map-ui-release.css";\n',
    'import "./map-ui-release.css";\nimport "./final-polish.css";\n',
)
replace_once(
    "web/app/layout.tsx",
    '    <html lang="ru"><head><link rel="preconnect" href="https://tiles.openfreemap.org" crossOrigin="anonymous"/><link rel="preconnect" href="https://tiles.mapterhorn.com" crossOrigin="anonymous"/><link rel="preload" href="/data/russia-display-area.geojson" as="fetch" crossOrigin="anonymous"/><link rel="preload" href="/maps/tropa-style.json" as="fetch" crossOrigin="anonymous"/></head>\n      <body>',
    '    <html lang="ru">\n      <body>',
)

Path(ROOT / "web/components/MapResourceHints.tsx").write_text("""export function MapResourceHints() {
  return <>
    <link rel="preconnect" href="https://tiles.openfreemap.org" crossOrigin="anonymous"/>
    <link rel="preconnect" href="https://tiles.mapterhorn.com" crossOrigin="anonymous"/>
    <link rel="preload" href="/data/russia-display-area.geojson" as="fetch" crossOrigin="anonymous"/>
    <link rel="preload" href="/maps/tropa-style.json" as="fetch" crossOrigin="anonymous"/>
  </>;
}
""")
replace_once(
    "web/components/Explore.tsx",
    "import {Modal} from './Modal';\n",
    "import {Modal} from './Modal';\nimport {MapResourceHints} from './MapResourceHints';\n",
)
replace_once(
    "web/components/Explore.tsx",
    " return <section className={`explore-layout",
    " return <><MapResourceHints/><section className={`explore-layout",
)
explore = ROOT / "web/components/Explore.tsx"
explore_text = explore.read_text()
ending = explore_text.rfind("</section>;")
if ending < 0:
    raise SystemExit("Explore.tsx: closing section not found")
explore.write_text(explore_text[:ending] + "</section></>;" + explore_text[ending + len("</section>;"):])

# Register the worker after first paint and only warm map assets on actual map surfaces.
Path(ROOT / "web/components/ServiceWorker.tsx").write_text("""'use client';

import {useEffect} from 'react';

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: {timeout: number}) => number;
  cancelIdleCallback?: (handle: number) => void;
};
type NetworkNavigator = Navigator & {
  connection?: {saveData?: boolean; effectiveType?: string};
};

export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const target = window as IdleWindow;
    const idleHandles = new Set<number>();
    const timers = new Set<number>();
    let disposed = false;

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
      for (const handle of idleHandles) target.cancelIdleCallback?.(handle);
      for (const handle of timers) window.clearTimeout(handle);
    };
  }, []);
  return null;
}
""")

# Make installation light. The verified relief package is warmed later and only for map users.
Path(ROOT / "web/public/sw.js").write_text("""/* Тропник. Only public static assets are cached. Auth, chat and API responses never enter CacheStorage. */
const VERSION='tropnik-shell-v17';
const SHELL=['/maps/russia-viewport.js','/data/russia-display-area.geojson','/data/russia-outside-mask.geojson','/data/russia-canonical-mask.geojson','/data/russia-boundaries-provenance.json','/offline-fonts.css','/fonts/MANROPE-LICENSE.txt','/fonts/manrope-latin-400.woff2','/fonts/manrope-cyrillic-400.woff2','/fonts/manrope-latin-600.woff2','/fonts/manrope-cyrillic-600.woff2','/maps/leaflet.js','/maps/leaflet.css','/maps/protomaps-leaflet.js','/maps/canvas-style.js','/offline-viewer.html','/offline.js','/offline.css','/favicon.svg','/data/world.geojson','/data/regions.geojson','/data/territories.geojson'];
const MAP_WARM=['/maps/tropa-style.json','/maps/tropnik-pictograms.js','/maps/tropnik-sprite.png','/maps/tropnik-sprite.json','/maps/tropnik-sprite@2x.png','/maps/tropnik-sprite@2x.json','/maps/tropnik-sprite-provenance.json'];
const WEBGL_WARM=['/terrain/ATTRIBUTION.txt','/terrain/sources/Copernicus-GLO30-LICENSE.pdf','/terrain/landscape.html','/maps/maplibre-gl.mjs','/maps/maplibre-gl.css','/maps/maplibre-worker.js'];
const warmJobs=new Map();
async function cacheOverview(cache){
 const base='/maps/russia-relief/',response=await fetch(base+'manifest.json',{cache:'no-store'});
 if(!response.ok)throw new Error('Overview manifest unavailable');
 const manifestText=await response.text();let manifest;
 try{manifest=JSON.parse(manifestText);}catch{throw new Error('Invalid overview package');}
 if(!manifest.complete||manifest.tileCount!==341||manifest.files?.length!==341||manifest.totalTileBytes>3*1024*1024)throw new Error('Invalid overview package');
 const seen=new Set(),unique=new Map();let total=0;
 for(const file of manifest.files){
  const match=/^([0-4])\/(\d+)\/(\d+)\.png$/.exec(file.path);
  if(!match||file.path!==`${+match[1]}/${+match[2]}/${+match[3]}.png`||+match[2]>=2**+match[1]||+match[3]>=2**+match[1]||seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>524288||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid overview tile');
  seen.add(file.path);total+=file.bytes;if(total>3*1024*1024)throw new Error('Overview byte budget exceeded');
  if(!unique.has(file.sha256))unique.set(file.sha256,{file,paths:[]});
  if(unique.get(file.sha256).file.bytes!==file.bytes)throw new Error('Conflicting overview tile');
  unique.get(file.sha256).paths.push(file.path);
 }
 if(total!==manifest.totalTileBytes)throw new Error('Overview package size mismatch');
 const pending=[...unique.values()];let index=0;
 await Promise.all(Array.from({length:3},async()=>{
  while(index<pending.length){
   const {file,paths}=pending[index++],result=await fetch(base+file.path);
   if(!result.ok)throw new Error('Overview tile unavailable');
   const bytes=await result.arrayBuffer();
   const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
   if(bytes.byteLength!==file.bytes||hash!==file.sha256)throw new Error('Overview tile integrity mismatch');
   for(const path of paths)await cache.put(base+path,new Response(bytes,{headers:{'Content-Type':'image/png'}}));
  }
 }));
 await cache.put(base+'manifest.json',new Response(manifestText,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/json'}}));
 await cache.addAll([base+'tilejson.json',base+'ATTRIBUTION.txt']);
}
function warmMapCache(engine){
 const kind=engine==='webgl'?'webgl':'canvas',marker=`/_offline/map-warm-${VERSION}-${kind}`;
 if(warmJobs.has(kind))return warmJobs.get(kind);
 const job=(async()=>{const cache=await caches.open(VERSION);if(await cache.match(marker))return;await cache.addAll(MAP_WARM);if(kind==='webgl')await cache.addAll(WEBGL_WARM);await cacheOverview(cache);await cache.put(marker,new Response('ready',{headers:{'Content-Type':'text/plain'}}));})().catch(error=>{warmJobs.delete(kind);throw error;});
 warmJobs.set(kind,job);return job;
}
self.addEventListener('install',event=>{event.waitUntil((async()=>{const cache=await caches.open(VERSION);await cache.addAll(SHELL);})());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('tropnik-shell-')&&name!==VERSION)await caches.delete(name);await self.clients.claim();})());});
self.addEventListener('message',event=>{if(event.data?.type==='warm-map')event.waitUntil(warmMapCache(event.data.engine));});
async function verifiedResource(request){const names=(await caches.keys()).filter(n=>n.startsWith('tropnik-map-')).sort().reverse();for(const name of names){const cache=await caches.open(name);if(await cache.match('/_offline/verified-map')){const match=await cache.match(request);if(match)return match;}}return null;}
self.addEventListener('fetch',event=>{const req=event.request,url=new URL(req.url);if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||req.headers.get('RSC'))return;
 if(url.pathname.startsWith('/offline-map/')||url.pathname==='/maps/pilot-style.json'){event.respondWith((async()=>{if(req.cache==='no-store'||req.cache==='reload')return fetch(req);const found=await verifiedResource(req);if(found)return found;return fetch(req);})());return;}
 if(req.mode==='navigate'){event.respondWith(fetch(req).catch(async()=>{const cache=await caches.open(VERSION);return await cache.match(url.pathname)||await cache.match('/offline-viewer.html')||Response.error();}));return;}
 const permitted=['/terrain/terrain-grid.json','/terrain/terrain-preview.json'].includes(url.pathname)||SHELL.includes(url.pathname)||MAP_WARM.includes(url.pathname)||WEBGL_WARM.includes(url.pathname)||url.pathname.startsWith('/_next/static/')||url.pathname.startsWith('/assets/')||url.pathname.startsWith('/data/routes/')||url.pathname.startsWith('/maps/russia-relief/');if(!permitted)return;
 event.respondWith((async()=>{const cache=await caches.open(VERSION);const found=await cache.match(req);if(found)return found;const res=await fetch(req);if(res.ok&&res.type==='basic')await cache.put(req,res.clone());return res;})());
});
""")

# Safety registration should not parse the entire route catalogue on every keystroke.
replace_once(
    "web/components/SafetyRegistration.tsx",
    "import {regions, trails} from '@/lib/content';\n",
    "",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    "import styles from './SafetyRegistration.module.css';\n",
    """import styles from './SafetyRegistration.module.css';

type SafetyCatalog = {
  regions: Array<{id: string; name: string}>;
  routes: Array<{id: string; title: string; regionId: string; description: string}>;
};
let safetyCatalogPromise: Promise<SafetyCatalog> | undefined;
function loadSafetyCatalog(): Promise<SafetyCatalog> {
  safetyCatalogPromise ??= import('@/lib/content').then(({regions, trails}) => ({
    regions: regions.map(({id, name}) => ({id, name})),
    routes: trails.map(({id, title, regionId, description}) => ({id, title, regionId, description})),
  }));
  return safetyCatalogPromise;
}
""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    "  const [locating, setLocating] = useState(false);\n",
    "  const [locating, setLocating] = useState(false);\n  const [catalog, setCatalog] = useState<SafetyCatalog | null>(null);\n  const [catalogState, setCatalogState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');\n",
)
old_effect = """  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const stored = parseSafetyPassportList(JSON.parse(localStorage.getItem(SAFETY_STORAGE_KEY) || '[]'));
        setSaved(stored);
        const params = new URLSearchParams(location.search);
        const requested = params.get('passport');
        const existing = requested ? stored.find(item => item.id === requested) : undefined;
        if (existing) { setPassport(existing); return; }
        const routeId = params.get('route');
        const route = routeId ? trails.find(item => item.id === routeId) : undefined;
        if (!route) return;
        const region = regions.find(item => item.id === route.regionId);
        setPassport(previous => ({
          ...previous,
          routeId: route.id,
          routeTitle: route.title,
          region: region?.name || previous.region,
          routeDescription: route.description || previous.routeDescription,
          updatedAt: new Date().toISOString(),
        }));
      } catch { setNotice('Не удалось прочитать сохранённые паспорта на этом устройстве.'); }
    });
    return () => { cancelled = true; };
  }, []);
"""
new_effect = """  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      let stored: SafetyPassport[] = [];
      try {
        stored = parseSafetyPassportList(JSON.parse(localStorage.getItem(SAFETY_STORAGE_KEY) || '[]'));
        setSaved(stored);
      } catch { setNotice('Не удалось прочитать сохранённые паспорта на этом устройстве.'); }
      const params = new URLSearchParams(location.search);
      const requested = params.get('passport');
      const existing = requested ? stored.find(item => item.id === requested) : undefined;
      if (existing) { setPassport(existing); return; }
      const routeId = params.get('route');
      if (!routeId) return;
      setCatalogState('loading');
      void loadSafetyCatalog().then(next => {
        if (cancelled) return;
        setCatalog(next);
        setCatalogState('ready');
        const route = next.routes.find(item => item.id === routeId);
        if (!route) return;
        const region = next.regions.find(item => item.id === route.regionId);
        setPassport(previous => ({
          ...previous,
          routeId: route.id,
          routeTitle: route.title,
          region: region?.name || previous.region,
          routeDescription: route.description || previous.routeDescription,
          updatedAt: new Date().toISOString(),
        }));
      }).catch(() => {
        if (!cancelled) { setCatalogState('error'); setNotice('Каталог маршрутов не загрузился. Форму можно заполнить вручную.'); }
      });
    });
    return () => { cancelled = true; };
  }, []);
"""
replace_once("web/components/SafetyRegistration.tsx", old_effect, new_effect)
old_select = """  function selectRoute(routeId: string) {
    const route = trails.find(item => item.id === routeId);
    if (!route) { update('routeId', undefined); return; }
    const region = regions.find(item => item.id === route.regionId);
    setPassport(previous => invalidateOfficialStatus({
      ...previous,
      routeId: route.id,
      routeTitle: route.title,
      region: region?.name || previous.region,
      routeDescription: route.description || previous.routeDescription,
    }));
  }
"""
new_select = """  async function openCatalog() {
    if (catalog || catalogState === 'loading') return;
    setCatalogState('loading');
    try { const next = await loadSafetyCatalog(); setCatalog(next); setCatalogState('ready'); }
    catch { setCatalogState('error'); setNotice('Каталог маршрутов не загрузился. Форму можно заполнить вручную.'); }
  }

  function selectRoute(routeId: string) {
    if (!routeId) { update('routeId', undefined); return; }
    const route = catalog?.routes.find(item => item.id === routeId);
    if (!route) return;
    const region = catalog?.regions.find(item => item.id === route.regionId);
    setPassport(previous => invalidateOfficialStatus({
      ...previous,
      routeId: route.id,
      routeTitle: route.title,
      region: region?.name || previous.region,
      routeDescription: route.description || previous.routeDescription,
    }));
  }
"""
replace_once("web/components/SafetyRegistration.tsx", old_select, new_select)
replace_once(
    "web/components/SafetyRegistration.tsx",
    '<div className={styles.progressTrack} aria-label={`Готовность ${readiness.percent}%`}><span style={{width: `${readiness.percent}%`}}/></div>',
    '<div className={styles.progressTrack} aria-label={`Готовность ${readiness.percent}%`}><span style={{transform: `scaleX(${readiness.percent / 100})`}}/></div>',
)
old_picker = '<div className={styles.fieldWide}><label htmlFor="catalog-route">Маршрут из каталога Тропника</label><select id="catalog-route" value={passport.routeId || \'\'} disabled={locked} onChange={event => selectRoute(event.target.value)}><option value="">Не выбран — заполню вручную</option>{trails.map(route => <option key={route.id} value={route.id}>{route.title}</option>)}</select><span className={styles.hint}>Описание из каталога остаётся справочным: проверьте ограничения и фактическую нитку перед подачей.</span></div>'
new_picker = '<div className={styles.fieldWide}><label htmlFor="catalog-route">Маршрут из каталога Тропника</label>{catalog ? <select id="catalog-route" value={passport.routeId || \'\'} disabled={locked} onChange={event => selectRoute(event.target.value)}><option value="">Не выбран — заполню вручную</option>{catalog.routes.map(route => <option key={route.id} value={route.id}>{route.title}</option>)}</select> : <button id="catalog-route" type="button" className={styles.catalogButton} disabled={locked || catalogState === \'loading\'} onClick={() => void openCatalog()}><MapPin size={18}/>{catalogState === \'loading\' ? \'Загружаем каталог…\' : catalogState === \'error\' ? \'Повторить загрузку каталога\' : \'Выбрать маршрут из каталога\'}</button>}<span className={styles.hint}>Каталог загружается только по запросу. Описание остаётся справочным: проверьте ограничения и фактическую нитку перед подачей.</span></div>'
replace_once("web/components/SafetyRegistration.tsx", old_picker, new_picker)
old_region = '<div className={styles.field}><label htmlFor="region">Регион начала *</label><select id="region" value={passport.region} disabled={locked} onChange={event => update(\'region\', event.target.value)}><option value="">Выберите регион</option>{regions.map(region => <option key={region.id} value={region.name}>{region.name}</option>)}</select></div>'
new_region = '<div className={styles.field}><label htmlFor="region">Регион начала *</label><input id="region" list="safety-regions" value={passport.region} disabled={locked} onChange={event => update(\'region\', event.target.value)} placeholder="Введите регион"/><datalist id="safety-regions">{catalog?.regions.map(region => <option key={region.id} value={region.name}/>)}</datalist></div>'
replace_once("web/components/SafetyRegistration.tsx", old_region, new_region)

# Safety visual and interaction polish.
css_path = ROOT / "web/components/SafetyRegistration.module.css"
css = css_path.read_text()
css = css.replace('.page{min-height:100vh;', '.page{min-height:100vh;min-height:100dvh;', 1)
css = css.replace('.savedButton:hover{background:#eef2e6;border-color:#b7c6ad}', '@media(hover:hover) and (pointer:fine){.savedButton:hover{background:#eef2e6;border-color:#b7c6ad}}', 1)
css = css.replace('.miniButton:hover{background:#eaf0e3}', '@media(hover:hover) and (pointer:fine){.miniButton:hover{background:#eaf0e3}}', 1)
css = css.replace('.primaryLink:hover{background:var(--forest-dark)}', '@media(hover:hover) and (pointer:fine){.primaryLink:hover{background:var(--forest-dark)}}', 1)
css = css.replace('.secondaryButton:hover{background:#eef2e8}', '@media(hover:hover) and (pointer:fine){.secondaryButton:hover{background:#eef2e8}}', 1)
css = css.replace('.progressTrack span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#315b45,#7e9b67);transition:width .35s var(--motion)}', '.progressTrack span{display:block;width:100%;height:100%;border-radius:999px;background:linear-gradient(90deg,#315b45,#7e9b67);transform:scaleX(0);transform-origin:left center;transition:transform .28s var(--motion);will-change:transform}', 1)
css += """
.catalogButton{width:100%;min-height:48px;border:1px solid #aebda5;border-radius:10px;background:#f5f8ef;color:var(--forest);padding:10px 14px;display:flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:14px;font-weight:800;touch-action:manipulation}.catalogButton:disabled{opacity:.62}.section{content-visibility:auto;contain-intrinsic-size:auto 620px}.workspace,.form,.sidebar,.summary,.card,.field,.fieldWide,.sectionHeader>div{min-width:0}.hero h1,.heroLead,.heroAside,.sectionHeader h2,.sectionHeader p,.hint,.deadline,.savedButton,.primaryLink,.secondaryButton,.miniButton{overflow-wrap:anywhere}.savedButton,.newButton,.miniButton,.removeParticipant,.addParticipant,.primaryLink,.secondaryButton,.call112,.copyEmergency,.catalogButton{touch-action:manipulation;-webkit-tap-highlight-color:transparent}.notice{bottom:max(24px,env(safe-area-inset-bottom));margin-inline:env(safe-area-inset-left) env(safe-area-inset-right)}
@media(hover:none),(pointer:coarse){.savedButton:hover,.miniButton:hover,.primaryLink:hover,.secondaryButton:hover{transform:none;box-shadow:none}.savedButton:hover{background:#f7f8f0;border-color:#d7decf}.miniButton:hover{background:#f9faf4}.primaryLink:hover{background:var(--forest)}.secondaryButton:hover{background:#fffef9}}
@media(max-width:760px){.workspace{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right));padding-bottom:max(64px,calc(env(safe-area-inset-bottom) + 48px))}.hero{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}.statusActions>*{min-height:44px}.officialActions>*{min-width:0}}
@media(prefers-reduced-motion:reduce){.progressTrack span{transition:none}.card,.section{scroll-behavior:auto}}
"""
css_path.write_text(css)

# Final cross-platform layer loaded after all legacy styles.
Path(ROOT / "web/app/final-polish.css").write_text("""/* Final cross-platform guardrails. Keep geometry in map-specific styles. */
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-behavior:smooth}body{overflow-x:clip;font-synthesis:none}img,video{max-width:100%;height:auto}.site-header,.top-nav,.header-actions,.article-body,.page-hero,.section-actions,.site-footer,.explore-panel,.explore-panel-content,.route-section,.route-actions,.trail-card,.fact-card,.modal,.modal-heading,.account-card,.departure-card{min-width:0}.article-body,.page-hero,.site-footer{overflow-wrap:anywhere}.button,.icon-button,.text-link,.sheet-handle,.sheet-peek-summary,.filter-button,.back-link,.fact-controls button,.fact-dismiss,.fact-closed{touch-action:manipulation;-webkit-tap-highlight-color:transparent}.button,.icon-button,.filter-button,.back-link,.fact-controls button,.fact-dismiss{transition-duration:160ms}.article-body pre,.article-body table{max-width:100%;overflow:auto}.article-body input,.article-body select,.article-body textarea{max-width:100%}
@supports(content-visibility:auto){.below-map,.region-links,.site-footer,.article-body>.prose-card,.article-body>.empty-state{content-visibility:auto;contain-intrinsic-size:auto 520px}}
@media(pointer:coarse){.button,.icon-button,.sheet-handle,.sheet-peek-summary,.filter-button,.back-link,.fact-controls button,.fact-dismiss,.fact-closed{min-height:44px}.button:hover,.icon-button:hover,.filter-button:hover,.back-link:hover,.fact-controls button:hover,.fact-dismiss:hover{transform:none}}
@media(max-width:700px){.article-body,.page-hero,.site-footer{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}.site-footer{padding-bottom:max(28px,env(safe-area-inset-bottom))}.section-actions{display:grid;grid-template-columns:minmax(0,1fr)}.section-actions>*{width:100%;min-width:0}.modal-backdrop{padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right));padding-bottom:max(12px,env(safe-area-inset-bottom))}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
""")

# Release metadata and regressions.
replace_once("web/package.json", '"version": "0.4.9"', '"version": "0.4.10"')
replace_once("web/tests/map-polish.test.mjs", 'tropnik-shell-v16', 'tropnik-shell-v17')
Path(ROOT / "web/tests/overview-offline.test.mjs").write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const publicRoot=new URL('../public/',import.meta.url);
const source=await readFile(new URL('sw.js',publicRoot),'utf8');
const manifest=JSON.parse(await readFile(new URL('maps/russia-relief/manifest.json',publicRoot),'utf8'));
async function run(corrupt=false){
 const calls=[],saved=new Map(),listeners={};
 const cache={addAll:async paths=>{for(const path of paths)saved.set(path,'shell');},match:async path=>saved.get(path),put:async(path,response)=>saved.set(path,new Uint8Array(await response.arrayBuffer()))};
 const context=vm.createContext({self:{addEventListener:(name,callback)=>listeners[name]=callback},caches:{open:async()=>cache},crypto:webcrypto,Response,Uint8Array,Set,Map,Promise,Array,Number,Error,fetch:async path=>{
  calls.push(path);assert.ok(path.startsWith('/maps/russia-relief/'));
  const bytes=await readFile(new URL(path.slice(1),publicRoot));
  return new Response(corrupt&&path.endsWith('0/0/0.png')?new Uint8Array([0]):bytes);
 }});
 vm.runInContext(source,context);
 let installation;listeners.install({waitUntil:promise=>installation=promise});
 await installation;
 const installCalls=calls.length;
 let warming;listeners.message({data:{type:'warm-map',engine:'canvas'},waitUntil:promise=>warming=promise});
 await warming;
 return{calls,saved,installCalls};
}
test('service worker installation keeps verified overview work off the first-load path',async()=>{
 const {installCalls}=await run();
 assert.equal(installCalls,0);
});
test('idle map warm saves all 341 actual RF overview tiles using 57 verified tile downloads',async()=>{
 const {calls,saved}=await run();
 assert.equal(calls.filter(path=>path.endsWith('.png')).length,57);
 for(const file of manifest.files)assert.equal(saved.get('/maps/russia-relief/'+file.path)?.byteLength,file.bytes,file.path);
 assert.ok(!calls.some(path=>path.includes('/api/')));
});
test('corrupt overview bytes reject warmup instead of claiming a complete offline map',async()=>{
 await assert.rejects(run(true),/integrity mismatch/);
});
""")
Path(ROOT / "web/tests/startup-polish.test.mjs").write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('map hints stay on map surfaces and article pages avoid map startup work',async()=>{
 const [layout,explore,hints]=await Promise.all([read('app/layout.tsx'),read('components/Explore.tsx'),read('components/MapResourceHints.tsx')]);
 assert.doesNotMatch(layout,/tiles\.openfreemap|russia-display-area\.geojson|tropa-style\.json/);
 assert.match(explore,/MapResourceHints/);
 assert.match(hints,/rel="preconnect"/);
 assert.match(hints,/russia-display-area\.geojson/);
 assert.match(hints,/tropa-style\.json/);
});

test('service worker registers after load and warms maps only during idle map sessions',async()=>{
 const [client,worker]=await Promise.all([read('components/ServiceWorker.tsx'),read('public/sw.js')]);
 assert.match(client,/requestIdleCallback/);
 assert.match(client,/addEventListener\('load'/);
 assert.match(client,/querySelector\('\.explore-layout'\)/);
 assert.match(client,/saveData/);
 assert.match(client,/type: 'warm-map'/);
 assert.match(worker,/tropnik-shell-v17/);
 assert.match(worker,/addEventListener\('message'/);
 assert.match(worker,/warmMapCache/);
 const install=worker.match(/addEventListener\('install'[\s\S]*?addEventListener\('activate'/)?.[0]||'';
 assert.doesNotMatch(install,/cacheOverview/);
});

test('safety registration loads the heavy route catalogue only on demand',async()=>{
 const source=await read('components/SafetyRegistration.tsx');
 assert.doesNotMatch(source,/import \{regions, trails\} from '@\/lib\/content'/);
 assert.match(source,/import\('@\/lib\/content'\)/);
 assert.match(source,/Выбрать маршрут из каталога/);
 assert.match(source,/catalogState/);
 assert.match(source,/datalist id="safety-regions"/);
});

test('final visual layer owns touch, viewport and reduced-motion guardrails',async()=>{
 const [layout,css,pkg]=await Promise.all([read('app/layout.tsx'),read('app/final-polish.css'),read('package.json')]);
 assert.ok(layout.indexOf('final-polish.css')>layout.indexOf('map-ui-release.css'));
 assert.match(css,/touch-action:manipulation/);
 assert.match(css,/content-visibility:auto/);
 assert.match(css,/safe-area-inset/);
 assert.match(css,/prefers-reduced-motion/);
 assert.equal(JSON.parse(pkg).version,'0.4.10');
});
""")

doc = ROOT / "docs/MAP-VISUAL-SYSTEM.md"
doc_text = doc.read_text()
section = """

## 0.4.10 — политика быстрого старта

- Корневой layout не инициирует соединения с тайловыми серверами и не предзагружает карту на статьях, в профиле или в форме безопасности. Ресурсные подсказки принадлежат только компоненту карты.
- Service worker регистрируется после события `load` и свободного периода главного потока. На медленном соединении или при включённой экономии трафика фоновый прогрев не запускается.
- Установка worker сохраняет только минимальный автономный каркас. Проверенный обзорный рельеф и WebGL-ресурсы прогреваются отдельным сообщением только после появления карты; мобильный Canvas-режим не загружает WebGL-пакет.
- Экран регистрации похода не импортирует полный каталог маршрутов при первом рендере. Каталог загружается по запросу или при открытии страницы с конкретным `route`.
- Финальный CSS-слой отвечает только за кроссплатформенные guardrails: безопасные отступы, перенос длинного текста, 44-px touch targets, ограниченные переходы и `prefers-reduced-motion`. Географическая геометрия и якоря остаются в картографических модулях.
"""
if "## 0.4.10 — политика быстрого старта" not in doc_text:
    doc.write_text(doc_text.rstrip()+section+"\n")

# Temporary release machinery must not enter the product diff.
(ROOT / ".github/workflows/startup-visual-polish.yml").unlink(missing_ok=True)
(ROOT / "tools/apply-startup-visual-polish.py").unlink(missing_ok=True)
