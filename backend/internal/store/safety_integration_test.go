//go:build integration

package store_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
	"tropa/backend/migrations"
)

func safetyFixture(t *testing.T, nearStart bool) (*store.Store, domain.User, string, domain.Departure, domain.SafetyPrepareInput) {
	t.Helper()
	s := db(t)
	s.SafetyKey = bytes.Repeat([]byte{9}, 32)
	ctx := context.Background()
	guide, base := fixture(t, s, 6)
	var admin, revision string
	if err := s.Pool.QueryRow(ctx, "SELECT id::text FROM users WHERE is_admin LIMIT 1").Scan(&admin); err != nil {
		t.Fatal(err)
	}
	err := s.Pool.QueryRow(ctx, `INSERT INTO route_revisions(route_id,revision,geometry,distance_km,ascent_m,duration_min,difficulty,season,min_people,max_group_size,required_guides,source_name,source_url,source_license,source_retrieved_at,reviewed_at,reviewed_by,review_evidence,mchs_notification_policy,emergency_exits,control_points)
 SELECT route_id,revision+1,geometry,distance_km,ascent_m,duration_min,difficulty,season,min_people,max_group_size,required_guides,source_name,source_url,source_license,source_retrieved_at,now(),$2,'SAFETY TEST ONLY','required','[{"name":"Test exit"}]','[{"name":"Test checkpoint"}]' FROM route_revisions WHERE id=$1 RETURNING id::text`, base.RouteRevisionID, admin).Scan(&revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE routes SET current_revision_id=$2 WHERE id=$1", base.RouteID, revision); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Mutate(ctx, guide.ID, base.ID, "cancel", "", base.Version); err != nil {
		t.Fatal(err)
	}
	delay := time.Hour
	if nearStart {
		delay = 2 * time.Second
	}
	d, err := s.CreateDeparture(ctx, guide.ID, store.CreateDeparture{RouteID: base.RouteID, RouteRevisionID: revision, StartsAt: time.Now().Add(delay), EndsAt: time.Now().Add(5 * time.Hour), TimeZone: "Europe/Moscow", MinPeople: 4, Capacity: 6})
	if err != nil {
		t.Fatal(err)
	}
	contacts := []domain.SafetyParticipantContact{{UserID: guide.ID, Phone: "+7 900 000-00-00"}}
	for i := 0; i < 3; i++ {
		u := account(t, s, fmt.Sprintf("safety-walker-%d", i), "tourist")
		d, err = s.Join(ctx, u.ID, d.ID, fmt.Sprintf("safety-join-key-%04d", i), 0)
		if err != nil {
			t.Fatal(err)
		}
		contacts = append(contacts, domain.SafetyParticipantContact{UserID: u.ID, Phone: fmt.Sprintf("+7 900 000-00-%02d", i+1)})
	}
	in := domain.SafetyPrepareInput{LeaderPhone: "+7 900 000-00-00", EmergencyContactName: "Test contact", EmergencyContactPhone: "+7 900 000-00-99", CommunicationPlan: "Test call schedule", Transport: "On foot", BackupRoute: "Test reserve exit", Equipment: "Test group equipment", FirstAid: "Test first aid kit", Insurance: "Not applicable", Participants: contacts}
	return s, guide, admin, d, in
}

func preparedSafety(t *testing.T, s *store.Store, guide, admin string, d domain.Departure, in domain.SafetyPrepareInput) domain.SafetyPassport {
	t.Helper()
	ctx := context.Background()
	p, err := s.PrepareSafetyPassport(ctx, guide, d.ID, "safety-prepare-key-0001", in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.RecordMCHSSubmission(ctx, guide, d.ID, "safety-submit-key-00001", domain.MCHSSubmissionInput{PassportVersion: p.Version, SubmissionID: "MCHS-TEST-001", SubmittedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ConfirmMCHSRegistration(ctx, admin, d.ID, "safety-confirm-key-0001", domain.MCHSConfirmationInput{PassportVersion: p.Version, ConfirmationRef: "operator checked test evidence"}); err != nil {
		t.Fatal(err)
	}
	p, err = s.ConfirmMCHSStartContact(ctx, guide, d.ID, "safety-contact-key-0001", domain.MCHSStartContactInput{PassportVersion: p.Version, ContactedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSafetyRequiredRouteAttendanceStartReturnAndEvidence(t *testing.T) {
	s, guide, admin, d, in := safetyFixture(t, true)
	ctx := context.Background()
	if _, err := s.Pool.Exec(ctx, "UPDATE departures SET status='in_progress' WHERE id=$1", d.ID); err == nil {
		t.Fatal("DB allowed required start without a passport")
	}
	p := preparedSafety(t, s, guide.ID, admin, d, in)
	if p.Status != "confirmed" || p.Private == nil {
		t.Fatalf("unexpected prepared state: %s", p.Status)
	}
	tourist := in.Participants[1].UserID
	public, err := s.SafetyPassport(ctx, tourist, d.ID)
	if err != nil || public.Private != nil {
		t.Fatal("participant received private passport", err)
	}
	var publicText, cipherText string
	if err = s.Pool.QueryRow(ctx, "SELECT public_payload::text,encode(payload_cipher,'escape') FROM safety_passport_versions WHERE departure_id=$1", d.ID).Scan(&publicText, &cipherText); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(publicText, "900 000") || strings.Contains(publicText, "Test contact") || strings.Contains(cipherText, "900 000") {
		t.Fatal("private contacts stored without encryption")
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE departures SET status='in_progress' WHERE id=$1", d.ID); err == nil {
		t.Fatal("DB allowed a registered member to be silently dropped at start")
	}
	for _, person := range in.Participants {
		d, err = s.Mutate(ctx, guide.ID, d.ID, "check-in", person.UserID, d.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	p, err = s.SafetyPassport(ctx, guide.ID, d.ID)
	if err != nil || p.Status != "confirmed" {
		t.Fatal("attendance/no-op upserts invalidated manifest", err, p.Status)
	}
	if wait := time.Until(d.StartsAt); wait > 0 {
		time.Sleep(wait)
	}
	d, err = s.Mutate(ctx, guide.ID, d.ID, "start", "", d.Version)
	if err != nil || d.SafetyStatus != "active" {
		t.Fatal("server blocked a fully verified start", err, d.SafetyStatus)
	}
	if _, err = s.ReportMCHSReturn(ctx, guide.ID, d.ID, "premature-return-key-01", domain.MCHSReturnReportInput{PassportVersion: p.Version, ReportedAt: time.Now(), Method: "test call"}); !errors.Is(err, domain.ErrNotReady) {
		t.Fatal("active trip closed before return", err)
	}
	lat, lng := 63.0, 33.0
	observation := domain.SafetyCheckInInput{Kind: "control_point", ObservedAt: time.Now(), Latitude: &lat, Longitude: &lng, Note: "TEST ONLY"}
	first, err := s.RecordSafetyCheckIn(ctx, guide.ID, d.ID, "safety-checkpoint-key-01", observation)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := s.RecordSafetyCheckIn(ctx, guide.ID, d.ID, "safety-checkpoint-key-01", observation)
	if err != nil || retry.ID != first.ID {
		t.Fatal("check-in retry duplicated observation", err)
	}
	d, err = s.Mutate(ctx, guide.ID, d.ID, "complete", "", d.Version)
	if err != nil || d.SafetyStatus != "return_report_pending" {
		t.Fatal("completion lost return-report requirement", err, d.SafetyStatus)
	}
	p, err = s.ReportMCHSReturn(ctx, guide.ID, d.ID, "safety-return-key-00001", domain.MCHSReturnReportInput{PassportVersion: p.Version, ReportedAt: time.Now(), Method: "test call"})
	if err != nil || p.Status != "closed" {
		t.Fatal("return report failed", err, p.Status)
	}
	for _, table := range []string{"safety_passport_versions", "safety_events", "safety_check_ins"} {
		if _, err = s.Pool.Exec(ctx, "DELETE FROM "+table+" WHERE departure_id=$1", d.ID); err == nil {
			t.Fatalf("%s evidence was deletable", table)
		}
	}
	if err = s.VerifySafetyEventChain(ctx, d.ID); err != nil {
		t.Fatal("invalid audit chain", err)
	}
	outsider := account(t, s, "safety-outsider", "tourist")
	if _, err = s.EmergencyCard(ctx, outsider.ID, d.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatal("private card leaked to outsider", err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE departure_safety SET event_sequence=event_sequence+1 WHERE departure_id=$1", d.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.VerifySafetyEventChain(ctx, d.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("audit did not detect a missing tail", err)
	}
}

func TestSafetyVersionedActionsAndIndependentConfirmation(t *testing.T) {
	s, guide, admin, d, in := safetyFixture(t, false)
	ctx := context.Background()
	p, err := s.PrepareSafetyPassport(ctx, guide.ID, d.ID, "safety-prepare-key-0001", in)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := s.PrepareSafetyPassport(ctx, guide.ID, d.ID, "safety-prepare-key-0001", in)
	if err != nil || retry.Version != p.Version {
		t.Fatal("prepare replay changed version", err)
	}
	if _, err = s.PrepareSafetyPassport(ctx, guide.ID, d.ID, "stale-prepare-key-001", in); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("stale client overwrote a newer version", err)
	}
	submit := domain.MCHSSubmissionInput{PassportVersion: 1, SubmissionID: "TEST-REF-001", SubmittedAt: time.Now()}
	if _, err = s.RecordMCHSSubmission(ctx, guide.ID, d.ID, "safety-submit-key-00001", submit); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE users SET is_admin=true WHERE id=$1", guide.ID); err != nil {
		t.Fatal(err)
	}
	confirmation := domain.MCHSConfirmationInput{PassportVersion: 1, ConfirmationRef: "operator checked fixture"}
	if _, err = s.ConfirmMCHSRegistration(ctx, guide.ID, d.ID, "self-confirm-key-0001", confirmation); !errors.Is(err, domain.ErrForbidden) {
		t.Fatal("guide approved own external evidence", err)
	}
	if _, err = s.ConfirmMCHSRegistration(ctx, in.Participants[1].UserID, d.ID, "tourist-confirm-key-01", confirmation); !errors.Is(err, domain.ErrForbidden) {
		t.Fatal("tourist approved evidence", err)
	}
	in.ExpectedVersion = 1
	p, err = s.PrepareSafetyPassport(ctx, guide.ID, d.ID, "safety-prepare-key-0002", in)
	if err != nil {
		t.Fatal(err)
	}
	submit.PassportVersion = 2
	submit.SubmittedAt = time.Now()
	if _, err = s.RecordMCHSSubmission(ctx, guide.ID, d.ID, "safety-submit-key-00002", submit); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ConfirmMCHSRegistration(ctx, admin, d.ID, "stale-confirm-key-0001", confirmation); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("old evidence confirmed a new passport", err)
	}
	if _, err = s.RecordSafetyCheckIn(ctx, guide.ID, d.ID, "too-early-check-in-001", domain.SafetyCheckInInput{Kind: "control_point", ObservedAt: time.Now()}); !errors.Is(err, domain.ErrNotReady) {
		t.Fatal("pre-start observation accepted as active", err)
	}
	p, err = s.SafetyPassport(ctx, guide.ID, d.ID)
	if err != nil || p.Version != 2 || p.ConfirmedAt != nil || p.StartContactConfirmedAt != nil {
		t.Fatal("new version retained old confirmation", err)
	}
}

func TestSafetyRosterAmendmentAndConcurrentConfirmation(t *testing.T) {
	s, guide, admin, d, in := safetyFixture(t, false)
	ctx := context.Background()
	preparedSafety(t, s, guide.ID, admin, d, in)
	d, err := s.Mutate(ctx, guide.ID, d.ID, "mark-absent", in.Participants[1].UserID, d.Version)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.SafetyPassport(ctx, guide.ID, d.ID)
	if err != nil || p.Status != "amendment_required" || p.ConfirmedAt != nil || p.StartContactConfirmedAt != nil {
		t.Fatal("real roster edit did not invalidate evidence", err)
	}
	if _, err = s.RecordMCHSSubmission(ctx, guide.ID, d.ID, "amended-submit-key-001", domain.MCHSSubmissionInput{PassportVersion: 1, SubmissionID: "OLD-REF-001", SubmittedAt: time.Now()}); !errors.Is(err, domain.ErrNotReady) {
		t.Fatal("amendment reused old version", err)
	}
	d, err = s.Mutate(ctx, guide.ID, d.ID, "check-in", in.Participants[1].UserID, d.Version)
	if err != nil {
		t.Fatal("could not correct absent attendance", err)
	}
	in.ExpectedVersion = 1
	p, err = s.PrepareSafetyPassport(ctx, guide.ID, d.ID, "safety-prepare-key-0002", in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.RecordMCHSSubmission(ctx, guide.ID, d.ID, "safety-submit-key-00002", domain.MCHSSubmissionInput{PassportVersion: 2, SubmissionID: "TEST-REF-002", SubmittedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	newMember := account(t, s, "concurrent-safety-join", "tourist")
	var wg sync.WaitGroup
	wg.Add(2)
	results := make(chan error, 2)
	go func() {
		defer wg.Done()
		_, e := s.Join(ctx, newMember.ID, d.ID, "safety-concurrent-join-01", 0)
		results <- e
	}()
	go func() {
		defer wg.Done()
		_, e := s.ConfirmMCHSRegistration(ctx, admin, d.ID, "safety-concurrent-confirm-01", domain.MCHSConfirmationInput{PassportVersion: 2, ConfirmationRef: "checked version two"})
		results <- e
	}()
	wg.Wait()
	close(results)
	for e := range results {
		if e != nil && !errors.Is(e, domain.ErrConflict) {
			t.Fatal("concurrent action failed unexpectedly", e)
		}
	}
	p, err = s.SafetyPassport(ctx, guide.ID, d.ID)
	if err != nil || p.Status != "amendment_required" {
		t.Fatal("confirmation race approved a changed manifest", err, p.Status)
	}
	if err = s.VerifySafetyEventChain(ctx, d.ID); err != nil {
		t.Fatal("trigger amendment broke audit chain", err)
	}
}

func TestRestrictedRuntimeSafetyLifecycleRenewsExpiredContact(t *testing.T) {
	s, guide, admin, d, in := safetyFixture(t, true)
	ctx := context.Background()
	secretBytes := make([]byte, 24)
	if _, err := rand.Read(secretBytes); err != nil {
		t.Fatal(err)
	}
	secret := hex.EncodeToString(secretBytes)
	role := pgx.Identifier{"tropa_safety_" + secret[:12]}.Sanitize()
	if _, err := s.Pool.Exec(ctx, "CREATE ROLE "+role+" LOGIN PASSWORD '"+secret+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION"); err != nil {
		t.Fatal(err)
	}
	if err := migrations.GrantRuntime(ctx, s.Pool, "tropa_safety_"+secret[:12]); err != nil {
		t.Fatal(err)
	}
	cfg := s.Pool.Config()
	cfg.ConnConfig.User = "tropa_safety_" + secret[:12]
	cfg.ConnConfig.Password = secret
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	app := &store.Store{Pool: pool, SafetyKey: s.SafetyKey}
	t.Cleanup(func() {
		app.Close()
		if _, err := s.Pool.Exec(ctx, "DROP OWNED BY "+role); err != nil {
			t.Error(err)
		}
		if _, err := s.Pool.Exec(ctx, "DROP ROLE "+role); err != nil {
			t.Error(err)
		}
	})
	p := preparedSafety(t, app, guide.ID, admin, d, in)
	for _, person := range in.Participants {
		d, err = app.Mutate(ctx, guide.ID, d.ID, "check-in", person.UserID, d.Version)
		if err != nil {
			t.Fatal("runtime attendance update failed", err)
		}
	}
	// Model a delayed departure without waiting a full day. The original call
	// stays recorded, but it must not continue to authorize a new start.
	if _, err = s.Pool.Exec(ctx, "UPDATE departure_safety SET start_contact_confirmed_at=now()-interval '25 hours' WHERE departure_id=$1", d.ID); err != nil {
		t.Fatal(err)
	}
	view, err := app.Departure(ctx, d.ID, guide.ID)
	if err != nil || view.StartContactConfirmed {
		t.Fatal("expired contact remained ready in the public read model", err)
	}
	if _, err = app.Mutate(ctx, guide.ID, d.ID, "start", "", d.Version); !errors.Is(err, domain.ErrNotReady) {
		t.Fatal("expired contact did not return a recoverable start error", err)
	}
	if _, err = app.Pool.Exec(ctx, "UPDATE departures SET status='in_progress' WHERE id=$1", d.ID); err == nil {
		t.Fatal("database allowed an expired contact to authorize a start")
	}
	if _, err = app.ConfirmMCHSStartContact(ctx, guide.ID, d.ID, "renew-expired-contact-01", domain.MCHSStartContactInput{PassportVersion: p.Version, ContactedAt: time.Now()}); err != nil {
		t.Fatal("runtime could not renew contact", err)
	}
	if wait := time.Until(d.StartsAt); wait > 0 {
		time.Sleep(wait)
	}
	d, err = app.Mutate(ctx, guide.ID, d.ID, "start", "", d.Version)
	if err != nil || !d.StartContactConfirmed || d.SafetyStatus != "active" {
		t.Fatal("runtime could not start verified group", err)
	}
	card, err := app.EmergencyCard(ctx, in.Participants[1].UserID, d.ID)
	if err != nil || card.LeaderPhone != in.LeaderPhone || card.EmergencyNumber != "112" {
		t.Fatal("runtime participant emergency card unavailable", err)
	}
	if _, err = app.RecordSafetyCheckIn(ctx, guide.ID, d.ID, "runtime-safety-check-in-01", domain.SafetyCheckInInput{Kind: "control_point", ObservedAt: time.Now()}); err != nil {
		t.Fatal("runtime check-in failed", err)
	}
	d, err = app.Mutate(ctx, guide.ID, d.ID, "complete", "", d.Version)
	if err != nil || d.SafetyStatus != "return_report_pending" {
		t.Fatal("runtime completion lost return reporting", err)
	}
	if _, err = app.ReportMCHSReturn(ctx, guide.ID, d.ID, "runtime-return-report-01", domain.MCHSReturnReportInput{PassportVersion: p.Version, ReportedAt: time.Now(), Method: "test call"}); err != nil {
		t.Fatal("runtime could not close return report", err)
	}
	for _, table := range []string{"safety_passport_versions", "safety_events", "safety_check_ins"} {
		if _, err = app.Pool.Exec(ctx, "DELETE FROM "+table+" WHERE departure_id=$1", d.ID); err == nil {
			t.Fatalf("runtime could delete %s evidence", table)
		}
	}
	if err = app.VerifySafetyEventChain(ctx, d.ID); err != nil {
		t.Fatal("runtime lifecycle produced an invalid evidence chain", err)
	}
}
