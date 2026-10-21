package jevsample

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func readLines(t *testing.T, path string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("invalid JSON line %q: %v", line, err)
		}
		lines = append(lines, record)
	}
	return lines
}

func TestDisabledCollectorIsNoop(t *testing.T) {
	var c *Collector
	if id := c.Decision(Decision{Scope: "run"}); id != "" {
		t.Fatal("disabled collector returned an id")
	}
	c.Outcome(Outcome{DecisionID: "x", Status: "completed"})
	c.Close()
}

func TestFileLayoutPermissionsAndRotation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits")
	}
	dir := t.TempDir()
	c := New(dir, "daemon-a", 0, nil)
	base := time.Date(2026, 10, 21, 23, 59, 0, 0, time.UTC)
	c.now = func() time.Time { return base }

	firstDay := base.UTC().Format(dateFormat)
	id := c.Decision(Decision{TaskID: "task-1", Scope: "run", Provider: "claude", Model: "m",
		State: "s1", Questions: json.RawMessage(`{"effort":{}}`),
		Source: "opencode-free", Choice: "low", Confidence: 0.8,
		Probabilities: map[string]float64{"low": 0.8, "high": 0.2}, LatencyMS: 12})
	if id == "" {
		t.Fatal("no sample id")
	}
	// Cross UTC midnight: the next record belongs to the next day's file.
	base = base.Add(2 * time.Minute) // 2026-10-22 00:01 UTC
	c.Outcome(Outcome{DecisionID: id, Status: "completed", ToolCalls: 3})
	c.Close()

	day2 := base.UTC().Format(dateFormat)
	if day2 == firstDay {
		t.Fatal("test did not cross midnight")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, e := range entries {
		names[e.Name()] = true
	}
	want1 := "decisions-daemon-a-" + firstDay + ".jsonl"
	want2 := "decisions-daemon-a-" + day2 + ".jsonl"
	if !names[want1] || !names[want2] {
		t.Fatalf("files=%v want %s and %s", names, want1, want2)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode=%o want 0700", info.Mode().Perm())
	}
	for _, name := range []string{want1, want2} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode=%o want 0600", name, info.Mode().Perm())
		}
	}
	decision := readLines(t, filepath.Join(dir, want1))[0]
	if decision["v"] != float64(1) || decision["type"] != "decision" || decision["id"] != id {
		t.Fatalf("decision record=%v", decision)
	}
	if decision["step"] != nil {
		t.Fatalf("run-level step must be null: %v", decision["step"])
	}
	outcome := readLines(t, filepath.Join(dir, want2))[0]
	if outcome["type"] != "outcome" || outcome["decision_id"] != id || outcome["outcome_ok"] != true || outcome["tool_calls"] != float64(3) {
		t.Fatalf("outcome record=%v", outcome)
	}
}

func TestStepScopeAndFailureOutcome(t *testing.T) {
	dir := t.TempDir()
	c := New(dir, "d", 0, nil)
	id := c.Decision(Decision{Scope: "step", Step: 4, Choice: "high"})
	c.Outcome(Outcome{DecisionID: id, Status: "blocked", FailureReason: "agent_error.timeout"})
	c.Close()
	records := readLines(t, filepath.Join(dir, "decisions-d-"+c.now().Format(dateFormat)+".jsonl"))
	if records[0]["step"] != float64(4) || records[0]["scope"] != "step" {
		t.Fatalf("step record=%v", records[0])
	}
	if records[1]["outcome_ok"] != false || records[1]["failure_reason"] != "agent_error.timeout" {
		t.Fatalf("outcome record=%v", records[1])
	}
}

func TestTwoDaemonsSeparateFiles(t *testing.T) {
	dir := t.TempDir()
	a := New(dir, "daemon-a", 0, nil)
	b := New(dir, "daemon-b", 0, nil)
	a.Decision(Decision{Scope: "run", Choice: "low"})
	b.Decision(Decision{Scope: "run", Choice: "high"})
	a.Close()
	b.Close()
	day := time.Now().UTC().Format(dateFormat)
	for _, daemon := range []string{"daemon-a", "daemon-b"} {
		path := filepath.Join(dir, "decisions-"+daemon+"-"+day+".jsonl")
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("missing %s: %v", path, err)
		}
	}
}

func TestSizeCapStopsWritingKeepsOldFiles(t *testing.T) {
	dir := t.TempDir()
	// Pre-existing sample larger than the cap: the collector must stop, not
	// delete or truncate.
	day := time.Now().UTC().Format(dateFormat)
	old := filepath.Join(dir, "decisions-d-"+day+".jsonl")
	if err := os.WriteFile(old, []byte(strings.Repeat("x", 100)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := New(dir, "d", 150, nil)
	c.Decision(Decision{Scope: "run", Choice: "low"})
	c.Close()
	raw, err := os.ReadFile(old)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 101 {
		t.Fatalf("old file modified: %d bytes", len(raw))
	}
}

func TestUnwritableDirDropsWithoutBlocking(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permissions")
	}
	// A regular file where the directory should be can never be created as a dir.
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	c := New(blocker, "d", 0, nil)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range 100 {
			c.Decision(Decision{Scope: "run", Choice: "low"})
		}
		c.Close()
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("collector blocked on an unusable directory")
	}
}

func TestQueueOverflowDrops(t *testing.T) {
	c := New(t.TempDir(), "d", 0, nil)
	var wg sync.WaitGroup
	for worker := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range queueDepth {
				_ = worker
				c.Decision(Decision{Scope: "run", Choice: "low"})
			}
		}()
	}
	// No blocking, no panic; close proves the writer drains whatever queued.
	c.Close()
	wg.Wait()
}
