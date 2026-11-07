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
