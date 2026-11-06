package main

import (
	"strings"
	"testing"
)

func TestProductionRejectsUnsafeDefaultsBeforeConnecting(t *testing.T) {
	cases := []struct{ name, mode, origin, dsn, demo, want string }{
		{"no database", "production", "https://tropa.example", "", "", "DATABASE_URL"},
		{"plaintext web", "production", "http://tropa.example", "postgres://tropa_app:unique-long-password-for-tests@db/tropa", "", "HTTPS"},
		{"weak database password", "production", "https://tropa.example", "postgres://tropa_app:postgres@db/tropa", "", "credential"},
		{"unverified external database", "production", "https://tropa.example", "postgres://tropa_app:unique-long-password-for-tests@db/tropa?sslmode=require", "", "verify-full"},
		{"demo flag", "production", "https://tropa.example", "postgres://tropa_app:unique-long-password-for-tests@db/tropa", "true", "demo fixtures"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("APP_ENV", c.mode)
			t.Setenv("PUBLIC_ORIGIN", c.origin)
			t.Setenv("DATABASE_URL", c.dsn)
			t.Setenv("DEMO_MODE", c.demo)
			t.Setenv("TRUST_PRIVATE_DATABASE_NETWORK", "")
			t.Setenv("TRUSTED_PROXY_CIDRS", "")
			e := run()
			if e == nil || !strings.Contains(e.Error(), c.want) {
				t.Fatalf("want %q, got %v", c.want, e)
			}
		})
	}
}

func TestProductionRejectsMissingRateKeyAndPartialProxyTrust(t *testing.T) {
	for _, tc := range []struct{ key, token, peers, want string }{
		{"", "", "", "TROPA_AUTH_RATE_KEY"},
		{strings.Repeat("ab", 32), "", "127.0.0.1/32", "TROPA_PROXY_TOKEN"},
		{strings.Repeat("ab", 32), strings.Repeat("cd", 32), "", "TRUSTED_PROXY_CIDRS"},
		{strings.Repeat("ab", 32), "private-invalid-token", "127.0.0.1/32", "TROPA_PROXY_TOKEN"},
		{strings.Repeat("ab", 32), strings.Repeat("ab", 32), "127.0.0.1/32", "independent"},
	} {
		t.Setenv("APP_ENV", "production")
		t.Setenv("PUBLIC_ORIGIN", "https://tropa.example")
		t.Setenv("DATABASE_URL", "postgres://tropa_app:unique-long-password-for-tests@db/tropa?sslmode=verify-full")
		t.Setenv("DEMO_MODE", "")
		t.Setenv("TRUSTED_PROXY_CIDRS", tc.peers)
		t.Setenv("TROPA_AUTH_RATE_KEY", tc.key)
		t.Setenv("TROPA_PROXY_TOKEN", tc.token)
		err := run()
		if err == nil || !strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "private-invalid-token") {
			t.Fatalf("expected safe early configuration error containing %s, got %v", tc.want, err)
		}
	}
}
