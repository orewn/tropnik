package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"tropa/backend/internal/abuse"
	"tropa/backend/internal/domain"
)

func (s *Store) Messages(ctx context.Context, user, id string, after time.Time, afterID string) ([]domain.Message, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	g, e := readGroup(ctx, tx, id, true)
	if e != nil {
		return nil, e
	}
	if !g.CanReadChat(user) {
		return nil, domain.ErrForbidden
	}
	query := `SELECT m.id::text,m.departure_id::text,m.user_id::text,u.display_name,CASE WHEN m.visibility='visible' THEN m.body ELSE '' END,m.visibility,m.client_id,m.created_at FROM messages m JOIN users u ON u.id=m.user_id WHERE m.departure_id=$1 AND (m.created_at>$2 OR (m.created_at=$2 AND m.id::text>$3)) ORDER BY m.created_at,m.id LIMIT 100`
	args := []any{g.ID, after, afterID}
	if after.IsZero() {
		query = `SELECT m.id::text,m.departure_id::text,m.user_id::text,u.display_name,CASE WHEN m.visibility='visible' THEN m.body ELSE '' END,m.visibility,m.client_id,m.created_at FROM (SELECT * FROM messages WHERE departure_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100) m JOIN users u ON u.id=m.user_id ORDER BY m.created_at,m.id`
		args = []any{g.ID}
	}
	rows, e := tx.Query(ctx, query, args...)
	if e != nil {
		return nil, e
	}
	out := []domain.Message{}
	for rows.Next() {
		var m domain.Message
		e = rows.Scan(&m.ID, &m.DepartureID, &m.UserID, &m.DisplayName, &m.Body, &m.Visibility, &m.ClientID, &m.CreatedAt)
		if e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, m)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	return out, tx.Commit(ctx)
}

type Participant struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	Status      string `json:"status"`
}

func (s *Store) Participants(ctx context.Context, user, id string) ([]Participant, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	g, e := readGroup(ctx, tx, id, true)
	if e != nil {
		return nil, e
	}
	// Read access for the assigned guide survives qualification expiry in order to
	// handle incidents. It is never a permission to start or check in the group.
	if g.GuideID == nil || *g.GuideID != user {
		return nil, domain.ErrForbidden
	}
	rows, e := tx.Query(ctx, "SELECT m.user_id::text,u.display_name,m.role,m.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.departure_id=$1 AND m.status<>'cancelled' ORDER BY m.role,u.display_name,m.user_id", g.ID)
	if e != nil {
		return nil, e
	}
	out := []Participant{}
	for rows.Next() {
		var p Participant
		if e = rows.Scan(&p.UserID, &p.DisplayName, &p.Role, &p.Status); e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, p)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	return out, tx.Commit(ctx)
}

func ownMessage(ctx context.Context, tx pgx.Tx, user, clientID string) (m domain.Message, e error) {
	e = tx.QueryRow(ctx, "SELECT m.id::text,m.departure_id::text,m.user_id::text,u.display_name,m.body,m.visibility,m.client_id,m.created_at FROM messages m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.client_id=$2", user, clientID).Scan(&m.ID, &m.DepartureID, &m.UserID, &m.DisplayName, &m.Body, &m.Visibility, &m.ClientID, &m.CreatedAt)
	return m, e
}
func (s *Store) SendMessage(ctx context.Context, user, id, body, clientID string) (domain.Message, error) {
	body = abuse.NormalizeBody(body)
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return domain.Message{}, e
	}
	defer tx.Rollback(ctx)
	g, e := readGroup(ctx, tx, id, true)
	if e != nil {
		return domain.Message{}, e
	}
	if !g.CanReadChat(user) {
		return domain.Message{}, domain.ErrForbidden
	}
	if e = lockPosting(ctx, tx, user); e != nil {
		return domain.Message{}, e
	}
	existing, e := ownMessage(ctx, tx, user, clientID)
	if e == nil {
		if existing.DepartureID != g.ID || existing.Body != body {
			return domain.Message{}, domain.ErrConflict
		}
		if existing.Visibility == "hidden" {
			existing.Body = ""
		}
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return domain.Message{}, e
	}
	channel := "departure:" + g.ID
	if e = checkSubmission(ctx, tx, user, channel, "message", body); e != nil {
		return domain.Message{}, e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO messages(departure_id,user_id,body,client_id) VALUES($1,$2,$3,$4)", g.ID, user, body, clientID); e != nil {
		return domain.Message{}, dbErr(e)
	}
	if e = recordSubmission(ctx, tx, user, channel, "message", body); e != nil {
		return domain.Message{}, e
	}
	m, e := ownMessage(ctx, tx, user, clientID)
	if e != nil {
		return m, e
	}
	return m, tx.Commit(ctx)
}

func (s *Store) Reviews(ctx context.Context, id string) ([]domain.Review, error) {
	rows, e := s.Pool.Query(ctx, `SELECT id::text,departure_id::text,user_id::text,target,rating,body,created_at FROM reviews WHERE departure_id::text=$1 AND visibility='visible' ORDER BY created_at DESC LIMIT 100`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []domain.Review{}
	for rows.Next() {
		var r domain.Review
		e = rows.Scan(&r.ID, &r.DepartureID, &r.UserID, &r.Target, &r.Rating, &r.Body, &r.CreatedAt)
		if e != nil {
			return nil, e
		}
		r.ParticipationConfirmed = true
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *Store) CreateReview(ctx context.Context, user, id, target, body string, rating int) (domain.Review, error) {
	body = abuse.NormalizeBody(body)
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return domain.Review{}, e
	}
	defer tx.Rollback(ctx)
	g, e := readGroup(ctx, tx, id, true)
	if e != nil {
		return domain.Review{}, e
	}
	if !g.CanReview(user, target) {
		return domain.Review{}, domain.ErrForbidden
	}
	var existing bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM reviews WHERE departure_id=$1 AND user_id=$2 AND target=$3)", g.ID, user, target).Scan(&existing); e != nil {
		return domain.Review{}, e
	}
	if existing {
		return domain.Review{}, domain.ErrDuplicate
	}
	if e = lockPosting(ctx, tx, user); e != nil {
		return domain.Review{}, e
	}
	channel := "reviews:" + g.ID
	if e = checkSubmission(ctx, tx, user, channel, "review", body); e != nil {
		return domain.Review{}, e
	}
	r := domain.Review{DepartureID: g.ID, UserID: user, Target: target, Body: body, Rating: rating, ParticipationConfirmed: true}
	e = tx.QueryRow(ctx, "INSERT INTO reviews(departure_id,user_id,target,rating,body) VALUES($1,$2,$3,$4,$5) RETURNING id::text,created_at", g.ID, user, target, rating, body).Scan(&r.ID, &r.CreatedAt)
	if e != nil {
		return r, dbErr(e)
	}
	if e = recordSubmission(ctx, tx, user, channel, "review", body); e != nil {
		return r, e
	}
	return r, tx.Commit(ctx)
}

func (s *Store) RecordObservation(ctx context.Context, user string, o domain.Observation) (domain.SyncAck, error) {
	ack := domain.SyncAck{ClientID: o.ClientID, Status: "rejected", ServerAuthorized: false}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return ack, e
	}
	defer tx.Rollback(ctx)
	g, e := readGroup(ctx, tx, o.DepartureID, true)
	if errors.Is(e, domain.ErrNotFound) {
		ack.Reason = "departure_unavailable"
		return ack, nil
	}
	if e != nil {
		return ack, e
	}
	if !g.CanReadChat(user) {
		ack.Reason = "membership_unavailable"
		return ack, nil
	}
	if o.Kind == "check_in_observation" && !g.IsGuide(user) {
		ack.Reason = "guide_required"
		return ack, nil
	}
	if o.ObservedAt.After(time.Now().Add(5*time.Minute)) || o.ObservedAt.Before(g.CreatedAt) {
		ack.Reason = "invalid_observation_time"
		return ack, nil
	}
	body, _ := json.Marshal(o)
	digest := sha256.Sum256(body)
	var oldDigest, oldAck []byte
	e = tx.QueryRow(ctx, "SELECT request_hash,acknowledgement FROM offline_observations WHERE user_id=$1 AND client_id=$2", user, o.ClientID).Scan(&oldDigest, &oldAck)
	if e == nil {
		if string(oldDigest) != string(digest[:]) {
			ack.Reason = "idempotency_conflict"
			return ack, nil
		}
		e = json.Unmarshal(oldAck, &ack)
		return ack, e
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return ack, e
	}
	ack.CurrentVersion = g.Version
	ack.Status = "recorded"
	if o.BaseVersion != g.Version {
		ack.Status = "conflict"
		ack.Reason = "departure_changed_since_download"
	}
	raw, _ := json.Marshal(ack)
	_, e = tx.Exec(ctx, "INSERT INTO offline_observations(user_id,client_id,departure_id,base_version,observed_at,kind,body,request_hash,acknowledgement) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", user, o.ClientID, g.ID, o.BaseVersion, o.ObservedAt, o.Kind, o.Body, digest[:], raw)
	if e != nil {
		return ack, dbErr(e)
	}
	// Observation storage never changes membership, guide assignment or departure state.
	return ack, tx.Commit(ctx)
}
