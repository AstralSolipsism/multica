package handler

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func adaptSnapshot(status string, updated time.Time) *protocol.ThinkingAdaptSnapshot {
	return &protocol.ThinkingAdaptSnapshot{
		Status:        status,
		ActiveSource:  "opencode-free",
		LastLatencyMS: 290,
		DecisionsOK:   8,
		Since:         updated.Add(-time.Hour),
		UpdatedAt:     updated,
	}
}

// fakeThinkingAdaptStore mirrors fakeMachineMetricsStore.
type fakeThinkingAdaptStore struct {
	available bool
	err       error
	calls     int
	stored    map[MachineRef]*protocol.ThinkingAdaptSnapshot
}

func (f *fakeThinkingAdaptStore) Available() bool { return f.available }

func (f *fakeThinkingAdaptStore) PutIfNewer(_ context.Context, ref MachineRef, snap *protocol.ThinkingAdaptSnapshot) (MachineMetricsPutResult, string, error) {
	f.calls++
	if f.err != nil {
		return MachineMetricsDropped, "", f.err
	}
	if f.stored == nil {
		f.stored = map[MachineRef]*protocol.ThinkingAdaptSnapshot{}
	}
	if cur, ok := f.stored[ref]; ok && !snap.UpdatedAt.After(cur.UpdatedAt) {
		return MachineMetricsDropped, contentKey(cur), nil
	}
	f.stored[ref] = snap
	return MachineMetricsChanged, contentKey(snap), nil
}

func (f *fakeThinkingAdaptStore) GetBatch(_ context.Context, refs []MachineRef) map[MachineRef]*protocol.ThinkingAdaptSnapshot {
	out := map[MachineRef]*protocol.ThinkingAdaptSnapshot{}
	for _, ref := range refs {
		if s, ok := f.stored[ref]; ok {
			out[ref] = s
		}
	}
	return out
}

func contentKey(s *protocol.ThinkingAdaptSnapshot) string {
	return fmt.Sprintf("%s|%s|%d|%d|%d", s.Status, s.ActiveSource, s.DecisionsOK, s.DecisionsFallback, s.LastLatencyMS)
}

// TestValidateThinkingAdapt pins the ingress gate: known statuses pass, an
// unknown status / missing or far-future updated_at is dropped.
func TestValidateThinkingAdapt(t *testing.T) {
	now := time.Now()
	for _, status := range []string{jev.StatusIdle, jev.StatusAvailable, jev.StatusDegraded, jev.StatusUnavailable} {
		if err := validateThinkingAdapt(adaptSnapshot(status, now), now); err != nil {
			t.Fatalf("status %q rejected: %v", status, err)
		}
	}
	if err := validateThinkingAdapt(adaptSnapshot("bogus", now), now); err == nil {
		t.Fatal("unknown status accepted")
	}
	if err := validateThinkingAdapt(adaptSnapshot(jev.StatusIdle, time.Time{}), now); err == nil {
		t.Fatal("missing updated_at accepted")
	}
	if err := validateThinkingAdapt(adaptSnapshot(jev.StatusIdle, now.Add(hostMetricsMaxFutureSkew+time.Minute)), now); err == nil {
		t.Fatal("far-future updated_at accepted")
	}
	// active_source must look like a source name: a modified daemon must not
	// store arbitrary text (URLs, prose) that every workspace member reads back.
	for _, source := range []string{"", "opencode-free", "self-hosted", "dashscope"} {
		snap := adaptSnapshot(jev.StatusAvailable, now)
		snap.ActiveSource = source
		if err := validateThinkingAdapt(snap, now); err != nil {
			t.Fatalf("source %q rejected: %v", source, err)
		}
	}
	for _, source := range []string{"https://evil.example/x", "SOURCE", "a b", "x/y", strings.Repeat("a", 65)} {
		snap := adaptSnapshot(jev.StatusAvailable, now)
		snap.ActiveSource = source
		if err := validateThinkingAdapt(snap, now); err == nil {
			t.Fatalf("source %q accepted", source)
		}
	}
}

// TestStoreHeartbeatThinkingAdapt pins the non-fatal heartbeat contract:
// invalid input, empty daemon id, unavailable store, and backend errors are
// swallowed; a content change publishes runtime:telemetry_updated while a
// pure freshness refresh (same status/source) does not.
func TestStoreHeartbeatThinkingAdapt(t *testing.T) {
	now := time.Now()

	newHandler := func(store ThinkingAdaptStore) (*Handler, *[]string) {
		bus := events.New()
		var published []string
		bus.SubscribeAll(func(event events.Event) { published = append(published, event.Type) })
		return &Handler{
			Bus:                  bus,
			ThinkingAdaptStore:   store,
			thinkingAdaptPublish: newHostMetricsPublishTracker(),
		}, &published
	}

	t.Run("nil snapshot and empty daemon id skip the store", func(t *testing.T) {
		store := &fakeThinkingAdaptStore{available: true}
		h, published := newHandler(store)
		h.storeHeartbeatThinkingAdapt(context.Background(), "ws", "d", nil)
		h.storeHeartbeatThinkingAdapt(context.Background(), "ws", "", adaptSnapshot(jev.StatusIdle, now))
		if store.calls != 0 || len(*published) != 0 {
			t.Fatalf("calls=%d published=%v, want none", store.calls, *published)
		}
	})

	t.Run("no redis wired is silent", func(t *testing.T) {
		h, published := newHandler(NewNoopThinkingAdaptStore())
		h.storeHeartbeatThinkingAdapt(context.Background(), "ws", "d", adaptSnapshot(jev.StatusIdle, now))
		if len(*published) != 0 {
			t.Fatalf("published=%v, want none", *published)
		}
	})

	t.Run("invalid snapshot dropped silently", func(t *testing.T) {
		store := &fakeThinkingAdaptStore{available: true}
		h, published := newHandler(store)
		h.storeHeartbeatThinkingAdapt(context.Background(), "ws", "d", adaptSnapshot("bogus", now))
		if store.calls != 0 || len(*published) != 0 {
			t.Fatalf("calls=%d published=%v, want none", store.calls, *published)
		}
	})

	t.Run("content change publishes, freshness refresh does not", func(t *testing.T) {
		store := &fakeThinkingAdaptStore{available: true}
		h, published := newHandler(store)
		ctx := context.Background()

		h.storeHeartbeatThinkingAdaptAt(ctx, "ws", "d", adaptSnapshot(jev.StatusIdle, now), now)
		if len(*published) != 1 || (*published)[0] != protocol.EventRuntimeTelemetryUpdated {
			t.Fatalf("published=%v, want one telemetry event", *published)
		}
		// Same content, newer updated_at: refresh only.
		h.storeHeartbeatThinkingAdaptAt(ctx, "ws", "d", adaptSnapshot(jev.StatusIdle, now.Add(15*time.Second)), now.Add(15*time.Second))
		if len(*published) != 1 {
			t.Fatalf("freshness refresh published: %v", *published)
		}
		// Status flip: content change.
		h.storeHeartbeatThinkingAdaptAt(ctx, "ws", "d", adaptSnapshot(jev.StatusDegraded, now.Add(30*time.Second)), now.Add(30*time.Second))
		if len(*published) != 2 {
			t.Fatalf("status change not published: %v", *published)
		}
	})

	// Latency alone is broadcast-worthy: a probe that only moves
	// last_latency_ms must still notify clients (§9 renders latency).
	t.Run("latency-only change publishes", func(t *testing.T) {
		store := &fakeThinkingAdaptStore{available: true}
		h, published := newHandler(store)
		ctx := context.Background()

		h.storeHeartbeatThinkingAdaptAt(ctx, "ws", "d", adaptSnapshot(jev.StatusAvailable, now), now)
		if len(*published) != 1 {
			t.Fatalf("first beat published=%v, want one", *published)
		}
		slower := adaptSnapshot(jev.StatusAvailable, now.Add(15*time.Second))
		slower.LastLatencyMS = 910
		h.storeHeartbeatThinkingAdaptAt(ctx, "ws", "d", slower, now.Add(15*time.Second))
		if len(*published) != 2 {
			t.Fatalf("latency-only change not published: %v", *published)
		}
	})

	t.Run("store error swallowed", func(t *testing.T) {
		store := &fakeThinkingAdaptStore{available: true, err: errors.New("redis down")}
		h, published := newHandler(store)
		h.storeHeartbeatThinkingAdapt(context.Background(), "ws", "d", adaptSnapshot(jev.StatusIdle, now))
		if len(*published) != 0 {
			t.Fatalf("published=%v, want none", *published)
		}
	})
}

// TestThinkingAdaptBroadcastIsolatedFromHostMetrics pins the review's
// shared-throttle bug: alternating host-metrics and thinking_adapt beats with
// UNCHANGED content must not re-broadcast — each stream keeps its own
// publish tracker, so neither sees the other's content key as a change.
func TestThinkingAdaptBroadcastIsolatedFromHostMetrics(t *testing.T) {
	now := time.Now()
	metricsStore := &fakeMachineMetricsStore{available: true}
	adaptStore := &fakeThinkingAdaptStore{available: true}
	bus := events.New()
	var published []string
	bus.SubscribeAll(func(event events.Event) { published = append(published, event.Type) })
	h := &Handler{
		Bus:                  bus,
		MachineMetricsStore:  metricsStore,
		ThinkingAdaptStore:   adaptStore,
		hostMetricsPublish:   newHostMetricsPublishTracker(),
		thinkingAdaptPublish: newHostMetricsPublishTracker(),
	}
	ctx := context.Background()

	cpu, mem := 42.0, 68.0
	for i := 1; i <= 8; i++ {
		at := now.Add(time.Duration(i) * 15 * time.Second)
		h.storeHeartbeatMetricsAt(ctx, "ws", "d", hostMetricsSample(&cpu, &mem, at.Unix()), at)
		h.storeHeartbeatThinkingAdaptAt(ctx, "ws", "d", adaptSnapshot(jev.StatusAvailable, at), at)
	}
	// One announcement per stream for its first content; nothing since.
	if len(published) != 2 {
		t.Fatalf("published=%d events over 8 unchanged cycles, want 2 (one per stream)", len(published))
	}
}

// TestRedisThinkingAdaptStore pins the Redis contract against a real Redis
// (REDIS_TEST_URL): write, real TTL expiry, older never overwrites newer,
// an unchanged snapshot still renews the TTL, timezone offsets order
// correctly, and the content-key outcomes.
func TestRedisThinkingAdaptStore(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisThinkingAdaptStore(rdb)
	ctx := context.Background()
	ref := MachineRef{WorkspaceID: "ws-1", DaemonID: "daemon-a"}

	t1 := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	t2 := t1.Add(15 * time.Second)

	result, key, err := store.PutIfNewer(ctx, ref, adaptSnapshot(jev.StatusIdle, t1))
	if err != nil || result != MachineMetricsChanged {
		t.Fatalf("first put = %v, %v; want changed", result, err)
	}
	if key != "idle|opencode-free|8|0|290" {
		t.Fatalf("first put key = %q", key)
	}

	// The write set a real TTL inside the configured window.
	ttl, err := rdb.TTL(ctx, thinkingAdaptKey(ref)).Result()
	if err != nil || ttl <= 0 || ttl > thinkingAdaptTTL {
		t.Fatalf("ttl after first put = %v, %v; want (0, %v]", ttl, err, thinkingAdaptTTL)
	}

	// Older sample must not overwrite the newer one.
	result, _, err = store.PutIfNewer(ctx, ref, adaptSnapshot(jev.StatusAvailable, t1.Add(-time.Minute)))
	if err != nil || result != MachineMetricsDropped {
		t.Fatalf("older put = %v, %v; want dropped", result, err)
	}
	got := store.GetBatch(ctx, []MachineRef{ref})[ref]
	if got == nil || got.Status != jev.StatusIdle {
		t.Fatalf("older sample overwrote newer: %+v", got)
	}

	// The SAME snapshot (unchanged updated_at) renews the TTL: without this,
	// the key lapses 90s after the last snapshot CHANGE and an online daemon
	// flickers to "not reported" between changes.
	result, _, err = store.PutIfNewer(ctx, ref, adaptSnapshot(jev.StatusIdle, t1))
	if err != nil || result != MachineMetricsRefreshed {
		t.Fatalf("equal put = %v, %v; want refreshed", result, err)
	}
	ttl, err = rdb.TTL(ctx, thinkingAdaptKey(ref)).Result()
	if err != nil || ttl <= 0 || ttl > thinkingAdaptTTL {
		t.Fatalf("ttl after equal put = %v, %v; want renewed into (0, %v]", ttl, err, thinkingAdaptTTL)
	}

	// Newer sample with the same content: refresh, no broadcast-worthy change.
	result, _, err = store.PutIfNewer(ctx, ref, adaptSnapshot(jev.StatusIdle, t2))
	if err != nil || result != MachineMetricsRefreshed {
		t.Fatalf("refresh put = %v, %v; want refreshed", result, err)
	}

	// A non-UTC offset must not break ordering: the stored idle snapshot
	// carries a +08:00 updated_at; a UTC-stamped snapshot five minutes
	// LATER must win, and one five minutes EARLIER must lose.
	plus8 := time.FixedZone("plus8", 8*3600)
	result, _, err = store.PutIfNewer(ctx, ref, adaptSnapshot(jev.StatusAvailable, t2.Add(5*time.Minute).In(plus8)))
	if err != nil || result != MachineMetricsChanged {
		t.Fatalf("utc-after-local put = %v, %v; want changed", result, err)
	}
	if got := store.GetBatch(ctx, []MachineRef{ref})[ref]; got == nil || got.Status != jev.StatusAvailable {
		t.Fatalf("later utc sample lost against stored local-offset one: %+v", got)
	}
	result, _, err = store.PutIfNewer(ctx, ref, adaptSnapshot(jev.StatusDegraded, t2.Add(-5*time.Minute).In(plus8)))
	if err != nil || result != MachineMetricsDropped {
		t.Fatalf("utc-before-local put = %v, %v; want dropped", result, err)
	}

	// Real expiry: with a short test TTL the key actually lapses and reads
	// return nothing (an offline daemon stops being reported).
	short := &RedisThinkingAdaptStore{rdb: rdb, ttl: time.Second}
	if _, _, err := short.PutIfNewer(ctx, ref, adaptSnapshot(jev.StatusIdle, t2.Add(10*time.Minute))); err != nil {
		t.Fatalf("short-ttl put: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if got := store.GetBatch(ctx, []MachineRef{ref})[ref]; got == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("short-ttl key never expired")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// TestNoopThinkingAdaptStore pins the no-Redis default.
func TestNoopThinkingAdaptStore(t *testing.T) {
	store := NewNoopThinkingAdaptStore()
	if store.Available() {
		t.Fatal("noop store reports available")
	}
	result, key, err := store.PutIfNewer(context.Background(), MachineRef{WorkspaceID: "ws", DaemonID: "d"}, adaptSnapshot(jev.StatusIdle, time.Now()))
	if result != MachineMetricsDropped || key != "" || err != nil {
		t.Fatalf("noop put = %v, %q, %v", result, key, err)
	}
	if got := store.GetBatch(context.Background(), []MachineRef{{WorkspaceID: "ws", DaemonID: "d"}}); len(got) != 0 {
		t.Fatalf("noop get = %v", got)
	}
}
