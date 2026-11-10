package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// These are decoded JSON response budgets. Native clients use the same limits;
// compression and a missing Content-Length never permit an unbounded read.
const (
	RoutePageResponseBytes   = 1 << 20
	RouteDetailResponseBytes = 8 << 20
	RouteMaximumVertices     = 100000
	RouteImportBytes         = 10 << 20
)

var routeSegment = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// ValidateRouteImport bounds operator inputs before storage, without reducing
// full geometry or silently truncating route descriptions. It does not approve
// a route for publication; editorial review remains a separate operator action.
func ValidateRouteImport(route Route) error {
	if err := NormalizeRouteSafety(&route); err != nil {
		return err
	}
	if !routeSegment.MatchString(route.Slug) || !routeSegment.MatchString(route.RegionID) {
		return fmt.Errorf("route slug and region must be 1..128 ASCII letters, digits, hyphens or underscores")
	}
	for _, field := range []struct {
		name  string
		value string
		max   int
	}{
		{"title", route.Title, 200}, {"description", route.Description, 20000},
		{"activity", route.Activity, 40}, {"season", route.Season, 200},
		{"source name", route.Source.Name, 200}, {"source URL", route.Source.URL, 2048},
		{"source license", route.Source.License, 200},
	} {
		if !utf8.ValidString(field.value) || strings.TrimSpace(field.value) == "" || utf8.RuneCountInString(field.value) > field.max {
			return fmt.Errorf("%s must contain 1..%d characters", field.name, field.max)
		}
	}
	if route.Source.RetrievedAt.IsZero() || route.AscentM < 0 || route.AscentM >= 100000 || route.DurationMin < 1 || route.DurationMin >= 100000 {
		return fmt.Errorf("a source date and bounded ascent/duration are required")
	}
	if route.Difficulty != "easy" && route.Difficulty != "moderate" && route.Difficulty != "hard" && route.Difficulty != "expert" {
		return fmt.Errorf("difficulty must be easy, moderate, hard or expert")
	}
	source, err := url.Parse(route.Source.URL)
	if err != nil || source.Scheme != "https" || source.Host == "" || source.User != nil {
		return fmt.Errorf("HTTPS source URL without credentials required")
	}
	if route.Geometry.Type != "LineString" || len(route.Geometry.Coordinates) < 2 || len(route.Geometry.Coordinates) > RouteMaximumVertices {
		return fmt.Errorf("LineString must contain 2..%d vertices", RouteMaximumVertices)
	}
	for _, point := range route.Geometry.Coordinates {
		if len(point) != 2 || math.IsNaN(point[0]) || math.IsNaN(point[1]) || math.IsInf(point[0], 0) || math.IsInf(point[1], 0) || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90 {
			return fmt.Errorf("geometry must contain finite WGS84 longitude/latitude pairs")
		}
	}
	// Include space for server-owned identifiers, timestamps and the envelope.
	raw, err := json.Marshal(route)
	if err != nil || len(raw) > RouteDetailResponseBytes-4096 {
		return fmt.Errorf("route exceeds the bounded full-geometry response budget")
	}
	return nil
}
