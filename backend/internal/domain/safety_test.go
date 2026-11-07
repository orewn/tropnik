package domain

import (
	"testing"
	"time"
)

func TestMCHSSubmissionDeadlineSkipsWeekends(t *testing.T) {
	start := time.Date(2026, time.November, 23, 9, 0, 0, 0, time.UTC) // Monday
	got := MCHSSubmissionDeadline(start)
	want := time.Date(2026, time.November, 9, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("deadline=%s want=%s", got, want)
	}
}
func TestRequiredSafetyCannotStartWithoutConfirmationAndContact(t *testing.T) {
	if SafetyStartAllowed("required", "confirmed", false) {
		t.Fatal("required route started without pre-start contact")
	}
	if SafetyStartAllowed("required", "start_contact_pending", true) {
		t.Fatal("pending external confirmation was accepted")
	}
	if !SafetyStartAllowed("required", "confirmed", true) {
		t.Fatal("confirmed required route was blocked")
	}
	if !SafetyStartAllowed("recommended", "recommended", false) {
		t.Fatal("recommended notification unexpectedly blocked start")
	}
}
