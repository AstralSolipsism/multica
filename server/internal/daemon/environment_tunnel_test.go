package daemon

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/multica-ai/multica/server/internal/daemon/localenv"
	"github.com/multica-ai/multica/server/internal/envtunnel"
)

func TestEnvironmentTunnelWhitelist(t *testing.T) {
	s := &environmentService{detected: []localenv.Environment{
		{Key: "detected:server", Port: 4321}, {Key: "detected:app", Port: 9876, Kind: localenv.KindApp},
	}}
	for _, tc := range []struct {
		key  string
		port int
		want bool
	}{
		{"detected:server", 4321, true}, {"detected:server", 4322, false}, {"unknown", 4321, false}, {"detected:app", 9876, false}, {"detected:server", 0, false},
	} {
		if got := s.allowsTunnelPort(tc.key, tc.port); got != tc.want {
			t.Errorf("%+v got %v", tc, got)
		}
	}
	var empty *environmentService
	if empty.allowsTunnelPort("x", 80) {
		t.Fatal("nil service allowed port")
	}
}

func TestEnvironmentTunnelForwardAndReject(t *testing.T) {
	for _, allowed := range []bool{true, false} {
		t.Run(strconv.FormatBool(allowed), func(t *testing.T) {
			local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("local response")) }))
			defer local.Close()
			_, portText, _ := net.SplitHostPort(strings.TrimPrefix(local.URL, "http://"))
			port, _ := strconv.Atoi(portText)
			result := make(chan error, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-token" {
					http.Error(w, "auth", 401)
					return
				}
				ws, err := (&websocket.Upgrader{}).Upgrade(w, r, http.Header{"X-Env-Tunnel-Key": {"detected:test"}, "X-Env-Tunnel-Port": {portText}})
				if err != nil {
					result <- err
					return
				}
				conn := envtunnel.NewConn(ws)
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(2 * time.Second))
				_, err = io.WriteString(conn, "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
				if err == nil {
					var b []byte
					b, err = io.ReadAll(conn)
					if strings.Contains(string(b), "local response") {
						err = nil
					}
				}
				result <- err
			}))
			defer server.Close()
			s := &environmentService{}
			if allowed {
				s.detected = []localenv.Environment{{Key: "detected:test", Port: port}}
			}
			client := NewClient(server.URL)
			client.SetToken("test-token")
			d := &Daemon{client: client, environments: s}
			d.openEnvironmentTunnel(context.Background(), uuid.NewString(), uuid.NewString())
			err := <-result
			if allowed && err != nil {
				t.Fatal(err)
			}
			if !allowed && err == nil {
				t.Fatal("unregistered port was forwarded")
			}
		})
	}
}

func TestEnvironmentTunnelDeclaredWhitelist(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("local environments require Unix")
	}
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".multica"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".multica/environments.toml"), []byte("[environments.web]\nstart='exec sleep 30'\nurl=''\n"), 0600); err != nil {
		t.Fatal(err)
	}
	manager := localenv.NewManager(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	task := localenv.Task{TaskID: "task", IssueID: "issue", WorkspaceID: "workspace", RootDir: root}
	env, err := manager.Start(task, root, "web", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.Stop(task, "web") })
	s := &environmentService{manager: manager}
	if !s.allowsTunnelPort(env.Key, env.Port) || s.allowsTunnelPort(env.Key, env.Port+1) {
		t.Fatal("declared environment not bound to exact port")
	}
	if _, err := manager.Stop(task, "web"); err != nil {
		t.Fatal(err)
	}
	if s.allowsTunnelPort(env.Key, env.Port) {
		t.Fatal("stopped environment allowed")
	}
}
