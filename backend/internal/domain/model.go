package domain

import (
	"errors"
	"time"
)

var (
	ErrNotFound          = errors.New("not_found")
	ErrForbidden         = errors.New("forbidden")
	ErrUnauthorized      = errors.New("unauthorized")
	ErrConflict          = errors.New("conflict")
	ErrFull              = errors.New("departure_full")
	ErrNotReady          = errors.New("departure_not_ready")
	ErrClosed            = errors.New("route_closed")
	ErrInvalid           = errors.New("invalid_request")
	ErrDuplicate         = errors.New("already_exists")
	ErrMuted             = errors.New("temporarily_muted")
	ErrSpamCooldown      = errors.New("posting_cooldown")
	ErrRepeated          = errors.New("repeated_content")
	ErrLinkLimit         = errors.New("link_limit")
	ErrSafetyUnavailable = errors.New("safety_not_configured")
)

type User struct {
	ID            string    `json:"id"`
	DisplayName   string    `json:"displayName"`
	Email         string    `json:"email"`
	Role          string    `json:"role"`
	StaffRole     string    `json:"staffRole"`
	GuideStatus   string    `json:"guideStatus"`
	EmailVerified bool      `json:"emailVerified"`
	CreatedAt     time.Time `json:"createdAt"`
}

type Region struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Center      [2]float64 `json:"center"`
	Bounds      [4]float64 `json:"bounds"`
	RouteCount  int        `json:"routeCount"`
}

type Source struct {
	Name        string    `json:"name"`
	URL         string    `json:"url"`
	License     string    `json:"license"`
	RetrievedAt time.Time `json:"retrievedAt"`
}

type Geometry struct {
	Type        string      `json:"type"`
	Coordinates [][]float64 `json:"coordinates"`
}

type Route struct {
	ID                      string              `json:"id"`
	Slug                    string              `json:"slug"`
	RegionID                string              `json:"regionId"`
	Title                   string              `json:"title"`
	Description             string              `json:"description"`
	Difficulty              string              `json:"difficulty"`
	Activity                string              `json:"activity"`
	DistanceKM              float64             `json:"distanceKm"`
	AscentM                 int                 `json:"ascentM"`
	DurationMin             int                 `json:"durationMin"`
	MinPeople               int                 `json:"minPeople"`
	MaxGroupSize            int                 `json:"maxGroupSize"`
	RequiredGuides          int                 `json:"requiredGuides"`
	Status                  string              `json:"status"`
	RevisionID              string              `json:"revisionId"`
	Revision                int                 `json:"revision"`
	VerifiedAt              *time.Time          `json:"verifiedAt"`
	Source                  Source              `json:"source"`
	Geometry                Geometry            `json:"geometry"`
	GeometryDetail          string              `json:"geometryDetail"`
	Season                  string              `json:"season"`
	UpdatedAt               time.Time           `json:"updatedAt"`
	RiskClass               string              `json:"riskClass"`
	RouteType               string              `json:"routeType"`
	LegalDifficultyCategory string              `json:"legalDifficultyCategory"`
	MCHSNotificationPolicy  string              `json:"mchsNotificationPolicy"`
	MCHSTerritorialUnitID   string              `json:"mchsTerritorialUnitId,omitempty"`
	EmergencyExits          []SafetyPoint       `json:"emergencyExits"`
	ControlPoints           []SafetyPoint       `json:"controlPoints"`
	DefaultCheckInSchedule  []SafetyCheckInRule `json:"defaultCheckInSchedule"`
	SafetyRevision          int                 `json:"safetyRevision"`
}

type Departure struct {
	ID                     string    `json:"id"`
	RouteID                string    `json:"routeId"`
	RouteRevisionID        string    `json:"routeRevisionId"`
	RouteTitle             string    `json:"routeTitle"`
	GuideID                *string   `json:"guideId"`
	GuideName              *string   `json:"guideName"`
	StartsAt               time.Time `json:"startsAt"`
	EndsAt                 time.Time `json:"endsAt"`
	TimeZone               string    `json:"timeZone"`
	MinPeople              int       `json:"minPeople"`
	Capacity               int       `json:"capacity"`
	ParticipantCount       int       `json:"participantCount"`
	Status                 string    `json:"status"`
	Version                int64     `json:"version"`
	RouteOpen              bool      `json:"routeOpen"`
	GuideEligible          bool      `json:"guideEligible"`
	Membership             string    `json:"membership"`
	CreatedAt              time.Time `json:"createdAt"`
	ReviewTargets          *[]string `json:"reviewTargets,omitempty"`
	SafetyStatus           string    `json:"safetyStatus"`
	SafetyPassportVersion  int       `json:"safetyPassportVersion"`
	MCHSNotificationPolicy string    `json:"mchsNotificationPolicy"`
	MCHSSubmissionID       *string   `json:"mchsSubmissionId,omitempty"`
	MCHSConfirmed          bool      `json:"mchsConfirmed"`
	StartContactConfirmed  bool      `json:"startContactConfirmed"`
	ReturnReported         bool      `json:"returnReported"`
	SafetyClosed           bool      `json:"safetyClosed"`
	SafetyDeadline         time.Time `json:"safetyDeadline"`
}

type Member struct{ UserID, Role, Status string }
type Group struct {
	Departure
	OwnerID string
	Members map[string]Member
}

func (g *Group) ActiveCount() int {
	n := 0
	for _, m := range g.Members {
		if m.Status == "confirmed" || m.Status == "checked_in" || m.Status == "completed" {
			n++
		}
	}
	return n
}

func (g *Group) Refresh() {
	g.ParticipantCount = g.ActiveCount()
	if g.Status != "recruiting" && g.Status != "ready" && g.Status != "awaiting_guide" {
		return
	}
	if g.GuideID == nil || !g.GuideEligible {
		g.Status = "awaiting_guide"
		return
	}
	if g.RouteOpen && g.ParticipantCount >= g.MinPeople {
		g.Status = "ready"
	} else {
		g.Status = "recruiting"
	}
}

func (g *Group) Join(userID string, expected int64, now time.Time) error {
	if expected > 0 && expected != g.Version {
		return ErrConflict
	}
	if m, ok := g.Members[userID]; ok && (m.Status == "confirmed" || m.Status == "checked_in") {
		return nil
	}
	if (g.Status != "recruiting" && g.Status != "ready") || !now.Before(g.StartsAt) {
		return ErrNotReady
	}
	if !g.RouteOpen {
		return ErrClosed
	}
	if g.GuideID == nil || !g.GuideEligible {
		return ErrNotReady
	}
	if g.ActiveCount() >= g.Capacity {
		return ErrFull
	}
	g.Members[userID] = Member{UserID: userID, Role: "tourist", Status: "confirmed"}
	g.Version++
	g.Refresh()
	return nil
}

func (g *Group) Leave(userID string, now time.Time) error {
	if g.Status == "in_progress" || g.Status == "completed" || g.Status == "aborted" {
		return ErrConflict
	}
	m, ok := g.Members[userID]
	if !ok {
		return ErrForbidden
	}
	if m.Status == "cancelled" {
		return nil
	}
	m.Status = "cancelled"
	g.Members[userID] = m
	if g.GuideID != nil && *g.GuideID == userID {
		g.GuideID = nil
		g.GuideName = nil
		g.GuideEligible = false
	}
	g.Version++
	g.Refresh()
	return nil
}

func (g *Group) IsGuide(userID string) bool {
	return g.GuideID != nil && *g.GuideID == userID && g.GuideEligible
}
func (g *Group) CanReadChat(userID string) bool {
	m, ok := g.Members[userID]
	return ok && (m.Status == "confirmed" || m.Status == "checked_in" || m.Status == "completed")
}

func (g *Group) CheckIn(actor, userID string, expected int64, now time.Time) error {
	if !g.IsGuide(actor) {
		return ErrForbidden
	}
	if expected != g.Version {
		return ErrConflict
	}
	if g.Status != "ready" && g.Status != "recruiting" {
		return ErrNotReady
	}
	if !g.RouteOpen || now.Before(g.StartsAt.Add(-24*time.Hour)) || !now.Before(g.EndsAt) {
		return ErrNotReady
	}
	m, ok := g.Members[userID]
	if !ok || (m.Status != "confirmed" && m.Status != "checked_in") {
		return ErrInvalid
	}
	if m.Status == "checked_in" {
		return nil
	}
	m.Status = "checked_in"
	g.Members[userID] = m
	g.Version++
	return nil
}

func (g *Group) Transition(actor, action string, expected int64, now time.Time) error {
	if expected != g.Version {
		return ErrConflict
	}
	// A withdrawn creator may cancel the stranded group, but cannot start it.
	assigned := g.GuideID != nil && *g.GuideID == actor
	if !assigned && !(action == "cancel" && actor == g.OwnerID) {
		return ErrForbidden
	}
	switch action {
	case "start":
		if !g.GuideEligible || g.Status != "ready" || !g.RouteOpen || now.Before(g.StartsAt) || !now.Before(g.EndsAt) {
			return ErrNotReady
		}
		count := 0
		for _, m := range g.Members {
			if m.Status == "checked_in" {
				count++
			}
		}
		gm, ok := g.Members[actor]
		if !ok || gm.Status != "checked_in" || count < g.MinPeople || count > g.Capacity {
			return ErrNotReady
		}
		for id, m := range g.Members {
			if m.Status == "confirmed" {
				m.Status = "no_show"
				g.Members[id] = m
			}
		}
		g.Status = "in_progress"
	case "complete":
		if g.Status != "in_progress" {
			return ErrConflict
		}
		g.Status = "completed"
		for id, m := range g.Members {
			if m.Status == "checked_in" {
				m.Status = "completed"
				g.Members[id] = m
			}
		}
	case "abort":
		if g.Status != "in_progress" {
			return ErrConflict
		}
		g.Status = "aborted"
	case "cancel":
		if g.Status != "ready" && g.Status != "recruiting" && g.Status != "awaiting_guide" {
			return ErrConflict
		}
		g.Status = "cancelled"
	default:
		return ErrInvalid
	}
	g.Version++
	g.Refresh()
	return nil
}

func (g *Group) CanReview(userID, target string) bool {
	m, ok := g.Members[userID]
	return ok && g.Status == "completed" && m.Status == "completed" && m.Role != "guide" && (target == "guide" || target == "route")
}

type Message struct {
	ID          string    `json:"id"`
	DepartureID string    `json:"departureId"`
	UserID      string    `json:"userId"`
	DisplayName string    `json:"displayName"`
	Body        string    `json:"body"`
	Visibility  string    `json:"visibility"`
	ClientID    string    `json:"clientId"`
	CreatedAt   time.Time `json:"createdAt"`
}
type Review struct {
	ID                     string    `json:"id"`
	DepartureID            string    `json:"departureId"`
	UserID                 string    `json:"userId"`
	Target                 string    `json:"target"`
	Rating                 int       `json:"rating"`
	Body                   string    `json:"body"`
	CreatedAt              time.Time `json:"createdAt"`
	ParticipationConfirmed bool      `json:"participationConfirmed"`
}
type Observation struct {
	ClientID    string    `json:"clientId"`
	DepartureID string    `json:"departureId"`
	BaseVersion int64     `json:"baseVersion"`
	ObservedAt  time.Time `json:"observedAt"`
	Kind        string    `json:"kind"`
	Body        string    `json:"body"`
}
type SyncAck struct {
	ClientID         string `json:"clientId"`
	Status           string `json:"status"`
	CurrentVersion   int64  `json:"currentVersion,omitempty"`
	Reason           string `json:"reason,omitempty"`
	ServerAuthorized bool   `json:"serverAuthorized"`
}
