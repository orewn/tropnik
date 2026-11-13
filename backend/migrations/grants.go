package migrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The grant writer and production verifier share one capability policy. A nil
// column list grants no privilege; All permits every column of that operation.
// In particular, row-lock privileges do not permit publication or staff grants.
type runtimeTablePolicy struct {
	Table         string   `json:"table_name"`
	Select        bool     `json:"select_rows"`
	InsertAll     bool     `json:"insert_all"`
	InsertColumns []string `json:"insert_columns"`
	UpdateAll     bool     `json:"update_all"`
	UpdateColumns []string `json:"update_columns"`
	Delete        bool     `json:"delete_rows"`
}

var runtimeTables = []runtimeTablePolicy{
	{Table: "users", Select: true, InsertColumns: []string{"email", "password_hash", "display_name", "role", "guide_status"}, UpdateColumns: []string{"display_name", "role", "guide_status", "email", "password_hash", "email_verified", "disabled", "deleted_at"}},
	{Table: "sessions", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "guide_qualifications", Select: true},
	{Table: "regions", Select: true},
	{Table: "routes", Select: true, UpdateColumns: []string{"updated_at"}},
	{Table: "route_regions", Select: true},
	{Table: "route_revisions", Select: true, UpdateColumns: []string{"source_retrieved_at"}},
	{Table: "departures", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "memberships", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "idempotency_keys", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "messages", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "reviews", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "offline_observations", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "recruitment_requests", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "recruitment_members", Select: true, InsertAll: true, UpdateAll: true, Delete: true},
	{Table: "recruitment_messages", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "departure_safety", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "safety_passport_versions", Select: true, InsertAll: true},
	{Table: "safety_events", Select: true, InsertAll: true},
	{Table: "safety_check_ins", Select: true, InsertAll: true},
	{Table: "schema_migrations", Select: true},
	{Table: "account_action_tokens", Select: true, InsertAll: true, UpdateAll: true},
	{Table: "account_mail_outbox", Select: true, InsertAll: true, UpdateAll: true, Delete: true},
	{Table: "auth_rate_limits", Select: true, InsertAll: true, UpdateAll: true, Delete: true},
	{Table: "audit_events", InsertAll: true},
	{Table: "outbox_events", InsertAll: true},
	{Table: "posting_guards", Select: true, InsertAll: true, UpdateColumns: []string{"updated_at"}},
	{Table: "submission_events", Select: true, InsertAll: true},
	{Table: "reports", Select: true, InsertAll: true, UpdateColumns: []string{"status", "resolved_at", "resolved_by", "decision_reason"}},
	{Table: "moderation_actions", Select: true, InsertAll: true, UpdateColumns: []string{"revoked_at"}},
	{Table: "appeals", Select: true, InsertAll: true, UpdateColumns: []string{"status", "decided_at", "decided_by", "decision_reason"}},
	{Table: "notifications", Select: true, InsertAll: true, UpdateColumns: []string{"read_at"}},
}

var runtimeRoleName = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

func columnGrant(privilege string, all bool, columns []string) string {
	if all {
		return privilege
	}
	if len(columns) == 0 {
		return ""
	}
	quoted := make([]string, len(columns))
	for i, column := range columns {
		quoted[i] = pgx.Identifier{column}.Sanitize()
	}
	return privilege + "(" + strings.Join(quoted, ",") + ")"
}

// GrantRuntime grants operational rights atomically. It never revokes existing
// operator rights automatically: CheckRuntimeRole rejects such a misconfigured
// credential before production startup, so an operator can inspect and fix it.
func GrantRuntime(ctx context.Context, pool *pgxpool.Pool, role string) error {
	if !runtimeRoleName.MatchString(role) {
		return fmt.Errorf("invalid runtime role")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var schema string
	if err = tx.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		return err
	}
	r := pgx.Identifier{role}.Sanitize()
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err = tx.Exec(ctx, "GRANT USAGE ON SCHEMA "+quotedSchema+" TO "+r); err != nil {
		return err
	}
	for _, policy := range runtimeTables {
		privileges := make([]string, 0, 4)
		if policy.Select {
			privileges = append(privileges, "SELECT")
		}
		if grant := columnGrant("INSERT", policy.InsertAll, policy.InsertColumns); grant != "" {
			privileges = append(privileges, grant)
		}
		if grant := columnGrant("UPDATE", policy.UpdateAll, policy.UpdateColumns); grant != "" {
			privileges = append(privileges, grant)
		}
		if policy.Delete {
			privileges = append(privileges, "DELETE")
		}
		table := pgx.Identifier{schema, policy.Table}.Sanitize()
		if _, err = tx.Exec(ctx, "GRANT "+strings.Join(privileges, ",")+" ON "+table+" TO "+r); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, "GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "+quotedSchema+" TO "+r); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

var ErrUnsafeRuntimeRole = errors.New("database runtime privileges do not match the application policy")

// CheckRuntimeRole checks effective privileges, not only role flags. Ownership,
// PUBLIC/inherited grants and roles reachable through SET ROLE can otherwise
// bypass a column-limited grant policy while all four old flags remain false.
// This is a startup check, not a claim to police later operator changes.
func CheckRuntimeRole(ctx context.Context, pool *pgxpool.Pool) error {
	raw, err := json.Marshal(runtimeTables)
	if err != nil {
		return err
	}
	var safe bool
	if err = pool.QueryRow(ctx, runtimeRoleCheckSQL, string(raw)).Scan(&safe); err != nil {
		return err
	}
	if !safe {
		return ErrUnsafeRuntimeRole
	}
	return nil
}

const runtimeRoleCheckSQL = `WITH
actors AS (
 SELECT oid,rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication
 FROM pg_catalog.pg_roles
 WHERE rolname=current_user OR pg_catalog.pg_has_role(current_user,oid,'USAGE')
    OR pg_catalog.pg_has_role(current_user,oid,'SET')
),
app_schema AS (SELECT oid,nspowner FROM pg_catalog.pg_namespace WHERE nspname=current_schema()),
policy AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(table_name text,select_rows boolean,
  insert_all boolean,insert_columns text[],update_all boolean,update_columns text[],delete_rows boolean)
),
tables AS (
 SELECT p.*,c.oid,c.relkind FROM policy p LEFT JOIN pg_catalog.pg_class c
 ON c.relname=p.table_name AND c.relnamespace=(SELECT oid FROM app_schema)
),
columns AS (
 SELECT t.*,a.attnum,
  t.insert_all OR a.attname=ANY(COALESCE(t.insert_columns,ARRAY[]::text[])) AS can_insert,
  t.update_all OR a.attname=ANY(COALESCE(t.update_columns,ARRAY[]::text[])) AS can_update
 FROM tables t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
)
SELECT current_user=session_user
AND EXISTS(SELECT 1 FROM app_schema)
AND NOT EXISTS(SELECT 1 FROM actors WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication OR left(rolname,3)='pg_')
AND NOT EXISTS(SELECT 1 FROM actors r,pg_catalog.pg_roles target WHERE r.oid<>target.oid AND pg_catalog.pg_has_role(r.oid,target.oid,'MEMBER WITH ADMIN OPTION'))
AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d JOIN actors r ON r.oid=d.datdba WHERE d.datname=current_database())
AND NOT EXISTS(SELECT 1 FROM app_schema n JOIN actors r ON r.oid=n.nspowner)
AND NOT EXISTS(SELECT 1 FROM actors r,app_schema n WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE') OR pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE'))
AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN actors r ON r.oid=c.relowner WHERE c.relnamespace=(SELECT oid FROM app_schema))
AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN actors r ON r.oid=p.proowner WHERE p.pronamespace=(SELECT oid FROM app_schema))
AND NOT EXISTS(SELECT 1 FROM tables WHERE oid IS NULL OR relkind NOT IN ('r','p'))
AND NOT EXISTS(SELECT 1 FROM tables t,actors r WHERE
 pg_catalog.has_table_privilege(r.oid,t.oid,'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,DELETE WITH GRANT OPTION')
 OR (pg_catalog.has_table_privilege(r.oid,t.oid,'DELETE') AND NOT t.delete_rows))
AND NOT EXISTS(SELECT 1 FROM columns c,actors r WHERE
 (pg_catalog.has_column_privilege(r.oid,c.oid,c.attnum,'SELECT') AND NOT c.select_rows)
 OR (pg_catalog.has_column_privilege(r.oid,c.oid,c.attnum,'INSERT') AND NOT c.can_insert)
 OR (pg_catalog.has_column_privilege(r.oid,c.oid,c.attnum,'UPDATE') AND NOT c.can_update)
 OR pg_catalog.has_column_privilege(r.oid,c.oid,c.attnum,'REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION'))
AND NOT EXISTS(SELECT 1 FROM tables t WHERE t.delete_rows AND NOT pg_catalog.has_table_privilege(current_user,t.oid,'DELETE'))
AND NOT EXISTS(SELECT 1 FROM columns c WHERE
 (c.select_rows AND NOT pg_catalog.has_column_privilege(current_user,c.oid,c.attnum,'SELECT'))
 OR (c.can_insert AND NOT pg_catalog.has_column_privilege(current_user,c.oid,c.attnum,'INSERT'))
 OR (c.can_update AND NOT pg_catalog.has_column_privilege(current_user,c.oid,c.attnum,'UPDATE')))
AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c,actors r WHERE c.relnamespace=(SELECT oid FROM app_schema)
 AND c.relkind IN ('r','p','v','m','f') AND NOT EXISTS(SELECT 1 FROM tables t WHERE t.oid=c.oid)
 AND (pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES') OR pg_catalog.has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE,TRIGGER,MAINTAIN')))
AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c,actors r WHERE c.relnamespace=(SELECT oid FROM app_schema) AND c.relkind='S'
 AND pg_catalog.has_sequence_privilege(r.oid,c.oid,'UPDATE,USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION'))
AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=(SELECT oid FROM app_schema) AND c.relkind='S'
 AND (NOT pg_catalog.has_sequence_privilege(current_user,c.oid,'USAGE') OR NOT pg_catalog.has_sequence_privilege(current_user,c.oid,'SELECT')))`
