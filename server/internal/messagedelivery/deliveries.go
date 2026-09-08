package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// ---- delivery records API ----

// ListRoutes returns a rule set (workspace-scoped).
func (s *Service) ListRoutes(ctx context.Context, workspaceID, autopilotID pgtype.UUID) ([]db.LabrastroMessageRoute, error) {
	return s.Queries.ListLabrastroMessageRoutesByAutopilot(ctx, db.ListLabrastroMessageRoutesByAutopilotParams{
		WorkspaceID: workspaceID,
		AutopilotID: autopilotID,
	})
}

// ListDeliveries returns the record page for one automation. Rows are the
// projection (no snapshots) so a listing never carries message bodies.
func (s *Service) ListDeliveries(ctx context.Context, workspaceID, autopilotID pgtype.UUID, status *string, limit, offset int32) ([]db.ListLabrastroMessageDeliveriesByAutopilotRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var statusArg pgtype.Text
	if status != nil && *status != "" {
		statusArg = pgtype.Text{String: *status, Valid: true}
	}
	return s.Queries.ListLabrastroMessageDeliveriesByAutopilot(ctx, db.ListLabrastroMessageDeliveriesByAutopilotParams{
		WorkspaceID: workspaceID,
		AutopilotID: autopilotID,
		Status:      statusArg,
		Limit:       limit,
		Offset:      offset,
	})
}

// GetDelivery loads one record with its receipt ledger. The delivery must
// belong to the automation in the path — a delivery id from another
// autopilot (or workspace) is not found.
func (s *Service) GetDelivery(ctx context.Context, workspaceID, autopilotID, deliveryID pgtype.UUID) (db.LabrastroMessageDelivery, []db.LabrastroMessageReceipt, error) {
	d, err := s.Queries.GetLabrastroMessageDelivery(ctx, db.GetLabrastroMessageDeliveryParams{
		ID: deliveryID, WorkspaceID: workspaceID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.LabrastroMessageDelivery{}, nil, ErrDeliveryNotFound
	}
	if err != nil {
		return db.LabrastroMessageDelivery{}, nil, fmt.Errorf("load delivery: %w", err)
	}
	if util.UUIDToString(d.AutopilotID) != util.UUIDToString(autopilotID) {
		return db.LabrastroMessageDelivery{}, nil, ErrDeliveryNotFound
	}
	receipts, err := s.Queries.ListLabrastroMessageReceiptsByDelivery(ctx, db.ListLabrastroMessageReceiptsByDeliveryParams{
		DeliveryID:  d.ID,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		return d, nil, fmt.Errorf("load receipts: %w", err)
	}
	return d, receipts, nil
}

// RetryDelivery re-queues a failed or uncertain delivery for one more pass.
// The fixed per-shard send UUIDs make the replay idempotent inside the
// platform's dedup window; shards whose receipt already carries an external
// message id are skipped, not re-sent.
func (s *Service) RetryDelivery(ctx context.Context, workspaceID, autopilotID, deliveryID pgtype.UUID) (db.LabrastroMessageDelivery, error) {
	d, err := s.Queries.GetLabrastroMessageDelivery(ctx, db.GetLabrastroMessageDeliveryParams{
		ID: deliveryID, WorkspaceID: workspaceID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.LabrastroMessageDelivery{}, ErrDeliveryNotFound
	}
	if err != nil {
		return db.LabrastroMessageDelivery{}, fmt.Errorf("load delivery: %w", err)
	}
	if util.UUIDToString(d.AutopilotID) != util.UUIDToString(autopilotID) {
		return db.LabrastroMessageDelivery{}, ErrDeliveryNotFound
	}
	switch d.Status {
	case DeliveryStatusFailed, DeliveryStatusUncertain:
	default:
		return db.LabrastroMessageDelivery{}, ErrDeliveryNotRetryable
	}
	row, err := s.Queries.RetryLabrastroMessageDeliveryManually(ctx, db.RetryLabrastroMessageDeliveryManuallyParams{
		ID:          d.ID,
		WorkspaceID: workspaceID,
		ErrorCode:   pgtype.Text{},
		LastError:   pgtype.Text{String: "manual retry requested", Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.LabrastroMessageDelivery{}, ErrDeliveryNotRetryable
	}
	if err != nil {
		return db.LabrastroMessageDelivery{}, fmt.Errorf("retry delivery: %w", err)
	}
	s.Notify()
	return row, nil
}

// ---- test send ----

// TestSend exercises the REAL send path for one rule with a synthetic
// message, synchronously, and records the outcome as a test_send delivery
// with its receipt ledger. This is the reachability check for group/topic
// targets ("保存前校验机器人可达性" is a runtime act, not a config flag).
func (s *Service) TestSend(ctx context.Context, route db.LabrastroMessageRoute, member db.Member) (db.LabrastroMessageDelivery, error) {
	// The installation must still be usable right now.
	if _, err := s.ResolveTarget(ctx, route.WorkspaceID, RouteInput{
		InstallationID:  util.UUIDToString(route.InstallationID),
		TargetType:      route.TargetType,
		TargetUserID:    util.UUIDToString(route.TargetUserID),
		TargetChatID:    route.TargetChatID.String,
		TargetMessageID: route.TargetMessageID.String,
		TargetThreadID:  route.TargetThreadID.String,
		Conditions:      ConditionSuccess,
		ContentMode:     route.ContentMode,
	}); err != nil {
		return db.LabrastroMessageDelivery{}, err
	}

	content := contentSnapshot{
		Text:      "Labrastro test message: the bot can reach this target. No action is needed.",
		Summary:   "Labrastro test message",
		RunStatus: "test",
	}
	contentJSON, err := json.Marshal(content)
	if err != nil {
		return db.LabrastroMessageDelivery{}, fmt.Errorf("encode test content: %w", err)
	}
	target := targetSnapshot{
		TargetType:   route.TargetType,
		ChannelType:  route.ChannelType,
		Installation: util.UUIDToString(route.InstallationID),
		UserID:       util.UUIDToString(route.TargetUserID),
		ChatID:       route.TargetChatID.String,
		MessageID:    route.TargetMessageID.String,
		ThreadID:     route.TargetThreadID.String,
	}
	targetJSON, err := json.Marshal(target)
	if err != nil {
		return db.LabrastroMessageDelivery{}, fmt.Errorf("encode test target: %w", err)
	}
	refJSON, err := json.Marshal(sourceRef{RunID: ""})
	if err != nil {
		return db.LabrastroMessageDelivery{}, fmt.Errorf("encode test ref: %w", err)
	}

	sendID := util.UUIDToString(dbid.NewV7())
	rows, err := s.Queries.CreateLabrastroMessageDelivery(ctx, db.CreateLabrastroMessageDeliveryParams{
		ID:              dbid.NewV7(),
		WorkspaceID:     route.WorkspaceID,
		RouteID:         route.ID,
		RouteRevision:   pgtype.Int4{Int32: route.Revision, Valid: true},
		AutopilotID:     route.AutopilotID,
		DedupKey:        TestDeliveryDedupKey(sendID),
		SourceKind:      SourceKindTestSend,
		Status:          DeliveryStatusSending,
		ContentSnapshot: contentJSON,
		TargetSnapshot:  targetJSON,
		ShardTotal:      int32(len(splitShards(content.Text))),
		SourceRef:       refJSON,
		TargetKey:       route.TargetKey,
		InstallationID:  route.InstallationID,
	})
	if err != nil {
		return db.LabrastroMessageDelivery{}, fmt.Errorf("record test send: %w", err)
	}
	d := rows[0]

	out := s.sendDelivery(ctx, d)
	updated, err := s.Queries.SetLabrastroMessageDeliveryOutcome(ctx, db.SetLabrastroMessageDeliveryOutcomeParams{
		ID:        d.ID,
		Status:    out.status,
		ErrorCode: pgtype.Text{String: out.errorCode, Valid: out.errorCode != ""},
		LastError: pgtype.Text{String: out.detail, Valid: out.detail != ""},
	})
	if err != nil {
		return d, fmt.Errorf("record test send outcome: %w", err)
	}
	s.logger().Info("messagedelivery: test send finished",
		"delivery_id", util.UUIDToString(d.ID),
		"route_id", util.UUIDToString(route.ID),
		"actor", util.UUIDToString(member.UserID),
		"status", out.status,
		"reason_code", out.errorCode,
	)
	return updated, nil
}

// sendOutcome is the classified result of a full send pass.
type sendOutcome struct {
	status    string // sent | failed | uncertain
	errorCode string
	detail    string
}

// sendDelivery performs one complete send pass for a claimed delivery:
// resolve the live target, then push every shard in order, resuming after
// partial progress from the receipt ledger. Pre-send gates (route, source,
// installation state) are the caller's job; this function owns the wire.
func (s *Service) sendDelivery(ctx context.Context, d db.LabrastroMessageDelivery) sendOutcome {
	if s.Sender == nil {
		return sendOutcome{
			status:    DeliveryStatusFailed,
			errorCode: ErrorCodeSenderUnavailable,
			detail:    "no delivery sender is configured for this deployment",
		}
	}
	var snap targetSnapshot
	if err := json.Unmarshal(d.TargetSnapshot, &snap); err != nil {
		return sendOutcome{status: DeliveryStatusFailed, errorCode: ErrorCodeSendRejected,
			detail: "corrupt target snapshot: " + err.Error()}
	}
	var content contentSnapshot
	if err := json.Unmarshal(d.ContentSnapshot, &content); err != nil {
		return sendOutcome{status: DeliveryStatusFailed, errorCode: ErrorCodeSendRejected,
			detail: "corrupt content snapshot: " + err.Error()}
	}

	// Live member resolution: the frozen open_id is a decision-time
	// observation, never an authority. The binding on THIS installation is
	// re-read before dialing, so unbinding (or a revoke) between decision
	// and send fails explainably instead of misdelivering.
	address := targetFromSnapshot(snap)
	if snap.TargetType == TargetMember {
		userID, err := util.ParseUUID(snap.UserID)
		instID, instErr := util.ParseUUID(snap.Installation)
		if err != nil || instErr != nil {
			return sendOutcome{status: DeliveryStatusFailed, errorCode: ErrorCodeMemberUnbound,
				detail: "member target snapshot is not resolvable"}
		}
		binding, err := s.Queries.GetChannelUserBindingForDelivery(ctx, db.GetChannelUserBindingForDeliveryParams{
			WorkspaceID:    d.WorkspaceID,
			InstallationID: instID,
			MulticaUserID:  userID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return sendOutcome{status: DeliveryStatusFailed, errorCode: ErrorCodeMemberUnbound,
				detail: "member has no binding on this installation"}
		} else if err != nil {
			return sendOutcome{status: DeliveryStatusUncertain, errorCode: ErrorCodeSendAmbiguous,
				detail: "resolve member binding: " + err.Error()}
		}
		address.OpenID = binding.ChannelUserID
	}

	shards := splitShards(content.Text)
	for i, shard := range shards {
		// Claim (or re-read) the shard's receipt row. The send UUID is
		// written once and never changes, so a retry replays the SAME
		// idempotency key.
		receipt, err := s.Queries.ClaimLabrastroMessageReceipt(ctx, db.ClaimLabrastroMessageReceiptParams{
			DeliveryID:     d.ID,
			WorkspaceID:    d.WorkspaceID,
			InstallationID: d.InstallationID,
			ShardIndex:     int32(i),
			ShardTotal:     int32(len(shards)),
			SendUuid:       util.UUIDToString(dbid.NewV7()),
		})
		if err != nil {
			return sendOutcome{status: DeliveryStatusUncertain, errorCode: ErrorCodeSendAmbiguous,
				detail: fmt.Sprintf("claim receipt for shard %d: %v", i, err)}
		}
		// Already-accepted shards are never re-sent — this is what makes
		// a resumed multi-shard send safe after a partial pass.
		if receipt.ExternalMessageID.Valid && strings.TrimSpace(receipt.ExternalMessageID.String) != "" {
			continue
		}
		res, err := s.Sender.Send(ctx, SendRequest{
			WorkspaceID:    util.UUIDToString(d.WorkspaceID),
			InstallationID: snap.Installation,
			ChannelType:    snap.ChannelType,
			Target:         address,
			Text:           shard,
			SendUUID:       receipt.SendUuid,
			ShardIndex:     i,
			ShardTotal:     len(shards),
		})
		if err != nil {
			return classifySendError(i, err)
		}
		if _, err := s.Queries.RecordLabrastroMessageReceiptExternalID(ctx, db.RecordLabrastroMessageReceiptExternalIDParams{
			ID:                receipt.ID,
			ExternalMessageID: pgtype.Text{String: res.ExternalMessageID, Valid: res.ExternalMessageID != ""},
		}); err != nil {
			// The platform ACCEPTED the shard but the receipt write
			// failed — the delivery is now uncertain, not sent.
			return sendOutcome{status: DeliveryStatusUncertain, errorCode: ErrorCodeSendAmbiguous,
				detail: fmt.Sprintf("record receipt for shard %d: %v", i, err)}
		}
	}
	return sendOutcome{status: DeliveryStatusSent}
}

// classifySendError maps a Sender error onto the delivery outcome.
func classifySendError(shard int, err error) sendOutcome {
	var sendErr *SendError
	if !errors.As(err, &sendErr) {
		return sendOutcome{status: DeliveryStatusUncertain, errorCode: ErrorCodeSendAmbiguous,
			detail: fmt.Sprintf("shard %d: unclassified send error: %v", shard, err)}
	}
	detail := fmt.Sprintf("shard %d: %s", shard, sendErr.Error())
	switch sendErr.Class {
	case ClassPermanent:
		return sendOutcome{status: DeliveryStatusFailed, errorCode: ErrorCodeSendRejected, detail: detail}
	case ClassTransient:
		return sendOutcome{status: DeliveryStatusFailed, errorCode: ErrorCodeSendTransient, detail: detail}
	default:
		return sendOutcome{status: DeliveryStatusUncertain, errorCode: ErrorCodeSendAmbiguous, detail: detail}
	}
}
