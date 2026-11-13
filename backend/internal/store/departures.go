package store

import (
	"context"

	"tropa/backend/internal/domain"
)

// Materialize the bounded public page before evaluating membership aggregates.
// The active-only index excludes cancelled/no-show history; only the caller's
// own membership is read separately. All fields use one database snapshot.
const publicDeparturesSQL = `WITH listed AS MATERIALIZED (
 SELECT d.id FROM departures d JOIN routes r ON r.id=d.route_id
 WHERE ($1='' OR r.id::text=$1 OR r.slug=$1) AND d.ends_at>now()
 AND d.status IN ('recruiting','ready','awaiting_guide','in_progress')
 ORDER BY d.starts_at,d.id LIMIT 100
)
SELECT ` + departureColumns + `,members.active_count,COALESCE(mine.status,'none')` + departureRelations + `
JOIN listed ON listed.id=d.id
CROSS JOIN LATERAL (
 SELECT count(*) AS active_count FROM memberships m
 WHERE m.departure_id=d.id AND m.status IN ('confirmed','checked_in','completed')
) members
LEFT JOIN memberships mine ON mine.departure_id=d.id AND mine.user_id=NULLIF($2,'')::uuid
ORDER BY d.starts_at,d.id`

func (s *Store) Departures(ctx context.Context, route, user string) ([]domain.Departure, error) {
	rows, err := s.Pool.Query(ctx, publicDeparturesSQL, route, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Departure{}
	for rows.Next() {
		// OwnerID is needed only by the mutation model. Reusing its shared SQL
		// projection keeps guide, route and safety fields aligned without loading
		// or allocating the group's membership-history map.
		var g domain.Group
		err = rows.Scan(&g.ID, &g.RouteID, &g.RouteRevisionID, &g.RouteTitle, &g.GuideID, &g.GuideName,
			&g.StartsAt, &g.EndsAt, &g.TimeZone, &g.MinPeople, &g.Capacity, &g.Status, &g.Version,
			&g.CreatedAt, &g.OwnerID, &g.RouteOpen, &g.GuideEligible, &g.SafetyStatus, &g.SafetyPassportVersion,
			&g.MCHSNotificationPolicy, &g.MCHSSubmissionID, &g.MCHSConfirmed, &g.StartContactConfirmed,
			&g.ReturnReported, &g.SafetyClosed, &g.ParticipantCount, &g.Membership)
		if err != nil {
			return nil, err
		}
		g.Departure.RefreshReadiness()
		out = append(out, g.Departure)
	}
	return out, rows.Err()
}
