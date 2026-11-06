//go:build integration

package store_test

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"tropa/backend/internal/auth"
	"tropa/backend/internal/store"
	"tropa/backend/migrations"
)

func TestAuthenticationBudgetPersistsExpiresAndCleansBoundedly(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	key := auth.RateIdentity(make([]byte, 32), store.AuthIPScope, "198.51.100.20")
	for i := 1; i <= 22; i++ {
		// A fresh Store value cannot reset the counter held by the database.
		app := &store.Store{Pool: s.Pool}
		result, err := app.ConsumeAuthAttempt(ctx, store.AuthIPScope, key)
		if err != nil || result.Allowed != (i <= 20) || result.RetryAfter < 1 || result.RetryAfter > 60 {
			t.Fatalf("attempt %d: %+v, %v", i, result, err)
		}
	}
	var count int
	if err := s.Pool.QueryRow(ctx, "SELECT attempts FROM auth_rate_limits WHERE scope=$1 AND key_hash=$2", store.AuthIPScope, key[:]).Scan(&count); err != nil || count != 21 {
		t.Fatal("denied attempts were rolled back or not capped", count, err)
	}
	if _, err := s.Pool.Exec(ctx, "UPDATE auth_rate_limits SET window_started_at=now()-interval '2 minutes',expires_at=now()-interval '1 minute' WHERE scope=$1 AND key_hash=$2", store.AuthIPScope, key[:]); err != nil {
		t.Fatal(err)
	}
	if result, err := s.ConsumeAuthAttempt(ctx, store.AuthIPScope, key); err != nil || !result.Allowed {
		t.Fatal("expired window did not reopen", result, err)
	}
	if err := s.Pool.QueryRow(ctx, "SELECT attempts FROM auth_rate_limits WHERE scope=$1 AND key_hash=$2", store.AuthIPScope, key[:]).Scan(&count); err != nil || count != 1 {
		t.Fatal("expired count not reset", count, err)
	}
	account := auth.RateIdentity(make([]byte, 32), store.LoginAccountScope, "person@example.invalid")
	for i := 1; i <= 11; i++ {
		result, err := s.ConsumeAuthAttempt(ctx, store.LoginAccountScope, account)
		if err != nil || result.Allowed != (i <= 10) {
			t.Fatal("account budget", i, result, err)
		}
	}
	if _, err := s.ConsumeAuthAttempt(ctx, "unknown", key); err == nil {
		t.Fatal("unbounded caller-selected scope accepted")
	}
	// The runtime cleanup is intentionally bounded even after an idle period.
	if _, err := s.Pool.Exec(ctx, `INSERT INTO auth_rate_limits(scope,key_hash,window_started_at,expires_at,attempts)
SELECT 'auth_ip',decode(lpad(to_hex(g),64,'0'),'hex'),now()-interval '2 minutes',now()-interval '1 minute',1
FROM generate_series(1,200) AS g`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ConsumeAuthAttempt(ctx, store.AuthIPScope, key); err != nil {
		t.Fatal(err)
	}
	if err := s.Pool.QueryRow(ctx, "SELECT count(*) FROM auth_rate_limits WHERE expires_at<=now()").Scan(&count); err != nil || count != 200-store.AuthCleanupBatch {
		t.Fatal("cleanup exceeded or missed its bounded batch", count, err)
	}
}

// This test belongs to the native multi-connection gate, never the single-session
// WASM compatibility selection. Two independent pools emulate API replicas.
func TestAuthenticationBudgetSerializesAcrossPools(t *testing.T) {
	s := db(t)
	otherPool, err := pgxpool.NewWithConfig(context.Background(), s.Pool.Config())
	if err != nil {
		t.Fatal(err)
	}
	defer otherPool.Close()
	apps := []*store.Store{s, {Pool: otherPool}}
	key := auth.RateIdentity(make([]byte, 32), store.LoginAccountScope, "parallel@example.invalid")
	var allowed atomic.Int32
	var wg sync.WaitGroup
	errors := make(chan error, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			result, err := apps[i%2].ConsumeAuthAttempt(context.Background(), store.LoginAccountScope, key)
			if err != nil {
				errors <- err
				return
			}
			if result.Allowed {
				allowed.Add(1)
			}
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	if allowed.Load() != 10 {
		t.Fatalf("exactly ten account attempts must win, got %d", allowed.Load())
	}
}

func TestReadinessRequiresCurrentSchemaVersion(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	if err := s.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, "DELETE FROM schema_migrations WHERE version=$1", migrations.RequiredVersion); err != nil {
		t.Fatal(err)
	}
	if err := s.Ready(ctx); err == nil {
		t.Fatal(fmt.Sprintf("readiness accepted a schema without migration %d", migrations.RequiredVersion))
	}
}
