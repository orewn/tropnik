package httpapi

import (
	"net/http"
	"tropa/backend/internal/domain"
)

func safetyMutationKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	key := r.Header.Get("Idempotency-Key")
	if !clientKey(key) {
		failure(w, 400, "idempotency_key_required", "Нужен уникальный ключ действия.")
		return "", false
	}
	return key, true
}

func (s *Server) safetyPassport(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, err := s.DB.SafetyPassport(r.Context(), u.ID, r.PathValue("id"))
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, 200, x)
}
func (s *Server) prepareSafetyPassport(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	key, ok := safetyMutationKey(w, r)
	if !ok {
		return
	}
	var in domain.SafetyPrepareInput
	if !decode(w, r, &in) {
		return
	}
	x, err := s.DB.PrepareSafetyPassport(r.Context(), u.ID, r.PathValue("id"), key, in)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, 201, x)
}
func (s *Server) recordMCHSSubmission(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	key, ok := safetyMutationKey(w, r)
	if !ok {
		return
	}
	var in domain.MCHSSubmissionInput
	if !decode(w, r, &in) {
		return
	}
	x, err := s.DB.RecordMCHSSubmission(r.Context(), u.ID, r.PathValue("id"), key, in)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, 200, x)
}
func (s *Server) confirmMCHSRegistration(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staff(w, r)
	if !ok {
		return
	}
	key, ok := safetyMutationKey(w, r)
	if !ok {
		return
	}
	var in domain.MCHSConfirmationInput
	if !decode(w, r, &in) {
		return
	}
	x, err := s.DB.ConfirmMCHSRegistration(r.Context(), u.ID, r.PathValue("id"), key, in)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, 200, x)
}
func (s *Server) confirmMCHSStartContact(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	key, ok := safetyMutationKey(w, r)
	if !ok {
		return
	}
	var in domain.MCHSStartContactInput
	if !decode(w, r, &in) {
		return
	}
	x, err := s.DB.ConfirmMCHSStartContact(r.Context(), u.ID, r.PathValue("id"), key, in)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, 200, x)
}
func (s *Server) reportMCHSReturn(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	key, ok := safetyMutationKey(w, r)
	if !ok {
		return
	}
	var in domain.MCHSReturnReportInput
	if !decode(w, r, &in) {
		return
	}
	x, err := s.DB.ReportMCHSReturn(r.Context(), u.ID, r.PathValue("id"), key, in)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, 200, x)
}
func (s *Server) safetyCheckIn(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	key, ok := safetyMutationKey(w, r)
	if !ok {
		return
	}
	var in domain.SafetyCheckInInput
	if !decode(w, r, &in) {
		return
	}
	x, err := s.DB.RecordSafetyCheckIn(r.Context(), u.ID, r.PathValue("id"), key, in)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, 201, x)
}
func (s *Server) emergencyCard(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, err := s.DB.EmergencyCard(r.Context(), u.ID, r.PathValue("id"))
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, 200, x)
}
