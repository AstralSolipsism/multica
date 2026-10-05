package lifecycle

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// StopInstallation runs in the caller's transaction AFTER its installation
// row lock/update. This fresh statement sees config writes committed before
// the lock was acquired. Reinstallation requires an explicit route enable.
func StopInstallation(ctx context.Context, q *db.Queries, workspaceID, installationID pgtype.UUID) error {
	if err := q.DisableLabrastroMessageRoutesByInstallation(ctx, db.DisableLabrastroMessageRoutesByInstallationParams{WorkspaceID: workspaceID, InstallationID: installationID}); err != nil {
		return err
	}
	if err := q.DeleteLabrastroMessageApprovedTargetsByInstallation(ctx, db.DeleteLabrastroMessageApprovedTargetsByInstallationParams{WorkspaceID: workspaceID, InstallationID: installationID}); err != nil {
		return err
	}
	_, err := q.CancelLabrastroMessageDeliveriesByInstallation(ctx, db.CancelLabrastroMessageDeliveriesByInstallationParams{
		WorkspaceID: workspaceID, InstallationID: installationID,
		ErrorCode: pgtype.Text{String: "installation_revoked", Valid: true},
		LastError: pgtype.Text{String: "installation removed or revoked", Valid: true},
	})
	return err
}

// StopAutopilot follows ArchiveAutopilot in the same transaction. History is
// retained, while outbound approval and not-yet-started sends stop immediately.
func StopAutopilot(ctx context.Context, q *db.Queries, workspaceID, autopilotID pgtype.UUID) error {
	if err := q.DeleteLabrastroMessageApprovedTargetsByAutopilot(ctx, db.DeleteLabrastroMessageApprovedTargetsByAutopilotParams{WorkspaceID: workspaceID, AutopilotID: autopilotID}); err != nil {
		return err
	}
	return q.CancelLabrastroMessageDeliveriesByAutopilot(ctx, db.CancelLabrastroMessageDeliveriesByAutopilotParams{WorkspaceID: workspaceID, AutopilotID: autopilotID})
}

// StopProject follows the project lock in the caller's deletion transaction.
// Disable precedes cancellation so a concurrent decision cannot escape it.
func StopProject(ctx context.Context, q *db.Queries, workspaceID, projectID pgtype.UUID) error {
	if _, err := q.DisableLabrastroMessageSourceRoutesByProject(ctx, db.DisableLabrastroMessageSourceRoutesByProjectParams{WorkspaceID: workspaceID, ProjectID: projectID}); err != nil {
		return err
	}
	if _, err := q.CancelLabrastroMessageDeliveriesByProject(ctx, db.CancelLabrastroMessageDeliveriesByProjectParams{
		WorkspaceID: workspaceID, ProjectID: projectID,
		ErrorCode: pgtype.Text{String: "route_disabled", Valid: true},
		LastError: pgtype.Text{String: "project deleted; team route disabled", Valid: true},
	}); err != nil {
		return err
	}
	return q.RevokeLabrastroMessageSourceTargetsByProject(ctx, db.RevokeLabrastroMessageSourceTargetsByProjectParams{WorkspaceID: workspaceID, ProjectID: projectID})
}

// StopMember stops personal forwarding before membership is removed in the
// caller's transaction. Other members' routes and delivery history survive.
func StopMember(ctx context.Context, q *db.Queries, workspaceID, userID pgtype.UUID) error {
	if _, err := q.DisableLabrastroMessagePersonalRoutesByUser(ctx, db.DisableLabrastroMessagePersonalRoutesByUserParams{WorkspaceID: workspaceID, TargetUserID: userID}); err != nil {
		return err
	}
	_, err := q.CancelLabrastroMessageDeliveriesByPersonalRecipient(ctx, db.CancelLabrastroMessageDeliveriesByPersonalRecipientParams{
		WorkspaceID: workspaceID, TargetKey: "member:" + util.UUIDToString(userID),
		ErrorCode: pgtype.Text{String: "route_disabled", Valid: true},
		LastError: pgtype.Text{String: "member removed; personal route disabled", Valid: true},
	})
	return err
}

// SweepWorkspace preserves the existing cleanup order under the caller's
// workspace deletion lock: feedback/approvals, receipts, deliveries, routes.
func SweepWorkspace(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID) error {
	for _, sweep := range []func(context.Context, pgtype.UUID) error{
		q.DeleteLabrastroFeedbackByWorkspace,
		q.DeleteLabrastroMessageApprovedTargetsByWorkspace,
		q.DeleteLabrastroMessageReceiptsByWorkspace,
		q.DeleteLabrastroMessageDeliveriesByWorkspace,
		q.DeleteLabrastroMessageRoutesByWorkspace,
	} {
		if err := sweep(ctx, workspaceID); err != nil {
			return err
		}
	}
	return nil
}
