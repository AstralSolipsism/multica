package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/ysk"
)

func TestYouShouldKnowStatusDecoding(t *testing.T) {
	for _, tc := range []struct {
		name, body                string
		present, enabled, wantErr bool
	}{
		{"old server", `{"status":"running"}`, false, false, false},
		{"null", `{"status":"running","you_should_know_enabled":null}`, false, false, false},
		{"on", `{"status":"running","you_should_know_enabled":true}`, true, true, false},
		{"off", `{"status":"running","you_should_know_enabled":false}`, true, false, false},
		{"invalid type", `{"status":"running","you_should_know_enabled":"false"}`, false, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, tc.body)
			}))
			defer srv.Close()
			status, err := NewClient(srv.URL).GetTaskStatus(context.Background(), "task-1")
			if (err != nil) != tc.wantErr {
				t.Fatalf("error = %v, want error=%v", err, tc.wantErr)
			}
			if tc.wantErr {
				if shouldInterruptAgent(status.Status, err) {
					t.Fatal("a malformed response interrupted the main agent")
				}
				return
			}
			if status.Status != "running" || (status.YouShouldKnowEnabled != nil) != tc.present {
				t.Fatalf("unexpected status: %+v", status)
			}
			if tc.present && *status.YouShouldKnowEnabled != tc.enabled {
				t.Fatalf("enabled = %v, want %v", *status.YouShouldKnowEnabled, tc.enabled)
			}
		})
	}
}

func TestYouShouldKnowPollWritesStopOnlyOnce(t *testing.T) {
	requests := make(chan struct{}, 1)
	responses := make(chan string)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- struct{}{}
		select {
		case body := <-responses:
			fmt.Fprint(w, body)
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	base, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	task := Task{ID: "task-1", YouShouldKnow: json.RawMessage(yskContext)}
	ctx := withYouShouldKnowStop(base, task)
	env := yskEnv(t)
	if !prepareYouShouldKnow(ctx, task, "claude", "2.1.292", env, map[string]string{}, slog.Default()) {
		t.Fatal("mod not installed")
	}
	d := &Daemon{client: NewClient(srv.URL)}
	cancelled := d.watchTaskCancellation(ctx, task.ID, 5*time.Millisecond, slog.Default())
	waitRequest := func() {
		t.Helper()
		select {
		case <-requests:
		case <-ctx.Done():
			t.Fatal("status poll did not arrive")
		}
	}
	waitRequest()
	poll := func(body string) {
		t.Helper()
		select {
		case responses <- body:
		case <-ctx.Done():
			t.Fatal("status response was not read")
		}
		// The next request proves the previous response was fully processed.
		waitRequest()
		select {
		case <-cancelled:
			t.Fatal("YSK switch interrupted the main agent")
		default:
		}
	}
	stopFile := ysk.PathsFor(env.MulticaConfigRoot).Stop
	for _, body := range []string{`{"status":"running"}`, `{"status":"running","you_should_know_enabled":true}`} {
		poll(body)
		if _, err := os.Stat(stopFile); !os.IsNotExist(err) {
			t.Fatalf("unexpected stop marker: %v", err)
		}
	}
	poll(`{"status":"running","you_should_know_enabled":false}`)
	if _, err := os.Stat(stopFile); err != nil {
		t.Fatalf("stop marker missing after poll: %v", err)
	}
	if err := os.WriteFile(stopFile, []byte("written once"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"status":"running","you_should_know_enabled":false}`, `{"status":"running","you_should_know_enabled":true}`} {
		poll(body)
		if data, err := os.ReadFile(stopFile); err != nil || string(data) != "written once" {
			t.Fatalf("stop marker was changed: %q (%v)", data, err)
		}
	}
}

func TestYouShouldKnowHandleTaskSharesShutdownWithRunner(t *testing.T) {
	var completed, failed atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/status"):
			fmt.Fprint(w, `{"status":"running","you_should_know_enabled":false}`)
		case strings.HasSuffix(r.URL.Path, "/complete"):
			completed.Store(true)
		case strings.HasSuffix(r.URL.Path, "/fail"):
			failed.Store(true)
		}
	}))
	defer srv.Close()
	d := &Daemon{
		client: NewClient(srv.URL), logger: slog.Default(),
		workspaces:         make(map[string]*workspaceState),
		runtimeIndex:       map[string]Runtime{"rt-1": {ID: "rt-1", Provider: "claude"}},
		cancelPollInterval: time.Millisecond,
	}
	env := yskEnv(t)
	d.runner = taskRunnerFunc(func(ctx context.Context, task Task, provider string, _ int, logger *slog.Logger) (TaskResult, error) {
		if !prepareYouShouldKnow(ctx, task, provider, "2.1.292", env, map[string]string{}, logger) {
			t.Fatal("mod not installed")
		}
		defer unregisterYouShouldKnowStop(ctx)
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			if _, err := os.Stat(ysk.PathsFor(env.MulticaConfigRoot).Stop); err == nil {
				return TaskResult{Status: "completed"}, nil
			}
			select {
			case <-ctx.Done():
				t.Fatal("runner did not receive shutdown without being cancelled")
			case <-ticker.C:
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	d.handleTask(ctx, Task{
		ID: "task-1", RuntimeID: "rt-1", IssueID: "issue-1", Agent: &AgentData{Name: "test-agent"},
		YouShouldKnow: json.RawMessage(yskContext),
	}, 0)
	if !completed.Load() || failed.Load() {
		t.Fatalf("YSK shutdown must let the main task complete: completed=%v failed=%v", completed.Load(), failed.Load())
	}
}

func TestYouShouldKnowStopDuringPreparation(t *testing.T) {
	task := Task{ID: "task-1", YouShouldKnow: json.RawMessage(yskContext)}
	ctx := withYouShouldKnowStop(context.Background(), task)
	env := yskEnv(t)
	off, on := false, true
	updateYouShouldKnowStop(ctx, &off, slog.Default())
	updateYouShouldKnowStop(ctx, &on, slog.Default())
	if !prepareYouShouldKnow(ctx, task, "claude", "2.1.292", env, map[string]string{}, slog.Default()) {
		t.Fatal("mod not installed")
	}
	if _, err := os.Stat(ysk.PathsFor(env.MulticaConfigRoot).Stop); err != nil {
		t.Fatalf("shutdown received before installation was lost: %v", err)
	}
	unregisterYouShouldKnowStop(ctx)
	// A later run gets a fresh signal even when it reuses the environment.
	freshCtx := withYouShouldKnowStop(context.Background(), task)
	if !prepareYouShouldKnow(freshCtx, task, "claude", "2.1.292", env, map[string]string{}, slog.Default()) {
		t.Fatal("fresh mod not installed")
	}
	if _, err := os.Stat(ysk.PathsFor(env.MulticaConfigRoot).Stop); !os.IsNotExist(err) {
		t.Fatalf("a later run inherited shutdown: %v", err)
	}
}

func TestYouShouldKnowStopDoesNotWriteAfterRunEnds(t *testing.T) {
	task := Task{YouShouldKnow: json.RawMessage(yskContext)}
	ctx := withYouShouldKnowStop(context.Background(), task)
	env := yskEnv(t)
	if !prepareYouShouldKnow(ctx, task, "claude", "2.1.292", env, map[string]string{}, slog.Default()) {
		t.Fatal("mod not installed")
	}
	unregisterYouShouldKnowStop(ctx)
	// handleTask's poller may still finish a request after runTask releases
	// the environment for the next task to reuse.
	off := false
	updateYouShouldKnowStop(ctx, &off, slog.Default())
	if _, err := os.Stat(ysk.PathsFor(env.MulticaConfigRoot).Stop); !os.IsNotExist(err) {
		t.Fatalf("finished run wrote a stop marker: %v", err)
	}
}

func TestYouShouldKnowStopSkipsUninstalledMods(t *testing.T) {
	for _, tc := range []struct{ name, provider, version, payload string }{
		{"no claim context", "claude", "2.1.292", ""},
		{"unsupported version", "claude", "2.1.267", yskContext},
		{"other provider", "codex", "2.1.292", yskContext},
		{"bad context", "claude", "2.1.292", "[]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task := Task{YouShouldKnow: json.RawMessage(tc.payload)}
			ctx := withYouShouldKnowStop(context.Background(), task)
			env := yskEnv(t)
			if prepareYouShouldKnow(ctx, task, tc.provider, tc.version, env, map[string]string{}, slog.Default()) {
				t.Fatal("mod unexpectedly installed")
			}
			off := false
			updateYouShouldKnowStop(ctx, &off, slog.Default())
			if _, err := os.Stat(env.MulticaConfigRoot); !os.IsNotExist(err) {
				t.Fatalf("uninstalled mod wrote task config: %v", err)
			}
		})
	}
}

func TestYouShouldKnowStopRetriesFailedWrite(t *testing.T) {
	task := Task{YouShouldKnow: json.RawMessage(yskContext)}
	ctx := withYouShouldKnowStop(context.Background(), task)
	env := yskEnv(t)
	if !prepareYouShouldKnow(ctx, task, "claude", "2.1.292", env, map[string]string{}, slog.Default()) {
		t.Fatal("mod not installed")
	}
	stopFile := ysk.PathsFor(env.MulticaConfigRoot).Stop
	if err := os.Mkdir(stopFile, 0o700); err != nil {
		t.Fatal(err)
	}
	off, on := false, true
	updateYouShouldKnowStop(ctx, &off, slog.Default()) // EISDIR, swallowed
	if err := os.Remove(stopFile); err != nil {
		t.Fatal(err)
	}
	updateYouShouldKnowStop(ctx, &on, slog.Default()) // Shutdown is sticky even after a failed write.
	if data, err := os.ReadFile(stopFile); err != nil || len(data) != 0 {
		t.Fatalf("stop marker not retried: %q (%v)", data, err)
	}
}
