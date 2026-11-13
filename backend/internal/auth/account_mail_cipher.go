package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

const maxAccountMailPlaintextBytes = 64 * 1024

var errAccountMailCipher = errors.New("invalid encrypted account mail")

// AccountMailCipher keeps action links and recipients encrypted at rest. Its
// master key is an independently provisioned, stable server secret, never a
// password or a key stored alongside the outbox. Only derived keys are retained.
type AccountMailCipher struct {
	aead         cipher.AEAD
	recipientKey [32]byte
	keyID        string
}

func NewAccountMailCipher(key []byte) (*AccountMailCipher, error) {
	if len(key) != 32 {
		return nil, errors.New("account mail requires a 32-byte encryption key")
	}
	derive := func(scope string) [32]byte {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte("tropnik-account-mail-key-v1\x00" + scope))
		var result [32]byte
		copy(result[:], mac.Sum(nil))
		return result
	}
	encryptionKey := derive("encryption")
	block, err := aes.NewCipher(encryptionKey[:])
	clear(encryptionKey[:])
	if err != nil {
		return nil, errAccountMailCipher
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errAccountMailCipher
	}
	identity := derive("key-id")
	return &AccountMailCipher{aead: aead, recipientKey: derive("recipient"), keyID: hex.EncodeToString(identity[:])}, nil
}

// KeyID is a nonsecret fingerprint used to reject a mismatched key before work
// is claimed. It is distinct from both the AES and recipient-index subkeys.
func (c *AccountMailCipher) KeyID() string { return c.keyID }

// RecipientKey indexes a caller-normalized email without storing that address
// in plaintext. The caller must construct the cipher successfully at startup.
func (c *AccountMailCipher) RecipientKey(normalizedEmail string) [32]byte {
	if c == nil || c.aead == nil {
		panic("account mail cipher is not initialized")
	}
	mac := hmac.New(sha256.New, c.recipientKey[:])
	_, _ = mac.Write([]byte("tropnik-account-mail-recipient-v1\x00" + normalizedEmail))
	var result [32]byte
	copy(result[:], mac.Sum(nil))
	return result
}

func canonicalAccountMailJobID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, b := range []byte(id) {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if b != '-' {
				return false
			}
		} else if !(b >= '0' && b <= '9' || b >= 'a' && b <= 'f') {
			return false
		}
	}
	return true
}

func accountMailAAD(jobID, purpose string, deadline time.Time) ([]byte, error) {
	if !canonicalAccountMailJobID(jobID) ||
		(purpose != "verify_email" && purpose != "reset_password" && purpose != "password_changed") ||
		deadline.IsZero() || deadline.UTC().Year() < 1970 || deadline.UTC().Year() > 9999 ||
		deadline.UnixMicro() <= 0 || !deadline.Equal(deadline.Truncate(time.Microsecond)) {
		return nil, errAccountMailCipher
	}
	// PostgreSQL stores timestamptz at microsecond precision. Reject a finer
	// input before sealing so a database round-trip cannot change the AAD.
	return []byte(strings.Join([]string{"tropnik-account-mail-aad-v1", jobID, purpose,
		strconv.FormatInt(deadline.UnixMicro(), 10)}, "\x00")), nil
}

func (c *AccountMailCipher) Seal(jobID, purpose string, deadline time.Time, plain []byte) (ciphertext, nonce []byte, err error) {
	if c == nil || c.aead == nil || len(plain) == 0 || len(plain) > maxAccountMailPlaintextBytes {
		return nil, nil, errAccountMailCipher
	}
	aad, err := accountMailAAD(jobID, purpose, deadline)
	if err != nil {
		return nil, nil, errAccountMailCipher
	}
	nonce = make([]byte, c.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, nil, errAccountMailCipher
	}
	return c.aead.Seal(nil, nonce, plain, aad), nonce, nil
}

func (c *AccountMailCipher) Open(jobID, purpose string, deadline time.Time, ciphertext, nonce []byte) ([]byte, error) {
	if c == nil || c.aead == nil || len(nonce) != c.aead.NonceSize() ||
		len(ciphertext) <= c.aead.Overhead() || len(ciphertext) > maxAccountMailPlaintextBytes+c.aead.Overhead() {
		return nil, errAccountMailCipher
	}
	aad, err := accountMailAAD(jobID, purpose, deadline)
	if err != nil {
		return nil, errAccountMailCipher
	}
	plain, err := c.aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, errAccountMailCipher
	}
	return plain, nil
}
