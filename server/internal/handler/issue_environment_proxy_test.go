package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/envtunnel"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func proxyTestHandler(t *testing.T, base string) *Handler {
	t.Helper()
	p := newEnvironmentProxy(Config{EnvProxyBaseURL: base, PublicURL: "https://main.example"})
	h := &Handler{Queries: testHandler.Queries, DB: testPool, envProxy: p}
	if p != nil {
		p.transport.DialContext = h.dialEnvironmentTunnel
		t.Cleanup(p.transport.CloseIdleConnections)
	}
	return h
}

func TestEnvironmentProxyURLAndRoutes(t *testing.T) {
	id := uuid.NewString()
	row := db.IssueEnvironment{ID: parseUUID(id), Port: pgtype.Int4{Int32: 41000, Valid: true}}
	for _, tc := range []struct{ base, want string }{
		{"", "http://localhost:41000/docs?q=1"},
		{"https://*.example.com", "https://env-" + strings.ReplaceAll(id, "-", "") + ".example.com/docs?q=1"},
		{"https://env-*.example.com:8080", "https://env-" + strings.ReplaceAll(id, "-", "") + ".example.com:8080/docs?q=1"},
		{"https://preview.example.com", "https://preview.example.com/env/" + id + "/docs?q=1"},
	} {
		h := proxyTestHandler(t, tc.base)
		if got := h.resolveIssueEnvironmentURL(row, "http://localhost:41000/docs?q=1"); got != tc.want {
			t.Fatalf("url=%s want %s", got, tc.want)
		}
		row.Kind = "app"
		if got := h.resolveIssueEnvironmentURL(row, "app-url"); got != "app-url" {
			t.Fatal(got)
		}
		row.Kind = "server"
		if h.envProxy != nil && h.envProxy.wildcard {
			host := strings.Split(strings.TrimPrefix(tc.want, "https://"), "/")[0]
			got, owned := h.envProxy.hostEnvironment(host)
			if got != id || !owned {
				t.Fatalf("route=%s %v", got, owned)
			}
			got, owned = h.envProxy.hostEnvironment(strings.Replace(host, strings.ReplaceAll(id, "-", ""), id, 1))
			if got != id || !owned {
				t.Fatal("canonical UUID rejected")
			}
			if _, owned = h.envProxy.hostEnvironment("evil.example.net"); owned {
				t.Fatal("foreign host matched")
			}
		}
	}
	for _, raw := range []string{"ftp://example.com", "https://user:pw@example.com", "https://example.com/sub", "https://*.*.com", "https://example.com?q=1"} {
		if p := newEnvironmentProxy(Config{EnvProxyBaseURL: raw}); p != nil {
			t.Fatalf("invalid base accepted: %s", raw)
		}
	}
	h := proxyTestHandler(t, "https://main.example")
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	req := httptest.NewRequest("GET", "https://main.example/env/"+id+"?q=1", nil)
	rec := httptest.NewRecorder()
	h.EnvironmentProxyHostBoundary(next).ServeHTTP(rec, req)
	if rec.Code != 307 || rec.Header().Get("Location") != "https://main.example/env/"+id+"/?q=1" {
		t.Fatalf("redirect=%d %s", rec.Code, rec.Header().Get("Location"))
	}
	for _, path := range []string{"/api/unknown", "/ws", "/auth/callback", "/_next/x", "/docs/a", "/metrics"} {
		if !environmentReservedPath(path) {
			t.Fatal(path)
		}
		req := httptest.NewRequest("GET", "https://main.example"+path, nil)
		req.AddCookie(&http.Cookie{Name: environmentProxyCookie, Value: id})
		rec := httptest.NewRecorder()
		h.EnvironmentProxyFallback(rec, req)
		if rec.Code != 404 {
			t.Fatalf("main route intercepted: %s %d", path, rec.Code)
		}
	}
}

func TestEnvironmentProxySharedOriginRoutes(t *testing.T) {
	for _, tc := range []struct {
		name, base, public, app string
		ancestors               []string
		dedicated               bool
	}{
		{name: "unknown API localhost", base: "http://localhost:8080", app: "http://localhost:3000"},
		{name: "unknown API IP", base: "http://192.168.1.100:8080", app: "https://app.example"},
		{name: "unknown API domain", base: "https://api.example", app: "https://app.example"},
		{name: "hostless API", public: "/api", app: "https://app.example"},
		{name: "invalid API", public: "https://[", app: "https://app.example"},
		{name: "shared API", public: "https://API.EXAMPLE", app: "https://app.example"},
		{name: "shared app", public: "https://other.example", app: "https://api.example"},
		{name: "shared ancestor", public: "https://other.example", app: "https://app.example", ancestors: []string{"https://API.EXAMPLE"}},
		{name: "dedicated preview", public: "https://other.example", app: "https://app.example", ancestors: []string{"https://desktop.example"}, dedicated: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := tc.base
			if base == "" {
				base = "https://api.example"
			}
			h := &Handler{envProxy: newEnvironmentProxy(Config{
				EnvProxyBaseURL: base, PublicURL: tc.public, AppURL: tc.app, AttachmentFrameAncestors: tc.ancestors,
			})}
			t.Cleanup(h.envProxy.transport.CloseIdleConnections)
			id := uuid.NewString()
			router := chi.NewRouter()
			router.Use(h.EnvironmentProxyHostBoundary)
			paths := []string{"/health", "/ws", "/api/issues", "/api/daemon/runtimes/runtime/environment-tunnel/stream"}
			for _, path := range paths {
				router.Get(path, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
			}
			router.NotFound(h.EnvironmentProxyFallback)
			for _, cookie := range []bool{false, true} {
				for _, path := range append(paths, "/api/unknown", "/env/"+id+"/", "/style.css") {
					req := httptest.NewRequest("GET", base+path, nil)
					req.Header.Set("Sec-Fetch-Mode", "cors")
					if cookie {
						req.AddCookie(&http.Cookie{Name: environmentProxyCookie, Value: id})
					}
					want := http.StatusNoContent
					if path == "/api/unknown" || path == "/style.css" || tc.dedicated {
						want = http.StatusNotFound
					}
					if strings.HasPrefix(path, "/env/") || cookie && (path == "/style.css" || tc.dedicated) {
						want = http.StatusUnauthorized
					}
					rec := httptest.NewRecorder()
					router.ServeHTTP(rec, req)
					if rec.Code != want {
						t.Errorf("%s cookie=%v: status=%d want %d", path, cookie, rec.Code, want)
					}
				}
			}
		})
	}
}

func TestEnvironmentProxyFallbackContext(t *testing.T) {
	p := newEnvironmentProxy(Config{EnvProxyBaseURL: "https://preview.example"})
	a, b := uuid.NewString(), uuid.NewString()
	for _, tc := range []struct{ ref, mode, want string }{
		{"https://preview.example/env/" + a + "/", "navigate", a},
		{"https://evil.example/env/" + a + "/", "cors", b},
		{"", "navigate", ""}, {"", "cors", b},
	} {
		req := httptest.NewRequest("GET", "https://preview.example/style.css", nil)
		req.Header.Set("Referer", tc.ref)
		req.Header.Set("Sec-Fetch-Mode", tc.mode)
		req.AddCookie(&http.Cookie{Name: environmentProxyCookie, Value: b})
		if got := p.fallbackEnvironment(req); got != tc.want {
			t.Fatalf("%+v got %s", tc, got)
		}
	}
}

func proxyToken(t *testing.T, user string) string {
	t.Helper()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": user, "exp": time.Now().Add(auth.AuthTokenTTL()).Unix()}).SignedString(auth.JWTSecret())
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func proxyFixture(t *testing.T) (id, runtimeID, issueID string) {
	t.Helper()
	issueID, taskID := issueEnvironmentFixture(t)
	reportEnvironments(t, taskID, webEnvironment("running")).Want(200)
	dbfx.QueryRow(t, `SELECT id,runtime_id FROM issue_environment WHERE task_id=$1`, taskID).Scan(&id, &runtimeID)
	return
}

func TestEnvironmentProxyAuthorizationAndState(t *testing.T) {
	id, rt, issue := proxyFixture(t)
	h := proxyTestHandler(t, "https://preview.example")
	outsider := dbfx.User(t, "outside", "env-outside-"+uuid.NewString()+"@example.com")
	project := newPrivateProjectFixture(t)
	memberToken := proxyToken(t, testUserID)
	serve := func(token, method, origin string) int {
		req := httptest.NewRequest(method, "https://preview.example/env/"+id+"/", nil)
		if token != "" {
			req.AddCookie(&http.Cookie{Name: auth.AuthCookieName, Value: token})
		}
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		h.EnvironmentProxyHostBoundary(http.NotFoundHandler()).ServeHTTP(rec, req)
		return rec.Code
	}
	if got := serve("", "GET", ""); got != 401 {
		t.Fatal(got)
	}
	if got := serve(proxyToken(t, outsider), "GET", ""); got != 403 {
		t.Fatal(got)
	}
	if got := serve(memberToken, "POST", "https://evil.example"); got != 403 {
		t.Fatal(got)
	}
	if got := serve(memberToken, "POST", ""); got != 403 {
		t.Fatal(got)
	}
	dbfx.Exec(t, `UPDATE issue SET project_id=$1 WHERE id=$2`, project.projectID, issue)
	if got := serve(proxyToken(t, project.outsider), "GET", ""); got != 403 {
		t.Fatalf("private project=%d", got)
	}
	dbfx.Exec(t, `UPDATE issue SET project_id=NULL WHERE id=$1`, issue)
	for _, state := range []string{"stopped", "exited"} {
		dbfx.Exec(t, `UPDATE issue_environment SET state=$1 WHERE id=$2`, state, id)
		if got := serve(memberToken, "GET", ""); got != 410 {
			t.Fatalf("%s=%d", state, got)
		}
	}
	dbfx.Exec(t, `UPDATE issue_environment SET state='running',last_seen_at=now()-interval '10 minutes' WHERE id=$1`, id)
	if got := serve(memberToken, "GET", ""); got != 503 {
		t.Fatalf("stale=%d", got)
	}
	dbfx.Exec(t, `UPDATE issue_environment SET last_seen_at=now(),kind='app' WHERE id=$1`, id)
	if got := serve(memberToken, "GET", ""); got != 404 {
		t.Fatal(got)
	}
	dbfx.Exec(t, `UPDATE issue_environment SET kind='server',port=NULL WHERE id=$1`, id)
	if got := serve(memberToken, "GET", ""); got != 404 {
		t.Fatal(got)
	}
	dbfx.Exec(t, `UPDATE issue_environment SET port=41000 WHERE id=$1`, id)
	dbfx.Exec(t, `UPDATE agent_runtime SET status='offline' WHERE id=$1`, rt)
	if got := serve(memberToken, "GET", ""); got != 503 {
		t.Fatal(got)
	}
	dbfx.Exec(t, `DELETE FROM issue_environment WHERE id=$1`, id)
	if got := serve(memberToken, "GET", ""); got != 404 {
		t.Fatal(got)
	}
}

type environmentNotifierFunc func(string, string)

func (f environmentNotifierFunc) NotifyPendingWork(runtimeID, kind string) { f(runtimeID, kind) }

func TestEnvironmentProxyTunnelHTTPAndWebSocket(t *testing.T) {
	id, rt, _ := proxyFixture(t)
	token := proxyToken(t, testUserID)
	requests := make(chan *http.Request, 20)
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Clone(r.Context())
		if r.URL.Path == "/socket" {
			ws, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			kind, b, err := ws.ReadMessage()
			if err == nil {
				ws.WriteMessage(kind, b)
			}
			return
		}
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/next?q=1", 302)
			return
		}
		if r.URL.Path == "/stream" {
			w.Write([]byte("first\n"))
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"path": r.URL.RequestURI(), "host": r.Host, "cookie": r.Header.Get("Cookie"), "auth": r.Header.Get("Authorization"), "forwarded": r.Header.Get("X-Forwarded-Host"), "proto": r.Header.Get("X-Forwarded-Proto"), "identity": r.Header.Get("X-User-ID")})
	}))
	defer local.Close()
	h := &Handler{Queries: testHandler.Queries, DB: testPool, envProxy: newEnvironmentProxy(Config{
		EnvProxyBaseURL: "http://preview.example", AppURL: "http://app.example",
	})}
	h.envProxy.transport.DialContext = h.dialEnvironmentTunnel
	router := chi.NewRouter()
	router.Use(h.EnvironmentProxyHostBoundary)
	router.With(middleware.DaemonAuth(h.Queries, nil, nil, nil)).Get("/api/daemon/runtimes/{runtimeId}/environment-tunnel/{streamId}", h.ConnectEnvironmentTunnel)
	router.NotFound(h.EnvironmentProxyFallback)
	server := httptest.NewServer(router)
	defer server.Close()
	var opened atomic.Int32
	var peers sync.WaitGroup
	h.DaemonPendingWork = environmentNotifierFunc(func(runtime, kind string) {
		peers.Add(1)
		go func() {
			defer peers.Done()
			ws, resp, err := websocket.DefaultDialer.Dial(strings.Replace(server.URL, "http://", "ws://", 1)+"/api/daemon/runtimes/"+runtime+"/environment-tunnel/"+strings.TrimPrefix(kind, protocol.PendingWorkKindEnvironmentTunnelPrefix), http.Header{"Host": {"preview.example"}, "Authorization": {"Bearer " + token}})
			if err != nil {
				return
			}
			opened.Add(1)
			conn := envtunnel.NewConn(ws)
			defer conn.Close()
			if resp.Header.Get("X-Env-Tunnel-Key") != "config:web" || resp.Header.Get("X-Env-Tunnel-Port") != "41000" {
				t.Error("tunnel handshake did not identify the registered environment")
				return
			}
			tcp, err := net.Dial("tcp", strings.TrimPrefix(local.URL, "http://"))
			if err != nil {
				return
			}
			defer tcp.Close()
			done := make(chan struct{})
			go func() { io.Copy(tcp, conn); tcp.Close(); close(done) }()
			io.Copy(conn, tcp)
			conn.Close()
			<-done
		}()
	})
	defer func() { h.envProxy.transport.CloseIdleConnections(); peers.Wait() }()
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	fetch := func(path string) *http.Response {
		req, _ := http.NewRequest("GET", server.URL+path, nil)
		req.Host = "preview.example"
		req.Header.Set("Cookie", "multica_auth="+token+"; multica_csrf=x; multica_csrf_session=y; multica_env_proxy="+id+"; app=kept")
		req.Header.Set("X-User-ID", "forged")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	for i := 0; i < 3; i++ {
		resp := fetch("/env/" + id + "/docs?q=1")
		var got map[string]string
		json.NewDecoder(resp.Body).Decode(&got)
		resp.Body.Close()
		if resp.StatusCode != 200 || got["path"] != "/docs?q=1" || got["host"] != "localhost:41000" || got["cookie"] != "app=kept" || got["auth"] != "" || got["identity"] != "" || got["forwarded"] != "preview.example" || got["proto"] != "http" {
			t.Fatalf("status %d output %+v", resp.StatusCode, got)
		}
		found := false
		for _, cookie := range resp.Cookies() {
			if cookie.Name == environmentProxyCookie && cookie.HttpOnly {
				found = true
			}
		}
		if !found {
			t.Fatal("routing cookie missing")
		}
	}
	if opened.Load() != 1 {
		t.Fatalf("keepalive opened %d tunnels", opened.Load())
	}
	resp := fetch("/env/" + id + "/redirect")
	resp.Body.Close()
	if got := resp.Header.Get("Location"); got != "/env/"+id+"/next?q=1" {
		t.Fatal(got)
	}
	resp = fetch("/env/" + id + "/stream")
	b := make([]byte, 6)
	_, err := io.ReadFull(resp.Body, b)
	resp.Body.Close()
	if err != nil || string(b) != "first\n" {
		t.Fatalf("stream=%q %v", b, err)
	}
	header := http.Header{"Host": {"preview.example"}, "Cookie": {"multica_auth=" + token}, "Origin": {"http://preview.example"}}
	ws, _, err := websocket.DefaultDialer.Dial(strings.Replace(server.URL, "http://", "ws://", 1)+"/env/"+id+"/socket", header)
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	ws.WriteMessage(websocket.TextMessage, []byte("hmr"))
	_, data, err := ws.ReadMessage()
	ws.Close()
	if err != nil || string(data) != "hmr" {
		t.Fatalf("websocket=%q %v", data, err)
	}
	h.envProxy.transport.CloseIdleConnections()
	peers.Wait()
	local.Close()
	resp = fetch("/env/" + id + "/")
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("refused local port = %d", resp.StatusCode)
	}
	// Stream IDs are consumed once, and bound to their runtime.
	pending := &pendingEnvironmentTunnel{runtimeID: rt}
	h.envProxy.pending["once"] = pending
	if h.envProxy.take("once", uuid.NewString()) != nil || h.envProxy.take("once", rt) != pending || h.envProxy.take("once", rt) != nil {
		t.Fatal("replay/runtime binding failed")
	}
}

func TestEnvironmentProxyPendingDialLimitAndCancellation(t *testing.T) {
	h := proxyTestHandler(t, "http://preview.example")
	runtime := parseUUID(uuid.NewString())
	row := db.IssueEnvironment{RuntimeID: runtime}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), environmentTunnelContextKey{}, row))
	notified := make(chan struct{}, 10)
	h.DaemonPendingWork = environmentNotifierFunc(func(string, string) { notified <- struct{}{} })
	errs := make(chan error, 10)
	for i := 0; i < 10; i++ {
		go func() { _, err := h.dialEnvironmentTunnel(ctx, "tcp", ""); errs <- err }()
	}
	for i := 0; i < 4; i++ {
		select {
		case <-notified:
		case <-time.After(time.Second):
			t.Fatal("missing dial")
		}
	}
	select {
	case <-notified:
		t.Fatal("more than four outstanding handshakes")
	default:
	}
	cancel()
	for i := 0; i < 10; i++ {
		if err := <-errs; !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	}
	if len(h.envProxy.pending) != 0 || len(h.envProxy.slots) != 0 {
		t.Fatal("cancel leaked broker entries")
	}
}

func TestEnvironmentProxyFailedState(t *testing.T) {
	row := db.IssueEnvironment{State: "failed", Port: pgtype.Int4{Int32: 80, Valid: true}}
	if got := environmentProxyStatus(row, time.Now()); got != 410 {
		t.Fatal(got)
	}
}

func TestEnvironmentProxyHandshakeTimeout(t *testing.T) {
	id, _, _ := proxyFixture(t)
	h := proxyTestHandler(t, "http://preview.example")
	req := httptest.NewRequest("GET", "http://preview.example/env/"+id+"/", nil)
	req.Header.Set("Authorization", "Bearer "+proxyToken(t, testUserID))
	rec := httptest.NewRecorder()
	h.EnvironmentProxyHostBoundary(http.NotFoundHandler()).ServeHTTP(rec, req)
	if rec.Code != 503 || len(h.envProxy.pending) != 0 || len(h.envProxy.slots) != 0 {
		t.Fatalf("timeout status=%d pending=%d slots=%d", rec.Code, len(h.envProxy.pending), len(h.envProxy.slots))
	}
}

func TestEnvironmentProxyDaemonOwnership(t *testing.T) {
	_, rt, _ := proxyFixture(t)
	h := proxyTestHandler(t, "http://preview.example")
	pending := &pendingEnvironmentTunnel{runtimeID: rt, ctx: context.Background()}
	h.envProxy.pending["secret"] = pending
	foreign := createPlainMember(t, "env-foreign-"+uuid.NewString()+"@example.com")
	req := withURLParam(newRequestAs(foreign, "GET", "/", nil), "runtimeId", rt)
	chi.RouteContext(req.Context()).URLParams.Add("streamId", "secret")
	rec := httptest.NewRecorder()
	h.ConnectEnvironmentTunnel(rec, req)
	if rec.Code != 404 || h.envProxy.pending["secret"] != pending {
		t.Fatal("foreign owner consumed pending stream")
	}
	req = withURLParam(newOwnerDaemonRequest("GET", "/", nil), "runtimeId", rt)
	chi.RouteContext(req.Context()).URLParams.Add("streamId", "missing")
	rec = httptest.NewRecorder()
	h.ConnectEnvironmentTunnel(rec, req)
	if rec.Code != 404 {
		t.Fatal(rec.Code)
	}
}

func TestEnvironmentProxyResponseDoesNotPersistURL(t *testing.T) {
	issue, task := issueEnvironmentFixture(t)
	reportEnvironments(t, task, webEnvironment("running"), map[string]any{"key": "detected:test", "source": "detected", "name": "detected", "url": "http://localhost:5173/docs?q=1", "port": 5173, "state": "running"}).Want(200)
	before := testHandler.envProxy
	testHandler.envProxy = newEnvironmentProxy(Config{EnvProxyBaseURL: "https://preview.example"})
	t.Cleanup(func() { testHandler.envProxy = before })
	for _, env := range listEnvironments(t, issue) {
		if !strings.HasPrefix(env.URL, "https://preview.example/env/"+env.ID+"/") {
			t.Fatal(env.URL)
		}
	}
	testHandler.envProxy = nil
	for _, env := range listEnvironments(t, issue) {
		if !strings.HasPrefix(env.URL, "http://localhost:") {
			t.Fatal("proxy URL persisted", env.URL)
		}
	}
}
