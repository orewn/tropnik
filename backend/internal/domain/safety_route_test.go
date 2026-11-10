package domain

import (
	"math"
	"testing"
)

func TestSafetyRouteImportRejectsUnknownPoliciesAndInvalidPointGeometry(t *testing.T) {
	for _, route := range []Route{
		{MCHSNotificationPolicy: "optional-ish"}, {RiskClass: "invented"}, {RouteType: "unknown"},
		{EmergencyExits: []SafetyPoint{{Name: "Test", Latitude: floatPointer(30)}}},
		{EmergencyExits: []SafetyPoint{{Name: "Test", Latitude: floatPointer(math.NaN()), Longitude: floatPointer(30)}}},
		{DefaultCheckInSchedule: []SafetyCheckInRule{{Name: "Test", At: "tomorrow"}}},
	} {
		if NormalizeRouteSafety(&route) == nil {
			t.Fatal("invalid safety metadata accepted")
		}
	}
	route := Route{}
	if err := NormalizeRouteSafety(&route); err != nil {
		t.Fatal(err)
	}
	if route.MCHSNotificationPolicy != "recommended" || route.EmergencyExits == nil || route.ControlPoints == nil {
		t.Fatal("import defaults incomplete")
	}
	if ValidNotificationPolicy("") {
		t.Fatal("publication must choose an explicit policy")
	}
}
func floatPointer(value float64) *float64 { return &value }
