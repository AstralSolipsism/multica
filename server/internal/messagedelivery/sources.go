package messagedelivery

// OL-27 personal-inbox and team-event source configuration. The delivery
// pipeline (route → frozen decision → lease worker → receipt) is the OL-25
// machinery unchanged; this file extends the CONFIGURATION surface with the
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
//     carry their own (workspace, source scope, bot, target) approval — an
//     automation's approval is never borrowed
//   - personal mute semantics reuse notification_preference through the
//     shared notify catalog, re-checked before every send

import (
	"context"
	"errors"
	"fmt"

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
	// EventTypes filters an INBOX route by inbox item type (empty = every
	// type). Rejected on team routes.
	EventTypes []string
	// Enabled is a pointer so create can default to true and update can
	// leave the flag untouched when omitted.
	Enabled *bool
}

// ValidSourceEventTypes validates the inbox event filter against the shared
// catalog: an unknown type would silently never match, which reads as a
// broken route, so it is refused at save time.
func ValidSourceEventTypes(types []string) bool {
	for _, t := range types {
		if _, ok := notify.PreferenceGroupForType(t); !ok {
			return false
		}
	}
	return true
}

// resolveSourceTarget validates a source-route payload against current
// state, mirroring resolveTarget for the automation scope: the installation
// must be active and in this workspace; a member target must be a member
// with a binding on THIS installation; group/topic targets must pass the
// fail-closed platform verification. Team targets additionally require the
// scope's own active approval — unless this IS the approval flow.
func (s *Service) resolveSourceTarget(ctx context.Context, workspaceID pgtype.UUID, scope string, in SourceRouteInput, requireApproval bool) (resolvedTarget, error) {
	if !IsSourceRouteScope(scope) {
		return resolvedTarget{}, &InvalidRouteError{Field: "source_kind"}
	}
	if !ValidTargetTypes[in.TargetType] {
		return resolvedTarget{}, &InvalidRouteError{Field: "target_type"}
	}
	instID, err := util.ParseUUID(in.InstallationID)
	if err != nil {
		return resolvedTarget{}, &InvalidRouteError{Field: "installation_id"}
	}
	inst, err := s.Queries.GetChannelInstallationInWorkspace(ctx, db.GetChannelInstallationInWorkspaceParams{
		ID:          instID,
		WorkspaceID: workspaceID,
		ChannelType: "feishu",
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return resolvedTarget{}, &InstallationInvalidError{Reason: "installation not found in workspace"}
	}
	if err != nil {
		return resolvedTarget{}, fmt.Errorf("load installation: %w", err)
	}
	if inst.Status != "active" {
		return resolvedTarget{}, &InstallationInvalidError{Reason: "installation is revoked"}
	}

	out := resolvedTarget{
		installation: inst,
		targetType:   in.TargetType,
		chatID:       pgtype.Text{String: in.TargetChatID, Valid: in.TargetChatID != ""},
		messageID:    pgtype.Text{String: in.TargetMessageID, Valid: in.TargetMessageID != ""},
		threadID:     pgtype.Text{String: in.TargetThreadID, Valid: in.TargetThreadID != ""},
	}

	switch scope {
	case RouteSourceInbox:
		// Personal forwarding is member-DM only: the whole point is the
		// recipient's own private chat.
		if in.TargetType != TargetMember {
			return resolvedTarget{}, &InvalidRouteError{Field: "target_type"}
		}
		userID, parseErr := util.ParseUUID(in.TargetUserID)
		if parseErr != nil {
			return resolvedTarget{}, &InvalidRouteError{Field: "target_user_id"}
		}
		if _, memberErr := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
			UserID: userID, WorkspaceID: workspaceID,
		}); errors.Is(memberErr, pgx.ErrNoRows) {
			return resolvedTarget{}, &TargetNotMemberError{}
		} else if memberErr != nil {
			return resolvedTarget{}, fmt.Errorf("load target member: %w", memberErr)
		}
		if _, bindErr := s.Queries.GetChannelUserBindingForDelivery(ctx, db.GetChannelUserBindingForDeliveryParams{
			WorkspaceID: workspaceID, InstallationID: instID, MulticaUserID: userID,
		}); errors.Is(bindErr, pgx.ErrNoRows) {
			return resolvedTarget{}, &MemberNotBoundError{}
		} else if bindErr != nil {
			return resolvedTarget{}, fmt.Errorf("load member binding: %w", bindErr)
		}
		if !ValidSourceEventTypes(in.EventTypes) {
			return resolvedTarget{}, &InvalidRouteError{Field: "event_types"}
		}
		if in.ProjectID != "" {
			return resolvedTarget{}, &InvalidRouteError{Field: "project_id"}
		}
		// A member target shapes its own row: any group/topic addressing in
		// the payload would violate the target-shape check at insert time.
		in.TargetChatID, in.TargetMessageID, in.TargetThreadID = "", "", ""
		out.userID = userID
		in.TargetUserID = util.UUIDToString(userID)

	case RouteSourceActivity, RouteSourceComment:
		// Team events deliver to shared destinations, never to a member DM
		// (the personal inbox source is the DM surface — a team route must
		// not become a per-member fan-out). Member addressing in the
		// payload is dropped, not stored.
		if in.TargetType == TargetMember {
			return resolvedTarget{}, &InvalidRouteError{Field: "target_type"}
		}
		if in.TargetChatID == "" {
			return resolvedTarget{}, &InvalidRouteError{Field: "target_chat_id"}
		}
		if len(in.EventTypes) > 0 {
			return resolvedTarget{}, &InvalidRouteError{Field: "event_types"}
		}
		in.TargetUserID, in.TargetThreadID = "", ""
		if in.ProjectID != "" {
			projectID, parseErr := util.ParseUUID(in.ProjectID)
			if parseErr != nil {
				return resolvedTarget{}, &InvalidRouteError{Field: "project_id"}
			}
			if _, pErr := s.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{
				ID: projectID, WorkspaceID: workspaceID,
			}); errors.Is(pErr, pgx.ErrNoRows) {
				return resolvedTarget{}, &InvalidRouteError{Field: "project_id"}
			} else if pErr != nil {
				return resolvedTarget{}, fmt.Errorf("load route project: %w", pErr)
			}
			out.projectID = projectID
		}
		if s.Verifier == nil {
			return resolvedTarget{}, &TargetUnverifiableError{}
		}
		if in.TargetType == TargetGroup {
			if err := s.Verifier.VerifyGroupTarget(ctx, VerifyTargetRequest{
				WorkspaceID:    util.UUIDToString(workspaceID),
				InstallationID: util.UUIDToString(instID),
				ChannelType:    inst.ChannelType,
				ChatID:         in.TargetChatID,
			}); err != nil {
				return resolvedTarget{}, classifyTargetVerifyError(err)
			}
			if requireApproval {
				if err := s.sourceTargetApproved(ctx, workspaceID, scope, instID, TargetKey(TargetGroup, "", in.TargetChatID, "")); err != nil {
					return resolvedTarget{}, err
				}
			}
		} else {
			if in.TargetMessageID == "" {
				return resolvedTarget{}, &InvalidRouteError{Field: "target_message_id"}
			}
			verified, err := s.Verifier.VerifyTopicTarget(ctx, VerifyTargetRequest{
				WorkspaceID:    util.UUIDToString(workspaceID),
				InstallationID: util.UUIDToString(instID),
				ChannelType:    inst.ChannelType,
				ChatID:         in.TargetChatID,
				MessageID:      in.TargetMessageID,
			})
			if err != nil {
				return resolvedTarget{}, classifyTargetVerifyError(err)
			}
			if requireApproval {
				if err := s.sourceTargetApproved(ctx, workspaceID, scope, instID, TargetKey(TargetTopic, "", verified, in.TargetMessageID)); err != nil {
					return resolvedTarget{}, err
				}
			}
			out.chatID = pgtype.Text{String: verified, Valid: true}
			in.TargetChatID = verified
		}
	}

	out.targetKey = TargetKey(in.TargetType, in.TargetUserID, in.TargetChatID, in.TargetMessageID)
	return out, nil
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

// sourceTargetApproved reports whether the (source scope, bot, target)
// triple currently holds an active workspace-admin approval. Team approvals
// have their own scope: an automation's approval is never borrowed.
func (s *Service) sourceTargetApproved(ctx context.Context, workspaceID pgtype.UUID, scope string, installationID pgtype.UUID, targetKey string) error {
	return sourceTargetApprovedWith(ctx, s.Queries, workspaceID, scope, installationID, targetKey)
}

func sourceTargetApprovedWith(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, scope string, installationID pgtype.UUID, targetKey string) error {
	_, err := q.GetActiveLabrastroMessageSourceApprovedTarget(ctx, db.GetActiveLabrastroMessageSourceApprovedTargetParams{
		WorkspaceID:    workspaceID,
		SourceKind:     scope,
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
			if err := sourceTargetApprovedWith(ctx, q, workspaceID, scope, inst.ID, target.targetKey); err != nil {
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

// normalizeEventTypes dedupes and canonicalizes the inbox event filter so
// two spellings of one filter are one route identity.
func normalizeEventTypes(types []string) []string {
	if len(types) == 0 {
		return []string{}
	}
	seen := make(map[string]bool, len(types))
	out := make([]string, 0, len(types))
	for _, t := range types {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// UpdateSourceRoute edits a personal/team route under optimistic
// concurrency. The scope never changes through an edit; disabling through
// an edit cancels the route's not-yet-started sends.
func (s *Service) UpdateSourceRoute(ctx context.Context, route db.LabrastroMessageRoute, member db.Member, expectedRevision int32, in SourceRouteInput) (db.LabrastroMessageRoute, error) {
	in.Scope = route.SourceKind
	if err := s.sourceScopeAuthority(ctx, member, in.Scope); err != nil {
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
		return writeErr
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
	if route.Enabled && !enabled {
		s.cancelRouteDeliveries(ctx, route.ID, ErrorCodeRouteDisabled, "route disabled by edit")
	}
	return updated, nil
}

// SetSourceRouteEnabled flips a personal/team route's enabled flag. Enable
// re-resolves the target (verification + approval may have lapsed) and
// resets the eligibility boundary; disable cancels queued sends and never
// backfills the disabled window.
func (s *Service) SetSourceRouteEnabled(ctx context.Context, route db.LabrastroMessageRoute, member db.Member, enabled bool, expectedRevision int32) (db.LabrastroMessageRoute, error) {
	if err := s.sourceScopeAuthority(ctx, member, route.SourceKind); err != nil {
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
		return err
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
	if !enabled {
		s.cancelRouteDeliveries(ctx, route.ID, ErrorCodeRouteDisabled, "route disabled")
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

// ListSourceRoutes returns the workspace's personal/team rules, optionally
// filtered to one scope.
func (s *Service) ListSourceRoutes(ctx context.Context, workspaceID pgtype.UUID, scope *string) ([]db.LabrastroMessageRoute, error) {
	var scopeArg pgtype.Text
	if scope != nil && *scope != "" {
		if !IsSourceRouteScope(*scope) {
			return nil, &InvalidRouteError{Field: "source_kind"}
		}
		scopeArg = pgtype.Text{String: *scope, Valid: true}
	}
	routes, err := s.Queries.ListLabrastroMessageSourceRoutes(ctx, db.ListLabrastroMessageSourceRoutesParams{
		WorkspaceID: workspaceID,
		SourceKind:  scopeArg,
	})
	if routes == nil {
		routes = []db.LabrastroMessageRoute{}
	}
	return routes, err
}

// ---- team target approvals ----

// ApproveSourceTarget grants the (source scope, bot, target) approval. The
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
			SourceKind:     scope,
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
// the source-scope twin of RetryDelivery, with the route pinning in the
// WHERE clause so a delivery id from another route (or workspace) is not
// found.
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
	switch d.Status {
	case DeliveryStatusFailed, DeliveryStatusUncertain:
	default:
		return db.LabrastroMessageDelivery{}, ErrDeliveryNotRetryable
	}
	row, err := s.Queries.RetryLabrastroMessageDeliveryManuallyByRoute(ctx, db.RetryLabrastroMessageDeliveryManuallyByRouteParams{
		ID:          d.ID,
		WorkspaceID: workspaceID,
		RouteID:     routeID,
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
	if _, err := s.ResolveSourceTarget(ctx, route.WorkspaceID, route.SourceKind, sourceRouteInputFromRoute(route)); err != nil {
		return db.LabrastroMessageDelivery{}, err
	}
	return s.executeTestSend(ctx, route, member)
}
