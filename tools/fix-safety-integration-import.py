#!/usr/bin/env python3
from pathlib import Path

path = Path(__file__).resolve().parents[1] / 'backend/internal/store/safety_integration_test.go'
text = path.read_text()
if '\t"errors"\n' not in text:
    anchor = 'import (\n\t"bytes"\n\t"context"\n'
    replacement = 'import (\n\t"bytes"\n\t"context"\n\t"errors"\n'
    if anchor not in text:
        raise SystemExit('safety integration import anchor not found')
    text = text.replace(anchor, replacement, 1)
fixed = '"safety-contact-key-0001"'
unique = '"safety-contact-"+d.ID'
if fixed not in text:
    raise SystemExit('safety contact idempotency anchor not found')
text = text.replace(fixed, unique, 1)
path.write_text(text)
Path(__file__).unlink()
