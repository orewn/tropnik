package auth

import (
	"bytes"
	"strings"
	"testing"
)

func TestServerKeysAreStrictAndErrorsDoNotDiscloseValues(t *testing.T) {
	for _, value := range []string{"", "PRIVATE-VALUE", strings.Repeat("x", 64), strings.Repeat("a", 63), strings.Repeat("a", 65), " " + strings.Repeat("a", 64)} {
		if _, err := ParseServerKey(value); err == nil || strings.Contains(err.Error(), "PRIVATE-VALUE") {
			t.Fatal("invalid key accepted or exposed")
		}
	}
	lower, err := ParseServerKey(strings.Repeat("ab", 32))
	if err != nil || len(lower) != 32 {
		t.Fatal("valid key rejected", err)
	}
	upper, _ := ParseServerKey(strings.Repeat("AB", 32))
	if !bytes.Equal(lower, upper) {
		t.Fatal("hexadecimal case changed the key")
	}
}

func TestRateIdentityIsStableAndSeparatedByKeyAndScope(t *testing.T) {
	key := bytes.Repeat([]byte{1}, 32)
	first := RateIdentity(key, "login_account", "person@example.invalid")
	if first != RateIdentity(append([]byte(nil), key...), "login_account", "person@example.invalid") {
		t.Fatal("replicas using the same key would disagree")
	}
	if first == RateIdentity(key, "auth_ip", "person@example.invalid") || first == RateIdentity(bytes.Repeat([]byte{2}, 32), "login_account", "person@example.invalid") || first == RateIdentity(key, "login_account", "other@example.invalid") {
		t.Fatal("scope, key or account separation failed")
	}
}
