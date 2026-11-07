#!/usr/bin/env python3
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT/path).read_text()


def write(path,text):
    (ROOT/path).write_text(text)


def remove_all_per_frame(path):
    text=read(path)
    before=text
    patterns=(
        r"(?:^|\n)[ \t]*map\.on\(\s*['\"]move['\"]\s*,\s*scheduleDirectionLayout\s*\)\s*;?",
        r"(?:^|\n)[ \t]*map\.on\(\s*['\"]zoom['\"]\s*,\s*scheduleDirectionLayout\s*\)\s*;?",
    )
    total=0
    for pattern in patterns:
        text,count=re.subn(pattern,'\n',text,flags=re.M)
        total+=count
    # Also remove exact inline remnants without consuming neighbouring code.
    for fragment in (
        "map.on('move',scheduleDirectionLayout);",
        "map.on('move', scheduleDirectionLayout);",
        'map.on("move",scheduleDirectionLayout);',
        "map.on('zoom',scheduleDirectionLayout);",
        "map.on('zoom', scheduleDirectionLayout);",
        'map.on("zoom",scheduleDirectionLayout);',
    ):
        count=text.count(fragment)
        total+=count
        text=text.replace(fragment,'')
    forbidden=re.compile(r"map\.on\(\s*['\"](?:move|zoom)['\"]\s*,\s*scheduleDirectionLayout")
    if forbidden.search(text):
        raise SystemExit(f'{path}: a per-frame direction layout listener survived normalization')
    if total<1 or text==before:
        raise SystemExit(f'{path}: no per-frame direction layout listener was removed')
    write(path,text)


remove_all_per_frame('web/components/Atlas.tsx')
remove_all_per_frame('web/components/Atlas2D.tsx')


def update_contract():
    path='web/tests/map-polish.test.mjs'
    text=read(path)
    replacements={
        "assert.match(atlas,/map\\.on\\('move',scheduleDirectionLayout\\)/);":
            "assert.doesNotMatch(atlas,/map\\.on\\('move',\\s*scheduleDirectionLayout\\)/);",
        "assert.match(canvas,/map\\.on\\('move',scheduleDirectionLayout\\)/);":
            "assert.doesNotMatch(canvas,/map\\.on\\('move',\\s*scheduleDirectionLayout\\)/);",
    }
    changed=0
    for old,new in replacements.items():
        count=text.count(old)
        changed+=count
        text=text.replace(old,new)
    if changed<2:
        raise SystemExit(f'{path}: expected at least two legacy listener assertions, changed {changed}')
    anchor="  assert.doesNotMatch(canvas,/map\\.on\\('move',\\s*scheduleDirectionLayout\\)/);"
    extra="""
  assert.doesNotMatch(canvas,/map\\.on\\('zoom',\\s*scheduleDirectionLayout\\)/);
  assert.match(atlas,/map\\.on\\('movestart'/);
  assert.match(canvas,/map\\.on\\('movestart'/);
  assert.match(atlas,/map\\.on\\('moveend'/);
  assert.match(canvas,/map\\.on\\('moveend'/);"""
    if extra.strip() not in text:
        if anchor not in text:
            raise SystemExit(f'{path}: normalized assertion anchor not found')
        text=text.replace(anchor,anchor+extra,1)
    if "assert.match(atlas,/map\\.on\\('move',scheduleDirectionLayout\\)/);" in text or "assert.match(canvas,/map\\.on\\('move',scheduleDirectionLayout\\)/);" in text:
        raise SystemExit(f'{path}: legacy positive move assertion survived')
    write(path,text)


update_contract()

# Validate the newly generated performance test against the normalized sources.
for path in ('web/components/Atlas.tsx','web/components/Atlas2D.tsx'):
    text=read(path)
    if re.search(r"map\.on\(\s*['\"](?:move|zoom)['\"]\s*,\s*scheduleDirectionLayout",text):
        raise SystemExit(f'{path}: forbidden camera-frame layout binding remains')
    if "map.on('movestart'" not in text or "map.on('moveend'" not in text:
        raise SystemExit(f'{path}: settle-only camera lifecycle is incomplete')

# The release patch is one-shot; keep no repair machinery in the final tree.
Path(__file__).unlink()
