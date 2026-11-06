package auth

import (
	"crypto/sha256"
	"net/url"
	"strings"
	"testing"
)

func TestAccountActionTokenEntropyDigestAndCanonicalEncoding(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		raw, digest, err := AccountActionToken()
		if err != nil || len(raw) != 43 || seen[raw] {
			t.Fatal("invalid or repeated secret", err)
		}
		seen[raw] = true
		parsed, err := AccountActionDigest(raw)
		if err != nil || parsed != digest || digest != sha256.Sum256([]byte(raw)) {
			t.Fatal("incorrect digest", err)
		}
	}
	for _, raw := range []string{"", strings.Repeat("A", 42), strings.Repeat("A", 44), strings.Repeat("A", 42) + "B", strings.Repeat("A", 42) + "=", strings.Repeat("A", 42) + "\n"} {
		if _, err := AccountActionDigest(raw); err == nil {
			t.Fatal("noncanonical token accepted")
		}
	}
}

func TestAccountActionLinkHasConfiguredHTTPSOriginAndFragmentOnlySecret(t *testing.T) {
	raw, _, _ := AccountActionToken()
	link, err := AccountActionURL("https://tropnik.example/tropnik/account/action/", "reset_password", raw)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(link)
	if err != nil || u.Host != "tropnik.example" || u.Path != "/tropnik/account/action/" || u.RawQuery != "" {
		t.Fatal("link target drift", err)
	}
	fragment, err := url.ParseQuery(u.Fragment)
	if err != nil || fragment.Get("token") != raw || fragment.Get("action") != "reset_password" {
		t.Fatal("secret missing from fragment", err)
	}
	for _, base := range []string{"http://localhost/account/action", "https://user:password@tropnik.example/account/action", "https://tropnik.example/account/action?token=x", "https://tropnik.example/account/action#old", "//tropnik.example/account/action", "javascript:alert(1)", "https:///account/action"} {
		if _, err = AccountActionURL(base, "verify_email", raw); err == nil {
			t.Fatalf("unsafe target accepted: %s", base)
		}
	}
	if _, err = AccountActionURL("https://tropnik.example/account/action", "session", raw); err == nil {
		t.Fatal("unsupported purpose")
	}
}
