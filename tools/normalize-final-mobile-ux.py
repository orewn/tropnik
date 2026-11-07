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

Path(__file__).unlink()
