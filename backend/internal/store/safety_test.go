package store

import (
	"bytes"
	"testing"
)

func TestSafetyEncryptionBindsCiphertextToDepartureAndVersion(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	value := map[string]any{"phone": "+7 900 000-00-00", "note": "private"}
	ciphertext, nonce, _, err := encryptSafety(key, "departure-a", 1, value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err = decryptSafety(key, "departure-a", 1, ciphertext, nonce, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["phone"] != value["phone"] {
		t.Fatal("decrypted payload mismatch")
	}
	if err = decryptSafety(key, "departure-b", 1, ciphertext, nonce, &decoded); err == nil {
		t.Fatal("ciphertext was not bound to departure")
	}
	if err = decryptSafety(key, "departure-a", 2, ciphertext, nonce, &decoded); err == nil {
		t.Fatal("ciphertext was not bound to version")
	}
}

func TestSafetyKeysAndContactValidationFailClosed(t *testing.T) {
	if _, err := ParseSafetyKey("private-bad-key"); err == nil {
		t.Fatal("malformed safety key accepted")
	}
	key, err := ParseSafetyKey("0707070707070707070707070707070707070707070707070707070707070707")
	if err != nil || len(key) != 32 {
		t.Fatal("valid key rejected", err)
	}
	for _, phone := range []string{"+       ", "123", "+12345678901234567890"} {
		if _, ok := normalizedPhone(phone); ok {
			t.Fatal("invalid phone accepted")
		}
	}
	if _, ok := normalizedPhone("+7 900 000-00-00"); !ok {
		t.Fatal("valid phone rejected")
	}
	var value map[string]any
	if err := decryptSafety(key, "fixture", 1, []byte("bad ciphertext"), nil, &value); err == nil {
		t.Fatal("malformed nonce accepted")
	}
}
