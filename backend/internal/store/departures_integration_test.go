//go:build integration

package store_test

import (
	"bytes"
	"context"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"tropa/backend/internal/store"
	"tropa/backend/migrations"
)

type departureQueryTrace struct{ calls, rows atomic.Int64 }

func (trace *departureQueryTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	trace.calls.Add(1)
	return ctx
}
func (trace *departureQueryTrace) TraceQueryEnd(_ context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	trace.rows.Add(data.CommandTag.RowsAffected())
}

func assertActiveMembershipIndex(t *testing.T, s *store.Store) {
	t.Helper()
	var valid bool
	err := s.Pool.QueryRow(context.Background(), `SELECT EXISTS(
 SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE i.indrelid='memberships'::regclass AND c.relname='memberships_active_departure'
 AND i.indisvalid AND i.indisready AND NOT i.indisunique AND i.indnkeyatts=1 AND i.indnatts=1 AND am.amname='btree'
 AND pg_get_indexdef(i.indexrelid,1,true)='departure_id'
 AND pg_get_expr(i.indpred,i.indrelid)=$1)`, "(status = ANY (ARRAY['confirmed'::text, 'checked_in'::text, 'completed'::text]))").Scan(&valid)
	if err != nil || !valid {
		t.Fatal("active membership index is missing or its predicate/key differs", err)
	}
}

func TestPublicDeparturesAggregatePreservesFieldsAndUsesOneQuery(t *testing.T) {
	s := db(t)
	guide, seed := fixture(t, s, 8)
	member := account(t, s, "projection member", "tourist")
	checked := account(t, s, "projection checked", "tourist")
	completed := account(t, s, "projection completed", "tourist")
	former := account(t, s, "projection former", "tourist")
	absent := account(t, s, "projection absent", "tourist")
	ctx := context.Background()
	_, err := s.Pool.Exec(ctx, `INSERT INTO memberships(departure_id,user_id,role,status) VALUES
 ($1,$2,'tourist','confirmed'),($1,$3,'tourist','checked_in'),($1,$4,'tourist','completed'),
 ($1,$5,'tourist','cancelled'),($1,$6,'tourist','no_show')`, seed.ID, member.ID, checked.ID, completed.ID, former.ID, absent.ID)
	if err != nil {
		t.Fatal(err)
	}
	// A long withdrawn history must neither inflate the count nor be sent back
	// to Go just to form the small public page. Preserve all SQL guards here.
	_, err = s.Pool.Exec(ctx, `WITH historical AS (
 INSERT INTO users(email,password_hash,display_name)
 SELECT 'projection-history-'||n||'@example.invalid','!fixture','Historical fixture'
 FROM generate_series(1,2000) n RETURNING id
)
INSERT INTO memberships(departure_id,user_id,role,status)
 SELECT $1,id,'tourist','cancelled' FROM historical`, seed.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertActiveMembershipIndex(t, s)
	ids := []string{seed.ID}
	for index, status := range []string{"ready", "awaiting_guide", "in_progress", "completed", "cancelled", "aborted", "recruiting"} {
		start, end := seed.StartsAt.Add(time.Duration(index+1)*time.Hour), seed.EndsAt.Add(time.Duration(index+1)*time.Hour)
		if index == 6 {
			start, end = time.Now().Add(-3*time.Hour), time.Now().Add(-time.Hour)
		}
		var id string
		err = s.Pool.QueryRow(ctx, `INSERT INTO departures(route_id,route_revision_id,guide_id,created_by,starts_at,ends_at,time_zone,min_people,capacity,status)
 VALUES($1,$2,CASE WHEN $7='awaiting_guide' THEN NULL ELSE $3::uuid END,$3,$4,$5,$6,4,8,$7)
 RETURNING id::text`, seed.RouteID, seed.RouteRevisionID, guide.ID, start, end, seed.TimeZone, status).Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		if index < 3 {
			ids = append(ids, id)
		}
	}
	// Nondefault safety fields must survive the aggregate projection unchanged.
	_, err = s.Pool.Exec(ctx, `UPDATE departure_safety SET submission_id='FIXTURE-REFERENCE',
 confirmed_at=now(),confirmed_by=$2,start_contact_confirmed_at=now(),return_reported_at=now(),status='closed'
 WHERE departure_id=$1`, seed.ID, guide.ID)
	if err != nil {
		t.Fatal(err)
	}
	trace := &departureQueryTrace{}
	cfg := s.Pool.Config()
	cfg.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	public := &store.Store{Pool: pool}
	for _, user := range []string{"", guide.ID, member.ID, former.ID, absent.ID} {
		for _, route := range []string{"", seed.RouteID, "integration-only"} {
			trace.calls.Store(0)
			trace.rows.Store(0)
			items, err := public.Departures(ctx, route, user)
			if err != nil || len(items) != len(ids) || trace.calls.Load() != 1 || trace.rows.Load() != int64(len(ids)) {
				t.Fatal("public page made extra queries, returned history rows, or lost records", err, len(items), trace.calls.Load(), trace.rows.Load())
			}
			for index, item := range items {
				if item.ID != ids[index] {
					t.Fatal("departure order or status filter changed")
				}
				want, err := s.Departure(ctx, item.ID, user)
				if err != nil || !reflect.DeepEqual(item, want) {
					t.Fatal("aggregate projection drifted from public detail", item.ID, err, item, want)
				}
			}
			if items[0].ParticipantCount != 4 || items[0].Status != "ready" || items[1].Status != "recruiting" || items[2].Status != "awaiting_guide" || items[3].Status != "in_progress" {
				t.Fatal("active count or derived readiness changed")
			}
		}
	}
	if items, err := public.Departures(ctx, "missing-route", ""); err != nil || items == nil || len(items) != 0 {
		t.Fatal("missing route did not return an empty public page", err)
	}
	// Revoking eligibility or withdrawing the route changes readiness using the
	// same rule as the locked mutation model, without changing stored statuses.
	if _, err = s.Pool.Exec(ctx, "UPDATE guide_qualifications SET revoked_at=now() WHERE user_id=$1", guide.ID); err != nil {
		t.Fatal(err)
	}
	items, err := public.Departures(ctx, seed.RouteID, member.ID)
	if err != nil || len(items) != 4 || items[0].GuideEligible || items[0].Status != "awaiting_guide" || items[3].Status != "in_progress" {
		t.Fatal("revoked guide readiness changed", err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE guide_qualifications SET revoked_at=NULL WHERE user_id=$1", guide.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE routes SET status='closed' WHERE id=$1", seed.RouteID); err != nil {
		t.Fatal(err)
	}
	items, err = public.Departures(ctx, seed.RouteID, member.ID)
	if err != nil || len(items) != 4 || items[0].RouteOpen || items[0].Status != "recruiting" {
		t.Fatal("withdrawn route readiness changed", err)
	}
	// Preserve the existing 100-row ceiling and deterministic timestamp ties.
	_, err = s.Pool.Exec(ctx, `INSERT INTO departures(route_id,route_revision_id,guide_id,created_by,starts_at,ends_at,time_zone,min_people,capacity)
 SELECT route_id,route_revision_id,guide_id,created_by,starts_at+interval '20 hours',ends_at+interval '20 hours',time_zone,min_people,capacity
 FROM departures d CROSS JOIN generate_series(1,105) WHERE d.id=$1`, seed.ID)
	if err != nil {
		t.Fatal(err)
	}
	trace.calls.Store(0)
	trace.rows.Store(0)
	items, err = public.Departures(ctx, "", "")
	if err != nil || len(items) != 100 || trace.calls.Load() != 1 || trace.rows.Load() != 100 {
		t.Fatal("public page is unbounded or query count grows with its size", err)
	}
	for index := 1; index < len(items); index++ {
		previous, item := items[index-1], items[index]
		if item.StartsAt.Before(previous.StartsAt) || (item.StartsAt.Equal(previous.StartsAt) && item.ID <= previous.ID) {
			t.Fatal("timestamp tie order is unstable")
		}
	}
}

func TestSchemaSevenUpgradeAddsActiveIndexWithoutChangingMailOrMemberships(t *testing.T) {
	s := dbThrough(t, 7)
	guide, departure := fixture(t, s, 4)
	ctx := context.Background()
	if err := s.ConfigureAccountMail(ctx, fixtureMailKey); err != nil {
		t.Fatal(err)
	}
	if err := s.QueueAccountMail(ctx, guide.Email, store.VerifyEmailAction); err != nil {
		t.Fatal(err)
	}
	var beforeCipher, beforeNonce []byte
	if err := s.Pool.QueryRow(ctx, "SELECT payload_cipher,payload_nonce FROM account_mail_outbox").Scan(&beforeCipher, &beforeNonce); err != nil {
		t.Fatal(err)
	}
	if err := s.Ready(ctx); err == nil {
		t.Fatal("API readiness accepted predecessor schema 7")
	}
	if err := migrations.Apply(ctx, s.Pool); err != nil {
		t.Fatal(err)
	}
	if err := migrations.Apply(ctx, s.Pool); err != nil {
		t.Fatal("repeated migration was not idempotent", err)
	}
	if err := s.Ready(ctx); err != nil {
		t.Fatal("upgraded schema did not become ready", err)
	}
	assertActiveMembershipIndex(t, s)
	var versions []int
	if err := s.Pool.QueryRow(ctx, "SELECT array_agg(version ORDER BY version) FROM schema_migrations").Scan(&versions); err != nil || !reflect.DeepEqual(versions, []int{1, 2, 3, 4, 5, 6, 7, 8}) {
		t.Fatal("upgrade changed migration history", versions, err)
	}
	var afterCipher, afterNonce []byte
	if err := s.Pool.QueryRow(ctx, "SELECT payload_cipher,payload_nonce FROM account_mail_outbox").Scan(&afterCipher, &afterNonce); err != nil || !bytes.Equal(beforeCipher, afterCipher) || !bytes.Equal(beforeNonce, afterNonce) {
		t.Fatal("index migration changed pending encrypted mail", err)
	}
	items, err := s.Departures(ctx, departure.RouteID, guide.ID)
	if err != nil || len(items) != 1 || items[0].ParticipantCount != 1 || items[0].Membership != "confirmed" {
		t.Fatal("upgrade changed existing membership visibility", err)
	}
}
