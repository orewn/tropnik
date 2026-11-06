/** TROPA API v1. No sample people, departures or ratings are production data. */
export type ID = string;
export type APIError = { error: { code: string; message: string; requestId?: string } };
export type Envelope<T> = { data: T; meta?: { mode: 'production'; nextCursor?: string } };
export type User = { id: ID; displayName: string; email: string; role: 'tourist' | 'guide'; staffRole: 'none' | 'moderator' | 'admin'; guideStatus: 'none' | 'pending' | 'verified' | 'suspended' | 'expired'; emailVerified: boolean; createdAt: string };
export type AuthResponse = Envelope<{ token: string; expiresAt: string; user: User }>;
export type RegisterInput = { email: string; password: string; displayName: string; role: 'tourist' | 'guide' };
export type AccountMailInput = {email: string};
export type AccountMailResponse = {status: 'accepted'; message: string};
export type AccountEmailConfirmInput = {token: string};
export type AccountPasswordResetInput = {token: string; password: string; passwordConfirmation: string};
export type AccountDeleteInput = {password: string; confirmation: 'delete'};
export type Region = { id: string; title: string; description: string; center: [number, number]; bounds: [number, number, number, number]; routeCount: number };
export type Route = { id: ID; slug: string; regionId: string; title: string; description: string; difficulty: 'easy' | 'moderate' | 'hard' | 'expert'; activity: string; distanceKm: number; ascentM: number; durationMin: number; minPeople: number; maxGroupSize: number; requiredGuides: number; status: 'published' | 'closed'; revisionId: ID; revision: number; verifiedAt: string | null; source: { name: string; url: string; license: string; retrievedAt: string }; geometry: { type: 'LineString'; coordinates: number[][] }; geometryDetail: 'overview' | 'full'; season: string; updatedAt: string };
export type DepartureStatus = 'recruiting' | 'ready' | 'awaiting_guide' | 'in_progress' | 'completed' | 'cancelled' | 'aborted';
export type Departure = { id: ID; routeId: ID; routeRevisionId: ID; routeTitle?: string; reviewTargets?: ('route' | 'guide')[]; guideId: ID | null; guideName: string | null; startsAt: string; endsAt: string; timeZone: string; minPeople: number; capacity: number; participantCount: number; status: DepartureStatus; version: number; routeOpen: boolean; guideEligible: boolean; membership: 'none' | 'confirmed' | 'checked_in' | 'cancelled' | 'completed' | 'no_show'; createdAt: string };
export type CompletedDeparture = { id: ID; routeId: ID; routeRevisionId: ID; routeTitle: string; startsAt: string; endsAt: string; completedAt: string; timeZone: string; role: 'tourist' | 'guide'; guideId: ID | null; guideName: string | null; reviewTargets: ('route' | 'guide')[] };
export type CreateDepartureInput = { routeId: ID; routeRevisionId?: ID; startsAt: string; endsAt: string; timeZone: string; minPeople?: number; capacity?: number };
export type RecruitmentRequest = { id: ID; routeId: ID; creatorId: ID; creatorName: string; preferredDate: string | null; body: string; status: 'open' | 'accepted' | 'cancelled'; departureId: ID | null; interestedCount: number; createdAt: string };
export type RecruitmentMessage = { id: ID; requestId: ID; userId: ID; displayName: string; body: string; visibility: 'visible' | 'hidden'; clientId: string; createdAt: string };
export type Message = { id: ID; departureId: ID; userId: ID; displayName: string; body: string; visibility: 'visible' | 'hidden'; clientId: string; createdAt: string };
export type Participant = { userId: ID; displayName: string; role: 'tourist' | 'guide'; status: 'confirmed' | 'checked_in' | 'completed' | 'no_show' };
export type Guide = { id: ID; displayName: string; guideStatus: 'verified'; activities: string[]; completedTrips: number; reviewCount: number; rating: number | null };
export type Review = { id: ID; departureId: ID; userId: ID; target: 'guide' | 'route'; rating: number; body: string; createdAt: string; participationConfirmed: true };
export type OfflineObservation = { clientId: string; departureId: ID; observedAt: string; baseVersion: number; kind: 'field_note' | 'check_in_observation'; body: string };
export type SyncAck = { clientId: string; status: 'recorded' | 'conflict' | 'rejected'; currentVersion?: number; reason?: string; serverAuthorized: false };
export type Badge = { id: 'first_trip' | 'five_trips' | 'first_review' | 'first_guided_trip'; title: string; description: string; earnedAt: string; evidenceId: ID; evidenceType: 'departure' | 'review' };
export type AccountSummary = { user: User; stats: { completedTrips: number; reviewsWritten: number }; badges: Badge[]; moderation: { mutedUntil: string | null } };
export type Notification = { id: ID; kind: 'moderation' | 'appeal' | 'report'; title: string; body: string; createdAt: string; readAt: string | null };
export type ReportTarget = 'message' | 'recruitment_message' | 'review';
export type ReportReason = 'spam' | 'harassment' | 'dangerous_information' | 'personal_data' | 'other';
export type ReportInput = { targetType: ReportTarget; targetId: ID; reason: ReportReason; body: string };
export type Report = ReportInput & { id: ID; status: 'open' | 'resolved' | 'dismissed'; createdAt: string; resolvedAt: string | null; decisionReason: string | null };
export type ModerationReport = Report & { reporter: { id: ID; displayName: string }; subject: { id: ID; displayName: string }; targetBody: string; targetVisibility: 'visible' | 'hidden' };
export type ModerationAction = { id: ID; reportId: ID; targetType: ReportTarget; targetId: ID; action: 'hide' | 'mute' | 'hide_and_mute'; reason: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; appealStatus: 'open' | 'upheld' | 'overturned' | null };
export type Appeal = { id: ID; actionId: ID; body: string; status: 'open' | 'upheld' | 'overturned'; createdAt: string; decidedAt: string | null; decisionReason: string | null };
export type ModerationAppeal = Appeal & { action: ModerationAction; subject: { id: ID; displayName: string }; canResolve: boolean };
export type ResolveReportInput = { action: 'dismiss' | 'hide' | 'mute' | 'hide_and_mute'; reason: string; muteHours?: number };
export type ResolveAppealInput = { decision: 'upheld' | 'overturned'; reason: string };
// Reads: GET /api/v1/regions, /routes?region=ID, /routes/ID,
// /departures?route=ID, /departures/ID, /me, /departures/ID/messages.
// Auth: POST /auth/register, /auth/login; POST /auth/logout requires Bearer.
// Mutations require Authorization: Bearer <token>. Never put tokens in URLs.
// Join: POST /departures/ID/join, JSON { expectedVersion?: number },
// Idempotency-Key: a unique 16..128 character opaque identifier per action.
// Leave: POST /departures/ID/leave. POST /departures/ID/messages {body,clientId}.
// Review: POST /departures/ID/reviews {target,rating,body}.
// Sync: POST /sync/observations { observations: OfflineObservation[] }.
// Sync records observations, NEVER issues offline/server departure authorization.
// Recruitment (authenticated): GET /recruitment-requests?route=ID;
// POST /recruitment-requests {routeId,preferredDate?:'YYYY-MM-DD',body};
// POST /recruitment-requests/ID/join or /leave; interest is not confirmed participation.
// GET/POST /recruitment-requests/ID/messages (POST {body,clientId}).
// POST /recruitment-requests/ID/accept with CreateDepartureInput (routeId optional).
// Acceptance requires an eligible verified guide; tourists explicitly join afterward.
// GET /departures/ID/participants: assigned guide only, no contact details.
// Departure messages: initial GET returns latest 100 in ascending order;
// meta.nextCursor retrieves newer messages, not older history.
// Route minPeople/maxGroupSize include the guide and are operator-reviewed policy.
// A departure cannot lower that minimum or exceed that capacity. The current
// membership model supports requiredGuides=1 only; larger values block creation.
// Account: GET /me/summary, GET /me/notifications, POST /me/notifications/ID/read {} ->204.
// Reports: POST /reports ReportInput (body 10..2000 trimmed characters), GET /me/reports.
// Moderation: GET /moderation/reports?status=open|resolved|dismissed (default open),
// POST /moderation/reports/ID/resolve ResolveReportInput -> Report.
// Reasons for staff decisions: 10..2000 chars; muteHours integer 1..168 when muting.
// Appeals: GET /me/moderation-actions, POST /moderation-actions/ID/appeals {body:10..2000 chars},
// GET /me/appeals, GET /moderation/appeals?status=open|upheld|overturned,
// POST /moderation/appeals/ID/resolve ResolveAppealInput -> Appeal.
// Staff queues exclude conflicted cases and subjects outside current authority.
// Appeal read/write excludes the subject, original reporter and original moderator.
// Appeal decisions require a different staff member than the original decision.
// ModerationAction.expiresAt ends the mute component only. Hidden content remains
// hidden until that decision is overturned, even after the mute has expired.
// Chat visibility hidden is a tombstone with body=''. Polling only by createdAt
// does not capture moderation changes: refresh the current latest-100 snapshot.
// GET /guides/ID/reviews -> Review[] for public, non-hidden guide reviews.

// GET /me/departures?limit=20&cursor=... -> Envelope<CompletedDeparture[]>; authenticated account only.
// History limit 1..50; meta.nextCursor continues older completed participation by (completedAt,id).
// Cursor is an opaque position, never an account selector or authorization. No participant list is returned.
// GET /routes pages are capped at 1 MiB of decoded JSON and may return fewer than limit.
// Always follow meta.nextCursor. GET /routes/ID retains complete geometry with an 8 MiB decoded JSON budget.
