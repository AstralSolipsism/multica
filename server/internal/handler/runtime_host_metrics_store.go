package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// MachineMetricsStore caches the latest host CPU/memory sample per daemon.
// It exists so the heartbeat hot path can hand the sample to a TTL'd Redis
// key instead of touching the DB on every beat, mirroring LivenessStore.
// Samples are observational: a store failure must never fail a heartbeat,
// and the runtime list API treats a missing/expired entry as "no data".
//
// Keys are scoped by daemon id (not runtime id) because the sample describes
// the host machine, which every runtime on that daemon shares.
type MachineMetricsStore interface {
	// Available reports whether the store is wired to a real backend. False
	// means callers should skip metrics handling entirely — the other
	// methods on a non-available store are no-ops.
	Available() bool

	// Put records the latest host metrics sample for daemonID with the
	// store's fixed TTL. Errors are returned so callers can log them; they
	// must never be propagated into a heartbeat failure.
	Put(ctx context.Context, daemonID string, metrics *protocol.HostMetrics) error

	// GetBatch fetches the latest sample for many daemon IDs at once. The
	// returned map contains an entry only for daemons with a live sample.
	// Backend errors degrade to an empty map (callers render no data).
	GetBatch(ctx context.Context, daemonIDs []string) map[string]*protocol.HostMetrics
}

// noopMachineMetricsStore is the default — used whenever no Redis client is
// wired in. All methods are no-ops; Available() returns false so callers
// know to skip metrics work.
type noopMachineMetricsStore struct{}

// NewNoopMachineMetricsStore returns a MachineMetricsStore that always
// reports unavailable. Callers should default to this and swap in a real
// store at wire time.
func NewNoopMachineMetricsStore() MachineMetricsStore { return noopMachineMetricsStore{} }

func (noopMachineMetricsStore) Available() bool { return false }

func (noopMachineMetricsStore) Put(_ context.Context, _ string, _ *protocol.HostMetrics) error {
	return nil
}

func (noopMachineMetricsStore) GetBatch(_ context.Context, _ []string) map[string]*protocol.HostMetrics {
	return nil
}

// machineMetricsKeyPrefix is the Redis key prefix for daemon host metrics
// samples. Mirrors the namespacing used by the other runtime stores
// (mul:runtime:hb:*, mul:update:*).
const machineMetricsKeyPrefix = "mul:runtime:hostmetrics:"

func machineMetricsKey(daemonID string) string {
	return machineMetricsKeyPrefix + daemonID
}

// machineMetricsTTL is how long a host metrics sample stays valid. The
// daemon attaches a fresh sample to every heartbeat (~15s), so — like the
// liveness TTL — 90s tolerates ~6 missed beats before the API stops
// reporting the machine's stats.
const machineMetricsTTL = 90 * time.Second

// RedisMachineMetricsStore writes one TTL'd JSON key per daemon heartbeat
// that carries a metrics sample.
type RedisMachineMetricsStore struct {
	rdb *redis.Client
}

func NewRedisMachineMetricsStore(rdb *redis.Client) *RedisMachineMetricsStore {
	return &RedisMachineMetricsStore{rdb: rdb}
}

func (s *RedisMachineMetricsStore) Available() bool { return s != nil && s.rdb != nil }

func (s *RedisMachineMetricsStore) Put(ctx context.Context, daemonID string, metrics *protocol.HostMetrics) error {
	if !s.Available() {
		return errors.New("redis machine metrics store: unavailable")
	}
	if daemonID == "" {
		return errors.New("redis machine metrics store: empty daemon id")
	}
	if metrics == nil {
		return errors.New("redis machine metrics store: nil metrics")
	}
	body, err := json.Marshal(metrics)
	if err != nil {
		return fmt.Errorf("machine metrics marshal: %w", err)
	}
	if err := s.rdb.Set(ctx, machineMetricsKey(daemonID), body, machineMetricsTTL).Err(); err != nil {
		return fmt.Errorf("machine metrics put: %w", err)
	}
	return nil
}

func (s *RedisMachineMetricsStore) GetBatch(ctx context.Context, daemonIDs []string) map[string]*protocol.HostMetrics {
	out := make(map[string]*protocol.HostMetrics, len(daemonIDs))
	if !s.Available() || len(daemonIDs) == 0 {
		return out
	}
	keys := make([]string, len(daemonIDs))
	for i, id := range daemonIDs {
		keys[i] = machineMetricsKey(id)
	}
	values, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		slog.Warn("machine metrics mget failed; reporting no host metrics",
			"error", err, "count", len(keys))
		return map[string]*protocol.HostMetrics{}
	}
	for i, id := range daemonIDs {
		raw, ok := values[i].(string)
		if !ok || raw == "" {
			continue
		}
		var sample protocol.HostMetrics
		if err := json.Unmarshal([]byte(raw), &sample); err != nil {
			slog.Warn("machine metrics value undecodable; skipping",
				"error", err, "daemon_id", id)
			continue
		}
		out[id] = &sample
	}
	return out
}
