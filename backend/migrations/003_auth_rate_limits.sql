BEGIN;

-- Shared between API processes. Only HMAC-SHA256 identities are stored: never
-- plaintext IP addresses, account identifiers or passwords.
CREATE TABLE auth_rate_limits (
    scope text NOT NULL CHECK (scope IN ('auth_ip', 'login_account')),
    key_hash bytea NOT NULL CHECK (octet_length(key_hash) = 32),
    window_started_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 21),
    PRIMARY KEY (scope, key_hash),
    CHECK (expires_at > window_started_at)
);
CREATE INDEX auth_rate_limits_expiry_idx ON auth_rate_limits (expires_at);

INSERT INTO schema_migrations(version) VALUES (3);
COMMIT;
