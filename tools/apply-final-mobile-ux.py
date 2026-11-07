#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: {label}: expected one anchor, found {count}")
    target.write_text(text.replace(old, new, 1))


def append_once(path: str, marker: str, addition: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if marker in text:
        return
    target.write_text(text.rstrip() + "\n\n" + addition.strip() + "\n")


# A dedicated preview replaces clipped full panel content in the collapsed peek.
replace_once(
    "web/components/Explore.tsx",
    "const terrainIcon=(id:string,size=24)=>id==='karelia'?<Tree size={size}/>:id==='baikal'?<WaveSine size={size}/>:<Mountains size={size}/>;",
    """const terrainIcon=(id:string,size=24)=>id==='karelia'?<Tree size={size}/>:id==='baikal'?<WaveSine size={size}/>:<Mountains size={size}/>;
const routeCountPreview=(count:number)=>{
 const mod100=count%100,mod10=count%10;
 const noun=mod100>=11&&mod100<=14?'маршрутов':mod10===1?'маршрут':mod10>=2&&mod10<=4?'маршрута':'маршрутов';
 return `${count.toLocaleString('ru')} ${noun}`;
};""",
    "route preview pluralization",
)
replace_once(
    "web/components/Explore.tsx",
    """ },[regionalTrails,routeSearch,difficulty,duration,onlySaved,saved]);
 return <section""",
    """ },[regionalTrails,routeSearch,difficulty,duration,onlySaved,saved]);
 const sheetPreviewKind=trail?'Маршрут':region?'Направление':'Каталог';
 const sheetPreviewTitle=trail?.title??region?.name??'Все направления';
 const sheetPreviewMeta=trail
  ?[trail.distanceKm!==undefined?`${trail.distanceKm.toLocaleString('ru')} км`:undefined,trail.duration].filter(Boolean).join(' · ')||'Открыть карточку маршрута'
  :routeCountPreview(region?shownTrails.length:catalog.length);
 return <section""",
    "sheet preview data",
)
replace_once(
    "web/components/Explore.tsx",
    """ <button className="sheet-handle" type="button" onClick={()=>setSheetOpen(open=>!open)} aria-controls={sheetPanelId} aria-expanded={sheetOpen} aria-label={sheetOpen?'Свернуть список':'Открыть список'}><span/></button>
 <div className="explore-panel-content" ref={panelContent}>""",
    """ <button className="sheet-handle" type="button" onClick={event=>{setSheetOpen(open=>!open);if(window.matchMedia('(pointer:coarse)').matches)event.currentTarget.blur();}} aria-controls={sheetPanelId} aria-expanded={sheetOpen} aria-label={sheetOpen?'Свернуть список':'Открыть список'}><span/></button>
 <button className="sheet-peek-summary" type="button" hidden={sheetOpen} onClick={event=>{setSheetOpen(true);if(window.matchMedia('(pointer:coarse)').matches)event.currentTarget.blur();}} aria-label={`Открыть: ${sheetPreviewTitle}`}>
  <span className="sheet-peek-copy"><small>{sheetPreviewKind}</small><strong>{sheetPreviewTitle}</strong><span>{sheetPreviewMeta}</span></span><ArrowRight size={20}/>
 </button>
 <div className="explore-panel-content" ref={panelContent}>""",
    "dedicated collapsed preview",
)

append_once(
    "web/app/map-ui-release.css",
    "/* Tropnik 0.4.8 collapsed sheet preview. */",
    r'''
/* Tropnik 0.4.8 collapsed sheet preview. */
.sheet-peek-summary{display:none}
@media(max-width:700px){
  .explore-layout .sheet-peek-summary{
    display:grid;
    grid-template-columns:minmax(0,1fr) 44px;
    align-items:center;
    width:100%;
    height:112px;
    min-height:112px;
    padding:12px 18px 15px 22px;
    gap:12px;
    background:var(--surface);
    color:var(--ink);
    text-align:left;
    touch-action:manipulation;
    contain:layout paint style;
  }
  .explore-layout .sheet-peek-summary[hidden]{display:none!important}
  .sheet-peek-copy{display:flex;min-width:0;flex-direction:column;gap:2px}
  .sheet-peek-copy small{color:var(--muted);font-size:9px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}
  .sheet-peek-copy strong{overflow:hidden;color:var(--forest-dark);font-size:18px;line-height:1.25;text-overflow:ellipsis;white-space:nowrap}
  .sheet-peek-copy>span{overflow:hidden;color:var(--muted);font-size:11px;line-height:1.45;text-overflow:ellipsis;white-space:nowrap}
  .sheet-peek-summary>svg{justify-self:end;color:var(--forest)}
  .explore-layout.sheet-closed .explore-panel-content,
  .explore-layout.sheet-closed .panel-foot{
    visibility:hidden!important;
    opacity:0!important;
    pointer-events:none!important;
  }
  .explore-layout.sheet-open .explore-panel-content,
  .explore-layout.sheet-open .panel-foot{visibility:visible;opacity:1}
  .explore-layout .sheet-handle:focus:not(:focus-visible),
  .explore-layout .sheet-peek-summary:focus:not(:focus-visible){outline:none}
}
@media(max-width:360px){
  .explore-layout .sheet-peek-summary{padding-inline:18px 12px}
  .sheet-peek-copy strong{font-size:16px}
}
''',
)

# Browser smoke: tap the real mobile sheet in every profile and verify that its
# geometry is transform-only, accessible and free of sticky touch state.
browser_path = "tools/pages-preview/browser-smoke.mjs"
replace_once(
    browser_path,
    """async function touchPrevious(cdp){
  const point=await evaluate(cdp,`(()=>{const button=document.querySelector('.fact-controls button[aria-label=\"Предыдущая история\"]');if(!button)return null;const r=button.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);""",
    """async function tapSelector(cdp,selector,id=1){
  const point=await evaluate(cdp,`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const r=element.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if(!point)return false;
  await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id,radiusX:2,radiusY:2,force:1}]});
  await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  return true;
}
async function sheetSnapshot(cdp){
  return evaluate(cdp,`(()=>{
    const visible=element=>{if(!element)return false;const style=getComputedStyle(element),r=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&r.width>1&&r.height>1};
    const root=document.querySelector('.explore-layout'),panel=document.querySelector('.explore-panel'),handle=document.querySelector('.sheet-handle'),summary=document.querySelector('.sheet-peek-summary'),content=document.querySelector('.explore-panel-content');
    if(!root||!panel||!handle)return{available:false};
    const rect=panel.getBoundingClientRect();
    return{available:true,state:root.dataset.sheetState,height:rect.height,top:rect.top,transform:getComputedStyle(panel).transform,summaryVisible:visible(summary),contentVisible:visible(content),focused:document.activeElement===handle};
  })()`);
}
async function touchSheet(cdp){
  let closed=await sheetSnapshot(cdp);
  if(!closed.available)return{available:false};
  if(closed.state!=='closed'){
    assert.equal(await tapSelector(cdp,'.sheet-handle',7),true);
    await sleep(380);closed=await sheetSnapshot(cdp);
  }
  assert.equal(await tapSelector(cdp,'.sheet-handle',8),true);
  await sleep(380);const open=await sheetSnapshot(cdp);
  assert.equal(await tapSelector(cdp,'.sheet-handle',9),true);
  await sleep(380);const final=await sheetSnapshot(cdp);
  return{available:true,closed,open,final,heightDelta:Math.max(Math.abs(open.height-closed.height),Math.abs(final.height-closed.height)),cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0};
}
async function touchPrevious(cdp){
  const point=await evaluate(cdp,`(()=>{const button=document.querySelector('.fact-controls button[aria-label=\"Предыдущая история\"]');if(!button)return null;const r=button.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);""",
    "browser sheet interaction helpers",
)
replace_once(
    browser_path,
    """    const touch=await touchPrevious(cdp);
    if(touch.available){""",
    """    const sheet=await touchSheet(cdp);
    if(sheet.available){
      assert.equal(sheet.closed.state,'closed',`${profile.name}: initial sheet state`);
      assert.equal(sheet.closed.summaryVisible,true,`${profile.name}: collapsed preview is not visible`);
      assert.equal(sheet.closed.contentVisible,false,`${profile.name}: full content leaks into collapsed preview`);
      assert.equal(sheet.open.state,'open',`${profile.name}: sheet did not open`);
      assert.equal(sheet.open.contentVisible,true,`${profile.name}: opened content is not visible`);
      assert.equal(sheet.open.summaryVisible,false,`${profile.name}: collapsed preview remained visible while open`);
      assert.equal(sheet.final.state,'closed',`${profile.name}: sheet did not close`);
      assert.equal(sheet.final.focused,false,`${profile.name}: sheet handle retained touch focus`);
      assert.ok(sheet.heightDelta<1.1,`${profile.name}: panel height changed during transform animation (${sheet.heightDelta}px)`);
    }
    const touch=await touchPrevious(cdp);
    if(touch.available){""",
    "browser sheet assertions",
)
replace_once(
    browser_path,
    """    results.push({...profile,geometry,touch});
  }
  const report={verified:true,browser:'system Chromium via CDP',profiles:results.map(({name,width,height,touch})=>({name,width,height,interactionTested:touch.available,layoutShift:touch.cls??0,longestTaskMs:touch.longest??0})),sourceCommit:process.env.GITHUB_SHA||null};""",
    """    results.push({...profile,geometry,sheet,touch});
  }
  const report={verified:true,browser:'system Chromium via CDP',profiles:results.map(({name,width,height,sheet,touch})=>({name,width,height,interactionTested:touch.available,sheetTested:sheet.available,sheetHeightDelta:sheet.heightDelta??0,layoutShift:Math.max(touch.cls??0,sheet.cls??0),longestTaskMs:Math.max(touch.longest??0,sheet.longest??0)})),sourceCommit:process.env.GITHUB_SHA||null};""",
    "browser report fields",
)

# The browser result becomes part of the signed Pages artifact and the public
# post-deploy verification, not a local-only report.
replace_once(
    ".github/workflows/pages.yml",
    """      - name: Record the verified build identity
        id: build_metadata""",
    """      - name: Verify real mobile rendering and sheet interaction
        run: node tools/pages-preview/browser-smoke.mjs
      - name: Record the verified build identity
        id: build_metadata""",
    "Pages browser smoke step",
)
replace_once(
    "tools/pages-preview/verify-deployed.mjs",
    """const pages = JSON.parse((await request('page-manifest.json')).text);
assert.equal(pages.length, build.pages);

const home""",
    """const pages = JSON.parse((await request('page-manifest.json')).text);
assert.equal(pages.length, build.pages);
const browser = JSON.parse((await request('browser-verification.json')).text);
assert.equal(browser.verified, true);
assert.equal(browser.sourceCommit, expectedCommit);
assert.ok(Array.isArray(browser.profiles) && browser.profiles.length >= 4);
for (const profile of browser.profiles) {
  assert.equal(profile.interactionTested, true, `${profile.name}: story touch was not tested`);
  assert.equal(profile.sheetTested, true, `${profile.name}: mobile sheet was not tested`);
  assert.ok(profile.sheetHeightDelta < 1.1, `${profile.name}: mobile sheet changed layout height`);
  assert.ok(profile.layoutShift < .12, `${profile.name}: excessive layout shift`);
  assert.ok(profile.longestTaskMs < 350, `${profile.name}: excessive long task`);
}

const home""",
    "deployed browser report verification",
)
replace_once(
    "tools/pages-preview/verify-deployed.mjs",
    "browserRenderingTested: false",
    "browserRenderingTested: true, browserProfiles: browser.profiles.length",
    "public browser status",
)

# Permanent source-contract tests prevent future regressions even before the
# Chromium smoke runs.
append_once(
    "web/tests/ui-smoothness.test.mjs",
    "test('collapsed mobile sheet has a dedicated stable preview and public browser proof'",
    r'''
test('collapsed mobile sheet has a dedicated stable preview and public browser proof',()=>{
  const explore=read('components/Explore.tsx');
  const css=read('app/map-ui-release.css');
  const pages=read('../.github/workflows/pages.yml');
  const deployed=read('../tools/pages-preview/verify-deployed.mjs');
  const browser=read('../tools/pages-preview/browser-smoke.mjs');
  assert.match(explore,/className="sheet-peek-summary"/);
  assert.match(explore,/hidden=\{sheetOpen\}/);
  assert.match(explore,/routeCountPreview/);
  assert.match(css,/sheet-peek-summary[\s\S]*height:112px/);
  assert.match(css,/sheet-closed \.explore-panel-content[\s\S]*visibility:hidden!important/);
  assert.match(pages,/Verify real mobile rendering and sheet interaction/);
  assert.match(browser,/touchSheet/);
  assert.match(browser,/sheetHeightDelta/);
  assert.match(deployed,/browser-verification\.json/);
  assert.match(deployed,/browserRenderingTested: true/);
});
''',
)

# Runtime documentation explicitly records the closed-sheet interaction model
# and the mandatory real-browser acceptance gate.
docs_path = ROOT / "docs/MAP-VISUAL-SYSTEM.md"
docs = docs_path.read_text()
addition = """

## Закрытая мобильная панель и browser gate

Закрытая нижняя панель не показывает обрезанный фрагмент полного документа. Видимая область состоит только из 44‑px handle и отдельного 112‑px preview с типом материала, названием и количеством маршрутов. Полный прокручиваемый контент в закрытом состоянии получает `visibility: hidden` и исключается из hit-testing; при раскрытии preview удаляется из layout.

Pages-сборка запускает системный Chromium через CDP в профилях 320×640, 390×844, 412×915 и 844×390. Проверяются реальные touch-события, открытие и закрытие панели, постоянство её layout-высоты, отсутствие sticky focus, выходов за viewport, горизонтального overflow, чрезмерного CLS и long tasks. Отчёт `browser-verification.json` входит в публикуемый артефакт и повторно проверяется после deploy.
"""
if "## Закрытая мобильная панель и browser gate" not in docs:
    docs_path.write_text(docs.rstrip() + addition + "\n")

# One-time release plumbing never reaches the final PR.
(ROOT / "tools/apply-final-mobile-ux.py").unlink(missing_ok=True)
(ROOT / ".github/workflows/final-mobile-ux.yml").unlink(missing_ok=True)
