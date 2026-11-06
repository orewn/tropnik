package httpapi

import "net/http"

func (s *Server) guides(w http.ResponseWriter, r *http.Request) {
	x, e := s.DB.Guides(r.Context(), r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	if r.PathValue("id") != "" {
		respond(w, 200, x[0])
		return
	}
	respond(w, 200, x)
}

func (s *Server) guideReviews(w http.ResponseWriter, r *http.Request) {
	x, e := s.DB.GuideReviews(r.Context(), r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, x)
}
