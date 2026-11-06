package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"tropa/backend/internal/abuse"
)

// The guard serializes one user's posting and sanctions across API replicas.
// Replayed client IDs are checked after this lock and before rate accounting.
func lockPosting(ctx context.Context, tx pgx.Tx, user string) error {
	if _, e := tx.Exec(ctx, "INSERT INTO posting_guards(user_id) VALUES($1) ON CONFLICT DO NOTHING", user); e != nil {
		return e
	}
	var id string
	return tx.QueryRow(ctx, "SELECT user_id::text FROM posting_guards WHERE user_id=$1 FOR UPDATE", user).Scan(&id)
}

func checkSubmission(ctx context.Context, tx pgx.Tx, user, channel, kind, body string) error {
	var s abuse.Snapshot
	var created time.Time
	digest := abuse.Fingerprint(body)
	if e := tx.QueryRow(ctx, "SELECT created_at FROM users WHERE id=$1 AND NOT disabled FOR SHARE", user).Scan(&created); e != nil {
		return dbErr(e)
	}
	e := tx.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM memberships m JOIN departures d ON d.id=m.departure_id WHERE m.user_id=$1 AND m.status='completed' AND d.status='completed'),
 EXISTS(SELECT 1 FROM moderation_actions WHERE subject_id=$1 AND revoked_at IS NULL AND action IN ('mute','hide_and_mute') AND expires_at>now()),
 count(*) FILTER(WHERE created_at>now()-interval '1 minute' AND kind<>'report'),
 count(*) FILTER(WHERE created_at>now()-interval '1 minute' AND channel=$2 AND kind<>'report'),
 count(*) FILTER(WHERE created_at>now()-interval '1 day' AND kind<>'report'),
 count(*) FILTER(WHERE created_at>now()-interval '1 hour' AND kind=$3),
 count(*) FILTER(WHERE created_at>now()-interval '15 minutes' AND fingerprint=$4 AND kind<>'report')
 FROM submission_events WHERE user_id=$1 AND created_at>now()-interval '1 day'`, user, channel, kind, digest[:]).Scan(&s.Established, &s.Muted, &s.UserMinute, &s.ChannelMinute, &s.Day, &s.Hour, &s.Duplicates)
	if e != nil {
		return e
	}
	s.Established = s.Established || time.Since(created) >= 7*24*time.Hour
	return abuse.Check(body, kind, s)
}

func recordSubmission(ctx context.Context, tx pgx.Tx, user, channel, kind, body string) error {
	digest := abuse.Fingerprint(body)
	_, e := tx.Exec(ctx, "INSERT INTO submission_events(user_id,channel,kind,fingerprint) VALUES($1,$2,$3,$4)", user, channel, kind, digest[:])
	return e
}
