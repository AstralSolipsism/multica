package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// sourceDecision is one judged (source, route) pair ready to record.
// Run and personal/team decisions share locking, version checks and insertion.
type sourceDecision struct {
	autopilotID     pgtype.UUID
	runID           pgtype.UUID
	shardTotal      int
	sourceCreatedAt time.Time
	projectID       pgtype.UUID
	scope           string
	workspaceID     string
	sourceRefID     string
	routeID         pgtype.UUID
	routeRevision   int32
	installationID  pgtype.UUID
	targetKey       string
	kind            string
	status          string
	errorCode       string
	target          targetSnapshot
	content         contentSnapshot
	ref             sourceRef
}

// insertSourceDecision records the decision inside the parent-integrity
// transaction (the workspace FOR SHARE lock, review R3): a workspace
// deletion either committed first (the row is gone — the source no longer
// exists) or lands after and sweeps the row. ON CONFLICT DO NOTHING against
// the global dedup index is the exactly-once guarantee across replicas and
// repeated scans.
func (s *Service) insertSourceDecision(ctx context.Context, d sourceDecision) error {
	d.shardTotal = len(splitShards(NewMessage(d.content.Text, d.content.Link)))
	_, err := s.insertDecision(ctx, d)
	return err
}

func (s *Service) insertDecision(ctx context.Context, d sourceDecision) (int, error) {
	contentJSON, err := json.Marshal(d.content)
	if err != nil {
		return 0, fmt.Errorf("encode content snapshot: %w", err)
	}
	targetJSON, err := json.Marshal(d.target)
	if err != nil {
		return 0, fmt.Errorf("encode target snapshot: %w", err)
	}
	refJSON, err := json.Marshal(d.ref)
	if err != nil {
		return 0, fmt.Errorf("encode source ref: %w", err)
	}
	var errorCode pgtype.Text
	if d.errorCode != "" {
		errorCode = pgtype.Text{String: d.errorCode, Valid: true}
	}

	tx, err := s.Tx.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin decision tx: %w", err)
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)
	if _, err := qtx.LockWorkspaceForMessageDecision(ctx, mustUUID(d.workspaceID)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil // workspace gone; the source no longer exists
		}
		return 0, fmt.Errorf("lock decision parent: %w", err)
	}
	// Project-before-route order matches deletion; a candidate must not
	// recreate a route/source reference after its parent has been swept.
	if d.projectID.Valid {
		if _, err := qtx.LockLabrastroMessageSourceProject(ctx, db.LockLabrastroMessageSourceProjectParams{ID: d.projectID, WorkspaceID: mustUUID(d.workspaceID)}); errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		} else if err != nil {
			return 0, err
		}
	}
	route, err := qtx.LockLabrastroMessageRoute(ctx, db.LockLabrastroMessageRouteParams{ID: d.routeID, WorkspaceID: mustUUID(d.workspaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !route.Enabled || route.SourceKind != d.scope || route.Revision != d.routeRevision || (route.EffectiveFrom.Valid && d.sourceCreatedAt.Before(route.EffectiveFrom.Time)) {
		return 0, nil // stale candidate; a subsequent page/cycle recomputes it
	}
	dedupKey := SourceDeliveryDedupKey(d.scope, d.workspaceID, d.sourceRefID, util.UUIDToString(d.installationID), d.targetKey)
	var sourceRefID pgtype.UUID
	if d.scope == RouteSourceRun {
		dedupKey = DeliveryDedupKey(d.sourceRefID, util.UUIDToString(d.installationID), d.targetKey)
	} else {
		sourceRefID = mustUUID(d.sourceRefID)
	}
	rows, err := qtx.CreateLabrastroMessageDelivery(ctx, db.CreateLabrastroMessageDeliveryParams{
		AutopilotID: d.autopilotID, RunID: d.runID,
		ID:              dbid.NewV7(),
		WorkspaceID:     mustUUID(d.workspaceID),
		RouteID:         d.routeID,
		RouteRevision:   pgtype.Int4{Int32: d.routeRevision, Valid: true},
		SourceRefID:     sourceRefID,
		DedupKey:        dedupKey,
		SourceKind:      d.kind,
		SourceScope:     pgtype.Text{String: d.scope, Valid: true},
		SourceProjectID: d.projectID,
		Status:          d.status,
		ContentSnapshot: contentJSON,
		TargetSnapshot:  targetJSON,
		ShardTotal:      int32(d.shardTotal),
		SourceRef:       refJSON,
		TargetKey:       d.targetKey,
		InstallationID:  d.installationID,
		ErrorCode:       errorCode,
	})
	if err != nil && !isUniqueViolation(err) {
		return 0, fmt.Errorf("insert source delivery decision: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit delivery decision: %w", err)
	}
	if len(rows) == 0 {
		return 0, nil // already decided (by this or another replica)
	}
	if d.status == DeliveryStatusSuppressed {
		s.logger().Info("messagedelivery: source suppressed",
			"scope", d.scope,
			"source_ref_id", d.sourceRefID,
			"route_id", util.UUIDToString(d.routeID),
			"reason_code", d.errorCode,
		)
		return 1, nil
	}
	s.logger().Info("messagedelivery: source delivery decision created",
		"delivery_id", util.UUIDToString(rows[0].ID),
		"scope", d.scope,
		"source_ref_id", d.sourceRefID,
		"route_id", util.UUIDToString(d.routeID),
	)
	return 1, nil
}
