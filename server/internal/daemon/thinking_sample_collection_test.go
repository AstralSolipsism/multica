package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/internal/daemon/jevsample"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// topLevelRaw extracts one top-level property's raw JSON text from a JSON
// document, so two documents can be compared byte-for-byte on that property.
func topLevelRaw(t *testing.T, doc []byte, key string) string {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(doc, &fields); err != nil {
		t.Fatalf("unmarshal %s: %v", key, err)
	}
	raw, ok := fields[key]
	if !ok {
		t.Fatalf("missing top-level key %s in %s", key, doc)
	}
	return string(raw)
}

// sampleRecords parses a sample file into one map per JSONL line.
func sampleRecords(t *testing.T, path string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var records []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("invalid sample line: %v", err)
		}
		records = append(records, record)
	}
	return records
}

// TestRunTaskDecisionSampleCollection covers the OL-1017 acceptance criteria.
// It drives handleTask (not runTask) so the outcome sample is written on the
// daemon's actual terminal path, including the failure branch.
func TestRunTaskDecisionSampleCollection(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake CLI")
	}
	for _, scenario := range []string{"success", "fallback-5xx", "retry", "disabled", "agent-start-failure", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			stubModelDiscovery(t, map[string]agent.Catalog{"claude": adaptTestCatalog()})

			// Sentinel secrets that must never appear in a sample file.
			t.Setenv("MULTICA_JEV_OPENCODE_API_KEY", "sentinel-opencode-key-0123456789abcdef")
			t.Setenv("MULTICA_TOKEN", "sentinel-multica-token-0123456789abcdef")
			secretTask := "Investigate ghp_" + strings.Repeat("A", 40) +
				" and sk-" + strings.Repeat("b", 30) +
				" plus API_KEY=supersecretvalue99 Bearer tok_wo_rd_987654321 done"

			var mu sync.Mutex
			var wireBodies [][]byte
			jevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("read jev body: %v", err)
				}
				mu.Lock()
				wireBodies = append(wireBodies, body)
				mu.Unlock()
				if scenario == "fallback-5xx" {
					w.WriteHeader(503)
					return
				}
				fmt.Fprint(w, `{"answers":{"effort":{"choice":"high","confidence":0.9,"probabilities":{"high":0.9,"low":0.1}}}}`)
			}))
			defer jevServer.Close()

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// In the cancelled scenario the final pre-completion status
				// check sees the task already terminal (user cancel):
				// handleTask must discard the result and write no outcome —
				// the server never received one.
				if scenario == "cancelled" && strings.HasSuffix(r.URL.Path, "/status") {
					fmt.Fprint(w, `{"status":"cancelled"}`)
					return
				}
				fmt.Fprint(w, `{}`)
			}))
			defer srv.Close()

			collectRoot := t.TempDir()
			collectDir := filepath.Join(collectRoot, "collect")
			sampleDir := collectDir
			if scenario == "disabled" {
				sampleDir = "" // MULTICA_JEV_COLLECT_DIR unset
			}
			collector := jevsample.New(sampleDir, "daemon-test", "", 0, quietTaskLog())

			fake := filepath.Join(t.TempDir(), "claude")
			// One tool_use block so the run's tool count is 1, not 0 — the
			// outcome sample must carry it through to tool_calls.
			writeTestExecutable(t, fake, []byte(`#!/bin/sh
case "$*" in *--version*) echo '2.1.304'; exit 0;; esac
IFS= read -r _
case "$*" in *--resume*) printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"No conversation found with session ID old"}'; exit 0;; esac
printf '%s\n' '{"type":"assistant","message":{"id":"one","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"old","result":"done"}'
`))
			if scenario == "agent-start-failure" {
				// The decision happens before launch; the launch then fails,
				// so handleTask reports failed and the outcome must say so.
				broken := filepath.Join(t.TempDir(), "claude-broken")
				writeTestExecutable(t, broken, []byte("#!/bin/sh\n"))
				_ = os.Chmod(broken, 0o644)
				fake = broken
			}

			d := &Daemon{client: NewClient(srv.URL), jevClient: jev.New(jev.Options{
				Sources: []jev.Source{{Name: "fake", BaseURL: jevServer.URL, Model: "test"}}}),
				jevSamples: collector, logger: quietTaskLog(),
				workspaces:   map[string]*workspaceState{},
				runtimeIndex: map[string]Runtime{"rt": {ID: "rt", Provider: "claude"}}, activeEnvRoots: map[string]int{},
				cfg: Config{WorkspacesRoot: t.TempDir(), AgentTimeout: 5 * time.Second, ServerBaseURL: srv.URL, Agents: map[string]AgentEntry{"claude": {Path: fake}}},
			}
			d.runner = taskRunnerFunc(d.runTask)
			task := Task{ID: "sample-task", WorkspaceID: "ws", RuntimeID: "rt", IssueID: "issue", AgentID: "agent", AuthToken: "mat_sample_test",
				IssueDescription: secretTask,
				Agent:            &AgentData{ID: "agent", Name: "test", Model: "test/model", ThinkingLevel: agent.ThinkingLevelAdapt}}
			if scenario == "retry" {
				// Establish a prior session first (non-adaptive, no sample).
				task.Agent.ThinkingLevel = ""
				first, err := d.runTask(t.Context(), task, "claude", 0, quietTaskLog())
				if err != nil || first.Status != "completed" {
					t.Fatalf("prepare prior session: %+v %v", first, err)
				}
				task.Agent.ThinkingLevel = agent.ThinkingLevelAdapt
				task.ID = "retry-task"
				task.PriorSessionID, task.PriorWorkDir = first.SessionID, first.WorkDir
			}

			d.handleTask(t.Context(), task, 0)
			collector.Close()

			switch scenario {
			case "disabled":
				if _, err := os.Stat(collectDir); !os.IsNotExist(err) {
					t.Fatalf("collection created files while disabled: %v", err)
				}
				return
			case "cancelled":
				// The decision was sampled before the run; the server
				// cancelled the task and discarded the result, so exactly one
				// record (the decision) remains — no outcome to pair.
				day := time.Now().UTC().Format("20060102")
				path := filepath.Join(collectDir, "decisions-daemon-test-"+day+".jsonl")
				records := sampleRecords(t, path)
				if len(records) != 1 || records[0]["type"] != "decision" {
					t.Fatalf("cancelled run must keep only the decision: %v", records)
				}
				return
			case "fallback-5xx":
				// Fail-open: the run completed; no decision may be sampled and
				// therefore no outcome either.
				entries, err := os.ReadDir(collectDir)
				if err != nil {
					if os.IsNotExist(err) {
						return
					}
					t.Fatal(err)
				}
				if len(entries) != 0 {
					t.Fatalf("fallback wrote %d sample files", len(entries))
				}
				return
			}

			// success / retry / agent-start-failure: exactly one decision and
			// one outcome, linked by id.
			day := time.Now().UTC().Format("20060102")
			path := filepath.Join(collectDir, "decisions-daemon-test-"+day+".jsonl")
			records := sampleRecords(t, path)
			if len(records) != 2 {
				t.Fatalf("want exactly 2 records (decision+outcome), got %d: %v", len(records), records)
			}
			decision, outcome := records[0], records[1]
			if decision["type"] != "decision" || outcome["type"] != "outcome" {
				t.Fatalf("record order/types: %v", records)
			}

			// Decision fields per contract.
			id, _ := decision["id"].(string)
			ts, _ := decision["ts"].(string)
			if id == "" {
				t.Fatal("missing decision id")
			}
			if _, err := time.Parse(time.RFC3339, ts); err != nil || !strings.HasSuffix(ts, "Z") {
				t.Fatalf("ts not RFC3339 UTC: %q", ts)
			}
			for key, want := range map[string]any{
				"v": float64(1), "daemon_id": "daemon-test", "task_id": task.ID, "scope": "run",
				"step": nil, "provider": "claude", "model": "test/model",
				"source": "fake", "choice": "high", "confidence": 0.9,
			} {
				if decision[key] != want {
					t.Fatalf("decision[%q]=%v want %v", key, decision[key], want)
				}
			}
			if probs, ok := decision["probabilities"].(map[string]any); !ok || probs["high"] != 0.9 || probs["low"] != 0.1 {
				t.Fatalf("probabilities: %v", decision["probabilities"])
			}
			if latency, ok := decision["latency_ms"].(float64); !ok || latency < 0 {
				t.Fatalf("latency_ms: %v", decision["latency_ms"])
			}

			// state and questions must be byte-identical to the wire body.
			// Compare against the file's raw decision line — re-marshalling
			// through a map would reorder keys and break byte identity.
			mu.Lock()
			wire := wireBodies[len(wireBodies)-1]
			mu.Unlock()
			rawAll, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var decisionLine []byte
			for _, line := range strings.Split(strings.TrimSpace(string(rawAll)), "\n") {
				var probe map[string]any
				if json.Unmarshal([]byte(line), &probe) == nil && probe["type"] == "decision" {
					decisionLine = []byte(line)
				}
			}
			if got, want := topLevelRaw(t, decisionLine, "state"), topLevelRaw(t, wire, "state"); got != want {
				t.Fatalf("sample state %s != wire state %s", got, want)
			}
			if got, want := topLevelRaw(t, decisionLine, "questions"), topLevelRaw(t, wire, "questions"); got != want {
				t.Fatalf("sample questions != wire questions:\n%s\n%s", got, want)
			}

			// Outcome fields per contract.
			if outcome["decision_id"] != id {
				t.Fatalf("decision_id mismatch: %v vs %v", outcome["decision_id"], id)
			}
			if outcome["v"] != float64(1) || outcome["scope"] != "run" {
				t.Fatalf("outcome envelope: %v", outcome)
			}
			switch scenario {
			case "agent-start-failure":
				// The decision was sampled; the launch failure must pair it
				// with a failed outcome, not strand it without one.
				if outcome["status"] != "failed" || outcome["outcome_ok"] != false {
					t.Fatalf("start-failure outcome: %v", outcome)
				}
				if reason, _ := outcome["failure_reason"].(string); reason == "" {
					t.Fatalf("start-failure outcome missing failure_reason: %v", outcome)
				}
			default:
				if outcome["status"] != "completed" || outcome["outcome_ok"] != true || outcome["failure_reason"] != "" {
					t.Fatalf("completed outcome: %v", outcome)
				}
				// The fake CLI ran exactly one tool_use.
				if outcome["tool_calls"] != float64(1) {
					t.Fatalf("tool_calls=%v want 1", outcome["tool_calls"])
				}
			}

			// Redaction: only redact.Text's markers, never the originals, and
			// never the environment sentinels.
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			for _, bad := range []string{
				"ghp_", "sk-", "supersecretvalue99", "tok_wo_rd_987654321",
				"sentinel-opencode-key-0123456789abcdef", "sentinel-multica-token-0123456789abcdef",
			} {
				if strings.Contains(string(raw), bad) {
					t.Fatalf("sample leaked %q: %s", bad, raw)
				}
			}
			if !strings.Contains(string(raw), "REDACTED") {
				t.Fatalf("expected redaction markers in state: %s", raw)
			}

			// Permissions: directory 0700, file 0600.
			if info, err := os.Stat(collectDir); err != nil || info.Mode().Perm() != 0o700 {
				t.Fatalf("collect dir mode: %v %v", info.Mode().Perm(), err)
			}
			if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
				t.Fatalf("sample file mode: %v %v", info.Mode().Perm(), err)
			}
		})
	}
}

// TestOutcomeEnqueuedBeforeTerminalReport pins the write order from the
// frozen baseline: the outcome must be enqueued BEFORE the terminal report.
// Reporting can block for minutes while shutdown closes the sample collector
// after 30 seconds, so an outcome enqueued after a slow report is dropped.
func TestOutcomeEnqueuedBeforeTerminalReport(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake CLI")
	}
	stubModelDiscovery(t, map[string]agent.Catalog{"claude": adaptTestCatalog()})

	jevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"answers":{"effort":{"choice":"high","confidence":0.9,"probabilities":{"high":0.9,"low":0.1}}}}`)
	}))
	defer jevServer.Close()

	reportStarted := make(chan struct{})
	releaseReport := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/complete") {
			close(reportStarted)
			<-releaseReport
		}
		fmt.Fprint(w, `{}`)
	}))
	defer srv.Close()

	collectDir := t.TempDir()
	collector := jevsample.New(collectDir, "daemon-test", "", 0, quietTaskLog())
	fake := filepath.Join(t.TempDir(), "claude")
	writeTestExecutable(t, fake, []byte(`#!/bin/sh
case "$*" in *--version*) echo '2.1.304'; exit 0;; esac
IFS= read -r _
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"old","result":"done"}'
`))

	d := &Daemon{client: NewClient(srv.URL), jevClient: jev.New(jev.Options{
		Sources: []jev.Source{{Name: "fake", BaseURL: jevServer.URL, Model: "test"}}}),
		jevSamples: collector, logger: quietTaskLog(),
		workspaces:   map[string]*workspaceState{},
		runtimeIndex: map[string]Runtime{"rt": {ID: "rt", Provider: "claude"}}, activeEnvRoots: map[string]int{},
		cfg: Config{WorkspacesRoot: t.TempDir(), AgentTimeout: 5 * time.Second, ServerBaseURL: srv.URL, Agents: map[string]AgentEntry{"claude": {Path: fake}}},
	}
	d.runner = taskRunnerFunc(d.runTask)
	task := Task{ID: "order-task", WorkspaceID: "ws", RuntimeID: "rt", IssueID: "issue", AgentID: "agent", AuthToken: "mat_order_test",
		IssueDescription: "plain task",
		Agent:            &AgentData{ID: "agent", Name: "test", Model: "test/model", ThinkingLevel: agent.ThinkingLevelAdapt}}

	done := make(chan struct{})
	go func() {
		defer close(done)
		d.handleTask(t.Context(), task, 0)
	}()

	// Shutdown closes the collector while the terminal report is still
	// blocked — exactly the production window the write order protects.
	<-reportStarted
	collector.Close()
	close(releaseReport)
	<-done

	day := time.Now().UTC().Format("20060102")
	path := filepath.Join(collectDir, "decisions-daemon-test-"+day+".jsonl")
	records := sampleRecords(t, path)
	var outcomes int
	for _, record := range records {
		if record["type"] == "outcome" {
			outcomes++
		}
	}
	if outcomes != 1 {
		t.Fatalf("outcome not enqueued before the terminal report; got %d outcome records, want 1: %v", outcomes, records)
	}
}
