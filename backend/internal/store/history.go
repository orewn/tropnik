package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"time"

	"tropa/backend/internal/domain"
)

type historyCursor struct {
	CompletedAt time.Time `json:"at"`
	ID          string    `json:"id"`
}

var historyUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func decodeHistoryCursor(value string) (*historyCursor, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > 256 {
		return nil, domain.ErrInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, domain.ErrInvalid
	}
	var cursor historyCursor
	if json.Unmarshal(raw, &cursor) != nil || cursor.CompletedAt.IsZero() || !historyUUID.MatchString(cursor.ID) {
		return nil, domain.ErrInvalid
	}
	return &cursor, nil
}

func encodeHistoryCursor(item domain.CompletedDeparture) string {
	raw, _ := json.Marshal(historyCursor{CompletedAt: item.CompletedAt, ID: item.ID})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// DepartureHistory never accepts a requested user ID from the HTTP caller. Its
// user argument is the current authenticated account. A cursor only narrows the
// result; knowing another account's cursor cannot disclose its participation.
func (s *Store) DepartureHistory(ctx context.Context, user, cursorValue string, limit int) ([]domain.CompletedDeparture, string, error) {
	if user == "" {
		return nil, "", domain.ErrUnauthorized
	}
	if limit < 1 || limit > 50 {
		return nil, "", domain.ErrInvalid
	}
	cursor, err := decodeHistoryCursor(cursorValue)
	if err != nil {
		return nil, "", err
	}
	var afterTime *time.Time
	var afterID *string
	if cursor != nil {
		afterTime, afterID = &cursor.CompletedAt, &cursor.ID
	}
	rows, err := s.Pool.Query(ctx, `SELECT d.id::text,d.route_id::text,d.route_revision_id::text,r.title,
 d.starts_at,d.ends_at,d.completed_at,d.time_zone,m.role,d.guide_id::text,u.display_name,
 EXISTS(SELECT 1 FROM reviews v WHERE v.departure_id=d.id AND v.user_id=m.user_id AND v.target='route'),
 EXISTS(SELECT 1 FROM reviews v WHERE v.departure_id=d.id AND v.user_id=m.user_id AND v.target='guide')
 FROM memberships m JOIN departures d ON d.id=m.departure_id
 JOIN routes r ON r.id=d.route_id LEFT JOIN users u ON u.id=d.guide_id
 WHERE m.user_id=$1 AND m.status='completed' AND d.status='completed' AND d.completed_at IS NOT NULL
 AND ($2::timestamptz IS NULL OR (d.completed_at,d.id)<($2::timestamptz,$3::uuid))
 ORDER BY d.completed_at DESC,d.id DESC LIMIT $4`, user, afterTime, afterID, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := make([]domain.CompletedDeparture, 0, limit)
	for rows.Next() {
		var item domain.CompletedDeparture
		var routeReviewed, guideReviewed bool
		if err = rows.Scan(&item.ID, &item.RouteID, &item.RouteRevisionID, &item.RouteTitle,
			&item.StartsAt, &item.EndsAt, &item.CompletedAt, &item.TimeZone, &item.Role,
			&item.GuideID, &item.GuideName, &routeReviewed, &guideReviewed); err != nil {
			return nil, "", err
		}
		item.ReviewTargets = []string{}
		// Hidden reviews still occupy their unique target; this endpoint must not
		// invite a duplicate review to evade a moderation decision.
		if item.Role == "tourist" {
			if !routeReviewed {
				item.ReviewTargets = append(item.ReviewTargets, "route")
			}
			if !guideReviewed {
				item.ReviewTargets = append(item.ReviewTargets, "guide")
			}
		}
		out = append(out, item)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > limit {
		out = out[:limit]
		next = encodeHistoryCursor(out[len(out)-1])
	}
	return out, next, nil
}
