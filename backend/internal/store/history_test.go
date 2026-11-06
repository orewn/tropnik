package store

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"tropa/backend/internal/domain"
)

func TestHistoryCursorRoundTripKeepsTimestampAndTieBreaker(t *testing.T) {
	item := domain.CompletedDeparture{ID: "00000000-0000-0000-0000-000000000123", CompletedAt: time.Date(2026, 11, 6, 8, 3, 12, 123456000, time.UTC)}
	value := encodeHistoryCursor(item)
	cursor, err := decodeHistoryCursor(value)
	if err != nil || cursor.ID != item.ID || !cursor.CompletedAt.Equal(item.CompletedAt) {
		t.Fatalf("history cursor lost a boundary: %+v %v", cursor, err)
	}
	if strings.ContainsAny(value, "/+=") {
		t.Fatal("cursor is not raw URL-safe base64")
	}
}

func TestHistoryCursorRejectsUnboundedMalformedAndUnusableValues(t *testing.T) {
	encode := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, value := range []string{
		strings.Repeat("a", 257), "not/base64", encode(`{}`), encode(`null`),
		encode(`{"at":"2026-11-06T08:03:12Z","id":"../../another-user"}`),
		encode(`{"at":"0001-01-01T00:00:00Z","id":"00000000-0000-0000-0000-000000000123"}`),
		encode(`{"at":"not-a-time","id":"00000000-0000-0000-0000-000000000123"}`),
	} {
		if _, err := decodeHistoryCursor(value); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("invalid cursor accepted: %q (%v)", value, err)
		}
	}
	if cursor, err := decodeHistoryCursor(""); cursor != nil || err != nil {
		t.Fatal("empty cursor must begin history")
	}
}
