//go:build integration

package store_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
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

func TestRestrictedRuntimeRoleCanOperateButCannotElevate(t *testing.T) {
	s := db(t)
	_, d := fixture(t, s, 5)
	ctx := context.Background()
	random := make([]byte, 24)
	rand.Read(random)
	secret := hex.EncodeToString(random)
	role := "tropa_it_" + secret[:12]
	quoted := pgx.Identifier{role}.Sanitize()
	// Identifier is quoted and password contains only generated hexadecimal digits.
	if _, e := s.Pool.Exec(ctx, "CREATE ROLE "+quoted+" LOGIN PASSWORD '"+secret+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION"); e != nil {
		t.Fatal(e)
	}
	if e := migrations.GrantRuntime(ctx, s.Pool, role); e != nil {
		t.Fatal(e)
	}
	cfg := s.Pool.Config()
	cfg.ConnConfig.User = role
	cfg.ConnConfig.Password = secret
	p, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	app := &store.Store{Pool: p}
	t.Cleanup(func() {
		app.Close()
		if _, e := s.Pool.Exec(context.Background(), "DROP OWNED BY "+quoted); e != nil {
			t.Error(e)
		}
		if _, e := s.Pool.Exec(context.Background(), "DROP ROLE "+quoted); e != nil {
			t.Error(e)
		}
	})
	if e = app.Ready(ctx); e != nil {
		t.Fatal("runtime readiness denied", e)
	}
	if e = app.CheckRuntimeRole(ctx); e != nil {
		t.Fatal("runtime privilege policy denied", e)
	}
	key := auth.RateIdentity(make([]byte, 32), store.AuthIPScope, "198.51.100.20")
	if result, err := app.ConsumeAuthAttempt(ctx, store.AuthIPScope, key); err != nil || !result.Allowed {
		t.Fatal("runtime auth budget denied", result, err)
	}
	u := account(t, app, "runtime-tourist", "tourist")
	if _, e = app.Join(ctx, u.ID, d.ID, "runtime-join-key-0001", 0); e != nil {
		t.Fatal("runtime could not execute real join", e)
	}
	for _, sql := range []string{"UPDATE users SET is_admin=true WHERE id='" + u.ID + "'", "UPDATE users SET is_moderator=true WHERE id='" + u.ID + "'", "UPDATE routes SET status='closed'", "UPDATE guide_qualifications SET revoked_at=now()"} {
		if _, e = app.Pool.Exec(ctx, sql); e == nil {
			t.Fatal("runtime exceeded assigned privileges")
		}
	}
}

func TestMain(m *testing.M) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "TEST_DATABASE_URL is required for the integration gate; tests were NOT run")
		os.Exit(2)
	}
	os.Exit(m.Run())
}
func db(t *testing.T) *store.Store {
	return dbThrough(t, migrations.RequiredVersion)
}

// dbThrough permits a real predecessor schema for upgrade regression tests.
// Ordinary integration fixtures always exercise the production migrator.
func dbThrough(t *testing.T, through int) *store.Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	u, e := url.Parse(dsn)
	if e != nil || !strings.HasSuffix(strings.TrimPrefix(u.Path, "/"), "_test") {
		t.Fatal("integration database name must end in _test")
	}
	ctx := context.Background()
	base, e := store.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = base.Pool.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public"); e != nil {
		base.Close()
		t.Fatal(e)
	}
	b := make([]byte, 8)
	rand.Read(b)
	schema := "tropa_it_" + hex.EncodeToString(b)
	ident := pgx.Identifier{schema}.Sanitize()
	if _, e = base.Pool.Exec(ctx, "CREATE SCHEMA "+ident); e != nil {
		base.Close()
		t.Fatal(e)
	}
	q := u.Query()
	q.Set("search_path", schema+",public")
	u.RawQuery = q.Encode()
	s, e := store.New(ctx, u.String())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		s.Close()
		_, e := base.Pool.Exec(context.Background(), "DROP SCHEMA "+ident+" CASCADE")
		base.Close()
		if e != nil {
			t.Error(e)
		}
	})
	if through == migrations.RequiredVersion {
		if e = migrations.Apply(ctx, s.Pool); e != nil {
			t.Fatal(e)
		}
	} else {
		files, err := migrations.Files.ReadDir(".")
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range files {
			version, err := strconv.Atoi(file.Name()[:3])
			if err != nil {
				t.Fatal(err)
			}
			if version > through {
				continue
			}
			raw, err := migrations.Files.ReadFile(file.Name())
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.Pool.Exec(ctx, string(raw)); err != nil {
				t.Fatal(err)
			}
		}
	}
	return s
}
func account(t *testing.T, s *store.Store, label, role string) domain.User {
	t.Helper()
	u, e := s.Register(context.Background(), strings.ToLower(strings.ReplaceAll(label, " ", "-"))+"@example.invalid", "integration-fixture-not-a-login-hash", label, role)
	if e != nil {
		t.Fatal(e)
	}
	return u
}
func fixture(t *testing.T, s *store.Store, capacity int) (domain.User, domain.Departure) {
	t.Helper()
	ctx := context.Background()
	admin := account(t, s, "Test operator", "tourist")
	guide := account(t, s, "Test guide", "guide")
	_, e := s.Pool.Exec(ctx, "UPDATE users SET is_admin=true WHERE id=$1", admin.ID)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.Pool.Exec(ctx, "UPDATE users SET guide_status='verified' WHERE id=$1", guide.ID)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.Pool.Exec(ctx, "INSERT INTO guide_qualifications(user_id,activity,max_difficulty,valid_until,evidence_ref,verified_by) VALUES($1,'hiking',2,now()+interval '1 year','INTEGRATION FIXTURE ONLY',$2)", guide.ID, admin.ID)
	if e != nil {
		t.Fatal(e)
	}
	var route, rev string
	e = s.Pool.QueryRow(ctx, "INSERT INTO routes(slug,region_id,title,description,activity) VALUES('integration-only','karelia','TEST ONLY','Not a public hiking route','hiking') RETURNING id::text").Scan(&route)
	if e != nil {
		t.Fatal(e)
	}
	e = s.Pool.QueryRow(ctx, `INSERT INTO route_revisions(route_id,revision,geometry,distance_km,ascent_m,duration_min,difficulty,season,source_name,source_url,source_license,source_retrieved_at,reviewed_at,reviewed_by,review_evidence) VALUES($1,1,ST_GeomFromText('LINESTRING(33 63,33.01 63.01)',4326),1,10,30,'easy','test only','integration fixture','https://example.invalid/test','test fixture',now(),now(),$2,'INTEGRATION FIXTURE ONLY') RETURNING id::text`, route, admin.ID).Scan(&rev)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.Pool.Exec(ctx, "UPDATE routes SET current_revision_id=$2,status='published' WHERE id=$1", route, rev)
	if e != nil {
		t.Fatal(e)
	}
	d, e := s.CreateDeparture(ctx, guide.ID, store.CreateDeparture{RouteID: route, RouteRevisionID: rev, StartsAt: time.Now().Add(time.Hour), EndsAt: time.Now().Add(5 * time.Hour), TimeZone: "Europe/Moscow", MinPeople: 4, Capacity: capacity})
	if e != nil {
		t.Fatal(e)
	}
	return guide, d
}

func TestConcurrentLastPlacesAndReplay(t *testing.T) {
	s := db(t)
	_, d := fixture(t, s, 4)
	people := []domain.User{}
	for i := 0; i < 24; i++ {
		people = append(people, account(t, s, fmt.Sprintf("tourist-%02d", i), "tourist"))
	}
	var won atomic.Int32
	var wg sync.WaitGroup
	for _, u := range people {
		u := u
		wg.Add(1)
		go func() {
			defer wg.Done()
			key := "join-" + u.ID
			got, e := s.Join(context.Background(), u.ID, d.ID, key, 0)
			if e == nil {
				won.Add(1)
				replayed, e := s.Join(context.Background(), u.ID, d.ID, key, 0)
				if e != nil || replayed.Version != got.Version {
					t.Errorf("idempotency failed: %v", e)
				}
			} else if !errors.Is(e, domain.ErrFull) {
				t.Errorf("unexpected concurrent error: %v", e)
			}
		}()
	}
	wg.Wait()
	if won.Load() != 3 {
		t.Fatalf("wanted three tourist places, got %d", won.Load())
	}
	latest, e := s.Departure(context.Background(), d.ID, "")
	if e != nil || latest.ParticipantCount != 4 || latest.Status != "ready" {
		t.Fatalf("invalid final departure: %+v %v", latest, e)
	}
}

func TestReviewedRoutePolicyCannotBeWeakened(t *testing.T) {
	s := db(t)
	guide, d := fixture(t, s, 4)
	ctx := context.Background()
	in := store.CreateDeparture{RouteID: d.RouteID, RouteRevisionID: d.RouteRevisionID, StartsAt: d.EndsAt.Add(time.Hour), EndsAt: d.EndsAt.Add(5 * time.Hour), TimeZone: "Europe/Moscow", MinPeople: 4, Capacity: 9}
	if _, e := s.CreateDeparture(ctx, guide.ID, in); !errors.Is(e, domain.ErrInvalid) {
		t.Fatalf("API allowed a capacity above the reviewed maximum: %v", e)
	}
	if _, e := s.Pool.Exec(ctx, "UPDATE departures SET capacity=9 WHERE id=$1", d.ID); e == nil {
		t.Fatal("database allowed a capacity above the reviewed maximum")
	}
	var revised string
	e := s.Pool.QueryRow(ctx, `INSERT INTO route_revisions(route_id,revision,geometry,distance_km,ascent_m,duration_min,difficulty,season,min_people,max_group_size,required_guides,source_name,source_url,source_license,source_retrieved_at,reviewed_at,reviewed_by,review_evidence)
	 SELECT route_id,revision+1,geometry,distance_km,ascent_m,duration_min,difficulty,season,6,8,1,source_name,source_url,source_license,source_retrieved_at,now(),reviewed_by,'INTEGRATION REVISED POLICY ONLY' FROM route_revisions WHERE id=$1 RETURNING id::text`, d.RouteRevisionID).Scan(&revised)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE routes SET current_revision_id=$2 WHERE id=$1", d.RouteID, revised); e != nil {
		t.Fatal(e)
	}
	in.RouteRevisionID = revised
	in.Capacity = 8
	if _, e = s.CreateDeparture(ctx, guide.ID, in); !errors.Is(e, domain.ErrInvalid) {
		t.Fatalf("API lowered the route minimum: %v", e)
	}
	in.MinPeople = 6
	if _, e = s.CreateDeparture(ctx, guide.ID, in); e != nil {
		t.Fatalf("valid reviewed policy was rejected: %v", e)
	}
	var multiGuide string
	e = s.Pool.QueryRow(ctx, `INSERT INTO route_revisions(route_id,revision,geometry,distance_km,ascent_m,duration_min,difficulty,season,min_people,max_group_size,required_guides,source_name,source_url,source_license,source_retrieved_at,reviewed_at,reviewed_by,review_evidence)
	 SELECT route_id,revision+1,geometry,distance_km,ascent_m,duration_min,difficulty,season,6,8,2,source_name,source_url,source_license,source_retrieved_at,now(),reviewed_by,'INTEGRATION MULTI-GUIDE POLICY ONLY' FROM route_revisions WHERE id=$1 RETURNING id::text`, revised).Scan(&multiGuide)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE routes SET current_revision_id=$2 WHERE id=$1", d.RouteID, multiGuide); e != nil {
		t.Fatal(e)
	}
	in.RouteRevisionID = multiGuide
	if _, e = s.CreateDeparture(ctx, guide.ID, in); !errors.Is(e, domain.ErrNotReady) {
		t.Fatalf("unsupported multi-guide policy was silently accepted: %v", e)
	}
}

func TestGuideWithdrawalAndPrivateChat(t *testing.T) {
	s := db(t)
	guide, d := fixture(t, s, 5)
	u := account(t, s, "tourist", "tourist")
	_, e := s.Join(context.Background(), u.ID, d.ID, "join-tourist-00000001", 0)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.SendMessage(context.Background(), u.ID, d.ID, "Вопрос гиду", "message-00000000001"); e != nil {
		t.Fatal(e)
	}
	outsider := account(t, s, "outsider", "tourist")
	if _, e = s.Messages(context.Background(), outsider.ID, d.ID, time.Time{}, ""); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("private chat leak", e)
	}
	left, e := s.Mutate(context.Background(), guide.ID, d.ID, "leave", "", 0)
	if e != nil || left.GuideID != nil || left.Status != "awaiting_guide" {
		t.Fatal("withdrawal failed", left, e)
	}
	if _, e = s.SendMessage(context.Background(), guide.ID, d.ID, "revoked", "message-00000000002"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("withdrawn member could send", e)
	}
	if _, e = s.Join(context.Background(), outsider.ID, d.ID, "join-outsider-000001", 0); !errors.Is(e, domain.ErrNotReady) {
		t.Fatal("guide-free join", e)
	}
}
func TestCompletionReviewsAndOfflineConflict(t *testing.T) {
	s := db(t)
	guide, d := fixture(t, s, 4)
	ctx := context.Background()
	people := []domain.User{}
	for i := 0; i < 3; i++ {
		u := account(t, s, fmt.Sprintf("walker-%d", i), "tourist")
		people = append(people, u)
		var e error
		d, e = s.Join(ctx, u.ID, d.ID, "join-walker-"+u.ID, 0)
		if e != nil {
			t.Fatal(e)
		}
	}
	oldVersion := d.Version
	for _, id := range []string{guide.ID, people[0].ID, people[1].ID, people[2].ID} {
		var e error
		d, e = s.Mutate(ctx, guide.ID, d.ID, "check-in", id, d.Version)
		if e != nil {
			t.Fatal(e)
		}
	}
	observation := domain.Observation{ClientID: "offline-event-000001", DepartureID: d.ID, BaseVersion: oldVersion, ObservedAt: time.Now(), Kind: "field_note", Body: "Наблюдение для теста"}
	ack, e := s.RecordObservation(ctx, people[0].ID, observation)
	if e != nil || ack.Status != "conflict" || ack.ServerAuthorized {
		t.Fatal("offline observation wrongly authorized", ack, e)
	}
	latest, _ := s.Departure(ctx, d.ID, guide.ID)
	if latest.Status != "ready" || latest.Version != d.Version {
		t.Fatal("offline evidence mutated authority")
	}
	_, e = s.Pool.Exec(ctx, "UPDATE departures SET starts_at=now()-interval '1 minute' WHERE id=$1", d.ID)
	if e != nil {
		t.Fatal(e)
	}
	d, e = s.Mutate(ctx, guide.ID, d.ID, "start", "", d.Version)
	if e != nil {
		t.Fatal(e)
	}
	d, e = s.Mutate(ctx, guide.ID, d.ID, "complete", "", d.Version)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.CreateReview(ctx, people[0].ID, d.ID, "guide", "Тестовый отзыв", 5); e != nil {
		t.Fatal(e)
	}
	if _, e = s.CreateReview(ctx, people[0].ID, d.ID, "guide", "Второй отзыв", 5); !errors.Is(e, domain.ErrDuplicate) {
		t.Fatal("duplicate review accepted", e)
	}
	if _, e = s.CreateReview(ctx, guide.ID, d.ID, "guide", "Самоотзыв", 5); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("guide self-rating accepted", e)
	}
	summary, e := s.AccountSummary(ctx, people[0].ID)
	if e != nil || summary.Stats.CompletedTrips != 1 || summary.Stats.ReviewsWritten != 1 || summary.User.StaffRole != "none" {
		t.Fatal("earned account summary mismatch", summary, e)
	}
	badges := map[string]domain.Badge{}
	for _, b := range summary.Badges {
		badges[b.ID] = b
	}
	if badges["first_trip"].EvidenceID != d.ID || badges["first_review"].EvidenceID == "" || len(badges) != 2 {
		t.Fatal("awards missing actual event evidence", badges)
	}
}
func TestRecruitmentDoesNotSilentlyBookTourists(t *testing.T) {
	s := db(t)
	guide, d := fixture(t, s, 6)
	ctx := context.Background()
	tourist := account(t, s, "requester", "tourist")
	req, e := s.CreateRecruitment(ctx, tourist.ID, d.RouteID, "", "Ищу группу и гида")
	if e != nil {
		t.Fatal(e)
	}
	other := account(t, s, "interested", "tourist")
	if e = s.JoinRecruitment(ctx, other.ID, req.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.SendRecruitmentMessage(ctx, other.ID, req.ID, "Можно присоединиться?", "interest-chat-00001"); e != nil {
		t.Fatal(e)
	}
	in := store.CreateDeparture{StartsAt: d.StartsAt.Add(48 * time.Hour), EndsAt: d.EndsAt.Add(48 * time.Hour), TimeZone: d.TimeZone, MinPeople: 4, Capacity: 6}
	created, e := s.AcceptRecruitment(ctx, guide.ID, req.ID, in)
	if e != nil {
		t.Fatal(e)
	}
	mine, e := s.Departure(ctx, created.ID, tourist.ID)
	if e != nil || mine.ParticipantCount != 1 || mine.Membership != "none" {
		t.Fatal("interest silently became booking", mine, e)
	}
	if _, e = s.Join(ctx, tourist.ID, created.ID, "confirm-new-dates-0001", 0); e != nil {
		t.Fatal(e)
	}
}
func TestRealSessionsAndPendingGuide(t *testing.T) {
	s := db(t)
	ctx := context.Background()
	u := account(t, s, "pending-guide", "guide")
	if u.GuideStatus != "pending" || u.EmailVerified {
		t.Fatal("fabricated verification")
	}
	token, e := auth.SessionToken()
	if e != nil {
		t.Fatal(e)
	}
	if e = s.CreateSession(ctx, u.ID, token, time.Now().Add(time.Hour)); e != nil {
		t.Fatal(e)
	}
	logged, e := s.SessionUser(ctx, token)
	if e != nil || logged.ID != u.ID {
		t.Fatal("session unavailable", e)
	}
	var n int
	e = s.Pool.QueryRow(ctx, "SELECT octet_length(token_hash) FROM sessions WHERE user_id=$1", u.ID).Scan(&n)
	if e != nil || n != 32 {
		t.Fatal("raw session stored")
	}
	if e = s.RevokeSession(ctx, token); e != nil {
		t.Fatal(e)
	}
	if _, e = s.SessionUser(ctx, token); !errors.Is(e, domain.ErrUnauthorized) {
		t.Fatal("revoked token accepted", e)
	}
}

func TestOverviewIsBoundedAndFullRouteRemainsAvailable(t *testing.T) {
	s := db(t)
	_, d := fixture(t, s, 4)
	ctx := context.Background()
	var admin, rev string
	if e := s.Pool.QueryRow(ctx, "SELECT id::text FROM users WHERE is_admin").Scan(&admin); e != nil {
		t.Fatal(e)
	}
	e := s.Pool.QueryRow(ctx, `INSERT INTO route_revisions(route_id,revision,geometry,distance_km,ascent_m,duration_min,difficulty,season,source_name,source_url,source_license,source_retrieved_at,reviewed_at,reviewed_by,review_evidence)
	VALUES($1,2,(SELECT ST_MakeLine(ST_SetSRID(ST_MakePoint(33+i/100000.0,63+i/100000.0),4326) ORDER BY i) FROM generate_series(1,1501) i),2,10,30,'easy','test only','test fixture','https://example.invalid/test','test fixture',now(),now(),$2,'INTEGRATION FIXTURE ONLY') RETURNING id::text`, d.RouteID, admin).Scan(&rev)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE routes SET current_revision_id=$2 WHERE id=$1", d.RouteID, rev); e != nil {
		t.Fatal(e)
	}
	list, e := s.Routes(ctx, "karelia", "", 30)
	if e != nil || len(list) != 1 {
		t.Fatal("overview query failed", e)
	}
	full, e := s.Route(ctx, d.RouteID)
	if e != nil {
		t.Fatal(e)
	}
	if list[0].GeometryDetail != "overview" || len(list[0].Geometry.Coordinates) > 1000 || full.GeometryDetail != "full" || len(full.Geometry.Coordinates) != 1501 {
		t.Fatal("overview/full geometry contract violated")
	}
	latest, e := s.Departure(ctx, d.ID, "")
	if e != nil || latest.RouteOpen {
		t.Fatal("old departure revision remained authorized after revision changed", e)
	}
}

func TestRosterOnlyAssignedGuideAndRevokedInterestCannotPost(t *testing.T) {
	s := db(t)
	guide, d := fixture(t, s, 4)
	ctx := context.Background()
	u := account(t, s, "roster-tourist", "tourist")
	if _, e := s.Join(ctx, u.ID, d.ID, "roster-join-key-00001", 0); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Participants(ctx, u.ID, d.ID); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("tourist obtained guide-only roster", e)
	}
	people, e := s.Participants(ctx, guide.ID, d.ID)
	if e != nil || len(people) != 2 {
		t.Fatal("guide roster unavailable", e)
	}
	req, e := s.CreateRecruitment(ctx, guide.ID, d.RouteID, "", "Тестовое обсуждение")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.JoinRecruitment(ctx, u.ID, req.ID); e != nil {
		t.Fatal(e)
	}
	if e = s.LeaveRecruitment(ctx, u.ID, req.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.SendRecruitmentMessage(ctx, u.ID, req.ID, "Сообщение после выхода", "revoked-chat-key-0001"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("revoked interest member posted", e)
	}
}
