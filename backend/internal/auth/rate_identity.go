package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

// ParseServerKey accepts a separately generated 256-bit server secret. It never
// includes a supplied value in an error. Keys must be stable across API replicas.
func ParseServerKey(value string) ([]byte, error) {
	if len(value) != 64 {
		return nil, errors.New("server key must contain exactly 64 hexadecimal characters")
	}
	key, err := hex.DecodeString(value)
	if err != nil {
		return nil, errors.New("server key must contain exactly 64 hexadecimal characters")
	}
	return key, nil
}

// RateIdentity keeps account names and IP addresses out of the rate-limit table.
// The caller canonicalizes the identifier and validates the 32-byte key at boot.
// Separate scopes cannot share a digest even when their identifiers are equal.
func RateIdentity(key []byte, scope, identifier string) [32]byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("tropnik-auth-rate-v1\x00" + scope + "\x00" + identifier))
	var digest [32]byte
	copy(digest[:], mac.Sum(nil))
	return digest
}
