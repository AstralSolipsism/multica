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

// MachineMetricsStore caches the latest host CPU/memory sample per
// (workspace, daemon). It exists so the heartbeat hot path can hand the
// sample to a TTL'd Redis key instead of touching the DB on every beat,
// mirroring LivenessStore. Samples are observational: a store failure must
// never fail a heartbeat, and the runtime list API treats a missing/expired
// entry as "no data" — there is deliberately NO DB fallback for host
// metrics, so a Redis outage degrades the UI to "not reported" rather than
// turning into high-frequency DB writes.
//
// Keys are scoped by (workspace id, daemon id), not daemon id alone: the
// daemon id is a machine-provided string that can collide (or be forged)
// across workspaces, and one workspace must never read or overwrite another
// workspace's sample.
type MachineMetricsStore interface {
	// Available reports whether the store is wired to a real backend. False
	// means callers should skip metrics handling entirely — the other
	// methods on a non-available store are no-ops.
	Available() bool

// PutIfNewer atomically records metrics when its CapturedAt is newer
	// than the stored sample's. It returns the put outcome and, crucially,
	// the STORED sample's rounded content key after the call — including
	// when nothing was written (same/older captured_at) — so the caller can
	// re-offer a throttle-deferred broadcast for the stored truth rather
	// than for whatever this beat happened to carry. Every runtime
	// heartbeat of one daemon carries the same sample (one sampler, one
	// captured_at per cycle), so the first beat of a cycle writes and the
	// remaining N-1 beats are no-ops — one Redis write per (workspace,
	// daemon) per sampling cycle.
	// Errors are returned so callers can log them; they must never be
	// propagated into a heartbeat failure.
	PutIfNewer(ctx context.Context, ref MachineRef, metrics *protocol.HostMetrics) (MachineMetricsPutResult, string, error)

	// GetBatch fetches the latest sample for many (workspace, daemon) refs
	// at once. The returned map contains an entry only for refs with a live
	// sample. Backend errors degrade to an empty map (callers render
	// "no data").
	GetBatch(ctx context.Context, refs []MachineRef) map[MachineRef]*protocol.HostMetrics
}

// MachineRef identifies the machine one host-metrics sample belongs to.
type MachineRef struct {
	WorkspaceID string
	DaemonID    string
}

// MachineMetricsPutResult is the outcome of one PutIfNewer call.
type MachineMetricsPutResult int

const (
	// MachineMetricsDropped means the incoming sample's captured_at was not
	// newer than the stored one; nothing was written. This is the common
	// case: N-1 of a daemon's N runtime heartbeats per cycle land here.
	MachineMetricsDropped MachineMetricsPutResult = iota
	// MachineMetricsRefreshed means the sample was stored but its rounded
	// percentage content equals the previous sample — a pure freshness
	// refresh that must not trigger a client broadcast.
	MachineMetricsRefreshed
	// MachineMetricsChanged means the sample was stored and its rounded
	// percentage content differs from the previous sample.
	MachineMetricsChanged
)

// noopMachineMetricsStore is the default — used whenever no Redis client is
// wired in. All methods are no-ops; Available() returns false so callers
// know to skip metrics work.
type noopMachineMetricsStore struct{}

// NewNoopMachineMetricsStore returns a MachineMetricsStore that always
// reports unavailable. Callers should default to this and swap in a real
// store at wire time.
func NewNoopMachineMetricsStore() MachineMetricsStore { return noopMachineMetricsStore{} }

func (noopMachineMetricsStore) Available() bool { return false }

func (noopMachineMetricsStore) PutIfNewer(_ context.Context, _ MachineRef, _ *protocol.HostMetrics) (MachineMetricsPutResult, string, error) {
	return MachineMetricsDropped, "", nil
}

func (noopMachineMetricsStore) GetBatch(_ context.Context, _ []MachineRef) map[MachineRef]*protocol.HostMetrics {
	return nil
}

// machineMetricsKeyPrefix is the Redis key prefix for daemon host metrics
// samples. Mirrors the namespacing used by the other runtime stores
// (mul:runtime:hb:*, mul:update:*).
const machineMetricsKeyPrefix = "mul:runtime:hostmetrics:"

func machineMetricsKey(ref MachineRef) string {
	return machineMetricsKeyPrefix + ref.WorkspaceID + ":" + ref.DaemonID
}

// machineMetricsTTL is how long a host metrics sample stays valid. The
// daemon attaches a fresh sample to every heartbeat (~15s), so — like the
// liveness TTL — 90s tolerates ~6 missed beats before the API stops
// reporting the machine's stats.
const machineMetricsTTL = 90 * time.Second

// machineMetricsPutScript atomically implements set-if-newer plus
// content-key reporting:
//
//	return {0, storedKey}  the stored sample's captured_at is >= the incoming
//	                       one — no write; storedKey still names the stored
//	                       content so the caller can re-offer a deferred
//	                       broadcast for it
//	return {1, newKey}     stored, rounded content unchanged (freshness only)
//	return {2, newKey}     stored, rounded content changed (first write too)
//
// The content key is "round(cpu)|round(mem)" with "-" for a nil metric —
// the same rounded-percentage comparison the publish tracker applies.
// KEYS[1] = the machine key; ARGV[1] = incoming captured_at (unix seconds),
// ARGV[2] = incoming sample JSON, ARGV[3] = TTL seconds.
// A corrupt stored value is treated as absent so one bad payload cannot
// wedge the key until TTL.
var machineMetricsPutScript = redis.NewScript(`
local function keyof(cpu, mem)
  local function r(v)
    if v == nil then return "-" end
    return tostring(math.floor(tonumber(v) + 0.5))
  end
  return r(cpu) .. "|" .. r(mem)
end
local cur = redis.call('GET', KEYS[1])
local oldCpu, oldMem, oldCap
if cur then
  local ok, dec = pcall(cjson.decode, cur)
  if ok and type(dec) == 'table' then
    oldCap = tonumber(dec.captured_at)
    oldCpu = dec.cpu_percent
    oldMem = dec.memory_percent
  end
end
if oldCap ~= nil and tonumber(ARGV[1]) <= oldCap then
  return {0, keyof(oldCpu, oldMem)}
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
local dec = cjson.decode(ARGV[2])
local newKey = keyof(dec.cpu_percent, dec.memory_percent)
if oldCap == nil then
  return {2, newKey}
end
if newKey ~= keyof(oldCpu, oldMem) then
  return {2, newKey}
end
return {1, newKey}
`)

// RedisMachineMetricsStore stores one TTL'd JSON key per (workspace,
// daemon), written at most once per daemon sampling cycle.
type RedisMachineMetricsStore struct {
	rdb *redis.Client
}

func NewRedisMachineMetricsStore(rdb *redis.Client) *RedisMachineMetricsStore {
	return &RedisMachineMetricsStore{rdb: rdb}
}

func (s *RedisMachineMetricsStore) Available() bool { return s != nil && s.rdb != nil }

func (s *RedisMachineMetricsStore) PutIfNewer(ctx context.Context, ref MachineRef, metrics *protocol.HostMetrics) (MachineMetricsPutResult, string, error) {
	if !s.Available() {
		return MachineMetricsDropped, "", errors.New("redis machine metrics store: unavailable")
	}
	if ref.WorkspaceID == "" || ref.DaemonID == "" {
		return MachineMetricsDropped, "", errors.New("redis machine metrics store: empty workspace or daemon id")
	}
	if metrics == nil {
		return MachineMetricsDropped, "", errors.New("redis machine metrics store: nil metrics")
	}
	body, err := json.Marshal(metrics)
	if err != nil {
		return MachineMetricsDropped, "", fmt.Errorf("machine metrics marshal: %w", err)
	}
	out, err := machineMetricsPutScript.Run(ctx, s.rdb,
		[]string{machineMetricsKey(ref)},
		metrics.CapturedAt, string(body), int(machineMetricsTTL/time.Second),
	).Slice()
	if err != nil {
		return MachineMetricsDropped, "", fmt.Errorf("machine metrics put: %w", err)
	}
	code, _ := out[0].(int64)
	storedKey, _ := out[1].(string)
	switch code {
	case 1:
		return MachineMetricsRefreshed, storedKey, nil
	case 2:
		return MachineMetricsChanged, storedKey, nil
	default:
		return MachineMetricsDropped, storedKey, nil
	}
}

func (s *RedisMachineMetricsStore) GetBatch(ctx context.Context, refs []MachineRef) map[MachineRef]*protocol.HostMetrics {
	out := make(map[MachineRef]*protocol.HostMetrics, len(refs))
	if !s.Available() || len(refs) == 0 {
		return out
	}
	keys := make([]string, len(refs))
	for i, ref := range refs {
		keys[i] = machineMetricsKey(ref)
	}
	values, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		slog.Warn("machine metrics mget failed; reporting no host metrics",
			"error", err, "count", len(keys))
		return map[MachineRef]*protocol.HostMetrics{}
	}
	for i, ref := range refs {
		raw, ok := values[i].(string)
		if !ok || raw == "" {
			continue
		}
		var sample protocol.HostMetrics
		if err := json.Unmarshal([]byte(raw), &sample); err != nil {
			slog.Warn("machine metrics value undecodable; skipping",
				"error", err, "workspace_id", ref.WorkspaceID, "daemon_id", ref.DaemonID)
			continue
		}
		out[ref] = &sample
	}
	return out
}
