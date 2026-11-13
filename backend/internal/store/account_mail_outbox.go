package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"tropa/backend/internal/auth"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/policy"
)

const AccountMailQueueLimit = policy.AccountMailQueueLimit

var ErrAccountMailUnavailable = errors.New("account mail key or durable queue unavailable")
var ErrAccountMailQueueFull = errors.New("account mail queue is full")

// A lease is an opaque fencing token, not an account action secret.
type AccountMailLease struct{ ID, LeaseID string }

type accountMailRow struct {
	ID, Purpose, KeyID       string
	UserID                   *string
	Cipher, Nonce, TokenHash []byte
	Expires                  time.Time
	Attempts                 int
	Expired                  bool
}

type accountMailEnvelope struct {
	Recipient string            `json:"recipient"`
	Token     string            `json:"token,omitempty"`
	Message   *auth.AccountMail `json:"message,omitempty"`
}

func loadAccountMailCipher() (*auth.AccountMailCipher, error) {
	raw := os.Getenv("TROPA_ACCOUNT_MAIL_KEY")
	if raw == "" {
		return nil, nil
	}
	key, err := auth.ParseServerKey(raw)
	if err != nil {
		return nil, ErrAccountMailUnavailable
	}
	return auth.NewAccountMailCipher(key)
}

// ConfigureAccountMail runs before workers start. A lost or replaced key must
// stop startup, never turn an existing encrypted backlog into discarded work.
// A key without SMTP configuration is useful for account-closure cancellation.
func (s *Store) ConfigureAccountMail(ctx context.Context, key []byte) error {
	if len(key) != 0 {
		cipher, err := auth.NewAccountMailCipher(key)
		if err != nil {
			return ErrAccountMailUnavailable
		}
		if s.mailCipher != nil && s.mailCipher.KeyID() != cipher.KeyID() {
			return ErrAccountMailUnavailable
		}
		if s.mailCipher == nil {
			s.mailCipher = cipher
		}
	}
	keyID := ""
	if s.mailCipher != nil {
		keyID = s.mailCipher.KeyID()
	}
	var incompatible bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM account_mail_outbox
WHERE state IN ('pending','leased') AND key_id<>$1)`, keyID).Scan(&incompatible)
	if err != nil {
		return err
	}
	if incompatible {
		return ErrAccountMailUnavailable
	}
	return nil
}

func lockAccountMailQueue(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(policy.AccountMailQueueLock))
	return err
}

func (s *Store) enqueueAccountMailTx(ctx context.Context, tx pgx.Tx, email, user, purpose string, coalesce bool) error {
	if s.mailCipher == nil {
		return ErrAccountMailUnavailable
	}
	ttl := 24 * 60 * 60
	if purpose == ResetPasswordAction {
		ttl = 30 * 60
	} else if purpose != VerifyEmailAction && purpose != "password_changed" {
		return domain.ErrInvalid
	}
	recipientKey := s.mailCipher.RecipientKey(email)
	// Repeated requests while a message is pending reuse its job and token. This
	// also prevents parallel retries from repeatedly invalidating delivered links.
	if coalesce {
		var existing string
		err := tx.QueryRow(ctx, `SELECT id::text FROM account_mail_outbox
WHERE recipient_key=$1 AND purpose=$2 AND state IN ('pending','leased') AND expires_at>clock_timestamp()
ORDER BY created_at,id LIMIT 1 FOR UPDATE`, recipientKey[:], purpose).Scan(&existing)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	var count int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM account_mail_outbox WHERE state IN ('pending','leased')").Scan(&count); err != nil {
		return err
	}
	if count >= AccountMailQueueLimit {
		return ErrAccountMailQueueFull
	}
	var id string
	var created, expires time.Time
	err := tx.QueryRow(ctx, `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS t)
SELECT gen_random_uuid()::text,t,t+$1*interval '1 second' FROM clock`, ttl).Scan(&id, &created, &expires)
	if err != nil {
		return err
	}
	plain, err := json.Marshal(accountMailEnvelope{Recipient: email})
	if err != nil {
		return err
	}
	ciphertext, nonce, err := s.mailCipher.Seal(id, purpose, expires, plain)
	if err != nil {
		return ErrAccountMailUnavailable
	}
	var userID *string
	if user != "" {
		userID = &user
	}
	_, err = tx.Exec(ctx, `INSERT INTO account_mail_outbox
(id,purpose,user_id,recipient_key,key_id,payload_cipher,payload_nonce,created_at,expires_at,next_attempt_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)`, id, purpose, userID, recipientKey[:], s.mailCipher.KeyID(), ciphertext, nonce, created, expires)
	return err
}

func (s *Store) QueueAccountMail(ctx context.Context, email, purpose string) error {
	if s.mailCipher == nil {
		return ErrAccountMailUnavailable
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockAccountMailQueue(ctx, tx); err != nil {
		return err
	}
	if err = s.enqueueAccountMailTx(ctx, tx, email, "", purpose, true); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RegisterWithAccountMail(ctx context.Context, email, hash, name, role string) (domain.User, error) {
	if s.mailCipher == nil {
		return domain.User{}, ErrAccountMailUnavailable
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return domain.User{}, err
	}
	defer tx.Rollback(ctx)
	if err = lockAccountMailQueue(ctx, tx); err != nil {
		return domain.User{}, err
	}
	status := "none"
	if role == "guide" {
		status = "pending"
	}
	u, err := scanUser(tx.QueryRow(ctx, `INSERT INTO users(email,password_hash,display_name,role,guide_status)
VALUES($1,$2,$3,$4,$5) RETURNING `+userColumns, email, hash, name, role, status))
	if err != nil {
		return u, err
	}
	// An earlier anonymous request must not race registration into discarding its
	// only verification intent. Replace it inside the registration transaction.
	if err = s.cancelAccountMailTx(ctx, tx, u.ID, email, []string{VerifyEmailAction}, ""); err != nil {
		return u, err
	}
	if err = s.enqueueAccountMailTx(ctx, tx, email, u.ID, VerifyEmailAction, false); err != nil {
		return u, err
	}
	return u, tx.Commit(ctx)
}

func (s *Store) ClaimAccountMail(ctx context.Context) (AccountMailLease, error) {
	var lease AccountMailLease
	if s.mailCipher == nil {
		return lease, ErrAccountMailUnavailable
	}
	// Claiming never locks an account. Preparation and acknowledgement acquire
	// the account before the job, matching reset/delete and avoiding lock cycles.
	err := s.Pool.QueryRow(ctx, `WITH candidate AS (
 SELECT id FROM account_mail_outbox
 WHERE (state='pending' AND next_attempt_at<=clock_timestamp())
    OR (state='leased' AND lease_until<=clock_timestamp())
 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
)
UPDATE account_mail_outbox j SET state='leased',lease_id=gen_random_uuid(),
lease_until=clock_timestamp()+$1*interval '1 second',attempts=LEAST(j.attempts+1,$2)
FROM candidate c WHERE j.id=c.id RETURNING j.id::text,j.lease_id::text`, policy.AccountMailLease.Seconds(), policy.AccountMailMaxAttempts+1).Scan(&lease.ID, &lease.LeaseID)
	return lease, dbErr(err)
}

func accountMailRowForLease(ctx context.Context, q querier, lease AccountMailLease, lock bool) (accountMailRow, error) {
	var row accountMailRow
	query := `SELECT id::text,purpose,user_id::text,key_id,payload_cipher,payload_nonce,token_hash,
expires_at,attempts,expires_at<=clock_timestamp() FROM account_mail_outbox
WHERE id=$1 AND state='leased' AND lease_id=$2 AND lease_until>clock_timestamp()`
	if lock {
		query += " FOR UPDATE"
	}
	err := q.QueryRow(ctx, query, lease.ID, lease.LeaseID).Scan(&row.ID, &row.Purpose, &row.UserID, &row.KeyID, &row.Cipher, &row.Nonce, &row.TokenHash, &row.Expires, &row.Attempts, &row.Expired)
	return row, dbErr(err)
}

func (s *Store) openAccountMail(row accountMailRow) (accountMailEnvelope, error) {
	var envelope accountMailEnvelope
	if s.mailCipher == nil || row.KeyID != s.mailCipher.KeyID() {
		return envelope, ErrAccountMailUnavailable
	}
	plain, err := s.mailCipher.Open(row.ID, row.Purpose, row.Expires, row.Cipher, row.Nonce)
	if err != nil {
		return envelope, ErrAccountMailUnavailable
	}
	if err = json.Unmarshal(plain, &envelope); err != nil || envelope.Recipient == "" {
		return envelope, ErrAccountMailUnavailable
	}
	return envelope, nil
}

func accountMailMessage(id, purpose, email, token, actionURL string) (auth.AccountMail, error) {
	messageID, err := auth.AccountMailMessageID(id, actionURL)
	if err != nil {
		return auth.AccountMail{}, err
	}
	message := auth.AccountMail{To: email, MessageID: messageID}
	if purpose == "password_changed" {
		message.Subject = "Пароль Tropnik изменён"
		message.Text = "Пароль вашего аккаунта Tropnik изменён. Все прежние сессии и ссылки восстановления отозваны. Войдите заново с новым паролем. Если это были не вы, откройте Tropnik самостоятельно и запросите восстановление доступа."
		return message, nil
	}
	link, err := auth.AccountActionURL(actionURL, purpose, token)
	if err != nil {
		return message, err
	}
	message.Subject = "Подтвердите почту Tropnik"
	message.Text = "Подтвердите адрес электронной почты для аккаунта Tropnik. Ссылка действует не более 24 часов с момента запроса и только один раз:\n\n" + link + "\n\nЕсли вы не создавали аккаунт, не переходите по ссылке. Для дальнейших действий потребуется пароль аккаунта."
	if purpose == ResetPasswordAction {
		message.Subject = "Восстановление доступа к Tropnik"
		message.Text = "Для установки нового пароля Tropnik откройте ссылку. Она действует не более 30 минут с момента запроса и только один раз:\n\n" + link + "\n\nЕсли вы не запрашивали восстановление, ничего не меняйте. Ваш текущий пароль продолжает действовать."
	}
	return message, nil
}

// Prepare persists one encrypted message and its digest atomically, before any
// SMTP I/O. Every retry, including an ambiguous DATA acknowledgement, reads the
// same token, body and Message-ID. SMTP itself never holds a DB transaction.
func (s *Store) PrepareAccountMail(ctx context.Context, lease AccountMailLease, actionURL string) (auth.AccountMail, error) {
	var none auth.AccountMail
	initial, err := accountMailRowForLease(ctx, s.Pool, lease, false)
	if err != nil {
		return none, err
	}
	if s.mailCipher == nil || initial.KeyID != s.mailCipher.KeyID() {
		return none, ErrAccountMailUnavailable
	}
	// Expiry and exhausted leases are authoritative DB state. Retire them under
	// the same account/job locks even if ciphertext was damaged; decryption must
	// not make a corrupt expired row occupy bounded capacity forever.
	if initial.Expired || initial.Attempts > policy.AccountMailMaxAttempts {
		if err = s.FinishAccountMail(ctx, lease, false); err != nil {
			return none, err
		}
		return none, domain.ErrNotFound
	}
	envelope, err := s.openAccountMail(initial)
	if err != nil {
		return none, err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return none, err
	}
	defer tx.Rollback(ctx)
	var user AccountActionRecipient
	var verified, disabled, deleted, staff bool
	query := "SELECT id::text,email,email_verified,disabled,deleted_at IS NOT NULL,is_admin OR is_moderator FROM users WHERE email=$1 FOR UPDATE"
	identity := envelope.Recipient
	if initial.UserID != nil {
		query = "SELECT id::text,email,email_verified,disabled,deleted_at IS NOT NULL,is_admin OR is_moderator FROM users WHERE id=$1 FOR UPDATE"
		identity = *initial.UserID
	}
	err = tx.QueryRow(ctx, query, identity).Scan(&user.ID, &user.Email, &verified, &disabled, &deleted, &staff)
	missing := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !missing {
		return none, err
	}
	row, err := accountMailRowForLease(ctx, tx, lease, true)
	if err != nil {
		return none, err
	}
	// Changes to the envelope are never allowed to cross a lease boundary.
	if !bytes.Equal(row.Cipher, initial.Cipher) || !bytes.Equal(row.Nonce, initial.Nonce) {
		return none, domain.ErrConflict
	}
	terminal := ""
	if row.Expired {
		terminal = "expired"
	} else if row.Attempts > policy.AccountMailMaxAttempts {
		terminal = "failed"
	} else if missing || disabled || deleted || staff || user.Email != envelope.Recipient || (row.Purpose == VerifyEmailAction && verified) {
		terminal = "cancelled"
	}
	if terminal != "" {
		if err = finishAccountMailTx(ctx, tx, row, terminal); err != nil {
			return none, err
		}
		if err = tx.Commit(ctx); err != nil {
			return none, err
		}
		return none, domain.ErrNotFound
	}
	if envelope.Message == nil {
		var token string
		var digest [32]byte
		if row.Purpose != "password_changed" {
			token, digest, err = auth.AccountActionToken()
			if err != nil {
				return none, err
			}
			if _, err = tx.Exec(ctx, `UPDATE account_action_tokens SET revoked_at=clock_timestamp()
WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL AND revoked_at IS NULL`, user.ID, row.Purpose); err != nil {
				return none, err
			}
			if err = s.cancelAccountMailTx(ctx, tx, user.ID, user.Email, []string{row.Purpose}, row.ID); err != nil {
				return none, err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO account_action_tokens(token_hash,user_id,purpose,created_at,expires_at)
VALUES($1,$2,$3,clock_timestamp(),$4)`, digest[:], user.ID, row.Purpose, row.Expires); err != nil {
				return none, err
			}
			row.TokenHash = digest[:]
		}
		message, buildErr := accountMailMessage(row.ID, row.Purpose, user.Email, token, actionURL)
		if buildErr != nil {
			return none, ErrAccountMailUnavailable
		}
		envelope.Token = token
		envelope.Message = &message
		plain, marshalErr := json.Marshal(envelope)
		if marshalErr != nil {
			return none, marshalErr
		}
		ciphertext, nonce, sealErr := s.mailCipher.Seal(row.ID, row.Purpose, row.Expires, plain)
		if sealErr != nil {
			return none, ErrAccountMailUnavailable
		}
		_, err = tx.Exec(ctx, `UPDATE account_mail_outbox SET user_id=$2,token_hash=$3,payload_cipher=$4,payload_nonce=$5 WHERE id=$1`, row.ID, user.ID, row.TokenHash, ciphertext, nonce)
		if err != nil {
			return none, err
		}
	}
	if row.Purpose != "password_changed" {
		digest, digestErr := auth.AccountActionDigest(envelope.Token)
		if digestErr != nil || !bytes.Equal(digest[:], row.TokenHash) {
			return none, ErrAccountMailUnavailable
		}
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM account_action_tokens WHERE token_hash=$1 AND user_id=$2 AND purpose=$3
AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp())`, row.TokenHash, user.ID, row.Purpose).Scan(&valid); err != nil {
			return none, err
		}
		if !valid {
			if err = finishAccountMailTx(ctx, tx, row, "cancelled"); err != nil {
				return none, err
			}
			if err = tx.Commit(ctx); err != nil {
				return none, err
			}
			return none, domain.ErrNotFound
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return none, err
	}
	return *envelope.Message, nil
}

func finishAccountMailTx(ctx context.Context, tx pgx.Tx, row accountMailRow, state string) error {
	if state != "accepted" && len(row.TokenHash) != 0 {
		if _, err := tx.Exec(ctx, `UPDATE account_action_tokens SET revoked_at=clock_timestamp()
WHERE token_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL`, row.TokenHash); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `UPDATE account_mail_outbox SET state=$2,recipient_key=NULL,payload_cipher=NULL,payload_nonce=NULL,
lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=$1`, row.ID, state)
	if err != nil {
		return err
	}
	if row.UserID != nil {
		action := "account.mail_" + state
		_, err = tx.Exec(ctx, `INSERT INTO audit_events(actor_id,action,entity_id,details)
VALUES($1,$2,$1,jsonb_build_object('purpose',$3::text,'jobId',$4::text))`, *row.UserID, action, row.Purpose, row.ID)
	}
	return err
}

// Finish uses the still-current lease, so a delayed worker cannot acknowledge,
// reschedule, or revoke the token owned by a subsequent attempt.
func (s *Store) FinishAccountMail(ctx context.Context, lease AccountMailLease, accepted bool) error {
	initial, err := accountMailRowForLease(ctx, s.Pool, lease, false)
	if errors.Is(err, domain.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if initial.UserID != nil {
		var ignored string
		if err = tx.QueryRow(ctx, "SELECT id::text FROM users WHERE id=$1 FOR UPDATE", *initial.UserID).Scan(&ignored); err != nil {
			return err
		}
	}
	row, err := accountMailRowForLease(ctx, tx, lease, true)
	if errors.Is(err, domain.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if accepted || row.Expired || row.Attempts >= policy.AccountMailMaxAttempts {
		state := "accepted"
		if !accepted {
			state = "failed"
			if row.Expired {
				state = "expired"
			}
		}
		if err = finishAccountMailTx(ctx, tx, row, state); err != nil {
			return err
		}
	} else {
		delay := policy.AccountMailRetryBase << (row.Attempts - 1)
		if delay > policy.AccountMailRetryMaximum {
			delay = policy.AccountMailRetryMaximum
		}
		_, err = tx.Exec(ctx, `UPDATE account_mail_outbox SET state='pending',lease_id=NULL,lease_until=NULL,
next_attempt_at=clock_timestamp()+$2*interval '1 second' WHERE id=$1`, row.ID, delay.Seconds())
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Callers hold the user lock before cancelling its work. Anonymous intents are
// matched using the keyed recipient digest; neither the email nor the bearer
// secret needs to be disclosed to SQL or persisted unencrypted in the queue.
func (s *Store) cancelAccountMailTx(ctx context.Context, tx pgx.Tx, user, email string, purposes []string, except string) error {
	var recipientKey []byte
	if s.mailCipher != nil {
		key := s.mailCipher.RecipientKey(email)
		recipientKey = key[:]
	}
	_, err := tx.Exec(ctx, `UPDATE account_mail_outbox SET state='cancelled',recipient_key=NULL,payload_cipher=NULL,payload_nonce=NULL,
lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp()
WHERE state IN ('pending','leased') AND (user_id=$1 OR recipient_key=$2) AND purpose=ANY($3::text[])
AND ($4='' OR id::text<>$4)`, user, recipientKey, purposes, except)
	return err
}

// AccountMailPrune records committed removals. More asks the scheduler to catch
// up promptly after a full batch/time budget; it is not a queue-size estimate.
type AccountMailPrune struct {
	Deleted int64
	More    bool
}

// PruneAccountMail bounds each statement and total work, while permitting more
// than one hundred removals per minute. Concurrent pruners claim disjoint rows;
// live, fresh and still-encrypted jobs are never selected. Retention is a target
// cutoff; processing pauses or DB overload can delay physical removal.
func (s *Store) PruneAccountMail(ctx context.Context) (AccountMailPrune, error) {
	var result AccountMailPrune
	pruneCtx, cancel := context.WithTimeout(ctx, policy.AccountMailPruneBudget)
	defer cancel()
	for batch := 0; batch < policy.AccountMailPruneMaxBatches; batch++ {
		tag, err := s.Pool.Exec(pruneCtx, `WITH stale AS (
SELECT id FROM account_mail_outbox
WHERE finished_at<statement_timestamp()-$2*interval '1 second'
ORDER BY finished_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
)
DELETE FROM account_mail_outbox j USING stale WHERE j.id=stale.id`, policy.AccountMailPruneBatch, policy.AccountMailRetention.Seconds())
		if err != nil {
			result.More = true
			if result.Deleted > 0 && ctx.Err() == nil && errors.Is(pruneCtx.Err(), context.DeadlineExceeded) {
				return result, nil
			}
			return result, err
		}
		removed := tag.RowsAffected()
		result.Deleted += removed
		if removed < policy.AccountMailPruneBatch {
			return result, nil
		}
	}
	result.More = true
	return result, nil
}
