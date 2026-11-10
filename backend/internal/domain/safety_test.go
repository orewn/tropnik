package domain

import "testing"

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
	if SafetyStartAllowed("unknown", "confirmed", true) {
		t.Fatal("unknown notification policy must fail closed")
	}
}
