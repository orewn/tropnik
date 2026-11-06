package store

import (
	"context"
	"tropa/backend/internal/domain"
)

type Guide struct {
	ID             string   `json:"id"`
	DisplayName    string   `json:"displayName"`
	GuideStatus    string   `json:"guideStatus"`
	Activities     []string `json:"activities"`
	CompletedTrips int      `json:"completedTrips"`
	ReviewCount    int      `json:"reviewCount"`
	Rating         *float64 `json:"rating"`
}

func (s *Store) Guides(ctx context.Context, id string) ([]Guide, error) {
	rows, e := s.Pool.Query(ctx, `SELECT u.id::text,u.display_name,
	ARRAY(SELECT DISTINCT q.activity FROM guide_qualifications q WHERE q.user_id=u.id AND q.revoked_at IS NULL AND q.valid_until>now() ORDER BY q.activity),
	(SELECT count(*) FROM departures d WHERE d.guide_id=u.id AND d.status='completed'),
	(SELECT count(*) FROM reviews r JOIN departures d ON d.id=r.departure_id WHERE d.guide_id=u.id AND r.target='guide' AND r.visibility='visible'),
	(SELECT avg(r.rating)::double precision FROM reviews r JOIN departures d ON d.id=r.departure_id WHERE d.guide_id=u.id AND r.target='guide' AND r.visibility='visible')
	FROM users u WHERE u.guide_status='verified' AND NOT u.disabled AND ($1='' OR u.id::text=$1) AND EXISTS(SELECT 1 FROM guide_qualifications q WHERE q.user_id=u.id AND q.revoked_at IS NULL AND q.valid_until>now()) ORDER BY u.display_name,u.id LIMIT 100`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Guide{}
	for rows.Next() {
		var g Guide
		e = rows.Scan(&g.ID, &g.DisplayName, &g.Activities, &g.CompletedTrips, &g.ReviewCount, &g.Rating)
		if e != nil {
			return nil, e
		}
		g.GuideStatus = "verified"
		out = append(out, g)
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	if id != "" && len(out) == 0 {
		return nil, domain.ErrNotFound
	}
	return out, nil
}

func (s *Store) GuideReviews(ctx context.Context, id string) ([]domain.Review, error) {
	if _, e := s.Guides(ctx, id); e != nil {
		return nil, e
	}
	rows, e := s.Pool.Query(ctx, `SELECT r.id::text,r.departure_id::text,r.user_id::text,r.target,r.rating,r.body,r.created_at FROM reviews r JOIN departures d ON d.id=r.departure_id WHERE d.guide_id::text=$1 AND r.target='guide' AND r.visibility='visible' ORDER BY r.created_at DESC,r.id DESC LIMIT 100`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []domain.Review{}
	for rows.Next() {
		var r domain.Review
		if e = rows.Scan(&r.ID, &r.DepartureID, &r.UserID, &r.Target, &r.Rating, &r.Body, &r.CreatedAt); e != nil {
			return nil, e
		}
		r.ParticipationConfirmed = true
		out = append(out, r)
	}
	return out, rows.Err()
}
