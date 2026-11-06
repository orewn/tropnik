package migrations

import (
	"context"
	"embed"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed *.sql
var Files embed.FS

// RequiredVersion is also the readiness gate used by the running API.
const RequiredVersion = 3

func Apply(ctx context.Context, pool *pgxpool.Pool) error {
	c, e := pool.Acquire(ctx)
	if e != nil {
		return e
	}
	defer c.Release()
	if _, e = c.Exec(ctx, "SELECT pg_advisory_lock(87071204)"); e != nil {
		return e
	}
	defer c.Exec(context.Background(), "SELECT pg_advisory_unlock(87071204)")
	var table *string
	if e = c.QueryRow(ctx, "SELECT to_regclass(quote_ident(current_schema())||'.schema_migrations')::text").Scan(&table); e != nil {
		return e
	}
	for version, name := range []string{"001_initial.sql", "002_moderation.sql", "003_auth_rate_limits.sql"} {
		if table != nil || version > 0 {
			var exists bool
			if e = c.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)", version+1).Scan(&exists); e != nil {
				return e
			}
			if exists {
				continue
			}
		}
		raw, e := Files.ReadFile(name)
		if e != nil {
			return e
		}
		if _, e = c.Exec(ctx, string(raw)); e != nil {
			_, _ = c.Exec(context.Background(), "ROLLBACK")
			return fmt.Errorf("migration %d failed: %w", version+1, e)
		}
	}
	return nil
}
