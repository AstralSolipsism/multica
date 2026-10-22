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
	// OL-1040 #1a: the default profile's prefix "decisions-d-" is itself a
	// prefix of every named profile's filename, so a loose prefix match
	// would count the named profile's 900 bytes into the default profile's
	// cap and refuse this record. It must be written.
	big := filepath.Join(dir, b.filePrefix+"-"+day+".jsonl")
	if err := os.WriteFile(big, []byte(strings.Repeat("x", 900)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	capped := New(dir, "d", "", 1000, nil)
	id := capped.Decision(Decision{Scope: "run", Choice: "low"})
	capped.Close()
	records := readLines(t, filepath.Join(dir, "decisions-d-"+day+".jsonl"))
	last := records[len(records)-1]
	if last["id"] != id {
		t.Fatalf("default profile's cap counted a named profile's bytes: %v", last)
	}
	// OL-1040 #1b: the named profile's own cap direction — with the default
	// profile's file at 900 bytes, a "work" daemon under the same 1000-byte
	// cap must still write: its cap must ignore the default profile's
	// bytes (a daemonID-only prefix match would not).
	big2 := filepath.Join(dir, "decisions-d-"+day+".jsonl")
	if err := os.WriteFile(big2, []byte(strings.Repeat("x", 900)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	capped2 := New(dir, "d", "work", 1000, nil)
	id2 := capped2.Decision(Decision{Scope: "run", Choice: "low"})
	capped2.Close()
	records2 := readLines(t, filepath.Join(dir, capped2.filePrefix+"-"+day+".jsonl"))
	last2 := records2[len(records2)-1]
	if last2["id"] != id2 {
		t.Fatalf("named profile's cap counted the default profile's bytes: %v", last2)
	}
}

// OL-1040 #2: profiles that differ only in characters the sanitizer maps to
// '_' ("my work" vs "my_work") sanitize to the same segment — the hash
// suffix is what must keep their files apart. Without it they would
// interleave appends in one file, the exact bug this issue fixes.
func TestSanitizedCollisionKeptApartByHash(t *testing.T) {
	dir := t.TempDir()
	c1 := New(dir, "d", "my work", 0, nil)
	c2 := New(dir, "d", "my_work", 0, nil)
	if c1.filePrefix == c2.filePrefix {
		t.Fatalf("profiles sanitizing to the same segment must get distinct prefixes: %s", c1.filePrefix)
	}
	id1 := c1.Decision(Decision{Scope: "run", Choice: "low"})
	id2 := c2.Decision(Decision{Scope: "run", Choice: "high"})
	c1.Close()
	c2.Close()
	day := time.Now().UTC().Format(dateFormat)
	records := readLines(t, filepath.Join(dir, c1.filePrefix+"-"+day+".jsonl"))
	if len(records) != 1 || records[0]["id"] != id1 {
		t.Fatalf("c1's file must hold exactly its own record: %v", records)
	}
	records = readLines(t, filepath.Join(dir, c2.filePrefix+"-"+day+".jsonl"))
	if len(records) != 1 || records[0]["id"] != id2 {
		t.Fatalf("c2's file must hold exactly its own record: %v", records)
	}
}

// A pathological profile name must not push the filename past the 255-byte
// limit: the sanitized segment truncates, uniqueness rides on the hash.
func TestLongProfileNameStillWrites(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("p", 300)
	c := New(dir, "01234567-89ab-cdef-0123-456789abcdef", long, 0, nil)
	id := c.Decision(Decision{Scope: "run", Choice: "low"})
	c.Close()
	if len(c.filePrefix) >= 255-len(".jsonl")-len(dateFormat)-1 {
		t.Fatalf("prefix too long: %d bytes", len(c.filePrefix))
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "decisions-*.jsonl"))
	if len(matches) != 1 {
		t.Fatalf("want exactly one sample file, got %v", matches)
	}
	if records := readLines(t, matches[0]); len(records) != 1 || records[0]["id"] != id {
		t.Fatalf("long-profile record missing: %v", records)
	}
}

func TestSizeCapRefusesSmallerRecordsAndResumesAfterDelete(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

	// Existing files already over the cap: the day's first record (decision,
	// ~283 bytes) trips the cap and makes the stop sticky, so the outcome
	// — which alone would fit under the cap — must still be refused.
	// No half pairs.
	old := filepath.Join(dir, "decisions-d-"+now.Format(dateFormat)+".jsonl")
	oldBytes := []byte(strings.Repeat("x", 750) + "\n")
	if err := os.WriteFile(old, oldBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	c := New(dir, "d", "", 1000, nil)
	c.now = func() time.Time { return now }
	id := c.Decision(Decision{Scope: "run", Choice: "low"}) // ~283 bytes: 750+284 > 1000, trips the cap
	c.Outcome(Outcome{DecisionID: id, Status: "completed"}) // ~193 bytes: alone under the cap; sticky stop must refuse it
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

func TestSizeCapWarnsOnceAcrossDays(t *testing.T) {
	handler := &countingHandler{}
	dir := t.TempDir()
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	c := New(dir, "d", "", 1000, slog.New(handler))
	c.now = func() time.Time { return now }
	// Over the cap on day 1: one warn, sticky stop for the day.
	c.Decision(Decision{Scope: "run", Choice: "low", State: strings.Repeat("s", 800)})
	// Still over the cap after rotating to day 2: must NOT warn again —
	// the cap warning is once per collector lifetime, not once per day.
	now = now.AddDate(0, 0, 1)
	c.now = func() time.Time { return now }
	c.Decision(Decision{Scope: "run", Choice: "low", State: strings.Repeat("s", 800)})
	c.Close()
	if got := handler.count.Load(); got != 1 {
		t.Fatalf("warn count=%d, want exactly 1 (once per collector lifetime, not per day)", got)
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
