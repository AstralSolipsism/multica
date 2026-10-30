package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func mediaNegotiated(capabilities []string) bool {
	for i := range capabilities {
		capabilities[i] = strings.TrimSpace(capabilities[i])
	}
	return slices.Contains(capabilities, protocol.DaemonCapabilityRPCV1) && slices.Contains(capabilities, protocol.DaemonCapabilityMediaJobsV1)
}

// The runtime row lock serializes inventories from different profiles and the
// resulting metadata projection. It does not serialize long-running generation.
func persistMediaReport(ctx context.Context, q *db.Queries, rt db.AgentRuntime, report *protocol.MediaExecutorReport, register bool) error {
	if report == nil {
		return nil
	}
	if err := protocol.ValidateMediaExecutorReport(report, time.Now()); err != nil {
		return err
	}
	if _, err := q.LockAgentRuntime(ctx, rt.ID); err != nil {
		return err
	}
	ids := make([]pgtype.UUID, 0, len(report.Executors))
	for _, e := range report.Executors {
		if rt.Provider != "media" && !(rt.Provider == "codex" && e.Provider == "codex") && !(rt.Provider == "antigravity" && e.Provider == "agy") {
			return fmt.Errorf("executor does not belong to runtime provider")
		}
		if e.QuotaRef.RuntimeID != "" && e.QuotaRef.RuntimeID != uuidToString(rt.ID) {
			return fmt.Errorf("quota reference outside runtime")
		}
		executorID := parseUUID(e.ExecutorID)
		ids = append(ids, executorID)
		quota := e.PlanQuota
		e.PlanQuota = nil // The newer-wins quota column is the sole authority.
		descriptor, _ := json.Marshal(e)
		quotaRef, _ := json.Marshal(e.QuotaRef)
		if register {
			_, err := q.UpsertMediaExecutor(ctx, db.UpsertMediaExecutorParams{
				WorkspaceID: rt.WorkspaceID, RuntimeID: rt.ID, DaemonID: rt.DaemonID.String,
				ExecutorID: executorID, CredentialScopeID: parseUUID(e.CredentialScopeID),
				Provider: e.Provider, Capability: e.Capability, DescriptorVersion: int32(e.DescriptorVersion),
				Descriptor: descriptor, QuotaRef: quotaRef, Readiness: string(e.Readiness),
				ObservedAt: e.ObservedAt, MaxConcurrency: int32(e.MaxConcurrency), ConnectionID: parseUUID(report.ConnectionID),
			})
			if err != nil {
				return fmt.Errorf("media registration identity or lease conflict: %w", err)
			}
		} else {
			n, err := q.RenewMediaExecutor(ctx, db.RenewMediaExecutorParams{
				WorkspaceID: rt.WorkspaceID, RuntimeID: rt.ID, DaemonID: rt.DaemonID.String,
				ExecutorID: executorID, CredentialScopeID: parseUUID(e.CredentialScopeID),
				Provider: e.Provider, Capability: e.Capability, Descriptor: descriptor, QuotaRef: quotaRef,
				Readiness: string(e.Readiness), ObservedAt: e.ObservedAt, MaxConcurrency: int32(e.MaxConcurrency),
				ConnectionID: parseUUID(report.ConnectionID),
			})
			if err != nil {
				return err
			}
			if n != 1 {
				return fmt.Errorf("media connection expired or not registered")
			}
		}
		if quota != nil {
			quota.Source = protocol.PlanQuotaSourceDaemon
			body, _ := json.Marshal(quota)
			var content map[string]any
			if err := json.Unmarshal(body, &content); err != nil {
				return err
			}
			delete(content, "observed_at")
			contentBody, _ := json.Marshal(content)
			if _, err := q.UpdateMediaExecutorQuota(ctx, db.UpdateMediaExecutorQuotaParams{
				WorkspaceID: rt.WorkspaceID, RuntimeID: rt.ID, ExecutorID: executorID,
				ConnectionID: parseUUID(report.ConnectionID), PlanQuota: body, Content: contentBody,
				ObservedAt: quota.ObservedAt, FreshnessBefore: quota.ObservedAt - planQuotaFreshnessThrottleSeconds,
			}); err != nil {
				return err
			}
		}
	}
	if err := q.RevokeMissingMediaExecutors(ctx, db.RevokeMissingMediaExecutorsParams{
		WorkspaceID: rt.WorkspaceID, RuntimeID: rt.ID, ConnectionID: parseUUID(report.ConnectionID), ExecutorIds: ids,
	}); err != nil {
		return err
	}
	rows, err := q.ListMediaExecutors(ctx, db.ListMediaExecutorsParams{WorkspaceID: rt.WorkspaceID, RuntimeID: rt.ID})
	if err != nil {
		return err
	}
	var meta struct {
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(rt.Metadata, &meta); err != nil {
		return err
	}
	caps := protocol.WithoutMediaCapabilities(meta.Capabilities)
	descriptors := make([]protocol.MediaExecutorDescriptor, 0, len(rows))
	for _, row := range rows {
		var e protocol.MediaExecutorDescriptor
		if err := json.Unmarshal(row.Descriptor, &e); err != nil {
			return err
		}
		e.Readiness = protocol.MediaReadiness(row.Readiness)
		if !row.ConnectionExpiresAt.Valid || !row.ConnectionExpiresAt.Time.After(time.Now()) {
			e.Readiness = protocol.MediaUnhealthy
		}
		if len(row.PlanQuota) > 0 {
			if err := json.Unmarshal(row.PlanQuota, &e.PlanQuota); err != nil {
				return err
			}
		}
		descriptors = append(descriptors, e)
		if e.Readiness == protocol.MediaReady && !slices.Contains(caps, e.Capability) {
			caps = append(caps, e.Capability)
		}
	}
	descriptorJSON, _ := json.Marshal(descriptors)
	capJSON, _ := json.Marshal(caps)
	return q.UpdateMediaRuntimeMetadata(ctx, db.UpdateMediaRuntimeMetadataParams{
		WorkspaceID: rt.WorkspaceID, RuntimeID: rt.ID, Descriptors: descriptorJSON, Capabilities: capJSON,
	})
}

func (h *Handler) heartbeatMedia(ctx context.Context, runtimeID string, report *protocol.MediaExecutorReport, capabilities, workspaceID, daemonID, ownerID string) error {
	if report == nil {
		return nil
	}
	if !mediaNegotiated(strings.Split(capabilities, ",")) {
		return fmt.Errorf("media-jobs-v1 and rpc-v1 required")
	}
	if err := protocol.ValidateMediaExecutorReport(report, time.Now()); err != nil {
		return err
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	q := h.Queries.WithTx(tx)
	rt, err := q.LockAgentRuntime(ctx, parseUUID(runtimeID))
	if err != nil {
		return err
	}
	if uuidToString(rt.WorkspaceID) != workspaceID || rt.DaemonID.String != daemonID || !rt.OwnerID.Valid || uuidToString(rt.OwnerID) != ownerID {
		return fmt.Errorf("media runtime ownership changed")
	}
	if err := persistMediaReport(ctx, q, rt, report, false); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (h *Handler) deregisterMedia(ctx context.Context, expected db.AgentRuntime, connectionID string) error {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	q := h.Queries.WithTx(tx)
	rt, err := q.LockAgentRuntime(ctx, expected.ID)
	if err != nil {
		return err
	}
	if rt.WorkspaceID != expected.WorkspaceID || rt.OwnerID != expected.OwnerID || rt.DaemonID != expected.DaemonID {
		return fmt.Errorf("media ownership changed")
	}
	if err := persistMediaReport(ctx, q, rt, &protocol.MediaExecutorReport{ConnectionID: connectionID, Executors: []protocol.MediaExecutorDescriptor{}}, false); err != nil {
		return err
	}
	rows, err := q.ListMediaExecutors(ctx, db.ListMediaExecutorsParams{WorkspaceID: rt.WorkspaceID, RuntimeID: rt.ID})
	if err != nil {
		return err
	}
	alive := false
	for _, row := range rows {
		if row.ConnectionExpiresAt.Valid && row.ConnectionExpiresAt.Time.After(time.Now()) {
			alive = true
			break
		}
	}
	if !alive {
		if err := q.SetAgentRuntimeOffline(ctx, rt.ID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
