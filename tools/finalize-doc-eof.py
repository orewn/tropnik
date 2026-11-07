#!/usr/bin/env python3
from pathlib import Path

root=Path(__file__).resolve().parents[1]
for relative in (
    'docs/MAP-VISUAL-SYSTEM.md',
    'web/app/map-ui-release.css',
    'web/tests/ui-smoothness.test.mjs',
):
    path=root/relative
    path.write_text(path.read_text().rstrip()+'\n')
Path(__file__).unlink()
