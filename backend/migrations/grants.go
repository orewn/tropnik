package migrations

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"regexp"
)

// GrantRuntime grants the API role operational rights, but no guide qualification,
// route publication, operator elevation, audit modification or schema ownership.
func GrantRuntime(ctx context.Context, pool *pgxpool.Pool, role string) error {
	if !regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`).MatchString(role) {
		return fmt.Errorf("invalid runtime role")
	}
	r := pgx.Identifier{role}.Sanitize()
	var schema string
	if e := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); e != nil {
		return e
	}
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	statements := []string{
		"GRANT USAGE ON SCHEMA " + quotedSchema + " TO " + r,
		"GRANT SELECT ON users,sessions,guide_qualifications,regions,routes,route_regions,route_revisions,departures,memberships,idempotency_keys,messages,reviews,offline_observations,recruitment_requests,recruitment_members,recruitment_messages,departure_safety,safety_passport_versions,safety_events,safety_check_ins,schema_migrations TO " + r,
		"GRANT INSERT(email,password_hash,display_name,role,guide_status) ON users TO " + r,
		"GRANT UPDATE(display_name,role,guide_status,email,password_hash,email_verified,disabled,deleted_at) ON users TO " + r,
		"GRANT SELECT,INSERT,UPDATE ON account_action_tokens TO " + r,
		"GRANT INSERT,UPDATE ON sessions,departures,memberships,idempotency_keys,messages,reviews,offline_observations,recruitment_requests,recruitment_members,recruitment_messages TO " + r,
		"GRANT DELETE ON recruitment_members TO " + r,
		// Shared auth counters need bounded removal of expired identities.
		"GRANT SELECT,INSERT,UPDATE,DELETE ON auth_rate_limits TO " + r,
		// PostgreSQL row locks require UPDATE privilege on at least one column.
		// Reviewed revision triggers reject modification; no publication/status rights.
		"GRANT UPDATE(updated_at) ON routes TO " + r,
		"GRANT UPDATE(source_retrieved_at) ON route_revisions TO " + r,
		"GRANT SELECT,INSERT,UPDATE ON departure_safety TO " + r,
		"GRANT INSERT ON safety_passport_versions,safety_events,safety_check_ins TO " + r,
		"GRANT INSERT ON audit_events,outbox_events TO " + r,
		"GRANT SELECT ON posting_guards,submission_events,reports,moderation_actions,appeals,notifications TO " + r,
		"GRANT INSERT ON posting_guards,submission_events,reports,moderation_actions,appeals,notifications TO " + r,
		"GRANT UPDATE(updated_at) ON posting_guards TO " + r,
		"GRANT UPDATE(status,resolved_at,resolved_by,decision_reason) ON reports TO " + r,
		"GRANT UPDATE(revoked_at) ON moderation_actions TO " + r,
		"GRANT UPDATE(status,decided_at,decided_by,decision_reason) ON appeals TO " + r,
		"GRANT UPDATE(read_at) ON notifications TO " + r,
		"GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA " + quotedSchema + " TO " + r,
	}
	for _, sql := range statements {
		if _, e := pool.Exec(ctx, sql); e != nil {
			return e
		}
	}
	return nil
}
