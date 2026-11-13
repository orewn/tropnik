package store

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"tropa/backend/internal/domain"
)

const (
	VerifyEmailAction   = "verify_email"
	ResetPasswordAction = "reset_password"
)

var (
	ErrAccountAction = errors.New("account action expired or invalid")
	ErrActiveAccount = errors.New("account has active commitments")
)

type AccountActionRecipient struct {
	ID    string
	Email string
}

// IssueAccountAction serializes replacement with consumption and deletion. The
// only token supplied to persistence is a SHA-256 digest of a 256-bit secret.
func (s *Store) IssueAccountAction(ctx context.Context, email, purpose string, digest [32]byte) (AccountActionRecipient, error) {
	var out AccountActionRecipient
	ttl := 0
	switch purpose {
	case VerifyEmailAction:
		ttl = 24 * 60 * 60
	case ResetPasswordAction:
		ttl = 30 * 60
	default:
		return out, domain.ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	var verified bool
	err = tx.QueryRow(ctx, `SELECT id::text,email,email_verified FROM users
WHERE email=$1 AND NOT disabled AND deleted_at IS NULL AND NOT is_admin AND NOT is_moderator FOR UPDATE`, email).Scan(&out.ID, &out.Email, &verified)
	if err != nil {
		return out, dbErr(err)
	}
	if purpose == VerifyEmailAction && verified {
		return out, domain.ErrNotFound
	}
	if _, err = tx.Exec(ctx, `UPDATE account_action_tokens SET revoked_at=clock_timestamp()
WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL AND revoked_at IS NULL`, out.ID, purpose); err != nil {
		return out, err
	}
	if err = s.cancelAccountMailTx(ctx, tx, out.ID, out.Email, []string{purpose}, ""); err != nil {
		return out, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO account_action_tokens(token_hash,user_id,purpose,created_at,expires_at)
VALUES($1,$2,$3,statement_timestamp(),statement_timestamp()+$4*interval '1 second')`, digest[:], out.ID, purpose, ttl)
	if err != nil {
		return out, dbErr(err)
	}
	return out, tx.Commit(ctx)
}

func (s *Store) RevokeAccountAction(ctx context.Context, digest [32]byte) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil { return err }
	defer tx.Rollback(ctx)
	var user string
	err = tx.QueryRow(ctx, "SELECT user_id::text FROM account_action_tokens WHERE token_hash=$1", digest[:]).Scan(&user)
	if errors.Is(err, pgx.ErrNoRows) { return nil }
	if err != nil { return err }
	if err = tx.QueryRow(ctx, "SELECT id::text FROM users WHERE id=$1 FOR UPDATE",user).Scan(&user); err != nil { return err }
	if _, err = tx.Exec(ctx, `UPDATE account_action_tokens SET revoked_at=clock_timestamp()
WHERE token_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL`, digest[:]); err != nil { return err }
	if _, err = tx.Exec(ctx, `UPDATE account_mail_outbox SET state='cancelled',recipient_key=NULL,payload_cipher=NULL,payload_nonce=NULL,
lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE token_hash=$1 AND state IN ('pending','leased')`,digest[:]); err != nil { return err }
	return tx.Commit(ctx)
}

// Always lock the user before mutating tokens, matching issue, reset and delete.
func consumeAccountAction(ctx context.Context, tx pgx.Tx, digest [32]byte, purpose string) (AccountActionRecipient, error) {
	var out AccountActionRecipient
	err := tx.QueryRow(ctx, "SELECT user_id::text FROM account_action_tokens WHERE token_hash=$1 AND purpose=$2", digest[:], purpose).Scan(&out.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrAccountAction
	}
	if err != nil {
		return out, err
	}
	err = tx.QueryRow(ctx, `SELECT email FROM users WHERE id=$1 AND NOT disabled AND deleted_at IS NULL
AND NOT is_admin AND NOT is_moderator FOR UPDATE`, out.ID).Scan(&out.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrAccountAction
	}
	if err != nil {
		return out, err
	}
	result, err := tx.Exec(ctx, `UPDATE account_action_tokens SET consumed_at=clock_timestamp()
WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`, digest[:], purpose)
	if err != nil {
		return out, err
	}
	if result.RowsAffected() != 1 {
		return out, ErrAccountAction
	}
	return out, nil
}

func (s *Store) VerifyAccountEmail(ctx context.Context, digest [32]byte) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	user, err := consumeAccountAction(ctx, tx, digest, VerifyEmailAction)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE users SET email_verified=true WHERE id=$1", user.ID); err != nil {
		return err
	}
	if err = s.cancelAccountMailTx(ctx,tx,user.ID,user.Email,[]string{VerifyEmailAction},""); err != nil { return err }
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,action,entity_id) VALUES($1,'account.email_verified',$1)", user.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ResetAccountPassword(ctx context.Context, digest [32]byte, passwordHash string) (AccountActionRecipient, error) {
	return s.resetAccountPassword(ctx,digest,passwordHash,false)
}

func (s *Store) ResetAccountPasswordWithMail(ctx context.Context, digest [32]byte, passwordHash string) (AccountActionRecipient, error) {
	if s.mailCipher == nil { return AccountActionRecipient{},ErrAccountMailUnavailable }
	return s.resetAccountPassword(ctx,digest,passwordHash,true)
}

func (s *Store) resetAccountPassword(ctx context.Context, digest [32]byte, passwordHash string, notify bool) (AccountActionRecipient, error) {
	var out AccountActionRecipient
	if len(passwordHash) < 32 || len(passwordHash) > 1024 {
		return out, domain.ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if notify {
		if err = lockAccountMailQueue(ctx,tx); err != nil { return out,err }
	}
	out, err = consumeAccountAction(ctx, tx, digest, ResetPasswordAction)
	if err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, "UPDATE users SET password_hash=$2 WHERE id=$1", out.ID, passwordHash); err != nil {
		return out, err
	}
	if err = s.revokeAccountAccess(ctx, tx, out.ID); err != nil {
		return out, err
	}
	if notify {
		if err = s.enqueueAccountMailTx(ctx,tx,out.Email,out.ID,"password_changed",false); err != nil { return out,err }
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,action,entity_id) VALUES($1,'account.password_reset',$1)", out.ID); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) revokeAccountAccess(ctx context.Context, tx pgx.Tx, user string) error {
	if _, err := tx.Exec(ctx, "UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL", user); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE account_action_tokens SET revoked_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL", user); err != nil { return err }
	var email string
	if err := tx.QueryRow(ctx,"SELECT email FROM users WHERE id=$1",user).Scan(&email); err != nil { return err }
	return s.cancelAccountMailTx(ctx,tx,user,email,[]string{VerifyEmailAction,ResetPasswordAction},"")
}

// This closes the login-vs-reset race: a password verified before a concurrent
// reset cannot be used to create a session after all old sessions were revoked.
func (s *Store) CreateSessionWithCredentials(ctx context.Context, user, token string, expiry time.Time, expectedPasswordHash string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current string
	err = tx.QueryRow(ctx, "SELECT password_hash FROM users WHERE id=$1 AND NOT disabled AND deleted_at IS NULL FOR SHARE", user).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if expectedPasswordHash == "" || subtle.ConstantTimeCompare([]byte(current), []byte(expectedPasswordHash)) != 1 {
		return domain.ErrUnauthorized
	}
	digest := sha256.Sum256([]byte(token))
	if _, err = tx.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", digest[:], user, expiry); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) DeleteAccount(ctx context.Context, user, expectedPasswordHash string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current string
	var staff bool
	err = tx.QueryRow(ctx, "SELECT password_hash,is_admin OR is_moderator FROM users WHERE id=$1 AND NOT disabled AND deleted_at IS NULL FOR UPDATE", user).Scan(&current, &staff)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if staff {
		return domain.ErrForbidden
	}
	if expectedPasswordHash == "" || subtle.ConstantTimeCompare([]byte(current), []byte(expectedPasswordHash)) != 1 {
		return domain.ErrUnauthorized
	}
	var active bool
	err = tx.QueryRow(ctx, `SELECT
EXISTS(SELECT 1 FROM memberships m JOIN departures d ON d.id=m.departure_id
 WHERE m.user_id=$1 AND m.status IN ('confirmed','checked_in','completed') AND d.status IN ('recruiting','ready','awaiting_guide','in_progress'))
OR EXISTS(SELECT 1 FROM departures WHERE (guide_id=$1 OR created_by=$1) AND status IN ('recruiting','ready','awaiting_guide','in_progress'))
OR EXISTS(SELECT 1 FROM recruitment_requests WHERE created_by=$1 AND status='open')`, user).Scan(&active)
	if err != nil {
		return err
	}
	if active {
		return ErrActiveAccount
	}
	if err = s.revokeAccountAccess(ctx, tx, user); err != nil {
		return err
	}
	var email string
	if err = tx.QueryRow(ctx,"SELECT email FROM users WHERE id=$1",user).Scan(&email); err != nil { return err }
	if err = s.cancelAccountMailTx(ctx,tx,user,email,[]string{"password_changed"},""); err != nil { return err }
	// Interest does not reserve a place. Withdraw it while holding the user lock;
	// keep actual participation, requests and messages as anonymised history.
	if _, err = tx.Exec(ctx, "DELETE FROM recruitment_members WHERE user_id=$1", user); err != nil {
		return err
	}
	// Idempotent join responses contain a guide-name snapshot. Keep their
	// operation/result identity, but do not return the former public name on a
	// later replay after this account was anonymised.
	_, err = tx.Exec(ctx, `UPDATE idempotency_keys SET response=jsonb_set(response,'{guideName}',to_jsonb('Удалённый аккаунт'::text),false)
WHERE response->>'guideId'=$1::text AND response ? 'guideName'`, user)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE users SET email='deleted-'||id::text||'@account.invalid',
 display_name='Удалённый аккаунт',password_hash='!deleted',email_verified=false,
 role='tourist',guide_status='none',disabled=true,deleted_at=clock_timestamp() WHERE id=$1`, user)
	if err != nil {
		return dbErr(err)
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,action,entity_id) VALUES($1,'account.deleted',$1)", user); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RecordAccountMail(ctx context.Context, user, purpose string, accepted bool) error {
	// Only an action name and opaque account id reach the audit. SMTP acceptance
	// is not proof that a message reached the mailbox or was read.
	action := "account.mail_failed"
	if accepted {
		action = "account.mail_accepted"
	}
	_, err := s.Pool.Exec(ctx, "INSERT INTO audit_events(actor_id,action,entity_id,details) VALUES($1,$2,$1,jsonb_build_object('purpose',$3::text))", user, action, purpose)
	return err
}
