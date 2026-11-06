//go:build integration

package store_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
)

func TestModerationCaseScopeMuteAndIndependentAppeal(t *testing.T) {
	s := db(t)
	_, d := fixture(t, s, 5)
	ctx := context.Background()
	author := account(t, s, "message-author", "tourist")
	reporter := account(t, s, "case-reporter", "tourist")
	outsider := account(t, s, "case-outsider", "tourist")
	moderator := account(t, s, "staff-reviewer", "tourist")
	independent := account(t, s, "independent-reviewer", "tourist")
	administrator := account(t, s, "staff-administrator", "tourist")
	if _, e := s.Pool.Exec(ctx, "UPDATE users SET is_admin=true WHERE id=$1", administrator.ID); e != nil {
		t.Fatal(e)
	}
	for _, u := range []domain.User{moderator, independent} {
		if _, e := s.Pool.Exec(ctx, "UPDATE users SET is_moderator=true WHERE id=$1", u.ID); e != nil {
			t.Fatal(e)
		}
	}
	for _, u := range []domain.User{author, reporter} {
		if _, e := s.Join(ctx, u.ID, d.ID, "join-case-"+u.ID, 0); e != nil {
			t.Fatal(e)
		}
	}
	body := "INTEGRATION FIXTURE: reported text, no real personal data"
	message, e := s.SendMessage(ctx, author.ID, d.ID, body, "case-message-original-001")
	if e != nil {
		t.Fatal(e)
	}
	input := domain.ReportInput{TargetType: "message", TargetID: message.ID, Reason: "spam", Body: "Проверьте нежелательную рекламу в этом сообщении."}
	if _, e = s.CreateReport(ctx, outsider.ID, input); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("outsider could report/read private target", e)
	}
	if _, e = s.ModerationReports(ctx, author.ID, "open"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("ordinary user opened moderation queue", e)
	}
	report, e := s.CreateReport(ctx, reporter.ID, input)
	if e != nil {
		t.Fatal(e)
	}
	queue, e := s.ModerationReports(ctx, moderator.ID, "open")
	if e != nil || len(queue) != 1 || queue[0].TargetBody != body {
		t.Fatal("case-scoped evidence missing", queue, e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE users SET is_moderator=true WHERE id=$1 OR id=$2", author.ID, reporter.ID); e != nil {
		t.Fatal(e)
	}
	for _, actor := range []domain.User{author, reporter, moderator} {
		items, e := s.ModerationReports(ctx, actor.ID, "open")
		if e != nil || len(items) != 0 {
			t.Fatal("staff queue leaked own case or privileged subject", actor.ID, items, e)
		}
	}
	queue, e = s.ModerationReports(ctx, administrator.ID, "open")
	if e != nil || len(queue) != 1 {
		t.Fatal("independent administrator cannot review staff case", queue, e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE users SET is_moderator=false WHERE id=$1 OR id=$2", author.ID, reporter.ID); e != nil {
		t.Fatal(e)
	}
	decision, e := s.ResolveReport(ctx, moderator.ID, report.ID, domain.ResolveReport{Action: "hide_and_mute", MuteHours: 2, Reason: "Нежелательная реклама подтверждена в проверяемом сообщении."})
	if e != nil || decision.Status != "resolved" {
		t.Fatal("resolution failed", decision, e)
	}
	messages, e := s.Messages(ctx, reporter.ID, d.ID, time.Time{}, "")
	if e != nil || len(messages) != 1 || messages[0].Visibility != "hidden" || messages[0].Body != "" {
		t.Fatal("hidden content leaked", messages, e)
	}
	if _, e = s.SendMessage(ctx, author.ID, d.ID, "Another new post", "case-message-new-00001"); !errors.Is(e, domain.ErrMuted) {
		t.Fatal("active mute did not block new posting", e)
	}
	replay, e := s.SendMessage(ctx, author.ID, d.ID, body, "case-message-original-001")
	if e != nil || replay.ID != message.ID || replay.Body != "" || replay.Visibility != "hidden" {
		t.Fatal("replay counted as spam or leaked hidden text", replay, e)
	}
	summary, e := s.AccountSummary(ctx, author.ID)
	if e != nil || summary.Moderation.MutedUntil == nil || len(summary.Badges) != 0 {
		t.Fatal("account moderation or earned-only awards wrong", summary, e)
	}
	actions, e := s.MyModerationActions(ctx, author.ID)
	if e != nil || len(actions) != 1 {
		t.Fatal(actions, e)
	}
	appeal, e := s.CreateAppeal(ctx, author.ID, actions[0].ID, "Прошу проверить контекст сообщения и пересмотреть решение.")
	if e != nil {
		t.Fatal(e)
	}
	appeals, e := s.ModerationAppeals(ctx, moderator.ID, "open")
	if e != nil || len(appeals) != 0 {
		t.Fatal("original moderator read own appeal in staff queue", appeals, e)
	}
	appeals, e = s.ModerationAppeals(ctx, independent.ID, "open")
	if e != nil || len(appeals) != 1 || !appeals[0].CanResolve {
		t.Fatal("independent appeal case missing", appeals, e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE users SET is_moderator=true WHERE id=$1 OR id=$2", author.ID, reporter.ID); e != nil {
		t.Fatal(e)
	}
	for _, actor := range []domain.User{author, reporter, independent} {
		items, e := s.ModerationAppeals(ctx, actor.ID, "open")
		if e != nil || len(items) != 0 {
			t.Fatal("appeal queue leaked conflicted or privileged case", actor.ID, items, e)
		}
	}
	appeals, e = s.ModerationAppeals(ctx, administrator.ID, "open")
	if e != nil || len(appeals) != 1 {
		t.Fatal("independent administrator cannot read staff appeal", appeals, e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE users SET is_moderator=false WHERE id=$1", author.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ResolveAppeal(ctx, reporter.ID, appeal.ID, domain.ResolveAppeal{Decision: "upheld", Reason: "Автор исходной жалобы не может рассмотреть апелляцию."}); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("original reporter decided appeal", e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE users SET is_moderator=false WHERE id=$1", reporter.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ResolveAppeal(ctx, moderator.ID, appeal.ID, domain.ResolveAppeal{Decision: "overturned", Reason: "Пересмотр моего собственного решения не разрешён."}); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("original actor decided appeal", e)
	}
	resolved, e := s.ResolveAppeal(ctx, independent.ID, appeal.ID, domain.ResolveAppeal{Decision: "overturned", Reason: "При повторной проверке нарушение не подтверждено."})
	if e != nil || resolved.Status != "overturned" {
		t.Fatal(resolved, e)
	}
	messages, e = s.Messages(ctx, reporter.ID, d.ID, time.Time{}, "")
	if e != nil || messages[0].Visibility != "visible" || messages[0].Body != body {
		t.Fatal("appeal did not restore authorized visibility", messages, e)
	}
	summary, e = s.AccountSummary(ctx, author.ID)
	if e != nil || summary.Moderation.MutedUntil != nil {
		t.Fatal("overturned mute remained active", summary, e)
	}
	if _, e = s.SendMessage(ctx, author.ID, d.ID, "Спасибо за независимый пересмотр.", "case-message-after-0001"); e != nil {
		t.Fatal(e)
	}
	notifications, e := s.Notifications(ctx, author.ID)
	if e != nil || len(notifications) < 3 {
		t.Fatal("durable user notices missing", notifications, e)
	}
	if e = s.ReadNotification(ctx, outsider.ID, notifications[0].ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("notification ownership bypass", e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE users SET is_moderator=false WHERE id=$1", moderator.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ModerationReports(ctx, moderator.ID, "open"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatal("revoked staff role remained usable", e)
	}
}

func TestPersistentPostingBudgetAcrossConcurrentChannels(t *testing.T) {
	s := db(t)
	guide, first := fixture(t, s, 4)
	ctx := context.Background()
	user := account(t, s, "rate-limited-walker", "tourist")
	departures := []domain.Departure{first}
	for i := 1; i < 3; i++ {
		start := first.EndsAt.Add(time.Duration(i) * 8 * time.Hour)
		d, e := s.CreateDeparture(ctx, guide.ID, store.CreateDeparture{RouteID: first.RouteID, RouteRevisionID: first.RouteRevisionID, StartsAt: start, EndsAt: start.Add(4 * time.Hour), TimeZone: "Europe/Moscow", MinPeople: 4, Capacity: 4})
		if e != nil {
			t.Fatal(e)
		}
		departures = append(departures, d)
	}
	for _, d := range departures {
		if _, e := s.Join(ctx, user.ID, d.ID, "posting-test-join-"+d.ID, 0); e != nil {
			t.Fatal(e)
		}
	}
	var total atomic.Int32
	counts := make([]atomic.Int32, 3)
	var wg sync.WaitGroup
	for channel, d := range departures {
		for i := 0; i < 7; i++ {
			channel, d, i := channel, d, i
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, e := s.SendMessage(ctx, user.ID, d.ID, fmt.Sprintf("Уникальный вопрос о маршруте %d, пункт %d", channel, i), fmt.Sprintf("posting-budget-%d-%04d", channel, i))
				if e == nil {
					total.Add(1)
					counts[channel].Add(1)
				} else if !errors.Is(e, domain.ErrSpamCooldown) {
					t.Errorf("unexpected posting error: %v", e)
				}
			}()
		}
	}
	wg.Wait()
	if total.Load() != 12 {
		t.Fatalf("expected global new-account budget 12, got %d", total.Load())
	}
	for i := range counts {
		if counts[i].Load() > 6 {
			t.Fatal("channel budget exceeded")
		}
	}
	var recorded int
	if e := s.Pool.QueryRow(ctx, "SELECT count(*) FROM submission_events WHERE user_id=$1", user.ID).Scan(&recorded); e != nil || recorded != 12 {
		t.Fatal("posting accounting is not atomic", recorded, e)
	}
}
