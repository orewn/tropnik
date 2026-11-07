#!/usr/bin/env python3
from pathlib import Path

script = Path('tools/apply-startup-visual-polish.py')
text = script.read_text()
old = 'doc.write_text(doc_text.rstrip()+section+"\\n")'
new = 'doc.write_text(doc_text.rstrip()+section.rstrip()+"\\n")'
if old not in text:
    raise SystemExit('documentation normalization anchor missing')
script.write_text(text.replace(old, new, 1))

test = Path('web/tests/place-stories.test.mjs')
source = test.read_text()
old = """  const imports = [...layout.matchAll(/import \"\\.\\/(.+?\\.css)\";/g)].map(match => match[1]);
  assert.equal(imports.at(-1), 'map-ui-release.css', 'release overrides must load after every legacy map stylesheet');
"""
new = """  const imports = [...layout.matchAll(/import \"\\.\\/(.+?\\.css)\";/g)].map(match => match[1]);
  const releaseIndex = imports.indexOf('map-ui-release.css');
  assert.ok(releaseIndex > imports.indexOf('interface-refresh.css'), 'map release overrides must stay after every legacy map stylesheet');
  assert.equal(imports.at(-1), 'final-polish.css', 'cross-platform guardrails must be the final stylesheet');
  assert.ok(imports.indexOf('final-polish.css') > releaseIndex, 'generic guardrails must not replace map-specific release geometry');
"""
if old not in source:
    raise SystemExit('map UI stylesheet order assertion missing')
test.write_text(source.replace(old, new, 1))

Path(__file__).unlink()
