#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
integration = root / 'backend/internal/store/safety_integration_test.go'
text = integration.read_text()

if '\t"errors"\n' not in text:
    anchor = 'import (\n\t"bytes"\n\t"context"\n'
    replacement = 'import (\n\t"bytes"\n\t"context"\n\t"errors"\n'
    if anchor not in text:
        raise SystemExit('safety integration import anchor not found')
    text = text.replace(anchor, replacement, 1)

fixed = '"safety-contact-key-0001"'
unique = '"safety-contact-"+d.ID'
if fixed in text:
    text = text.replace(fixed, unique, 1)
elif unique not in text:
    raise SystemExit('safety contact idempotency anchor not found')

integration.write_text(text)
Path(__file__).unlink()
