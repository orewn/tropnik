//go:build integration

package store_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"tropa/backend/internal/auth"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
	"tropa/backend/migrations"
)

func actionToken(t *testing.T, s *store.Store, email, purpose string) (string, [32]byte) {
	t.Helper()
	raw, digest, err := auth.AccountActionToken()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.IssueAccountAction(context.Background(), email, purpose, digest); err != nil {
		t.Fatal(err)
	}
	return raw, digest
}

func TestAccountActionDigestExpiryReplacementAndPurpose(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	u := account(t, s, "lifecycle-verification", "tourist")
	raw, first := actionToken(t, s, u.Email, store.VerifyEmailAction)
	var stored []byte
	var ttl float64
	if err := s.Pool.QueryRow(ctx, "SELECT token_hash,extract(epoch FROM expires_at-created_at)::double precision FROM account_action_tokens WHERE token_hash=$1", first[:]).Scan(&stored, &ttl); err != nil {
		t.Fatal(err)
	}
	if len(stored) != 32 || string(stored) == raw || ttl != 86400 {
		t.Fatal("incorrect token storage or verification lifetime", len(stored), ttl)
	}
	_, second := actionToken(t, s, u.Email, store.VerifyEmailAction)
	if err := s.VerifyAccountEmail(ctx, first); !errors.Is(err, store.ErrAccountAction) {
		t.Fatal("replaced link accepted", err)
	}
	_, reset := actionToken(t, s, u.Email, store.ResetPasswordAction)
	if err := s.VerifyAccountEmail(ctx, reset); !errors.Is(err, store.ErrAccountAction) {
		t.Fatal("wrong-purpose token accepted", err)
	}
	if err := s.VerifyAccountEmail(ctx, second); err != nil {
		t.Fatal(err)
	}
	if err := s.VerifyAccountEmail(ctx, second); !errors.Is(err, store.ErrAccountAction) {
		t.Fatal("verification replay", err)
	}
	if current, err := s.User(ctx, u.ID); err != nil || !current.EmailVerified {
		t.Fatal("verification not committed", err)
	}
	if _, err := s.Pool.Exec(ctx, "UPDATE account_action_tokens SET created_at=now()-interval '31 minutes',expires_at=now()-interval '1 minute' WHERE token_hash=$1", reset[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResetAccountPassword(ctx, reset, strings.Repeat("fixture-hash", 5)); !errors.Is(err, store.ErrAccountAction) {
		t.Fatal("expired reset accepted", err)
	}
}

func TestPasswordResetAtomicallyRevokesSessionsAndAllLinks(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	u := account(t, s, "lifecycle-reset", "tourist")
	session, _ := auth.SessionToken()
	if err := s.CreateSession(ctx, u.ID, session, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	_, verification := actionToken(t, s, u.Email, store.VerifyEmailAction)
	_, reset := actionToken(t, s, u.Email, store.ResetPasswordAction)
	newHash, err := auth.HashPassword("new private fixture password")
	if err != nil {
		t.Fatal(err)
	}
	recipient, err := s.ResetAccountPassword(ctx, reset, newHash)
	if err != nil || recipient.ID != u.ID || recipient.Email != u.Email {
		t.Fatal("reset failed", err)
	}
	if _, err = s.SessionUser(ctx, session); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatal("old session survived", err)
	}
	if err = s.VerifyAccountEmail(ctx, verification); !errors.Is(err, store.ErrAccountAction) {
		t.Fatal("old verification link survived", err)
	}
	if _, err = s.ResetAccountPassword(ctx, reset, newHash); !errors.Is(err, store.ErrAccountAction) {
		t.Fatal("reset replay", err)
	}
	_, stored, err := s.Credentials(ctx, u.Email)
	if err != nil || !auth.VerifyPassword(stored, "new private fixture password") {
		t.Fatal("new credentials not committed", err)
	}
	if err = s.CreateSessionWithCredentials(ctx, u.ID, session, time.Now().Add(time.Hour), "integration-fixture-not-a-login-hash"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatal("stale password verification created a new session", err)
	}
}

func TestAccountTokenSingleUseAcrossIndependentPools(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	u := account(t, s, "lifecycle-concurrent-token", "tourist")
	other, err := pgxpool.NewWithConfig(ctx, s.Pool.Config())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	apps := []*store.Store{s, {Pool: other}}
	_, digest := actionToken(t, s, u.Email, store.ResetPasswordAction)
	var accepted atomic.Int32
	var wg sync.WaitGroup
	errorsSeen := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := apps[i%2].ResetAccountPassword(ctx, digest, strings.Repeat("new-hash-fixture", 4))
			if err == nil {
				accepted.Add(1)
			} else if !errors.Is(err, store.ErrAccountAction) {
				errorsSeen <- err
			}
		}(i)
	}
	wg.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Error(err)
	}
	if accepted.Load() != 1 {
		t.Fatalf("single token committed %d resets", accepted.Load())
	}
	var audits int
	if err := s.Pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE actor_id=$1 AND action='account.password_reset'", u.ID).Scan(&audits); err != nil || audits != 1 {
		t.Fatal("reset/audit transaction mismatch", audits, err)
	}
}

func TestResetAndCredentialFencedLoginCannotLeaveAnOldSession(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	other, err := pgxpool.NewWithConfig(ctx, s.Pool.Config())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	loginStore := &store.Store{Pool: other}
	oldHash := strings.Repeat("old-fixture-hash", 3)
	newHash := strings.Repeat("new-fixture-hash", 3)
	for i := 0; i < 12; i++ {
		u, err := s.Register(ctx, fmt.Sprintf("race-%d@example.invalid", i), oldHash, "Race fixture", "tourist")
		if err != nil {
			t.Fatal(err)
		}
		_, digest := actionToken(t, s, u.Email, store.ResetPasswordAction)
		session, _ := auth.SessionToken()
		start := make(chan struct{})
		loginResult := make(chan error, 1)
		resetResult := make(chan error, 1)
		go func() {
			<-start
			loginResult <- loginStore.CreateSessionWithCredentials(ctx, u.ID, session, time.Now().Add(time.Hour), oldHash)
		}()
		go func() { <-start; _, err := s.ResetAccountPassword(ctx, digest, newHash); resetResult <- err }()
		close(start)
		if err := <-loginResult; err != nil && !errors.Is(err, domain.ErrUnauthorized) {
			t.Fatal(err)
		}
		if err := <-resetResult; err != nil {
			t.Fatal(err)
		}
		if _, err := s.SessionUser(ctx, session); !errors.Is(err, domain.ErrUnauthorized) {
			t.Fatal("old-password login survived a completed reset", i, err)
		}
	}
}

func TestAccountDeletionBlocksCommitmentsAndKeepsAnAnonymousHistory(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	guide, departure := fixture(t, s, 5)
	u := account(t, s, "lifecycle-delete-tourist", "tourist")
	if _, err := s.Join(ctx, u.ID, departure.ID, "lifecycle-join-key-0001", 0); err != nil {
		t.Fatal(err)
	}
	fixtureHash := "integration-fixture-not-a-login-hash"
	for _, id := range []string{u.ID, guide.ID} {
		if err := s.DeleteAccount(ctx, id, fixtureHash); !errors.Is(err, store.ErrActiveAccount) {
			t.Fatal("active trip account deleted", err)
		}
	}
	requestOwner := account(t, s, "lifecycle-request-owner", "tourist")
	if _, err := s.Pool.Exec(ctx, "INSERT INTO recruitment_requests(route_id,created_by,body) VALUES($1,$2,'A fixture request')", departure.RouteID, requestOwner.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteAccount(ctx, requestOwner.ID, fixtureHash); !errors.Is(err, store.ErrActiveAccount) {
		t.Fatal("open request orphaned", err)
	}
	if _, err := s.Pool.Exec(ctx, "UPDATE departures SET status='cancelled' WHERE id=$1", departure.ID); err != nil {
		t.Fatal(err)
	}
	session, _ := auth.SessionToken()
	if err := s.CreateSession(ctx, guide.ID, session, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	_, reset := actionToken(t, s, guide.Email, store.ResetPasswordAction)
	_, verify := actionToken(t, s, guide.Email, store.VerifyEmailAction)
	if err := s.DeleteAccount(ctx, guide.ID, "wrong observed hash"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatal("deletion ignored reauthentication", err)
	}
	if err := s.DeleteAccount(ctx, guide.ID, fixtureHash); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Credentials(ctx, guide.Email); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("deleted credentials usable", err)
	}
	if _, err := s.User(ctx, guide.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("deleted profile visible", err)
	}
	if _, err := s.SessionUser(ctx, session); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatal("deleted session usable", err)
	}
	if _, err := s.ResetAccountPassword(ctx, reset, strings.Repeat("hash", 12)); !errors.Is(err, store.ErrAccountAction) {
		t.Fatal("reset resurrected account", err)
	}
	if err := s.VerifyAccountEmail(ctx, verify); !errors.Is(err, store.ErrAccountAction) {
		t.Fatal("verification resurrected account", err)
	}
	var email, name, hash, role, guideStatus string
	var disabled, verified bool
	var deleted *time.Time
	if err := s.Pool.QueryRow(ctx, "SELECT email,display_name,password_hash,role,guide_status,disabled,email_verified,deleted_at FROM users WHERE id=$1", guide.ID).Scan(&email, &name, &hash, &role, &guideStatus, &disabled, &verified, &deleted); err != nil {
		t.Fatal(err)
	}
	if email != "deleted-"+guide.ID+"@account.invalid" || name != "Удалённый аккаунт" || hash != "!deleted" || role != "tourist" || guideStatus != "none" || !disabled || verified || deleted == nil {
		t.Fatal("incomplete tombstone")
	}
	var cachedGuideName string
	if err := s.Pool.QueryRow(ctx, "SELECT response->>'guideName' FROM idempotency_keys WHERE user_id=$1 AND key='lifecycle-join-key-0001'", u.ID).Scan(&cachedGuideName); err != nil || cachedGuideName != "Удалённый аккаунт" {
		t.Fatal("idempotent response retained old public identity", cachedGuideName, err)
	}
	var history, qualifications int
	if err := s.Pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM departures WHERE guide_id=$1),(SELECT count(*) FROM guide_qualifications WHERE user_id=$1)", guide.ID).Scan(&history, &qualifications); err != nil || history != 1 || qualifications != 1 {
		t.Fatal("required history destroyed", err)
	}
	if _, err := s.Pool.Exec(ctx, "UPDATE users SET disabled=false WHERE id=$1", guide.ID); err == nil {
		t.Fatal("tombstone was reversible")
	}
}

func TestConcurrentDeleteAndJoinCannotCreateADeletedParticipant(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	_, departure := fixture(t, s, 20)
	other, err := pgxpool.NewWithConfig(ctx, s.Pool.Config())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	joining := &store.Store{Pool: other}
	for i := 0; i < 10; i++ {
		u := account(t, s, fmt.Sprintf("concurrent-deletion-%d", i), "tourist")
		start := make(chan struct{})
		joins := make(chan error, 1)
		deletions := make(chan error, 1)
		go func() {
			<-start
			_, err := joining.Join(ctx, u.ID, departure.ID, fmt.Sprintf("lifecycle-race-join-%04d", i), 0)
			joins <- err
		}()
		go func() { <-start; deletions <- s.DeleteAccount(ctx, u.ID, "integration-fixture-not-a-login-hash") }()
		close(start)
		joinErr, deleteErr := <-joins, <-deletions
		if joinErr == nil && deleteErr == nil {
			t.Fatal("both deletion and active join committed")
		}
		var orphan bool
		if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id JOIN departures d ON d.id=m.departure_id WHERE u.id=$1 AND u.deleted_at IS NOT NULL AND m.status IN ('confirmed','checked_in') AND d.status IN ('recruiting','ready','awaiting_guide','in_progress'))`, u.ID).Scan(&orphan); err != nil || orphan {
			t.Fatal("deleted active participant", err)
		}
	}
}

func TestAccountDeletionCannotOrphanAWithdrawnDepartureCreator(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	guide, departure := fixture(t, s, 5)
	if _, err := s.Pool.Exec(ctx, "UPDATE memberships SET status='cancelled' WHERE departure_id=$1 AND user_id=$2", departure.ID, guide.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, "UPDATE departures SET guide_id=NULL,status='awaiting_guide' WHERE id=$1", departure.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteAccount(ctx, guide.ID, "integration-fixture-not-a-login-hash"); !errors.Is(err, store.ErrActiveAccount) {
		t.Fatal("only remaining cancellation authority was deleted", err)
	}
	if _, err := s.Pool.Exec(ctx, "UPDATE departures SET status='cancelled' WHERE id=$1", departure.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteAccount(ctx, guide.ID, "integration-fixture-not-a-login-hash"); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeRoleCanCompleteLifecycleWithoutOperatorPrivileges(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	secret := hex.EncodeToString(b)
	role := "tropa_lifecycle_" + secret[:12]
	quoted := pgx.Identifier{role}.Sanitize()
	if _, err := s.Pool.Exec(ctx, "CREATE ROLE "+quoted+" LOGIN PASSWORD '"+secret+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION"); err != nil {
		t.Fatal(err)
	}
	if err := migrations.GrantRuntime(ctx, s.Pool, role); err != nil {
		t.Fatal(err)
	}
	cfg := s.Pool.Config()
	cfg.ConnConfig.User = role
	cfg.ConnConfig.Password = secret
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	runtime := &store.Store{Pool: pool}
	t.Cleanup(func() {
		runtime.Close()
		if _, err := s.Pool.Exec(ctx, "DROP OWNED BY "+quoted); err != nil {
			t.Error(err)
		}
		if _, err := s.Pool.Exec(ctx, "DROP ROLE "+quoted); err != nil {
			t.Error(err)
		}
	})
	u := account(t, runtime, "lifecycle-runtime", "tourist")
	_, verification := actionToken(t, runtime, u.Email, store.VerifyEmailAction)
	if err := runtime.VerifyAccountEmail(ctx, verification); err != nil {
		t.Fatal("runtime verification", err)
	}
	_, reset := actionToken(t, runtime, u.Email, store.ResetPasswordAction)
	newHash := strings.Repeat("new-credential-fixture", 3)
	if _, err := runtime.ResetAccountPassword(ctx, reset, newHash); err != nil {
		t.Fatal("runtime password reset", err)
	}
	session, _ := auth.SessionToken()
	if err := runtime.CreateSessionWithCredentials(ctx, u.ID, session, time.Now().Add(time.Hour), newHash); err != nil {
		t.Fatal("runtime login", err)
	}
	if err := runtime.DeleteAccount(ctx, u.ID, newHash); err != nil {
		t.Fatal("runtime deletion", err)
	}
	if _, err := runtime.Pool.Exec(ctx, "UPDATE users SET is_admin=true WHERE id=$1", u.ID); err == nil {
		t.Fatal("runtime elevated operator role")
	}
}

func TestLifecycleMailAndReauthenticationBudgetsUsePersistentScopes(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	for _, tc := range []struct {
		scope          string
		limit, seconds int
	}{{store.AccountMailScope, 3, 900}, {store.AccountReauthScope, 5, 60}} {
		key := auth.RateIdentity(make([]byte, 32), tc.scope, "fixture@example.invalid")
		for i := 1; i <= tc.limit+1; i++ {
			result, err := s.ConsumeAuthAttempt(ctx, tc.scope, key)
			if err != nil || result.Allowed != (i <= tc.limit) || result.RetryAfter < 1 || result.RetryAfter > tc.seconds {
				t.Fatal(tc.scope, i, result, err)
			}
		}
	}
}
