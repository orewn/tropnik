#!/usr/bin/env python3
from pathlib import Path

root=Path(__file__).resolve().parents[1]

docs=root/'docs/MAP-VISUAL-SYSTEM.md'
docs.write_text(docs.read_text().rstrip()+'\n')

explore=root/'web/components/Explore.tsx'
text=explore.read_text()
old="trail.distanceKm!==undefined?`${trail.distanceKm.toLocaleString('ru')} км`:undefined"
new="trail.distanceKm!=null?`${trail.distanceKm.toLocaleString('ru')} км`:undefined"
if old not in text:
    raise SystemExit('Nullable route distance preview anchor not found')
explore.write_text(text.replace(old,new,1))

css=root/'web/app/map-ui-release.css'
style=css.read_text()
old_touch=".fact-card--compact .fact-story-toggle{font-size:11px;gap:3px;min-height:42px}"
new_touch=".fact-card--compact .fact-story-toggle{font-size:11px;gap:3px;min-height:44px}"
if old_touch not in style:
    raise SystemExit('Compact story touch target anchor not found')
style=style.replace(old_touch,new_touch,1)
sticky_marker='/* Touch browsers may retain synthetic :hover after tap. */'
sticky_fix="""

/* Touch browsers may retain synthetic :hover after tap. */
@media(hover:none),(pointer:coarse){
  .fact-controls button:hover,
  .fact-controls button:active,
  .fact-controls button:focus:not(:focus-visible){background:transparent!important}
}
"""
if sticky_marker not in style:
    style=style.rstrip()+sticky_fix
landscape_marker='/* Compact landscape keeps 44px touch targets. */'
landscape_fix="""

/* Compact landscape keeps 44px touch targets. */
@media(max-height:620px) and (orientation:landscape) and (max-width:900px){
  .explore-layout .map-style-switch{min-height:52px!important}
  .explore-layout .map-style-switch button,
  .explore-layout .map-controls button{
    height:44px!important;
    min-height:44px!important;
  }
}
"""
if landscape_marker not in style:
    style=style.rstrip()+landscape_fix
css.write_text(style.rstrip()+'\n')

stories=root/'web/components/PlaceStories.tsx'
story=stories.read_text()
manual_anchor=" function manual(delta:number){setPaused(true);setIndex(i=>(i+delta+facts.length)%facts.length);}\n"
manual_replacement=""" function manual(delta:number){setPaused(true);setIndex(i=>(i+delta+facts.length)%facts.length);}
 function releaseTouchFocus(button:HTMLButtonElement){
  if(window.matchMedia('(hover:none), (pointer:coarse)').matches)requestAnimationFrame(()=>button.blur());
 }
"""
if manual_anchor not in story:
    raise SystemExit('Story touch-focus helper anchor not found')
story=story.replace(manual_anchor,manual_replacement,1)
controls={
 "<button aria-label=\"Предыдущая история\" onClick={()=>manual(-1)}>":"<button aria-label=\"Предыдущая история\" onClick={event=>{manual(-1);releaseTouchFocus(event.currentTarget);}}>",
 "<button aria-label={paused||reduced?'Включить смену историй':'Остановить смену историй'} aria-pressed={paused||reduced} onClick={togglePlayback}>":"<button aria-label={paused||reduced?'Включить смену историй':'Остановить смену историй'} aria-pressed={paused||reduced} onClick={event=>{togglePlayback();releaseTouchFocus(event.currentTarget);}}>",
 "<button aria-label=\"Следующая история\" onClick={()=>manual(1)}>":"<button aria-label=\"Следующая история\" onClick={event=>{manual(1);releaseTouchFocus(event.currentTarget);}}>",
 "onClick={()=>setExpanded(value=>!value)}>{expanded?'Свернуть':'Читать историю'}":"onClick={event=>{setExpanded(value=>!value);releaseTouchFocus(event.currentTarget);}}>{expanded?'Свернуть':'Читать историю'}",
}
for old_control,new_control in controls.items():
    if old_control not in story:
        raise SystemExit('Story control focus anchor not found: '+old_control[:48])
    story=story.replace(old_control,new_control,1)
stories.write_text(story)

# Progressive enhancement: touch phones use the substantially lighter Leaflet
# canvas path. Desktop keeps MapLibre and all explicit terrain controls.
preload=root/'web/lib/map-preload.ts'
preload_text=preload.read_text()
webgl_anchor="""export function supportsMapWebGL() {
  if(typeof document==='undefined')return false;
  if(webglAvailable===undefined){
    try{const gl=document.createElement('canvas').getContext('webgl2');webglAvailable=!!gl;gl?.getExtension('WEBGL_lose_context')?.loseContext();}
    catch{webglAvailable=false;}
  }
  return webglAvailable;
}
"""
preference="""
export function preferCanvasMap() {
  if(typeof window==='undefined'||typeof navigator==='undefined')return false;
  const nav=navigator as Navigator&{deviceMemory?:number;connection?:{saveData?:boolean}};
  const coarse=window.matchMedia('(pointer:coarse)').matches||nav.maxTouchPoints>0;
  const constrained=(nav.deviceMemory??8)<=4||(nav.hardwareConcurrency||8)<=4||!!nav.connection?.saveData;
  return coarse&&(window.innerWidth<=900||constrained);
}
"""
if webgl_anchor not in preload_text:
    raise SystemExit('WebGL capability anchor not found')
preload_text=preload_text.replace(webgl_anchor,webgl_anchor+preference,1)
old_warm="  const webgl=supportsMapWebGL();"
new_warm="  const webgl=supportsMapWebGL()&&!preferCanvasMap();"
if old_warm not in preload_text:
    raise SystemExit('Map warmup engine anchor not found')
preload.write_text(preload_text.replace(old_warm,new_warm,1))

atlas=root/'web/components/Atlas.tsx'
atlas_text=atlas.read_text()
old_import="import {warmMap,supportsMapWebGL,preloadTerrain,preloadTrail,hasTerrainPreview,loadPublicJSON,mapRequest} from '@/lib/map-preload';"
new_import="import {warmMap,supportsMapWebGL,preferCanvasMap,preloadTerrain,preloadTrail,hasTerrainPreview,loadPublicJSON,mapRequest} from '@/lib/map-preload';"
if old_import not in atlas_text:
    raise SystemExit('Atlas map-preload import anchor not found')
atlas_text=atlas_text.replace(old_import,new_import,1)
old_engine="    if(!supportsMapWebGL()){setFallback(true);return;}"
new_engine="    if(preferCanvasMap()||!supportsMapWebGL()){setFallback(true);return;}"
if old_engine not in atlas_text:
    raise SystemExit('Atlas engine selection anchor not found')
atlas.write_text(atlas_text.replace(old_engine,new_engine,1))

browser=root/'tools/pages-preview/browser-smoke.mjs'
script=browser.read_text()
old_metrics="  return{available:true,closed,open,final,heightDelta:Math.max(Math.abs(open.height-closed.height),Math.abs(final.height-closed.height)),cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0};"
new_metrics="""  const perf=await evaluate(cdp,`(()=>({cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0}))()`);
  return{available:true,closed,open,final,heightDelta:Math.max(Math.abs(open.height-closed.height),Math.abs(final.height-closed.height)),cls:perf.cls,longest:perf.longest};"""
if old_metrics not in script:
    raise SystemExit('Browser performance metric context anchor not found')
script=script.replace(old_metrics,new_metrics,1)
old_geometry="      width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,"
new_geometry="      width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,engine:document.querySelector('.leaflet-container')?'leaflet':document.querySelector('.maplibregl-map')?'maplibre':'unknown',"
if old_geometry not in script:
    raise SystemExit('Browser geometry engine anchor not found')
script=script.replace(old_geometry,new_geometry,1)
old_assert="    assert.ok(geometry.scrollWidth<=geometry.width+1,`${profile.name}: horizontal overflow ${geometry.scrollWidth}>${geometry.width}`);"
new_assert="""    assert.equal(geometry.engine,'leaflet',`${profile.name}: mobile profile loaded the heavy ${geometry.engine} engine`);
    assert.ok(geometry.scrollWidth<=geometry.width+1,`${profile.name}: horizontal overflow ${geometry.scrollWidth}>${geometry.width}`);"""
if old_assert not in script:
    raise SystemExit('Browser engine assertion anchor not found')
browser.write_text(script.replace(old_assert,new_assert,1))

ui_test=root/'web/tests/ui-smoothness.test.mjs'
test_text=ui_test.read_text()
if "synthetic touch hover paint is cleared" not in test_text:
    test_text += """

test('synthetic touch hover paint is cleared without removing keyboard focus',()=>{
  const css=read('app/map-ui-release.css');
  const stories=read('components/PlaceStories.tsx');
  assert.match(css,/Touch browsers may retain synthetic :hover after tap/);
  assert.match(css,/@media\(hover:none\),\(pointer:coarse\)[\s\S]*\.fact-controls button:hover[\s\S]*background:transparent!important/);
  assert.match(css,/focus:not\(:focus-visible\)/);
  assert.match(stories,/releaseTouchFocus/);
  assert.match(stories,/requestAnimationFrame\(\(\)=>button\.blur\(\)\)/);
});
"""
if "compact landscape keeps every map control at 44px" not in test_text:
    test_text += """

test('compact landscape keeps every map control at 44px',()=>{
  const css=read('app/map-ui-release.css');
  assert.match(css,/Compact landscape keeps 44px touch targets/);
  assert.match(css,/@media\(max-height:620px\) and \(orientation:landscape\) and \(max-width:900px\)[\s\S]*map-style-switch button[\s\S]*map-controls button[\s\S]*height:44px!important[\s\S]*min-height:44px!important/);
});
"""
if "mobile touch profiles avoid the heavy WebGL startup path" not in test_text:
    test_text += """

test('mobile touch profiles avoid the heavy WebGL startup path',()=>{
  const preload=read('lib/map-preload.ts');
  const atlas=read('components/Atlas.tsx');
  const browser=read('../tools/pages-preview/browser-smoke.mjs');
  assert.match(preload,/export function preferCanvasMap/);
  assert.match(preload,/window\.innerWidth<=900/);
  assert.match(preload,/supportsMapWebGL\(\)&&!preferCanvasMap\(\)/);
  assert.match(atlas,/preferCanvasMap\(\)\|\|!supportsMapWebGL\(\)/);
  assert.match(browser,/mobile profile loaded the heavy/);
  assert.match(browser,/geometry\.engine,'leaflet'/);
});
"""
ui_test.write_text(test_text.rstrip()+'\n')

runtime_docs=docs.read_text()
engine_section="""

## Адаптивный картографический движок

На touch-устройствах с шириной viewport до 900 px, а также при `saveData`, малом объёме памяти или четырёх и менее логических ядрах, Тропник сразу выбирает Leaflet/Canvas. Этот путь сохраняет карту, маршруты, рельеф, точные географические точки, офлайн-обзор и 3D-сцену, но не загружает и не компилирует 1,1‑МБ MapLibre bundle при первом открытии. Desktop и устройства с точным указателем продолжают использовать MapLibre.

Выбор выполняется до `warmMap`: мобильная ветка не запускает MapLibre prewarm и worker pool. Chromium gate отдельно утверждает, что все четыре touch-профиля реально используют Leaflet, а не только имеют соответствующее условие в исходниках.
"""
if "## Адаптивный картографический движок" not in runtime_docs:
    docs.write_text(runtime_docs.rstrip()+engine_section+'\n')

Path(__file__).unlink()
