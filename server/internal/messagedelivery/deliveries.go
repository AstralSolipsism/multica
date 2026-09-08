package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

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
// with its receipt ledger. It runs through the SAME lifecycle protocol as a
// queued delivery (repair contract §5): parent-lock-guarded creation +
// claim-by-ID in one transaction, then the shared send path, then a
// lease-guarded outcome write. NO check is skipped for test sends — acting
// member write (HTTP gate), target verification and approval
// (ResolveTarget), workspace liveness (parent lock) and the lease protocol
// all apply.
func (s *Service) TestSend(ctx context.Context, route db.LabrastroMessageRoute, member db.Member) (db.LabrastroMessageDelivery, error) {
	// Same validation a route save performs: installation active +
	// member binding / verifier + workspace-admin approval for external
	// targets. Acting-member write was judged by the HTTP gate upstream.
	if _, err := s.ResolveTarget(ctx, route.WorkspaceID, route.AutopilotID, RouteInput{
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

	// Create queued + claim by ID inside ONE parent-lock transaction: a
	// workspace deletion that commits before the lock either refuses the
	// whole test send, or lands after and sweeps the row — no orphan.
	var d db.LabrastroMessageDelivery
	err = s.withParentLock(ctx, route.WorkspaceID, func(qtx *db.Queries) error {
		created, cErr := qtx.CreateLabrastroMessageDelivery(ctx, db.CreateLabrastroMessageDeliveryParams{
			ID:              dbid.NewV7(),
			WorkspaceID:     route.WorkspaceID,
			RouteID:         route.ID,
			RouteRevision:   pgtype.Int4{Int32: route.Revision, Valid: true},
			AutopilotID:     route.AutopilotID,
			DedupKey:        TestDeliveryDedupKey(util.UUIDToString(dbid.NewV7())),
			SourceKind:      SourceKindTestSend,
			RequestedBy:     member.UserID,
			Status:          DeliveryStatusQueued,
			ContentSnapshot: contentJSON,
			TargetSnapshot:  targetJSON,
			ShardTotal:      int32(len(splitShards(content.Text))),
			SourceRef:       refJSON,
			TargetKey:       route.TargetKey,
			InstallationID:  route.InstallationID,
		})
		if cErr != nil {
			return cErr
		}
		// Claim within the same transaction: this call owns a bounded
		// lease under the same protocol as the queue workers.
		createdRow := created[0]
		d, cErr = qtx.ClaimLabrastroMessageDeliveryByID(ctx, createdRow.ID)
		return cErr
	})
	if err != nil {
		return db.LabrastroMessageDelivery{}, fmt.Errorf("record test send: %w", err)
	}

	out := s.sendDelivery(ctx, d)
	// The final write runs on a detached bounded context (a disconnected
	// caller must not prevent the outcome from being recorded) and under
	// the SAME lease-ownership guard as every other result write: an
	// expired-then-reclaimed row belongs to its new owner.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if out.lost {
		// Recovery owns this row. Return its persisted state without claiming
		// a transition or hiding an existing diagnostic ID behind a 500.
		return s.Queries.GetLabrastroMessageDelivery(writeCtx, db.GetLabrastroMessageDeliveryParams{ID: d.ID, WorkspaceID: d.WorkspaceID})
	}
	updated, err := s.Queries.SetLabrastroMessageDeliveryOutcome(writeCtx, db.SetLabrastroMessageDeliveryOutcomeParams{
		ID:         d.ID,
		LeaseToken: d.LeaseToken,
		Status:     out.status,
		ErrorCode:  pgtype.Text{String: out.errorCode, Valid: out.errorCode != ""},
		LastError:  pgtype.Text{String: out.detail, Valid: out.detail != ""},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Benign lease handover: the row expired, was recovered and
		// re-claimed while this request was in flight. The NEW owner owns
		// the outcome; our rejected 'failed' write must not pollute it.
		s.logger().Debug("messagedelivery: test send outcome write lost lease ownership",
			"delivery_id", util.UUIDToString(d.ID))
		return s.Queries.GetLabrastroMessageDelivery(writeCtx, db.GetLabrastroMessageDeliveryParams{ID: d.ID, WorkspaceID: d.WorkspaceID})
	}
	if err != nil {
		return d, fmt.Errorf("record test send outcome: %w", err)
	}
	// The caller's interruption surfaces as an error even though the
	// outcome was recorded on the detached context.
	if cErr := ctx.Err(); cErr != nil {
		return updated, cErr
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
	// lost: lease ownership was lost mid-pass (review R9). Nothing is
	// sent or written after this point; the row's new owner owns the
	// outcome and the final lease-guarded write would fail anyway.
	lost bool
}

// sendDelivery performs one complete send pass for a claimed delivery:
// resolve the live target, then push every shard in order, resuming after
// partial progress from the receipt ledger. Pre-send gates (route, source,
// installation state) are checked here before every new shard.
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

	shards := splitShards(content.Text)
	for i, shard := range shards {
		// Claim (or re-read) the shard's receipt row. The send UUID is
		// written once and never changes, so a retry replays the SAME
		// idempotency key. The insert shares a transaction with the
		// workspace parent lock (review R3), so a teardown that committed
		// meanwhile refuses the receipt instead of landing in a deleted
		// workspace.
		var receipt db.LabrastroMessageReceipt
		err := s.withParentLock(ctx, d.WorkspaceID, func(qtx *db.Queries) error {
			var cErr error
			receipt, cErr = qtx.ClaimLabrastroMessageReceipt(ctx, db.ClaimLabrastroMessageReceiptParams{
				DeliveryID:     d.ID,
				WorkspaceID:    d.WorkspaceID,
				InstallationID: d.InstallationID,
				ShardIndex:     int32(i),
				ShardTotal:     int32(len(shards)),
				SendUuid:       util.UUIDToString(dbid.NewV7()),
			})
			return cErr
		})
		if err != nil {
			if errors.Is(err, errParentGone) {
				return sendOutcome{lost: true,
					detail: "workspace deleted before shard receipt"}
			}
			return sendOutcome{status: DeliveryStatusUncertain, errorCode: ErrorCodeSendAmbiguous,
				detail: fmt.Sprintf("claim receipt for shard %d: %v", i, err)}
		}
		// Already-accepted shards are never re-sent — this is what makes
		// a resumed multi-shard send safe after a partial pass.
		if receipt.ExternalMessageID.Valid && strings.TrimSpace(receipt.ExternalMessageID.String) != "" {
			continue
		}
		if out := s.gateClaimed(ctx, d); out != nil {
			return *out
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

		// Lease ownership re-check BEFORE dialing a new shard (review
		// R9): a worker whose claim expired — or whose row another
		// replica already parked as uncertain — must not start sends its
		// final lease-guarded write could never account for.
		if !s.holdsLease(ctx, d) {
			return sendOutcome{lost: true,
				detail: fmt.Sprintf("lease lost before shard %d", i)}
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
		if strings.TrimSpace(res.ExternalMessageID) == "" {
			return sendOutcome{status: DeliveryStatusUncertain, errorCode: ErrorCodeSendAmbiguous, detail: "accepted shard has no external receipt id"}
		}
		receiptCtx, cancelReceipt := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		_, receiptErr := s.Queries.RecordLabrastroMessageReceiptExternalID(receiptCtx, db.RecordLabrastroMessageReceiptExternalIDParams{
			ID:                receipt.ID,
			ExternalMessageID: pgtype.Text{String: res.ExternalMessageID, Valid: true},
		})
		cancelReceipt()
		if receiptErr != nil {
			// The platform ACCEPTED the shard but the receipt write
			// failed — the delivery is now uncertain, not sent.
			return sendOutcome{status: DeliveryStatusUncertain, errorCode: ErrorCodeSendAmbiguous,
				detail: fmt.Sprintf("record receipt for shard %d: %v", i, receiptErr)}
		}
	}
	return sendOutcome{status: DeliveryStatusSent}
}

// testSendLeaseTTL bounds a synchronous test send; it matches the claim
// lease window so the expiry sweep's recovery contract applies uniformly.
const testSendLeaseTTL = 2 * time.Minute

// errParentGone reports that the workspace a guarded write depends on no
// longer exists (the delete transaction committed first).
var errParentGone = errors.New("workspace parent gone")

// withParentLock runs fn inside a transaction holding a FOR SHARE lock on
// the workspace row (review R3). The DeleteWorkspace flow takes the same
// row FOR UPDATE before sweeping, so a write racing a committed delete is
// refused with errParentGone instead of landing in a deleted workspace.
func (s *Service) withParentLock(ctx context.Context, workspaceID pgtype.UUID, fn func(qtx *db.Queries) error) error {
	tx, err := s.Tx.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin parent-lock tx: %w", err)
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)
	if _, err := qtx.LockWorkspaceForMessageDecision(ctx, workspaceID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errParentGone
		}
		return fmt.Errorf("lock workspace parent: %w", err)
	}
	if err := fn(qtx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// holdsLease re-reads the delivery's live lease and reports whether the
// calling worker still owns it: same token, still 'sending', not expired.
func (s *Service) holdsLease(ctx context.Context, d db.LabrastroMessageDelivery) bool {
	if !d.LeaseToken.Valid {
		return false
	}
	row, err := s.Queries.GetLabrastroMessageDeliveryLease(ctx, d.ID)
	if err != nil {
		return false
	}
	if row.Status != DeliveryStatusSending || row.LeaseToken != d.LeaseToken {
		return false
	}
	return row.LeaseActive
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
