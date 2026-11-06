//go:build integration

package store_test

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"

	"tropa/backend/internal/domain"
)

func TestCompletedHistoryIsPrivateStableAndRetainsReviewedRevision(t *testing.T) {
	s := db(t)
	guide, seed := fixture(t, s, 4)
	member := account(t, s, "history member", "tourist")
	outsider := account(t, s, "history outsider", "tourist")
	absent := account(t, s, "history no show", "tourist")
	ctx := context.Background()
	finished := time.Date(2026, 11, 5, 12, 0, 0, 123456000, time.UTC)
	ids := []string{}
	for i := 0; i < 3; i++ {
		var id string
		at := finished
		if i == 2 {
			at = at.Add(-time.Hour)
		}
		err := s.Pool.QueryRow(ctx, `INSERT INTO departures(route_id,route_revision_id,guide_id,created_by,starts_at,ends_at,time_zone,min_people,capacity,status,completed_at)
 VALUES($1,$2,$3,$3,$4,$5,'Europe/Moscow',4,4,'completed',$6) RETURNING id::text`, seed.RouteID, seed.RouteRevisionID, guide.ID, at.Add(-3*time.Hour), at.Add(-time.Hour), at).Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.Pool.Exec(ctx, `INSERT INTO memberships(departure_id,user_id,role,status) VALUES
 ($1,$2,'guide','completed'),($1,$3,'tourist','completed'),($1,$4,'tourist','no_show')`, id, guide.ID, member.ID, absent.ID); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ids[:2])))
	// A moderated review must still prevent duplicate submission to that target.
	if _, err := s.Pool.Exec(ctx, "INSERT INTO reviews(departure_id,user_id,target,rating,body,visibility) VALUES($1,$2,'route',4,'History fixture only','hidden')", ids[0], member.ID); err != nil {
		t.Fatal(err)
	}
	// Withdrawal from the public catalogue must not erase the member's history.
	if _, err := s.Pool.Exec(ctx, "UPDATE routes SET status='draft' WHERE id=$1", seed.RouteID); err != nil {
		t.Fatal(err)
	}
	page, next, err := s.DepartureHistory(ctx, member.ID, "", 1)
	if err != nil || len(page) != 1 || page[0].ID != ids[0] || next == "" {
		t.Fatalf("first history page: %+v %q %v", page, next, err)
	}
	if page[0].RouteRevisionID != seed.RouteRevisionID || page[0].Role != "tourist" || len(page[0].ReviewTargets) != 1 || page[0].ReviewTargets[0] != "guide" {
		t.Fatal("history lost pinned revision/role or reopened a hidden review", page[0])
	}
	// A completed hike remains reachable from history even after its public
	// route is withdrawn. Only this member sees their unwritten review targets.
	detail, err := s.Departure(ctx, ids[0], member.ID)
	if err != nil || detail.RouteTitle == "" || detail.RouteRevisionID != seed.RouteRevisionID || detail.ReviewTargets == nil || len(*detail.ReviewTargets) != 1 || (*detail.ReviewTargets)[0] != "guide" {
		t.Fatal("completed detail lost title/revision or reopened a hidden review", detail, err)
	}
	for _, user := range []string{"", outsider.ID, absent.ID} {
		detail, err = s.Departure(ctx, ids[0], user)
		if err != nil || detail.ReviewTargets != nil {
			t.Fatal("private review availability leaked to a non-participant", user, err)
		}
	}
	detail, err = s.Departure(ctx, ids[0], guide.ID)
	if err != nil || detail.ReviewTargets == nil || len(*detail.ReviewTargets) != 0 {
		t.Fatal("guide detail offers a self review", detail, err)
	}
	second, last, err := s.DepartureHistory(ctx, member.ID, next, 2)
	if err != nil || len(second) != 2 || second[0].ID != ids[1] || second[1].ID != ids[2] || last != "" {
		t.Fatalf("timestamp tie or final page lost a record: %+v %q %v", second, last, err)
	}
	for _, user := range []string{outsider.ID, absent.ID} {
		for _, cursor := range []string{"", next} {
			items, token, err := s.DepartureHistory(ctx, user, cursor, 50)
			if err != nil || len(items) != 0 || token != "" {
				t.Fatal("another account's participation leaked through history or its cursor", err)
			}
		}
	}
	guided, _, err := s.DepartureHistory(ctx, guide.ID, "", 20)
	if err != nil || len(guided) != 3 || len(guided[0].ReviewTargets) != 0 || guided[0].Role != "guide" {
		t.Fatal("guide history must not offer a self review", err)
	}
	if _, _, err = s.DepartureHistory(ctx, "", "", 20); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatal("anonymous history accepted", err)
	}
	if _, _, err = s.DepartureHistory(ctx, member.ID, "malformed", 20); !errors.Is(err, domain.ErrInvalid) {
		t.Fatal("invalid history cursor accepted", err)
	}
	for _, limit := range []int{-1, 0, 51} {
		if _, _, err = s.DepartureHistory(ctx, member.ID, "", limit); !errors.Is(err, domain.ErrInvalid) {
			t.Fatal("unbounded history page accepted", limit, err)
		}
	}
}
