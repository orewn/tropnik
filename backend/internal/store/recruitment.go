package store

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"time"
	"tropa/backend/internal/abuse"
	"tropa/backend/internal/domain"
)

type RecruitmentMessage struct {
	ID          string    `json:"id"`
	RequestID   string    `json:"requestId"`
	UserID      string    `json:"userId"`
	DisplayName string    `json:"displayName"`
	Body        string    `json:"body"`
	Visibility  string    `json:"visibility"`
	ClientID    string    `json:"clientId"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Recruitment struct {
	ID              string    `json:"id"`
	RouteID         string    `json:"routeId"`
	CreatorID       string    `json:"creatorId"`
	CreatorName     string    `json:"creatorName"`
	PreferredDate   *string   `json:"preferredDate"`
	Body            string    `json:"body"`
	Status          string    `json:"status"`
	DepartureID     *string   `json:"departureId"`
	InterestedCount int       `json:"interestedCount"`
	CreatedAt       time.Time `json:"createdAt"`
}

func (s *Store) RecruitmentRequests(ctx context.Context, route string) ([]Recruitment, error) {
	rows, e := s.Pool.Query(ctx, `SELECT q.id::text,q.route_id::text,q.created_by::text,u.display_name,q.preferred_date::text,q.body,q.status,q.departure_id::text,(SELECT count(*) FROM recruitment_members m WHERE m.request_id=q.id),q.created_at FROM recruitment_requests q JOIN users u ON u.id=q.created_by JOIN routes r ON r.id=q.route_id WHERE ($1='' OR r.id::text=$1 OR r.slug=$1) AND q.status IN ('open','accepted') ORDER BY q.created_at DESC LIMIT 100`, route)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Recruitment{}
	for rows.Next() {
		var x Recruitment
		e = rows.Scan(&x.ID, &x.RouteID, &x.CreatorID, &x.CreatorName, &x.PreferredDate, &x.Body, &x.Status, &x.DepartureID, &x.InterestedCount, &x.CreatedAt)
		if e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
func (s *Store) CreateRecruitment(ctx context.Context, user, route, preferredDate, body string) (Recruitment, error) {
	body = abuse.NormalizeBody(body)
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return Recruitment{}, e
	}
	defer tx.Rollback(ctx)
	var rid string
	e = tx.QueryRow(ctx, `SELECT r.id::text FROM routes r JOIN route_revisions rr ON rr.id=r.current_revision_id WHERE (r.id::text=$1 OR r.slug=$1) AND r.status='published' AND rr.reviewed_at IS NOT NULL FOR SHARE OF r`, route).Scan(&rid)
	if e != nil {
		return Recruitment{}, dbErr(e)
	}
	if e = lockPosting(ctx, tx, user); e != nil {
		return Recruitment{}, e
	}
	var existing bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM recruitment_requests WHERE route_id=$1 AND created_by=$2 AND status='open')", rid, user).Scan(&existing); e != nil {
		return Recruitment{}, e
	}
	if existing {
		return Recruitment{}, domain.ErrDuplicate
	}
	if e = checkSubmission(ctx, tx, user, "recruitment:"+rid, "recruitment", body); e != nil {
		return Recruitment{}, e
	}
	x := Recruitment{RouteID: rid, CreatorID: user, Body: body, Status: "open", InterestedCount: 1}
	var date any
	if preferredDate != "" {
		date = preferredDate
		x.PreferredDate = &preferredDate
	}
	e = tx.QueryRow(ctx, "INSERT INTO recruitment_requests(route_id,created_by,preferred_date,body) VALUES($1,$2,$3,$4) RETURNING id::text,created_at", rid, user, date, body).Scan(&x.ID, &x.CreatedAt)
	if e != nil {
		return x, dbErr(e)
	}
	_, e = tx.Exec(ctx, "INSERT INTO recruitment_members(request_id,user_id) VALUES($1,$2)", x.ID, user)
	if e != nil {
		return x, e
	}
	e = tx.QueryRow(ctx, "SELECT display_name FROM users WHERE id=$1", user).Scan(&x.CreatorName)
	if e != nil {
		return x, e
	}
	if e = recordSubmission(ctx, tx, user, "recruitment:"+rid, "recruitment", body); e != nil {
		return x, e
	}
	return x, tx.Commit(ctx)
}
func (s *Store) JoinRecruitment(ctx context.Context, user, id string) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Match DeleteAccount's user-first lock order. A request authenticated before
	// account closure must not recreate interest after its removal commits.
	var activeUser string
	e = tx.QueryRow(ctx, "SELECT id::text FROM users WHERE id=$1 AND NOT disabled AND deleted_at IS NULL FOR SHARE", user).Scan(&activeUser)
	if errors.Is(e, pgx.ErrNoRows) {
		return domain.ErrUnauthorized
	}
	if e != nil {
		return e
	}
	var real, status string
	e = tx.QueryRow(ctx, "SELECT id::text,status FROM recruitment_requests WHERE id::text=$1 FOR UPDATE", id).Scan(&real, &status)
	if e != nil {
		return dbErr(e)
	}
	if status != "open" {
		return domain.ErrConflict
	}
	var existing bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM recruitment_members WHERE request_id=$1 AND user_id=$2)", real, user).Scan(&existing)
	if e != nil {
		return e
	}
	if existing {
		return tx.Commit(ctx)
	}
	var n int
	e = tx.QueryRow(ctx, "SELECT count(*) FROM recruitment_members WHERE request_id=$1", real).Scan(&n)
	if e != nil {
		return e
	}
	if n >= 100 {
		return domain.ErrFull
	}
	_, e = tx.Exec(ctx, "INSERT INTO recruitment_members(request_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", real, user)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (s *Store) LeaveRecruitment(ctx context.Context, user, id string) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var real, owner, status string
	e = tx.QueryRow(ctx, "SELECT id::text,created_by::text,status FROM recruitment_requests WHERE id::text=$1 FOR UPDATE", id).Scan(&real, &owner, &status)
	if e != nil {
		return dbErr(e)
	}
	if owner == user && status == "open" {
		if _, e = tx.Exec(ctx, "UPDATE recruitment_requests SET status='cancelled' WHERE id=$1", real); e != nil {
			return e
		}
	}
	_, e = tx.Exec(ctx, "DELETE FROM recruitment_members WHERE request_id=$1 AND user_id=$2", real, user)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func (s *Store) AcceptRecruitment(ctx context.Context, user, id string, in CreateDeparture) (domain.Departure, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return domain.Departure{}, e
	}
	defer tx.Rollback(ctx)
	var req, route, status string
	var dep *string
	e = tx.QueryRow(ctx, "SELECT id::text,route_id::text,status,departure_id::text FROM recruitment_requests WHERE id::text=$1 FOR UPDATE", id).Scan(&req, &route, &status, &dep)
	if e != nil {
		return domain.Departure{}, dbErr(e)
	}
	if status != "open" {
		return domain.Departure{}, domain.ErrConflict
	}
	if in.RouteID != "" && in.RouteID != route {
		return domain.Departure{}, domain.ErrInvalid
	}
	in.RouteID = route
	depID, e := createDepartureTx(ctx, tx, user, in)
	if e != nil {
		return domain.Departure{}, e
	}
	_, e = tx.Exec(ctx, "UPDATE recruitment_requests SET status='accepted',departure_id=$2 WHERE id=$1", req, depID)
	if e != nil {
		return domain.Departure{}, e
	}
	_, e = tx.Exec(ctx, "INSERT INTO recruitment_members(request_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", req, user)
	if e != nil {
		return domain.Departure{}, e
	}
	// Interest is not booking: every tourist must explicitly accept the guide's dates
	// and join the new departure. No one is silently promoted to confirmed attendance.
	if e = tx.Commit(ctx); e != nil {
		return domain.Departure{}, e
	}
	return s.Departure(ctx, depID, user)
}
func (s *Store) RecruitmentMessages(ctx context.Context, user, id string) ([]RecruitmentMessage, error) {
	var allowed bool
	e := s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM recruitment_members WHERE request_id::text=$1 AND user_id=$2)", id, user).Scan(&allowed)
	if e != nil {
		return nil, e
	}
	if !allowed {
		return nil, domain.ErrForbidden
	}
	// Recheck membership in the same snapshot as the message read. A withdrawal
	// committed after the first check must not expose subsequently written messages.
	rows, e := s.Pool.Query(ctx, `SELECT m.id::text,m.request_id::text,m.user_id::text,u.display_name,CASE WHEN m.visibility='visible' THEN m.body ELSE '' END,m.visibility,m.client_id,m.created_at FROM (SELECT * FROM recruitment_messages rm WHERE request_id::text=$1 AND EXISTS(SELECT 1 FROM recruitment_members member WHERE member.request_id=rm.request_id AND member.user_id=$2) ORDER BY created_at DESC,id DESC LIMIT 100) m JOIN users u ON u.id=m.user_id ORDER BY m.created_at,m.id`, id, user)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []RecruitmentMessage{}
	for rows.Next() {
		var m RecruitmentMessage
		e = rows.Scan(&m.ID, &m.RequestID, &m.UserID, &m.DisplayName, &m.Body, &m.Visibility, &m.ClientID, &m.CreatedAt)
		if e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func ownRecruitmentMessage(ctx context.Context, tx pgx.Tx, user, clientID string) (m RecruitmentMessage, e error) {
	e = tx.QueryRow(ctx, "SELECT m.id::text,m.request_id::text,m.user_id::text,u.display_name,m.body,m.visibility,m.client_id,m.created_at FROM recruitment_messages m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.client_id=$2", user, clientID).Scan(&m.ID, &m.RequestID, &m.UserID, &m.DisplayName, &m.Body, &m.Visibility, &m.ClientID, &m.CreatedAt)
	return m, e
}
func (s *Store) SendRecruitmentMessage(ctx context.Context, user, id, body, clientID string) (RecruitmentMessage, error) {
	body = abuse.NormalizeBody(body)
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return RecruitmentMessage{}, e
	}
	defer tx.Rollback(ctx)
	var real string
	if e = tx.QueryRow(ctx, "SELECT id::text FROM recruitment_requests WHERE id::text=$1 FOR SHARE", id).Scan(&real); e != nil {
		return RecruitmentMessage{}, dbErr(e)
	}
	var allowed bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM recruitment_members WHERE request_id=$1 AND user_id=$2)", real, user).Scan(&allowed); e != nil {
		return RecruitmentMessage{}, e
	}
	if !allowed {
		return RecruitmentMessage{}, domain.ErrForbidden
	}
	if e = lockPosting(ctx, tx, user); e != nil {
		return RecruitmentMessage{}, e
	}
	existing, e := ownRecruitmentMessage(ctx, tx, user, clientID)
	if e == nil {
		if existing.RequestID != real || existing.Body != body {
			return RecruitmentMessage{}, domain.ErrConflict
		}
		if existing.Visibility == "hidden" {
			existing.Body = ""
		}
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return RecruitmentMessage{}, e
	}
	channel := "recruitment:" + real
	if e = checkSubmission(ctx, tx, user, channel, "message", body); e != nil {
		return RecruitmentMessage{}, e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO recruitment_messages(request_id,user_id,body,client_id) VALUES($1,$2,$3,$4)", real, user, body, clientID); e != nil {
		return RecruitmentMessage{}, dbErr(e)
	}
	if e = recordSubmission(ctx, tx, user, channel, "message", body); e != nil {
		return RecruitmentMessage{}, e
	}
	m, e := ownRecruitmentMessage(ctx, tx, user, clientID)
	if e != nil {
		return m, e
	}
	return m, tx.Commit(ctx)
}
