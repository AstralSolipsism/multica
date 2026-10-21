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

// ThinkingAdaptStore caches the latest Jev health snapshot per (workspace,
// daemon), mirroring MachineMetricsStore: TTL'd Redis key on the heartbeat
// hot path, no DB fallback, observational (a store failure never fails a
// heartbeat). See runtime_host_metrics_store.go for the shared rationale.
type ThinkingAdaptStore interface {
	Available() bool
	PutIfNewer(ctx context.Context, ref MachineRef, snap *protocol.ThinkingAdaptSnapshot) (MachineMetricsPutResult, string, error)
	GetBatch(ctx context.Context, refs []MachineRef) map[MachineRef]*protocol.ThinkingAdaptSnapshot
}

// noopThinkingAdaptStore is the default: no Redis wired, all no-ops.
type noopThinkingAdaptStore struct{}

func NewNoopThinkingAdaptStore() ThinkingAdaptStore { return noopThinkingAdaptStore{} }

func (noopThinkingAdaptStore) Available() bool { return false }

func (noopThinkingAdaptStore) PutIfNewer(_ context.Context, _ MachineRef, _ *protocol.ThinkingAdaptSnapshot) (MachineMetricsPutResult, string, error) {
	return MachineMetricsDropped, "", nil
}

func (noopThinkingAdaptStore) GetBatch(_ context.Context, _ []MachineRef) map[MachineRef]*protocol.ThinkingAdaptSnapshot {
	return nil
}

const thinkingAdaptKeyPrefix = "mul:runtime:thinkingadapt:"

func thinkingAdaptKey(ref MachineRef) string {
	return thinkingAdaptKeyPrefix + ref.WorkspaceID + ":" + ref.DaemonID
}

// thinkingAdaptTTL mirrors machineMetricsTTL: the daemon attaches a fresh
// snapshot to every heartbeat (~15s), so 90s tolerates ~6 missed beats.
const thinkingAdaptTTL = 90 * time.Second

// thinkingAdaptPutScript is set-if-newer plus content-key reporting, keyed
// on updated_at (the snapshot's own last-change time, RFC3339) instead of
// captured_at. Content key is "status|source|ok|fallback" — the fields a UI
// renders; latency and timestamps change every beat and must not trigger a
// broadcast. Returns match machineMetricsPutScript: {0,storedKey} no write,
// {1,newKey} freshness only, {2,newKey} content changed.
var thinkingAdaptPutScript = redis.NewScript(`
local cur = redis.call('GET', KEYS[1])
local oldUpdated, oldStatus, oldSource, oldOK, oldFallback
if cur then
  local ok, dec = pcall(cjson.decode, cur)
  if ok and type(dec) == 'table' then
    oldUpdated = dec.updated_at
    oldStatus = dec.status
    oldSource = dec.active_source
    oldOK = dec.decisions_ok
    oldFallback = dec.decisions_fallback
  end
end
if oldUpdated ~= nil and ARGV[1] <= oldUpdated then
  return {0, oldStatus .. "|" .. tostring(oldSource or '-') .. "|" .. tostring(oldOK or 0) .. "|" .. tostring(oldFallback or 0)}
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
local dec = cjson.decode(ARGV[2])
local newKey = tostring(dec.status) .. "|" .. tostring(dec.active_source or '-') .. "|" .. tostring(dec.decisions_ok or 0) .. "|" .. tostring(dec.decisions_fallback or 0)
if oldUpdated == nil then
  return {2, newKey}
end
if newKey ~= (oldStatus .. "|" .. tostring(oldSource or '-') .. "|" .. tostring(oldOK or 0) .. "|" .. tostring(oldFallback or 0)) then
  return {2, newKey}
end
return {1, newKey}
`)

// RedisThinkingAdaptStore stores one TTL'd JSON key per (workspace, daemon).
type RedisThinkingAdaptStore struct {
	rdb redis.UniversalClient
}

func NewRedisThinkingAdaptStore(rdb redis.UniversalClient) *RedisThinkingAdaptStore {
	return &RedisThinkingAdaptStore{rdb: rdb}
}

func (s *RedisThinkingAdaptStore) Available() bool { return s != nil && s.rdb != nil }

func (s *RedisThinkingAdaptStore) PutIfNewer(ctx context.Context, ref MachineRef, snap *protocol.ThinkingAdaptSnapshot) (MachineMetricsPutResult, string, error) {
	if !s.Available() {
		return MachineMetricsDropped, "", errors.New("redis thinking adapt store: unavailable")
	}
	if ref.WorkspaceID == "" || ref.DaemonID == "" {
		return MachineMetricsDropped, "", errors.New("redis thinking adapt store: empty workspace or daemon id")
	}
	if snap == nil {
		return MachineMetricsDropped, "", errors.New("redis thinking adapt store: nil snapshot")
	}
	if snap.UpdatedAt.IsZero() {
		return MachineMetricsDropped, "", errors.New("redis thinking adapt store: missing updated_at")
	}
	body, err := json.Marshal(snap)
	if err != nil {
		return MachineMetricsDropped, "", fmt.Errorf("thinking adapt marshal: %w", err)
	}
	out, err := thinkingAdaptPutScript.Run(ctx, s.rdb,
		[]string{thinkingAdaptKey(ref)},
		snap.UpdatedAt.UTC().Format(time.RFC3339Nano), string(body), int(thinkingAdaptTTL/time.Second),
	).Slice()
	if err != nil {
		return MachineMetricsDropped, "", fmt.Errorf("thinking adapt put: %w", err)
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

func (s *RedisThinkingAdaptStore) GetBatch(ctx context.Context, refs []MachineRef) map[MachineRef]*protocol.ThinkingAdaptSnapshot {
	out := make(map[MachineRef]*protocol.ThinkingAdaptSnapshot, len(refs))
	if !s.Available() || len(refs) == 0 {
		return out
	}
	pipe := s.rdb.Pipeline()
	values := make([]*redis.StringCmd, len(refs))
	for i, ref := range refs {
		values[i] = pipe.Get(ctx, thinkingAdaptKey(ref))
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		slog.Warn("thinking adapt pipeline failed; reporting available snapshots",
			"error", err, "count", len(refs))
	}
	for i, ref := range refs {
		raw, err := values[i].Result()
		if err != nil || raw == "" {
			continue
		}
		var snap protocol.ThinkingAdaptSnapshot
		if err := json.Unmarshal([]byte(raw), &snap); err != nil {
			slog.Warn("thinking adapt value undecodable; skipping",
				"error", err, "workspace_id", ref.WorkspaceID, "daemon_id", ref.DaemonID)
			continue
		}
		out[ref] = &snap
	}
	return out
}
