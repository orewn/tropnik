// Package abuse implements transparent posting heuristics, not an AI classifier.
// Rules can reject one submission with a retryable error, never grant staff or
// guide privileges, automatically hide an existing message or ban an account.
package abuse

import (
	"crypto/sha256"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
	"tropa/backend/internal/domain"
)

var links = regexp.MustCompile(`(?i)(?:https?://|www\.|t\.me/|telegram\.me/)[^\s]+`)

func NormalizeBody(body string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if (unicode.IsControl(r) && r != '\n' && r != '\t') || (unicode.Is(unicode.Cf, r) && r != '\u200d') {
			return -1
		}
		return r
	}, norm.NFC.String(body)))
}
func canonical(body string) string {
	x := strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) || unicode.IsControl(r) && !unicode.IsSpace(r) {
			return -1
		}
		return r
	}, norm.NFKC.String(body))
	return strings.ToLower(strings.Join(strings.Fields(x), " "))
}
func Fingerprint(body string) [32]byte { return sha256.Sum256([]byte(canonical(body))) }

type Snapshot struct {
	Established                                      bool
	Muted                                            bool
	UserMinute, ChannelMinute, Day, Hour, Duplicates int
}

func Check(body, kind string, s Snapshot) error {
	if !utf8.ValidString(body) || NormalizeBody(body) == "" {
		return domain.ErrInvalid
	}
	// Muting affects public posting, not the user's right to report or appeal.
	if kind == "report" {
		if s.Hour >= 20 {
			return domain.ErrSpamCooldown
		}
		return nil
	}
	if s.Muted {
		return domain.ErrMuted
	}
	if s.Duplicates > 0 {
		return domain.ErrRepeated
	}
	userMax, channelMax, dayMax, linkMax := 12, 6, 100, 1
	if s.Established {
		userMax, channelMax, dayMax, linkMax = 40, 20, 500, 3
	}
	if s.UserMinute >= userMax || s.ChannelMinute >= channelMax || s.Day >= dayMax {
		return domain.ErrSpamCooldown
	}
	if kind == "recruitment" && s.Hour >= 3 {
		return domain.ErrSpamCooldown
	}
	if len(links.FindAllString(canonical(body), -1)) > linkMax {
		return domain.ErrLinkLimit
	}
	return nil
}
