package jevsample

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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

// countingHandler counts Warn records so tests can assert on rate limiting
// without matching message text.
type countingHandler struct{ count atomic.Int64 }

func (h *countingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *countingHandler) Handle(_ context.Context, r slog.Record) error {
	if r.Level == slog.LevelWarn {
		h.count.Add(1)
	}
	return nil
}
func (h *countingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *countingHandler) WithGroup(string) slog.Handler      { return h }

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
	c := New(dir, "daemon-a", "", 0, nil)
	// Non-UTC clock: rotation and ts must still key off UTC, not local time.
	utcPlus8 := time.FixedZone("UTC+8", 8*3600)
	base := time.Date(2026, 10, 22, 7, 30, 0, 0, utcPlus8) // Oct 21 23:30 UTC
	c.now = func() time.Time { return base }

	firstDay := base.UTC().Format(dateFormat)
	id := c.Decision(Decision{TaskID: "task-1", Scope: "run", Provider: "claude", Model: "m",
		State: "s1", Questions: json.RawMessage(`{"effort":{}}`),
		Source: "opencode-free", Choice: "low", Confidence: 0.8,
		Probabilities: map[string]float64{"low": 0.8, "high": 0.2}, LatencyMS: 12})
	if id == "" {
		t.Fatal("no sample id")
	}
	// One hour later is past UTC midnight (Oct 22 00:30 UTC) while the local
	// date (Oct 22 in UTC+8) has not changed: the record still belongs to the
	// next UTC day's file.
	base = base.Add(time.Hour)
	c.now = func() time.Time { return base }
	c.Outcome(Outcome{DecisionID: id, Status: "completed", ToolCalls: 3})
	c.Close()

	day2 := base.UTC().Format(dateFormat)
	if day2 == firstDay {
		t.Fatal("test did not cross a UTC day boundary")
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
	if ts, _ := decision["ts"].(string); !strings.HasSuffix(ts, "Z") {
		t.Fatalf("ts must be UTC (Z suffix), got %q", ts)
	}
	outcome := readLines(t, filepath.Join(dir, want2))[0]
	if outcome["type"] != "outcome" || outcome["decision_id"] != id || outcome["outcome_ok"] != true || outcome["tool_calls"] != float64(3) {
		t.Fatalf("outcome record=%v", outcome)
	}
}

func TestStepScopeAndFailureOutcome(t *testing.T) {
	dir := t.TempDir()
	c := New(dir, "d", "", 0, nil)
	now := time.Now().UTC()
	c.now = func() time.Time { return now }
	id := c.Decision(Decision{Scope: "step", Step: 4, Choice: "high"})
	c.Outcome(Outcome{DecisionID: id, Status: "blocked", FailureReason: "agent_error.timeout"})
	c.Close()
	records := readLines(t, filepath.Join(dir, "decisions-d-"+now.Format(dateFormat)+".jsonl"))
	if records[0]["step"] != float64(4) || records[0]["scope"] != "step" {
		t.Fatalf("step record=%v", records[0])
	}
	if records[1]["outcome_ok"] != false || records[1]["failure_reason"] != "agent_error.timeout" {
		t.Fatalf("outcome record=%v", records[1])
	}
}

func TestTwoDaemonsSeparateFiles(t *testing.T) {
	dir := t.TempDir()
	a := New(dir, "daemon-a", "", 0, nil)
	b := New(dir, "daemon-b", "", 0, nil)
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

// OL-1040: the daemon ID is machine-scoped while the single-instance lock is
// per profile, so two same-machine daemons differ only by profile — the
// filename must keep their records in separate files.
func TestSameDaemonTwoProfilesSeparateFiles(t *testing.T) {
	dir := t.TempDir()
	a := New(dir, "d", "", 0, nil)           // default profile: no segment
	b := New(dir, "d", "work", 0, nil)       // named profile
	weird := New(dir, "d", "wörk/x", 0, nil) // unsafe chars must not collide
	a.Decision(Decision{Scope: "run", Choice: "low"})
	b.Decision(Decision{Scope: "run", Choice: "high"})
	weird.Decision(Decision{Scope: "run", Choice: "high"})
	a.Close()
	b.Close()
	weird.Close()

	day := time.Now().UTC().Format(dateFormat)
	files := map[string]string{}
	for _, c := range []*Collector{a, b, weird} {
		path := filepath.Join(dir, c.filePrefix+"-"+day+".jsonl")
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("missing %s: %v", path, err)
		}
		files[c.filePrefix] = path
	}
	if len(files) != 3 {
		t.Fatalf("want 3 distinct file prefixes, got %v", files)
	}
	// The default profile keeps the pre-OL-1040 name.
	if _, ok := files["decisions-d"]; !ok {
		t.Fatalf("default profile must use plain prefix: %v", files)
	}
	// Size cap must count only this profile's files even in a shared dir.
	// The default profile's file below is over the cap on its own; a "work"
	// daemon must still write, proving its cap ignores other profiles' bytes.
	big := filepath.Join(dir, "decisions-d-"+day+".jsonl")
	if err := os.WriteFile(big, []byte(strings.Repeat("x", 900)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	capped := New(dir, "d", "work", 1000, nil)
	id := capped.Decision(Decision{Scope: "run", Choice: "low"})
	capped.Close()
	records := readLines(t, filepath.Join(dir, capped.filePrefix+"-"+day+".jsonl"))
	last := records[len(records)-1]
	if last["id"] != id {
		t.Fatalf("profile-scoped cap miscounted other profiles' files: %v", last)
	}
}

func TestSizeCapRefusesSmallerRecordsAndResumesAfterDelete(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

	// Existing files already over the cap: both the decision and its much
	// smaller outcome must be refused — the stop is sticky for the day, so
	// no half pairs.
	old := filepath.Join(dir, "decisions-d-"+now.Format(dateFormat)+".jsonl")
	oldBytes := []byte(strings.Repeat("x", 900) + "\n")
	if err := os.WriteFile(old, oldBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	c := New(dir, "d", "", 1000, nil)
	c.now = func() time.Time { return now }
	id := c.Decision(Decision{Scope: "run", Choice: "low"}) // ~300 bytes: does not fit
	c.Outcome(Outcome{DecisionID: id, Status: "completed"}) // ~190 bytes: fits alone, must still be refused
	c.Close()

	if raw, err := os.ReadFile(old); err != nil || string(raw) != string(oldBytes) {
		t.Fatalf("old file modified: %d bytes, err %v", len(raw), err)
	}

	// Deleting files resumes collection on a later day (sizeOnDisk is
	// re-checked per day).
	if err := os.Remove(old); err != nil {
		t.Fatal(err)
	}
	next := now.AddDate(0, 0, 1)
	c2 := New(dir, "d", "", 1000, nil)
	c2.now = func() time.Time { return next }
	id2 := c2.Decision(Decision{Scope: "run", Choice: "low"})
	c2.Outcome(Outcome{DecisionID: id2, Status: "completed"})
	c2.Close()
	records := readLines(t, filepath.Join(dir, "decisions-d-"+next.Format(dateFormat)+".jsonl"))
	if len(records) != 2 || records[0]["id"] != id2 || records[1]["decision_id"] != id2 {
		t.Fatalf("post-delete records: %v", records)
	}
}

func TestSymlinkedDirRefusedWithoutBlocking(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix symlinks")
	}
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	c := New(link, "d", "", 0, nil)
	id := c.Decision(Decision{Scope: "run", Choice: "low"})
	c.Close()
	matches, _ := filepath.Glob(filepath.Join(real, "*"))
	if len(matches) != 0 {
		t.Fatalf("wrote through a symlinked sample dir: %v", matches)
	}
	if id == "" {
		t.Fatal("expected a sample id even when the record is later dropped")
	}
}

func TestUnwritableDirDropsWithoutBlocking(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permissions")
	}
	// A regular file where the directory should be can never become a dir.
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	c := New(blocker, "d", "", 0, nil)
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

func TestWarnRateLimitedPerReason(t *testing.T) {
	handler := &countingHandler{}
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	c := New(blocker, "d", "", 0, slog.New(handler))
	for range 10 {
		c.Decision(Decision{Scope: "run", Choice: "low"})
	}
	c.Close()
	if got := handler.count.Load(); got != 1 {
		t.Fatalf("warn count=%d, want exactly 1 (rate-limited per reason)", got)
	}
}

func TestQueueOverflowDrops(t *testing.T) {
	c := New(t.TempDir(), "d", "", 0, nil)
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range queueDepth {
				c.Decision(Decision{Scope: "run", Choice: "low"})
			}
		}()
	}
	// No blocking, no panic; close proves the writer drains whatever queued.
	c.Close()
	wg.Wait()
}
