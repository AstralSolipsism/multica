package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/envtunnel"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const tunnelDialTimeout = 10 * time.Second
const maxPendingDialsPerRuntime = 4
const environmentProxyCookie = "multica_env_proxy"

type environmentProxy struct {
	base      *url.URL
	wildcard  bool
	dedicated bool
	transport *http.Transport
	mu        sync.Mutex
	pending   map[string]*pendingEnvironmentTunnel
	slots     map[string]*environmentTunnelSlots
}
type pendingEnvironmentTunnel struct {
	runtimeID, key string
	port           int32
	ctx            context.Context
	conn           chan net.Conn
}
type environmentTunnelSlots struct {
	ch   chan struct{}
	refs int
}
type environmentTunnelContextKey struct{}

func newEnvironmentProxy(cfg Config) *environmentProxy {
	raw := strings.TrimSpace(cfg.EnvProxyBaseURL)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" || strings.Count(u.Host, "*") > 1 {
		slog.Error("invalid MULTICA_ENV_PROXY_BASE_URL; environment proxy disabled")
		return nil
	}
	u.Host = strings.ToLower(u.Host)
	wildcard := strings.Contains(u.Host, "*")
	if wildcard && !strings.HasPrefix(u.Host, "*.") && !strings.HasPrefix(u.Host, "env-*.") {
		return nil
	}
	// Without a known API origin, preserve shared-origin routing rules.
	_, publicURLErr := parsePluginSurfaceOrigin(cfg.PublicURL)
	dedicated := publicURLErr == nil && (&Handler{cfg: cfg}).pluginSurfaceOriginIsDedicated(u)
	p := &environmentProxy{base: u, wildcard: wildcard, dedicated: dedicated, pending: make(map[string]*pendingEnvironmentTunnel), slots: make(map[string]*environmentTunnelSlots)}
	p.transport = &http.Transport{
		MaxConnsPerHost: 6, MaxIdleConnsPerHost: 4, MaxIdleConns: 64,
		IdleConnTimeout: 60 * time.Second, ResponseHeaderTimeout: 60 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return p
}

func (h *Handler) resolveIssueEnvironmentURL(row db.IssueEnvironment, original string) string {
	p := h.envProxy
	if p == nil || row.Kind == "app" || original == "" || !row.Port.Valid || row.Port.Int32 <= 0 || row.Port.Int32 > 65535 {
		return original
	}
	source, err := url.Parse(original)
	if err != nil {
		return original
	}
	target := *p.base
	target.Path, target.RawPath, target.RawQuery, target.Fragment = source.Path, source.RawPath, source.RawQuery, source.Fragment
	if target.Path == "" {
		target.Path = "/"
	}
	id := uuidToString(row.ID)
	if p.wildcard {
		label := strings.ReplaceAll(id, "-", "")
		if !strings.HasPrefix(target.Host, "env-*") {
			label = "env-" + label
		}
		target.Host = strings.Replace(target.Host, "*", label, 1)
	} else {
		prefix := "/env/" + id
		target.Path = prefix + target.Path
		if target.RawPath != "" {
			target.RawPath = prefix + target.RawPath
		}
	}
	return target.String()
}

func environmentPath(path string) (id, rest string, ok bool) {
	if !strings.HasPrefix(path, "/env/") {
		return "", "", false
	}
	id, rest, slash := strings.Cut(strings.TrimPrefix(path, "/env/"), "/")
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", "", false
	}
	if slash {
		rest = "/" + rest
	}
	return parsed.String(), rest, true
}

func (p *environmentProxy) hostEnvironment(host string) (string, bool) {
	if !p.wildcard {
		return "", false
	}
	before, after, _ := strings.Cut(p.base.Host, "*")
	host = strings.ToLower(host)
	if !strings.HasPrefix(host, before) || !strings.HasSuffix(host, after) {
		return "", false
	}
	label := strings.TrimSuffix(strings.TrimPrefix(host, before), after)
	if before == "" {
		if !strings.HasPrefix(label, "env-") {
			return "", false
		}
		label = strings.TrimPrefix(label, "env-")
	}
	id, err := uuid.Parse(label)
	if err != nil {
		return "", true
	}
	return id.String(), true
}

func (h *Handler) EnvironmentProxyHostBoundary(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := h.envProxy
		if p == nil {
			next.ServeHTTP(w, r)
			return
		}
		if id, owned := p.hostEnvironment(r.Host); owned {
			if id == "" {
				http.NotFound(w, r)
				return
			}
			h.serveEnvironmentProxy(w, r, id, "")
			return
		}
		if !p.wildcard && strings.EqualFold(r.Host, p.base.Host) {
			if id, rest, ok := environmentPath(r.URL.Path); ok {
				if rest == "" {
					target := *r.URL
					target.Path += "/"
					target.RawPath = ""
					http.Redirect(w, r, target.String(), http.StatusTemporaryRedirect)
					return
				}
				h.serveEnvironmentProxy(w, r, id, strings.TrimSuffix(r.URL.Path, rest))
				return
			}
			if p.dedicated {
				h.EnvironmentProxyFallback(w, r)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func environmentReservedPath(path string) bool {
	for _, prefix := range []string{"/api", "/ws", "/auth", "/v1", "/health", "/readyz", "/healthz", "/plugin-surfaces", "/_next", "/docs", "/metrics"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}

func (p *environmentProxy) sameOrigin(raw, host string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.User == nil && u.Scheme == p.base.Scheme && strings.EqualFold(u.Host, host)
}

func (p *environmentProxy) fallbackEnvironment(r *http.Request) string {
	if ref, err := url.Parse(r.Referer()); err == nil && p.sameOrigin(r.Referer(), r.Host) {
		if id, _, ok := environmentPath(ref.Path); ok {
			return id
		}
	}
	if r.Header.Get("Sec-Fetch-Mode") != "navigate" {
		if c, err := r.Cookie(environmentProxyCookie); err == nil {
			if id, err := uuid.Parse(c.Value); err == nil {
				return id.String()
			}
		}
	}
	return ""
}

func (h *Handler) EnvironmentProxyFallback(w http.ResponseWriter, r *http.Request) {
	p := h.envProxy
	if p != nil && !p.wildcard && strings.EqualFold(r.Host, p.base.Host) && (p.dedicated || !environmentReservedPath(r.URL.Path)) {
		if id := p.fallbackEnvironment(r); id != "" {
			h.serveEnvironmentProxy(w, r, id, "")
			return
		}
	}
	http.NotFound(w, r)
}

func environmentProxyStatus(row db.IssueEnvironment, now time.Time) int {
	if row.Kind == "app" || !row.Port.Valid || row.Port.Int32 < 1 || row.Port.Int32 > 65535 {
		return http.StatusNotFound
	}
	if row.EndedAt.Valid {
		return http.StatusGone
	}
	switch issueEnvironmentToResponse(row, now).State {
	case "stopped", "exited", "failed":
		return http.StatusGone
	case "unreachable":
		return http.StatusServiceUnavailable
	}
	return 0
}

func (h *Handler) serveEnvironmentProxy(w http.ResponseWriter, r *http.Request, id, prefix string) {
	p := h.envProxy
	// Auth's cookie CSRF token belongs to the main app. Environment apps use
	// a same-origin check, including WebSocket handshakes, instead.
	authReq := r.Clone(r.Context())
	authReq.Method = http.MethodGet
	middleware.Auth(h.Queries, h.PATCache, nil, h.CFSigner)(http.HandlerFunc(func(w http.ResponseWriter, authenticated *http.Request) {
		if r.Header.Get("Authorization") == "" && (r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" || websocket.IsWebSocketUpgrade(r)) {
			origin := r.Header.Get("Origin")
			if origin == "" {
				origin = r.Referer()
			}
			if !p.sameOrigin(origin, r.Host) {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
		}
		var row db.IssueEnvironment
		err := h.DB.QueryRow(r.Context(), `SELECT id, workspace_id, issue_id, runtime_id, local_key, kind, port, state, last_seen_at, ended_at FROM issue_environment WHERE id=$1`, id).Scan(
			&row.ID, &row.WorkspaceID, &row.IssueID, &row.RuntimeID, &row.LocalKey, &row.Kind, &row.Port, &row.State, &row.LastSeenAt, &row.EndedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, "failed to load environment", http.StatusInternalServerError)
			return
		}
		wsID := uuidToString(row.WorkspaceID)
		if authenticated.Header.Get("X-Actor-Source") == "task_token" && authenticated.Header.Get("X-Workspace-ID") != wsID {
			http.Error(w, "task token is bound to a different workspace", http.StatusForbidden)
			return
		}
		if _, err := h.getWorkspaceMember(authenticated.Context(), requestUserID(authenticated), wsID); err != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if !h.requireIssueIDVisible(w, authenticated, wsID, row.IssueID, http.StatusForbidden, "forbidden") {
			return
		}
		if status := environmentProxyStatus(row, time.Now()); status != 0 {
			http.Error(w, http.StatusText(status), status)
			return
		}
		if !row.RuntimeID.Valid {
			http.Error(w, "runtime unavailable", http.StatusServiceUnavailable)
			return
		}
		rt, err := h.Queries.GetAgentRuntime(r.Context(), row.RuntimeID)
		if err != nil || rt.Status != "online" {
			http.Error(w, "runtime unavailable", http.StatusServiceUnavailable)
			return
		}
		if prefix != "" {
			http.SetCookie(w, &http.Cookie{Name: environmentProxyCookie, Value: id, Path: "/", MaxAge: 3600, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: p.base.Scheme == "https"})
		}
		w.Header().Del("Content-Security-Policy")
		h.proxyEnvironment(w, r, row, prefix)
	})).ServeHTTP(w, authReq)
}

func stripEnvironmentCredentials(r *http.Request) {
	var cookies []string
	for _, header := range r.Header.Values("Cookie") {
		for _, cookie := range strings.Split(header, ";") {
			cookie = strings.TrimLeft(cookie, " \t")
			if cookie != "" && !isEnvironmentPlatformCookie(cookie) {
				cookies = append(cookies, cookie)
			}
		}
	}
	r.Header.Del("Cookie")
	if len(cookies) != 0 {
		r.Header.Set("Cookie", strings.Join(cookies, "; "))
	}
	for _, name := range []string{"X-User-ID", "X-User-Email", "X-Actor-Source", "X-Agent-ID", "X-Task-ID", "X-CSRF-Token", "X-Workspace-ID"} {
		r.Header.Del(name)
	}
	// Authorization was used by Multica Auth, including JWTs; never pass it on.
	r.Header.Del("Authorization")
}

func isEnvironmentPlatformCookie(cookie string) bool {
	pair, _, _ := strings.Cut(cookie, ";")
	name, value, _ := strings.Cut(pair, "=")
	// Browsers send nameless cookie values as bare request cookie names.
	if strings.TrimSpace(name) == "" {
		name = strings.Trim(strings.TrimSpace(value), "\"")
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), "multica_")
}

func (h *Handler) proxyEnvironment(w http.ResponseWriter, r *http.Request, row db.IssueEnvironment, prefix string) {
	p := h.envProxy
	proxy := &httputil.ReverseProxy{
		Transport: p.transport, FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = uuidToString(row.ID) + "." + uuidToString(row.RuntimeID) + ".env.internal:" + strconv.Itoa(int(row.Port.Int32))
			if prefix != "" {
				pr.Out.URL.Path = strings.TrimPrefix(pr.Out.URL.Path, prefix)
				if pr.Out.URL.RawPath != "" {
					pr.Out.URL.RawPath = strings.TrimPrefix(pr.Out.URL.RawPath, prefix)
				}
			}
			pr.Out.Host = "localhost:" + strconv.Itoa(int(row.Port.Int32))
			pr.SetXForwarded()
			pr.Out.Header.Set("X-Forwarded-Proto", p.base.Scheme)
			stripEnvironmentCredentials(pr.Out)
		},
		ModifyResponse: func(resp *http.Response) error {
			cookies := resp.Header.Values("Set-Cookie")
			resp.Header.Del("Set-Cookie")
			for _, cookie := range cookies {
				if !isEnvironmentPlatformCookie(cookie) {
					resp.Header.Add("Set-Cookie", cookie)
				}
			}
			if !p.wildcard {
				location := resp.Header.Get("Location")
				base := "/env/" + uuidToString(row.ID)
				if strings.HasPrefix(location, "/") && !strings.HasPrefix(location, "//") && location != base && !strings.HasPrefix(location, base+"/") {
					resp.Header.Set("Location", base+location)
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			status := http.StatusBadGateway
			if errors.Is(err, context.DeadlineExceeded) {
				status = http.StatusServiceUnavailable
			}
			http.Error(w, http.StatusText(status), status)
		},
	}
	proxy.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), environmentTunnelContextKey{}, row)))
}

func (p *environmentProxy) take(streamID, runtimeID string) *pendingEnvironmentTunnel {
	p.mu.Lock()
	defer p.mu.Unlock()
	pending := p.pending[streamID]
	if pending == nil || pending.runtimeID != runtimeID {
		return nil
	}
	delete(p.pending, streamID)
	return pending
}

func (h *Handler) dialEnvironmentTunnel(ctx context.Context, network, address string) (net.Conn, error) {
	p := h.envProxy
	row, ok := ctx.Value(environmentTunnelContextKey{}).(db.IssueEnvironment)
	if !ok {
		return nil, fmt.Errorf("missing environment")
	}
	runtimeID := uuidToString(row.RuntimeID)
	ctx, cancel := context.WithTimeout(ctx, tunnelDialTimeout)
	defer cancel()
	p.mu.Lock()
	slots := p.slots[runtimeID]
	if slots == nil {
		slots = &environmentTunnelSlots{ch: make(chan struct{}, maxPendingDialsPerRuntime)}
		p.slots[runtimeID] = slots
	}
	slots.refs++
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		slots.refs--
		if slots.refs == 0 {
			delete(p.slots, runtimeID)
		}
		p.mu.Unlock()
	}()
	select {
	case slots.ch <- struct{}{}:
		defer func() { <-slots.ch }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	streamID := strings.ReplaceAll(uuid.NewString(), "-", "")
	pending := &pendingEnvironmentTunnel{runtimeID: runtimeID, key: row.LocalKey, port: row.Port.Int32, ctx: ctx, conn: make(chan net.Conn)}
	p.mu.Lock()
	p.pending[streamID] = pending
	p.mu.Unlock()
	defer p.take(streamID, runtimeID)
	h.requestDaemonPendingWork(runtimeID, protocol.PendingWorkKindEnvironmentTunnelPrefix+streamID)
	select {
	case conn := <-pending.conn:
		return conn, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (h *Handler) ConnectEnvironmentTunnel(w http.ResponseWriter, r *http.Request) {
	if h.envProxy == nil {
		http.NotFound(w, r)
		return
	}
	rt, ok := h.requireDaemonRuntimeAccess(w, r, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	pending := h.envProxy.take(chi.URLParam(r, "streamId"), uuidToString(rt.ID))
	if pending == nil || pending.ctx.Err() != nil {
		http.NotFound(w, r)
		return
	}
	upgrader := websocket.Upgrader{HandshakeTimeout: tunnelDialTimeout}
	ws, err := upgrader.Upgrade(w, r, http.Header{"X-Env-Tunnel-Key": {pending.key}, "X-Env-Tunnel-Port": {strconv.Itoa(int(pending.port))}})
	if err != nil {
		return
	}
	conn := envtunnel.NewConn(ws)
	select {
	case pending.conn <- conn:
	case <-pending.ctx.Done():
		conn.Close()
	}
}
