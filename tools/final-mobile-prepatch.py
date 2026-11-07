#!/usr/bin/env python3
from pathlib import Path

path=Path('tools/final-mobile-map-release.py')
text=path.read_text()
old='replace_once("web/app/map-polish.css","max-width:168px;","max-width:var(--map-label-max-width,168px);","dynamic region label width")'
new='''css=read("web/app/map-polish.css")
if "max-width:var(--map-label-max-width,168px);" not in css:
    write("web/app/map-polish.css",css.replace("max-width:168px;","max-width:var(--map-label-max-width,168px);"))'''
if old not in text:
    raise SystemExit('CSS patch anchor missing')
path.write_text(text.replace(old,new,1))
Path(__file__).unlink()
