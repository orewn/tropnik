# TROPA backend

Go API and PostgreSQL/PostGIS persistence for a Russia-first guided hiking product.
The API stores real accounts, sessions, recruitment requests, groups, messages and
reviews. The initial migration contains six region records and **no invented
routes, verified guides, departures, participants or ratings**.

## What is implemented

- Real email/password registration and login, opaque 256-bit sessions, logout.
  Only SHA-256 session-token hashes are stored. Passwords use the Go standard
  library's PBKDF2-HMAC-SHA256, 600,000 iterations and a unique 128-bit salt.
- Email verification, password recovery and account closure through a configured
  TLS SMTP transport. Without mail configuration, public registration and new
  action-link requests stay closed. See the lifecycle section below for delivery
  limits, retained records and operator setup.
- Shared PostgreSQL authentication budgets: 20 attempts/IP/minute and ten login
  attempts/normalized account/minute. Identifiers are HMAC-SHA256 digests made
  with a stable server-only key. Restarting or adding an API process does not
  reset these counters; database failure denies authentication attempts.
- A guide application starts as `pending`. An operator verifies the qualification
  scope, expiry and evidence through a separate CLI. Public endpoints cannot
  grant operator rights or publish a route.
- Route provenance, immutable reviewed revisions, spatial geometry and an
  explicit publication process. Importing coordinates never verifies a trail.
- Guide-led departures with a pinned route revision. Default minimum: four people
  **including** the guide. Default capacity: eight. A departure may raise the
  route's reviewed minimum or lower its reviewed maximum; it cannot weaken
  either limit. The operator explicitly approves the route's group policy before
  publication. One designated guide is supported in this release. Routes
  requiring more guides cannot create departures with the current model.
- Database-serialized joins, capacity enforcement in PostgreSQL, idempotency
  keys, guide withdrawal, underflow, attendance, start and completion gates.
- Recruitment requests with an interest chat. An eligible guide accepts a request
  and creates a dated departure atomically. Interested tourists then explicitly
  confirm those dates; interest is never silently converted to a booking.
- Participant-only departure chat; assigned-guide-only roster without private
  contact details; plain-text messages with client idempotency keys.
- Completed participants can submit one review per departure and target. A guide
  cannot rate their own departure. A guide's public rating is `null` with zero
  reviews, not a fabricated five-star score.
- Offline observation acknowledgements with conflict detection. These records
  **do not authorize a start or modify the authoritative roster**.
- Transactional outbox and an append-only audit table for the API database role.
  The outbox is durable storage, not a claim that push/email delivery exists.
- Separate staff roles, case-scoped moderation, reporting and independent appeals.
  Guide qualification never grants staff permissions. Sanctions require a reason,
  generate a stored account notification and commit with their audit entry.
- Persistent anti-spam posting budgets, Unicode-aware duplicate fingerprints and
  link limits. These are explicit heuristics, not an AI classifier or a guarantee
  that all unwanted content will be detected. A rejected post gets `429` and is
  not inserted or presented as delivered.
- Personal account summary and four evidence-derived badges. They are based only
  on completed membership/review records, with the original event ID and time.
  Badges do not grant guide/staff permissions or assert a person's safety.

## API contracts

See `../contracts/api.ts` and `../contracts/openapi.yaml`. All resource paths begin
with `/api/v1`. Successful JSON responses use `{ "data": ..., "meta": ... }`.
Errors use `{ "error": { "code": ..., "message": ... } }`.

Native clients use `Authorization: Bearer <token>` over HTTPS. Web clients should
keep that token in a same-origin BFF's HttpOnly, Secure cookie; do not put it in
URLs, browser localStorage, analytics or logs. The BFF must validate Origin on
cookie-authenticated mutations and handle a successful `204` logout without
trying to parse JSON.

Key operations:

| Operation | Endpoint |
| --- | --- |
| Public regions and trails | `GET /regions`, `GET /routes?region=karelia`, `GET /routes/{id}` |
| Public guide profiles | `GET /guides`, `GET /guides/{id}` |
| Real account | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /me` |
| Confirm email | `POST /auth/email/request`, `POST /auth/email/confirm` |
| Recover password | `POST /auth/password/request`, `POST /auth/password/reset` |
| Close account with current-password confirmation | `POST /me/delete` |
| Profile / guide application | `PATCH /me/profile` |
| Private completed hike history | `GET /me/departures?limit=20&cursor=...` |
| Create dated hike | `POST /departures` (eligible verified guide) |
| Join / withdraw | `POST /departures/{id}/join`, `POST /departures/{id}/leave` |
| Roster / attendance | `GET /departures/{id}/participants`, `POST /departures/{id}/check-in` |
| Start / complete / cancel / abort | `POST /departures/{id}/transition` |
| Trip chat | `GET/POST /departures/{id}/messages` |
| Reviews | `GET/POST /departures/{id}/reviews` |
| Start interest group | `POST /recruitment-requests` |
| Join / leave interest | `POST /recruitment-requests/{id}/join` or `/leave` |
| Interest chat | `GET/POST /recruitment-requests/{id}/messages` |
| Guide accepts interest | `POST /recruitment-requests/{id}/accept` |
| Reconcile field notes | `POST /sync/observations` |

`POST /departures/{id}/join` requires a unique `Idempotency-Key` of 16–128 ASCII
letters, numbers, `_` or `-`. Use a random UUID and retain it for retries of the
same action and payload. A replay returns the original result; refresh the
departure afterward to show its current state. Reusing a key for another request
is rejected. `expectedVersion` prevents applying an action to an older roster.

Trip chat initially returns the latest 100 messages in ascending order. Use
`meta.nextCursor` to poll **newer** messages; if a large backlog fills a page,
continue until caught up. Recruitment chat returns the latest 100. Older history
pagination and WebSocket delivery are not implemented in this release.

Moderation can change an older message without changing its creation timestamp.
Refresh the current latest-100 snapshot to reconcile `visibility: "hidden"`
tombstones (`body: ""`); a creation-time cursor alone cannot observe those edits.
Previously downloaded offline text cannot be made remotely unreadable while a
device is disconnected. Hidden reviews are excluded from public lists and ratings.

Route list geometry is explicitly `geometryDetail: "overview"`, bounded to
1,000 source vertices per route. It is for discovery, not navigation. Request
`GET /routes/{id}` for the complete reviewed geometry (`geometryDetail: "full"`)
and pin its revision when preparing an offline package.

Route overview pages are bounded to **1 MiB of decoded JSON**, including their
envelope. A page can contain fewer than the requested limit even when more
routes exist: continue with `meta.nextCursor` until it is absent. The cursor
always points to the last included route; a row that does not fit is not skipped.
Full route detail has a separate **8 MiB** decoded response budget and retains
all reviewed vertices, up to 100,000. The Android client applies the same limits
while streaming, including chunked and gzip responses; error responses retain
the 1 MiB limit. A legacy oversized route returns an explicit service error
instead of truncated geometry. Operator import reads at most 10 MiB, validates
bounded metadata and finite WGS84 coordinate pairs, and checks the full route
transport budget before storage.

`GET /me/departures` returns only the authenticated account's completed
memberships in completed hikes, with the pinned route revision and completion
time. It accepts a page size of 1–50 (default 20) and a stable descending
completion-time/ID cursor. It includes records after a route leaves the public
catalogue and never includes a roster or private contacts. `reviewTargets`
lists the account's remaining review targets; a hidden review still occupies
its target. Completed departure detail also returns that field only to the
current completed participant. The web account and Android profile link each
history entry to its hike and reviews; the history is not a public profile.

## Local development

Requires Go 1.27+, PostgreSQL with PostGIS, and a **development database**.
Generate a separate 64-character hexadecimal auth key once (for example with
`openssl rand -hex 32`) and retain it in your uncommitted development environment.

```bash
export DATABASE_URL='postgres://your_dev_user:your_dev_password@127.0.0.1:5432/tropa_dev?sslmode=disable'
export TROPA_AUTH_RATE_KEY='REPLACE_WITH_YOUR_64_HEXADECIMAL_CHARACTERS'
go run ./cmd/tropa-migrate
APP_ENV=development PUBLIC_ORIGIN=http://localhost:3000 go run ./cmd/tropa-api
```

The development example intentionally names placeholders. No default account or
default password is installed. The API binds `127.0.0.1:8080` unless `HTTP_ADDR`
is specified. Use the production container instructions in `../infra/README.md`
for real users. Do not point a development process at a production database.

## Operator review, with explicit evidence

The operator CLI uses `OPERATOR_DATABASE_URL`, separate from the API role. First
register the real operator account through the app. Bootstrap can create only
the first operator, under a database advisory lock:

```bash
go run ./cmd/tropa-admin bootstrap-admin --email your-operator-address
```

Then review a guide's actual evidence before invoking:

```bash
go run ./cmd/tropa-admin verify-guide --actor OPERATOR_UUID --user GUIDE_UUID \
  --activity hiking --max-difficulty 2 --valid-until RFC3339_EXPIRY \
  --evidence INTERNAL_REVIEW_REFERENCE
```

No registry lookup is fabricated by this command. An operator must actually
perform the required checks and record the reference. The CLI supports
`revoke-guide` with the same actor/user/evidence parameters. Route publication
is also an operator action:

```bash
go run ./cmd/tropa-admin import-route --actor OPERATOR_UUID --file reviewed-input.json
go run ./cmd/tropa-admin publish-route --actor OPERATOR_UUID --route ROUTE_UUID \
  --evidence INTERNAL_ROUTE_REVIEW_REFERENCE --min-people 4 \
  --max-group-size REVIEWED_MAXIMUM --required-guides 1
```

The input is the `Route` shape in `contracts/api.ts`; supply a slug, region, title,
description, activity, difficulty, season, ascent, duration, source name/HTTPS URL/
license/retrieval timestamp and a WGS84 GeoJSON LineString. Import disregards any
claimed public status or verification timestamp and creates `review_required`.
Distance is calculated from the imported geometry. Ascent, duration and
difficulty still require an actual source and review. Route closing uses
`close-route --actor ... --route ... --evidence ...`.

`REVIEWED_MAXIMUM` must be replaced with the actual reviewed limit, including the
guide; it is not a universal recommendation. The CLI deliberately requires the
maximum and guide count rather than assuming every route has the same safe or
lawful ratio. The current publication flow accepts one required guide only.
The minimum, maximum and guide count are part of the immutable route revision.

The region center/bounds records are approximate overview camera bounds, not
legal border polygons. The route's original source/license remains explicit.

## Staff roles, reporting and anti-spam

`role` remains `tourist` or `guide`. The separate, server-derived `staffRole` is
`none`, `moderator` or `admin`. Registration/profile endpoints reject staff-role
claims. Grant staff access only with the operator credential and a verified
existing account identity:

```bash
go run ./cmd/tropa-admin grant-staff --actor OPERATOR_UUID --user STAFF_UUID \
  --staff-role moderator --evidence INTERNAL_AUTHORIZATION_REFERENCE
```

Use `--staff-role none` to revoke access or `admin` for an explicitly authorized
administrator. The CLI prohibits changing the acting operator's own assignment
and prohibits verifying their own guide qualification. The actor row is locked
while authorization is used. Existing HTTP sessions do not preserve a revoked
staff role: each moderation operation checks current database permissions.
There is no public staff-grant API, and earning a badge changes no permissions.

The current workflow is deliberately bounded to messages in hike/request chats
and published reviews:

1. An authenticated participant reports a specific accessible message; any
   authenticated user may report another user's public review. The report does
   not automatically hide the content. One report per reporter and target is
   stored; personal reports remain private.
2. A moderator opens the case queue. Only the reported material and minimal
   identities are returned, not the rest of a private conversation. The case IDs
   viewed are recorded in the audit log. The queue excludes the actor's own cases
   and subjects above their authority; complaints about staff require an
   independent administrator for both reading and deciding.
3. A different actor from the subject and reporter dismisses, hides, temporarily
   mutes, or hides and mutes the subject. A moderator cannot sanction staff;
   that requires an administrator. A human-readable reason is mandatory.
4. The subject can appeal even while muted. A staff member other than the subject,
   original reporter and original moderator must read and decide the appeal.
   Overturning one decision leaves other active decisions in force.

Mutes last from one hour through seven days. `expiresAt` applies to the mute
component; hidden material remains hidden until the corresponding decision is
overturned. An active mute blocks new chat messages, reviews and recruitment
requests. It does not block map access, reporting, appeals, group withdrawal,
attendance, cancellation or incident handling. Report moderation is not an
emergency communication service.

The initial posting budgets are product policy and should be monitored for false
positives before expanding access:

| Rule | Account younger than seven days without a completed hike | Older account or completed participant |
| --- | --- | --- |
| Successful public posts per minute, across channels | 12 | 40 |
| Successful public posts per minute in one channel | 6 | 20 |
| Successful public posts per day | 100 | 500 |
| Recognized links per post | 1 | 3 |
| Recruitment requests per hour | 3 | 3 |
| Reports per hour, including during a mute | 20 | 20 |

Counters and sanctions share a per-user PostgreSQL lock, so adding API replicas
does not reset those budgets. A client-ID replay is recognized before counting
or duplicate detection. Accepted posts record a fingerprint; text identical after
normalization within 15 minutes is rejected as a repeat. The fingerprint
normalizes compatibility forms, case, whitespace and invisible formatting
characters. It does not solve all language obfuscation or collusion. No supplied
URL is fetched, and no permanent ban is issued by these heuristics.

`GET /me/summary` returns actual counts and badges with `evidenceId` /
`evidenceType`. Badge dates use recorded completion/review timestamps; old records
without a completion event time do not get an invented award date. Notifications
are stored records under `/me/notifications`, not a claim of email/push delivery.
The exact account/report/appeal request shapes are in `contracts/api.ts` and
OpenAPI. Queues return up to 100 eligible cases, oldest first; personal histories
return up to 100 recent records. Older-page navigation is not implemented.

The framework now applies migrations 001–005 in order and refuses API
readiness without schema version 5. Migration 004 adds account-history indexes;
005 adds digest-only action tokens, permanent account tombstones and guards
against deleting active participants, guides or departure owners. Re-run
migrations with the owner credential,
then reapply restricted runtime grants as documented in `../infra`.

## Account lifecycle and mail transport

Configure `TROPA_SMTP_HOST`, `TROPA_SMTP_PORT`, `TROPA_SMTP_TLS_MODE` (`tls` or
`starttls`), `TROPA_MAIL_FROM` and `TROPA_ACCOUNT_ACTION_URL`. Optional SMTP
username/password must be supplied together. TLS 1.2 or newer, certificate
validation and matching server name are mandatory; STARTTLS cannot fall back
to plaintext. The action URL is a fixed operator-configured HTTPS page, normally
`https://your-domain.example/account/action`; it is never built from request
Host headers. A deployment under a path prefix includes that prefix in this URL.
The Docker base network has no external egress; use the explicit mail overlay in
[`infra`](../infra/README.md) when the sender is ready.

An entirely absent configuration disables signup and new-link requests with
`503 registration_unavailable`, while existing accounts can log in. A partial
configuration fails startup. There is no log mailer, development token response
or fake success transport. Tests explicitly inject an in-memory mailer or use
a loopback TLS SMTP fixture with `example.invalid` recipients. No real mail was
sent while implementing or testing this change.

Successful registration keeps the original `201 {data:{token,expiresAt,user}}`
session contract and `emailVerified:false`. Email ownership changes only after
consuming the verification link. A verification flag does not grant a guide
qualification, a staff role or an operator entitlement; existing participation
permissions are unchanged.

Action secrets contain 256 cryptographically random bits. Only SHA-256 digests
are stored. Verification lasts at most 24 hours; reset links last 30 minutes.
Links put the secret in a URL fragment. The action page reads it once, immediately
removes it from the address bar and sends it only in the subsequent explicit
POST. Merely opening an email link does not consume it. New requests replace the
previous link of the same purpose. Token consumption and the corresponding
account mutation are one transaction, using a consistent user-row lock order.

Mail requests use a bounded in-memory queue (36 accepted jobs including four
active workers). Workers have a 20-second operation timeout; SMTP itself has a
15-second bound. A restart can lose queued requests; delivery is not a durable
promise, and the user can request another link. SMTP acceptance is audited as
acceptance, not mailbox delivery. Failed transport attempts revoke their own
token. Tokens, SMTP diagnostics and email addresses are not written to logs.
This transport sends account security mail; stored moderation notifications and
the departure outbox are not connected to it.

Recovery and verification-request responses are identical for existing, absent,
verified, disabled and staff accounts. Database account lookups and SMTP run
outside the HTTP response path. The existing HMAC-backed budget table now also
limits mail to three requests/address/15 minutes and deletion reauthentication
to five attempts/account/minute, in addition to the shared IP budget. Per-address
suppression still returns the same `202`; it does not claim mail was delivered.

A reset atomically changes the hash, consumes the token and revokes every
session and outstanding action link. Login session creation rechecks the
previously verified password hash under a row lock, closing the concurrent
login/reset race. The user signs in again; no automatic session is issued by
reset. A password-change notification is attempted through the same mail queue.

Account closure requires a valid session, the current password and explicit
confirmation. Active memberships, owned or guided departures, and owned open
recruitment requests block closure. The account is disabled permanently, email
and name are replaced, its password is destroyed and sessions/links are revoked.
Cached idempotent departure responses also replace the former guide name.
Participation history, messages/reviews, qualification evidence and audit remain;
personal information inside retained text or backups is **not** automatically
erased. An operator still needs a retention and personal-data request process.
Staff recovery and closure require operator-managed deprovisioning, not these
public endpoints.

The implementation follows the relevant token, enumeration, session-revocation
and reauthentication guidance in the [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
and [Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
This scope is not a claim of complete OWASP or legal compliance.

## Authentication budgets and trusted ingress

The API requires `TROPA_AUTH_RATE_KEY`, an independent, stable 256-bit key encoded
as 64 hexadecimal characters. Generate it once per deployment, share it between
API replicas and keep it out of source, client bundles, responses and logs. The
database stores only scope, keyed digest, count and timestamps for these budgets,
not plaintext account identifiers/IPs. Rotation changes the identity namespace
and resets outstanding counters, so coordinate it across replicas.

Counters use an atomic upsert and the database clock. Denied attempts commit;
they do not prolong the 60-second window. A separate autocommit cleanup uses
`FOR UPDATE SKIP LOCKED` to remove at most 64 expired rows. Separating the upsert
and cleanup avoids holding a current-identity lock while locking other keys.
Expiry works independently of cleanup; idle stale rows wait for later traffic
or scheduled bounded maintenance. Password-hash concurrency remains bounded to
four slots per process. The broad non-auth write guard is still process-local;
the existing per-user posting budgets are already persistent.

To preserve distinct browser IP budgets through the BFF, configure a separate
64-character `TROPA_PROXY_TOKEN` on Caddy, Next and Go, and explicit
`TRUSTED_PROXY_CIDRS` on Go. Caddy overwrites both `X-Real-IP` and the proof from
its own connection/environment. The BFF checks the proof in constant time and
accepts only a single valid address. Go repeats the proof check **and** verifies
the actual direct peer against its configured CIDRs. Untrusted/ambiguous headers
fall back to the peer address; `X-Forwarded-For` is ignored. Partial trust config
and reuse of the HMAC key as the proxy key are rejected at startup. No proxy
settings means direct-peer limiting, which is safe but shares a bucket if a BFF
sits in front. See [the topology and upgrade steps](../infra/README.md).

## Invariants and offline semantics

The departure row is locked before membership changes. Joins, membership writes,
state changes and the outbox entry commit together. A database trigger also
rejects over-capacity membership writes. The guide counts once. Removing the
guide removes readiness, and losing the minimum removes readiness.

Starting a hike additionally requires an eligible assigned guide, the pinned
reviewed route still being open/current, enough physically checked-in people,
the guide's check-in, and the scheduled time window. Withdrawal cannot erase an
in-progress roster. Expiry or revocation does not prevent the assigned guide
from recording an abort; it does prevent another start.

Offline notes carry the downloaded version and observed time. The server records
them separately and replies `serverAuthorized: false`, including after a
successful upload. A stale version gets a conflict acknowledgement. Local map
access is a client responsibility and must survive an expired login or failed
server authorization; no API response can make a disconnected client know about
a later closure or cancellation.

## Tests and actual verification status

```bash
go test -race ./...
go vet ./...
```

These exercise the domain, password/session primitives, HTTP boundary, strict
JSON handling, production configuration gates, trusted-proxy interpretation,
Unicode normalization, posting-budget boundaries, staff object permissions and
independent appeal rules.
The state tests include randomized adverse join/leave sequences, underflow,
guide withdrawal, a closed route, attendance quorum, review eligibility and
incident handling after qualification revocation.

The **separate real-PostGIS gate** is:

```bash
../infra/run-integration.sh
```

Or point `TEST_DATABASE_URL` at an isolated database whose name ends in `_test`
and run `go test -race -tags=integration ./internal/store`. Each test creates and
removes only its own random schema. Fixtures are clearly test-only. This suite
checks actual concurrent joins, replay, membership access, review uniqueness,
offline conflicts, recruitment conversion, runtime privileges, reviewed route
policies, concurrent posting across channels, moderation visibility, mute/appeal
transactions, notification ownership and award evidence. Its executable was compiled in
the build environment, but the suite was **not executed there**: neither Docker
nor PostgreSQL was available, and the normal package setup could not switch
system users. No privilege workaround was used. Do not treat a unit-test pass
as a PostgreSQL transaction test or a container deployment test.

An additional [isolated SQL compatibility harness](../tools/db-compat/README.md)
executes serial test bodies with pgx against PostgreSQL 18.6 / experimental
PostGIS 3.6.2 in PGlite. Nine serial scenarios passed before this auth change;
the three affected auth/expiry/cleanup, schema-readiness and `SET ROLE` grant
scenarios passed again after migration 003. It deliberately excludes native
concurrency and network role authentication. The native integration suite now
also contains a two-pool simultaneous auth-budget test; its compilation is not
an execution result. The exact current scope and source hashes are recorded in
[`verification/auth-proxy-2026-11-06.json`](verification/auth-proxy-2026-11-06.json).

## Required before public production launch

- Run the real PostGIS integration suite and exercise the container with its
  restricted API database role; verify backup restoration, not only backup creation.
- Set up operational guide/route review, reports/appeals and privacy/retention
  procedures. This CLI is a technical review mechanism, not a legal attestation.
- Configure and validate a real mail sender and the account-action page; exercise
  verification, recovery, delivery failure and closure against the deployed
  service. The implemented flows do not replace operator MFA/SSO or a complete
  personal-data retention/deletion process.
- Staff the moderation and independent-appeal process before accepting public
  UGC. Case APIs and the web interface exist; no staffed service or response-time
  commitment is implied. Profile/request-card/catalog report targets, collusion
  detection and wider content policy workflows remain outside this narrow release.
- Configure the trusted ingress proof/CIDRs and edge limits for the actual
  topology. Shared authentication/posting budgets are implemented; the broad
  mutation guard and password-hash slots remain per process. Network DDoS
  protection and a real cross-client deployment check remain operational gates.
- Define allowed route categories and guide ratios. This version supports one
  designated guide and must not silently advertise support for expeditions that
  require several guides or additional authorizations.
- Complete device/offline/field validation and legal review. No rescue delivery,
  current weather, payment capture or automatic MChS submission is implemented.
- Pin container image digests and run dependency/security scans in the release
  environment. Go dependencies are version/checksum-pinned; image tags alone are
  not immutable supply-chain pins.

## Primary technical references checked

- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): PBKDF2 parameters. This choice does not claim FIPS certification.
- [Go PBKDF2](https://pkg.go.dev/crypto/pbkdf2): standard-library KDF implementation.
- [pgx changelog](https://github.com/jackc/pgx/blob/master/CHANGELOG.md): v5.12.0 security fixes; dependency is pinned to that version.
- [PostGIS Docker](https://github.com/postgis/docker-postgis): current 18-3.7 image, amd64 support and PostgreSQL 18 volume path.
