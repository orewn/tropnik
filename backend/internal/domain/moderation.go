package domain

import "time"

type Badge struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	Description  string    `json:"description"`
	EarnedAt     time.Time `json:"earnedAt"`
	EvidenceID   string    `json:"evidenceId"`
	EvidenceType string    `json:"evidenceType"`
}
type AccountStats struct {
	CompletedTrips int `json:"completedTrips"`
	ReviewsWritten int `json:"reviewsWritten"`
}
type AccountModeration struct {
	MutedUntil *time.Time `json:"mutedUntil"`
}
type AccountSummary struct {
	User       User              `json:"user"`
	Stats      AccountStats      `json:"stats"`
	Badges     []Badge           `json:"badges"`
	Moderation AccountModeration `json:"moderation"`
}
type Notification struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	CreatedAt time.Time  `json:"createdAt"`
	ReadAt    *time.Time `json:"readAt"`
}
type ReportInput struct {
	TargetType string `json:"targetType"`
	TargetID   string `json:"targetId"`
	Reason     string `json:"reason"`
	Body       string `json:"body"`
}
type Report struct {
	ReportInput
	ID             string     `json:"id"`
	Status         string     `json:"status"`
	CreatedAt      time.Time  `json:"createdAt"`
	ResolvedAt     *time.Time `json:"resolvedAt"`
	DecisionReason *string    `json:"decisionReason"`
}
type PublicIdentity struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}
type ModerationReport struct {
	Report
	Reporter         PublicIdentity `json:"reporter"`
	Subject          PublicIdentity `json:"subject"`
	TargetBody       string         `json:"targetBody"`
	TargetVisibility string         `json:"targetVisibility"`
}
type ModerationAction struct {
	ID           string     `json:"id"`
	ReportID     string     `json:"reportId"`
	TargetType   string     `json:"targetType"`
	TargetID     string     `json:"targetId"`
	Action       string     `json:"action"`
	Reason       string     `json:"reason"`
	CreatedAt    time.Time  `json:"createdAt"`
	ExpiresAt    *time.Time `json:"expiresAt"`
	RevokedAt    *time.Time `json:"revokedAt"`
	AppealStatus *string    `json:"appealStatus"`
}
type Appeal struct {
	ID             string     `json:"id"`
	ActionID       string     `json:"actionId"`
	Body           string     `json:"body"`
	Status         string     `json:"status"`
	CreatedAt      time.Time  `json:"createdAt"`
	DecidedAt      *time.Time `json:"decidedAt"`
	DecisionReason *string    `json:"decisionReason"`
}
type ModerationAppeal struct {
	Appeal
	Action     ModerationAction `json:"action"`
	Subject    PublicIdentity   `json:"subject"`
	CanResolve bool             `json:"canResolve"`
}
type ResolveReport struct {
	Action    string `json:"action"`
	Reason    string `json:"reason"`
	MuteHours int    `json:"muteHours"`
}
type ResolveAppeal struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

func IsStaff(role string) bool { return role == "moderator" || role == "admin" }
func CanModerate(actor, actorRole, subject, subjectRole, reporter string) bool {
	return IsStaff(actorRole) && actor != subject && actor != reporter && (subjectRole == "none" || actorRole == "admin")
}
func CanResolveAppeal(actor, actorRole, subject, subjectRole, originalActor, reporter string) bool {
	return actor != originalActor && CanModerate(actor, actorRole, subject, subjectRole, reporter)
}
