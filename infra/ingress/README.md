# Local HTTP ingress

The `ingress` service is the bridge between host Caddy and the internal
application network. Docker does not provide a default gateway for a container
attached only to internal networks, and port publication uses that gateway
network. The previous internal-only API/web placement therefore could declare
host bindings without making those bindings active. The ingress alone joins
the ordinary `frontend` bridge; API and Next keep internal-only attachments in
the base deployment. The database stays on its separate internal `backend`
network. An explicit mail overlay is the only addition of API egress.

Host Caddy sends native API traffic to `127.0.0.1:8080`; the sidecar forwards it
to `api:8080`. With `compose.web.yaml`, host Caddy also sends website traffic to
`127.0.0.1:3000`; the sidecar forwards it to `web:3000`. API, migration, database
and Next containers publish no direct host ports. The web overlay retains the
API dependency and waits for Next's connected `/api/status` result.

## Trust and process policy

Host Caddy is the only TLS endpoint and author of `X-Real-IP` and
`X-Tropa-Proxy-Token`. The sidecar has fixed upstreams, preserves those headers
and the original Host/Origin, and is not given proxy, authentication, database,
mail or safety keys. Go still validates the direct ingress/Next peer and the
shared proof; configure its trusted peers from the actual `application` network.
Default Caddy rewriting of `X-Forwarded-*` does not establish application identity.

The sidecar disables automatic HTTPS, the admin API and configuration persistence.
It has no certificate configuration or ACME operation. All HTTP-module logs are
excluded so that forwarded proofs and private URLs do not enter proxy error
logs; ordinary non-HTTP lifecycle messages remain. No access-log directive is
enabled. The bootstrap gate adapts the mounted configuration and requires exactly
the fixed HTTP routes, including these global settings.

The official image runs as `65532:65532`, with a read-only root,
`no-new-privileges`, all capabilities dropped, read-only configuration mounts and
a small writable `/tmp` tmpfs. Config/data locations point into that tmpfs. The
API readiness check is made through the proxy with the image's actual `curl`.
No derived proxy image or extra executable is added to the production image.

## Image provenance

`provenance.json` pins the official `caddy:2.11.9-alpine` image by multi-platform
index digest, with an explicit `linux/amd64` platform and the reviewed manifest
and configuration digests. The official image definition was selected from the
[Docker Official Images Caddy entry](https://github.com/docker-library/official-images/blob/master/library/caddy)
and its [recorded Dockerfile commit](https://github.com/caddyserver/caddy-docker/blob/d322e6686bbce5622d98a04c84fadd43b5eb8c58/2.11/alpine/Dockerfile).
The [Caddy v2.11.9 release](https://github.com/caddyserver/caddy/releases/tag/v2.11.9)
is the source of its binary.

On 2026-11-13 the Docker Hub tag metadata and raw registry index/amd64 manifests
were compared, including SHA-256 against each requested digest and
`Docker-Content-Digest`. The dependency layer was downloaded by its recorded
digest, its SHA-256 verified, and `/usr/bin/curl` confirmed as a regular executable
in that exact layer. The official Linux amd64 release archive was verified
against the SHA-512 in the image's Dockerfile; its extracted Caddy binary
successfully adapted and validated both the base and optional web configuration
with the same mounted-file layout. These are source/parser checks, not evidence
that the Docker image started.

## Qualification boundary

The actual bootstrap gate pulls the pinned image, checks its image ID/platform
and version, then starts the unmodified production topology with disposable
database credentials and keys. Success requires real host → ingress → API
readiness/liveness using `{"data":{"status":"ready"},"meta":{"mode":"production"}}`
and the corresponding `ok` liveness response. The gate checks active loopback
publication, absence of direct API/database ports, actual isolated memberships,
kernel-enforced process restrictions, migrations and runtime grants, followed
by complete fixture teardown. A receipt is emitted only after all pass.

The four base/web/mail Compose combinations also receive real `compose config`
checks and regression tests. The optional web configuration is parsed locally,
but the bootstrap gate does not build or start Next. A local proxy transport
check with synthetic HTTP fixtures can establish forwarding behavior only; it
cannot establish Docker port publication, Next startup or a deployed browser
flow. Those checks remain separate. The new ingress Docker runtime receipt is
pending until the authorized CI run completes.

Primary behavior references: Docker's
[Compose networking guide](https://docs.docker.com/compose/how-tos/networking/),
the [Moby internal-network port-publication discussion](https://github.com/moby/moby/discussions/53256),
Caddy's [global options](https://caddyserver.com/docs/caddyfile/options) and
[reverse-proxy header behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers).
