# TROPA: independent self-host deployment

This directory runs the Go API and its PostgreSQL/PostGIS database. It does not
publish a website or contact real users. The web preview uses its own preview
runtime; ordinary self-hosting uses the Next application from `../web`.

## Host layout

Use an x86-64 Linux host with Docker Compose for the supplied PostGIS image.
The upstream `postgis/postgis:18-3.7` image documents amd64 support. An ARM host
requires a separately verified native PostGIS build; do not silently rely on
emulation for production. The data volume is `/var/lib/postgresql`, the
PostgreSQL 18+ image layout.

The database has no published port. API port 8080 binds only to host loopback.
PostgreSQL connections use a private isolated Docker network. The explicit
`TRUST_PRIVATE_DATABASE_NETWORK=true` setting applies to this topology; use
`sslmode=verify-full` for an external database instead.

## Configure and start

1. Copy the environment template to `.env` in this directory.
2. Generate independent 64-character hexadecimal values, for example by running
   `openssl rand -hex 32` separately for each. Set `POSTGRES_PASSWORD`,
   `TROPA_APP_PASSWORD` and the stable server-only `TROPA_AUTH_RATE_KEY`.
3. Set `PUBLIC_ORIGIN` to the exact HTTPS website origin, without a trailing slash.
4. Run:

```bash
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose --env-file .env ps
curl --fail http://127.0.0.1:8080/api/v1/health/ready
```

The database init script creates the unprivileged API role. The migration job
applies the schema as the owner and grants only the required runtime rights.
The API refuses a privileged database user in production. Neither an operator
nor a guide is automatically created. The API container is non-root, read-only,
has no extra Linux capabilities and contains no shell.

For an existing data volume, database initialization scripts do not run again.
Changing `.env` does not rotate an existing PostgreSQL role password. Perform a
planned database credential rotation and update the application configuration.
Do not delete a data volume to solve a credential or migration error.

The operator CLI is shipped in the API image at `/tropa-admin`. Run it as a
one-off process with an explicitly supplied operator database credential.
Do not copy that credential into the API service or the browser. See the backend
README for bootstrap, actual qualification review and route publication.

## Standard Next deployment

The application source uses Next conventions. Install its pinned dependencies
and use its ordinary Next commands on Node 24:

```bash
cd ../web
pnpm install --frozen-lockfile
pnpm run build:next
TROPA_API_URL=http://127.0.0.1:8080 pnpm run start:next
```

`pnpm-lock.yaml` is the current lockfile, including the map dependencies. The
inherited `package-lock.json` belongs to the original starter and is not the
self-host dependency source. The Dockerfile uses the pinned pnpm version and
frozen pnpm lockfile. `build:next` / `start:next` use ordinary Next; the existing
`build` / `start` scripts still serve the private-preview workflow.

The optional web container builds a traced Next standalone bundle:

```bash
docker compose -f compose.yaml -f compose.web.yaml --env-file .env up --build -d
```

The build context is `web/`. It never sends environment files or local build
state to Docker. The runtime is a non-root Node process with static/public files
copied alongside the traced server. `TROPA_STANDALONE=true` is a build-only switch
in `next.config.ts`; an ordinary non-container build still supports `next start`.
`PUBLIC_ORIGIN` is also passed as the Docker `SITE_ORIGIN` build argument because
the public canonical origin is bundled during the Next build. For a manual build,
set `NEXT_PUBLIC_SITE_URL` before `pnpm run build:next`. The build defaults to
`TROPA_PUBLIC_INDEXING=false`; enabling indexing requires the reviewed publication
configuration and a rebuild of the relevant static metadata. Do not infer public
launch readiness from a successful build.
The web port binds only to loopback and the supplied Caddy example remains the
public HTTPS ingress. Do not deploy the private-preview worker as if it were a
standalone Node HTTP server.

The server-only environment for the Next BFF should point to the actual origin
of the API, for example `TROPA_API_URL=http://127.0.0.1:8080` when Next and the API
share this host. The BFF appends `/api/v1` itself. Do not append it twice. Never
put credentials or database strings in `NEXT_PUBLIC_*` variables. Native Android
uses the public HTTPS origin and the same `/api/v1` API.

Use `Caddyfile.example` as the ingress starting point. It sends `/api/v1/*` to Go
and all remaining paths, **including `/api/backend/*`**, to Next. DNS and the
actual domain must be configured before enabling public HTTPS.

### Trusted client-address forwarding

The supplied forwarding path is Caddy → Next BFF → Go for website requests,
and Caddy → Go for the native client. Caddy must be the actual HTTPS ingress and
overwrite both `X-Real-IP` from its connection and `X-Tropa-Proxy-Token` from its
server environment. Generate a **fourth, independent** 64-character hexadecimal
value for `TROPA_PROXY_TOKEN`; install it in Caddy's service environment, the
server-side Next process and Go. A Compose `.env` does not automatically configure
a separately installed Caddy service.

Set `TRUSTED_PROXY_CIDRS` to the exact direct ingress/BFF peer addresses observed
by Go in the chosen topology. For three ordinary host processes that may be
`127.0.0.1/32,::1/128`; a containerized Go process sees Docker peers instead.
Inspect the actual network before choosing narrow ranges. Never allow all of
the Internet, publish the API/Next private ports, or copy the proof into
`NEXT_PUBLIC_*`, browser code, access logs or an APK. Use HTTPS between hosts.

The BFF forwards only a syntactically valid single IP with a constant-time valid
token. Go additionally requires its direct peer to match the configured CIDRs.
An arbitrary `X-Forwarded-For` is ignored. A wrong or missing proof falls back to
the socket peer. The API refuses partial trust configuration or reuse of the
auth HMAC key as the proxy token. Leave **both** proxy settings empty only for
direct connections or an intentional shared peer bucket. That fallback is safe
against spoofing but does not give each browser a distinct budget. Managed Sites
does not automatically provide this Caddy trust path; connect a separately
verified ingress before enabling its production account traffic.

### Shared authentication budgets and upgrade

Migration `003_auth_rate_limits.sql` is required by `/api/v1/health/ready`.
Re-run the migration job using the owner role and reapply runtime grants before
starting the new API. Login/registration share 20 attempts per client IP per
60-second window; login also consumes 10 attempts per normalized account name.
Atomic PostgreSQL upserts share these budgets across processes and restarts.
The table stores only scope, HMAC-SHA256 digest, counts and times. No plaintext
email/IP is stored in it. A database error denies the attempt with `503`.

All API replicas need the same stable `TROPA_AUTH_RATE_KEY`. Rotation changes
the identity namespace and therefore resets outstanding auth budgets; do it
as a coordinated maintenance action. The key is distinct from database and
ingress credentials. Denied attempts remain committed. Counters expire logically
after 60 seconds and do not extend indefinitely on retries. At most 64 expired
rows are removed per attempt with `SKIP LOCKED`; cleanup is lazy, so idle expired
rows remain until later traffic or scheduled bounded maintenance. The broader
120/minute write guard and four password-hash slots are still process-local;
separate per-user posting budgets remain database-backed. These are abuse limits,
not a complete network DDoS defense.

## Real database integration gate

```bash
./run-integration.sh
```

This requires Docker, Go and OpenSSL. The script creates a uniquely named
temporary test stack, generates a test-only random password, runs the integration
suite against `tropa_test` and removes that temporary stack when it exits. It
does not use or remove the production `postgres-data` volume.

The supplied code was compiled and its ordinary race/unit tests ran in the
authoring environment. Additional serial SQL scenarios and `SET ROLE` grants
can be exercised with [`tools/db-compat`](../tools/db-compat/README.md). That
experimental, single-session PGlite/PostGIS engine does not replace this native
gate: concurrent transactions, two-pool auth limits, network role authentication
and container startup still require a Docker-capable host.

The ordinary Next 16 build, including TypeScript checking and standalone output,
also completed in the authoring environment. This does not constitute a Docker
build or a live web/API/PostGIS integration check.

## Operational launch checks

Configure encrypted backups and an actual restore drill, secret rotation,
monitoring and alert delivery, data retention/deletion, abuse handling and
guide/route review. Keep personal records and backups within the deployment
location required by the legal review. A hosting region selection alone is not
proof of compliance. Check new route restrictions with authoritative sources
and actual guide review; importing a map is not that review.

Container tags are explicit but still mutable. Before a production release,
resolve and record the tested image digests, SBOM and vulnerability scan results.
The separate website and Android artifacts do not configure any live server.
