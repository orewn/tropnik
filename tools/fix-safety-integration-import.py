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

# fixture() creates an active departure to provide a verified guide and route.
# This scenario creates another departure for a new safety revision, so release
# the fixture departure first. The production overlap guard remains unchanged.
if "UPDATE departures SET status='cancelled' WHERE id=$1" not in text:
    marker = 'd, err := s.CreateDeparture'
    marker_at = text.find(marker)
    if marker_at < 0:
        raise SystemExit('safety fixture departure creation anchor not found')
    line_at = text.rfind('\n', 0, marker_at) + 1
    indent = text[line_at:marker_at]
    cancel_block = (
        f'{indent}if _, err = s.Pool.Exec(ctx, "UPDATE departures SET status=\'cancelled\' WHERE id=$1", base.ID); err != nil {{\n'
        f'{indent}\tt.Fatal(err)\n'
        f'{indent}}}\n'
    )
    text = text[:line_at] + cancel_block + text[line_at:]

integration.write_text(text)
Path(__file__).unlink()
