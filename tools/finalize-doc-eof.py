#!/usr/bin/env python3
from pathlib import Path

root=Path(__file__).resolve().parents[1]
path=root/'docs/MAP-VISUAL-SYSTEM.md'
path.write_text(path.read_text().rstrip()+'\n')
Path(__file__).unlink()
