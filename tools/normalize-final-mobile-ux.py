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

browser=root/'tools/pages-preview/browser-smoke.mjs'
script=browser.read_text()
old_metrics="  return{available:true,closed,open,final,heightDelta:Math.max(Math.abs(open.height-closed.height),Math.abs(final.height-closed.height)),cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0};"
new_metrics="""  const perf=await evaluate(cdp,`(()=>({cls:window.__tropnikPerf?.cls||0,longest:window.__tropnikPerf?.longest||0}))()`);
  return{available:true,closed,open,final,heightDelta:Math.max(Math.abs(open.height-closed.height),Math.abs(final.height-closed.height)),cls:perf.cls,longest:perf.longest};"""
if old_metrics not in script:
    raise SystemExit('Browser performance metric context anchor not found')
browser.write_text(script.replace(old_metrics,new_metrics,1))

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
ui_test.write_text(test_text.rstrip()+'\n')

Path(__file__).unlink()
