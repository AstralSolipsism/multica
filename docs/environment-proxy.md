# Remote issue environments

Remote access is opt-in. With neither setting below configured, environment
links keep their existing localhost behavior. No database migration is needed;
the server derives proxy links when listing environments and keeps the daemon's
original URL in storage. Both declared and detected servers are supported.

## Server proxy

Set `MULTICA_ENV_PROXY_BASE_URL` to an HTTP(S) origin routed to the Go API server.
The daemon needs outbound WebSocket access to that server; the runtime needs no
inbound public port. Upgrade both server and daemon before enabling this option.

- `https://*.env.example.com` (or `https://env-*.env.example.com`) gives each
  environment its own root path. Route the wildcard DNS name to the API and
  configure wildcard TLS at the ingress. Links use the environment's full UUID,
  without hyphens. Applications can use root assets, `/api`, and WebSockets.
- `https://preview.example.com` gives links like `/env/<uuid>/`. It needs one
  DNS record. A bare IP origin or the API's existing origin also works. The
  initial path sets an HttpOnly routing cookie, with same-origin Referer taking
  precedence for later root resources. Relative redirects retain the prefix.

The base URL must be an origin, without credentials, query, fragment or path.
Invalid configuration disables the proxy and logs an error. Preserve Host and
WebSocket Upgrade at the ingress. This does not add Next.js rewrites: if using
an existing frontend origin, the ingress must route `/env/*` and environment
resources to the Go API. A dedicated preview origin avoids that ambiguity.

The current tunnel rendezvous is in memory. Route preview requests and daemon
callbacks to the same API instance; Redis distributes the wakeup hint, not the
TCP stream. Deploy with one API instance for this feature unless the ingress
provides that affinity.

### Browser session and route boundaries

`server/internal/auth/cookie.go` sets `multica_auth` with `HttpOnly`,
`SameSite=Strict`, `Path=/`, and the configured `COOKIE_DOMAIN`. `Secure` follows
`FRONTEND_ORIGIN`. For wildcard or separate preview subdomains, configure a
shared parent domain such as `.example.com` and use the same scheme as the app.
An unrelated preview domain cannot receive the app session cookie. An empty
`COOKIE_DOMAIN` keeps cookies host-only; an IP value is ignored. Sign in again
after changing the cookie domain.

Every proxy request checks the existing login, workspace membership and private
project visibility. Cookie-authenticated writes and WebSocket upgrades require
a same-origin Origin/Referer. Multica identity headers, authorization and session
cookies are removed before forwarding; application cookies are preserved.
Upstream `Set-Cookie` headers for the platform's `multica_*` namespace are
discarded so an environment cannot overwrite login, CSRF or routing cookies.
Application `Set-Cookie` headers and their attributes are passed through unchanged.
The local service receives `Host: localhost:<port>` and the public host/scheme
in `X-Forwarded-Host` and `X-Forwarded-Proto`.

When sharing the API origin, registered API routes and reserved prefixes
(`/api`, `/ws`, `/auth`, `/v1`, `/health`, `/readyz`, `/healthz`,
`/plugin-surfaces`, `/_next`, `/docs`, `/metrics`) stay with Multica. An app that
needs these root routes should use a dedicated preview origin or wildcard mode.
Single-address mode treats the origin as dedicated only when `MULTICA_PUBLIC_URL`
is a valid API origin and the preview host differs from it, `MULTICA_APP_URL`,
and the configured attachment frame ancestors. When the API origin is unknown,
shared-origin routing rules apply, including the reserved prefixes above.
The routing cookie alone never redirects a top-level navigation into an
application. Multiple tabs without an environment Referer share the latest
routing cookie; wildcard mode keeps each environment independent.

### Lifecycle

Connections open on demand, with at most four pending handshakes per runtime.
HTTP connections are reused per environment and released after 60 seconds idle;
stream reads/writes time out after five minutes idle. Handshakes time out after
10 seconds. The daemon accepts only registered, active local environment keys
and their exact ports, and always connects to `127.0.0.1`.

Missing environments and desktop apps return 404, ended environments 410,
unreachable/offline environments or unanswered handshakes 503, and a refused
local connection 502. Unauthenticated requests return 401; unauthorized members
or origins return 403. Environment applications are executable workspace code;
only enable access for trusted workspaces, especially when sharing an app origin.

## Direct LAN or VPN access

Set `MULTICA_ENV_PUBLIC_HOST` on the daemon to a hostname or IP reachable by
members, for example `dev-machine.internal` or `192.168.10.20`. This replaces
`localhost` in declared URLs and the host in detected URLs. IPv6 is bracketed in
URLs. Existing explicit custom URL hosts are preserved.

Declared URLs also accept `$MULTICA_HOST` / `${MULTICA_HOST}`, defaulting to
`localhost`; start/stop commands receive `MULTICA_HOST` alongside `MULTICA_PORT`.
Implicit readiness checks stay on `127.0.0.1` when the URL uses localhost or the
host placeholder. An explicit `ready` continues to use its configured address.
Direct host links do not create a tunnel or change how the application binds its
listening interface. Server proxy configuration takes precedence in sidebar URLs.
