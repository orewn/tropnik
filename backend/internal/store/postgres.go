package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"tropa/backend/internal/domain"
	"tropa/backend/migrations"
)

type Store struct {
	Pool      *pgxpool.Pool
	SafetyKey []byte
}
type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func New(ctx context.Context, uri string) (*Store, error) {
	c, e := pgxpool.ParseConfig(uri)
	if e != nil {
		return nil, e
	}
	c.MaxConns = 12
	c.MinConns = 1
	c.MaxConnLifetime = time.Hour
	c.ConnConfig.RuntimeParams["timezone"] = "UTC"
	c.ConnConfig.RuntimeParams["statement_timeout"] = "8000"
	p, e := pgxpool.NewWithConfig(ctx, c)
	if e != nil {
		return nil, e
	}
	if e = p.Ping(ctx); e != nil {
		p.Close()
		return nil, e
	}
	key, e := loadSafetyKeyFromEnv()
	if e != nil {
		p.Close()
		return nil, e
	}
	return &Store{Pool: p, SafetyKey: key}, nil
}
func (s *Store) Close() { s.Pool.Close() }
func (s *Store) Ready(ctx context.Context) error {
	var v int
	return s.Pool.QueryRow(ctx, "SELECT version FROM schema_migrations WHERE version=$1", migrations.RequiredVersion).Scan(&v)
}
func dbErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	var p *pgconn.PgError
	if errors.As(err, &p) {
		if p.Code == "23505" {
			return domain.ErrDuplicate
		}
		if p.Code == "23514" || p.Code == "22P02" {
			return domain.ErrInvalid
		}
		if p.Code == "40001" || p.Code == "40P01" {
			return domain.ErrConflict
		}
	}
	return err
}

const userColumns = "id::text,display_name,email,role,CASE WHEN is_admin THEN 'admin' WHEN is_moderator THEN 'moderator' ELSE 'none' END,guide_status,email_verified,created_at"

func scanUser(r pgx.Row) (u domain.User, err error) {
	err = r.Scan(&u.ID, &u.DisplayName, &u.Email, &u.Role, &u.StaffRole, &u.GuideStatus, &u.EmailVerified, &u.CreatedAt)
	return u, dbErr(err)
}
func (s *Store) Register(ctx context.Context, email, passwordHash, name, role string) (domain.User, error) {
	status := "none"
	if role == "guide" {
		status = "pending"
	}
	return scanUser(s.Pool.QueryRow(ctx, "INSERT INTO users(email,password_hash,display_name,role,guide_status) VALUES($1,$2,$3,$4,$5) RETURNING "+userColumns, email, passwordHash, name, role, status))
}
func (s *Store) Credentials(ctx context.Context, email string) (id, hash string, err error) {
	err = s.Pool.QueryRow(ctx, "SELECT id::text,password_hash FROM users WHERE email=$1 AND NOT disabled", email).Scan(&id, &hash)
	return id, hash, dbErr(err)
}
func (s *Store) User(ctx context.Context, id string) (domain.User, error) {
	u, e := scanUser(s.Pool.QueryRow(ctx, "SELECT "+userColumns+" FROM users WHERE id::text=$1 AND NOT disabled", id))
	if e != nil {
		return u, e
	}
	if u.GuideStatus == "verified" {
		var valid bool
		e = s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM guide_qualifications WHERE user_id=$1 AND revoked_at IS NULL AND valid_until>now())", id).Scan(&valid)
		if e != nil {
			return u, e
		}
		if !valid {
			u.GuideStatus = "expired"
		}
	}
	return u, nil
}
func (s *Store) CreateSession(ctx context.Context, user, token string, expiry time.Time) error {
	hash := sha256.Sum256([]byte(token))
	_, e := s.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", hash[:], user, expiry)
	return e
}
func (s *Store) SessionUser(ctx context.Context, token string) (domain.User, error) {
	hash := sha256.Sum256([]byte(token))
	var id string
	e := s.Pool.QueryRow(ctx, "SELECT user_id::text FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()", hash[:]).Scan(&id)
	if errors.Is(e, pgx.ErrNoRows) {
		return domain.User{}, domain.ErrUnauthorized
	}
	if e != nil {
		return domain.User{}, e
	}
	u, e := s.User(ctx, id)
	if errors.Is(e, domain.ErrNotFound) {
		e = domain.ErrUnauthorized
	}
	return u, e
}
func (s *Store) RevokeSession(ctx context.Context, token string) error {
	hash := sha256.Sum256([]byte(token))
	_, e := s.Pool.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", hash[:])
	return e
}
func (s *Store) UpdateProfile(ctx context.Context, id, name, role string) (domain.User, error) {
	// Only a new application can be requested. Public API never grants verification.
	_, e := scanUser(s.Pool.QueryRow(ctx, `UPDATE users SET display_name=$2,
	role=CASE WHEN $3='guide' THEN 'guide' ELSE role END,
	guide_status=CASE WHEN $3='guide' AND guide_status='none' THEN 'pending' ELSE guide_status END
	WHERE id::text=$1 AND NOT disabled RETURNING `+userColumns, id, name, role))
	if e != nil {
		return domain.User{}, e
	}
	return s.User(ctx, id)
}

func (s *Store) Regions(ctx context.Context) ([]domain.Region, error) {
	rows, e := s.Pool.Query(ctx, `SELECT g.id,g.title,g.description,ST_X(g.center),ST_Y(g.center),g.bounds,
	(SELECT count(*) FROM routes r JOIN route_revisions rr ON rr.id=r.current_revision_id WHERE r.region_id=g.id AND r.status='published' AND rr.reviewed_at IS NOT NULL)
	FROM regions g ORDER BY g.title`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []domain.Region{}
	for rows.Next() {
		var x domain.Region
		var raw []byte
		if e = rows.Scan(&x.ID, &x.Title, &x.Description, &x.Center[0], &x.Center[1], &raw, &x.RouteCount); e != nil {
			return nil, e
		}
		if e = json.Unmarshal(raw, &x.Bounds); e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

const routeSQL = `SELECT r.id::text,r.slug,r.region_id,r.title,r.description,rr.difficulty,r.activity,rr.distance_km,rr.ascent_m,rr.duration_min,rr.min_people,rr.max_group_size,rr.required_guides,r.status,rr.id::text,rr.revision,rr.reviewed_at,rr.source_name,rr.source_url,rr.source_license,rr.source_retrieved_at,ST_AsGeoJSON(rr.geometry)::jsonb,rr.season,r.updated_at,rr.risk_class,rr.route_type,rr.legal_difficulty_category,rr.mchs_notification_policy,COALESCE(rr.mchs_territorial_unit_id,''),rr.emergency_exits,rr.control_points,rr.default_check_in_schedule,rr.safety_revision FROM routes r JOIN route_revisions rr ON rr.id=r.current_revision_id `

func scanRoute(r pgx.Row) (x domain.Route, e error) {
	var geo, emergency, controls, schedule []byte
	e = r.Scan(&x.ID, &x.Slug, &x.RegionID, &x.Title, &x.Description, &x.Difficulty, &x.Activity, &x.DistanceKM, &x.AscentM, &x.DurationMin, &x.MinPeople, &x.MaxGroupSize, &x.RequiredGuides, &x.Status, &x.RevisionID, &x.Revision, &x.VerifiedAt, &x.Source.Name, &x.Source.URL, &x.Source.License, &x.Source.RetrievedAt, &geo, &x.Season, &x.UpdatedAt, &x.RiskClass, &x.RouteType, &x.LegalDifficultyCategory, &x.MCHSNotificationPolicy, &x.MCHSTerritorialUnitID, &emergency, &controls, &schedule, &x.SafetyRevision)
	if e != nil {
		return x, dbErr(e)
	}
	if e = json.Unmarshal(geo, &x.Geometry); e != nil {
		return x, e
	}
	if e = json.Unmarshal(emergency, &x.EmergencyExits); e != nil {
		return x, e
	}
	if e = json.Unmarshal(controls, &x.ControlPoints); e != nil {
		return x, e
	}
	e = json.Unmarshal(schedule, &x.DefaultCheckInSchedule)
	return x, e
}
func (s *Store) Routes(ctx context.Context, region, cursor string, limit int) ([]domain.Route, error) {
	if limit < 1 || limit > 100 {
		return nil, domain.ErrInvalid
	}
	// Overview geometry has at most 1,000 original vertices, including both ends.
	// Full, reviewed navigation geometry is available only from the detail endpoint.
	preview := `ST_AsGeoJSON((SELECT ST_MakeLine(ST_PointN(rr.geometry,v.n) ORDER BY v.n) FROM (SELECT generate_series(1,ST_NPoints(rr.geometry),GREATEST(1,CEIL((ST_NPoints(rr.geometry)-1)/999.0)::integer)) AS n UNION SELECT ST_NPoints(rr.geometry)) v))::jsonb`
	summarySQL := strings.Replace(routeSQL, "ST_AsGeoJSON(rr.geometry)::jsonb", preview, 1)
	rows, e := s.Pool.Query(ctx, summarySQL+`WHERE r.status IN ('published','closed') AND rr.reviewed_at IS NOT NULL AND ($1='' OR r.region_id=$1 OR EXISTS(SELECT 1 FROM route_regions rg WHERE rg.route_id=r.id AND rg.region_id=$1)) AND r.id::text>$2 ORDER BY r.id LIMIT $3`, region, cursor, limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []domain.Route{}
	for rows.Next() {
		x, e := scanRoute(rows)
		if e != nil {
			return nil, e
		}
		x.GeometryDetail = "overview"
		out = append(out, x)
	}
	return out, rows.Err()
}
func (s *Store) Route(ctx context.Context, id string) (domain.Route, error) {
	x, e := scanRoute(s.Pool.QueryRow(ctx, routeSQL+"WHERE (r.id::text=$1 OR r.slug=$1) AND r.status IN ('published','closed') AND rr.reviewed_at IS NOT NULL", id))
	x.GeometryDetail = "full"
	return x, e
}

const eligibleSQL = `u.guide_status='verified' AND NOT u.disabled AND EXISTS(SELECT 1 FROM guide_qualifications q WHERE q.user_id=u.id AND q.revoked_at IS NULL AND q.activity=r.activity AND q.valid_until>=d.ends_at AND q.max_difficulty>=CASE rr.difficulty WHEN 'easy' THEN 1 WHEN 'moderate' THEN 2 WHEN 'hard' THEN 3 ELSE 4 END)`
const departureSQL = `SELECT d.id::text,d.route_id::text,d.route_revision_id::text,r.title,d.guide_id::text,u.display_name,d.starts_at,d.ends_at,d.time_zone,d.min_people,d.capacity,d.status,d.version,d.created_at,d.created_by::text,
(r.status='published' AND r.current_revision_id=d.route_revision_id AND rr.reviewed_at IS NOT NULL AND rr.required_guides=1),COALESCE((` + eligibleSQL + `),false),
COALESCE(ds.status,rr.mchs_notification_policy),COALESCE(ds.passport_version,0),COALESCE(ds.notification_policy,rr.mchs_notification_policy),ds.submission_id,(ds.confirmed_at IS NOT NULL),(ds.start_contact_confirmed_at IS NOT NULL),(ds.return_reported_at IS NOT NULL),COALESCE(ds.status IN ('closed','cancelled'),false)
FROM departures d JOIN routes r ON r.id=d.route_id JOIN route_revisions rr ON rr.id=d.route_revision_id LEFT JOIN users u ON u.id=d.guide_id LEFT JOIN departure_safety ds ON ds.departure_id=d.id `

func readGroup(ctx context.Context, q querier, id string, locked bool) (g domain.Group, e error) {
	query := departureSQL + "WHERE d.id::text=$1"
	if locked {
		query += " FOR UPDATE OF d FOR SHARE OF r,rr"
	}
	e = q.QueryRow(ctx, query, id).Scan(&g.ID, &g.RouteID, &g.RouteRevisionID, &g.RouteTitle, &g.GuideID, &g.GuideName, &g.StartsAt, &g.EndsAt, &g.TimeZone, &g.MinPeople, &g.Capacity, &g.Status, &g.Version, &g.CreatedAt, &g.OwnerID, &g.RouteOpen, &g.GuideEligible, &g.SafetyStatus, &g.SafetyPassportVersion, &g.MCHSNotificationPolicy, &g.MCHSSubmissionID, &g.MCHSConfirmed, &g.StartContactConfirmed, &g.ReturnReported, &g.SafetyClosed)
	if e != nil {
		return g, dbErr(e)
	}
	if locked && g.GuideID != nil {
		// Administrative qualification writes lock the same user first. Re-read after
		// that lock so a revocation committed while waiting cannot authorize a start.
		var dummy string
		e = q.QueryRow(ctx, "SELECT id::text FROM users WHERE id=$1 FOR SHARE", *g.GuideID).Scan(&dummy)
		if e != nil {
			return g, e
		}
		e = q.QueryRow(ctx, "SELECT COALESCE(("+eligibleSQL+"),false) FROM departures d JOIN routes r ON r.id=d.route_id JOIN route_revisions rr ON rr.id=d.route_revision_id LEFT JOIN users u ON u.id=d.guide_id WHERE d.id=$1", g.ID).Scan(&g.GuideEligible)
		if e != nil {
			return g, e
		}
	}
	rows, e := q.Query(ctx, "SELECT user_id::text,role,status FROM memberships WHERE departure_id=$1", g.ID)
	if e != nil {
		return g, e
	}
	defer rows.Close()
	g.Members = map[string]domain.Member{}
	for rows.Next() {
		var m domain.Member
		if e = rows.Scan(&m.UserID, &m.Role, &m.Status); e != nil {
			return g, e
		}
		g.Members[m.UserID] = m
	}
	if e = rows.Err(); e != nil {
		return g, e
	}
	g.Membership = "none"
	loc, _ := time.LoadLocation(g.TimeZone)
	if loc == nil {
		loc = time.UTC
	}
	g.SafetyDeadline = domain.MCHSSubmissionDeadline(g.StartsAt.In(loc))
	g.Refresh()
	return g, nil
}
func publicDeparture(g domain.Group, user string) domain.Departure {
	x := g.Departure
	if m, ok := g.Members[user]; ok {
		x.Membership = m.Status
	}
	return x
}
func (s *Store) Departure(ctx context.Context, id, user string) (domain.Departure, error) {
	g, e := readGroup(ctx, s.Pool, id, false)
	out := publicDeparture(g, user)
	if e != nil {
		return out, e
	}
	if g.Status == "completed" && out.Membership == "completed" {
		targets := []string{}
		if g.CanReview(user, "route") {
			var routeWritten, guideWritten bool
			e = s.Pool.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM reviews WHERE departure_id=$1 AND user_id=$2 AND target='route'),
 EXISTS(SELECT 1 FROM reviews WHERE departure_id=$1 AND user_id=$2 AND target='guide')`, id, user).Scan(&routeWritten, &guideWritten)
			if e != nil {
				return out, e
			}
			if !routeWritten {
				targets = append(targets, "route")
			}
			if !guideWritten {
				targets = append(targets, "guide")
			}
		}
		out.ReviewTargets = &targets
	}
	return out, nil
}
func (s *Store) Departures(ctx context.Context, route, user string) ([]domain.Departure, error) {
	rows, e := s.Pool.Query(ctx, `SELECT d.id::text FROM departures d JOIN routes r ON r.id=d.route_id WHERE ($1='' OR r.id::text=$1 OR r.slug=$1) AND d.ends_at>now() AND d.status IN ('recruiting','ready','awaiting_guide','in_progress') ORDER BY d.starts_at LIMIT 100`, route)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	out := []domain.Departure{}
	for _, id := range ids {
		x, e := s.Departure(ctx, id, user)
		if e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, nil
}

func saveGroup(ctx context.Context, tx pgx.Tx, g domain.Group, actor, action string) error {
	_, e := tx.Exec(ctx, "UPDATE departures SET guide_id=$2,status=$3,version=$4,completed_at=CASE WHEN $3='completed' THEN COALESCE(completed_at,now()) ELSE completed_at END WHERE id=$1", g.ID, g.GuideID, g.Status, g.Version)
	if e != nil {
		return e
	}
	for _, m := range g.Members {
		_, e = tx.Exec(ctx, `INSERT INTO memberships(departure_id,user_id,role,status) VALUES($1,$2,$3,$4) ON CONFLICT(departure_id,user_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now()`, g.ID, m.UserID, m.Role, m.Status)
		if e != nil {
			return e
		}
	}
	payload, _ := json.Marshal(map[string]any{"departureId": g.ID, "version": g.Version, "status": g.Status})
	_, e = tx.Exec(ctx, "INSERT INTO outbox_events(aggregate_id,event_type,payload) VALUES($1,$2,$3)", g.ID, "departure."+action, payload)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)", actor, "departure."+action, g.ID, payload)
	if e != nil {
		return e
	}
	return advanceSafetyStateTx(ctx, tx, g.ID, actor, action)
}

func (s *Store) Join(ctx context.Context, user, id, key string, expected int64) (domain.Departure, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return domain.Departure{}, e
	}
	defer tx.Rollback(ctx)
	op := "join:" + id
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", op, expected)))
	_, e = tx.Exec(ctx, "INSERT INTO idempotency_keys(user_id,key,operation,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", user, key, op, digest[:])
	if e != nil {
		return domain.Departure{}, e
	}
	var oldOp string
	var oldHash, raw []byte
	e = tx.QueryRow(ctx, "SELECT operation,request_hash,response FROM idempotency_keys WHERE user_id=$1 AND key=$2 FOR UPDATE", user, key).Scan(&oldOp, &oldHash, &raw)
	if e != nil {
		return domain.Departure{}, e
	}
	if oldOp != op || string(oldHash) != string(digest[:]) {
		return domain.Departure{}, domain.ErrConflict
	}
	if len(raw) > 0 {
		var out domain.Departure
		if e = json.Unmarshal(raw, &out); e != nil {
			return out, e
		}
		e = tx.Commit(ctx)
		return out, e
	}
	g, e := readGroup(ctx, tx, id, true)
	if e != nil {
		return g.Departure, e
	}
	if e = g.Join(user, expected, time.Now().UTC()); e != nil {
		return g.Departure, e
	}
	if e = saveGroup(ctx, tx, g, user, "joined"); e != nil {
		return g.Departure, e
	}
	out := publicDeparture(g, user)
	raw, e = json.Marshal(out)
	if e != nil {
		return out, e
	}
	_, e = tx.Exec(ctx, "UPDATE idempotency_keys SET response=$3 WHERE user_id=$1 AND key=$2", user, key, raw)
	if e != nil {
		return out, e
	}
	return out, dbErr(tx.Commit(ctx))
}
func (s *Store) Mutate(ctx context.Context, user, id, action, target string, expected int64) (domain.Departure, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return domain.Departure{}, e
	}
	defer tx.Rollback(ctx)
	g, e := readGroup(ctx, tx, id, true)
	if e != nil {
		return g.Departure, e
	}
	if action == "start" {
		if e = authorizeSafetyStartTx(ctx, tx, id); e != nil {
			return g.Departure, e
		}
	}
	switch action {
	case "leave":
		e = g.Leave(user, time.Now().UTC())
	case "check-in":
		e = g.CheckIn(user, target, expected, time.Now().UTC())
	default:
		e = g.Transition(user, action, expected, time.Now().UTC())
	}
	if e != nil {
		return g.Departure, e
	}
	if e = saveGroup(ctx, tx, g, user, action); e != nil {
		return g.Departure, e
	}
	e = tx.Commit(ctx)
	return publicDeparture(g, user), dbErr(e)
}

type CreateDeparture struct {
	RouteID         string    `json:"routeId"`
	RouteRevisionID string    `json:"routeRevisionId"`
	StartsAt        time.Time `json:"startsAt"`
	EndsAt          time.Time `json:"endsAt"`
	TimeZone        string    `json:"timeZone"`
	MinPeople       int       `json:"minPeople"`
	Capacity        int       `json:"capacity"`
}

func (s *Store) CreateDeparture(ctx context.Context, user string, in CreateDeparture) (domain.Departure, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return domain.Departure{}, e
	}
	defer tx.Rollback(ctx)
	id, e := createDepartureTx(ctx, tx, user, in)
	if e != nil {
		return domain.Departure{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return domain.Departure{}, dbErr(e)
	}
	return s.Departure(ctx, id, user)
}
func createDepartureTx(ctx context.Context, tx pgx.Tx, user string, in CreateDeparture) (string, error) {
	if in.MinPeople == 0 {
		in.MinPeople = 4
	}
	if in.Capacity == 0 {
		in.Capacity = 8
	}
	if in.MinPeople < 4 || in.Capacity < in.MinPeople || in.Capacity > 50 || !in.StartsAt.After(time.Now()) || !in.EndsAt.After(in.StartsAt) || in.EndsAt.Sub(in.StartsAt) > 30*24*time.Hour {
		return "", domain.ErrInvalid
	}
	if _, e := time.LoadLocation(in.TimeZone); e != nil {
		return "", domain.ErrInvalid
	}
	var status string
	e := tx.QueryRow(ctx, "SELECT guide_status FROM users WHERE id=$1 AND NOT disabled FOR UPDATE", user).Scan(&status)
	if e != nil {
		return "", dbErr(e)
	}
	if status != "verified" {
		return "", domain.ErrForbidden
	}
	var rid, rev, activity string
	var difficulty, minPeople, maxGroupSize, requiredGuides int
	e = tx.QueryRow(ctx, `SELECT r.id::text,rr.id::text,r.activity,CASE rr.difficulty WHEN 'easy' THEN 1 WHEN 'moderate' THEN 2 WHEN 'hard' THEN 3 ELSE 4 END,rr.min_people,rr.max_group_size,rr.required_guides FROM routes r JOIN route_revisions rr ON rr.id=r.current_revision_id WHERE (r.id::text=$1 OR r.slug=$1) AND r.status='published' AND rr.reviewed_at IS NOT NULL FOR SHARE OF r,rr`, in.RouteID).Scan(&rid, &rev, &activity, &difficulty, &minPeople, &maxGroupSize, &requiredGuides)
	if e != nil {
		return "", dbErr(e)
	}
	if in.RouteRevisionID != "" && in.RouteRevisionID != rev {
		return "", domain.ErrConflict
	}
	if requiredGuides != 1 {
		return "", domain.ErrNotReady
	}
	if in.MinPeople < minPeople || in.Capacity > maxGroupSize {
		return "", domain.ErrInvalid
	}
	var eligible bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM guide_qualifications WHERE user_id=$1 AND activity=$2 AND max_difficulty>=$3 AND revoked_at IS NULL AND valid_until>=$4)", user, activity, difficulty, in.EndsAt).Scan(&eligible)
	if e != nil {
		return "", e
	}
	if !eligible {
		return "", domain.ErrForbidden
	}
	var overlap bool
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM departures WHERE guide_id=$1 AND status IN ('recruiting','ready','in_progress') AND starts_at<$3 AND ends_at>$2)`, user, in.StartsAt, in.EndsAt).Scan(&overlap)
	if e != nil {
		return "", e
	}
	if overlap {
		return "", domain.ErrConflict
	}
	var id string
	e = tx.QueryRow(ctx, `INSERT INTO departures(route_id,route_revision_id,guide_id,created_by,starts_at,ends_at,time_zone,min_people,capacity) VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8) RETURNING id::text`, rid, rev, user, in.StartsAt, in.EndsAt, in.TimeZone, in.MinPeople, in.Capacity).Scan(&id)
	if e != nil {
		return "", dbErr(e)
	}
	_, e = tx.Exec(ctx, "INSERT INTO memberships(departure_id,user_id,role,status) VALUES($1,$2,'guide','confirmed')", id, user)
	if e != nil {
		return "", e
	}
	_, e = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,action,entity_id) VALUES($1,'departure.created',$2)", user, id)
	return id, e
}
