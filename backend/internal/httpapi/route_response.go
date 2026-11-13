package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"tropa/backend/internal/domain"
)

var errRouteResponseBudget = errors.New("route response exceeds its transport budget")

type routePageMeta struct {
	Mode       string `json:"mode"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// routePageJSON preserves every route's position in pagination. If the next
// complete overview does not fit, the cursor stays on the last included item,
// so the next request begins with that omitted route rather than skipping it.
func routePageJSON(routes []domain.Route, requested int) ([]byte, error) {
	const prefix = `{"data":[`
	// Small and empty catalogues should not reserve the entire 1 MiB wire
	// budget. Grow from a row-count estimate, keeping capacity bounded too.
	capacity := min(domain.RoutePageResponseBytes, 256+min(len(routes), 64)*1024)
	data := make([]byte, 0, capacity)
	data = append(data, prefix...)
	meta := routePageMeta{Mode: "production"}
	metaJSON, _ := json.Marshal(meta)
	for index, route := range routes {
		raw, err := json.Marshal(route)
		if err != nil {
			return nil, err
		}
		candidateMeta := routePageMeta{Mode: "production"}
		if index+1 < len(routes) || len(routes) == requested {
			candidateMeta.NextCursor = route.ID
		}
		candidateJSON, _ := json.Marshal(candidateMeta)
		separator := 0
		if index > 0 {
			separator = 1
		}
		needed := len(data) + separator + len(raw) + len(`],"meta":`) + len(candidateJSON) + len("}\n")
		if needed > domain.RoutePageResponseBytes {
			if index == 0 {
				// An oversized legacy/operator row must be corrected; dropping it
				// would make the catalogue incomplete or trap clients in a loop.
				return nil, errRouteResponseBudget
			}
			break
		}
		if needed > cap(data) {
			next := make([]byte, len(data), min(domain.RoutePageResponseBytes, max(needed, 2*cap(data))))
			copy(next, data)
			data = next
		}
		if separator != 0 {
			data = append(data, ',')
		}
		data = append(data, raw...)
		metaJSON = candidateJSON
	}
	data = append(data, `],"meta":`...)
	data = append(data, metaJSON...)
	data = append(data, '}', '\n')
	return data, nil
}

func routeDetailJSON(route domain.Route) ([]byte, error) {
	data, err := json.Marshal(struct {
		Data domain.Route  `json:"data"`
		Meta routePageMeta `json:"meta"`
	}{route, routePageMeta{Mode: "production"}})
	if err != nil {
		return nil, err
	}
	if len(data)+1 > domain.RouteDetailResponseBytes {
		return nil, errRouteResponseBudget
	}
	return append(data, '\n'), nil
}

func routeResponse(w http.ResponseWriter, data []byte, err error) {
	if err != nil {
		failure(w, http.StatusServiceUnavailable, "route_response_unavailable", "Данные маршрута требуют исправления. Попробуйте позже.")
		return
	}
	_, _ = w.Write(data)
}
