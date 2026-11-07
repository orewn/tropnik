#!/usr/bin/env python3
from pathlib import Path

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


# Story controls: real mouse hover only, no persistent touch focus, and decoded
# neighbour images so a manual previous/next action does not hitch on decode.
stories_path = "web/components/PlaceStories.tsx"
replace_once(
    stories_path,
    """ useEffect(()=>{if(!fact)return;setFailedPhoto(current=>current===fact.id?'':current);if(facts.length<2)return;for(const offset of [-1,1]){const nearby=facts[(index+offset+facts.length)%facts.length];const image=new window.Image();image.src=nearby.imageUrl;}},[fact?.id,facts,index]);""",
    """ useEffect(()=>{if(!fact)return;setFailedPhoto(current=>current===fact.id?'':current);if(facts.length<2)return;for(const offset of [-1,1]){const nearby=facts[(index+offset+facts.length)%facts.length];const image=new window.Image();image.decoding='async';image.src=nearby.imageUrl;void image.decode().catch(()=>undefined);}},[fact?.id,facts,index]);""",
    "story image preload",
)
replace_once(
    stories_path,
    """ function finishSwipe(event:ReactPointerEvent<HTMLElement>){
  const start=swipe.current;swipe.current=null;
  if(!start||start.id!==event.pointerId)return;
  const dx=event.clientX-start.x,dy=event.clientY-start.y;
  if(Math.abs(dx)>=44&&Math.abs(dx)>Math.abs(dy)*1.2){event.preventDefault();manual(dx>0?-1:1);}
 }""",
    """ function finishSwipe(event:ReactPointerEvent<HTMLElement>){
  const control=(event.target as HTMLElement).closest('button');
  if(event.pointerType!=='mouse'&&control instanceof HTMLButtonElement)requestAnimationFrame(()=>control.blur());
  const start=swipe.current;swipe.current=null;
  if(!start||start.id!==event.pointerId)return;
  const dx=event.clientX-start.x,dy=event.clientY-start.y;
  if(Math.abs(dx)>=44&&Math.abs(dx)>Math.abs(dy)*1.2){event.preventDefault();manual(dx>0?-1:1);}
 }""",
    "touch focus release",
)
replace_once(
    stories_path,
    """  onMouseEnter={()=>setHovered(true)}
  onMouseLeave={()=>setHovered(false)}""",
    """  onPointerEnter={event=>{if(event.pointerType==='mouse')setHovered(true);}}
  onPointerLeave={event=>{if(event.pointerType==='mouse')setHovered(false);}}""",
    "fine-pointer hover",
)
replace_once(
    stories_path,
    """<img key={fact.imageUrl} src={fact.imageUrl} alt={fact.imageAlt} loading="eager" decoding="async" style={{objectPosition:fact.imagePosition||'50% 50%'}} onError={()=>setFailedPhoto(fact.id)}/>""",
    """<img key={fact.imageUrl} src={fact.imageUrl} alt={fact.imageAlt} loading="eager" decoding="async" fetchPriority="high" draggable={false} style={{objectPosition:fact.imagePosition||'50% 50%'}} onError={()=>setFailedPhoto(fact.id)}/>""",
    "story image priority",
)
stories = read(stories_path)
if '<button type="button"' not in stories:
    if stories.count('<button ') < 8:
        raise RuntimeError('PlaceStories button inventory changed unexpectedly')
    stories = stories.replace('<button ', '<button type="button" ')
    write(stories_path, stories)

# Label reflow should react to geometry changes, not every story text mutation or
# pointer crossing in the entire page. ResizeObserver remains authoritative.
layout_path = "web/lib/map-direction-layout.ts"
layout = read(layout_path)
start = layout.index("export function bindMapLabelReflow(")
end = layout.index("\nexport function directionCountLabel", start)
replacement = r'''export function bindMapLabelReflow(viewport:HTMLElement,schedule:()=>void){
  const root=viewport.closest('.explore-layout')??viewport.parentElement??viewport;
  const selector=MAP_LABEL_OBSTACLE_SELECTORS.join(',');
  const mapInteractive='.region-marker,.trail-marker';
  const resize=new ResizeObserver(schedule),observed=new Set<Element>();
  const observe=()=>{
    for(const element of [viewport,...root.querySelectorAll(selector)])if(!observed.has(element)){observed.add(element);resize.observe(element);}
  };
  const geometryNode=(node:Node)=>node instanceof Element&&(
    node.matches(`${selector},${mapInteractive}`)||!!node.querySelector(`${selector},${mapInteractive}`)
  );
  observe();
  const mutation=new MutationObserver(records=>{
    const relevant=records.some(record=>{
      if(record.type==='attributes'){
        const target=record.target;
        return target instanceof Element&&!!target.closest(`${selector},${mapInteractive}`);
      }
      return [...record.addedNodes,...record.removedNodes].some(geometryNode);
    });
    if(relevant){observe();schedule();}
  });
  mutation.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-expanded']});
  const markerSchedule=(event:Event)=>{if(event.target instanceof Element&&event.target.closest(mapInteractive))schedule();};
  const transitionSchedule=(event:Event)=>{if(event.target instanceof Element&&event.target.closest(selector))schedule();};
  root.addEventListener('pointerover',markerSchedule,true);
  root.addEventListener('focusin',markerSchedule,true);
  root.addEventListener('transitionend',transitionSchedule,true);
  const fonts=document.fonts,visual=window.visualViewport;
  void fonts.ready.then(schedule).catch(()=>undefined);
  fonts.addEventListener('loadingdone',schedule);
  window.addEventListener('resize',schedule,{passive:true});
  window.addEventListener('orientationchange',schedule,{passive:true});
  visual?.addEventListener('resize',schedule,{passive:true});
  visual?.addEventListener('scroll',schedule,{passive:true});
  schedule();
  return()=>{
    resize.disconnect();mutation.disconnect();
    root.removeEventListener('pointerover',markerSchedule,true);
    root.removeEventListener('focusin',markerSchedule,true);
    root.removeEventListener('transitionend',transitionSchedule,true);
    fonts.removeEventListener('loadingdone',schedule);
    window.removeEventListener('resize',schedule);
    window.removeEventListener('orientationchange',schedule);
    visual?.removeEventListener('resize',schedule);
    visual?.removeEventListener('scroll',schedule);
  };
}
'''
layout = layout[:start] + replacement + layout[end:]
write(layout_path, layout)

# Camera hot path: map engines own marker projection while moving. Hide labels
# during motion and run the expensive collision/DOM measurement once on settle.
atlas = "web/components/Atlas.tsx"
replace_once(atlas, "    map.on('move',scheduleDirectionLayout);", "    map.on('movestart',()=>{if(container.current)container.current.dataset.mapCamera='moving';});", "MapLibre camera hot path")
replace_once(
    atlas,
    """    map.on('dragstart',()=>{fullView.current=false;frameRefit.current?.cancel();});map.on('zoomstart',event=>{if(event.originalEvent){fullView.current=false;frameRefit.current?.cancel();}if(container.current)container.current.dataset.mapCamera='zooming';scheduleDirectionLayout();});""",
    """    map.on('dragstart',()=>{fullView.current=false;frameRefit.current?.cancel();});map.on('zoomstart',event=>{if(event.originalEvent){fullView.current=false;frameRefit.current?.cancel();}if(container.current)container.current.dataset.mapCamera='zooming';});""",
    "MapLibre zoom start",
)
replace_once(
    atlas,
    """    map.on('moveend',()=>{
     scheduleDirectionLayout();""",
    """    map.on('moveend',()=>{
     if(container.current)delete container.current.dataset.mapCamera;
     scheduleDirectionLayout();""",
    "MapLibre move settle",
)
replace_once(
    atlas,
    """     scheduleDirectionLayout();
     requestAnimationFrame(()=>{if(!cancelled&&container.current){delete container.current.dataset.mapCamera;scheduleDirectionLayout();}});""",
    """     requestAnimationFrame(()=>{if(!cancelled&&container.current){delete container.current.dataset.mapCamera;scheduleDirectionLayout();}});""",
    "MapLibre zoom settle",
)

canvas = "web/components/Atlas2D.tsx"
replace_once(
    canvas,
    """    map.on('move',scheduleDirectionLayout);map.on('zoom',scheduleDirectionLayout);
    map.on('zoomstart',()=>{element.dataset.mapCamera='zooming';scheduleDirectionLayout();});
    map.on('zoomend',()=>{scheduleDirectionLayout();requestAnimationFrame(()=>{if(!cancelled){delete element.dataset.mapCamera;scheduleDirectionLayout();}});});""",
    """    map.on('movestart',()=>{element.dataset.mapCamera='moving';});
    map.on('zoomstart',()=>{element.dataset.mapCamera='zooming';});
    map.on('zoomend',()=>{requestAnimationFrame(()=>{if(!cancelled){delete element.dataset.mapCamera;scheduleDirectionLayout();}});});""",
    "Leaflet camera hot path",
)
replace_once(
    canvas,
    """    map.on('moveend',()=>{clampCamera();ensureDetail();scheduleDirectionLayout();});""",
    """    map.on('moveend',()=>{delete element.dataset.mapCamera;clampCamera();ensureDetail();scheduleDirectionLayout();});""",
    "Leaflet move settle",
)

# Final loaded-last CSS: stable touch controls, 44px targets, no live blur or
# story animation competing with a moving map, and no sticky coarse-pointer hover.
append_once(
    "web/app/map-ui-release.css",
    "Interaction performance release 0.4.8",
    r'''
/* Interaction performance release 0.4.8. */
.fact-card .fact-controls button,
.fact-card .fact-dismiss,
.fact-card .fact-story-toggle{
  min-width:44px!important;
  min-height:44px!important;
  touch-action:manipulation;
  -webkit-tap-highlight-color:transparent;
  transform:none!important;
  transition:background-color .12s ease,color .12s ease,border-color .12s ease,opacity .12s ease!important;
}
.fact-card .fact-controls button[aria-pressed='true']{background:var(--surface-soft);color:var(--forest)}
.explore-layout .region-marker{width:44px!important;height:44px!important;min-width:44px!important;min-height:44px!important}
.explore-layout :is(.region-marker-label,.trail-marker-label){will-change:auto!important}
.explore-layout .atlas-canvas[data-map-camera] :is(.region-marker-label,.trail-marker-label){opacity:0!important;visibility:hidden!important;transition:none!important}
.explore-layout .atlas-canvas[data-map-camera]~:is(.map-context,.map-style-switch,.map-controls,.layer-control,.map-message){-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
@media(hover:hover) and (pointer:fine){
  .fact-card .fact-controls button:hover,.fact-card .fact-dismiss:hover,.fact-card .fact-story-toggle:hover{background:var(--surface-soft)}
}
@media(hover:none),(pointer:coarse){
  .fact-card .fact-controls button:hover:not([aria-pressed='true']),
  .fact-card .fact-dismiss:hover,.fact-card .fact-story-toggle:hover{background:transparent!important;color:inherit;box-shadow:none!important}
  .fact-card .fact-controls button:focus:not(:focus-visible),
  .fact-card .fact-dismiss:focus:not(:focus-visible),.fact-card .fact-story-toggle:focus:not(:focus-visible){outline:none!important;background:transparent!important;box-shadow:none!important}
  .fact-card .fact-copy{animation:none!important}
  .fact-card:hover .fact-photo img{transform:none!important}
  .explore-layout :is(.map-context,.map-style-switch,.map-controls,.layer-button,.layer-menu,.map-message){-webkit-backdrop-filter:none!important;backdrop-filter:none!important;background:rgba(255,254,250,.98)}
}
@media(max-width:700px){
  .explore-layout .region-marker{width:44px!important;height:44px!important;min-width:44px!important;min-height:44px!important}
}
@media(max-height:620px) and (orientation:landscape){
  .explore-layout .map-style-switch button,.explore-layout .map-controls button{height:44px!important;min-height:44px!important}
}
''',
)

# Browser verification becomes a first-class Pages gate.
workflow = ".github/workflows/pages.yml"
replace_once(
    workflow,
    """      - name: Record the verified build identity
        id: build_metadata""",
    """      - name: Verify real mobile browser interaction and layout
        run: node tools/pages-preview/browser-smoke.mjs
      - name: Record the verified build identity
        id: build_metadata""",
    "Pages browser smoke step",
)

verify = "tools/pages-preview/verify-deployed.mjs"
replace_once(
    verify,
    """const verification = JSON.parse((await request('verification.json')).text);
assert.equal(verification.verified, true);""",
    """const verification = JSON.parse((await request('verification.json')).text);
assert.equal(verification.verified, true);
const browser = JSON.parse((await request('browser-verification.json')).text);
assert.equal(browser.verified, true);
assert.equal(browser.profiles.length, 4);
assert.ok(browser.profiles.every(profile=>profile.width>=320&&profile.height>=390));""",
    "deployed browser report",
)
replace_once(
    verify,
    """console.log(JSON.stringify({verified: true, url: site.href, buildId: build.buildId, sourceCommit: build.sourceCommit, publicHttpChecks: checks, apkSha256: apk.sha256, browserRenderingTested: false}, null, 2));""",
    """console.log(JSON.stringify({verified: true, url: site.href, buildId: build.buildId, sourceCommit: build.sourceCommit, publicHttpChecks: checks, apkSha256: apk.sha256, browserRenderingTested: true}, null, 2));""",
    "deployed browser status",
)

# Browser smoke runs after HTTP verification; promote the generated report once
# all four profiles and the touch interaction pass.
smoke = "tools/pages-preview/browser-smoke.mjs"
replace_once(
    smoke,
    """  await writeFile(REPORT,JSON.stringify(report,null,2)+'\\n');
  console.log(JSON.stringify(report,null,2));""",
    """  await writeFile(REPORT,JSON.stringify(report,null,2)+'\\n');
  const httpReportUrl=new URL('http-verification.json',ROOT);
  const httpReport=JSON.parse(await readFile(httpReportUrl,'utf8'));
  httpReport.browserRenderingTested=true;
  await writeFile(httpReportUrl,JSON.stringify(httpReport,null,2)+'\\n');
  console.log(JSON.stringify(report,null,2));""",
    "browser report promotion",
)

# Version, documentation and source-level regression gates.
replace_once("web/package.json", '"version": "0.4.7"', '"version": "0.4.8"', "web version")
docs = "docs/MAP-VISUAL-SYSTEM.md"
replace_once(docs, "Актуально для веб-релиза **0.4.7**, 7 ноября 2026 года.", "Актуально для веб-релиза **0.4.8**, 7 ноября 2026 года.", "documentation version")
append_once(
    docs,
    "## Плавность взаимодействия и браузерная приёмка",
    """
## Плавность взаимодействия и браузерная приёмка

Во время pan, pinch и wheel zoom движок карты сам проецирует географические anchors. Полный collision-layout подписей, DOM-измерения и группировка направлений выполняются после завершения движения, а не на каждом кадре. На активной камере текстовые плашки временно скрываются; точки и цифровые badges остаются на координатах. Это исключает layout thrashing и конкуренцию с рендером карты.

Touch-интерфейс не использует визуальный `:hover`. После касания служебный focus снимается в следующем animation frame, при этом клавиатурный `:focus-visible` сохраняется. Все controls остаются не меньше 44×44 CSS px. На coarse pointer отключены live backdrop blur, увеличение фото по hover и анимация смены текста карточки.

Pages CI запускает системный Chromium через DevTools Protocol на профилях 320×640, 390×844, 412×915 и 844×390. Проверяются горизонтальный overflow, границы подписей и карточки, размеры touch targets, отсутствие залипшего состояния кнопки назад, cumulative layout shift и длинные main-thread tasks. Публичный deploy принимается только при наличии `browser-verification.json`.
""",
)

place_tests = "web/tests/place-stories.test.mjs"
append_once(
    place_tests,
    "touch story controls never depend on sticky hover",
    r'''
test('touch story controls never depend on sticky hover', () => {
  assert.match(stories, /event\.pointerType!=='mouse'/);
  assert.match(stories, /requestAnimationFrame\(\(\)=>control\.blur\(\)\)/);
  assert.match(stories, /image\.decode\(\)/);
  assert.match(releaseCss, /@media\(hover:none\),\(pointer:coarse\)/);
  assert.match(releaseCss, /fact-card \.fact-copy\{animation:none!important\}/);
  assert.match(releaseCss, /min-width:44px!important/);
});
''',
)
map_tests = "web/tests/map-polish.test.mjs"
append_once(
    map_tests,
    "camera movement keeps the collision engine off the animation hot path",
    r'''
test('camera movement keeps the collision engine off the animation hot path',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const release=read('app/map-ui-release.css');
  const pages=read('../.github/workflows/pages.yml');
  assert.doesNotMatch(atlas,/map\.on\('move',scheduleDirectionLayout\)/);
  assert.doesNotMatch(canvas,/map\.on\('move',scheduleDirectionLayout\)/);
  assert.doesNotMatch(canvas,/map\.on\('zoom',scheduleDirectionLayout\)/);
  assert.match(atlas,/map\.on\('moveend',[\s\S]*scheduleDirectionLayout/);
  assert.match(canvas,/map\.on\('moveend',[\s\S]*scheduleDirectionLayout/);
  assert.match(release,/atlas-canvas\[data-map-camera\][\s\S]*region-marker-label/);
  assert.match(pages,/browser-smoke\.mjs/);
});
''',
)

# One-time release machinery must never enter the squash merge.
(ROOT / ".github/workflows/ui-smoothness-release-v2.yml").unlink(missing_ok=True)
Path(__file__).unlink()
print('0.4.8 interaction performance patch applied')
