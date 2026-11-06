package httpapi

import (
	"net/http"
	"tropa/backend/internal/abuse"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
)

func (s *Server) staff(w http.ResponseWriter, r *http.Request) (domain.User, bool) {
	u, ok := s.user(w, r)
	if !ok {
		return u, false
	}
	if !domain.IsStaff(u.StaffRole) {
		fail(w, domain.ErrForbidden)
		return u, false
	}
	return u, true
}
func (s *Server) accountSummary(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, e := s.DB.AccountSummary(r.Context(), u.ID)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) notifications(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, e := s.DB.Notifications(r.Context(), u.ID)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) readNotification(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	if e := s.DB.ReadNotification(r.Context(), u.ID, r.PathValue("id")); e != nil {
		fail(w, e)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) myReports(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, e := s.DB.MyReports(r.Context(), u.ID)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) createReport(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in domain.ReportInput
	if !decode(w, r, &in) {
		return
	}
	in.Body = abuse.NormalizeBody(in.Body)
	if !store.ValidTarget(in.TargetType) || in.TargetID == "" || !store.ValidReportReason(in.Reason) || !textValid(in.Body, 10, 2000) {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.CreateReport(r.Context(), u.ID, in)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 201, x)
}
func (s *Server) moderationReports(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staff(w, r)
	if !ok {
		return
	}
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "open"
	}
	if !store.IsReportStatus(status) {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.ModerationReports(r.Context(), u.ID, status)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) resolveReport(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staff(w, r)
	if !ok {
		return
	}
	var in domain.ResolveReport
	if !decode(w, r, &in) {
		return
	}
	in.Reason = abuse.NormalizeBody(in.Reason)
	muting := in.Action == "mute" || in.Action == "hide_and_mute"
	if !textValid(in.Reason, 10, 2000) || (!muting && in.Action != "hide" && in.Action != "dismiss") || (muting && (in.MuteHours < 1 || in.MuteHours > 168)) || (!muting && in.MuteHours != 0) {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.ResolveReport(r.Context(), u.ID, r.PathValue("id"), in)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) myModerationActions(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, e := s.DB.MyModerationActions(r.Context(), u.ID)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) myAppeals(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, e := s.DB.MyAppeals(r.Context(), u.ID)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) createAppeal(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in struct {
		Body string `json:"body"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Body = abuse.NormalizeBody(in.Body)
	if !textValid(in.Body, 10, 2000) {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.CreateAppeal(r.Context(), u.ID, r.PathValue("id"), in.Body)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 201, x)
}
func (s *Server) moderationAppeals(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staff(w, r)
	if !ok {
		return
	}
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "open"
	}
	if !store.IsAppealStatus(status) {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.ModerationAppeals(r.Context(), u.ID, status)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) resolveAppeal(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staff(w, r)
	if !ok {
		return
	}
	var in domain.ResolveAppeal
	if !decode(w, r, &in) {
		return
	}
	in.Reason = abuse.NormalizeBody(in.Reason)
	if !textValid(in.Reason, 10, 2000) || (in.Decision != "upheld" && in.Decision != "overturned") {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.ResolveAppeal(r.Context(), u.ID, r.PathValue("id"), in)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
