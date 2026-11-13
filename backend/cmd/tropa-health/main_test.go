package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadinessUsesCustomPortAndRequiresDirectSuccess(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusServiceUnavailable, http.StatusFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/health/ready" {
					t.Error("probe requested a different endpoint")
				}
				if status == http.StatusFound {
					w.Header().Set("Location", "/misleading-success")
					if r.URL.Path == "/misleading-success" {
						w.WriteHeader(http.StatusOK)
						return
					}
				}
				w.WriteHeader(status)
			}))
			defer server.Close()
			if got := ready(strings.TrimPrefix(server.URL, "http://")); got != (status == http.StatusOK) {
				t.Fatal("readiness accepted an unhealthy/redirected result or ignored the custom port")
			}
		})
	}
	if ready("not-a-listener") {
		t.Fatal("malformed listener was reported healthy")
	}
}
