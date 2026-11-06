package domain

import (
	"math"
	"strings"
	"testing"
	"time"
)

func importFixture() Route {
	return Route{Slug: "test-route", RegionID: "karelia", Title: "Fixture", Description: "Integration fixture only", Activity: "hiking", Season: "test", DurationMin: 30, Difficulty: "easy",
		Source:   Source{Name: "Fixture", URL: "https://example.invalid/fixture", License: "fixture only", RetrievedAt: time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)},
		Geometry: Geometry{Type: "LineString", Coordinates: [][]float64{{33, 63}, {33.01, 63.01}}}}
}

func TestOperatorImportDoesNotAcceptUnboundedOrInvalidTransportInputs(t *testing.T) {
	valid := importFixture()
	if err := ValidateRouteImport(valid); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Route){
		func(r *Route) { r.Slug = "../another/route" },
		func(r *Route) { r.Difficulty = "unreviewed-category" },
		func(r *Route) { r.Description = strings.Repeat("x", 20001) },
		func(r *Route) { r.Title = strings.Repeat("я", 201) },
		func(r *Route) { r.Source.URL = "https://user:secret@example.invalid/route" },
		func(r *Route) { r.Geometry.Coordinates = [][]float64{{math.NaN(), 63}, {33, 63}} },
		func(r *Route) { r.Geometry.Coordinates = [][]float64{{33, math.Inf(1)}, {33, 63}} },
		func(r *Route) { r.Geometry.Coordinates = [][]float64{{181, 63}, {33, 63}} },
		func(r *Route) { r.Geometry.Coordinates = [][]float64{{33, 63, 10}, {33, 63}} },
		func(r *Route) { r.Geometry.Coordinates = make([][]float64, RouteMaximumVertices+1) },
	} {
		route := importFixture()
		mutate(&route)
		if err := ValidateRouteImport(route); err == nil {
			t.Fatal("invalid/oversized operator input was accepted")
		}
	}
}
