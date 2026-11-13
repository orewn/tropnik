BEGIN;

-- No recipient, action secret, message body or SMTP diagnostic is stored in
-- plaintext. The independently managed application key is never in this DB.
CREATE TABLE account_mail_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 purpose text NOT NULL CHECK(purpose IN ('verify_email','reset_password','password_changed')),
 user_id uuid REFERENCES users(id),
 recipient_key bytea CHECK(recipient_key IS NULL OR octet_length(recipient_key)=32),
 key_id text NOT NULL CHECK(key_id ~ '^[0-9a-f]{64}$'),
 payload_cipher bytea CHECK(payload_cipher IS NULL OR octet_length(payload_cipher) BETWEEN 17 AND 65552),
 payload_nonce bytea CHECK(payload_nonce IS NULL OR octet_length(payload_nonce)=12),
 token_hash bytea REFERENCES account_action_tokens(token_hash),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','accepted','cancelled','failed','expired')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 9),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_id uuid,
 lease_until timestamptz,
 finished_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
 CHECK(purpose<>'reset_password' OR expires_at<=created_at+interval '30 minutes'),
 CHECK((state='leased')=(lease_id IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state='leased' OR (lease_id IS NULL AND lease_until IS NULL)),
 CHECK((state IN ('pending','leased') AND recipient_key IS NOT NULL AND payload_cipher IS NOT NULL AND payload_nonce IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('accepted','cancelled','failed','expired') AND recipient_key IS NULL AND payload_cipher IS NULL AND payload_nonce IS NULL AND finished_at IS NOT NULL)),
 CHECK(token_hash IS NULL OR (user_id IS NOT NULL AND purpose<>'password_changed'))
);
CREATE INDEX account_mail_due ON account_mail_outbox(next_attempt_at,created_at,id) WHERE state IN ('pending','leased');
CREATE INDEX account_mail_recipient ON account_mail_outbox(recipient_key,purpose) WHERE state IN ('pending','leased');
CREATE INDEX account_mail_account ON account_mail_outbox(user_id) WHERE state IN ('pending','leased');
CREATE INDEX account_mail_retention ON account_mail_outbox(finished_at) WHERE finished_at IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES(7);
COMMIT;
