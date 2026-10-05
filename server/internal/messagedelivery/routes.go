package messagedelivery

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// routeConfig contains validated configuration. Public entry points enforce
// each scope's authority and payload rules before these shared writes.
type routeConfig struct {
	scope       string
	autopilotID pgtype.UUID
	target      resolvedTarget
	conditions  string
	contentMode string
	eventTypes  []string
	enabled     bool
}

func (s *Service) withRouteWrite(ctx context.Context, workspaceID pgtype.UUID, member db.Member, cfg routeConfig, fn func(*db.Queries) error) error {
	if cfg.scope == RouteSourceRun {
		return s.withTargetWrite(ctx, workspaceID, cfg.autopilotID, member, cfg.target, false, fn)
	}
	return s.withSourceRouteWrite(ctx, workspaceID, cfg.scope, member, cfg.target, true, fn)
}

func (s *Service) createRoute(ctx context.Context, workspaceID pgtype.UUID, member db.Member, cfg routeConfig) (db.LabrastroMessageRoute, error) {
	var route db.LabrastroMessageRoute
	err := s.withRouteWrite(ctx, workspaceID, member, cfg, func(q *db.Queries) error {
		var err error
		route, err = q.CreateLabrastroMessageRoute(ctx, db.CreateLabrastroMessageRouteParams{
			ID: dbid.NewV7(), WorkspaceID: workspaceID, AutopilotID: cfg.autopilotID,
			SourceKind: cfg.scope, ProjectID: cfg.target.projectID, EventTypes: normalizeEventTypes(cfg.eventTypes),
			InstallationID: cfg.target.installation.ID, ChannelType: cfg.target.installation.ChannelType,
			TargetType: cfg.target.targetType, TargetKey: cfg.target.targetKey,
			TargetUserID: cfg.target.userID, TargetChatID: cfg.target.chatID,
			TargetMessageID: cfg.target.messageID, TargetThreadID: cfg.target.threadID,
			Conditions: cfg.conditions, ContentMode: cfg.contentMode,
			Enabled: cfg.enabled, CreatedBy: member.UserID,
		})
		return err
	})
	if isUniqueViolation(err) {
		return db.LabrastroMessageRoute{}, ErrRouteAlreadyExists
	}
	if err != nil {
		return db.LabrastroMessageRoute{}, fmt.Errorf("create message route: %w", err)
	}
	return route, nil
}

func (s *Service) updateRoute(ctx context.Context, route db.LabrastroMessageRoute, member db.Member, expectedRevision int32, cfg routeConfig) (db.LabrastroMessageRoute, error) {
	var updated db.LabrastroMessageRoute
	err := s.withRouteWrite(ctx, route.WorkspaceID, member, cfg, func(q *db.Queries) error {
		var err error
		updated, err = q.UpdateLabrastroMessageRoute(ctx, db.UpdateLabrastroMessageRouteParams{
			ID: route.ID, WorkspaceID: route.WorkspaceID, SourceKind: cfg.scope, ExpectedRevision: expectedRevision,
			InstallationID: cfg.target.installation.ID, ChannelType: cfg.target.installation.ChannelType,
			TargetType: cfg.target.targetType, TargetKey: cfg.target.targetKey,
			TargetUserID: cfg.target.userID, TargetChatID: cfg.target.chatID,
			TargetMessageID: cfg.target.messageID, TargetThreadID: cfg.target.threadID,
			ProjectID: cfg.target.projectID, EventTypes: normalizeEventTypes(cfg.eventTypes),
			Conditions: cfg.conditions, ContentMode: cfg.contentMode,
			Enabled: cfg.enabled, UpdatedBy: member.UserID,
		})
		if err != nil {
			return err
		}
		if !cfg.enabled {
			return cancelRouteDeliveriesWith(ctx, q, route.ID, ErrorCodeRouteDisabled, "route disabled by edit")
		}
		return nil
	})
	return updated, s.routeWriteError(ctx, route, expectedRevision, "update message route", err)
}

// setRouteEnabled shares the transaction, cancellation and revision handling
// across all scopes. Only enabling requires live target verification.
func (s *Service) setRouteEnabled(ctx context.Context, route db.LabrastroMessageRoute, member db.Member, enabled bool, expectedRevision int32) (db.LabrastroMessageRoute, error) {
	var updated db.LabrastroMessageRoute
	write := func(q *db.Queries) error {
		var err error
		updated, err = q.SetLabrastroMessageRouteEnabled(ctx, db.SetLabrastroMessageRouteEnabledParams{
			ID: route.ID, WorkspaceID: route.WorkspaceID, SourceKind: route.SourceKind,
			ExpectedRevision: expectedRevision, Enabled: enabled, UpdatedBy: member.UserID,
		})
		if err != nil {
			return err
		}
		if !enabled {
			return cancelRouteDeliveriesWith(ctx, q, route.ID, ErrorCodeRouteDisabled, "route disabled")
		}
		return nil
	}
	var err error
	if enabled {
		var target resolvedTarget
		if route.SourceKind == RouteSourceRun {
			target, err = s.ResolveTarget(ctx, route.WorkspaceID, route.AutopilotID, routeInput(route))
		} else {
			target, err = s.ResolveSourceTarget(ctx, route.WorkspaceID, route.SourceKind, sourceRouteInputFromRoute(route))
		}
		if err != nil {
			return updated, err
		}
		err = s.withRouteWrite(ctx, route.WorkspaceID, member, routeConfig{scope: route.SourceKind, autopilotID: route.AutopilotID, target: target}, write)
	} else {
		err = s.withParentLock(ctx, route.WorkspaceID, write)
	}
	return updated, s.routeWriteError(ctx, route, expectedRevision, "set message route enabled", err)
}

func (s *Service) routeWriteError(ctx context.Context, route db.LabrastroMessageRoute, expectedRevision int32, operation string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		current, getErr := s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{ID: route.ID, WorkspaceID: route.WorkspaceID})
		if errors.Is(getErr, pgx.ErrNoRows) {
			return ErrRouteNotFound
		}
		if getErr != nil {
			return fmt.Errorf("load route after conflict: %w", getErr)
		}
		if current.Revision != expectedRevision {
			return ErrRouteRevisionConflict
		}
		return ErrRouteNotFound
	}
	if err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}
