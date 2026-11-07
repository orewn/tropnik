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
cancel_block = '''\tif _, err = s.Pool.Exec(ctx, "UPDATE departures SET status='cancelled' WHERE id=$1", base.ID); err != nil {
\t\tt.Fatal(err)
\t}
'''
create_anchor = '\td, err := s.CreateDeparture'
if "UPDATE departures SET status='cancelled' WHERE id=$1" not in text:
    if create_anchor not in text:
        raise SystemExit('safety fixture departure creation anchor not found')
    text = text.replace(create_anchor, cancel_block + create_anchor, 1)

integration.write_text(text)
Path(__file__).unlink()
