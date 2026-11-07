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
if fixed not in text:
    raise SystemExit('safety contact idempotency anchor not found')
text = text.replace(fixed, unique, 1)
integration.write_text(text)

store = root / 'backend/internal/store/safety.go'
text = store.read_text()
old = '''\tif _, err = tx.Exec(ctx, "INSERT INTO idempotency_keys(user_id,key,operation,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", actor, key, operation, digest[:]); err != nil {\n\t\treturn nil, err\n\t}\n\tvar storedOperation string\n\tvar storedHash, response []byte\n\tif err = tx.QueryRow(ctx, "SELECT operation,request_hash,response FROM idempotency_keys WHERE user_id=$1 AND key=$2 FOR UPDATE", actor, key).Scan(&storedOperation, &storedHash, &response); err != nil {\n\t\treturn nil, err\n\t}\n'''
new = '''\tvar storedOperation string\n\tvar storedHash, response []byte\n\terr = tx.QueryRow(ctx, `\n\t\tINSERT INTO idempotency_keys(user_id,key,operation,request_hash)\n\t\tVALUES($1,$2,$3,$4)\n\t\tON CONFLICT (user_id,key) DO UPDATE SET key=EXCLUDED.key\n\t\tRETURNING operation,request_hash,response`,\n\t\tactor, key, operation, digest[:]).Scan(&storedOperation, &storedHash, &response)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n'''
if old not in text:
    raise SystemExit('beginSafetyMutation idempotency anchor not found')
store.write_text(text.replace(old, new, 1))

Path(__file__).unlink()
