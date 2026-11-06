package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"

	"tropa/backend/internal/domain"
)

func (s *Server) departureHistory(w http.ResponseWriter, r *http.Request) {
	u, ok := s.user(w, r)
	if !ok {
		return
	}
	limit := 20
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 50 {
			fail(w, domain.ErrInvalid)
			return
		}
		limit = value
	}
	items, next, err := s.DB.DepartureHistory(r.Context(), u.ID, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		fail(w, err)
		return
	}
	meta := map[string]string{"mode": "production"}
	if next != "" {
		meta["nextCursor"] = next
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": items, "meta": meta})
}
