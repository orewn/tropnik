package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSafetyReadinessAndMutationAuthenticationFailClosed(t *testing.T) {
	server := &Server{limiter: &limiter{entries: map[string]window{}}}
	ready := httptest.NewRecorder()
	server.Handler().ServeHTTP(ready, httptest.NewRequest("GET", "/api/v1/health/ready", nil))
	if ready.Code != 503 || !strings.Contains(ready.Body.String(), "safety_not_configured") {
		t.Fatal("unconfigured safety reported ready", ready.Code)
	}
	for _, path := range []string{"safety-passport/prepare", "mchs/submission", "mchs/confirmation", "mchs/start-contact", "mchs/return-report", "safety-check-ins"} {
		response := httptest.NewRecorder()
		// Handler authentication terminates before inspecting any DB state or data.
		server.Handler().ServeHTTP(response, httptest.NewRequest("POST", "/api/v1/departures/fixture/"+path, strings.NewReader(`{"passportVersion":1}`)))
		if response.Code != 401 {
			t.Fatalf("%s accepted unauthenticated mutation: %d", path, response.Code)
		}
	}
}
