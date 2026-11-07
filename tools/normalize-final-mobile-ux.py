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
css.write_text(style.replace(old_touch,new_touch,1))

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

Path(__file__).unlink()
