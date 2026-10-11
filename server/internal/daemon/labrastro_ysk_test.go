package daemon

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/internal/daemon/ysk"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const yskContext = `{"version":1,"issue_identifier":"OL-123","anchor_comment_id":null,"latest_human_comment":"hi","existing_tips":[],"known_topics":[],"light_tip_count":3,"check_every_steps":6,"limits":{"line":40,"title":12,"explanation":200}}`

func yskEnv(t *testing.T) *execenv.Environment {
	t.Helper()
	return &execenv.Environment{MulticaConfigRoot: filepath.Join(t.TempDir(), "multica-config")}
}

func TestPrepareYouShouldKnowLeavesOtherTasksAlone(t *testing.T) {
	withField := Task{ID: "task-1", YouShouldKnow: json.RawMessage(yskContext)}
	for name, tc := range map[string]struct {
		task     Task
		provider string
		version  string
		noEnv    bool
	}{
		"feature off":       {task: Task{ID: "task-1"}, provider: "claude", version: "2.1.292"},
		"not claude":        {task: withField, provider: "codex", version: "2.1.292"},
		"claude too old":    {task: withField, provider: "claude", version: "2.1.267 (Claude Code)"},
		"version unknown":   {task: withField, provider: "claude", version: ""},
		"no task directory": {task: withField, provider: "claude", version: "2.1.292", noEnv: true},
	} {
		t.Run(name, func(t *testing.T) {
			env := yskEnv(t)
			if tc.noEnv {
				env = nil
			}
			agentEnv := map[string]string{"MULTICA_TASK_ID": "task-1"}
			if prepareYouShouldKnow(tc.task, tc.provider, tc.version, env, agentEnv, slog.Default()) {
				t.Fatal("tips mod installed")
			}
			if len(agentEnv) != 1 {
				t.Fatalf("agent env changed: %v", agentEnv)
			}
			if env != nil {
				if _, err := os.Stat(filepath.Join(env.MulticaConfigRoot, "ysk")); !os.IsNotExist(err) {
					t.Fatalf("ysk folder written: %v", err)
				}
			}
		})
	}
}

func TestPrepareYouShouldKnowInstallsForASupportedClaude(t *testing.T) {
	sep := string(os.PathListSeparator)
	t.Setenv(ysk.PluginDirsEnv, "/daemon/plugins")
	for name, tc := range map[string]struct {
		agentEnv   map[string]string
		wantPrefix string
	}{
		"inherits the daemon's plugin folders": {agentEnv: map[string]string{}, wantPrefix: "/daemon/plugins" + sep},
		"keeps the agent's own plugin folders": {agentEnv: map[string]string{ysk.PluginDirsEnv: "/agent/plugins"}, wantPrefix: "/agent/plugins" + sep},
	} {
		t.Run(name, func(t *testing.T) {
			env := yskEnv(t)
			task := Task{ID: "task-1", YouShouldKnow: json.RawMessage(yskContext)}
			if !prepareYouShouldKnow(task, "claude", "2.1.292 (Claude Code)", env, tc.agentEnv, slog.Default()) {
				t.Fatal("tips mod not installed")
			}
			paths := ysk.PathsFor(env.MulticaConfigRoot)
			if got, want := tc.agentEnv[ysk.PluginDirsEnv], tc.wantPrefix+paths.Plugin; got != want {
				t.Fatalf("%s = %q, want %q", ysk.PluginDirsEnv, got, want)
			}
			if tc.agentEnv[ysk.ContextFileEnv] != paths.Context {
				t.Fatalf("%s = %q, want %q", ysk.ContextFileEnv, tc.agentEnv[ysk.ContextFileEnv], paths.Context)
			}
			if data, err := os.ReadFile(paths.Context); err != nil || string(data) != yskContext {
				t.Fatalf("context.json = %q (%v)", data, err)
			}
			if _, err := os.Stat(filepath.Join(paths.Plugin, "hooks", "register.ts")); err != nil {
				t.Fatalf("mod not written: %v", err)
			}
		})
	}
}

func TestPrepareYouShouldKnowSurvivesABadContext(t *testing.T) {
	env := yskEnv(t)
	agentEnv := map[string]string{}
	task := Task{ID: "task-1", YouShouldKnow: json.RawMessage(`[1,2]`)}
	if prepareYouShouldKnow(task, "claude", "2.1.292", env, agentEnv, slog.Default()) {
		t.Fatal("tips mod installed for a malformed context")
	}
	if len(agentEnv) != 0 {
		t.Fatalf("agent env changed: %v", agentEnv)
	}
}

func TestYouShouldKnowReporterPostsTheBatchAsIs(t *testing.T) {
	type request struct {
		method, path, auth string
		body               []byte
	}
	got := make(chan request, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got <- request{method: r.Method, path: r.URL.Path, auth: r.Header.Get("Authorization"), body: body}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	client := NewClient(srv.URL)
	client.SetToken("daemon-token")
	d := &Daemon{client: client}
	batch := json.RawMessage(`{"ysk":1,"kind":"heads_up","tips":[{"tag":"heads_up","line":"l","title":"t","explanation":"e"}],"overturned":[],"step":8}`)
	d.youShouldKnowReporter("task-1", slog.Default())(batch)

	select {
	case req := <-got:
		if req.method != http.MethodPost || req.path != "/api/daemon/tasks/task-1/tips" || req.auth != "Bearer daemon-token" {
			t.Fatalf("request = %s %s (auth %q)", req.method, req.path, req.auth)
		}
		var sent, want any
		if err := json.Unmarshal(req.body, &sent); err != nil {
			t.Fatalf("body %s: %v", req.body, err)
		}
		_ = json.Unmarshal(batch, &want)
		if !jsonEqual(sent, want) {
			t.Fatalf("body = %s, want %s", req.body, batch)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no tips request")
	}
}

func jsonEqual(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return bytes.Equal(left, right)
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestYouShouldKnowReporterOnlyLogsAFailedPost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unknown route", http.StatusNotFound)
	}))
	defer srv.Close()

	var logs syncBuffer
	d := &Daemon{client: NewClient(srv.URL)}
	d.youShouldKnowReporter("task-1", slog.New(slog.NewTextHandler(&logs, nil)))(json.RawMessage(`{"ysk":1,"kind":"light"}`))

	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(logs.String(), "tips report failed") {
		if time.Now().After(deadline) {
			t.Fatalf("no failure logged; logs: %s", logs.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDaemonAdvertisesYouShouldKnow(t *testing.T) {
	for name, capabilities := range map[string]string{
		"websocket": daemonClientCapabilities(),
		"http":      daemonHTTPClientCapabilities(),
	} {
		found := false
		for _, capability := range strings.Split(capabilities, ",") {
			found = found || capability == protocol.DaemonCapabilityYouShouldKnowV1
		}
		if !found {
			t.Errorf("%s capabilities %q do not advertise %s", name, capabilities, protocol.DaemonCapabilityYouShouldKnowV1)
		}
	}
}

func TestClaimDecodesYouShouldKnowAsReceived(t *testing.T) {
	var task Task
	if err := json.Unmarshal([]byte(`{"id":"task-1","you_should_know":`+yskContext+`}`), &task); err != nil {
		t.Fatal(err)
	}
	if string(task.YouShouldKnow) != yskContext {
		t.Fatalf("you_should_know = %s", task.YouShouldKnow)
	}
	var fresh Task
	if err := json.Unmarshal([]byte(`{"id":"task-2"}`), &fresh); err != nil {
		t.Fatal(err)
	}
	if fresh.YouShouldKnow != nil {
		t.Fatalf("absent field decoded as %s", fresh.YouShouldKnow)
	}
}
