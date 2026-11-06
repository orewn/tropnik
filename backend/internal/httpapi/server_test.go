package httpapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"tropa/backend/internal/auth"
	"tropa/backend/internal/store"
)

type budgetFunc func(context.Context, string, [32]byte) (store.AuthAttempt, error)

func (f budgetFunc) ConsumeAuthAttempt(ctx context.Context, scope string, key [32]byte) (store.AuthAttempt, error) {
	return f(ctx, scope, key)
}

func testServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	cfg.AuthRateKey = bytes.Repeat([]byte{1}, 32)
	s, err := New(nil, cfg)
	if err != nil {
		t.Fatal(err)
	}
	s.authBudget = budgetFunc(func(context.Context, string, [32]byte) (store.AuthAttempt, error) {
		return store.AuthAttempt{Allowed: true, RetryAfter: 60}, nil
	})
	return s
}

func TestForwardedAddressRequiresExplicitProxyTrust(t *testing.T) {
	proof := bytes.Repeat([]byte{2}, 32)
	s := &Server{cfg: Config{TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}, ProxyToken: proof}}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "203.0.113.10:1234"
	r.Header.Set("X-Real-IP", "198.51.100.4")
	r.Header.Set("X-Tropa-Proxy-Token", hex.EncodeToString(proof))
	if s.clientIP(r) != "203.0.113.10" {
		t.Fatal("untrusted forwarded address accepted")
	}
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Del("X-Tropa-Proxy-Token")
	if s.clientIP(r) != "127.0.0.1" {
		t.Fatal("trusted peer without ingress proof was accepted")
	}
	r.Header.Set("X-Tropa-Proxy-Token", strings.Repeat("ab", 32))
	if s.clientIP(r) != "127.0.0.1" {
		t.Fatal("forged ingress proof accepted")
	}
	r.Header.Set("X-Tropa-Proxy-Token", hex.EncodeToString(proof))
	if s.clientIP(r) != "198.51.100.4" {
		t.Fatal("trusted proxy ignored")
	}
	r.Header.Set("X-Real-IP", "198.51.100.4, 198.51.100.5")
	if s.clientIP(r) != "127.0.0.1" {
		t.Fatal("ambiguous address chain accepted")
	}
	r.Header.Set("X-Real-IP", "::ffff:198.51.100.4")
	if s.clientIP(r) != "198.51.100.4" {
		t.Fatal("IPv4-mapped address did not share the canonical bucket")
	}
	r.Header.Add("X-Real-IP", "198.51.100.5")
	if s.clientIP(r) != "127.0.0.1" {
		t.Fatal("duplicate address header accepted")
	}
	r.Header.Set("X-Real-IP", "fe80::1%local")
	if s.clientIP(r) != "127.0.0.1" {
		t.Fatal("zone-bearing forwarded address accepted")
	}
	s.cfg.ProxyToken = nil
	r.Header.Set("X-Real-IP", "198.51.100.4")
	if s.clientIP(r) != "127.0.0.1" {
		t.Fatal("unset proxy secret opened forwarding trust")
	}
}

func TestPrivateEndpointsDenyMissingOrForgedSessions(t *testing.T) {
	s := testServer(t, Config{Origins: []string{"https://tropa.example"}})
	h := s.Handler()
	for _, tc := range []struct{ method, path string }{{"GET", "/api/v1/me"}, {"POST", "/api/v1/departures/123/join"}, {"GET", "/api/v1/departures/123/messages"}, {"POST", "/api/v1/departures/123/reviews"}, {"POST", "/api/v1/sync/observations"}, {"POST", "/api/v1/recruitment-requests"}, {"GET", "/api/v1/me/summary"}, {"POST", "/api/v1/reports"}, {"GET", "/api/v1/moderation/reports"}, {"POST", "/api/v1/moderation/reports/123/resolve"}, {"POST", "/api/v1/moderation-actions/123/appeals"}, {"POST", "/api/v1/moderation/appeals/123/resolve"}} {
		for _, header := range []string{"", "Bearer guide", "Bearer ../../admin"} {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			if header != "" {
				r.Header.Set("Authorization", header)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 401 {
				t.Fatalf("%s %s: %d", tc.method, tc.path, w.Code)
			}
		}
	}
}
func TestCORSRejectsUnapprovedOrigin(t *testing.T) {
	s := testServer(t, Config{Origins: []string{"https://tropa.example"}})
	r := httptest.NewRequest("GET", "/api/v1/health/live", nil)
	r.Header.Set("Origin", "https://attacker.example")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 403 || w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unapproved origin accepted")
	}
}
func TestStrictJSONRejectsExtraAndTrailingPayloads(t *testing.T) {
	for _, body := range []string{`{"email":"a","isAdmin":true}`, `{"email":"a"} {"email":"b"}`} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		var x struct {
			Email string `json:"email"`
		}
		if decode(w, r, &x) || w.Code != http.StatusBadRequest {
			t.Fatal("unknown or trailing payload accepted")
		}
	}
}
func TestSelfVerificationCannotBeRequestedInRegistration(t *testing.T) {
	s := testServer(t, Config{})
	r := httptest.NewRequest("POST", "/api/v1/auth/register", strings.NewReader(`{"email":"a@example.org","password":"very strong long password","displayName":"Путник","role":"guide","guideStatus":"verified"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("self verification accepted: %d", w.Code)
	}
}

func TestRegistrationRejectsStaffRoleClaims(t *testing.T) {
	s := testServer(t, Config{})
	r := httptest.NewRequest("POST", "/api/v1/auth/register", strings.NewReader(`{"email":"staff@example.invalid","password":"a sufficiently long password","displayName":"Test user","role":"tourist","staffRole":"admin"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("self-assigned staff role was not rejected: %d", w.Code)
	}
}

func TestSecurityConfigurationRejectsPartialTrustAndUnstableKeys(t *testing.T) {
	key := bytes.Repeat([]byte{1}, 32)
	proof := bytes.Repeat([]byte{2}, 32)
	peer := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	for _, cfg := range []Config{
		{},
		{AuthRateKey: key[:31]},
		{AuthRateKey: key, ProxyToken: proof},
		{AuthRateKey: key, TrustedProxyCIDRs: peer},
		{AuthRateKey: key, ProxyToken: key, TrustedProxyCIDRs: peer},
		{AuthRateKey: key, ProxyToken: proof, TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0")}},
	} {
		if err := cfg.Validate(); err == nil {
			t.Fatal("unsafe configuration accepted")
		}
	}
	for _, cfg := range []Config{{AuthRateKey: key}, {AuthRateKey: key, ProxyToken: proof, TrustedProxyCIDRs: peer}} {
		if err := cfg.Validate(); err != nil {
			t.Fatal("complete configuration rejected", err)
		}
	}
}

func TestAuthStorageFailureAndRateDenialFailClosed(t *testing.T) {
	for _, unavailable := range []bool{true, false} {
		s := testServer(t, Config{})
		s.authBudget = budgetFunc(func(context.Context, string, [32]byte) (store.AuthAttempt, error) {
			if unavailable {
				return store.AuthAttempt{}, errors.New("private-storage-detail")
			}
			return store.AuthAttempt{Allowed: false, RetryAfter: 37}, nil
		})
		r := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"email":"person@example.invalid","password":"test-only"}`))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		want := 429
		if unavailable {
			want = 503
		}
		if w.Code != want || len(s.authSlots) != 0 || strings.Contains(w.Body.String(), "private-storage-detail") {
			t.Fatalf("auth guard did not stop safely: status %d", w.Code)
		}
		if !unavailable && w.Header().Get("Retry-After") != "37" {
			t.Fatal("rate retry delay lost")
		}
	}
}

func TestBFFClientsSeparateIPBucketsAndNormalizeAccountIdentity(t *testing.T) {
	proof := bytes.Repeat([]byte{2}, 32)
	s := testServer(t, Config{ProxyToken: proof, TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}})
	var ips, accounts [][32]byte
	s.authBudget = budgetFunc(func(_ context.Context, scope string, key [32]byte) (store.AuthAttempt, error) {
		if scope == store.AuthIPScope {
			ips = append(ips, key)
			return store.AuthAttempt{Allowed: true, RetryAfter: 60}, nil
		}
		accounts = append(accounts, key)
		return store.AuthAttempt{Allowed: false, RetryAfter: 60}, nil
	})
	for i, email := range []string{"  Person@Example.Invalid  ", "person@example.invalid"} {
		r := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"email":"`+email+`","password":"test-only"}`))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Tropa-Proxy-Token", hex.EncodeToString(proof))
		r.Header.Set("X-Real-IP", []string{"198.51.100.4", "198.51.100.5"}[i])
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 429 {
			t.Fatalf("account budget did not stop credentials lookup: %d", w.Code)
		}
	}
	if len(ips) != 2 || ips[0] == ips[1] || len(accounts) != 2 || accounts[0] != accounts[1] {
		t.Fatal("BFF clients collapsed or equivalent accounts bypassed the shared budget")
	}
	if accounts[0] != auth.RateIdentity(s.cfg.AuthRateKey, store.LoginAccountScope, "person@example.invalid") {
		t.Fatal("unkeyed or noncanonical identity used")
	}
}
