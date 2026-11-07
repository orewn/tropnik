//go:build integration

package store_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
)

func TestSafetyPassportRequiredRouteAndAppendOnlyEvidence(t *testing.T) {
	s := db(t)
	s.SafetyKey = bytes.Repeat([]byte{9}, 32)
	ctx := context.Background()
	guide, base := fixture(t, s, 6)
	var admin string
	if err := s.Pool.QueryRow(ctx, "SELECT id::text FROM users WHERE is_admin LIMIT 1").Scan(&admin); err != nil {
		t.Fatal(err)
	}
	var revision string
	err := s.Pool.QueryRow(ctx, `INSERT INTO route_revisions(route_id,revision,geometry,distance_km,ascent_m,duration_min,difficulty,season,min_people,max_group_size,required_guides,source_name,source_url,source_license,source_retrieved_at,reviewed_at,reviewed_by,review_evidence,risk_class,route_type,legal_difficulty_category,mchs_notification_policy,mchs_territorial_unit_id,emergency_exits,control_points,default_check_in_schedule,safety_revision)
 SELECT route_id,revision+1,geometry,distance_km,ascent_m,duration_min,difficulty,season,min_people,max_group_size,required_guides,source_name,source_url,source_license,source_retrieved_at,now(),$2,'SAFETY INTEGRATION REVISION','high','pedestrian','1','required','test-territorial-unit','[{"name":"reserve exit"}]','[{"name":"checkpoint"}]','[{"name":"daily contact","offsetHour":12}]',2 FROM route_revisions WHERE id=$1 RETURNING id::text`, base.RouteRevisionID, admin).Scan(&revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE routes SET current_revision_id=$2 WHERE id=$1", base.RouteID, revision); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE departures SET status='cancelled' WHERE id=$1", base.ID); err != nil {
		t.Fatal(err)
	}
	d, err := s.CreateDeparture(ctx, guide.ID, store.CreateDeparture{RouteID: base.RouteID, RouteRevisionID: revision, StartsAt: time.Now().Add(2 * time.Hour), EndsAt: time.Now().Add(7 * time.Hour), TimeZone: "Europe/Moscow", MinPeople: 4, Capacity: 6})
	if err != nil {
		t.Fatal(err)
	}
	people := []domain.User{}
	for i := 0; i < 3; i++ {
		u := account(t, s, "safety-walker-"+string(rune('a'+i)), "tourist")
		people = append(people, u)
		d, err = s.Join(ctx, u.ID, d.ID, "safety-join-key-000"+string(rune('1'+i)), 0)
		if err != nil {
			t.Fatal(err)
		}
	}
	contacts := []domain.SafetyParticipantContact{{UserID: guide.ID, Phone: "+7 900 000-00-00"}}
	for i, u := range people {
		contacts = append(contacts, domain.SafetyParticipantContact{UserID: u.ID, Phone: "+7 900 000-00-0" + string(rune('1'+i))})
	}
	passport, err := s.PrepareSafetyPassport(ctx, guide.ID, d.ID, "safety-prepare-key-0001", domain.SafetyPrepareInput{LeaderPhone: "+7 900 000-00-00", EmergencyContactName: "Test contact", EmergencyContactPhone: "+7 900 000-00-99", CommunicationPlan: "Call before start and at checkpoint", Transport: "On foot", BackupRoute: "Return through reserve exit", Equipment: "Group and personal equipment", FirstAid: "Group first aid kit", Insurance: "Not applicable", Notes: "integration only", Participants: contacts})
	if err != nil {
		t.Fatal(err)
	}
	if passport.Status != "ready_to_submit" || passport.Version != 1 || passport.Private == nil {
		t.Fatalf("unexpected passport: %+v", passport)
	}
	var publicText string
	if err = s.Pool.QueryRow(ctx, "SELECT public_payload::text FROM safety_passport_versions WHERE departure_id=$1", d.ID).Scan(&publicText); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(publicText, "900 000") || strings.Contains(publicText, "Test contact") {
		t.Fatal("private safety data leaked into public JSON")
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE departures SET status='in_progress' WHERE id=$1", d.ID); err == nil {
		t.Fatal("database allowed required route start before confirmation")
	}
	passport, err = s.RecordMCHSSubmission(ctx, guide.ID, d.ID, "safety-submit-key-00001", domain.MCHSSubmissionInput{SubmissionID: "MCHS-TEST-001", SubmittedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	passport, err = s.ConfirmMCHSRegistration(ctx, admin, d.ID, "safety-confirm-key-0001", domain.MCHSConfirmationInput{ConfirmationRef: "operator checked test evidence"})
	if err != nil {
		t.Fatal(err)
	}
	passport, err = s.ConfirmMCHSStartContact(ctx, guide.ID, d.ID, "safety-contact-"+d.ID, domain.MCHSStartContactInput{ContactedAt: time.Now(), Note: "test call"})
	if err != nil {
		t.Fatal(err)
	}
	if passport.Status != "confirmed" {
		t.Fatalf("unexpected confirmed state: %s", passport.Status)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE departures SET status='in_progress' WHERE id=$1", d.ID); err != nil {
		t.Fatal("confirmed safety state was blocked", err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE safety_passport_versions SET public_payload='{}' WHERE departure_id=$1", d.ID); err == nil {
		t.Fatal("append-only passport was mutable")
	}
	if err = s.VerifySafetyEventChain(ctx, d.ID); err != nil {
		t.Fatal("event chain invalid", err)
	}
	outsider := account(t, s, "safety-outsider", "tourist")
	if _, err = s.EmergencyCard(ctx, outsider.ID, d.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatal("emergency card leaked to outsider", err)
	}
}

func TestConfirmedSafetyBecomesAmendmentRequiredWhenRosterChanges(t *testing.T) {
	s := db(t)
	s.SafetyKey = bytes.Repeat([]byte{3}, 32)
	ctx := context.Background()
	guide, d := fixture(t, s, 6)
	u := account(t, s, "safety-member", "tourist")
	d, err := s.Join(ctx, u.ID, d.ID, "safety-amend-join-001", 0)
	if err != nil {
		t.Fatal(err)
	}
	contacts := []domain.SafetyParticipantContact{{UserID: guide.ID, Phone: "+7 900 000-00-00"}, {UserID: u.ID, Phone: "+7 900 000-00-01"}}
	if _, err = s.PrepareSafetyPassport(ctx, guide.ID, d.ID, "safety-prepare-key-0001", domain.SafetyPrepareInput{LeaderPhone: "+7 900 000-00-00", EmergencyContactName: "Contact", EmergencyContactPhone: "+7 900 000-00-99", CommunicationPlan: "Daily contact", Transport: "On foot", BackupRoute: "Return", Equipment: "Equipment", FirstAid: "First aid", Insurance: "None", Participants: contacts}); err != nil {
		t.Fatal(err)
	}
	newMember := account(t, s, "safety-new-member", "tourist")
	if _, err = s.Join(ctx, newMember.ID, d.ID, "safety-amend-join-002", 0); err != nil {
		t.Fatal(err)
	}
	var status string
	if err = s.Pool.QueryRow(ctx, "SELECT status FROM departure_safety WHERE departure_id=$1", d.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "amendment_required" {
		t.Fatalf("roster change did not invalidate passport: %s", status)
	}
}
