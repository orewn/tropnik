package auth

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

const accountMailFixtureJob = "00000000-0000-4000-8000-000000000001"

func mailCipherFixture(t *testing.T, marker byte) *AccountMailCipher {
	t.Helper()
	c, err := NewAccountMailCipher(bytes.Repeat([]byte{marker}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func mailCipherDeadline() time.Time { return time.Date(2030, 2, 3, 4, 5, 6, 123456000, time.UTC) }

func TestAccountMailCipherSurvivesRestartWithIndependentSubkeys(t *testing.T) {
	master := bytes.Repeat([]byte{0x15}, 32) // disposable fixture, never a deployment key
	first, err := NewAccountMailCipher(master)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewAccountMailCipher(append([]byte(nil), master...))
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte(`{"To":"person@example.invalid","Text":"token=PRIVATE-FIXTURE","MessageID":"fixed"}`)
	deadline := mailCipherDeadline()
	encrypted, nonce, err := first.Seal(accountMailFixtureJob, "verify_email", deadline, plain)
	if err != nil {
		t.Fatal(err)
	}
	if len(nonce) != 12 || len(encrypted) != len(plain)+16 || bytes.Contains(encrypted, []byte("person@example.invalid")) || bytes.Contains(encrypted, []byte("PRIVATE-FIXTURE")) {
		t.Fatal("unexpected or plaintext outbox representation")
	}
	opened, err := second.Open(accountMailFixtureJob, "verify_email", deadline, encrypted, nonce)
	if err != nil || !bytes.Equal(opened, plain) {
		t.Fatal("persisted mail could not be recovered by a fresh process", err)
	}
	identity, err := hex.DecodeString(first.KeyID())
	if err != nil || len(identity) != 32 || first.KeyID() != second.KeyID() || bytes.Equal(identity, master) {
		t.Fatal("invalid or unstable nonsecret key fingerprint")
	}
	recipient := first.RecipientKey("person@example.invalid")
	if recipient != second.RecipientKey("person@example.invalid") || recipient == first.RecipientKey("other@example.invalid") || recipient == mailCipherFixture(t, 0x16).RecipientKey("person@example.invalid") {
		t.Fatal("recipient index is not stable and key-separated")
	}
	publicDigest := sha256.Sum256([]byte("person@example.invalid"))
	rawMAC := hmac.New(sha256.New, master)
	_, _ = rawMAC.Write([]byte("tropnik-account-mail-recipient-v1\x00person@example.invalid"))
	if recipient == publicDigest || bytes.Equal(recipient[:], rawMAC.Sum(nil)) || bytes.Equal(identity, recipient[:]) {
		t.Fatal("recipient index or fingerprint reused an inappropriate key")
	}
	// The master is not an AES key: the cipher uses a domain-separated subkey.
	block, _ := aes.NewCipher(master)
	direct, _ := cipher.NewGCM(block)
	aad, _ := accountMailAAD(accountMailFixtureJob, "verify_email", deadline)
	if _, err = direct.Open(nil, nonce, encrypted, aad); err == nil {
		t.Fatal("raw master key was used directly for encryption")
	}
	clear(master)
	if second.KeyID() != first.KeyID() || recipient != first.RecipientKey("person@example.invalid") {
		t.Fatal("cipher retained its caller's mutable master-key buffer")
	}
	other, otherNonce, err := first.Seal(accountMailFixtureJob, "verify_email", deadline, plain)
	if err != nil || bytes.Equal(nonce, otherNonce) || bytes.Equal(encrypted, other) {
		t.Fatal("separate seals reused a nonce or ciphertext", err)
	}
	if opened, err = second.Open(accountMailFixtureJob, "verify_email", deadline, other, otherNonce); err != nil || !bytes.Equal(opened, plain) {
		t.Fatal("clearing the caller's key changed the cipher", err)
	}
}

func TestAccountMailCipherRejectsTamperingAndContextSubstitution(t *testing.T) {
	c := mailCipherFixture(t, 0x21)
	deadline := mailCipherDeadline()
	plain := []byte("person@example.invalid PRIVATE-TOKEN")
	encrypted, nonce, err := c.Seal(accountMailFixtureJob, "reset_password", deadline, plain)
	if err != nil {
		t.Fatal(err)
	}
	changed := func(input []byte, at int) []byte {
		result := append([]byte(nil), input...)
		result[at] ^= 1
		return result
	}
	for _, tc := range []struct {
		name       string
		cipher     *AccountMailCipher
		jobID      string
		purpose    string
		deadline   time.Time
		ciphertext []byte
		nonce      []byte
	}{
		{"payload", c, accountMailFixtureJob, "reset_password", deadline, changed(encrypted, 0), nonce},
		{"tag", c, accountMailFixtureJob, "reset_password", deadline, changed(encrypted, len(encrypted)-1), nonce},
		{"truncated", c, accountMailFixtureJob, "reset_password", deadline, encrypted[:len(encrypted)-1], nonce},
		{"extended", c, accountMailFixtureJob, "reset_password", deadline, append(append([]byte(nil), encrypted...), 0), nonce},
		{"nonce", c, accountMailFixtureJob, "reset_password", deadline, encrypted, changed(nonce, 0)},
		{"short-nonce", c, accountMailFixtureJob, "reset_password", deadline, encrypted, nonce[:11]},
		{"long-nonce", c, accountMailFixtureJob, "reset_password", deadline, encrypted, append(append([]byte(nil), nonce...), 0)},
		{"different-job", c, "00000000-0000-4000-8000-000000000002", "reset_password", deadline, encrypted, nonce},
		{"different-purpose", c, accountMailFixtureJob, "verify_email", deadline, encrypted, nonce},
		{"different-expiry", c, accountMailFixtureJob, "reset_password", deadline.Add(time.Microsecond), encrypted, nonce},
		{"wrong-key", mailCipherFixture(t, 0x22), accountMailFixtureJob, "reset_password", deadline, encrypted, nonce},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opened, err := tc.cipher.Open(tc.jobID, tc.purpose, tc.deadline, tc.ciphertext, tc.nonce)
			if !errors.Is(err, errAccountMailCipher) || opened != nil || strings.Contains(err.Error(), "PRIVATE-TOKEN") || strings.Contains(err.Error(), "person@example.invalid") {
				t.Fatal("tampered envelope returned content or sensitive diagnostics", err)
			}
		})
	}
	// A timezone is presentation, not a different expiration instant.
	opened, err := c.Open(accountMailFixtureJob, "reset_password", deadline.In(time.FixedZone("fixture", 3*60*60)), encrypted, nonce)
	if err != nil || !bytes.Equal(opened, plain) {
		t.Fatal("equivalent timestamp representations did not round-trip", err)
	}
}

func TestAccountMailCipherBoundsInputsBeforeEncryptionOrDecryption(t *testing.T) {
	for _, length := range []int{0, 16, 31, 33, 64} {
		if c, err := NewAccountMailCipher(bytes.Repeat([]byte{'X'}, length)); err == nil || c != nil {
			t.Fatal("accepted an invalid master-key length")
		}
	}
	c := mailCipherFixture(t, 0x31)
	deadline := mailCipherDeadline()
	for _, tc := range []struct {
		jobID    string
		purpose  string
		deadline time.Time
		plain    []byte
	}{
		{"", "verify_email", deadline, []byte("mail")},
		{"00000000-0000-4000-8000-00000000000\x00", "verify_email", deadline, []byte("mail")},
		{accountMailFixtureJob, "other", deadline, []byte("mail")},
		{accountMailFixtureJob, "verify_email\x00suffix", deadline, []byte("mail")},
		{accountMailFixtureJob, "verify_email", time.Time{}, []byte("mail")},
		{accountMailFixtureJob, "verify_email", deadline.Add(time.Nanosecond), []byte("mail")},
		{accountMailFixtureJob, "verify_email", deadline, nil},
		{accountMailFixtureJob, "verify_email", deadline, make([]byte, maxAccountMailPlaintextBytes+1)},
	} {
		if encrypted, nonce, err := c.Seal(tc.jobID, tc.purpose, tc.deadline, tc.plain); err == nil || encrypted != nil || nonce != nil {
			t.Fatal("invalid encryption input was accepted")
		}
	}
	plain := bytes.Repeat([]byte{'m'}, maxAccountMailPlaintextBytes)
	encrypted, nonce, err := c.Seal(accountMailFixtureJob, "password_changed", deadline, plain)
	if err != nil {
		t.Fatal("maximum supported message was rejected", err)
	}
	if got, err := c.Open(accountMailFixtureJob, "password_changed", deadline, encrypted, nonce); err != nil || !bytes.Equal(got, plain) {
		t.Fatal("maximum supported message did not round-trip", err)
	}
	for _, bad := range [][]byte{nil, make([]byte, 16), make([]byte, maxAccountMailPlaintextBytes+17)} {
		if got, err := c.Open(accountMailFixtureJob, "password_changed", deadline, bad, nonce); err == nil || got != nil {
			t.Fatal("invalid ciphertext length was accepted")
		}
	}
}

func TestAccountMailCipherSupportsConcurrentWorkers(t *testing.T) {
	c := mailCipherFixture(t, 0x41)
	deadline := mailCipherDeadline()
	var workers sync.WaitGroup
	nonces := make(chan string, 64)
	for worker := 0; worker < 8; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for attempt := 0; attempt < 8; attempt++ {
				plain := []byte("isolated concurrent mail fixture")
				encrypted, nonce, err := c.Seal(accountMailFixtureJob, "verify_email", deadline, plain)
				if err != nil {
					t.Error(err)
					return
				}
				got, err := c.Open(accountMailFixtureJob, "verify_email", deadline, encrypted, nonce)
				if err != nil || !bytes.Equal(got, plain) {
					t.Error("concurrent envelope did not round-trip", err)
					return
				}
				nonces <- string(nonce)
			}
		}()
	}
	workers.Wait()
	close(nonces)
	seen := map[string]bool{}
	for nonce := range nonces {
		if seen[nonce] {
			t.Fatal("concurrent seals reused a nonce")
		}
		seen[nonce] = true
	}
	if len(seen) != 64 {
		t.Fatal("not all worker envelopes completed")
	}
}
