package daemon

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// A daemon with two workspaces: ws-1 has a built-in hermes runtime, ws-2 has
// both a built-in hermes AND a custom hermes profile runtime (same provider
// string — the S2a collision), plus a kimi runtime for cross-provider checks.
func newZenmuxLinkTestDaemon() *Daemon {
	return &Daemon{
		cfg:        Config{},
		logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		runtimeSet: newRuntimeSetWatcher(),
		workspaces: map[string]*workspaceState{
			"ws-1": {runtimeIDs: []string{"rt-h1"}},
			"ws-2": {runtimeIDs: []string{"rt-h2", "rt-h2p", "rt-kimi"}},
		},
		runtimeIndex: map[string]Runtime{
			"rt-h1":   {ID: "rt-h1", Provider: "hermes"},
			"rt-h2":   {ID: "rt-h2", Provider: "hermes"},
			"rt-h2p":  {ID: "rt-h2p", Provider: "hermes", ProfileID: "prof-zen"},
			"rt-kimi": {ID: "rt-kimi", Provider: "kimi"},
		},
	}
}

func seedZenmuxState(t *testing.T, keys ...string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Keep the profile dir resolution on the temp HOME even when the test
	// binary runs inside a daemon-managed task (which sets this env var).
	t.Setenv("MULTICA_TASK_CONFIG_ROOT", "")
	raw, err := json.Marshal(zenmuxQuotaStateFile{Keys: keys})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, ".multica")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, zenmuxQuotaStateFileName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func readZenmuxStateKeys(t *testing.T, home string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(home, ".multica", zenmuxQuotaStateFileName))
	if err != nil {
		return nil
	}
	var doc zenmuxQuotaStateFile
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Keys
}

func TestParseZenMuxLink(t *testing.T) {
	t.Run("empty means no association", func(t *testing.T) {
		set, err := parseZenMuxLink("")
		if err != nil || !set.empty() {
			t.Fatalf("empty parse = %+v, %v", set, err)
		}
	})
	t.Run("all hermes", func(t *testing.T) {
		set, err := parseZenMuxLink("hermes")
		if err != nil || !set.allHermes {
			t.Fatalf("parse = %+v, %v", set, err)
		}
		if !set.linked("hermes", "any-ws", "") || set.linked("kimi", "any-ws", "") {
			t.Fatal("linked() wrong for all-hermes")
		}
	})
	t.Run("per-workspace entries", func(t *testing.T) {
		set, err := parseZenMuxLink(" hermes@ws-1 , hermes@ws-2 ")
		if err != nil {
			t.Fatal(err)
		}
		if !set.linked("hermes", "ws-1", "") || !set.linked("hermes", "ws-2", "") || set.linked("hermes", "ws-3", "") {
			t.Fatal("linked() wrong for per-workspace set")
		}
		// Workspace-wide selection covers profiles in that workspace too.
		if !set.linked("hermes", "ws-1", "prof-zen") {
			t.Fatal("workspace entry should cover its custom profiles")
		}
	})
	t.Run("builtin entries exclude custom profiles", func(t *testing.T) {
		set, err := parseZenMuxLink("hermes:builtin")
		if err != nil {
			t.Fatal(err)
		}
		if !set.linked("hermes", "ws-1", "") || !set.linked("hermes", "ws-9", "") {
			t.Fatal("builtin-all did not match built-in runtimes")
		}
		if set.linked("hermes", "ws-2", "prof-zen") {
			t.Fatal("builtin-all leaked to a custom profile")
		}
		scoped, err := parseZenMuxLink("hermes:builtin@ws-2")
		if err != nil {
			t.Fatal(err)
		}
		if !scoped.linked("hermes", "ws-2", "") || scoped.linked("hermes", "ws-1", "") {
			t.Fatal("builtin@ws scoping wrong")
		}
		if scoped.linked("hermes", "ws-2", "prof-zen") {
			t.Fatal("builtin@ws leaked to a custom profile")
		}
	})
	t.Run("profile entries select one profile across workspaces", func(t *testing.T) {
		set, err := parseZenMuxLink("hermes:profile:prof-zen")
		if err != nil {
			t.Fatal(err)
		}
		if !set.linked("hermes", "ws-2", "prof-zen") {
			t.Fatal("profile entry did not match its runtime")
		}
		if set.linked("hermes", "ws-2", "") || set.linked("hermes", "ws-1", "") {
			t.Fatal("profile entry leaked to built-in runtimes")
		}
	})
	t.Run("rejects non-hermes providers and malformed entries", func(t *testing.T) {
		for _, bad := range []string{"codex", "kimi@ws-1", "hermes@", "@ws-1", "her", "hermesx", "hermes:profile:", "hermes:profile", "hermes:builtin@", "hermes:builtinx"} {
			if _, err := parseZenMuxLink(bad); err == nil {
				t.Fatalf("%q parsed without error", bad)
			}
		}
	})
}

func TestZenmuxLinkedRuntimes(t *testing.T) {
	d := newZenmuxLinkTestDaemon()

	all, _ := parseZenMuxLink("hermes")
	if got := d.zenmuxLinkedRuntimes(all); len(got) != 3 {
		t.Fatalf("all-hermes targets = %v", got)
	}

	ws1, _ := parseZenMuxLink("hermes@ws-1")
	if got := d.zenmuxLinkedRuntimes(ws1); len(got) != 1 || got[0].ID != "rt-h1" {
		t.Fatalf("ws-1 targets = %v", got)
	}

	// S2a: profile-granular selection picks exactly the profile runtime out
	// of a workspace that also has a built-in hermes.
	prof, _ := parseZenMuxLink("hermes:profile:prof-zen")
	if got := d.zenmuxLinkedRuntimes(prof); len(got) != 1 || got[0].ID != "rt-h2p" {
		t.Fatalf("profile targets = %v", got)
	}

	// S2a: built-in-only selection picks exactly the built-in runtime out of
	// a workspace that also has a custom profile — "内置用 ZenMux、自定义用
	// 其他来源" is expressible.
	builtin, _ := parseZenMuxLink("hermes:builtin@ws-2")
	if got := d.zenmuxLinkedRuntimes(builtin); len(got) != 1 || got[0].ID != "rt-h2" {
		t.Fatalf("builtin@ws-2 targets = %v", got)
	}
	builtinAll, _ := parseZenMuxLink("hermes:builtin")
	if got := d.zenmuxLinkedRuntimes(builtinAll); len(got) != 2 {
		t.Fatalf("builtin-all targets = %v", got)
	}

	none, _ := parseZenMuxLink("")
	if got := d.zenmuxLinkedRuntimes(none); len(got) != 0 {
		t.Fatalf("empty link targets = %v", got)
	}
}

// S2b: clearing reaches only runtimes this daemon previously reported for
// (persisted state) and which are no longer linked. Never-reported runtimes
// — whose row may belong to a BYO reporter — get no marker at all.
func TestReconcileZenMuxClears(t *testing.T) {
	d := newZenmuxLinkTestDaemon()

	state := &zenmuxQuotaState{keys: map[string]struct{}{
		"hermes@ws-2":          {}, // previously reported, now unlinked
		"hermes@ws-2#prof-zen": {}, // previously reported profile, now unlinked
		"hermes@ws-9":          {}, // reported once, runtime gone server-side
	}}
	ws1, _ := parseZenMuxLink("hermes@ws-1")
	d.reconcileZenMuxClears(ws1, state)

	if _, ok := d.planQuotaCache.Load("rt-h1"); ok {
		t.Fatal("linked runtime received a clear marker")
	}
	for _, rid := range []string{"rt-h2", "rt-h2p"} {
		cached, ok := d.planQuotaCache.Load(rid)
		if !ok {
			t.Fatalf("previously-reported unlinked runtime %s not cleared", rid)
		}
		quota := cached.(*protocol.RuntimePlanQuota)
		if quota.Provider != "zenmux" || len(quota.Windows) != 0 || quota.Source != protocol.PlanQuotaSourceDaemon {
			t.Fatalf("clear marker for %s = %+v", rid, quota)
		}
	}
	if _, ok := d.planQuotaCache.Load("rt-kimi"); ok {
		t.Fatal("kimi runtime received a zenmux clear marker")
	}

	// Without state memory, nothing is cleared — the never-reported case.
	d2 := newZenmuxLinkTestDaemon()
	empty := &zenmuxQuotaState{keys: map[string]struct{}{}}
	d2.reconcileZenMuxClears(ws1, empty)
	for _, rid := range []string{"rt-h2", "rt-h2p"} {
		if _, ok := d2.planQuotaCache.Load(rid); ok {
			t.Fatalf("never-reported runtime %s received a clear marker", rid)
		}
	}
}

// End-to-end through the loop with a mocked Management API: the linked
// workspace's hermes runtime gets the real snapshot and its key is persisted
// to the state file; the previously-reported-but-now-unlinked runtime gets
// cleared; the never-reported profile runtime and kimi are untouched.
func TestZenmuxLoop_MixedSources(t *testing.T) {
	var gotAuth string
	srv := newZenmuxTestServer(t, 0, zenmuxDetailJSON, &gotAuth)
	defer srv.Close()

	// State says this daemon previously reported ws-2's built-in hermes;
	// the current link covers only ws-1.
	home := seedZenmuxState(t, "hermes@ws-2")

	d := newZenmuxLinkTestDaemon()
	link, err := parseZenMuxLink("hermes@ws-1")
	if err != nil {
		t.Fatal(err)
	}
	d.cfg = Config{
		ZenMuxManagementAPIKey:  "zm-mgmt-key",
		ZenMuxAPIBaseURL:        srv.URL,
		ZenMuxLink:              link,
		PlanQuotaZenMuxInterval: 10 * time.Millisecond,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.zenmuxPlanQuotaLoop(ctx)

	waitForQuotaCondition(t, "linked runtime snapshot", func() bool {
		cached, ok := d.planQuotaCache.Load("rt-h1")
		return ok && len(cached.(*protocol.RuntimePlanQuota).Windows) == 2
	})
	waitForQuotaCondition(t, "linked key persisted", func() bool {
		for _, k := range readZenmuxStateKeys(t, home) {
			if k == "hermes@ws-1" {
				return true
			}
		}
		return false
	})
	cancel()

	h1, _ := d.planQuotaCache.Load("rt-h1")
	if q := h1.(*protocol.RuntimePlanQuota); q.Provider != "zenmux" || len(q.Windows) != 2 {
		t.Fatalf("linked snapshot = %+v", q)
	}
	h2, ok := d.planQuotaCache.Load("rt-h2")
	if !ok {
		t.Fatal("removed-link runtime not cleared")
	}
	if q := h2.(*protocol.RuntimePlanQuota); len(q.Windows) != 0 {
		t.Fatalf("removed-link runtime carries windows: %+v", q)
	}
	// The custom profile runtime was never reported and is not linked:
	// nothing may be written for it (its row may belong to a BYO reporter).
	if _, ok := d.planQuotaCache.Load("rt-h2p"); ok {
		t.Fatal("never-reported profile runtime received a zenmux snapshot")
	}
	if _, ok := d.planQuotaCache.Load("rt-kimi"); ok {
		t.Fatal("kimi runtime received a zenmux snapshot")
	}
	if gotAuth != "Bearer zm-mgmt-key" {
		t.Fatalf("management api auth = %q", gotAuth)
	}
}

// Key configured but link empty: nothing is collected (the key alone never
// links every hermes runtime); previously-reported runtimes are cleared;
// never-reported ones are untouched.
func TestZenmuxLoop_KeyWithoutLinkCollectsNothing(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	seedZenmuxState(t, "hermes@ws-1")
	d := newZenmuxLinkTestDaemon()
	d.cfg = Config{
		ZenMuxManagementAPIKey:  "zm-mgmt-key",
		ZenMuxAPIBaseURL:        srv.URL,
		PlanQuotaZenMuxInterval: 10 * time.Millisecond,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.zenmuxPlanQuotaLoop(ctx)

	waitForQuotaCondition(t, "previously-reported runtime cleared", func() bool {
		_, ok := d.planQuotaCache.Load("rt-h1")
		return ok
	})
	time.Sleep(50 * time.Millisecond) // let a few ticks pass
	cancel()

	if hits.Load() != 0 {
		t.Fatalf("management api polled %d times with an empty link set", hits.Load())
	}
	h1, _ := d.planQuotaCache.Load("rt-h1")
	if q := h1.(*protocol.RuntimePlanQuota); len(q.Windows) != 0 {
		t.Fatalf("cleared runtime carries windows: %+v", q)
	}
	if _, ok := d.planQuotaCache.Load("rt-h2"); ok {
		t.Fatal("never-reported runtime received a marker with empty link")
	}
}

// Link + key both gone: the loop still runs the state-driven clear (that is
// how a full removal takes effect), and polls nothing.
func TestZenmuxLoop_FullRemovalStillClears(t *testing.T) {
	seedZenmuxState(t, "hermes@ws-1")
	d := newZenmuxLinkTestDaemon() // no key, no link

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.zenmuxPlanQuotaLoop(ctx)

	waitForQuotaCondition(t, "cleared without key", func() bool {
		_, ok := d.planQuotaCache.Load("rt-h1")
		return ok
	})
	cancel()
	if _, ok := d.planQuotaCache.Load("rt-h2"); ok {
		t.Fatal("never-reported runtime cleared on full removal")
	}
}
