package domain

import "time"

// CompletedDeparture is private account history, not a public participant list.
// The route revision remains the one used by the completed departure even when
// the current route is later updated or withdrawn from publication.
type CompletedDeparture struct {
	ID              string    `json:"id"`
	RouteID         string    `json:"routeId"`
	RouteRevisionID string    `json:"routeRevisionId"`
	RouteTitle      string    `json:"routeTitle"`
	StartsAt        time.Time `json:"startsAt"`
	EndsAt          time.Time `json:"endsAt"`
	CompletedAt     time.Time `json:"completedAt"`
	TimeZone        string    `json:"timeZone"`
	Role            string    `json:"role"`
	GuideID         *string   `json:"guideId"`
	GuideName       *string   `json:"guideName"`
	ReviewTargets   []string  `json:"reviewTargets"`
}
