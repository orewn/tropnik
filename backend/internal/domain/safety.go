package domain

import "time"

const MCHSOfficialFormURL = "https://forms.mchs.gov.ru/registration_tourist_groups"

type SafetyPoint struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Latitude    *float64 `json:"latitude,omitempty"`
	Longitude   *float64 `json:"longitude,omitempty"`
}

type SafetyCheckInRule struct {
	Name       string `json:"name"`
	OffsetHour int    `json:"offsetHour,omitempty"`
	At         string `json:"at,omitempty"`
}

type SafetyParticipantContact struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName,omitempty"`
	Role        string `json:"role,omitempty"`
	Phone       string `json:"phone"`
}

type SafetyPrepareInput struct {
	ExpectedVersion       int                        `json:"expectedVersion"`
	LeaderPhone           string                     `json:"leaderPhone"`
	EmergencyContactName  string                     `json:"emergencyContactName"`
	EmergencyContactPhone string                     `json:"emergencyContactPhone"`
	CommunicationPlan     string                     `json:"communicationPlan"`
	Transport             string                     `json:"transport"`
	BackupRoute           string                     `json:"backupRoute"`
	Equipment             string                     `json:"equipment"`
	FirstAid              string                     `json:"firstAid"`
	Insurance             string                     `json:"insurance"`
	Notes                 string                     `json:"notes"`
	Participants          []SafetyParticipantContact `json:"participants"`
}

type SafetyRouteSnapshot struct {
	RouteID                 string              `json:"routeId"`
	RouteRevisionID         string              `json:"routeRevisionId"`
	Title                   string              `json:"title"`
	Description             string              `json:"description"`
	RiskClass               string              `json:"riskClass"`
	RouteType               string              `json:"routeType"`
	LegalDifficultyCategory string              `json:"legalDifficultyCategory"`
	TerritorialUnitID       string              `json:"territorialUnitId,omitempty"`
	EmergencyExits          []SafetyPoint       `json:"emergencyExits"`
	ControlPoints           []SafetyPoint       `json:"controlPoints"`
	DefaultCheckInSchedule  []SafetyCheckInRule `json:"defaultCheckInSchedule"`
	SafetyRevision          int                 `json:"safetyRevision"`
}

type SafetyPublicPayload struct {
	Route            SafetyRouteSnapshot `json:"route"`
	StartsAt         time.Time           `json:"startsAt"`
	EndsAt           time.Time           `json:"endsAt"`
	TimeZone         string              `json:"timeZone"`
	LeaderName       string              `json:"leaderName"`
	ParticipantCount int                 `json:"participantCount"`
	PreparedAt       time.Time           `json:"preparedAt"`
}

type SafetyPrivateDetails struct {
	LeaderPhone           string                     `json:"leaderPhone"`
	EmergencyContactName  string                     `json:"emergencyContactName"`
	EmergencyContactPhone string                     `json:"emergencyContactPhone"`
	CommunicationPlan     string                     `json:"communicationPlan"`
	Transport             string                     `json:"transport"`
	BackupRoute           string                     `json:"backupRoute"`
	Equipment             string                     `json:"equipment"`
	FirstAid              string                     `json:"firstAid"`
	Insurance             string                     `json:"insurance"`
	Notes                 string                     `json:"notes"`
	Participants          []SafetyParticipantContact `json:"participants"`
}

type SafetyPassport struct {
	DepartureID             string                `json:"departureId"`
	Version                 int                   `json:"version"`
	Status                  string                `json:"status"`
	NotificationPolicy      string                `json:"notificationPolicy"`
	OfficialFormURL         string                `json:"officialFormUrl"`
	SubmissionID            *string               `json:"submissionId,omitempty"`
	SubmittedAt             *time.Time            `json:"submittedAt,omitempty"`
	ConfirmedAt             *time.Time            `json:"confirmedAt,omitempty"`
	StartContactConfirmedAt *time.Time            `json:"startContactConfirmedAt,omitempty"`
	ReturnReportedAt        *time.Time            `json:"returnReportedAt,omitempty"`
	PassportHash            string                `json:"passportHash,omitempty"`
	ManifestHash            string                `json:"manifestHash,omitempty"`
	Public                  *SafetyPublicPayload  `json:"public,omitempty"`
	Private                 *SafetyPrivateDetails `json:"private,omitempty"`
}

type MCHSSubmissionInput struct {
	PassportVersion int       `json:"passportVersion"`
	SubmissionID    string    `json:"submissionId"`
	SubmittedAt     time.Time `json:"submittedAt"`
}

type MCHSConfirmationInput struct {
	PassportVersion    int    `json:"passportVersion"`
	ConfirmationRef    string `json:"confirmationRef"`
	ConfirmationSHA256 string `json:"confirmationSha256,omitempty"`
}

type MCHSStartContactInput struct {
	PassportVersion int       `json:"passportVersion"`
	ContactedAt     time.Time `json:"contactedAt"`
	Note            string    `json:"note,omitempty"`
}

type MCHSReturnReportInput struct {
	PassportVersion int       `json:"passportVersion"`
	ReportedAt      time.Time `json:"reportedAt"`
	Method          string    `json:"method"`
	Note            string    `json:"note,omitempty"`
}

type SafetyCheckInInput struct {
	Kind       string    `json:"kind"`
	ObservedAt time.Time `json:"observedAt"`
	Latitude   *float64  `json:"latitude,omitempty"`
	Longitude  *float64  `json:"longitude,omitempty"`
	Note       string    `json:"note,omitempty"`
}

type SafetyCheckIn struct {
	ID               string    `json:"id"`
	DepartureID      string    `json:"departureId"`
	ActorID          string    `json:"actorId"`
	Kind             string    `json:"kind"`
	ObservedAt       time.Time `json:"observedAt"`
	ServerReceivedAt time.Time `json:"serverReceivedAt"`
	Latitude         *float64  `json:"latitude,omitempty"`
	Longitude        *float64  `json:"longitude,omitempty"`
	Note             string    `json:"note,omitempty"`
}

type EmergencyCard struct {
	DepartureID           string        `json:"departureId"`
	EmergencyNumber       string        `json:"emergencyNumber"`
	RouteTitle            string        `json:"routeTitle"`
	StartsAt              time.Time     `json:"startsAt"`
	EndsAt                time.Time     `json:"endsAt"`
	TimeZone              string        `json:"timeZone"`
	LeaderName            string        `json:"leaderName"`
	LeaderPhone           string        `json:"leaderPhone,omitempty"`
	EmergencyContactName  string        `json:"emergencyContactName,omitempty"`
	EmergencyContactPhone string        `json:"emergencyContactPhone,omitempty"`
	MCHSStatus            string        `json:"mchsStatus"`
	MCHSSubmissionID      *string       `json:"mchsSubmissionId,omitempty"`
	TerritorialUnitID     string        `json:"territorialUnitId,omitempty"`
	ControlPoints         []SafetyPoint `json:"controlPoints"`
	EmergencyExits        []SafetyPoint `json:"emergencyExits"`
	MessageTemplate       string        `json:"messageTemplate"`
}

func SafetyStartAllowed(policy, status string, contacted bool) bool {
	if policy == "not_required" || policy == "recommended" {
		return true
	}
	return policy == "required" && status == "confirmed" && contacted
}
