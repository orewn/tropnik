#!/usr/bin/env python3
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]

def update(path,transform):
    target=ROOT/path
    before=target.read_text()
    after=transform(before)
    if after==before:
        raise SystemExit(f'{path}: normalizer made no change')
    target.write_text(after)


def remove_per_frame(text):
    text,count_move=re.subn(r"\s*map\.on\('move',\s*scheduleDirectionLayout\);",'',text)
    text,count_zoom=re.subn(r"\s*map\.on\('zoom',\s*scheduleDirectionLayout\);",'',text)
    if count_move+count_zoom<1:
        raise SystemExit('No per-frame direction layout listener found')
    return text

update('web/components/Atlas.tsx',remove_per_frame)
update('web/components/Atlas2D.tsx',remove_per_frame)


def update_contract(text):
    old="""  assert.match(atlas,/map\\.on\\('move',scheduleDirectionLayout\\)/);
  assert.match(canvas,/map\\.on\\('move',scheduleDirectionLayout\\)/);"""
    new="""  assert.doesNotMatch(atlas,/map\\.on\\('move',\\s*scheduleDirectionLayout\\)/);
  assert.doesNotMatch(canvas,/map\\.on\\('move',\\s*scheduleDirectionLayout\\)/);
  assert.doesNotMatch(canvas,/map\\.on\\('zoom',\\s*scheduleDirectionLayout\\)/);
  assert.match(atlas,/map\\.on\\('movestart'/);
  assert.match(canvas,/map\\.on\\('movestart'/);
  assert.match(atlas,/map\\.on\\('moveend'/);
  assert.match(canvas,/map\\.on\\('moveend'/);"""
    if old not in text:
        raise SystemExit('Legacy per-frame marker assertions not found')
    return text.replace(old,new,1)

update('web/tests/map-polish.test.mjs',update_contract)

# The release patch is one-shot; keep no repair machinery in the final tree.
Path(__file__).unlink()
