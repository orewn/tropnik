# Backend implementation review

## Current context — 2026-11-13

The review below is a historical record from 2026-11-06. Its statements about
unexecuted database tests and missing account lifecycle functions are not the
current release status. Email verification, recovery and account closure were
subsequently implemented; schema 006 added the server-side safety passport.
The [0.4.23 source-bound proof](../docs/verification/backend-0.4.23-final.json)
records 52 unit tests and 29 native PostGIS integration tests. These historical
results do not qualify later changes.

The 2026-11-13 review found a production startup gap: checking only role flags
accepted an ordinary table/schema owner or a role with extra grants. Production
startup now compares effective privileges with the same policy that grants the
31 application tables. It rejects ownership, privileged predefined roles,
inherited/SET ROLE powers, ADMIN/GRANT options, extra or missing column/table
privileges, sequence rewriting and an owner connection with a selected limited
role. Grants are transactional; existing operator permissions are never revoked
automatically. This is a startup boundary, not continuous enforcement against a
later operator change or a claim of protection from a compromised database owner.

New native tests cover the previously accepted cases, assert that the former
four-flag check still appears unprivileged in those cases, and require a normal
restricted login to remain operational. The privileged-role tests inspect
metadata only. Their result must come from the exact-source native CI run;
adding test code is not evidence of execution. Current deployment and external
launch gates are recorded in [acceptance](../docs/acceptance.md).

Primary references for this boundary are PostgreSQL 18
[privilege semantics](https://www.postgresql.org/docs/18/ddl-priv.html) and
[privilege/role inquiry functions](https://www.postgresql.org/docs/18/functions-info.html).

## Historical implementation review

Review date: 2026-11-06. Scope: Go API, SQL migrations, operator CLI, API contract,
container configuration, social UI/API client and a read-only review of the web BFF. This is an
implementation review with recorded checks, not an independent penetration test
or a claim of production certification.

## Changes made during review

| Boundary | Implemented protection | Remaining limit |
| --- | --- | --- |
| Guide eligibility | Registration creates `pending`; separate operator credential records scoped qualifications and evidence. Eligibility is re-read under the guide row lock before authoritative group changes. | The operator must actually review evidence; no registry lookup or operator MFA is claimed. |
| Route publication | Imported data remains `review_required`; reviewed geometry, provenance, group minimum/maximum and guide count are immutable. API role cannot publish routes. | Route/permit/season evidence and group ratios require operational review. The current model rejects routes needing multiple assigned guides. |
| Last group places | A departure row lock serializes membership changes; database capacity trigger adds defense; a unique membership key counts the guide once. Idempotency key reuse with changed payload conflicts. | PostgreSQL concurrency assertions are in the integration suite, which has not run in this environment. |
| Start and incidents | Start requires eligible guide, current open revision, scheduled window and enough checked-in people including guide. No-shows cannot review. A revoked guide can still record an incident abort. | Physical attendance is a guide assertion, not independently established by GPS or the server. |
| Private chat and roster | Departure access is checked within the locked transaction; interest-chat membership is rechecked in the read snapshot and serialized for sending. Only the assigned guide can read the minimal roster. | Messages already downloaded cannot be remotely made unreadable offline. No older-history pagination or end-to-end encryption is implemented. |
| Staff permissions | Staff roles are separate from tourist/guide status. Grants require the operator CLI; registration cannot self-assign them. Each case request rechecks current roles under a row lock. | An authorized operator can still misuse their authority; external MFA/SSO and operational oversight remain required. |
| Case privacy and appeals | Queues return only reported material for cases the actor may review. Self-cases, original-report conflicts and staff subjects outside the actor's authority are excluded before the queue limit and rechecked before evidence is returned. Appeals exclude the subject, original reporter and original moderator. Queue reads and decisions are audited. | An authorized reviewer can read the reported body and minimal identities. This release does not implement a separate per-case assignee permission or a staff investigation organization. |
| Moderation transactions | Hide/mute, decisions, visibility, notifications and audit records commit together. Overturning one action preserves other active actions. A mute does not prevent reports, appeals, maps or incident handling. | The real PostgreSQL lock/visibility assertions are compiled but unexecuted here. Hidden cached messages need a current snapshot refresh; a creation-time cursor alone cannot propagate a later hide. |
| Sessions | Cryptographically random 256-bit bearer tokens, only token hashes in PostgreSQL, expiry and explicit revocation. Browser integration uses an HttpOnly cookie at the BFF boundary. | Email ownership, account recovery/deletion and operator MFA remain launch work. |
| Passwords and auth abuse | PBKDF2-SHA256 with 600,000 iterations, unique salt, constant-time verification and bounded input. Migration 003 stores HMAC-keyed per-IP and per-account budgets in PostgreSQL; atomic upserts persist denied attempts and share limits across API processes/restarts. Database failure denies authentication. | The four concurrent password-hash slots and broader 120/minute write guard remain process-local. Accurate per-visitor accounting behind ingress requires the independently keyed proxy chain; real two-pool PostgreSQL execution is still a deployment gate. |
| Posting abuse | PostgreSQL serializes per-user budgets across channels and API replicas. Unicode-normalized fingerprints, bounded link counts, recruitment/report budgets and temporary mutes are checked before new content commits. Stable message-client-ID replay precedes spam accounting and redacts hidden content. | These are explicit heuristics, not AI or a guarantee of spam detection. They do not establish identity or detect coordinated accounts. Operator monitoring and a false-positive process are needed. |
| Reviews and badges | A completed participant may write at most one review per target and cannot review their own guiding. Hidden reviews leave public aggregates. Badges use actual completion/review event evidence and dates, and confer no permissions. | Guide-confirmed completion can still be abused by colluding people; no independent physical-attendance verification is claimed. |
| Proxy trust | Forwarded addresses are ignored unless the direct peer matches an explicit trusted CIDR and a separate 256-bit ingress proof matches in constant time. Only a single valid `X-Real-IP` is interpreted; arbitrary `X-Forwarded-For` is ignored. | Trusted ingress must overwrite incoming spoofable headers and install the same proof on Caddy, Next and Go. No default broad trust range is shipped. Managed Sites does not automatically provide this chain. |
| Database credentials | Separate owner/operator and restricted API roles; production rejects superuser/create-role/create-db/bypass-RLS accounts. External databases require verified TLS unless private-network trust is explicitly configured. | The actual restricted-role/container integration test remains a mandatory deployment gate. |
| Offline reconciliation | Observations have client IDs, observation time, base version and explicit conflict acknowledgements. Every response keeps `serverAuthorized: false`. | A disconnected phone cannot learn about later guide revocation or trail closure. Cached maps must remain available during an incident. |

## Web BFF review and handoff

The reviewed BFF restricts the API path, validates same-origin mutations, bounds
request bodies, keeps session tokens out of browser JSON, uses an HttpOnly cookie,
does not follow upstream redirects and handles a successful `204` logout. The
web owner corrected the two initial findings: logout upstream errors now clear
the local cookie with an explicit acknowledgement header while reporting that
server revocation was not confirmed; `HEAD` responses have no parsed JSON body.
Those changes were observed in the final source review, not on a live backend.

The subsequent deployment review found that ordinary Next can construct
`req.nextUrl` from the internal listener hostname and port. Comparing a public
browser `Origin` to that internal URL would reject legitimate mutations behind
Caddy. The BFF now checks the server-only canonical `PUBLIC_ORIGIN` instead and
uses its HTTPS scheme for both session creation and deletion cookies. Missing or
invalid origin configuration fails closed; request/forwarded host and protocol
headers never grant origin trust. Plain HTTP is permitted only for an explicit
loopback origin under `NODE_ENV=development`. See
[`backend-origin-audit-2026-11-06.md`](../docs/backend-origin-audit-2026-11-06.md).
The status endpoint applies the same origin policy before probing Go readiness;
it does not report the browser service as connected when that policy is invalid.

The social UI clears private views on confirmed local-session changes, prevents
stale async responses from replacing a newer identity/group, preserves message
client IDs for uncertain retries, and uses fresh snapshots for hidden-message
updates. It distinguishes a missing API configuration from a network failure.
Browser cookies and pending writes require real end-to-end deployment testing.

## Checks actually completed

Machine-readable results are in `verification/summary.json` and full Go event
output in `verification/go-tests.jsonl`.

- Go race test suite: 22 top-level tests passed across five packages, with 31
  total test/subtest pass events and no failures. Other ordinary packages
  compiled. These numbers describe this run, not broad security coverage.
- `go vet ./...`: passed.
- Integration test executable with `-tags=integration`: compiled successfully.
  Compilation is not database execution.
- Static Go build of all packages, without VCS stamping: passed. The first plain
  build could not read the surrounding workspace's VCS state; disabling only
  build metadata stamping resolved this unrelated packaging condition.
- OpenAPI and all three Compose YAML documents parsed; shell scripts passed `bash -n`.
  Syntax checks do not validate Docker networking, privileges or SQL behavior.
- Web API/policy tests: eight tests passed. TypeScript checking, a standard
  Next 16 production build and a local standalone HTTP smoke check passed for
  the social-UI handoff. The smoke check verified public pages plus an honest
  `503 service_not_configured` API response. It did not exercise a real database.
  The web owner subsequently completed an isolated Next 16.3.4 webpack build;
  its separate evidence is recorded in `../docs/verification/next-production-build.json`.
  That later build does not broaden the scope of the earlier HTTP smoke check.

## Release gates recorded on 2026-11-06

Run `../infra/run-integration.sh` on a Docker-capable host. It provisions only a
uniquely named ephemeral test stack and schema. The suite checks concurrent last
places, replay, guide withdrawal, private access, actual review uniqueness,
offline conflicts, recruitment conversion, runtime database privileges, bounded
overview geometry, route-revision invalidation and reviewed group-policy limits.
It also checks posting budgets under concurrent channels, private-target report
access, role revocation, staff-case privacy, independent appeals, moderation
visibility, mute/replay semantics, notification ownership and award evidence.

This environment has no PostgreSQL or Docker runtime. Normal package setup could
not switch system users; no workaround to the privilege restriction was used.
Consequently migration execution, PostGIS expressions, transaction behavior,
runtime grants and container startup are not represented as passed.

Before opening public registration, also finish contact verification, recovery
and deletion; staff and operate the implemented moderation/appeal workflows;
define retention and complaint-handling policies; complete evidence review and
legal checks; configure trusted ingress and shared auth rate limits; test backup
restoration; perform container digest/SBOM/vulnerability review; and conduct actual Android
offline/device/field testing. No payment, weather, rescue-delivery or automatic
emergency-registration service is implemented by this backend. Stored notices
are not email or push delivery; no notification delivery worker is claimed.
Profile/request-card/catalog complaint targets, broader content-policy workflows
and collusion detection are outside the bounded moderation implementation.
