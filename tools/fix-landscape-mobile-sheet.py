#!/usr/bin/env python3
from pathlib import Path

root=Path(__file__).resolve().parents[1]
css=root/'web/app/map-ui-release.css'
text=css.read_text()
marker='/* Touch landscape uses the same compositor sheet above 700px. */'
addition=r'''

/* Touch landscape uses the same compositor sheet above 700px. */
@media(min-width:701px) and (max-width:900px) and (max-height:620px) and (orientation:landscape) and (pointer:coarse){
  .explore-layout{
    --sheet-expanded-height:calc(100svh - var(--header) - 8px);
    --sheet-peek:112px;
  }
  .explore-layout .explore-panel,
  .explore-layout .explore-panel.collapsed,
  .explore-layout .explore-panel.expanded{
    position:absolute!important;
    z-index:30;
    left:0!important;
    right:0!important;
    top:auto!important;
    bottom:0!important;
    width:100%!important;
    height:var(--sheet-expanded-height)!important;
    min-height:0!important;
    max-height:calc(100svh - var(--header) - 8px)!important;
    overflow:hidden;
    border-radius:28px 28px 0 0;
    transform:translate3d(0,0,0);
    transition:transform .28s cubic-bezier(.22,1,.36,1)!important;
    will-change:transform;
    backface-visibility:hidden;
    contain:layout paint style;
  }
  .explore-layout.sheet-closed .explore-panel{transform:translate3d(0,calc(100% - var(--sheet-peek)),0)}
  .explore-layout.sheet-open .explore-panel{transform:translate3d(0,0,0)}
  .explore-layout .sheet-handle{
    display:grid;
    place-items:center;
    width:100%;
    height:44px;
    min-height:44px;
    padding:0;
    background:var(--surface);
    touch-action:manipulation;
  }
  .explore-layout .sheet-handle>span{width:40px;height:5px;background:#AEBDA4}
  .explore-layout .sheet-peek-summary{
    display:grid;
    grid-template-columns:minmax(0,1fr) 44px;
    align-items:center;
    width:100%;
    height:68px;
    min-height:68px;
    padding:5px 18px 8px 22px;
    gap:12px;
    background:var(--surface);
    color:var(--ink);
    text-align:left;
    touch-action:manipulation;
  }
  .explore-layout .sheet-peek-summary[hidden]{display:none!important}
  .explore-layout.sheet-closed .explore-panel-content,
  .explore-layout.sheet-closed .panel-foot{visibility:hidden!important;opacity:0!important;pointer-events:none!important}
  .explore-layout.sheet-open .explore-panel-content,
  .explore-layout.sheet-open .panel-foot{visibility:visible;opacity:1}
  .explore-layout.sheet-closed .sheet-handle,
  .explore-layout.sheet-closed .sheet-peek-summary{pointer-events:auto}
  .explore-layout .map-context,
  .explore-layout .map-style-switch,
  .explore-layout .map-controls,
  .explore-layout .layer-button,
  .explore-layout .layer-menu,
  .explore-layout .map-message,
  .map-attribution-content,
  .map-attribution-toggle{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
}
'''
if marker not in text:
    css.write_text(text.rstrip()+addition+'\n')

test=root/'web/tests/ui-smoothness.test.mjs'
tests=test.read_text()
if 'touch landscape receives the mobile sheet preview above 700px' not in tests:
    tests += r'''

test('touch landscape receives the mobile sheet preview above 700px',()=>{
  const css=read('app/map-ui-release.css');
  assert.match(css,/Touch landscape uses the same compositor sheet above 700px/);
  assert.match(css,/@media\(min-width:701px\) and \(max-width:900px\) and \(max-height:620px\) and \(orientation:landscape\) and \(pointer:coarse\)/);
  assert.match(css,/sheet-peek-summary[\s\S]*height:68px[\s\S]*min-height:68px/);
  assert.match(css,/sheet-closed \.explore-panel[\s\S]*translate3d\(0,calc\(100% - var\(--sheet-peek\)\),0\)/);
});
'''
    test.write_text(tests.rstrip()+'\n')

Path(__file__).unlink()
