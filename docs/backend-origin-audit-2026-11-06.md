# Public browser origin and BFF cookie boundary

Review date: 2026-11-06. Scope: the Next BFF, server configuration and targeted
request/cookie tests. This review does not assert a live Go/PostGIS deployment.

## Defect

The BFF compared browser `Origin` with `req.nextUrl.origin` and chose the session
cookie's `Secure` attribute from `req.nextUrl.protocol`. In the shipped standalone
deployment, Next listens at `0.0.0.0:3000` behind HTTPS Caddy. Next 16.3.4 constructs
its initial request URL from the internal fetch hostname and port when those are
set; its Node request adapter passes this URL to `NextRequest`. A legitimate
browser mutation can therefore have an origin different from `req.nextUrl.origin`.

Primary implementation references:

- [Next 16.3.4 request metadata construction](https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/next-server.ts).
- [Next 16.3.4 Node request adapter](https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/web/spec-extension/adapters/next-request.ts).

## Correction

`PUBLIC_ORIGIN` is the one server-configured canonical browser origin used by
both Go and the BFF. The BFF validates it before contacting a configured API and
compares each mutation's `Origin` to that value. Its session creation and deletion
cookies use the configured HTTPS scheme even when the internal request URL is
HTTP. Neither host/protocol forwarding headers nor the internal listener URL
grant trust.

The value must contain only a canonical HTTPS origin, without a trailing slash,
path, user information, query, fragment or surrounding whitespace. HTTP requires
`NODE_ENV=development` and an explicitly configured `localhost`, `127.0.0.1` or
`[::1]` origin. Production and unspecified modes reject plaintext origins. There
is no request-derived or automatic fallback.

The status endpoint applies the same origin policy before probing Go. It reports
`connected: true` only after both the browser configuration and the existing
database-readiness check pass. Configuration failure returns `reason:
"service_config"`; an unavailable or invalid readiness response returns
`reason: "upstream_unavailable"`. Neither value reveals the configured addresses
or private upstream diagnostics.

The Compose web service now receives `PUBLIC_ORIGIN` at runtime. The current
Sites value is `https://tropa-rf-atlas-2026.wintrybluebell1.chatgpt.site`. This is
ordinary server configuration, not an API deployment or a private-site access
bypass. No authentication secret is embedded in the web bundle or APK.

## Targeted verification

`web/tests/backend-origin.test.mjs` loads and invokes the actual BFF handler,
with framework aliases resolved for Node and the upstream `fetch` replaced by
bounded test responses. The new checks cover:

1. Canonical origins; explicit local-development HTTP; rejection of unsafe values.
2. Public HTTPS browser access through an internal HTTP listener, Secure/HttpOnly
   cookie creation, and removal of the upstream token from browser JSON.
3. Rejection of foreign/missing/null Origin despite supplied forwarding headers.
4. Missing/invalid public configuration failing before GET or POST reaches Go.
5. Unconfigured preview remaining honestly disconnected.
6. Explicit loopback development without a Secure cookie; remote HTTP rejected.
7. Secure cookie deletion on successful logout and uncertain server revocation.
8. The real status handler refusing to advertise a healthy upstream when browser
   origin configuration is missing, then reporting ready with a valid origin.
9. Distinct bounded configuration/upstream failure reasons without private
   addresses or connection errors in the status body.

The nine new checks, four existing forwarding checks and seven readiness checks
passed together: 20 tests, zero failures. The scoped TypeScript check also passed
with exit code 0. These checks do not substitute for a live HTTPS
Caddy → Next → Go → PostGIS test, private Sites
sign-in testing or an Android device run. Native PostgreSQL concurrency, network
database-role authentication, backup restoration and deployment remain separate
gates; no result for them was created by this correction.
