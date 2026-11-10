package domain

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

// Imported safety metadata is still a draft. Publication separately requires an
// operator to choose the notification policy and record the review evidence.
func NormalizeRouteSafety(route *Route) error {
	if route.RiskClass == "" {
		route.RiskClass = "standard"
	}
	if route.RouteType == "" {
		route.RouteType = "pedestrian"
	}
	if route.LegalDifficultyCategory == "" {
		route.LegalDifficultyCategory = "uncategorized"
	}
	if route.MCHSNotificationPolicy == "" {
		route.MCHSNotificationPolicy = "recommended"
	}
	if route.SafetyRevision == 0 {
		route.SafetyRevision = 1
	}
	if route.RiskClass != "standard" && route.RiskClass != "elevated" && route.RiskClass != "high" && route.RiskClass != "extreme" {
		return fmt.Errorf("invalid route risk class")
	}
	if route.RouteType != "pedestrian" && route.RouteType != "mountain" && route.RouteType != "water" && route.RouteType != "ski" && route.RouteType != "speleo" && route.RouteType != "combined" {
		return fmt.Errorf("invalid route type")
	}
	if !ValidNotificationPolicy(route.MCHSNotificationPolicy) || route.SafetyRevision < 1 {
		return fmt.Errorf("reviewed notification policy and positive safety revision required")
	}
	if strings.TrimSpace(route.LegalDifficultyCategory) == "" || utf8.RuneCountInString(route.LegalDifficultyCategory) > 40 || utf8.RuneCountInString(route.MCHSTerritorialUnitID) > 120 {
		return fmt.Errorf("invalid route safety metadata")
	}
	for _, points := range [][]SafetyPoint{route.EmergencyExits, route.ControlPoints} {
		if len(points) > 50 {
			return fmt.Errorf("route may contain at most 50 safety points of each kind")
		}
		for _, point := range points {
			if strings.TrimSpace(point.Name) == "" || utf8.RuneCountInString(point.Name) > 240 || utf8.RuneCountInString(point.Description) > 2000 || (point.Latitude == nil) != (point.Longitude == nil) {
				return fmt.Errorf("invalid safety point")
			}
			if point.Latitude != nil && (math.IsNaN(*point.Latitude) || math.IsNaN(*point.Longitude) || math.IsInf(*point.Latitude, 0) || math.IsInf(*point.Longitude, 0) || *point.Latitude < -90 || *point.Latitude > 90 || *point.Longitude < -180 || *point.Longitude > 180) {
				return fmt.Errorf("invalid safety point coordinates")
			}
		}
	}
	if len(route.DefaultCheckInSchedule) > 50 {
		return fmt.Errorf("too many check-in rules")
	}
	for _, rule := range route.DefaultCheckInSchedule {
		if strings.TrimSpace(rule.Name) == "" || utf8.RuneCountInString(rule.Name) > 240 || rule.OffsetHour < 0 || rule.OffsetHour > 720 {
			return fmt.Errorf("invalid check-in rule")
		}
		if rule.At != "" {
			if _, err := time.Parse(time.RFC3339, rule.At); err != nil {
				return fmt.Errorf("check-in rule time must be RFC3339")
			}
		}
	}
	if route.EmergencyExits == nil {
		route.EmergencyExits = []SafetyPoint{}
	}
	if route.ControlPoints == nil {
		route.ControlPoints = []SafetyPoint{}
	}
	if route.DefaultCheckInSchedule == nil {
		route.DefaultCheckInSchedule = []SafetyCheckInRule{}
	}
	return nil
}

func ValidNotificationPolicy(policy string) bool {
	return policy == "required" || policy == "recommended" || policy == "not_required"
}
