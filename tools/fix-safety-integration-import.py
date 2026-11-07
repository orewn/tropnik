#!/usr/bin/env python3
from pathlib import Path

path = Path(__file__).resolve().parents[1] / 'backend/internal/store/safety_integration_test.go'
text = path.read_text()
if '\t"errors"\n' not in text:
    anchor = 'import (\n\t"bytes"\n\t"context"\n'
    replacement = 'import (\n\t"bytes"\n\t"context"\n\t"errors"\n'
    if anchor not in text:
        raise SystemExit('safety integration import anchor not found')
    path.write_text(text.replace(anchor, replacement, 1))
Path(__file__).unlink()
