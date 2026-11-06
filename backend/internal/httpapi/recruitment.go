package httpapi

import (
	"net/http"
	"strings"
	"time"
	"tropa/backend/internal/domain"
	"tropa/backend/internal/store"
)

func (s *Server) recruitmentList(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.user(w, r); !ok {
		return
	}
	x, e := s.DB.RecruitmentRequests(r.Context(), r.URL.Query().Get("route"))
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) recruitmentCreate(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in struct {
		RouteID       string `json:"routeId"`
		PreferredDate string `json:"preferredDate"`
		Body          string `json:"body"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if !textValid(in.Body, 1, 2000) {
		fail(w, domain.ErrInvalid)
		return
	}
	if in.PreferredDate != "" {
		d, e := time.Parse("2006-01-02", in.PreferredDate)
		if e != nil || d.Before(time.Now().UTC().Truncate(24*time.Hour)) {
			fail(w, domain.ErrInvalid)
			return
		}
	}
	x, e := s.DB.CreateRecruitment(r.Context(), u.ID, in.RouteID, in.PreferredDate, in.Body)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 201, x)
}
func (s *Server) recruitmentLeave(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	if e := s.DB.LeaveRecruitment(r.Context(), u.ID, r.PathValue("id")); e != nil {
		fail(w, e)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) recruitmentJoin(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	if e := s.DB.JoinRecruitment(r.Context(), u.ID, r.PathValue("id")); e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, map[string]any{"interested": true, "confirmedParticipant": false})
}
func (s *Server) recruitmentAccept(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in store.CreateDeparture
	if !decode(w, r, &in) {
		return
	}
	x, e := s.DB.AcceptRecruitment(r.Context(), u.ID, r.PathValue("id"), in)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 201, x)
}
func (s *Server) recruitmentMessages(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, e := s.DB.RecruitmentMessages(r.Context(), u.ID, r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
func (s *Server) recruitmentMessage(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	var in struct {
		Body     string `json:"body"`
		ClientID string `json:"clientId"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if !textValid(in.Body, 1, 4000) || !clientKey(in.ClientID) {
		fail(w, domain.ErrInvalid)
		return
	}
	x, e := s.DB.SendRecruitmentMessage(r.Context(), u.ID, r.PathValue("id"), in.Body, in.ClientID)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 201, x)
}
