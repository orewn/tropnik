package auth

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

const Iterations = 600000

var ErrPassword = errors.New("password must contain 12 to 128 characters")

func HashPassword(password string) (string, error) {
	if !utf8.ValidString(password) {
		return "", ErrPassword
	}
	if n := utf8.RuneCountInString(password); n < 12 || n > 128 || len(password) > 512 {
		return "", ErrPassword
	}
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	key, e := pbkdf2.Key(sha256.New, password, salt, Iterations, 32)
	if e != nil {
		return "", e
	}
	return fmt.Sprintf("$pbkdf2-sha256$%d$%s$%s", Iterations, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}
func VerifyPassword(encoded, password string) bool {
	if len(password) > 512 || !utf8.ValidString(password) {
		return false
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 5 || parts[1] != "pbkdf2-sha256" {
		return false
	}
	it, e := strconv.Atoi(parts[2])
	if e != nil || it < Iterations || it > 2000000 {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(parts[3])
	if e != nil || len(salt) != 16 {
		return false
	}
	want, e := base64.RawStdEncoding.DecodeString(parts[4])
	if e != nil || len(want) != 32 {
		return false
	}
	got, e := pbkdf2.Key(sha256.New, password, salt, it, 32)
	if e != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}
func SessionToken() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
