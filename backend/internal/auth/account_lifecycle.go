package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
)

// AccountActionToken carries 256 random bits. Only its digest crosses the store
// boundary. It is distinct from the session token and grants no API session.
func AccountActionToken() (string, [32]byte, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", [32]byte{}, err
	}
	raw := base64.RawURLEncoding.EncodeToString(b[:])
	return raw, sha256.Sum256([]byte(raw)), nil
}

func AccountActionDigest(raw string) ([32]byte, error) {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil || len(decoded) != 32 || len(raw) != 43 {
		return [32]byte{}, errors.New("invalid account action token")
	}
	return sha256.Sum256([]byte(raw)), nil
}

// Action URLs are operator configuration, never derived from a request's Host.
// A fragment keeps the token out of HTTP access logs and Referer headers.
func AccountActionURL(base, purpose, raw string) (string, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", errors.New("account action URL must be an HTTPS page without query or fragment")
	}
	if purpose != "verify_email" && purpose != "reset_password" {
		return "", errors.New("unsupported account action")
	}
	if _, err := AccountActionDigest(raw); err != nil {
		return "", err
	}
	u.Fragment = url.Values{"action": {purpose}, "token": {raw}}.Encode()
	return u.String(), nil
}
