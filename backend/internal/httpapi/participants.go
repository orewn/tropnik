package httpapi

import "net/http"

func (s *Server) participants(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	x, e := s.DB.Participants(r.Context(), u.ID, r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
