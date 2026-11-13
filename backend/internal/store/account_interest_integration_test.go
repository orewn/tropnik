//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
)

func TestAccountDeletionWithdrawsInterestAndRetainsParticipationHistory(t *testing.T) {
	owner := db(t)
	guide, departure := fixture(t, owner, 5)
	app, _ := runtimeRoleFixture(t, owner)
	ctx := context.Background()
	user := account(t, app, "interest account deletion", "tourist")
	request, err := app.CreateRecruitment(ctx, guide.ID, departure.RouteID, "", "Обсуждаем новый выход по маршруту")
	if err != nil {
		t.Fatal(err)
	}
	if err = app.JoinRecruitment(ctx, user.ID, request.ID); err != nil {
		t.Fatal(err)
	}
	message, err := app.SendRecruitmentMessage(ctx, user.ID, request.ID, "Интересует следующий выход", "interest-deletion-message-0001")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.Join(ctx, user.ID, departure.ID, "interest-deletion-booking-0001", 0); err != nil {
		t.Fatal(err)
	}
	const passwordHash = "integration-fixture-not-a-login-hash"
	if err = app.DeleteAccount(ctx, user.ID, passwordHash); !errors.Is(err, store.ErrActiveAccount) {
		t.Fatal("active booking did not block account deletion", err)
	}
	requests, err := app.RecruitmentRequests(ctx, departure.RouteID)
	if err != nil || len(requests) != 1 || requests[0].InterestedCount != 2 {
		t.Fatal("failed account deletion changed nonbinding interest", requests, err)
	}
	// Record a completed fixture through the operator connection. Account closure
	// must preserve this participation while withdrawing only nonbinding interest.
	if _, err = owner.Pool.Exec(ctx, "UPDATE departures SET status='completed',completed_at=clock_timestamp() WHERE id=$1", departure.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Pool.Exec(ctx, "UPDATE memberships SET status='completed' WHERE departure_id=$1", departure.ID); err != nil {
		t.Fatal(err)
	}
	if err = app.DeleteAccount(ctx, user.ID, passwordHash); err != nil {
		t.Fatal(err)
	}
	requests, err = app.RecruitmentRequests(ctx, departure.RouteID)
	if err != nil || len(requests) != 1 || requests[0].ID != request.ID || requests[0].Status != "open" || requests[0].InterestedCount != 1 {
		t.Fatal("deleted account still counted as interested or changed the request", requests, err)
	}
	messages, err := app.RecruitmentMessages(ctx, guide.ID, request.ID)
	if err != nil || len(messages) != 1 || messages[0].ID != message.ID || messages[0].Body != message.Body || messages[0].DisplayName != "Удалённый аккаунт" {
		t.Fatal("recruitment conversation lost its anonymised history", messages, err)
	}
	if _, err = app.RecruitmentMessages(ctx, user.ID, request.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatal("closed account retained recruitment membership", err)
	}
	if err = app.JoinRecruitment(ctx, user.ID, request.ID); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatal("closed account recreated recruitment interest", err)
	}
	var membershipStatus, departureStatus, revision string
	err = owner.Pool.QueryRow(ctx, `SELECT m.status,d.status,d.route_revision_id::text
FROM memberships m JOIN departures d ON d.id=m.departure_id
WHERE m.departure_id=$1 AND m.user_id=$2`, departure.ID, user.ID).Scan(&membershipStatus, &departureStatus, &revision)
	if err != nil || membershipStatus != "completed" || departureStatus != "completed" || revision != departure.RouteRevisionID {
		t.Fatal("account closure changed completed participation", membershipStatus, departureStatus, revision, err)
	}
}

func TestConcurrentAccountDisableCannotAddRecruitmentInterest(t *testing.T) {
	owner := db(t)
	guide, departure := fixture(t, owner, 5)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	user := account(t, owner, "interest concurrent disable", "tourist")
	request, err := owner.CreateRecruitment(ctx, guide.ID, departure.RouteID, "", "Согласуем дату будущего выхода")
	if err != nil {
		t.Fatal(err)
	}
	cfg := owner.Pool.Config()
	cfg.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	joining := &store.Store{Pool: pool}
	defer joining.Close()
	var joiningPID int32
	if err = pool.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&joiningPID); err != nil {
		t.Fatal(err)
	}
	tx, err := owner.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var lockedUser string
	var holdingPID int32
	if err = tx.QueryRow(ctx, "SELECT id::text,pg_backend_pid() FROM users WHERE id=$1 FOR UPDATE", user.ID).Scan(&lockedUser, &holdingPID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- joining.JoinRecruitment(ctx, user.ID, request.ID) }()
	// Observe a real PostgreSQL lock wait before changing state, rather than
	// relying on goroutine timing to exercise the authentication-vs-closure race.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err = owner.Pool.QueryRow(ctx, "SELECT $1::int = ANY(pg_blocking_pids($2::int))", holdingPID, joiningPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case err = <-result:
			t.Fatal("join completed without waiting for the account lock", err)
		case <-ctx.Done():
			t.Fatal("join never reached the account lock", ctx.Err())
		case <-ticker.C:
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE users SET disabled=true WHERE id=$1", user.ID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
		if !errors.Is(err, domain.ErrUnauthorized) {
			t.Fatal("stale authenticated request added interest after account disable", err)
		}
	case <-ctx.Done():
		t.Fatal("join did not finish after the account lock was released", ctx.Err())
	}
	var count int
	if err = owner.Pool.QueryRow(ctx, "SELECT count(*) FROM recruitment_members WHERE request_id=$1 AND user_id=$2", request.ID, user.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("disabled account has recruitment interest", count, err)
	}
}
