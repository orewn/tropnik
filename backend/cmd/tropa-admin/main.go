// tropa-admin is an operator-only CLI. It uses a separate migration/operator DSN,
// never an HTTP request or a client-supplied role claim.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"tropa/backend/internal/domain"
)

func main() {
	if e := run(); e != nil {
		log.Fatal(e)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("commands: bootstrap-admin, grant-staff, verify-guide, revoke-guide, import-route, publish-route, close-route")
	}
	command := os.Args[1]
	f := flag.NewFlagSet(command, flag.ContinueOnError)
	actor := f.String("actor", "", "operator user UUID")
	user := f.String("user", "", "guide user UUID")
	email := f.String("email", "", "existing account email (first admin only)")
	route := f.String("route", "", "route UUID")
	file := f.String("file", "", "route JSON file")
	evidence := f.String("evidence", "", "review evidence/reference; do not put personal documents in public storage")
	activity := f.String("activity", "hiking", "qualification activity")
	level := f.Int("max-difficulty", 0, "1 easy, 2 moderate, 3 hard, 4 expert")
	staffRole := f.String("staff-role", "", "operator-only grant: none, moderator, admin")
	minPeople := f.Int("min-people", 4, "reviewed minimum including the guide")
	maxGroup := f.Int("max-group-size", 0, "required for publication: reviewed maximum including the guide")
	requiredGuides := f.Int("required-guides", 0, "required for publication; this release supports exactly one")
	until := f.String("valid-until", "", "RFC3339 expiry")
	if e := f.Parse(os.Args[2:]); e != nil {
		return e
	}
	dsn := os.Getenv("OPERATOR_DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("OPERATOR_DATABASE_URL required; do not use this command through the public API")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p, e := pgxpool.New(ctx, dsn)
	if e != nil {
		return fmt.Errorf("invalid operator database configuration")
	}
	defer p.Close()
	tx, e := p.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if command == "bootstrap-admin" {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(87071205)"); e != nil {
			return e
		}
		var id string
		e = tx.QueryRow(ctx, `UPDATE users SET is_admin=true WHERE email=$1 AND NOT EXISTS(SELECT 1 FROM users WHERE is_admin) RETURNING id::text`, strings.ToLower(strings.TrimSpace(*email))).Scan(&id)
		if e != nil {
			return fmt.Errorf("first admin not created: check existing account and whether an admin already exists")
		}
		_, e = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,action,entity_id) VALUES($1,'operator.bootstrap',$1)", id)
		if e != nil {
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		fmt.Println("First operator account authorized:", id)
		return nil
	}
	var admin bool
	e = tx.QueryRow(ctx, "SELECT is_admin FROM users WHERE id::text=$1 AND NOT disabled FOR SHARE", *actor).Scan(&admin)
	if e != nil || !admin {
		return fmt.Errorf("--actor must identify an active operator account")
	}
	if command != "import-route" && len(strings.TrimSpace(*evidence)) < 6 {
		return fmt.Errorf("--evidence is required")
	}
	entity := ""
	switch command {
	case "grant-staff":
		if *staffRole != "none" && *staffRole != "moderator" && *staffRole != "admin" {
			return fmt.Errorf("--staff-role must be none, moderator or admin")
		}
		e = tx.QueryRow(ctx, "SELECT id::text FROM users WHERE id::text=$1 AND NOT disabled FOR UPDATE", *user).Scan(&entity)
		if e != nil {
			return e
		}
		if entity == *actor {
			return fmt.Errorf("operator cannot change their own staff assignment")
		}
		_, e = tx.Exec(ctx, "UPDATE users SET is_admin=$2,is_moderator=$3 WHERE id=$1", entity, *staffRole == "admin", *staffRole == "moderator")
		if e != nil {
			return e
		}
	case "verify-guide", "revoke-guide":
		var role string
		e = tx.QueryRow(ctx, "SELECT id::text,role FROM users WHERE id::text=$1 AND NOT disabled FOR UPDATE", *user).Scan(&entity, &role)
		if e != nil {
			return e
		}
		if role != "guide" {
			return fmt.Errorf("account must first apply as a guide")
		}
		if command == "verify-guide" {
			if entity == *actor {
				return fmt.Errorf("an operator cannot verify their own guide qualification")
			}
			expiry, e := time.Parse(time.RFC3339, *until)
			if e != nil || !expiry.After(time.Now()) || *level < 1 || *level > 4 || *activity == "" {
				return fmt.Errorf("valid scope, max-difficulty and future RFC3339 valid-until required")
			}
			_, e = tx.Exec(ctx, `INSERT INTO guide_qualifications(user_id,activity,max_difficulty,valid_until,evidence_ref,verified_by) VALUES($1,$2,$3,$4,$5,$6)`, entity, *activity, *level, expiry, *evidence, *actor)
			if e != nil {
				return e
			}
			_, e = tx.Exec(ctx, "UPDATE users SET guide_status='verified' WHERE id=$1", entity)
			if e != nil {
				return e
			}
		} else {
			_, e = tx.Exec(ctx, "UPDATE users SET guide_status='suspended' WHERE id=$1", entity)
			if e != nil {
				return e
			}
			_, e = tx.Exec(ctx, "UPDATE guide_qualifications SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", entity)
			if e != nil {
				return e
			}
		}
	case "import-route":
		input, e := os.Open(*file)
		if e != nil {
			return e
		}
		defer input.Close()
		b, e := io.ReadAll(io.LimitReader(input, domain.RouteImportBytes+1))
		if e != nil {
			return e
		}
		if len(b) > domain.RouteImportBytes {
			return fmt.Errorf("route file too large")
		}
		var r domain.Route
		if e = json.Unmarshal(b, &r); e != nil {
			return e
		}
		if e = domain.ValidateRouteImport(r); e != nil {
			return e
		}
		geo, _ := json.Marshal(r.Geometry)
		e = tx.QueryRow(ctx, "INSERT INTO routes(slug,region_id,title,description,activity,status) VALUES($1,$2,$3,$4,$5,'review_required') RETURNING id::text", r.Slug, r.RegionID, r.Title, r.Description, r.Activity).Scan(&entity)
		if e != nil {
			return e
		}
		var rev string
		e = tx.QueryRow(ctx, `INSERT INTO route_revisions(route_id,revision,geometry,distance_km,ascent_m,duration_min,difficulty,season,source_name,source_url,source_license,source_retrieved_at) VALUES($1,1,ST_SetSRID(ST_GeomFromGeoJSON($2),4326),ST_Length(ST_SetSRID(ST_GeomFromGeoJSON($2),4326)::geography)/1000,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text`, entity, string(geo), r.AscentM, r.DurationMin, r.Difficulty, r.Season, r.Source.Name, r.Source.URL, r.Source.License, r.Source.RetrievedAt).Scan(&rev)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "UPDATE routes SET current_revision_id=$2 WHERE id=$1", entity, rev)
		if e != nil {
			return e
		}
	case "publish-route", "close-route":
		var rev string
		e = tx.QueryRow(ctx, "SELECT id::text,current_revision_id::text FROM routes WHERE id::text=$1 FOR UPDATE", *route).Scan(&entity, &rev)
		if e != nil {
			return e
		}
		if command == "publish-route" {
			if *minPeople < 4 || *maxGroup < *minPeople || *maxGroup > 50 || *requiredGuides != 1 {
				return fmt.Errorf("publication requires reviewed --min-people >=4, --max-group-size and --required-guides 1; multi-guide routes are not supported")
			}
			var reviewed bool
			var oldMin, oldMax, oldGuides int
			e = tx.QueryRow(ctx, "SELECT reviewed_at IS NOT NULL,min_people,max_group_size,required_guides FROM route_revisions WHERE id=$1", rev).Scan(&reviewed, &oldMin, &oldMax, &oldGuides)
			if e != nil {
				return e
			}
			if reviewed && (oldMin != *minPeople || oldMax != *maxGroup || oldGuides != *requiredGuides) {
				return fmt.Errorf("reviewed policy is immutable; create a new revision")
			}
			_, e = tx.Exec(ctx, "UPDATE route_revisions SET reviewed_at=now(),reviewed_by=$2,review_evidence=$3,min_people=$4,max_group_size=$5,required_guides=$6 WHERE id=$1 AND reviewed_at IS NULL", rev, *actor, *evidence, *minPeople, *maxGroup, *requiredGuides)
			if e != nil {
				return e
			}
			_, e = tx.Exec(ctx, "UPDATE routes SET status='published',updated_at=now() WHERE id=$1", entity)
		} else {
			_, e = tx.Exec(ctx, "UPDATE routes SET status='closed',updated_at=now() WHERE id=$1", entity)
		}
		if e != nil {
			return e
		}
	default:
		return fmt.Errorf("unknown command")
	}
	details, _ := json.Marshal(map[string]string{"evidence": *evidence, "staffRole": *staffRole})
	_, e = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)", *actor, "operator."+command, entity, details)
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	fmt.Println(command+" completed; entity:", entity)
	return nil
}
