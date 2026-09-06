package daemon

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// A daemon with two workspaces, one hermes runtime each, plus one kimi
// runtime — the mixed-source fixture for the link tests.
func newZenmuxLinkTestDaemon() *Daemon {
	return &Daemon{
		cfg:    Config{},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		workspaces: map[string]*workspaceState{
			"ws-1": {runtimeIDs: []string{"rt-h1"}},
			"ws-2": {runtimeIDs: []string{"rt-h2", "rt-kimi"}},
		},
		runtimeIndex: map[string]Runtime{
			"rt-h1":   {ID: "rt-h1", Provider: "hermes"},
			"rt-h2":   {ID: "rt-h2", Provider: "hermes"},
			"rt-kimi": {ID: "rt-kimi", Provider: "kimi"},
		},
	}
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
		if !set.linked("hermes", "any-ws") || set.linked("kimi", "any-ws") {
			t.Fatal("linked() wrong for all-hermes")
		}
	})
	t.Run("per-workspace entries", func(t *testing.T) {
		set, err := parseZenMuxLink(" hermes@ws-1 , hermes@ws-2 ")
		if err != nil {
			t.Fatal(err)
		}
		if !set.linked("hermes", "ws-1") || !set.linked("hermes", "ws-2") || set.linked("hermes", "ws-3") {
			t.Fatal("linked() wrong for per-workspace set")
		}
	})
	t.Run("rejects non-hermes providers and malformed entries", func(t *testing.T) {
		for _, bad := range []string{"codex", "kimi@ws-1", "hermes@", "@ws-1", "her", "hermesx"} {
			if _, err := parseZenMuxLink(bad); err == nil {
				t.Fatalf("%q parsed without error", bad)
			}
		}
	})
}

func TestZenmuxLinkedRuntimeIDs(t *testing.T) {
	d := newZenmuxLinkTestDaemon()

	all, _ := parseZenMuxLink("hermes")
	if got := d.zenmuxLinkedRuntimeIDs(all); len(got) != 2 || got[0] != "rt-h1" || got[1] != "rt-h2" {
		t.Fatalf("all-hermes targets = %v", got)
	}

	ws1, _ := parseZenMuxLink("hermes@ws-1")
	if got := d.zenmuxLinkedRuntimeIDs(ws1); len(got) != 1 || got[0] != "rt-h1" {
		t.Fatalf("ws-1 targets = %v", got)
	}

	none, _ := parseZenMuxLink("")
	if got := d.zenmuxLinkedRuntimeIDs(none); len(got) != 0 {
		t.Fatalf("empty link targets = %v", got)
	}
}

// A runtime whose association was removed gets an explicit empty snapshot on
// its next heartbeat, flipping the UI back to "not reported" instead of
// showing the mismatched source until the 24h staleness window.
func TestClearUnlinkedZenMuxQuotas(t *testing.T) {
	d := newZenmuxLinkTestDaemon()
	ws1, _ := parseZenMuxLink("hermes@ws-1")
	d.clearUnlinkedZenMuxQuotas(ws1)

	if _, ok := d.planQuotaCache.Load("rt-h1"); ok {
		t.Fatal("linked runtime received a clear snapshot")
	}
	cached, ok := d.planQuotaCache.Load("rt-h2")
	if !ok {
		t.Fatal("unlinked hermes runtime not cleared")
	}
	quota := cached.(*protocol.RuntimePlanQuota)
	if quota.Provider != "zenmux" || len(quota.Windows) != 0 || quota.Source != protocol.PlanQuotaSourceDaemon {
		t.Fatalf("clear snapshot = %+v", quota)
	}
	if _, ok := d.planQuotaCache.Load("rt-kimi"); ok {
		t.Fatal("kimi runtime received a zenmux clear snapshot")
	}
}

// End-to-end through the loop with a mocked Management API: the linked
// workspace's hermes runtime gets the real snapshot, the unlinked one gets
// cleared, and no other provider is touched.
func TestZenmuxLoop_MixedSources(t *testing.T) {
	var gotAuth string
	srv := newZenmuxTestServer(t, 0, zenmuxDetailJSON, &gotAuth)
	defer srv.Close()

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
	cancel()

	h1, _ := d.planQuotaCache.Load("rt-h1")
	if q := h1.(*protocol.RuntimePlanQuota); q.Provider != "zenmux" || len(q.Windows) != 2 {
		t.Fatalf("linked snapshot = %+v", q)
	}
	h2, ok := d.planQuotaCache.Load("rt-h2")
	if !ok {
		t.Fatal("unlinked hermes runtime not cleared")
	}
	if q := h2.(*protocol.RuntimePlanQuota); len(q.Windows) != 0 {
		t.Fatalf("unlinked runtime carries windows: %+v", q)
	}
	if _, ok := d.planQuotaCache.Load("rt-kimi"); ok {
		t.Fatal("kimi runtime received a zenmux snapshot")
	}
	if gotAuth != "Bearer zm-mgmt-key" {
		t.Fatalf("management api auth = %q", gotAuth)
	}
}

// Key configured but link empty: nothing is collected (the key alone never
// links every hermes runtime) and every hermes runtime is actively cleared.
func TestZenmuxLoop_KeyWithoutLinkCollectsNothing(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	d := newZenmuxLinkTestDaemon()
	d.cfg = Config{
		ZenMuxManagementAPIKey:  "zm-mgmt-key",
		ZenMuxAPIBaseURL:        srv.URL,
		PlanQuotaZenMuxInterval: 10 * time.Millisecond,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.zenmuxPlanQuotaLoop(ctx)

	waitForQuotaCondition(t, "unlinked runtimes cleared", func() bool {
		_, ok1 := d.planQuotaCache.Load("rt-h1")
		_, ok2 := d.planQuotaCache.Load("rt-h2")
		return ok1 && ok2
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
}
