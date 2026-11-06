package auth

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestPasswordRoundTripSaltAndTamper(t *testing.T) {
	p := "correct horse trail battery"
	a, e := HashPassword(p)
	if e != nil {
		t.Fatal(e)
	}
	b, e := HashPassword(p)
	if e != nil {
		t.Fatal(e)
	}
	if a == b {
		t.Fatal("missing random salt")
	}
	if !VerifyPassword(a, p) || VerifyPassword(a, p+"!") {
		t.Fatal("password verification failure")
	}
	for _, bad := range []string{"", a + "bad", strings.Replace(a, "600000", "1", 1), strings.Replace(a, "600000", "999999999", 1)} {
		if VerifyPassword(bad, p) {
			t.Fatal("malformed hash accepted")
		}
	}
}
func TestPasswordBoundsAndTokenEntropy(t *testing.T) {
	if _, e := HashPassword("short"); e == nil {
		t.Fatal("short password accepted")
	}
	if _, e := HashPassword(strings.Repeat("x", 129)); e == nil {
		t.Fatal("oversize accepted")
	}
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		x, e := SessionToken()
		if e != nil {
			t.Fatal(e)
		}
		raw, e := base64.RawURLEncoding.DecodeString(x)
		if e != nil || len(raw) != 32 || seen[x] {
			t.Fatal("invalid session token")
		}
		seen[x] = true
	}
}
