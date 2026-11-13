//go:build integration

package store_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"tropa/backend/internal/store"
	"tropa/backend/migrations"
)

// Every role and grant below belongs to this disposable integration schema.
// The application connects as the generated login, not through SET ROLE; this
// also proves that session identity cannot hide an owner credential at startup.
func runtimeRoleFixture(t *testing.T, owner *store.Store) (*store.Store, string) {
	t.Helper()
	ctx := context.Background()
	var random [24]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	secret := hex.EncodeToString(random[:])
	role := "tropa_policy_" + secret[:12]
	quoted := pgx.Identifier{role}.Sanitize()
	if _, err := owner.Pool.Exec(ctx, "CREATE ROLE "+quoted+" LOGIN PASSWORD '"+secret+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := owner.Pool.Exec(context.Background(), "DROP OWNED BY "+quoted); err != nil {
			t.Error(err)
		}
		if _, err := owner.Pool.Exec(context.Background(), "DROP ROLE "+quoted); err != nil {
			t.Error(err)
		}
	})
	if err := migrations.GrantRuntime(ctx, owner.Pool, role); err != nil {
		t.Fatal(err)
	}
	cfg := owner.Pool.Config()
	cfg.ConnConfig.User = role
	cfg.ConnConfig.Password = secret
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	app := &store.Store{Pool: pool}
	if err := app.CheckRuntimeRole(ctx); err != nil {
		t.Fatal("reviewed runtime policy was rejected", err)
	}
	return app, role
}

func expectUnsafeRuntimeRole(t *testing.T, app *store.Store) {
	t.Helper()
	var legacyFlags bool
	if err := app.Pool.QueryRow(context.Background(), "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname=current_user").Scan(&legacyFlags); err != nil {
		t.Fatal(err)
	}
	if legacyFlags {
		t.Fatal("test must exercise a capability the former four-flag check missed")
	}
	if err := app.CheckRuntimeRole(context.Background()); !errors.Is(err, migrations.ErrUnsafeRuntimeRole) {
		t.Fatalf("expected an unsafe-role decision, got %v", err)
	}
}

func TestRuntimePolicyRejectsExcessAndMissingGrants(t *testing.T) {
	owner := db(t)
	app, role := runtimeRoleFixture(t, owner)
	ctx := context.Background()
	quoted := pgx.Identifier{role}.Sanitize()
	var schema, database string
	if err := owner.Pool.QueryRow(ctx, "SELECT current_schema(),current_database()").Scan(&schema, &database); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, grant, revoke string }{
		{"staff column", "GRANT UPDATE(is_admin) ON users TO " + quoted, "REVOKE UPDATE(is_admin) ON users FROM " + quoted},
		{"qualification insert", "GRANT INSERT ON guide_qualifications TO " + quoted, "REVOKE INSERT ON guide_qualifications FROM " + quoted},
		{"publication column", "GRANT UPDATE(status) ON routes TO " + quoted, "REVOKE UPDATE(status) ON routes FROM " + quoted},
		{"reviewed geometry", "GRANT UPDATE(geometry) ON route_revisions TO " + quoted, "REVOKE UPDATE(geometry) ON route_revisions FROM " + quoted},
		{"audit modification", "GRANT UPDATE ON audit_events TO " + quoted, "REVOKE UPDATE ON audit_events FROM " + quoted},
		{"audit reading", "GRANT SELECT ON audit_events TO " + quoted, "REVOKE SELECT ON audit_events FROM " + quoted},
		{"message deletion", "GRANT DELETE ON messages TO " + quoted, "REVOKE DELETE ON messages FROM " + quoted},
		{"audit truncation", "GRANT TRUNCATE ON audit_events TO " + quoted, "REVOKE TRUNCATE ON audit_events FROM " + quoted},
		{"trigger installation", "GRANT TRIGGER ON users TO " + quoted, "REVOKE TRIGGER ON users FROM " + quoted},
		{"column reference", "GRANT REFERENCES(id) ON users TO " + quoted, "REVOKE REFERENCES(id) ON users FROM " + quoted},
		{"grant delegation", "GRANT SELECT ON users TO " + quoted + " WITH GRANT OPTION", "REVOKE GRANT OPTION FOR SELECT ON users FROM " + quoted},
		{"schema creation", "GRANT CREATE ON SCHEMA " + pgx.Identifier{schema}.Sanitize() + " TO " + quoted, "REVOKE CREATE ON SCHEMA " + pgx.Identifier{schema}.Sanitize() + " FROM " + quoted},
		{"database creation", "GRANT CREATE ON DATABASE " + pgx.Identifier{database}.Sanitize() + " TO " + quoted, "REVOKE CREATE ON DATABASE " + pgx.Identifier{database}.Sanitize() + " FROM " + quoted},
		{"sequence rewriting", "GRANT UPDATE ON SEQUENCE audit_events_id_seq TO " + quoted, "REVOKE UPDATE ON SEQUENCE audit_events_id_seq FROM " + quoted},
		{"replication capability", "ALTER ROLE " + quoted + " REPLICATION", "ALTER ROLE " + quoted + " NOREPLICATION"},
		{"missing session write", "REVOKE INSERT ON sessions FROM " + quoted, "GRANT INSERT ON sessions TO " + quoted},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := owner.Pool.Exec(ctx, tc.grant); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := owner.Pool.Exec(ctx, tc.revoke); err != nil {
					t.Fatal(err)
				}
				if err := app.CheckRuntimeRole(ctx); err != nil {
					t.Fatal("restored policy was rejected", err)
				}
			}()
			expectUnsafeRuntimeRole(t, app)
		})
	}
	// An extra PUBLIC grant also reaches the runtime even without an ACL entry
	// naming its role. This schema and table disappear with the test fixture.
	t.Run("public audit grant", func(t *testing.T) {
		if _, err := owner.Pool.Exec(ctx, "GRANT UPDATE ON audit_events TO PUBLIC"); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := owner.Pool.Exec(ctx, "REVOKE UPDATE ON audit_events FROM PUBLIC"); err != nil {
				t.Fatal(err)
			}
		}()
		expectUnsafeRuntimeRole(t, app)
	})
	if err := app.CheckRuntimeRole(ctx); err != nil {
		t.Fatal("runtime failed after all grants were restored", err)
	}
	// Existing operational behavior is exercised with the exact same policy by
	// TestRestrictedRuntimeRoleCanOperateButCannotElevate and lifecycle/safety tests.
}

func TestRuntimePolicyRejectsOwnersAndReachableRoles(t *testing.T) {
	owner := db(t)
	app, role := runtimeRoleFixture(t, owner)
	ctx := context.Background()
	quoted := pgx.Identifier{role}.Sanitize()
	var ownerName, schema string
	if err := owner.Pool.QueryRow(ctx, "SELECT current_user,current_schema()").Scan(&ownerName, &schema); err != nil {
		t.Fatal(err)
	}
	ownerQuoted := pgx.Identifier{ownerName}.Sanitize()
	t.Run("ordinary schema owner", func(t *testing.T) {
		name := pgx.Identifier{schema}.Sanitize()
		if _, err := owner.Pool.Exec(ctx, "ALTER SCHEMA "+name+" OWNER TO "+quoted); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := owner.Pool.Exec(ctx, "ALTER SCHEMA "+name+" OWNER TO "+ownerQuoted); err != nil {
				t.Fatal(err)
			}
			if _, err := owner.Pool.Exec(ctx, "REVOKE ALL ON SCHEMA "+name+" FROM "+quoted); err != nil {
				t.Fatal(err)
			}
			if err := migrations.GrantRuntime(ctx, owner.Pool, role); err != nil {
				t.Fatal(err)
			}
		}()
		expectUnsafeRuntimeRole(t, app)
	})
	group := role + "_group"
	groupQuoted := pgx.Identifier{group}.Sanitize()
	if _, err := owner.Pool.Exec(ctx, "CREATE ROLE "+groupQuoted+" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := owner.Pool.Exec(ctx, "ALTER TABLE audit_events OWNER TO "+ownerQuoted); err != nil {
			t.Error(err)
		}
		if _, err := owner.Pool.Exec(ctx, "DROP OWNED BY "+groupQuoted); err != nil {
			t.Error(err)
		}
		if _, err := owner.Pool.Exec(ctx, "DROP ROLE "+groupQuoted); err != nil {
			t.Error(err)
		}
	}()
	t.Run("ordinary table owner", func(t *testing.T) {
		if _, err := owner.Pool.Exec(ctx, "ALTER TABLE audit_events OWNER TO "+quoted); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := owner.Pool.Exec(ctx, "ALTER TABLE audit_events OWNER TO "+ownerQuoted); err != nil {
				t.Fatal(err)
			}
			// Ownership transfer changes ACL entries. Restore only the baseline.
			if _, err := owner.Pool.Exec(ctx, "REVOKE ALL ON audit_events FROM "+quoted); err != nil {
				t.Fatal(err)
			}
			if _, err := owner.Pool.Exec(ctx, "REVOKE ALL ON SEQUENCE audit_events_id_seq FROM "+quoted); err != nil {
				t.Fatal(err)
			}
			if err := migrations.GrantRuntime(ctx, owner.Pool, role); err != nil {
				t.Fatal(err)
			}
		}()
		expectUnsafeRuntimeRole(t, app)
	})
	if _, err := owner.Pool.Exec(ctx, "GRANT USAGE ON SCHEMA "+pgx.Identifier{schema}.Sanitize()+" TO "+groupQuoted); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"INHERIT TRUE, SET FALSE", "INHERIT FALSE, SET TRUE", "ADMIN TRUE, INHERIT FALSE, SET FALSE"} {
		t.Run(mode, func(t *testing.T) {
			if _, err := owner.Pool.Exec(ctx, "GRANT UPDATE(is_admin) ON users TO "+groupQuoted); err != nil {
				t.Fatal(err)
			}
			if _, err := owner.Pool.Exec(ctx, "GRANT "+groupQuoted+" TO "+quoted+" WITH "+mode); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := owner.Pool.Exec(ctx, "REVOKE "+groupQuoted+" FROM "+quoted); err != nil {
					t.Fatal(err)
				}
			}()
			expectUnsafeRuntimeRole(t, app)
		})
	}
	for _, predefined := range []string{"pg_read_server_files", "pg_write_server_files", "pg_execute_server_program", "pg_read_all_data", "pg_write_all_data", "pg_signal_backend", "pg_maintain", "pg_monitor"} {
		t.Run(predefined, func(t *testing.T) {
			builtin := pgx.Identifier{predefined}.Sanitize()
			if _, err := owner.Pool.Exec(ctx, "GRANT "+builtin+" TO "+quoted+" WITH INHERIT FALSE, SET TRUE"); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := owner.Pool.Exec(ctx, "REVOKE "+builtin+" FROM "+quoted); err != nil {
					t.Fatal(err)
				}
			}()
			// Only catalog privileges are inspected. No protected file, process,
			// backend cancellation or operating-system function is exercised.
			expectUnsafeRuntimeRole(t, app)
		})
	}
	t.Run("owner group reachable only through set role", func(t *testing.T) {
		if _, err := owner.Pool.Exec(ctx, "REVOKE UPDATE(is_admin) ON users FROM "+groupQuoted); err != nil {
			t.Fatal(err)
		}
		if _, err := owner.Pool.Exec(ctx, "ALTER TABLE audit_events OWNER TO "+groupQuoted); err != nil {
			t.Fatal(err)
		}
		if _, err := owner.Pool.Exec(ctx, "GRANT "+groupQuoted+" TO "+quoted+" WITH INHERIT FALSE, SET TRUE"); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := owner.Pool.Exec(ctx, "REVOKE "+groupQuoted+" FROM "+quoted); err != nil {
				t.Fatal(err)
			}
		}()
		expectUnsafeRuntimeRole(t, app)
	})
}

func TestRuntimePolicyRejectsOwnerConnectionWithSelectedRuntimeRole(t *testing.T) {
	owner := db(t)
	_, role := runtimeRoleFixture(t, owner)
	cfg := owner.Pool.Config()
	cfg.ConnConfig.RuntimeParams["role"] = role
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	app := &store.Store{Pool: pool}
	var current, session string
	if err := pool.QueryRow(context.Background(), "SELECT current_user,session_user").Scan(&current, &session); err != nil {
		t.Fatal(err)
	}
	if current != role || current == session {
		t.Fatal("test did not establish an owner connection with a restricted current role")
	}
	expectUnsafeRuntimeRole(t, app)
}
