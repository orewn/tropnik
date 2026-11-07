#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(path: str, old: str, new: str, label: str) -> None:
    text = read(path)
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: {label}: expected one source anchor, found {count}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{path}: {label}: expected one regex match, found {count}")
    write(path, updated)


# Mobile sheet: stable state classes, a real 44px handle and no stale closure.
replace_once(
    "web/components/Explore.tsx",
    "import {useState,useEffect,useCallback,useMemo,useRef,useSyncExternalStore} from 'react';",
    "import {useState,useEffect,useCallback,useMemo,useRef,useSyncExternalStore,useId} from 'react';",
    "React useId import",
)
replace_once(
    "web/components/Explore.tsx",
    " const hydrated=useSyncExternalStore(subscribeHydration,hydratedSnapshot,serverHydrationSnapshot);\n const panelContent=useRef<HTMLDivElement>(null);",
    " const hydrated=useSyncExternalStore(subscribeHydration,hydratedSnapshot,serverHydrationSnapshot);\n const sheetPanelId=useId();\n const panelContent=useRef<HTMLDivElement>(null);",
    "sheet id",
)
replace_once(
    "web/components/Explore.tsx",
    " return <section className=\"explore-layout\" aria-label=\"Поиск маршрутов\"><aside className={`explore-panel ${sheetOpen?'expanded':'collapsed'}`}>",
    " return <section className={`explore-layout ${sheetOpen?'sheet-open':'sheet-closed'}`} data-sheet-state={sheetOpen?'open':'closed'} aria-label=\"Поиск маршрутов\"><aside id={sheetPanelId} className={`explore-panel ${sheetOpen?'expanded':'collapsed'}`}>",
    "sheet state classes",
)
replace_once(
    "web/components/Explore.tsx",
    " <button className=\"sheet-handle\" onClick={()=>setSheetOpen(!sheetOpen)} aria-expanded={sheetOpen} aria-label={sheetOpen?'Свернуть список':'Открыть список'}><span/></button>",
    " <button className=\"sheet-handle\" type=\"button\" onClick={()=>setSheetOpen(open=>!open)} aria-controls={sheetPanelId} aria-expanded={sheetOpen} aria-label={sheetOpen?'Свернуть список':'Открыть список'}><span/></button>",
    "sheet handle semantics",
)

# A transform-based drawer settles without resizing the map on every animation frame.
replace_once(
    "web/lib/map-framing.ts",
    " const transition=(event:Event)=>{if(event.target===panel&&(event as TransitionEvent).propertyName==='height')refit.settled();};",
    " const transition=(event:Event)=>{const property=(event as TransitionEvent).propertyName;if(event.target===panel&&(property==='transform'||property==='height'))refit.settled();};",
    "transform drawer refit",
)
replace_once(
    "web/tests/map-framing.test.mjs",
    "test('map input bindings stop automatic framing while only the drawer height transition flushes it',()=>{",
    "test('map input bindings stop automatic framing while only the drawer transform transition flushes it',()=>{",
    "map framing test title",
)
replace_once(
    "web/tests/map-framing.test.mjs",
    " panel.events.get('transitionend')({target:{},propertyName:'height'});\n panel.events.get('transitionend')({target:panel,propertyName:'opacity'});\n assert.equal(env.frames.size,0);\n panel.events.get('transitionend')({target:panel,propertyName:'height'});env.flushFrames();",
    " panel.events.get('transitionend')({target:{},propertyName:'transform'});\n panel.events.get('transitionend')({target:panel,propertyName:'opacity'});\n assert.equal(env.frames.size,0);\n panel.events.get('transitionend')({target:panel,propertyName:'transform'});env.flushFrames();",
    "map framing transform assertion",
)

# Batch label invalidations into one animation frame and ignore unrelated transitions.
new_reflow = r'''export function bindMapLabelReflow(viewport:HTMLElement,schedule:()=>void){
  const root=viewport.closest('.explore-layout')??viewport.parentElement??viewport;
  const selector=MAP_LABEL_OBSTACLE_SELECTORS.join(',');
  let frame=0;
  const queue=()=>{
    if(frame)return;
    frame=requestAnimationFrame(()=>{frame=0;schedule();});
  };
  const resize=new ResizeObserver(queue),observed=new Set<Element>();
  const observe=()=>{
    for(const element of [viewport,...root.querySelectorAll(selector)])if(!observed.has(element)){observed.add(element);resize.observe(element);}
  };
  observe();
  const mutation=new MutationObserver(records=>{
    const relevant=records.some(record=>{
      const target=record.target;return !(target instanceof Element)||!target.closest('.atlas-canvas');
    });
    if(relevant){observe();queue();}
  });
  mutation.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-expanded','data-sheet-state']});
  const relevantEvent=(event:Event)=>{
    const target=event.target;
    if(!(target instanceof Element))return;
    if(target===root||target.matches('.explore-panel')||target.closest('.region-marker,.trail-marker,.fact-card,.fact-closed,.map-style-switch,.map-controls,.layer-control,.map-message'))queue();
  };
  root.addEventListener('focusin',relevantEvent,true);
  root.addEventListener('transitionend',relevantEvent,true);
  const fonts=document.fonts,visual=window.visualViewport;
  void fonts.ready.then(queue).catch(()=>undefined);
  fonts.addEventListener('loadingdone',queue);
  window.addEventListener('resize',queue,{passive:true});
  window.addEventListener('orientationchange',queue,{passive:true});
  visual?.addEventListener('resize',queue,{passive:true});
  visual?.addEventListener('scroll',queue,{passive:true});
  queue();
  return()=>{
    if(frame)cancelAnimationFrame(frame);
    resize.disconnect();mutation.disconnect();
    root.removeEventListener('focusin',relevantEvent,true);
    root.removeEventListener('transitionend',relevantEvent,true);
    fonts.removeEventListener('loadingdone',queue);
    window.removeEventListener('resize',queue);
    window.removeEventListener('orientationchange',queue);
    visual?.removeEventListener('resize',queue);
    visual?.removeEventListener('scroll',queue);
  };
}
'''
regex_once(
    "web/lib/map-direction-layout.ts",
    r"export function bindMapLabelReflow\(viewport:HTMLElement,schedule:\(\)=>void\)\{.*?\n\}\n\nexport function directionCountLabel",
    new_reflow + "\nexport function directionCountLabel",
    "batched label reflow",
)

# Native map engines already move markers every frame. Heavy grouping, DOM
# measurement and collision solving now run only after camera movement settles.
replace_once(
    "web/components/Atlas.tsx",
    "    map.on('move',scheduleDirectionLayout);\n",
    "",
    "remove per-frame MapLibre direction layout",
)
replace_once(
    "web/components/Atlas.tsx",
    "    map.on('dragstart',()=>{fullView.current=false;frameRefit.current?.cancel();});map.on('zoomstart',event=>{if(event.originalEvent){fullView.current=false;frameRefit.current?.cancel();}if(container.current)container.current.dataset.mapCamera='zooming';scheduleDirectionLayout();});",
    "    map.on('dragstart',()=>{fullView.current=false;frameRefit.current?.cancel();});\n    map.on('movestart',()=>{if(container.current)container.current.dataset.mapCamera='moving';});\n    map.on('zoomstart',event=>{if(event.originalEvent){fullView.current=false;frameRefit.current?.cancel();}if(container.current)container.current.dataset.mapCamera='moving';});",
    "MapLibre camera start",
)
replace_once(
    "web/components/Atlas.tsx",
    "    map.on('moveend',()=>{\n     scheduleDirectionLayout();",
    "    map.on('moveend',()=>{\n     if(container.current)delete container.current.dataset.mapCamera;\n     scheduleDirectionLayout();",
    "MapLibre settled layout",
)
replace_once(
    "web/components/Atlas.tsx",
    "     scheduleDirectionLayout();\n     requestAnimationFrame(()=>{if(!cancelled&&container.current){delete container.current.dataset.mapCamera;scheduleDirectionLayout();}});",
    "     requestAnimationFrame(()=>{if(!cancelled&&container.current){delete container.current.dataset.mapCamera;scheduleDirectionLayout();}});",
    "MapLibre zoomend duplicate layout",
)

replace_once(
    "web/components/Atlas2D.tsx",
    "    map.on('move',scheduleDirectionLayout);map.on('zoom',scheduleDirectionLayout);\n",
    "    map.on('movestart',()=>{element.dataset.mapCamera='moving';});\n",
    "remove per-frame Leaflet direction layout",
)
replace_once(
    "web/components/Atlas2D.tsx",
    "    map.on('zoomstart',()=>{element.dataset.mapCamera='zooming';scheduleDirectionLayout();});\n",
    "    map.on('zoomstart',()=>{element.dataset.mapCamera='moving';});\n",
    "Leaflet camera start",
)
replace_once(
    "web/components/Atlas2D.tsx",
    "    map.on('moveend',()=>{clampCamera();ensureDetail();scheduleDirectionLayout();});",
    "    map.on('moveend',()=>{delete element.dataset.mapCamera;clampCamera();ensureDetail();scheduleDirectionLayout();});",
    "Leaflet settled layout",
)

# Final, imported-last performance layer. The sheet is composited instead of
# changing height, blur is disabled over the moving map on touch devices and
# story progress animates transform rather than layout width.
css_path = "web/app/map-ui-release.css"
css = read(css_path)
marker = "/* Tropnik 0.4.8 interaction and rendering performance pass. */"
if marker not in css:
    css += r'''

/* Tropnik 0.4.8 interaction and rendering performance pass. */
@keyframes fact-progress-smooth{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.fact-progress span{
  width:100%!important;
  transform:scaleX(0);
  transform-origin:left center;
  animation-name:fact-progress-smooth!important;
  will-change:transform;
}
.explore-panel-content{
  overscroll-behavior-y:contain;
  -webkit-overflow-scrolling:touch;
}
.explore-layout .atlas-canvas[data-map-camera] .region-marker-label,
.explore-layout .atlas-canvas[data-map-camera] .trail-marker-label{
  opacity:0!important;
  visibility:hidden!important;
  transition:none!important;
}
@supports(content-visibility:auto){
  .explore-panel-content .trail-card{
    content-visibility:auto;
    contain-intrinsic-size:132px;
  }
}
@media(max-width:700px){
  .explore-layout{
    --sheet-expanded-height:min(56svh,545px);
    --sheet-peek:156px;
  }
  .explore-layout .explore-panel,
  .explore-layout .explore-panel.collapsed,
  .explore-layout .explore-panel.expanded{
    height:var(--sheet-expanded-height)!important;
    min-height:0!important;
    max-height:calc(100svh - var(--header) - 8px)!important;
    overflow:hidden;
    transform:translate3d(0,0,0);
    transition:transform .28s cubic-bezier(.22,1,.36,1)!important;
    will-change:transform;
    backface-visibility:hidden;
    contain:layout paint style;
  }
  .explore-layout.sheet-closed .explore-panel{
    transform:translate3d(0,calc(100% - var(--sheet-peek)),0);
  }
  .explore-layout.sheet-open .explore-panel{
    transform:translate3d(0,0,0);
  }
  .explore-layout .sheet-handle{
    display:grid;
    place-items:center;
    flex:0 0 44px;
    width:100%;
    min-height:44px;
    height:44px;
    padding:0;
    touch-action:manipulation;
    user-select:none;
    -webkit-user-select:none;
    background:var(--surface);
  }
  .explore-layout .sheet-handle>span{
    width:40px;
    height:5px;
    background:#AEBDA4;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.75);
    transition:width .18s ease,background-color .18s ease,transform .18s ease;
  }
  .explore-layout.sheet-open .sheet-handle>span{
    width:48px;
    background:var(--line-strong);
  }
  .explore-layout.sheet-closed .explore-panel-content{
    overflow:hidden!important;
    pointer-events:none;
  }
  .explore-layout.sheet-closed .sheet-handle{
    pointer-events:auto;
  }
  .explore-layout .explore-panel-content{
    padding-top:0!important;
    scroll-behavior:auto;
  }
  .explore-layout .map-context,
  .explore-layout .map-style-switch,
  .explore-layout .map-controls,
  .explore-layout .layer-button,
  .explore-layout .layer-menu,
  .explore-layout .map-message,
  .map-attribution-content,
  .map-attribution-toggle{
    backdrop-filter:none!important;
    -webkit-backdrop-filter:none!important;
    background:rgba(255,254,250,.985)!important;
  }
  .explore-layout .map-style-switch,
  .explore-layout .map-controls,
  .explore-layout .layer-button,
  .explore-layout .fact-card{
    box-shadow:0 8px 22px rgba(29,48,38,.10)!important;
  }
  .explore-layout .fact-card{
    transform:translateZ(0);
    backface-visibility:hidden;
    contain:layout paint style;
  }
}
@media(hover:none),(pointer:coarse){
  .fact-photo img{transition:none!important}
  .fact-card:hover .fact-photo img{transform:none!important}
  .explore-layout .map-style-switch button:active:not(:disabled),
  .explore-layout .map-controls button:active:not(:disabled),
  .explore-layout .layer-button:active:not(:disabled){transform:none!important}
}
@media(max-height:620px) and (orientation:landscape) and (max-width:900px){
  .explore-layout{--sheet-expanded-height:calc(100svh - var(--header) - 8px);--sheet-peek:112px}
}
@media(prefers-reduced-motion:reduce){
  .explore-layout .explore-panel{transition:none!important}
  .fact-progress span{animation:none!important;transform:scaleX(1)}
}
'''
    write(css_path, css)

# Cache and release identity.
replace_once("web/public/sw.js", "const VERSION='tropnik-shell-v14';", "const VERSION='tropnik-shell-v15';", "service worker generation")
replace_once("web/tests/map-polish.test.mjs", "assert.match(sw,/tropnik-shell-v14/);", "assert.match(sw,/tropnik-shell-v15/);", "service worker regression")
package_path = ROOT / "web/package.json"
package = json.loads(package_path.read_text())
package["version"] = "0.4.8"
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n")

# Permanent regression tests for the performance contract.
write("web/tests/ui-smoothness.test.mjs", r'''import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('mobile sheet uses compositor transforms instead of resizing the map every frame',()=>{
  const explore=read('components/Explore.tsx');
  const css=read('app/map-ui-release.css');
  const framing=read('lib/map-framing.ts');
  assert.match(explore,/sheet-open.*sheet-closed/);
  assert.match(explore,/aria-controls=\{sheetPanelId\}/);
  assert.match(css,/--sheet-peek:156px/);
  assert.match(css,/transition:transform \.28s/);
  assert.match(css,/translate3d\(0,calc\(100% - var\(--sheet-peek\)\),0\)/);
  assert.doesNotMatch(css,/Tropnik 0\.4\.8[\s\S]*transition:height/);
  assert.match(framing,/property==='transform'/);
});

test('camera movement does not run full DOM collision layout on every frame',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const labels=read('lib/map-direction-layout.ts');
  assert.doesNotMatch(atlas,/map\.on\('move',scheduleDirectionLayout\)/);
  assert.doesNotMatch(canvas,/map\.on\('move',scheduleDirectionLayout\)/);
  assert.doesNotMatch(canvas,/map\.on\('zoom',scheduleDirectionLayout\)/);
  assert.match(atlas,/map\.on\('movestart'/);
  assert.match(canvas,/map\.on\('movestart'/);
  assert.match(labels,/let frame=0/);
  assert.match(labels,/requestAnimationFrame\(\(\)=>\{frame=0;schedule\(\);\}\)/);
  assert.doesNotMatch(labels,/root\.addEventListener\('pointerover'/);
});

test('mobile paint work is bounded and progress animation stays compositor-only',()=>{
  const css=read('app/map-ui-release.css');
  assert.match(css,/@keyframes fact-progress-smooth[\s\S]*transform:scaleX\(1\)/);
  assert.match(css,/backdrop-filter:none!important/);
  assert.match(css,/content-visibility:auto/);
  assert.match(css,/contain:layout paint style/);
  assert.match(css,/sheet-handle[\s\S]*min-height:44px/);
});
''')

# Documentation records the real runtime contract rather than aspirational UI.
docs_path = "docs/MAP-VISUAL-SYSTEM.md"
docs = read(docs_path).replace("Актуально для веб-релиза **0.4.7**", "Актуально для веб-релиза **0.4.8**")
section = """

## Плавность и бюджет кадра

Мобильная нижняя панель имеет постоянную высоту и раскрывается через compositor-свойство `transform`. Анимация не меняет `height`, поэтому не запускает каскадный `ResizeObserver`, resize карты и повторный fit камеры на каждом кадре. Карта получает один итоговый refit после `transitionend`.

Во время pan, pinch и zoom картографический движок самостоятельно перемещает географические markers. Тяжёлая группировка направлений, измерение DOM и collision pass выполняются после завершения движения, а не на каждом `move`. Активное движение временно скрывает только подписи; точки и цифровые badges остаются нативно закреплены на координатах.

Resize, visual viewport, orientation, панели и загрузка шрифтов объединяются в один `requestAnimationFrame`. На touch-устройствах отключены blur и декоративные hover-transform поверх движущейся карты. Прогресс историй анимируется через `transform: scaleX`, карточки списка используют `content-visibility`, а скролл нижней панели изолирован через `overscroll-behavior`.
"""
if "## Плавность и бюджет кадра" not in docs:
    docs += section
write(docs_path, docs)

# One-time release plumbing must not survive the squash merge.
(ROOT / "scripts/apply-ui-smoothness-0.4.8.py").unlink(missing_ok=True)
(ROOT / ".github/workflows/ui-smoothness-release.yml").unlink(missing_ok=True)
