#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(path: str, old: str, new: str, label: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one {label} anchor, found {count}")
    write(path, text.replace(old, new, 1))


def append_once(path: str, marker: str, addition: str) -> None:
    text = read(path)
    if marker in text:
        return
    write(path, text.rstrip() + "\n\n" + addition.strip() + "\n")


# Atlas: synchronize mutable callbacks after commit instead of mutating refs in
# the render phase. Scene visibility is keyed to the selection, so changing a
# region/route resets it without a synchronous setState effect.
atlas = "web/components/Atlas.tsx"
replace_once(
    atlas,
    """ const [fallback,setFallback]=useState(false),[scene,setScene]=useState(false);
 const [loaded,setLoaded]=useState(false),[painted,setPainted]=useState(false),[tilesLoading,setTilesLoading]=useState(false),[offline,setOffline]=useState(false);
 const [baseMode,setBaseMode]=useState<'detail'|'overview'>('detail'),[terrain,setTerrain]=useState(false),[layersOpen,setLayersOpen]=useState(false),[status,setStatus]=useState('');
 const [pathLayer,setPathLayer]=useState(true),[boundaryLayer,setBoundaryLayer]=useState(true),[mapZoom,setMapZoom]=useState(2),[styleRevision,setStyleRevision]=useState(0);
 const sceneAvailable=hasTerrainPreview(trail,region?.id);
 onRegionRef.current=onRegion;onTrailRef.current=onTrail;regionRef.current=region;trailRef.current=trail;viewportRef.current=onViewportRegion;terrainRef.current=terrain;
 visibleTrailsRef.current=visibleTrails;
 layerVisibility.current={paths:pathLayer,boundaries:boundaryLayer};
 useEffect(()=>{setScene(false);if(sceneAvailable)void preloadTerrain();},[region?.id,trail?.id,sceneAvailable]);""",
    """ const [fallback,setFallback]=useState(false),[sceneSelection,setSceneSelection]=useState('');
 const [loaded,setLoaded]=useState(false),[painted,setPainted]=useState(false),[tilesLoading,setTilesLoading]=useState(false),[offline,setOffline]=useState(false);
 const [baseMode,setBaseMode]=useState<'detail'|'overview'>('detail'),[terrain,setTerrain]=useState(false),[layersOpen,setLayersOpen]=useState(false),[status,setStatus]=useState('');
 const [pathLayer,setPathLayer]=useState(true),[boundaryLayer,setBoundaryLayer]=useState(true),[mapZoom,setMapZoom]=useState(2),[styleRevision,setStyleRevision]=useState(0);
 const sceneKey=`${region?.id??''}:${trail?.id??''}`,sceneAvailable=hasTerrainPreview(trail,region?.id),scene=sceneAvailable&&sceneSelection===sceneKey;
 useEffect(()=>{
  onRegionRef.current=onRegion;onTrailRef.current=onTrail;regionRef.current=region;trailRef.current=trail;viewportRef.current=onViewportRegion;terrainRef.current=terrain;
  visibleTrailsRef.current=visibleTrails;layerVisibility.current={paths:pathLayer,boundaries:boundaryLayer};
 },[onRegion,onTrail,region,trail,onViewportRegion,terrain,visibleTrails,pathLayer,boundaryLayer]);
 useEffect(()=>{if(sceneAvailable)void preloadTerrain();},[sceneAvailable,sceneKey]);""",
    "Atlas render-phase refs",
)
text = read(atlas)
if text.count("setScene(false)") < 2 or text.count("setScene(true)") != 1:
    raise RuntimeError("Atlas scene controls changed unexpectedly")
text = text.replace("setScene(false)", "setSceneSelection('')").replace("setScene(true)", "setSceneSelection(sceneKey)")
write(atlas, text)

# Leaflet fallback receives the same render discipline and keyed scene state.
canvas = "web/components/Atlas2D.tsx"
replace_once(
    canvas,
    """ const [reliefReady,setReliefReady]=useState(false);
 const [scene,setScene]=useState(false),[loaded,setLoaded]=useState(false),[tilesLoading,setTilesLoading]=useState(false);
 const [status,setStatus]=useState(''),[layers,setLayers]=useState(false),[mode,setMode]=useState<'detail'|'overview'>('overview');
 const [showPaths,setShowPaths]=useState(true),[offline,setOffline]=useState(false);
 pathVisibility.current=showPaths;
 trailRef.current=trail;
 regionRef.current=region;
 visibleTrailsRef.current=visibleTrails;
 const sceneAvailable=hasTerrainPreview(trail,region?.id);
 callbacks.current={onRegion,onTrail,onMapNote,onViewportRegion};
 useEffect(()=>{setScene(false);if(sceneAvailable)void preloadTerrain();},[region?.id,trail?.id,sceneAvailable]);""",
    """ const [reliefReady,setReliefReady]=useState(false);
 const [sceneSelection,setSceneSelection]=useState(''),[loaded,setLoaded]=useState(false),[tilesLoading,setTilesLoading]=useState(false);
 const [status,setStatus]=useState(''),[layers,setLayers]=useState(false),[mode,setMode]=useState<'detail'|'overview'>('overview');
 const [showPaths,setShowPaths]=useState(true),[offline,setOffline]=useState(false);
 const sceneKey=`${region?.id??''}:${trail?.id??''}`,sceneAvailable=hasTerrainPreview(trail,region?.id),scene=sceneAvailable&&sceneSelection===sceneKey;
 useEffect(()=>{
  pathVisibility.current=showPaths;trailRef.current=trail;regionRef.current=region;visibleTrailsRef.current=visibleTrails;
  callbacks.current={onRegion,onTrail,onMapNote,onViewportRegion};
 },[showPaths,trail,region,visibleTrails,onRegion,onTrail,onMapNote,onViewportRegion]);
 useEffect(()=>{if(sceneAvailable)void preloadTerrain();},[sceneAvailable,sceneKey]);""",
    "Atlas2D render-phase refs",
)
text = read(canvas)
if text.count("setScene(false)") < 2 or text.count("setScene(true)") != 1:
    raise RuntimeError("Atlas2D scene controls changed unexpectedly")
text = text.replace("setScene(false)", "setSceneSelection('')").replace("setScene(true)", "setSceneSelection(sceneKey)")
write(canvas, text)

# Story state resets by React identity instead of multiple synchronous effects.
stories = "web/components/PlaceStories.tsx"
replace_once(
    stories,
    """ const [index,setIndex]=useState(0),[paused,setPaused]=useState(false),[hovered,setHovered]=useState(false),[hidden,setHidden]=useState(false),[dismissed,setDismissed]=useState(false),[reduced,setReduced]=useState(false),[expanded,setExpanded]=useState(false),[narrow,setNarrow]=useState(false),[failedPhoto,setFailedPhoto]=useState('');""",
    """ const [index,setIndex]=useState(0),[paused,setPaused]=useState(false),[hovered,setHovered]=useState(false),[hidden,setHidden]=useState(false),[dismissed,setDismissed]=useState(Boolean(routeId)),[reduced,setReduced]=useState(false),[expanded,setExpanded]=useState(false),[narrow,setNarrow]=useState(false),[failedPhoto,setFailedPhoto]=useState('');""",
    "story initial state",
)
replace_once(
    stories,
    """ const regionKey=useRef(''),swipe=useRef<{x:number;y:number;id:number}|null>(null);""",
    """ const swipe=useRef<{x:number;y:number;id:number}|null>(null);""",
    "story key ref",
)
replace_once(
    stories,
    """ useEffect(()=>{const key=`${regionId||'all'}:${routeId||''}`;if(key!==regionKey.current){setIndex(0);setExpanded(false);setPaused(false);regionKey.current=key;}},[regionId,routeId]);
 useEffect(()=>{if(routeId)setDismissed(true);},[routeId]);""",
    """,
    "story reset effects",
)
replace_once(
    stories,
    """ useEffect(()=>{if(!fact)return;setFailedPhoto(current=>current===fact.id?'':current);if(facts.length<2)return;for(const offset of [-1,1]){const nearby=facts[(index+offset+facts.length)%facts.length];const image=new window.Image();image.decoding='async';image.src=nearby.imageUrl;void image.decode().catch(()=>undefined);}},[fact?.id,facts,index]);""",
    """ useEffect(()=>{if(facts.length<2)return;for(const offset of [-1,1]){const nearby=facts[(index+offset+facts.length)%facts.length];const image=new window.Image();image.decoding='async';image.src=nearby.imageUrl;void image.decode().catch(()=>undefined);}},[facts,index]);""",
    "story preload effect",
)

# Explore: defer expensive searching/catalog refreshes and give PlaceStories a
# stable reset boundary. Input remains synchronous while results may lag a frame.
explore = "web/components/Explore.tsx"
replace_once(
    explore,
    """import {useState,useEffect,useCallback,useMemo,useRef,useSyncExternalStore} from 'react';""",
    """import {useState,useEffect,useCallback,useMemo,useRef,useSyncExternalStore,useDeferredValue,startTransition} from 'react';""",
    "Explore React imports",
)
replace_once(
    explore,
    """ const catalog=useMemo(()=>[...liveTrails,...trails.filter(t=>!liveTrails.some(x=>x.id===t.id))],[liveTrails]);""",
    """ const catalog=useMemo(()=>{const liveIds=new Set(liveTrails.map(item=>item.id));return[...liveTrails,...trails.filter(item=>!liveIds.has(item.id))];},[liveTrails]);""",
    "catalog merge",
)
replace_once(
    explore,
    """ useEffect(()=>{api<Route[]>('routes').then(r=>setLiveTrails(r.map(publishedTrail))).catch(()=>{});},[]);""",
    """ useEffect(()=>{api<Route[]>('routes').then(routes=>startTransition(()=>setLiveTrails(routes.map(publishedTrail)))).catch(()=>{});},[]);""",
    "catalog network transition",
)
replace_once(
    explore,
    """ const [saved,setSaved]=useState<SavedPack[]>([]),[notice,setNotice]=useState(''),[saving,setSaving]=useState(''),[request,setRequest]=useState(false),[date,setDate]=useState(''),[note,setNote]=useState(''),[offline,setOffline]=useState(false),[draftSaved,setDraftSaved]=useState(false),[sheetOpen,setSheetOpen]=useState(false);
 const [viewportRegion,setViewportRegion]=useState<string|undefined>();""",
    """ const [saved,setSaved]=useState<SavedPack[]>([]),[notice,setNotice]=useState(''),[saving,setSaving]=useState(''),[request,setRequest]=useState(false),[date,setDate]=useState(''),[note,setNote]=useState(''),[offline,setOffline]=useState(false),[draftSaved,setDraftSaved]=useState(false),[sheetOpen,setSheetOpen]=useState(false);
 const deferredQuery=useDeferredValue(query),savedIds=useMemo(()=>new Set(saved.map(item=>item.id)),[saved]);
 const [viewportRegion,setViewportRegion]=useState<string|undefined>();""",
    "deferred search state",
)
replace_once(
    explore,
    """ const selectRegion=useCallback((r:MapRegion)=>{setRegion(r);setViewportRegion(undefined);setTrail(undefined);setSheetOpen(true);setQuery('');if(window.location.pathname==='/')history.replaceState(null,'',`/?region=${r.id}`);},[]);""",
    """ const selectRegion=useCallback((r:MapRegion)=>{startTransition(()=>{setRegion(r);setViewportRegion(undefined);setTrail(undefined);setSheetOpen(true);setQuery('');});if(window.location.pathname==='/')history.replaceState(null,'',`/?region=${r.id}`);},[]);""",
    "region transition",
)
replace_once(
    explore,
    """ const selectTrail=useCallback((t:Trail)=>{void preloadTrail(t);setTrail(t);if(!region)setRegion(regionById(t.regionId));setSheetOpen(true);if(window.location.pathname==='/')history.replaceState(null,'',`/?region=${region?.id||t.regionId}&route=${encodeURIComponent(t.id)}`);},[region?.id]);""",
    """ const selectTrail=useCallback((t:Trail)=>{void preloadTrail(t);startTransition(()=>{setTrail(t);if(!region)setRegion(regionById(t.regionId));setSheetOpen(true);});if(window.location.pathname==='/')history.replaceState(null,'',`/?region=${region?.id||t.regionId}&route=${encodeURIComponent(t.id)}`);},[region]);""",
    "trail transition",
)
replace_once(
    explore,
    """ const routeSearch=useMemo(()=>query.trim()?searchSite(query,{kind:'route'}):null,[query]);""",
    """ const routeSearch=useMemo(()=>deferredQuery.trim()?searchSite(deferredQuery,{kind:'route'}):null,[deferredQuery]);""",
    "deferred route search",
)
replace_once(
    explore,
    """filterMapTrails(regionalTrails,{query:'',difficulty,duration,onlySaved,savedIds:new Set(saved.map(item=>item.id))})""",
    """filterMapTrails(regionalTrails,{query:'',difficulty,duration,onlySaved,savedIds})""",
    "saved id set",
)
text = read(explore)
text = text.replace("saved.some(s=>s.id===t.id)", "savedIds.has(t.id)")
if text.count("<PlaceStories ") != 1:
    raise RuntimeError(f"Explore: expected one PlaceStories mount, found {text.count('<PlaceStories ')}")
text = text.replace("<PlaceStories ", "<PlaceStories key={`${region?.id||'all'}:${trail?.id||''}`} ", 1)
if "<TerritoryBrowser query={query}" not in text:
    raise RuntimeError("Explore: TerritoryBrowser query anchor missing")
text = text.replace("<TerritoryBrowser query={query}", "<TerritoryBrowser query={deferredQuery}", 1)
write(explore, text)

# Rendering and touch polish beyond the map controls.
append_once(
    "web/app/map-ui-release.css",
    "Extended interaction performance release 0.4.8",
    r'''
/* Extended interaction performance release 0.4.8. */
.explore-panel-content{overscroll-behavior:contain;scrollbar-gutter:stable;scroll-behavior:auto}
.explore-panel-content :is(.trail-card,.route-section,.info-compact,.catalog-empty){content-visibility:auto;contain-intrinsic-size:auto 180px}
.explore-layout .fact-card{contain:layout paint style}
.explore-layout .region-marker{will-change:auto!important}
@media(hover:none),(pointer:coarse){
  :is(.button,.filter-button,.save-button,.icon-button,.back-link,.sheet-handle,.trail-card){transform:none!important;transition-duration:.1s!important;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
  .trail-card:hover:not([aria-current='true']):not(.is-selected){background:var(--surface)!important;border-color:var(--line)!important;box-shadow:var(--shadow-card)!important}
  :is(.back-link,.filter-button,.save-button,.icon-button):hover:not(.selected){box-shadow:none!important}
}
''',
)

# Source-level protection for the eliminated render work.
(ROOT / "web/tests/ui-performance.test.mjs").write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('map callbacks synchronize after commit instead of mutating refs during render',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  assert.doesNotMatch(atlas,/sceneAvailable=hasTerrainPreview[\s\S]{0,400}onRegionRef\.current=/);
  assert.doesNotMatch(canvas,/sceneAvailable=hasTerrainPreview[\s\S]{0,400}pathVisibility\.current=/);
  assert.match(atlas,/useEffect\(\(\)=>\{[\s\S]*onRegionRef\.current=onRegion/);
  assert.match(canvas,/useEffect\(\(\)=>\{[\s\S]*pathVisibility\.current=showPaths/);
  assert.match(atlas,/sceneSelection===sceneKey/);
  assert.match(canvas,/sceneSelection===sceneKey/);
});

test('search and remote catalogue work are deferred away from urgent input',()=>{
  const explore=read('components/Explore.tsx');
  assert.match(explore,/useDeferredValue\(query\)/);
  assert.match(explore,/startTransition\(\(\)=>setLiveTrails/);
  assert.match(explore,/new Set\(saved\.map/);
  assert.match(explore,/PlaceStories key=/);
});

test('offscreen cards and coarse pointer states use the lightweight path',()=>{
  const css=read('app/map-ui-release.css');
  assert.match(css,/content-visibility:auto/);
  assert.match(css,/contain-intrinsic-size/);
  assert.match(css,/scrollbar-gutter:stable/);
  assert.match(css,/@media\(hover:none\),\(pointer:coarse\)[\s\S]*trail-card:hover/);
});
''')

# One-time helper never enters the release commit.
Path(__file__).unlink()
print('extended 0.4.8 React and scrolling performance patch applied')
