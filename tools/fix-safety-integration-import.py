#!/usr/bin/env python3
from pathlib import Path
import re

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
    match = re.search(r'(?m)^(?P<indent>[ \t]*)d\s*,\s*err\s*:=\s*s\.CreateDeparture', text)
    if not match:
        raise SystemExit('safety fixture departure creation anchor not found')
    indent = match.group('indent')
    cancel_block = (
        f'{indent}if _, err = s.Pool.Exec(ctx, "UPDATE departures SET status=\'cancelled\' WHERE id=$1", base.ID); err != nil {{\n'
        f'{indent}\tt.Fatal(err)\n'
        f'{indent}}}\n'
    )
    text = text[:match.start()] + cancel_block + text[match.start():]
integration.write_text(text)

safety_path = root / 'backend/internal/store/safety.go'
safety = safety_path.read_text()
# PostgreSQL timestamptz persists microseconds. Hashing a nanosecond timestamp
# before insertion makes the immutable event unverifiable after a round trip.
old_created = 'created := time.Now().UTC()'
new_created = 'created := time.Now().UTC().Truncate(time.Microsecond)'
if old_created in safety:
    safety = safety.replace(old_created, new_created, 1)
elif new_created not in safety:
    raise SystemExit('safety event creation timestamp anchor not found')
old_verify = 'created.UTC().Format(time.RFC3339Nano)'
new_verify = 'created.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)'
if old_verify in safety:
    safety = safety.replace(old_verify, new_verify, 1)
elif new_verify not in safety:
    raise SystemExit('safety event verification timestamp anchor not found')
safety_path.write_text(safety)

Path(__file__).unlink()
