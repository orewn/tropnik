#!/usr/bin/env python3
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def replace(path,old,new):
    target=ROOT/path
    text=target.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f'missing reviewed anchor in {path}')
    target.write_text(text.replace(old,new,1))

replace(Path('web/app/map-polish.css'),
'''.explore-layout .trail-marker:hover,
.explore-layout .trail-marker:focus-visible{background:transparent}
''',
'''.explore-layout .trail-marker:hover,
.explore-layout .trail-marker:focus-visible{background:transparent;transform:none}
''')
replace(Path('web/tests/map-polish.test.mjs'),
'''  assert.match(css,/atlas-canvas\\{overflow:hidden\\}/);
});
''',
'''  assert.match(css,/atlas-canvas\\{overflow:hidden\\}/);
  assert.match(css,/trail-marker:focus-visible\\{background:transparent;transform:none\\}/);
});
''')
