package messagedelivery

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/autopilotauth"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// sourceAuthority uses a freshly read human membership for both saved rules
// and test sends. A machine owner never supplies authority to this predicate.
func sourceAuthority(ctx context.Context, q *db.Queries, ap db.Autopilot, userID pgtype.UUID, admin bool) error {
	if ap.Status == "archived" {
		return ErrSourceUnavailable
	}
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		WorkspaceID: ap.WorkspaceID, UserID: userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrAuthorizationLost
	}
	if err != nil {
		return err
	}
	if !autopilotauth.CanWriteAutopilot(ctx, q, ap, member) ||
		(admin && member.Role != "owner" && member.Role != "admin") {
		return ErrAuthorizationLost
	}
	return nil
}

// External verification happens before this short transaction. Re-read local
// authority under workspace -> source -> installation locks before committing
// a configuration row, so deletion/revocation cannot leave orphan approvals.
func (s *Service) withTargetWrite(ctx context.Context, workspaceID, autopilotID pgtype.UUID, member db.Member, target resolvedTarget, admin bool, fn func(*db.Queries) error) error {
	return s.withParentLock(ctx, workspaceID, func(q *db.Queries) error {
		ap, err := q.LockAutopilotForUpdate(ctx, db.LockAutopilotForUpdateParams{ID: autopilotID, WorkspaceID: workspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSourceUnavailable
		}
		if err != nil {
			return err
		}
		if err := sourceAuthority(ctx, q, ap, member.UserID, admin); err != nil {
			return err
		}
		inst, err := q.LockLabrastroMessageInstallation(ctx, db.LockLabrastroMessageInstallationParams{ID: target.installation.ID, WorkspaceID: workspaceID})
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
			_, err = q.GetChannelUserBindingForDelivery(ctx, db.GetChannelUserBindingForDeliveryParams{WorkspaceID: workspaceID, InstallationID: inst.ID, MulticaUserID: target.userID})
			if errors.Is(err, pgx.ErrNoRows) {
				return &MemberNotBoundError{}
			}
			if err != nil {
				return err
			}
		} else if !admin {
			if err := targetApprovedWith(ctx, q, workspaceID, autopilotID, inst.ID, target.targetKey); err != nil {
				return err
			}
		}
		return fn(q)
	})
}

func routeInput(route db.LabrastroMessageRoute) RouteInput {
	return RouteInput{
		InstallationID: util.UUIDToString(route.InstallationID), TargetType: route.TargetType,
		TargetUserID: util.UUIDToString(route.TargetUserID), TargetChatID: route.TargetChatID.String,
		TargetMessageID: route.TargetMessageID.String, TargetThreadID: route.TargetThreadID.String,
		Conditions: route.Conditions, ContentMode: route.ContentMode,
	}
}
