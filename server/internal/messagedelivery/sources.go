package messagedelivery

// OL-27 personal-inbox and team-event source configuration. The delivery
// pipeline (route → frozen decision → lease worker → receipt) reuses the
// OL-25 machinery; this file extends the CONFIGURATION surface with the
// source scopes:
//
//	inbox    → forwards the route owner's OWN inbox items to their OWN DM
//	activity → forwards canonical team status/assignee changes to group/topic
//	comment  → forwards canonical team comments to group/topic
//
// Scope rules enforced here (see README "OL-27 sources"):
//   - a non-run route never impersonates an automation id (autopilot_id NULL)
//   - an inbox route's target is the acting member themselves — configuring
//     someone else's inbox is refused, admins included
//   - team routes are owner/admin configuration, and their external targets
//     carry their own (workspace, source scope, project, bot, target) approval — an
//     automation's approval is never borrowed
//   - personal mute semantics reuse notification_preference through the
//     shared notify catalog, re-checked before every send

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/notify"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// SourceRouteInput is the create/update payload for a personal/team route.
// There are deliberately NO conditions/content_mode fields: those decide
// WHICH automation outcome to push, and these sources have no outcomes —
// every source record inside the eligibility window is either forwarded or
// explicitly suppressed.
type SourceRouteInput struct {
	Scope           string
	InstallationID  string
	TargetType      string
	TargetUserID    string
	TargetChatID    string
	TargetMessageID string
	TargetThreadID  string
	// ProjectID scopes a TEAM route to one project (empty = whole
	// workspace). Rejected on inbox routes.
	ProjectID string
	// EventTypes selects a subset of the scope event catalog (empty = all).
	EventTypes []string
	// Enabled is a pointer so create can default to true and update can
	// leave the flag untouched when omitted.
	Enabled *bool
}

// ValidSourceEventTypes checks a source-specific subset of the event catalog.
func ValidSourceEventTypes(scope string, types []string) bool {
	for _, event := range types {
		switch scope {
		case RouteSourceInbox:
			if _, ok := notify.PreferenceGroupForType(event); !ok {
				return false
			}
		case RouteSourceActivity:
			if !notify.IsTeamActivityAction(event) {
				return false
			}
		case RouteSourceComment:
			if !notify.IsDeliverableCommentType(event) {
				return false
			}
		default:
			return false
		}
	}
	return IsSourceRouteScope(scope)
}

// resolveSourceTarget validates the source/filter scope, delegates destination
// verification to the shared pipeline, then checks consent for the exact scope.
func (s *Service) resolveSourceTarget(ctx context.Context, workspaceID pgtype.UUID, scope string, in SourceRouteInput, requireApproval bool) (resolvedTarget, error) {
	if !IsSourceRouteScope(scope) {
		return resolvedTarget{}, &InvalidRouteError{Field: "source_kind"}
	}
	if !ValidTargetTypes[in.TargetType] || (scope == RouteSourceInbox) != (in.TargetType == TargetMember) {
		return resolvedTarget{}, &InvalidRouteError{Field: "target_type"}
	}
	if !ValidSourceEventTypes(scope, in.EventTypes) {
		return resolvedTarget{}, &InvalidRouteError{Field: "event_types"}
	}
	var projectID pgtype.UUID
	if in.ProjectID != "" {
		if scope == RouteSourceInbox {
			return resolvedTarget{}, &InvalidRouteError{Field: "project_id"}
		}
		var err error
		projectID, err = util.ParseUUID(in.ProjectID)
		if err != nil {
			return resolvedTarget{}, &InvalidRouteError{Field: "project_id"}
		}
		if _, err := s.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: projectID, WorkspaceID: workspaceID}); errors.Is(err, pgx.ErrNoRows) {
			return resolvedTarget{}, &InvalidRouteError{Field: "project_id"}
		} else if err != nil {
			return resolvedTarget{}, fmt.Errorf("load route project: %w", err)
		}
	}
	// Store only addressing fields that belong to the chosen target shape.
	if in.TargetType == TargetMember {
		in.TargetChatID, in.TargetMessageID, in.TargetThreadID = "", "", ""
	} else {
		in.TargetUserID, in.TargetThreadID = "", ""
		if in.TargetType == TargetGroup {
			in.TargetMessageID = ""
		}
	}
	target, err := s.resolveDeliveryTarget(ctx, workspaceID, RouteInput{
		InstallationID: in.InstallationID, TargetType: in.TargetType,
		TargetUserID: in.TargetUserID, TargetChatID: in.TargetChatID,
		TargetMessageID: in.TargetMessageID, TargetThreadID: in.TargetThreadID,
	})
	if err != nil {
		return resolvedTarget{}, err
	}
	target.projectID = projectID
	if requireApproval && scope != RouteSourceInbox {
		if err := s.sourceTargetApproved(ctx, workspaceID, scope, projectID, target.installation.ID, target.targetKey); err != nil {
			return resolvedTarget{}, err
		}
	}
	return target, nil
}

// ResolveSourceTarget validates a source-route payload the way a save
// would (including the approval requirement).
func (s *Service) ResolveSourceTarget(ctx context.Context, workspaceID pgtype.UUID, scope string, in SourceRouteInput) (resolvedTarget, error) {
	return s.resolveSourceTarget(ctx, workspaceID, scope, in, true)
}

// ResolveSourceTargetForApproval skips the approval lookup — an approval
// cannot require itself.
func (s *Service) ResolveSourceTargetForApproval(ctx context.Context, workspaceID pgtype.UUID, scope string, in SourceRouteInput) (resolvedTarget, error) {
	return s.resolveSourceTarget(ctx, workspaceID, scope, in, false)
}

// sourceTargetApproved checks active consent for the exact project range
// and destination in the source scope. Team approvals
// have their own scope: an automation's approval is never borrowed.
func (s *Service) sourceTargetApproved(ctx context.Context, workspaceID pgtype.UUID, scope string, projectID, installationID pgtype.UUID, targetKey string) error {
	return sourceTargetApprovedWith(ctx, s.Queries, workspaceID, scope, projectID, installationID, targetKey)
}

func sourceTargetApprovedWith(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, scope string, projectID, installationID pgtype.UUID, targetKey string) error {
	_, err := q.GetActiveLabrastroMessageSourceApprovedTarget(ctx, db.GetActiveLabrastroMessageSourceApprovedTargetParams{
		WorkspaceID:    workspaceID,
		SourceKind:     scope,
		ProjectID:      projectID,
		InstallationID: installationID,
		TargetKey:      targetKey,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return &TargetNotApprovedError{}
	}
	if err != nil {
		return &TargetUnverifiableError{Detail: "check approval: " + err.Error()}
	}
	return nil
}

// withSourceRouteWrite runs fn inside the parent-integrity transaction,
// re-reading every local permission fresh before the commit: acting
// membership (+ admin role where the scope demands it), self-ownership for
// inbox routes, installation liveness, the member binding, and — for team
// saves — the scope's approval. External verification happened BEFORE this
// short transaction; nothing network-backed runs inside it.
func (s *Service) withSourceRouteWrite(ctx context.Context, workspaceID pgtype.UUID, scope string, member db.Member, target resolvedTarget, requireApproval bool, fn func(*db.Queries) error) error {
	adminRequired := scope != RouteSourceInbox
	return s.withParentLock(ctx, workspaceID, func(q *db.Queries) error {
		if target.projectID.Valid {
			if _, err := q.LockLabrastroMessageSourceProject(ctx, db.LockLabrastroMessageSourceProjectParams{ID: target.projectID, WorkspaceID: workspaceID}); errors.Is(err, pgx.ErrNoRows) {
				return &InvalidRouteError{Field: "project_id"}
			} else if err != nil {
				return err
			}
		}
		acting, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
			WorkspaceID: workspaceID, UserID: member.UserID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrAuthorizationLost
		}
		if err != nil {
			return err
		}
		if adminRequired && acting.Role != "owner" && acting.Role != "admin" {
			return ErrAuthorizationLost
		}
		if scope == RouteSourceInbox && acting.UserID != target.userID {
			return &RouteNotSelfError{}
		}
		inst, err := q.LockLabrastroMessageInstallation(ctx, db.LockLabrastroMessageInstallationParams{
			ID: target.installation.ID, WorkspaceID: workspaceID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return &InstallationInvalidError{Reason: "installation no longer exists"}
		}
		if err != nil {
			return err
		}
		if inst.Status != "active" {
			return &InstallationInvalidError{Reason: "installation is revoked"}
		}
		if target.targetType == TargetMember {
			if _, err := q.GetChannelUserBindingForDelivery(ctx, db.GetChannelUserBindingForDeliveryParams{
				WorkspaceID: workspaceID, InstallationID: inst.ID, MulticaUserID: target.userID,
			}); errors.Is(err, pgx.ErrNoRows) {
				return &MemberNotBoundError{}
			} else if err != nil {
				return err
			}
		} else if requireApproval {
			if err := sourceTargetApprovedWith(ctx, q, workspaceID, scope, target.projectID, inst.ID, target.targetKey); err != nil {
				return err
			}
		}
		return fn(q)
	})
}

// CreateSourceRoute saves a personal/team delivery rule. The acting member
// (resolved by the HTTP layer) is stamped as creator AND first updater;
// inbox routes additionally pin them as the sole legal target.
func (s *Service) CreateSourceRoute(ctx context.Context, member db.Member, in SourceRouteInput) (db.LabrastroMessageRoute, error) {
	if err := s.sourceScopeAuthority(ctx, member, in.Scope); err != nil {
		return db.LabrastroMessageRoute{}, err
	}
	target, err := s.resolveSourceTarget(ctx, member.WorkspaceID, in.Scope, in, true)
	if err != nil {
		return db.LabrastroMessageRoute{}, err
	}
	var route db.LabrastroMessageRoute
	err = s.withSourceRouteWrite(ctx, member.WorkspaceID, in.Scope, member, target, true, func(q *db.Queries) error {
		var writeErr error
		route, writeErr = q.CreateLabrastroMessageSourceRoute(ctx, db.CreateLabrastroMessageSourceRouteParams{
			ID:              dbid.NewV7(),
			WorkspaceID:     member.WorkspaceID,
			InstallationID:  target.installation.ID,
			ChannelType:     target.installation.ChannelType,
			TargetType:      target.targetType,
			TargetUserID:    target.userID,
			TargetChatID:    target.chatID,
			TargetMessageID: target.messageID,
			TargetThreadID:  target.threadID,
			TargetKey:       target.targetKey,
			SourceKind:      in.Scope,
			ProjectID:       target.projectID,
			EventTypes:      normalizeEventTypes(in.EventTypes),
			Enabled:         s.enabledOrDefault(RouteInput{Enabled: in.Enabled}, true, false),
			CreatedBy:       member.UserID,
		})
		return writeErr
	})
	if isUniqueViolation(err) {
		return db.LabrastroMessageRoute{}, ErrRouteAlreadyExists
	}
	if err != nil {
		return db.LabrastroMessageRoute{}, fmt.Errorf("create message source route: %w", err)
	}
	return route, nil
}

// sourceScopeAuthority refuses team-scope configuration to a member below
// admin BEFORE any target resolution — the permission boundary is judged on
// identity, not on whether the target happens to be approved. The write
// transaction re-checks it again against fresh state.
func (s *Service) sourceScopeAuthority(ctx context.Context, member db.Member, scope string) error {
	if scope == RouteSourceInbox {
		return nil
	}
	if !IsSourceRouteScope(scope) {
		return &InvalidRouteError{Field: "source_kind"}
	}
	acting, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		WorkspaceID: member.WorkspaceID, UserID: member.UserID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrAuthorizationLost
	}
	if err != nil {
		return err
	}
	if acting.Role != "owner" && acting.Role != "admin" {
		return ErrAuthorizationLost
	}
	return nil
}

// normalizeEventTypes makes order and duplicate spelling irrelevant to identity.
func normalizeEventTypes(types []string) []string {
	out := append([]string{}, types...)
	slices.Sort(out)
	return slices.Compact(out)
}

// sourceRouteAuthority applies the same ownership rule to every service entry.
func (s *Service) sourceRouteAuthority(ctx context.Context, route db.LabrastroMessageRoute, member db.Member) error {
	if route.WorkspaceID != member.WorkspaceID {
		return ErrAuthorizationLost
	}
	if route.SourceKind == RouteSourceInbox && route.TargetUserID != member.UserID {
		return &RouteNotSelfError{}
	}
	return s.sourceScopeAuthority(ctx, member, route.SourceKind)
}

// UpdateSourceRoute edits a personal/team route under optimistic
// concurrency. The scope never changes through an edit; disabling through
// an edit cancels the route's not-yet-started sends.
func (s *Service) UpdateSourceRoute(ctx context.Context, route db.LabrastroMessageRoute, member db.Member, expectedRevision int32, in SourceRouteInput) (db.LabrastroMessageRoute, error) {
	in.Scope = route.SourceKind
	if err := s.sourceRouteAuthority(ctx, route, member); err != nil {
		return db.LabrastroMessageRoute{}, err
	}
	target, err := s.resolveSourceTarget(ctx, route.WorkspaceID, route.SourceKind, in, true)
	if err != nil {
		return db.LabrastroMessageRoute{}, err
	}
	enabled := s.enabledOrDefault(RouteInput{Enabled: in.Enabled}, false, route.Enabled)
	var updated db.LabrastroMessageRoute
	err = s.withSourceRouteWrite(ctx, route.WorkspaceID, route.SourceKind, member, target, true, func(q *db.Queries) error {
		var writeErr error
		updated, writeErr = q.UpdateLabrastroMessageSourceRoute(ctx, db.UpdateLabrastroMessageSourceRouteParams{
			ID:               route.ID,
			WorkspaceID:      route.WorkspaceID,
			SourceKind:       route.SourceKind,
			ExpectedRevision: expectedRevision,
			InstallationID:   target.installation.ID,
			ChannelType:      target.installation.ChannelType,
			TargetType:       target.targetType,
			TargetUserID:     target.userID,
			TargetChatID:     target.chatID,
			TargetMessageID:  target.messageID,
			TargetThreadID:   target.threadID,
			TargetKey:        target.targetKey,
			ProjectID:        target.projectID,
			EventTypes:       normalizeEventTypes(in.EventTypes),
			Enabled:          enabled,
			UpdatedBy:        member.UserID,
		})
		if writeErr != nil {
			return writeErr
		}
		if !enabled {
			return cancelRouteDeliveriesWith(ctx, q, route.ID, ErrorCodeRouteDisabled, "route disabled by edit")
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		current, getErr := s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{
			ID: route.ID, WorkspaceID: route.WorkspaceID,
		})
		if getErr != nil {
			return db.LabrastroMessageRoute{}, ErrRouteNotFound
		}
		if current.Revision != expectedRevision {
			return db.LabrastroMessageRoute{}, ErrRouteRevisionConflict
		}
		return db.LabrastroMessageRoute{}, ErrRouteNotFound
	}
	if err != nil {
		return db.LabrastroMessageRoute{}, fmt.Errorf("update message source route: %w", err)
	}
	return updated, nil
}

// SetSourceRouteEnabled flips a personal/team route's enabled flag. Enable
// re-resolves the target (verification + approval may have lapsed) and
// resets the eligibility boundary; disable cancels queued sends and never
// backfills the disabled window.
func (s *Service) SetSourceRouteEnabled(ctx context.Context, route db.LabrastroMessageRoute, member db.Member, enabled bool, expectedRevision int32) (db.LabrastroMessageRoute, error) {
	if err := s.sourceRouteAuthority(ctx, route, member); err != nil {
		return db.LabrastroMessageRoute{}, err
	}
	var updated db.LabrastroMessageRoute
	write := func(q *db.Queries) error {
		var err error
		updated, err = q.SetLabrastroMessageSourceRouteEnabled(ctx, db.SetLabrastroMessageSourceRouteEnabledParams{
			ID:               route.ID,
			WorkspaceID:      route.WorkspaceID,
			SourceKind:       route.SourceKind,
			ExpectedRevision: expectedRevision,
			Enabled:          enabled,
			UpdatedBy:        member.UserID,
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
		target, resolveErr := s.ResolveSourceTarget(ctx, route.WorkspaceID, route.SourceKind, sourceRouteInputFromRoute(route))
		if resolveErr != nil {
			return updated, resolveErr
		}
		err = s.withSourceRouteWrite(ctx, route.WorkspaceID, route.SourceKind, member, target, true, write)
	} else {
		err = s.withParentLock(ctx, route.WorkspaceID, write)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		current, getErr := s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{
			ID: route.ID, WorkspaceID: route.WorkspaceID,
		})
		if getErr != nil {
			return db.LabrastroMessageRoute{}, ErrRouteNotFound
		}
		if current.Revision != expectedRevision {
			return db.LabrastroMessageRoute{}, ErrRouteRevisionConflict
		}
		return db.LabrastroMessageRoute{}, ErrRouteNotFound
	}
	if err != nil {
		return db.LabrastroMessageRoute{}, fmt.Errorf("set message source route enabled: %w", err)
	}
	return updated, nil
}

// sourceRouteInputFromRoute rebuilds the payload a route currently holds —
// the re-validation input for enable/test-send.
func sourceRouteInputFromRoute(route db.LabrastroMessageRoute) SourceRouteInput {
	return SourceRouteInput{
		Scope:           route.SourceKind,
		InstallationID:  util.UUIDToString(route.InstallationID),
		TargetType:      route.TargetType,
		TargetUserID:    util.UUIDToString(route.TargetUserID),
		TargetChatID:    route.TargetChatID.String,
		TargetMessageID: route.TargetMessageID.String,
		TargetThreadID:  route.TargetThreadID.String,
		ProjectID:       util.UUIDToString(route.ProjectID),
		EventTypes:      route.EventTypes,
	}
}

// ListSourceRoutes returns only the actor's own inbox rules and, for a
// current owner/admin, team rules. Membership is evaluated by the query.
func (s *Service) ListSourceRoutes(ctx context.Context, member db.Member, scope *string) ([]db.LabrastroMessageRoute, error) {
	var scopeArg pgtype.Text
	if scope != nil && *scope != "" {
		if !IsSourceRouteScope(*scope) {
			return nil, &InvalidRouteError{Field: "source_kind"}
		}
		scopeArg = pgtype.Text{String: *scope, Valid: true}
	}
	routes, err := s.Queries.ListLabrastroMessageSourceRoutes(ctx, db.ListLabrastroMessageSourceRoutesParams{
		WorkspaceID: member.WorkspaceID,
		UserID:      member.UserID,
		SourceKind:  scopeArg,
	})
	if routes == nil {
		routes = []db.LabrastroMessageRoute{}
	}
	return routes, err
}

// ---- team target approvals ----

// ApproveSourceTarget grants the (source scope, project, bot, target) approval. The
// caller resolved the target first so the approval covers the VERIFIED chat.
func (s *Service) ApproveSourceTarget(ctx context.Context, workspaceID pgtype.UUID, scope string, approver db.Member, target resolvedTarget) (db.LabrastroMessageApprovedTarget, error) {
	var row db.LabrastroMessageApprovedTarget
	err := s.withSourceRouteWrite(ctx, workspaceID, scope, approver, target, false, func(q *db.Queries) error {
		var err error
		row, err = q.ApproveLabrastroMessageSourceTarget(ctx, db.ApproveLabrastroMessageSourceTargetParams{
			WorkspaceID:    workspaceID,
			InstallationID: target.installation.ID,
			TargetKey:      target.targetKey,
			TargetType:     target.targetType,
			SourceKind:     scope,
			ProjectID:      target.projectID,
			ApprovedBy:     approver.UserID,
		})
		return err
	})
	if isUniqueViolation(err) {
		return row, ErrRouteAlreadyExists
	}
	return row, err
}

// RevokeSourceTarget soft-revokes one team approval and cancels the
// not-yet-started sends against the frozen target in the SAME transaction.
func (s *Service) RevokeSourceTarget(ctx context.Context, workspaceID pgtype.UUID, scope string, target db.LabrastroMessageApprovedTarget) (int, error) {
	cancelled := 0
	err := s.withParentLock(ctx, workspaceID, func(q *db.Queries) error {
		revoked, err := q.RevokeLabrastroMessageSourceTarget(ctx, db.RevokeLabrastroMessageSourceTargetParams{
			ID:             target.ID,
			WorkspaceID:    workspaceID,
			SourceKind:     scope,
			ProjectID:      target.ProjectID,
			InstallationID: target.InstallationID,
			TargetKey:      target.TargetKey,
		})
		if err != nil {
			return err
		}
		if len(revoked) == 0 {
			return ErrApprovedTargetNotFound
		}
		rows, err := q.CancelLabrastroMessageDeliveriesBySourceTarget(ctx, db.CancelLabrastroMessageDeliveriesBySourceTargetParams{
			WorkspaceID:    workspaceID,
			SourceKind:     pgtype.Text{String: scope, Valid: true},
			ProjectID:      target.ProjectID,
			InstallationID: target.InstallationID,
			TargetKey:      target.TargetKey,
			ErrorCode:      pgtype.Text{String: ErrorCodeTargetNotApproved, Valid: true},
			LastError:      pgtype.Text{String: "target approval revoked", Valid: true},
		})
		cancelled = len(rows)
		return err
	})
	return cancelled, err
}

// ListSourceApprovedTargets returns the workspace's active team approvals.
func (s *Service) ListSourceApprovedTargets(ctx context.Context, workspaceID pgtype.UUID) ([]db.LabrastroMessageApprovedTarget, error) {
	rows, err := s.Queries.ListLabrastroMessageSourceApprovedTargets(ctx, workspaceID)
	if rows == nil {
		rows = []db.LabrastroMessageApprovedTarget{}
	}
	return rows, err
}

// ---- records ----

// ListRouteDeliveries returns the record page for one personal/team route.
// Rows are the projection (no snapshots), same as the automation listing.
func (s *Service) ListRouteDeliveries(ctx context.Context, workspaceID, routeID pgtype.UUID, status *string, limit, offset int32) ([]db.ListLabrastroMessageDeliveriesByRouteRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var statusArg pgtype.Text
	if status != nil && *status != "" {
		statusArg = pgtype.Text{String: *status, Valid: true}
	}
	return s.Queries.ListLabrastroMessageDeliveriesByRoute(ctx, db.ListLabrastroMessageDeliveriesByRouteParams{
		WorkspaceID: workspaceID,
		RouteID:     routeID,
		Status:      statusArg,
		Limit:       limit,
		Offset:      offset,
	})
}

// RetryRouteDelivery re-queues a failed/uncertain delivery of ONE route —
// using the shared retry transition after checking the immutable route
// identity. A delivery from another route (or workspace) is not found.
func (s *Service) RetryRouteDelivery(ctx context.Context, workspaceID, routeID, deliveryID pgtype.UUID) (db.LabrastroMessageDelivery, error) {
	d, err := s.Queries.GetLabrastroMessageDelivery(ctx, db.GetLabrastroMessageDeliveryParams{
		ID: deliveryID, WorkspaceID: workspaceID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.LabrastroMessageDelivery{}, ErrDeliveryNotFound
	}
	if err != nil {
		return db.LabrastroMessageDelivery{}, fmt.Errorf("load delivery: %w", err)
	}
	if d.RouteID != routeID {
		return db.LabrastroMessageDelivery{}, ErrDeliveryNotFound
	}
	return s.retryDelivery(ctx, d)
}

// GetSourceDelivery loads one record with its receipt ledger for a source
// route. The delivery must belong to the route in the path.
func (s *Service) GetSourceDelivery(ctx context.Context, workspaceID, routeID, deliveryID pgtype.UUID) (db.LabrastroMessageDelivery, []db.LabrastroMessageReceipt, error) {
	d, receipts, err := s.GetDeliveryRecords(ctx, workspaceID, deliveryID)
	if err != nil {
		return db.LabrastroMessageDelivery{}, nil, err
	}
	if d.RouteID != routeID {
		return db.LabrastroMessageDelivery{}, nil, ErrDeliveryNotFound
	}
	return d, receipts, nil
}

// TestSourceSend exercises the REAL send path for one personal/team rule
// with a synthetic message — the source-scope twin of TestSend. NO check is
// skipped: acting-member gate (HTTP), scope ownership, target verification
// and scope approval, workspace liveness and the lease protocol all apply.
func (s *Service) TestSourceSend(ctx context.Context, route db.LabrastroMessageRoute, member db.Member) (db.LabrastroMessageDelivery, error) {
	if err := s.sourceRouteAuthority(ctx, route, member); err != nil {
		return db.LabrastroMessageDelivery{}, err
	}
	if _, err := s.ResolveSourceTarget(ctx, route.WorkspaceID, route.SourceKind, sourceRouteInputFromRoute(route)); err != nil {
		return db.LabrastroMessageDelivery{}, err
	}
	return s.executeTestSend(ctx, route, member)
}
