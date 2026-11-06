package store

import (
	"context"
	"errors"
)

const (
	AuthIPScope        = "auth_ip"
	LoginAccountScope  = "login_account"
	AccountMailScope   = "account_mail"
	AccountReauthScope = "account_reauth"
	AuthCleanupBatch   = 64
)

type AuthAttempt struct {
	Allowed    bool
	RetryAfter int
}

// ConsumeAuthAttempt commits one attempt even when it is denied. Its upsert is
// atomic across API instances; the database clock defines the one-minute window.
// At most AuthCleanupBatch expired identities are removed after each upsert.
// Expiry is enforced regardless of cleanup, which is lazy when traffic is idle.
func (s *Store) ConsumeAuthAttempt(ctx context.Context, scope string, key [32]byte) (AuthAttempt, error) {
	limit := 0
	windowSeconds := 60
	switch scope {
	case AuthIPScope:
		limit = 20
	case LoginAccountScope:
		limit = 10
	case AccountMailScope:
		limit = 3
		windowSeconds = 15 * 60
	case AccountReauthScope:
		limit = 5
	default:
		return AuthAttempt{}, errors.New("unsupported authentication rate scope")
	}
	var result AuthAttempt
	err := s.Pool.QueryRow(ctx, `INSERT INTO auth_rate_limits(scope,key_hash,window_started_at,expires_at,attempts)
VALUES($1,$2,statement_timestamp(),statement_timestamp()+$4*interval '1 second',1)
ON CONFLICT(scope,key_hash) DO UPDATE SET
    attempts=CASE WHEN auth_rate_limits.expires_at <= statement_timestamp()
        THEN 1 ELSE LEAST(auth_rate_limits.attempts+1,$3+1) END,
    window_started_at=CASE WHEN auth_rate_limits.expires_at <= statement_timestamp()
        THEN statement_timestamp() ELSE auth_rate_limits.window_started_at END,
    expires_at=CASE WHEN auth_rate_limits.expires_at <= statement_timestamp()
        THEN statement_timestamp()+$4*interval '1 second' ELSE auth_rate_limits.expires_at END
RETURNING attempts <= $3,
    GREATEST(1,CEIL(EXTRACT(EPOCH FROM expires_at-statement_timestamp())))::integer
`, scope, key[:], limit, windowSeconds).Scan(&result.Allowed, &result.RetryAfter)
	if err != nil {
		return AuthAttempt{}, err
	}
	// A separate autocommit statement avoids a lock-order cycle between cleanup
	// of other identities and the current upsert. Never roll back a denied count.
	_, err = s.Pool.Exec(ctx, `WITH stale AS (
    SELECT scope,key_hash FROM auth_rate_limits
    WHERE expires_at <= statement_timestamp()
    ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
)
DELETE FROM auth_rate_limits AS r USING stale
WHERE r.scope=stale.scope AND r.key_hash=stale.key_hash`, AuthCleanupBatch)
	return result, err
}
