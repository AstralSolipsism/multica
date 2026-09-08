package lifecycle

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
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
