package store

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"tropa/backend/internal/abuse"
	"tropa/backend/internal/domain"
)

type reportRecord struct {
	domain.Report
	ReporterID, SubjectID string
}

const reportColumns = "r.id::text,r.target_type,r.target_id::text,r.reason,r.body,r.status,r.created_at,r.resolved_at,r.decision_reason,r.reporter_id::text,r.subject_id::text"

func scanReport(row pgx.Row) (out reportRecord, e error) {
	e = row.Scan(&out.ID, &out.TargetType, &out.TargetID, &out.Reason, &out.Body, &out.Status, &out.CreatedAt, &out.ResolvedAt, &out.DecisionReason, &out.ReporterID, &out.SubjectID)
	return out, dbErr(e)
}

type targetRecord struct{ AuthorID, Body, Visibility, ChannelID string }

func targetTable(kind string) (string, bool) {
	switch kind {
	case "message":
		return "messages", true
	case "recruitment_message":
		return "recruitment_messages", true
	case "review":
		return "reviews", true
	}
	return "", false
}
func targetContent(ctx context.Context, tx pgx.Tx, kind, id string) (out targetRecord, e error) {
	table, ok := targetTable(kind)
	if !ok {
		return out, domain.ErrInvalid
	}
	column := "departure_id"
	if kind == "recruitment_message" {
		column = "request_id"
	}
	e = tx.QueryRow(ctx, "SELECT user_id::text,body,visibility,"+column+"::text FROM "+table+" WHERE id::text=$1", id).Scan(&out.AuthorID, &out.Body, &out.Visibility, &out.ChannelID)
	return out, dbErr(e)
}
func targetAccess(ctx context.Context, tx pgx.Tx, user, kind string, target targetRecord) error {
	if kind == "review" {
		return nil
	}
	table := "departures"
	if kind == "recruitment_message" {
		table = "recruitment_requests"
	}
	var id string
	if e := tx.QueryRow(ctx, "SELECT id::text FROM "+table+" WHERE id=$1 FOR SHARE", target.ChannelID).Scan(&id); e != nil {
		return dbErr(e)
	}
	var allowed bool
	query := "SELECT EXISTS(SELECT 1 FROM memberships WHERE departure_id=$1 AND user_id=$2 AND status IN ('confirmed','checked_in','completed'))"
	if kind == "recruitment_message" {
		query = "SELECT EXISTS(SELECT 1 FROM recruitment_members WHERE request_id=$1 AND user_id=$2)"
	}
	if e := tx.QueryRow(ctx, query, target.ChannelID, user).Scan(&allowed); e != nil {
		return e
	}
	if !allowed {
		return domain.ErrForbidden
	}
	return nil
}
func identity(ctx context.Context, tx pgx.Tx, user string, lock, active bool) (out domain.PublicIdentity, role string, e error) {
	query := "SELECT id::text,display_name,CASE WHEN is_admin THEN 'admin' WHEN is_moderator THEN 'moderator' ELSE 'none' END FROM users WHERE id::text=$1"
	if active {
		query += " AND NOT disabled"
	}
	if lock {
		query += " FOR SHARE"
	}
	e = tx.QueryRow(ctx, query, user).Scan(&out.ID, &out.DisplayName, &role)
	return out, role, dbErr(e)
}
func requireStaff(ctx context.Context, tx pgx.Tx, user string) (string, error) {
	_, role, e := identity(ctx, tx, user, true, true)
	if e != nil {
		return "", e
	}
	if !domain.IsStaff(role) {
		return "", domain.ErrForbidden
	}
	return role, nil
}
func auditModeration(ctx context.Context, tx pgx.Tx, actor, action, entity string, details any) error {
	raw, e := json.Marshal(details)
	if e != nil {
		return e
	}
	var target any
	if entity != "" {
		target = entity
	}
	_, e = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)", actor, action, target, raw)
	return e
}

func (s *Store) CreateReport(ctx context.Context, user string, in domain.ReportInput) (domain.Report, error) {
	out := domain.Report{}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	target, e := targetContent(ctx, tx, in.TargetType, in.TargetID)
	if e != nil {
		return out, e
	}
	if target.AuthorID == user {
		return out, domain.ErrForbidden
	}
	if e = targetAccess(ctx, tx, user, in.TargetType, target); e != nil {
		return out, e
	}
	if e = lockPosting(ctx, tx, user); e != nil {
		return out, e
	}
	var existing bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM reports WHERE reporter_id=$1 AND target_type=$2 AND target_id::text=$3)", user, in.TargetType, in.TargetID).Scan(&existing); e != nil {
		return out, e
	}
	if existing {
		return out, domain.ErrDuplicate
	}
	in.Body = abuse.NormalizeBody(in.Body)
	if e = checkSubmission(ctx, tx, user, in.TargetType+":"+in.TargetID, "report", in.Body); e != nil {
		return out, e
	}
	record, e := scanReport(tx.QueryRow(ctx, "INSERT INTO reports AS r(reporter_id,subject_id,target_type,target_id,reason,body) VALUES($1,$2,$3,$4,$5,$6) RETURNING "+reportColumns, user, target.AuthorID, in.TargetType, in.TargetID, in.Reason, in.Body))
	if e != nil {
		return out, e
	}
	if e = recordSubmission(ctx, tx, user, in.TargetType+":"+in.TargetID, "report", in.Body); e != nil {
		return out, e
	}
	if e = notify(ctx, tx, user, "report", "Жалоба принята", "Обращение сохранено. Модератор проверит материал; автоматического скрытия по жалобе нет."); e != nil {
		return out, e
	}
	if e = auditModeration(ctx, tx, user, "report.created", record.ID, map[string]string{"targetType": in.TargetType, "targetId": in.TargetID}); e != nil {
		return out, e
	}
	return record.Report, dbErr(tx.Commit(ctx))
}
func collectReports(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]reportRecord, error) {
	rows, e := tx.Query(ctx, query, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []reportRecord{}
	for rows.Next() {
		r, e := scanReport(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *Store) MyReports(ctx context.Context, user string) ([]domain.Report, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	items, e := collectReports(ctx, tx, "SELECT "+reportColumns+" FROM reports r WHERE r.reporter_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 100", user)
	if e != nil {
		return nil, e
	}
	out := []domain.Report{}
	for _, item := range items {
		out = append(out, item.Report)
	}
	return out, tx.Commit(ctx)
}
func (s *Store) ModerationReports(ctx context.Context, user, status string) ([]domain.ModerationReport, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	role, e := requireStaff(ctx, tx, user)
	if e != nil {
		return nil, e
	}
	// Filter before LIMIT so inaccessible cases neither leak evidence nor crowd
	// eligible work out of the bounded queue. Recheck the subject under a row
	// lock below in case an operator changes their staff role between reads.
	items, e := collectReports(ctx, tx, "SELECT "+reportColumns+" FROM reports r JOIN users subject ON subject.id=r.subject_id WHERE r.status=$1 AND r.subject_id<>$2 AND r.reporter_id<>$2 AND ($3='admin' OR (NOT subject.is_admin AND NOT subject.is_moderator)) ORDER BY r.created_at,r.id LIMIT 100", status, user, role)
	if e != nil {
		return nil, e
	}
	out := []domain.ModerationReport{}
	for _, item := range items {
		x := domain.ModerationReport{Report: item.Report}
		var subjectRole string
		x.Subject, subjectRole, e = identity(ctx, tx, item.SubjectID, true, false)
		if e != nil {
			return nil, e
		}
		if !domain.CanModerate(user, role, item.SubjectID, subjectRole, item.ReporterID) {
			continue
		}
		x.Reporter, _, e = identity(ctx, tx, item.ReporterID, false, false)
		if e != nil {
			return nil, e
		}
		target, e := targetContent(ctx, tx, item.TargetType, item.TargetID)
		if e != nil {
			return nil, e
		}
		x.TargetBody = target.Body
		x.TargetVisibility = target.Visibility
		out = append(out, x)
	}
	caseIDs := []string{}
	for _, item := range out {
		caseIDs = append(caseIDs, item.ID)
	}
	if e = auditModeration(ctx, tx, user, "moderation.queue_read", "", map[string]any{"status": status, "caseIds": caseIDs}); e != nil {
		return nil, e
	}
	return out, tx.Commit(ctx)
}
func setVisibility(ctx context.Context, tx pgx.Tx, kind, id, visibility string) error {
	table, ok := targetTable(kind)
	if !ok {
		return domain.ErrInvalid
	}
	_, e := tx.Exec(ctx, "UPDATE "+table+" SET visibility=$2 WHERE id::text=$1", id, visibility)
	return e
}
func (s *Store) ResolveReport(ctx context.Context, user, id string, in domain.ResolveReport) (domain.Report, error) {
	out := domain.Report{}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	role, e := requireStaff(ctx, tx, user)
	if e != nil {
		return out, e
	}
	record, e := scanReport(tx.QueryRow(ctx, "SELECT "+reportColumns+" FROM reports r WHERE r.id::text=$1 FOR UPDATE", id))
	if e != nil {
		return out, e
	}
	if record.Status != "open" {
		return out, domain.ErrConflict
	}
	if e = lockPosting(ctx, tx, record.SubjectID); e != nil {
		return out, e
	}
	_, subjectRole, e := identity(ctx, tx, record.SubjectID, true, false)
	if e != nil {
		return out, e
	}
	if !domain.CanModerate(user, role, record.SubjectID, subjectRole, record.ReporterID) {
		return out, domain.ErrForbidden
	}
	in.Reason = abuse.NormalizeBody(in.Reason)
	out = record.Report
	status := "resolved"
	if in.Action == "dismiss" {
		status = "dismissed"
	} else {
		var actionID string
		e = tx.QueryRow(ctx, "INSERT INTO moderation_actions(report_id,subject_id,actor_id,target_type,target_id,action,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6='hide' THEN NULL ELSE now()+make_interval(hours=>$8) END) RETURNING id::text", record.ID, record.SubjectID, user, record.TargetType, record.TargetID, in.Action, in.Reason, in.MuteHours).Scan(&actionID)
		if e != nil {
			return out, dbErr(e)
		}
		if in.Action == "hide" || in.Action == "hide_and_mute" {
			if e = setVisibility(ctx, tx, record.TargetType, record.TargetID, "hidden"); e != nil {
				return out, e
			}
		}
		if e = notify(ctx, tx, record.SubjectID, "moderation", "Решение модерации", in.Reason); e != nil {
			return out, e
		}
	}
	e = tx.QueryRow(ctx, "UPDATE reports SET status=$2,resolved_at=now(),resolved_by=$3,decision_reason=$4 WHERE id=$1 RETURNING resolved_at", record.ID, status, user, in.Reason).Scan(&out.ResolvedAt)
	if e != nil {
		return out, e
	}
	out.Status = status
	out.DecisionReason = &in.Reason
	if e = notify(ctx, tx, record.ReporterID, "report", "Жалоба рассмотрена", in.Reason); e != nil {
		return out, e
	}
	if e = auditModeration(ctx, tx, user, "moderation.report_resolved", record.ID, map[string]any{"action": in.Action, "muteHours": in.MuteHours, "targetType": record.TargetType, "targetId": record.TargetID}); e != nil {
		return out, e
	}
	return out, dbErr(tx.Commit(ctx))
}

type actionRecord struct {
	domain.ModerationAction
	SubjectID, ActorID string
}

const actionColumns = "a.id::text,a.report_id::text,a.target_type,a.target_id::text,a.action,a.reason,a.created_at,a.expires_at,a.revoked_at,p.status,a.subject_id::text,a.actor_id::text"

func scanAction(row pgx.Row) (out actionRecord, e error) {
	e = row.Scan(&out.ID, &out.ReportID, &out.TargetType, &out.TargetID, &out.Action, &out.Reason, &out.CreatedAt, &out.ExpiresAt, &out.RevokedAt, &out.AppealStatus, &out.SubjectID, &out.ActorID)
	return out, dbErr(e)
}
func readAction(ctx context.Context, tx pgx.Tx, id string, lock bool) (actionRecord, error) {
	query := "SELECT " + actionColumns + " FROM moderation_actions a LEFT JOIN appeals p ON p.action_id=a.id WHERE a.id::text=$1"
	if lock {
		query += " FOR UPDATE OF a"
	}
	return scanAction(tx.QueryRow(ctx, query, id))
}
func actionReporter(ctx context.Context, tx pgx.Tx, reportID string) (string, error) {
	var reporter string
	e := tx.QueryRow(ctx, "SELECT reporter_id::text FROM reports WHERE id=$1", reportID).Scan(&reporter)
	return reporter, dbErr(e)
}
func (s *Store) MyModerationActions(ctx context.Context, user string) ([]domain.ModerationAction, error) {
	rows, e := s.Pool.Query(ctx, "SELECT "+actionColumns+" FROM moderation_actions a LEFT JOIN appeals p ON p.action_id=a.id WHERE a.subject_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 100", user)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []domain.ModerationAction{}
	for rows.Next() {
		a, e := scanAction(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, a.ModerationAction)
	}
	return out, rows.Err()
}

const appealColumns = "p.id::text,p.action_id::text,p.body,p.status,p.created_at,p.decided_at,p.decision_reason"

func scanAppeal(row pgx.Row) (out domain.Appeal, e error) {
	e = row.Scan(&out.ID, &out.ActionID, &out.Body, &out.Status, &out.CreatedAt, &out.DecidedAt, &out.DecisionReason)
	return out, dbErr(e)
}
func (s *Store) CreateAppeal(ctx context.Context, user, id, body string) (domain.Appeal, error) {
	out := domain.Appeal{}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	action, e := readAction(ctx, tx, id, true)
	if e != nil {
		return out, e
	}
	if action.SubjectID != user {
		return out, domain.ErrForbidden
	}
	if action.RevokedAt != nil {
		return out, domain.ErrConflict
	}
	if action.AppealStatus != nil {
		return out, domain.ErrDuplicate
	}
	out, e = scanAppeal(tx.QueryRow(ctx, "INSERT INTO appeals AS p(action_id,user_id,body) VALUES($1,$2,$3) RETURNING "+appealColumns, action.ID, user, abuse.NormalizeBody(body)))
	if e != nil {
		return out, e
	}
	if e = notify(ctx, tx, user, "appeal", "Обжалование принято", "Обращение сохранено. Его должен рассмотреть другой сотрудник."); e != nil {
		return out, e
	}
	if e = auditModeration(ctx, tx, user, "appeal.created", out.ID, map[string]string{"actionId": action.ID}); e != nil {
		return out, e
	}
	return out, dbErr(tx.Commit(ctx))
}
func collectAppeals(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]domain.Appeal, error) {
	rows, e := tx.Query(ctx, query, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []domain.Appeal{}
	for rows.Next() {
		a, e := scanAppeal(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
func (s *Store) MyAppeals(ctx context.Context, user string) ([]domain.Appeal, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	out, e := collectAppeals(ctx, tx, "SELECT "+appealColumns+" FROM appeals p WHERE p.user_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 100", user)
	if e != nil {
		return nil, e
	}
	return out, tx.Commit(ctx)
}
func (s *Store) ModerationAppeals(ctx context.Context, user, status string) ([]domain.ModerationAppeal, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	role, e := requireStaff(ctx, tx, user)
	if e != nil {
		return nil, e
	}
	items, e := collectAppeals(ctx, tx, "SELECT "+appealColumns+" FROM appeals p JOIN moderation_actions a ON a.id=p.action_id JOIN reports r ON r.id=a.report_id JOIN users subject ON subject.id=a.subject_id WHERE p.status=$1 AND a.subject_id<>$2 AND a.actor_id<>$2 AND r.reporter_id<>$2 AND ($3='admin' OR (NOT subject.is_admin AND NOT subject.is_moderator)) ORDER BY p.created_at,p.id LIMIT 100", status, user, role)
	if e != nil {
		return nil, e
	}
	out := []domain.ModerationAppeal{}
	for _, item := range items {
		a, e := readAction(ctx, tx, item.ActionID, false)
		if e != nil {
			return nil, e
		}
		subject, subjectRole, e := identity(ctx, tx, a.SubjectID, true, false)
		if e != nil {
			return nil, e
		}
		reporter, e := actionReporter(ctx, tx, a.ReportID)
		if e != nil {
			return nil, e
		}
		if !domain.CanResolveAppeal(user, role, a.SubjectID, subjectRole, a.ActorID, reporter) {
			continue
		}
		out = append(out, domain.ModerationAppeal{Appeal: item, Action: a.ModerationAction, Subject: subject, CanResolve: item.Status == "open"})
	}
	caseIDs := []string{}
	for _, item := range out {
		caseIDs = append(caseIDs, item.ID)
	}
	if e = auditModeration(ctx, tx, user, "moderation.appeal_queue_read", "", map[string]any{"status": status, "caseIds": caseIDs}); e != nil {
		return nil, e
	}
	return out, tx.Commit(ctx)
}
func (s *Store) ResolveAppeal(ctx context.Context, user, id string, in domain.ResolveAppeal) (domain.Appeal, error) {
	out := domain.Appeal{}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	role, e := requireStaff(ctx, tx, user)
	if e != nil {
		return out, e
	}
	out, e = scanAppeal(tx.QueryRow(ctx, "SELECT "+appealColumns+" FROM appeals p WHERE p.id::text=$1 FOR UPDATE", id))
	if e != nil {
		return out, e
	}
	if out.Status != "open" {
		return out, domain.ErrConflict
	}
	action, e := readAction(ctx, tx, out.ActionID, true)
	if e != nil {
		return out, e
	}
	if e = lockPosting(ctx, tx, action.SubjectID); e != nil {
		return out, e
	}
	_, subjectRole, e := identity(ctx, tx, action.SubjectID, true, false)
	if e != nil {
		return out, e
	}
	reporter, e := actionReporter(ctx, tx, action.ReportID)
	if e != nil {
		return out, e
	}
	if !domain.CanResolveAppeal(user, role, action.SubjectID, subjectRole, action.ActorID, reporter) {
		return out, domain.ErrForbidden
	}
	in.Reason = abuse.NormalizeBody(in.Reason)
	if in.Decision == "overturned" {
		if _, e = tx.Exec(ctx, "UPDATE moderation_actions SET revoked_at=now() WHERE id=$1", action.ID); e != nil {
			return out, e
		}
		if action.Action == "hide" || action.Action == "hide_and_mute" {
			var stillHidden bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM moderation_actions WHERE target_type=$1 AND target_id::text=$2 AND action IN ('hide','hide_and_mute') AND revoked_at IS NULL)", action.TargetType, action.TargetID).Scan(&stillHidden); e != nil {
				return out, e
			}
			if !stillHidden {
				if e = setVisibility(ctx, tx, action.TargetType, action.TargetID, "visible"); e != nil {
					return out, e
				}
			}
		}
	}
	e = tx.QueryRow(ctx, "UPDATE appeals SET status=$2,decided_at=now(),decided_by=$3,decision_reason=$4 WHERE id=$1 RETURNING decided_at", out.ID, in.Decision, user, in.Reason).Scan(&out.DecidedAt)
	if e != nil {
		return out, e
	}
	out.Status = in.Decision
	out.DecisionReason = &in.Reason
	if e = notify(ctx, tx, action.SubjectID, "appeal", "Обжалование рассмотрено", in.Reason); e != nil {
		return out, e
	}
	if e = auditModeration(ctx, tx, user, "appeal.resolved", out.ID, map[string]string{"decision": in.Decision, "actionId": action.ID}); e != nil {
		return out, e
	}
	return out, dbErr(tx.Commit(ctx))
}

// Input classification never grants authority. Unknown values are rejected before
// a transaction and are also constrained by PostgreSQL.
func ValidReportReason(reason string) bool {
	switch reason {
	case "spam", "harassment", "dangerous_information", "personal_data", "other":
		return true
	}
	return false
}
func ValidTarget(kind string) bool { _, ok := targetTable(kind); return ok }
func IsReportStatus(s string) bool { return s == "open" || s == "resolved" || s == "dismissed" }
func IsAppealStatus(s string) bool { return s == "open" || s == "upheld" || s == "overturned" }
