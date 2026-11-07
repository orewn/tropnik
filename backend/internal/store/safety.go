package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"tropa/backend/internal/domain"
)

var phonePattern = regexp.MustCompile(`^[+0-9][0-9 ()-]{6,24}$`)

func loadSafetyKeyFromEnv() ([]byte, error) {
	raw := strings.TrimSpace(os.Getenv("TROPA_SAFETY_DATA_KEY"))
	if raw == "" {
		return nil, nil
	}
	if decoded, err := hex.DecodeString(raw); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	for _, encoding := range []*base64.Encoding{base64.RawStdEncoding, base64.StdEncoding, base64.RawURLEncoding, base64.URLEncoding} {
		if decoded, err := encoding.DecodeString(raw); err == nil && len(decoded) == 32 {
			return decoded, nil
		}
	}
	return nil, fmt.Errorf("TROPA_SAFETY_DATA_KEY must encode exactly 32 bytes")
}

func (s *Store) safetyKey() ([]byte, error) {
	if len(s.SafetyKey) != 32 {
		return nil, domain.ErrSafetyUnavailable
	}
	return s.SafetyKey, nil
}

func encryptSafety(key []byte, departureID string, version int, value any) (encrypted, nonce, digest []byte, err error) {
	plain, err := json.Marshal(value)
	if err != nil {
		return nil, nil, nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err = cryptorand.Read(nonce); err != nil {
		return nil, nil, nil, err
	}
	aad := []byte(fmt.Sprintf("tropnik-safety:%s:%d", departureID, version))
	encrypted = gcm.Seal(nil, nonce, plain, aad)
	hash := sha256.Sum256(plain)
	return encrypted, nonce, hash[:], nil
}

func decryptSafety(key []byte, departureID string, version int, encrypted, nonce []byte, target any) error {
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	plain, err := gcm.Open(nil, nonce, encrypted, []byte(fmt.Sprintf("tropnik-safety:%s:%d", departureID, version)))
	if err != nil {
		return domain.ErrConflict
	}
	return json.Unmarshal(plain, target)
}

type safetyEnvelope struct {
	Public  domain.SafetyPublicPayload  `json:"public"`
	Private domain.SafetyPrivateDetails `json:"private"`
}

type safetyAccess struct {
	GuideID    *string
	GuideName  *string
	StartsAt   time.Time
	EndsAt     time.Time
	TimeZone   string
	Status     string
	Membership string
	Staff      bool
}

func safetyAccessFor(ctx context.Context, q querier, departureID, actor string) (x safetyAccess, err error) {
	err = q.QueryRow(ctx, `SELECT d.guide_id::text,u.display_name,d.starts_at,d.ends_at,d.time_zone,d.status,
 COALESCE(m.status,'none'),COALESCE(a.is_admin OR a.is_moderator,false)
 FROM departures d LEFT JOIN users u ON u.id=d.guide_id LEFT JOIN memberships m ON m.departure_id=d.id AND m.user_id::text=$2
 JOIN users a ON a.id::text=$2 AND NOT a.disabled WHERE d.id::text=$1`, departureID, actor).
		Scan(&x.GuideID, &x.GuideName, &x.StartsAt, &x.EndsAt, &x.TimeZone, &x.Status, &x.Membership, &x.Staff)
	return x, dbErr(err)
}

func (x safetyAccess) guide(actor string) bool { return x.GuideID != nil && *x.GuideID == actor }
func (x safetyAccess) activeMember() bool {
	return x.Membership == "confirmed" || x.Membership == "checked_in" || x.Membership == "completed"
}

func normalizedPhone(value string) (string, bool) {
	value = strings.TrimSpace(value)
	return value, phonePattern.MatchString(value)
}
func boundedText(value string, min, max int) (string, bool) {
	value = strings.TrimSpace(value)
	return value, len([]rune(value)) >= min && len([]rune(value)) <= max
}

func beginSafetyMutation(ctx context.Context, tx pgx.Tx, actor, key, operation string, request any) ([]byte, error) {
	if len(key) < 16 || len(key) > 128 {
		return nil, domain.ErrInvalid
	}
	raw, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(append([]byte(operation+":"), raw...))
	if _, err = tx.Exec(ctx, "INSERT INTO idempotency_keys(user_id,key,operation,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", actor, key, operation, digest[:]); err != nil {
		return nil, err
	}
	var storedOperation string
	var storedHash, response []byte
	if err = tx.QueryRow(ctx, "SELECT operation,request_hash,response FROM idempotency_keys WHERE user_id=$1 AND key=$2 FOR UPDATE", actor, key).Scan(&storedOperation, &storedHash, &response); err != nil {
		return nil, err
	}
	if storedOperation != operation || !equalBytes(storedHash, digest[:]) {
		return nil, domain.ErrConflict
	}
	return response, nil
}
func finishSafetyMutation(ctx context.Context, tx pgx.Tx, actor, key string, response any) error {
	raw, err := json.Marshal(response)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE idempotency_keys SET response=$3 WHERE user_id=$1 AND key=$2", actor, key, raw)
	return err
}

func validateSafetyPrepare(in *domain.SafetyPrepareInput) error {
	var ok bool
	if in.LeaderPhone, ok = normalizedPhone(in.LeaderPhone); !ok {
		return domain.ErrInvalid
	}
	if in.EmergencyContactPhone, ok = normalizedPhone(in.EmergencyContactPhone); !ok {
		return domain.ErrInvalid
	}
	if in.EmergencyContactName, ok = boundedText(in.EmergencyContactName, 2, 120); !ok {
		return domain.ErrInvalid
	}
	fields := []*string{&in.CommunicationPlan, &in.Transport, &in.BackupRoute, &in.Equipment, &in.FirstAid, &in.Insurance}
	for _, field := range fields {
		if *field, ok = boundedText(*field, 1, 2000); !ok {
			return domain.ErrInvalid
		}
	}
	if in.Notes, ok = boundedText(in.Notes, 0, 4000); !ok {
		return domain.ErrInvalid
	}
	if len(in.Participants) < 1 || len(in.Participants) > 50 {
		return domain.ErrInvalid
	}
	seen := map[string]bool{}
	for i := range in.Participants {
		contact := &in.Participants[i]
		contact.UserID = strings.TrimSpace(contact.UserID)
		if contact.UserID == "" || seen[contact.UserID] {
			return domain.ErrInvalid
		}
		seen[contact.UserID] = true
		if contact.Phone, ok = normalizedPhone(contact.Phone); !ok {
			return domain.ErrInvalid
		}
	}
	return nil
}

func appendSafetyEvent(ctx context.Context, tx pgx.Tx, departureID, actor, eventType string, payload map[string]any) error {
	var sequence int
	var previous []byte
	if err := tx.QueryRow(ctx, "SELECT event_sequence,event_hash FROM departure_safety WHERE departure_id=$1 FOR UPDATE", departureID).Scan(&sequence, &previous); err != nil {
		return dbErr(err)
	}
	sequence++
	created := time.Now().UTC().Truncate(time.Microsecond)
	body, err := json.Marshal(struct {
		DepartureID string         `json:"departureId"`
		Sequence    int            `json:"sequence"`
		EventType   string         `json:"eventType"`
		Actor       string         `json:"actor"`
		Payload     map[string]any `json:"payload"`
		CreatedAt   string         `json:"createdAt"`
	}{departureID, sequence, eventType, actor, payload, created.Format(time.RFC3339Nano)})
	if err != nil {
		return err
	}
	material := append(append([]byte(nil), previous...), body...)
	hash := sha256.Sum256(material)
	var actorValue any
	if actor != "" {
		actorValue = actor
	}
	if _, err = tx.Exec(ctx, `INSERT INTO safety_events(departure_id,sequence,event_type,actor_id,payload,previous_hash,event_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, departureID, sequence, eventType, actorValue, payload, previous, hash[:], created); err != nil {
		return dbErr(err)
	}
	_, err = tx.Exec(ctx, "UPDATE departure_safety SET event_sequence=$2,event_hash=$3,updated_at=now() WHERE departure_id=$1", departureID, sequence, hash[:])
	return err
}

func (s *Store) PrepareSafetyPassport(ctx context.Context, actor, departureID, key string, in domain.SafetyPrepareInput) (domain.SafetyPassport, error) {
	if err := validateSafetyPrepare(&in); err != nil {
		return domain.SafetyPassport{}, err
	}
	dataKey, err := s.safetyKey()
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	defer tx.Rollback(ctx)
	replay, err := beginSafetyMutation(ctx, tx, actor, key, "safety.prepare:"+departureID, in)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if len(replay) > 0 {
		if err = finishSafetyMutation(ctx, tx, actor, key, map[string]any{"ok": true}); err != nil {
			return domain.SafetyPassport{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return domain.SafetyPassport{}, dbErr(err)
		}
		return s.SafetyPassport(ctx, actor, departureID)
	}
	g, err := readGroup(ctx, tx, departureID, true)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if !g.IsGuide(actor) || (g.Status != "recruiting" && g.Status != "ready" && g.Status != "awaiting_guide") || !time.Now().UTC().Before(g.StartsAt) {
		return domain.SafetyPassport{}, domain.ErrForbidden
	}
	var version int
	var policy, currentStatus string
	if err = tx.QueryRow(ctx, "SELECT passport_version,notification_policy,status FROM departure_safety WHERE departure_id=$1 FOR UPDATE", departureID).Scan(&version, &policy, &currentStatus); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	var route domain.SafetyRouteSnapshot
	var emergencyRaw, controlRaw, scheduleRaw []byte
	err = tx.QueryRow(ctx, `SELECT r.id::text,rr.id::text,r.title,r.description,rr.risk_class,rr.route_type,rr.legal_difficulty_category,COALESCE(rr.mchs_territorial_unit_id,''),rr.emergency_exits,rr.control_points,rr.default_check_in_schedule,rr.safety_revision
 FROM routes r JOIN route_revisions rr ON rr.id=$2 WHERE r.id=$1`, g.RouteID, g.RouteRevisionID).
		Scan(&route.RouteID, &route.RouteRevisionID, &route.Title, &route.Description, &route.RiskClass, &route.RouteType, &route.LegalDifficultyCategory, &route.TerritorialUnitID, &emergencyRaw, &controlRaw, &scheduleRaw, &route.SafetyRevision)
	if err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	if err = json.Unmarshal(emergencyRaw, &route.EmergencyExits); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = json.Unmarshal(controlRaw, &route.ControlPoints); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = json.Unmarshal(scheduleRaw, &route.DefaultCheckInSchedule); err != nil {
		return domain.SafetyPassport{}, err
	}
	rows, err := tx.Query(ctx, `SELECT m.user_id::text,u.display_name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.departure_id=$1 AND m.status IN ('confirmed','checked_in') ORDER BY CASE WHEN m.role='guide' THEN 0 ELSE 1 END,u.display_name,u.id`, departureID)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	contacts := map[string]string{}
	for _, contact := range in.Participants {
		contacts[contact.UserID] = contact.Phone
	}
	members := []domain.SafetyParticipantContact{}
	manifestIDs := []string{}
	for rows.Next() {
		var member domain.SafetyParticipantContact
		if err = rows.Scan(&member.UserID, &member.DisplayName, &member.Role); err != nil {
			rows.Close()
			return domain.SafetyPassport{}, err
		}
		phone, found := contacts[member.UserID]
		if !found {
			rows.Close()
			return domain.SafetyPassport{}, domain.ErrInvalid
		}
		member.Phone = phone
		members = append(members, member)
		manifestIDs = append(manifestIDs, member.UserID+":"+member.Role)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return domain.SafetyPassport{}, err
	}
	rows.Close()
	if len(members) != len(in.Participants) || len(members) != g.ActiveCount() {
		return domain.SafetyPassport{}, domain.ErrConflict
	}
	sort.Strings(manifestIDs)
	manifestRaw, _ := json.Marshal(map[string]any{"departureId": departureID, "routeRevisionId": g.RouteRevisionID, "startsAt": g.StartsAt, "endsAt": g.EndsAt, "members": manifestIDs})
	manifestHash := sha256.Sum256(manifestRaw)
	prepared := time.Now().UTC()
	public := domain.SafetyPublicPayload{Route: route, StartsAt: g.StartsAt, EndsAt: g.EndsAt, TimeZone: g.TimeZone, LeaderName: valueOr(g.GuideName, ""), ParticipantCount: len(members), PreparedAt: prepared}
	private := domain.SafetyPrivateDetails{LeaderPhone: in.LeaderPhone, EmergencyContactName: in.EmergencyContactName, EmergencyContactPhone: in.EmergencyContactPhone, CommunicationPlan: in.CommunicationPlan, Transport: in.Transport, BackupRoute: in.BackupRoute, Equipment: in.Equipment, FirstAid: in.FirstAid, Insurance: in.Insurance, Notes: in.Notes, Participants: members}
	version++
	ciphertext, nonce, digest, err := encryptSafety(dataKey, departureID, version, safetyEnvelope{Public: public, Private: private})
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	publicRaw, err := json.Marshal(public)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO safety_passport_versions(departure_id,version,payload_cipher,payload_nonce,public_payload,content_hash,manifest_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, departureID, version, ciphertext, nonce, publicRaw, digest, manifestHash[:], actor); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	nextStatus := "ready_to_submit"
	if policy == "not_required" {
		nextStatus = "not_required"
	}
	_, err = tx.Exec(ctx, `UPDATE departure_safety SET passport_version=$2,status=$3,passport_hash=$4,manifest_hash=$5,territorial_unit_id=NULLIF($6,''),submission_id=NULL,submitted_at=NULL,confirmation_ref=NULL,confirmation_hash=NULL,confirmed_at=NULL,confirmed_by=NULL,start_contact_confirmed_at=NULL,return_reported_at=NULL,last_safety_change_at=now(),updated_at=now() WHERE departure_id=$1`, departureID, version, nextStatus, digest, manifestHash[:], route.TerritorialUnitID)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = appendSafetyEvent(ctx, tx, departureID, actor, "passport.prepared", map[string]any{"version": version, "policy": policy, "previousStatus": currentStatus, "passportHash": hex.EncodeToString(digest)}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = finishSafetyMutation(ctx, tx, actor, key, map[string]any{"ok": true}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	return s.SafetyPassport(ctx, actor, departureID)
}

func valueOr(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func (s *Store) SafetyPassport(ctx context.Context, actor, departureID string) (domain.SafetyPassport, error) {
	access, err := safetyAccessFor(ctx, s.Pool, departureID, actor)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if !access.guide(actor) && !access.Staff && !access.activeMember() {
		return domain.SafetyPassport{}, domain.ErrForbidden
	}
	var out domain.SafetyPassport
	out.DepartureID = departureID
	out.OfficialFormURL = domain.MCHSOfficialFormURL
	var passportHash, manifestHash []byte
	err = s.Pool.QueryRow(ctx, `SELECT passport_version,status,notification_policy,submission_id,submitted_at,confirmed_at,start_contact_confirmed_at,return_reported_at,passport_hash,manifest_hash FROM departure_safety WHERE departure_id=$1`, departureID).
		Scan(&out.Version, &out.Status, &out.NotificationPolicy, &out.SubmissionID, &out.SubmittedAt, &out.ConfirmedAt, &out.StartContactConfirmedAt, &out.ReturnReportedAt, &passportHash, &manifestHash)
	if err != nil {
		return out, dbErr(err)
	}
	loc, _ := time.LoadLocation(access.TimeZone)
	if loc == nil {
		loc = time.UTC
	}
	out.SubmissionDeadline = domain.MCHSSubmissionDeadline(access.StartsAt.In(loc))
	out.PassportHash = hex.EncodeToString(passportHash)
	out.ManifestHash = hex.EncodeToString(manifestHash)
	if out.Version == 0 {
		return out, nil
	}
	var publicRaw, ciphertext, nonce []byte
	if err = s.Pool.QueryRow(ctx, `SELECT public_payload,payload_cipher,payload_nonce FROM safety_passport_versions WHERE departure_id=$1 AND version=$2`, departureID, out.Version).Scan(&publicRaw, &ciphertext, &nonce); err != nil {
		return out, dbErr(err)
	}
	var public domain.SafetyPublicPayload
	if err = json.Unmarshal(publicRaw, &public); err != nil {
		return out, err
	}
	out.Public = &public
	if access.guide(actor) || access.Staff {
		key, err := s.safetyKey()
		if err != nil {
			return out, err
		}
		var envelope safetyEnvelope
		if err = decryptSafety(key, departureID, out.Version, ciphertext, nonce, &envelope); err != nil {
			return out, err
		}
		out.Private = &envelope.Private
	}
	return out, nil
}

func (s *Store) RecordMCHSSubmission(ctx context.Context, actor, departureID, key string, in domain.MCHSSubmissionInput) (domain.SafetyPassport, error) {
	in.SubmissionID = strings.TrimSpace(in.SubmissionID)
	if len([]rune(in.SubmissionID)) < 3 || len([]rune(in.SubmissionID)) > 160 || in.SubmittedAt.IsZero() || in.SubmittedAt.After(time.Now().UTC().Add(5*time.Minute)) {
		return domain.SafetyPassport{}, domain.ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	defer tx.Rollback(ctx)
	replay, err := beginSafetyMutation(ctx, tx, actor, key, "mchs.submission:"+departureID, in)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if len(replay) > 0 {
		if err = finishSafetyMutation(ctx, tx, actor, key, map[string]any{"ok": true}); err != nil {
			return domain.SafetyPassport{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return domain.SafetyPassport{}, dbErr(err)
		}
		return s.SafetyPassport(ctx, actor, departureID)
	}
	access, err := safetyAccessFor(ctx, tx, departureID, actor)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if !access.guide(actor) {
		return domain.SafetyPassport{}, domain.ErrForbidden
	}
	var version int
	var status, policy string
	if err = tx.QueryRow(ctx, "SELECT passport_version,status,notification_policy FROM departure_safety WHERE departure_id=$1 FOR UPDATE", departureID).Scan(&version, &status, &policy); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	if version < 1 || status != "ready_to_submit" || policy == "not_required" {
		return domain.SafetyPassport{}, domain.ErrNotReady
	}
	_, err = tx.Exec(ctx, `UPDATE departure_safety SET status='submitted_unverified',submission_id=$2,submitted_at=$3,confirmation_ref=NULL,confirmation_hash=NULL,confirmed_at=NULL,confirmed_by=NULL,start_contact_confirmed_at=NULL,updated_at=now() WHERE departure_id=$1`, departureID, in.SubmissionID, in.SubmittedAt.UTC())
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = appendSafetyEvent(ctx, tx, departureID, actor, "mchs.submitted", map[string]any{"submissionId": in.SubmissionID, "submittedAt": in.SubmittedAt.UTC()}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = finishSafetyMutation(ctx, tx, actor, key, map[string]any{"ok": true}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	return s.SafetyPassport(ctx, actor, departureID)
}

func (s *Store) ConfirmMCHSRegistration(ctx context.Context, actor, departureID, key string, in domain.MCHSConfirmationInput) (domain.SafetyPassport, error) {
	in.ConfirmationRef = strings.TrimSpace(in.ConfirmationRef)
	if len([]rune(in.ConfirmationRef)) < 3 || len([]rune(in.ConfirmationRef)) > 240 {
		return domain.SafetyPassport{}, domain.ErrInvalid
	}
	var confirmationHash []byte
	if strings.TrimSpace(in.ConfirmationSHA256) != "" {
		decoded, err := hex.DecodeString(strings.TrimSpace(in.ConfirmationSHA256))
		if err != nil || len(decoded) != 32 {
			return domain.SafetyPassport{}, domain.ErrInvalid
		}
		confirmationHash = decoded
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	defer tx.Rollback(ctx)
	replay, err := beginSafetyMutation(ctx, tx, actor, key, "mchs.confirmation:"+departureID, in)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if len(replay) > 0 {
		if err = finishSafetyMutation(ctx, tx, actor, key, map[string]any{"ok": true}); err != nil {
			return domain.SafetyPassport{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return domain.SafetyPassport{}, dbErr(err)
		}
		return s.SafetyPassport(ctx, actor, departureID)
	}
	access, err := safetyAccessFor(ctx, tx, departureID, actor)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if !access.Staff {
		return domain.SafetyPassport{}, domain.ErrForbidden
	}
	var status string
	if err = tx.QueryRow(ctx, "SELECT status FROM departure_safety WHERE departure_id=$1 FOR UPDATE", departureID).Scan(&status); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	if status != "submitted_unverified" {
		return domain.SafetyPassport{}, domain.ErrConflict
	}
	_, err = tx.Exec(ctx, `UPDATE departure_safety SET status='start_contact_pending',confirmation_ref=$2,confirmation_hash=$3,confirmed_at=now(),confirmed_by=$4,updated_at=now() WHERE departure_id=$1`, departureID, in.ConfirmationRef, confirmationHash, actor)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = appendSafetyEvent(ctx, tx, departureID, actor, "mchs.confirmed", map[string]any{"confirmationRef": in.ConfirmationRef}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = finishSafetyMutation(ctx, tx, actor, key, map[string]any{"ok": true}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	return s.SafetyPassport(ctx, actor, departureID)
}

func (s *Store) ConfirmMCHSStartContact(ctx context.Context, actor, departureID, key string, in domain.MCHSStartContactInput) (domain.SafetyPassport, error) {
	in.Note = strings.TrimSpace(in.Note)
	if len([]rune(in.Note)) > 1000 || in.ContactedAt.IsZero() || in.ContactedAt.After(time.Now().UTC().Add(5*time.Minute)) {
		return domain.SafetyPassport{}, domain.ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	defer tx.Rollback(ctx)
	replay, err := beginSafetyMutation(ctx, tx, actor, key, "mchs.start-contact:"+departureID, in)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if len(replay) > 0 {
		if err = tx.Commit(ctx); err != nil {
			return domain.SafetyPassport{}, dbErr(err)
		}
		return s.SafetyPassport(ctx, actor, departureID)
	}
	access, err := safetyAccessFor(ctx, tx, departureID, actor)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if !access.guide(actor) {
		return domain.SafetyPassport{}, domain.ErrForbidden
	}
	var status string
	if err = tx.QueryRow(ctx, "SELECT status FROM departure_safety WHERE departure_id=$1 FOR UPDATE", departureID).Scan(&status); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	if status != "start_contact_pending" && status != "confirmed" {
		return domain.SafetyPassport{}, domain.ErrNotReady
	}
	contacted := in.ContactedAt.UTC()
	if contacted.Before(access.StartsAt.Add(-24*time.Hour)) || contacted.After(access.StartsAt.Add(2*time.Hour)) {
		return domain.SafetyPassport{}, domain.ErrInvalid
	}
	_, err = tx.Exec(ctx, `UPDATE departure_safety SET status='confirmed',start_contact_confirmed_at=$2,updated_at=now() WHERE departure_id=$1`, departureID, contacted)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = appendSafetyEvent(ctx, tx, departureID, actor, "mchs.start_contact", map[string]any{"contactedAt": contacted, "note": in.Note}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = finishSafetyMutation(ctx, tx, actor, key, map[string]any{"ok": true}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	return s.SafetyPassport(ctx, actor, departureID)
}

func (s *Store) ReportMCHSReturn(ctx context.Context, actor, departureID, key string, in domain.MCHSReturnReportInput) (domain.SafetyPassport, error) {
	in.Method = strings.TrimSpace(in.Method)
	in.Note = strings.TrimSpace(in.Note)
	if len([]rune(in.Method)) < 2 || len([]rune(in.Method)) > 120 || len([]rune(in.Note)) > 1000 || in.ReportedAt.IsZero() || in.ReportedAt.After(time.Now().UTC().Add(5*time.Minute)) {
		return domain.SafetyPassport{}, domain.ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	defer tx.Rollback(ctx)
	replay, err := beginSafetyMutation(ctx, tx, actor, key, "mchs.return-report:"+departureID, in)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if len(replay) > 0 {
		if err = tx.Commit(ctx); err != nil {
			return domain.SafetyPassport{}, dbErr(err)
		}
		return s.SafetyPassport(ctx, actor, departureID)
	}
	access, err := safetyAccessFor(ctx, tx, departureID, actor)
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if !access.guide(actor) {
		return domain.SafetyPassport{}, domain.ErrForbidden
	}
	var status string
	if err = tx.QueryRow(ctx, "SELECT status FROM departure_safety WHERE departure_id=$1 FOR UPDATE", departureID).Scan(&status); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	if status != "return_report_pending" && status != "active" {
		return domain.SafetyPassport{}, domain.ErrNotReady
	}
	_, err = tx.Exec(ctx, `UPDATE departure_safety SET status='closed',return_reported_at=$2,updated_at=now() WHERE departure_id=$1`, departureID, in.ReportedAt.UTC())
	if err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = appendSafetyEvent(ctx, tx, departureID, actor, "mchs.return_reported", map[string]any{"reportedAt": in.ReportedAt.UTC(), "method": in.Method, "note": in.Note}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = finishSafetyMutation(ctx, tx, actor, key, map[string]any{"ok": true}); err != nil {
		return domain.SafetyPassport{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SafetyPassport{}, dbErr(err)
	}
	return s.SafetyPassport(ctx, actor, departureID)
}

func (s *Store) RecordSafetyCheckIn(ctx context.Context, actor, departureID, key string, in domain.SafetyCheckInInput) (domain.SafetyCheckIn, error) {
	in.Kind = strings.TrimSpace(in.Kind)
	in.Note = strings.TrimSpace(in.Note)
	if in.Kind != "start" && in.Kind != "control_point" && in.Kind != "return" && in.Kind != "incident" {
		return domain.SafetyCheckIn{}, domain.ErrInvalid
	}
	if len([]rune(in.Note)) > 1000 || in.ObservedAt.IsZero() || in.ObservedAt.After(time.Now().UTC().Add(5*time.Minute)) || (in.Latitude == nil) != (in.Longitude == nil) {
		return domain.SafetyCheckIn{}, domain.ErrInvalid
	}
	if in.Latitude != nil && (*in.Latitude < -90 || *in.Latitude > 90 || *in.Longitude < -180 || *in.Longitude > 180) {
		return domain.SafetyCheckIn{}, domain.ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return domain.SafetyCheckIn{}, err
	}
	defer tx.Rollback(ctx)
	replay, err := beginSafetyMutation(ctx, tx, actor, key, "safety.check-in:"+departureID, in)
	if err != nil {
		return domain.SafetyCheckIn{}, err
	}
	if len(replay) > 0 {
		var out domain.SafetyCheckIn
		if err = json.Unmarshal(replay, &out); err != nil {
			return out, err
		}
		if err = tx.Commit(ctx); err != nil {
			return out, dbErr(err)
		}
		return out, nil
	}
	access, err := safetyAccessFor(ctx, tx, departureID, actor)
	if err != nil {
		return domain.SafetyCheckIn{}, err
	}
	if !access.guide(actor) {
		return domain.SafetyCheckIn{}, domain.ErrForbidden
	}
	var out domain.SafetyCheckIn
	err = tx.QueryRow(ctx, `INSERT INTO safety_check_ins(departure_id,actor_id,kind,observed_at,latitude,longitude,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text,departure_id::text,actor_id::text,kind,observed_at,server_received_at,latitude,longitude,note`, departureID, actor, in.Kind, in.ObservedAt.UTC(), in.Latitude, in.Longitude, in.Note).Scan(&out.ID, &out.DepartureID, &out.ActorID, &out.Kind, &out.ObservedAt, &out.ServerReceivedAt, &out.Latitude, &out.Longitude, &out.Note)
	if err != nil {
		return out, dbErr(err)
	}
	if err = appendSafetyEvent(ctx, tx, departureID, actor, "check_in."+in.Kind, map[string]any{"checkInId": out.ID, "observedAt": out.ObservedAt, "hasCoordinates": out.Latitude != nil}); err != nil {
		return out, err
	}
	if err = finishSafetyMutation(ctx, tx, actor, key, out); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, dbErr(err)
	}
	return out, nil
}

func (s *Store) EmergencyCard(ctx context.Context, actor, departureID string) (domain.EmergencyCard, error) {
	access, err := safetyAccessFor(ctx, s.Pool, departureID, actor)
	if err != nil {
		return domain.EmergencyCard{}, err
	}
	if !access.Staff && !access.activeMember() && !access.guide(actor) {
		return domain.EmergencyCard{}, domain.ErrForbidden
	}
	passport, err := s.SafetyPassport(ctx, actor, departureID)
	if err != nil {
		return domain.EmergencyCard{}, err
	}
	var card domain.EmergencyCard
	card.DepartureID = departureID
	card.EmergencyNumber = "112"
	card.StartsAt = access.StartsAt
	card.EndsAt = access.EndsAt
	card.TimeZone = access.TimeZone
	card.LeaderName = valueOr(access.GuideName, "")
	card.MCHSStatus = passport.Status
	card.MCHSSubmissionID = passport.SubmissionID
	if passport.Public != nil {
		card.RouteTitle = passport.Public.Route.Title
		card.TerritorialUnitID = passport.Public.Route.TerritorialUnitID
		card.ControlPoints = passport.Public.Route.ControlPoints
		card.EmergencyExits = passport.Public.Route.EmergencyExits
	} else {
		_ = s.Pool.QueryRow(ctx, "SELECT r.title FROM departures d JOIN routes r ON r.id=d.route_id WHERE d.id=$1", departureID).Scan(&card.RouteTitle)
	}
	if passport.Version > 0 {
		key, err := s.safetyKey()
		if err != nil {
			return card, err
		}
		var ciphertext, nonce []byte
		if err = s.Pool.QueryRow(ctx, "SELECT payload_cipher,payload_nonce FROM safety_passport_versions WHERE departure_id=$1 AND version=$2", departureID, passport.Version).Scan(&ciphertext, &nonce); err != nil {
			return card, dbErr(err)
		}
		var envelope safetyEnvelope
		if err = decryptSafety(key, departureID, passport.Version, ciphertext, nonce, &envelope); err != nil {
			return card, err
		}
		card.LeaderPhone = envelope.Private.LeaderPhone
		card.EmergencyContactName = envelope.Private.EmergencyContactName
		card.EmergencyContactPhone = envelope.Private.EmergencyContactPhone
	}
	card.MessageTemplate = fmt.Sprintf("Нужна помощь группе похода «%s». Руководитель: %s. Маршрут с %s по %s. Регистрация МЧС: %s. Координаты сообщу отдельно.", card.RouteTitle, card.LeaderName, card.StartsAt.Format(time.RFC3339), card.EndsAt.Format(time.RFC3339), valueOr(card.MCHSSubmissionID, "не указана"))
	return card, nil
}

func authorizeSafetyStartTx(ctx context.Context, tx pgx.Tx, departureID string) error {
	var policy, status string
	var version int
	var contacted *time.Time
	if err := tx.QueryRow(ctx, "SELECT notification_policy,status,passport_version,start_contact_confirmed_at FROM departure_safety WHERE departure_id=$1 FOR UPDATE", departureID).Scan(&policy, &status, &version, &contacted); err != nil {
		return dbErr(err)
	}
	if policy == "required" && (version < 1 || !domain.SafetyStartAllowed(policy, status, contacted != nil)) {
		return domain.ErrNotReady
	}
	return nil
}

func advanceSafetyStateTx(ctx context.Context, tx pgx.Tx, departureID, actor, action string) error {
	var next string
	switch action {
	case "start":
		next = "active"
	case "complete", "abort":
		var submitted *string
		if err := tx.QueryRow(ctx, "SELECT submission_id FROM departure_safety WHERE departure_id=$1 FOR UPDATE", departureID).Scan(&submitted); err != nil {
			return dbErr(err)
		}
		if submitted != nil {
			next = "return_report_pending"
		} else {
			next = "closed"
		}
	case "cancel":
		next = "cancelled"
	default:
		return nil
	}
	if _, err := tx.Exec(ctx, "UPDATE departure_safety SET status=$2,updated_at=now() WHERE departure_id=$1", departureID, next); err != nil {
		return err
	}
	return appendSafetyEvent(ctx, tx, departureID, actor, "departure."+action, map[string]any{"safetyStatus": next})
}

func (s *Store) VerifySafetyEventChain(ctx context.Context, departureID string) error {
	rows, err := s.Pool.Query(ctx, "SELECT sequence,event_type,COALESCE(actor_id::text,''),payload,previous_hash,event_hash,created_at FROM safety_events WHERE departure_id=$1 ORDER BY sequence", departureID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var previous []byte
	expectedSequence := 1
	for rows.Next() {
		var sequence int
		var eventType, actor string
		var payloadRaw, storedPrevious, storedHash []byte
		var created time.Time
		if err = rows.Scan(&sequence, &eventType, &actor, &payloadRaw, &storedPrevious, &storedHash, &created); err != nil {
			return err
		}
		if sequence != expectedSequence || !equalBytes(previous, storedPrevious) {
			return domain.ErrConflict
		}
		var payload map[string]any
		if err = json.Unmarshal(payloadRaw, &payload); err != nil {
			return err
		}
		body, _ := json.Marshal(struct {
			DepartureID string         `json:"departureId"`
			Sequence    int            `json:"sequence"`
			EventType   string         `json:"eventType"`
			Actor       string         `json:"actor"`
			Payload     map[string]any `json:"payload"`
			CreatedAt   string         `json:"createdAt"`
		}{departureID, sequence, eventType, actor, payload, created.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)})
		hash := sha256.Sum256(append(append([]byte(nil), previous...), body...))
		if !equalBytes(hash[:], storedHash) {
			return domain.ErrConflict
		}
		previous = storedHash
		expectedSequence++
	}
	return rows.Err()
}
func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
