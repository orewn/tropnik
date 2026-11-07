#!/usr/bin/env python3
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
integration = root / 'backend/internal/store/safety_integration_test.go'
text = integration.read_text()
if '\t"errors"\n' not in text:
    anchor = 'import (\n\t"bytes"\n\t"context"\n'
    replacement = 'import (\n\t"bytes"\n\t"context"\n\t"errors"\n'
    if anchor not in text: raise SystemExit('safety integration import anchor not found')
    text = text.replace(anchor, replacement, 1)
fixed='"safety-contact-key-0001"'; unique='"safety-contact-"+d.ID'
if fixed in text: text=text.replace(fixed,unique,1)
elif unique not in text: raise SystemExit('safety contact idempotency anchor not found')
if "UPDATE departures SET status='cancelled' WHERE id=$1" not in text:
    match=re.search(r'(?m)^(?P<indent>[ \t]*)d\s*,\s*err\s*:=\s*s\.CreateDeparture',text)
    if not match: raise SystemExit('safety fixture departure creation anchor not found')
    indent=match.group('indent')
    block=(f'{indent}if _, err = s.Pool.Exec(ctx, "UPDATE departures SET status=\'cancelled\' WHERE id=$1", base.ID); err != nil {{\n'
           f'{indent}\tt.Fatal(err)\n{indent}}}\n')
    text=text[:match.start()]+block+text[match.start():]
integration.write_text(text)

safety_path=root/'backend/internal/store/safety.go'; safety=safety_path.read_text()
old='created := time.Now().UTC()'; new='created := time.Now().UTC().Truncate(time.Microsecond)'
if old in safety: safety=safety.replace(old,new,1)
elif new not in safety: raise SystemExit('creation timestamp anchor not found')
old='created.UTC().Format(time.RFC3339Nano)'; new='created.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)'
if old in safety: safety=safety.replace(old,new,1)
elif new not in safety: raise SystemExit('verification timestamp anchor not found')
safety_path.write_text(safety)

panel=root/'web/components/SafetyPanel.tsx'
print('--- SafetyPanel.tsx ---')
print(panel.read_text())
raise SystemExit('diagnostic complete')
