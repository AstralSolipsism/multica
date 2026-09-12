package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Run the real task execution and HTTP reporting path with a fake agy process.
// A runner stub returning TaskResult would bypass the conversion that used to
// discard explicit zero usage before ReportTaskUsage ever saw it.
func TestHandleTaskPreservesReportedZeroUsage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	for _, tc := range []struct {
		name, usage string
		reported    bool
	}{
		{"confirmed zero", `{"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0}`, true},
		{"unreported", "null", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, _, cleanup := newLeaderReuseTestDaemon(t)
			defer cleanup()
			fakePath := filepath.Join(t.TempDir(), "agy")
			script := "#!/bin/sh\n" +
				`printf '%s\n' '{"event":"init","conversation_id":"fixture-session","init":{"model":"fixture-model"}}'` + "\n" +
				`printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"done","usage":` + tc.usage + `}}'` + "\n"
			if err := os.WriteFile(fakePath, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			usageReports := make(chan []TaskUsageEntry, 4)
			terminalReports := make(chan string, 4)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/usage"):
					var body struct {
						Usage []TaskUsageEntry `json:"usage"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					usageReports <- body.Usage
				case strings.HasSuffix(r.URL.Path, "/complete"), strings.HasSuffix(r.URL.Path, "/fail"):
					terminalReports <- r.URL.Path
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"status":"running"}`))
			}))
			defer srv.Close()
			d.client = NewClient(srv.URL)
			d.cfg.ServerBaseURL = srv.URL
			d.cfg.Agents = map[string]AgentEntry{"antigravity": {Path: fakePath}}
			d.runtimeIndex["rt-leader"] = Runtime{ID: "rt-leader", Provider: "antigravity"}
			d.runner = taskRunnerFunc(d.runTask)
			d.cancelPollInterval = time.Hour
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			d.handleTask(ctx, leaderReuseTestTask("task-usage"), 0)
			select {
			case path := <-terminalReports:
				if !strings.HasSuffix(path, "/complete") {
					t.Fatalf("task failed instead of completing: %s", path)
				}
			default:
				t.Fatal("task never reported completion")
			}
			select {
			case usage := <-usageReports:
				if !tc.reported || len(usage) != 1 || usage[0] != (TaskUsageEntry{Provider: "antigravity", Model: "fixture-model"}) {
					t.Fatalf("unexpected usage report: %+v", usage)
				}
			default:
				if tc.reported {
					t.Fatal("reported zero was lost before HTTP upload")
				}
			}
		})
	}
}
