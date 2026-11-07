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

Path(__file__).unlink()
