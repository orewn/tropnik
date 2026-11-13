package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"tropa/backend/internal/domain"
)

func TestRoutePageBudgetPaginatesWithoutLosingTheFirstOmittedRoute(t *testing.T) {
	routes := make([]domain.Route, 30)
	for i := range routes {
		routes[i] = domain.Route{ID: fmt.Sprintf("00000000-0000-0000-0000-%012d", i+1), Description: strings.Repeat("<", 20000), GeometryDetail: "overview"}
	}
	seen := []string{}
	remaining := routes
	for len(remaining) > 0 {
		body, err := routePageJSON(remaining, 100)
		if err != nil || len(body) > domain.RoutePageResponseBytes || cap(body) > domain.RoutePageResponseBytes {
			t.Fatalf("page exceeded its wire budget: %d %v", len(body), err)
		}
		var envelope struct {
			Data []domain.Route `json:"data"`
			Meta routePageMeta  `json:"meta"`
		}
		if err = json.Unmarshal(body, &envelope); err != nil || len(envelope.Data) == 0 {
			t.Fatal("budget returned invalid/empty progress", err)
		}
		for _, route := range envelope.Data {
			seen = append(seen, route.ID)
		}
		count := len(envelope.Data)
		if count < len(remaining) && envelope.Meta.NextCursor != remaining[count-1].ID {
			t.Fatal("cursor skipped an omitted item or stopped pagination")
		}
		if count == len(remaining) && envelope.Meta.NextCursor != "" {
			t.Fatal("short final page must terminate pagination")
		}
		remaining = remaining[count:]
	}
	if len(seen) != len(routes) {
		t.Fatal("routes were lost")
	}
	for i := range routes {
		if seen[i] != routes[i].ID {
			t.Fatal("route order changed")
		}
	}
}

func TestSmallRoutePagesDoNotReserveTheFullResponseBudget(t *testing.T) {
	for _, routes := range [][]domain.Route{nil, {{ID: "small-route", Title: "Short route"}}} {
		body, err := routePageJSON(routes, 30)
		if err != nil || cap(body) >= 16<<10 || !json.Valid(body) {
			t.Fatal("small response retained an excessive backing buffer", len(body), cap(body), err)
		}
	}
}

func TestOversizedLegacyOverviewFailsWithoutDroppingIt(t *testing.T) {
	if _, err := routePageJSON([]domain.Route{{ID: "oversized", Description: strings.Repeat("x", domain.RoutePageResponseBytes)}}, 30); !errors.Is(err, errRouteResponseBudget) {
		t.Fatal("an oversized first route was silently skipped", err)
	}
}

func TestFullRouteHasIndependentBoundedBudgetAndKeepsEveryVertex(t *testing.T) {
	route := domain.Route{ID: "large-reviewed-route", GeometryDetail: "full", Geometry: domain.Geometry{Type: "LineString"}}
	for i := 0; i < domain.RouteMaximumVertices; i++ {
		route.Geometry.Coordinates = append(route.Geometry.Coordinates, []float64{33.123456789 + float64(i)/1e7, 63.123456789 + float64(i)/1e7})
	}
	body, err := routeDetailJSON(route)
	if err != nil || len(body) <= domain.RoutePageResponseBytes || len(body) > domain.RouteDetailResponseBytes {
		t.Fatalf("large route not within its explicit detail budget: %d %v", len(body), err)
	}
	var envelope struct{ Data domain.Route }
	if err := json.Unmarshal(body, &envelope); err != nil || len(envelope.Data.Geometry.Coordinates) != domain.RouteMaximumVertices {
		t.Fatal("full geometry was reduced", err)
	}
	last := domain.RouteMaximumVertices - 1
	if envelope.Data.Geometry.Coordinates[last][0] != route.Geometry.Coordinates[last][0] {
		t.Fatal("last source vertex changed")
	}
	route.Description = strings.Repeat("x", domain.RouteDetailResponseBytes)
	if _, err = routeDetailJSON(route); !errors.Is(err, errRouteResponseBudget) {
		t.Fatal("detail budget was removed", err)
	}
}
