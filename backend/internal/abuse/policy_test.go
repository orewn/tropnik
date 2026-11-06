package abuse

import (
	"errors"
	"testing"
	"tropa/backend/internal/domain"
)

func TestUnicodeFingerprintAndHiddenLinkNormalization(t *testing.T) {
	if e := Check("Одна ссылка https://www.example.invalid/path", "message", Snapshot{}); e != nil {
		t.Fatal("one URL was counted twice", e)
	}
	if Fingerprint("Привет  группе") != Fingerprint("ПРИВЕТ\u200b группе") {
		t.Fatal("zero-width/case/space duplicate escaped fingerprint")
	}
	if Fingerprint("café") != Fingerprint("cafe\u0301") {
		t.Fatal("canonical equivalent Unicode diverged")
	}
	if e := Check("h\u200bttps://one.invalid hｔtps://two.invalid", "message", Snapshot{}); !errors.Is(e, domain.ErrLinkLimit) {
		t.Fatalf("obfuscated links escaped budget: %v", e)
	}
	if NormalizeBody(" \u202eПривет\x01\nгруппе ") != "Привет\nгруппе" {
		t.Fatal("control stripping damaged safe text")
	}
}
func TestPostingCooldownAndReportsRemainAvailableDuringMute(t *testing.T) {
	for _, s := range []Snapshot{{Muted: true}, {UserMinute: 12}, {ChannelMinute: 6}, {Day: 100}, {Duplicates: 1}} {
		if Check("Вопрос о маршруте", "message", s) == nil {
			t.Fatalf("posting gate missed %+v", s)
		}
	}
	if e := Check("Сообщение раскрывает чужой телефон", "report", Snapshot{Muted: true}); e != nil {
		t.Fatal("mute blocked reporting", e)
	}
	if e := Check("Новая группа на маршрут", "recruitment", Snapshot{Hour: 3}); !errors.Is(e, domain.ErrSpamCooldown) {
		t.Fatal("recruitment burst allowed", e)
	}
	if e := Check("Ссылка https://one.invalid и https://two.invalid", "message", Snapshot{Established: true}); e != nil {
		t.Fatal("established budget misapplied", e)
	}
}
