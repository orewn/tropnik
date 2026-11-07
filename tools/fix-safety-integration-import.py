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

# Temporary diagnostic output for the immutable event-chain mismatch. This
# script deletes itself, so no diagnostic helper enters the product commit.
safety = (root / 'backend/internal/store/safety.go').read_text().splitlines()
for start, end in ((80, 180), (730, 840)):
    print(f'--- safety.go lines {start}-{end} ---')
    for number, line in enumerate(safety[start - 1:end], start):
        print(f'{number:4d}: {line}')

Path(__file__).unlink()
