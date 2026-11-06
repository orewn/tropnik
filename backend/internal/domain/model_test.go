package domain

import (
	"errors"
	"fmt"
	"math/rand"
	"testing"
	"time"
)

var testNow = time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)

func fixture() Group {
	guide := "guide"
	g := Group{Departure: Departure{ID: "trip", GuideID: &guide, GuideEligible: true, RouteOpen: true, MinPeople: 4, Capacity: 5, Status: "recruiting", Version: 1, StartsAt: testNow.Add(time.Hour), EndsAt: testNow.Add(8 * time.Hour)}, OwnerID: guide, Members: map[string]Member{guide: {UserID: guide, Role: "guide", Status: "confirmed"}}}
	g.Refresh()
	return g
}
func ready(t *testing.T) Group {
	t.Helper()
	g := fixture()
	for _, id := range []string{"a", "b", "c"} {
		if e := g.Join(id, 0, testNow); e != nil {
			t.Fatal(e)
		}
	}
	return g
}

func TestMinimumIncludesOneGuideOnce(t *testing.T) {
	g := fixture()
	for i := 0; i < 3; i++ {
		if e := g.Join(fmt.Sprint(i), g.Version, testNow); e != nil {
			t.Fatal(e)
		}
		if i < 2 && g.Status == "ready" {
			t.Fatal("premature readiness")
		}
	}
	if g.ActiveCount() != 4 || g.Status != "ready" {
		t.Fatalf("count=%d status=%s", g.ActiveCount(), g.Status)
	}
	v := g.Version
	if e := g.Join("guide", 0, testNow); e != nil || g.ActiveCount() != 4 || g.Version != v {
		t.Fatal("guide counted twice")
	}
}
func TestMissingGuideCannotJoin(t *testing.T) {
	for _, variant := range []string{"none", "revoked"} {
		t.Run(variant, func(t *testing.T) {
			g := fixture()
			if variant == "none" {
				g.GuideID = nil
			} else {
				g.GuideEligible = false
			}
			g.Refresh()
			if e := g.Join("a", 0, testNow); !errors.Is(e, ErrNotReady) {
				t.Fatal(e)
			}
			if g.Status != "awaiting_guide" {
				t.Fatal(g.Status)
			}
		})
	}
}
func TestCapacityAndStaleVersion(t *testing.T) {
	g := ready(t)
	old := g.Version
	if e := g.Join("d", old, testNow); e != nil {
		t.Fatal(e)
	}
	if e := g.Join("e", old, testNow); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	if e := g.Join("e", g.Version, testNow); !errors.Is(e, ErrFull) {
		t.Fatal(e)
	}
	if g.ActiveCount() != 5 {
		t.Fatal("capacity changed")
	}
}
func TestWithdrawalRecomputesReadiness(t *testing.T) {
	g := ready(t)
	if e := g.Leave("a", testNow); e != nil {
		t.Fatal(e)
	}
	if g.Status != "recruiting" || g.ActiveCount() != 3 {
		t.Fatalf("%+v", g.Departure)
	}
	if e := g.Join("a", 0, testNow); e != nil {
		t.Fatal(e)
	}
	if e := g.Leave("guide", testNow); e != nil {
		t.Fatal(e)
	}
	if g.GuideID != nil || g.Status != "awaiting_guide" {
		t.Fatal("guide withdrawal left ready group")
	}
	if e := g.Transition("guide", "cancel", g.Version, testNow); e != nil {
		t.Fatal("creator cannot cancel stranded group", e)
	}
}
func TestStartNeedsActualQuorum(t *testing.T) {
	g := ready(t)
	for _, id := range []string{"guide", "a", "b"} {
		if e := g.CheckIn("guide", id, g.Version, testNow); e != nil {
			t.Fatal(e)
		}
	}
	if e := g.Transition("guide", "start", g.Version, g.StartsAt); !errors.Is(e, ErrNotReady) {
		t.Fatal(e)
	}
	if e := g.CheckIn("guide", "c", g.Version, testNow); e != nil {
		t.Fatal(e)
	}
	if e := g.Transition("guide", "start", g.Version, g.StartsAt); e != nil {
		t.Fatal(e)
	}
	if g.Status != "in_progress" {
		t.Fatal(g.Status)
	}
	if e := g.Leave("a", g.StartsAt); !errors.Is(e, ErrConflict) {
		t.Fatal("in-progress membership destroyed")
	}
}
func TestStartRechecksClosureAndGuide(t *testing.T) {
	for _, which := range []string{"closed", "guide"} {
		t.Run(which, func(t *testing.T) {
			g := ready(t)
			for id, m := range g.Members {
				m.Status = "checked_in"
				g.Members[id] = m
			}
			if which == "closed" {
				g.RouteOpen = false
			} else {
				g.GuideEligible = false
			}
			if e := g.Transition("guide", "start", g.Version, g.StartsAt); !errors.Is(e, ErrNotReady) {
				t.Fatal(e)
			}
			if g.Status == "in_progress" {
				t.Fatal("unsafe transition")
			}
		})
	}
}
func TestRevocationDoesNotPreventIncidentAbort(t *testing.T) {
	g := ready(t)
	g.Status = "in_progress"
	g.GuideEligible = false
	if e := g.Transition("guide", "abort", g.Version, g.StartsAt); e != nil {
		t.Fatal(e)
	}
	if g.Status != "aborted" || len(g.Members) != 4 {
		t.Fatal("safety record or roster lost")
	}
}
func TestReviewsRequireCompletedAttendanceAndExcludeGuide(t *testing.T) {
	g := ready(t)
	g.Join("absent", 0, testNow)
	for _, id := range []string{"guide", "a", "b", "c"} {
		g.CheckIn("guide", id, g.Version, testNow)
	}
	if e := g.Transition("guide", "start", g.Version, g.StartsAt); e != nil {
		t.Fatal(e)
	}
	if g.CanReview("a", "guide") {
		t.Fatal("review before completion")
	}
	if e := g.Transition("guide", "complete", g.Version, g.StartsAt.Add(time.Hour)); e != nil {
		t.Fatal(e)
	}
	if !g.CanReview("a", "guide") || g.CanReview("guide", "guide") || g.CanReview("absent", "route") || g.CanReview("outsider", "guide") {
		t.Fatal("incorrect review eligibility")
	}
	if g.CanReadChat("absent") {
		t.Fatal("absent member has chat access")
	}
}
func TestRemovedParticipantCannotReadChat(t *testing.T) {
	g := ready(t)
	if !g.CanReadChat("a") {
		t.Fatal("active member excluded")
	}
	g.Leave("a", testNow)
	if g.CanReadChat("a") || g.CanReadChat("outsider") {
		t.Fatal("chat permission leak")
	}
}
func TestStateInvariantsAcrossAdversarialSequences(t *testing.T) {
	r := rand.New(rand.NewSource(20261106))
	for attempt := 0; attempt < 50; attempt++ {
		g := fixture()
		for step := 0; step < 200; step++ {
			id := fmt.Sprint(r.Intn(12))
			if r.Intn(2) == 0 {
				_ = g.Join(id, 0, testNow)
			} else {
				_ = g.Leave(id, testNow)
			}
			if g.ActiveCount() > g.Capacity {
				t.Fatal("capacity invariant violated")
			}
			if g.Status == "ready" && (g.ActiveCount() < 4 || g.GuideID == nil || !g.GuideEligible) {
				t.Fatal("quorum invariant violated")
			}
			if step == 150 {
				_ = g.Leave("guide", testNow)
			}
		}
	}
}
