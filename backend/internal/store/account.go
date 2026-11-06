package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"tropa/backend/internal/domain"
)

func (s *Store) AccountSummary(ctx context.Context, user string) (domain.AccountSummary, error) {
	out := domain.AccountSummary{Badges: []domain.Badge{}}
	var e error
	out.User, e = s.User(ctx, user)
	if e != nil {
		return out, e
	}
	e = s.Pool.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM memberships m JOIN departures d ON d.id=m.departure_id WHERE m.user_id=$1 AND m.status='completed' AND d.status='completed'),
 (SELECT count(*) FROM reviews WHERE user_id=$1 AND visibility='visible'),
 (SELECT max(expires_at) FROM moderation_actions WHERE subject_id=$1 AND revoked_at IS NULL AND action IN ('mute','hide_and_mute') AND expires_at>now())`, user).Scan(&out.Stats.CompletedTrips, &out.Stats.ReviewsWritten, &out.Moderation.MutedUntil)
	if e != nil {
		return out, e
	}
	rows, e := s.Pool.Query(ctx, `SELECT d.id::text,d.completed_at FROM memberships m JOIN departures d ON d.id=m.departure_id WHERE m.user_id=$1 AND m.status='completed' AND d.status='completed' AND d.completed_at IS NOT NULL ORDER BY d.completed_at,d.id LIMIT 5`, user)
	if e != nil {
		return out, e
	}
	n := 0
	for rows.Next() {
		var id string
		var at time.Time
		if e = rows.Scan(&id, &at); e != nil {
			rows.Close()
			return out, e
		}
		n++
		if n == 1 {
			out.Badges = append(out.Badges, domain.Badge{ID: "first_trip", Title: "Первая история", Description: "Первый завершённый поход с подтверждённым участием.", EarnedAt: at, EvidenceID: id, EvidenceType: "departure"})
		}
		if n == 5 {
			out.Badges = append(out.Badges, domain.Badge{ID: "five_trips", Title: "Пять историй", Description: "Пять завершённых походов с подтверждённым участием.", EarnedAt: at, EvidenceID: id, EvidenceType: "departure"})
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return out, e
	}
	var id string
	var at time.Time
	e = s.Pool.QueryRow(ctx, "SELECT id::text,created_at FROM reviews WHERE user_id=$1 AND visibility='visible' ORDER BY created_at,id LIMIT 1", user).Scan(&id, &at)
	if e == nil {
		out.Badges = append(out.Badges, domain.Badge{ID: "first_review", Title: "Полезный опыт", Description: "Первый опубликованный отзыв после подтверждённого участия.", EarnedAt: at, EvidenceID: id, EvidenceType: "review"})
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	e = s.Pool.QueryRow(ctx, `SELECT d.id::text,d.completed_at FROM departures d JOIN memberships m ON m.departure_id=d.id WHERE d.guide_id=$1 AND m.user_id=$1 AND m.role='guide' AND m.status='completed' AND d.status='completed' AND d.completed_at IS NOT NULL ORDER BY d.completed_at,d.id LIMIT 1`, user).Scan(&id, &at)
	if e == nil {
		out.Badges = append(out.Badges, domain.Badge{ID: "first_guided_trip", Title: "Первый выход с группой", Description: "Первый завершённый выход в роли назначенного гида. Награда не заменяет действующий допуск.", EarnedAt: at, EvidenceID: id, EvidenceType: "departure"})
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	return out, nil
}

func (s *Store) Notifications(ctx context.Context, user string) ([]domain.Notification, error) {
	rows, e := s.Pool.Query(ctx, "SELECT id::text,kind,title,body,created_at,read_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100", user)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []domain.Notification{}
	for rows.Next() {
		var n domain.Notification
		if e = rows.Scan(&n.ID, &n.Kind, &n.Title, &n.Body, &n.CreatedAt, &n.ReadAt); e != nil {
			return nil, e
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
func (s *Store) ReadNotification(ctx context.Context, user, id string) error {
	result, e := s.Pool.Exec(ctx, "UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id::text=$2 AND user_id=$1", user, id)
	if e != nil {
		return e
	}
	if result.RowsAffected() != 1 {
		return domain.ErrNotFound
	}
	return nil
}
func notify(ctx context.Context, tx pgx.Tx, user, kind, title, body string) error {
	_, e := tx.Exec(ctx, "INSERT INTO notifications(user_id,kind,title,body) VALUES($1,$2,$3,$4)", user, kind, title, body)
	return e
}
