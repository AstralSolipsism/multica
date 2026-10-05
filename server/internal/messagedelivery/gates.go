package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Gates run before dialing. A failed read cannot imply an ambiguous send.
type gateClass int

const (
	gateRejected gateClass = iota
	gateTransient
)

type gateResult struct {
	class     gateClass
	status    string
	errorCode string
	detail    string
}

func rejectGate(status, code, detail string) *gateResult {
	return &gateResult{class: gateRejected, status: status, errorCode: code, detail: detail}
}

func (s *Service) retryGate(deliveryID pgtype.UUID, detail string, err error) *gateResult {
	if err != nil {
		s.logger().Warn("messagedelivery: pre-send check failed", "delivery_id", util.UUIDToString(deliveryID), "operation", detail, "error", err)
	}
	return &gateResult{class: gateTransient, detail: detail}
}

func (g *gateResult) outcome() sendOutcome {
	if g.class == gateTransient {
		return sendOutcome{status: DeliveryStatusFailed, errorCode: ErrorCodeSendTransient, detail: g.detail}
	}
	return sendOutcome{status: g.status, errorCode: g.errorCode, detail: g.detail}
}

type sourceGate func(*Service, context.Context, db.LabrastroMessageDelivery, db.LabrastroMessageRoute) *gateResult

var sourceGates = map[string]sourceGate{
	SourceKindRunOnly:     (*Service).gateRunSource,
	SourceKindCreateIssue: (*Service).gateRunSource,
	SourceKindTestSend:    (*Service).gateTestSendSource,
	SourceKindInbox:       (*Service).gateInboxSource,
	SourceKindActivity:    (*Service).gateTeamSource,
	SourceKindComment:     (*Service).gateTeamSource,
}

func (s *Service) gateRunSource(ctx context.Context, d db.LabrastroMessageDelivery, route db.LabrastroMessageRoute) *gateResult {
	if route.AutopilotID != d.AutopilotID {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source mismatch")
	}
	ap, err := s.Queries.GetAutopilotInWorkspace(ctx, db.GetAutopilotInWorkspaceParams{ID: d.AutopilotID, WorkspaceID: d.WorkspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source automation deleted")
	}
	if err != nil {
		return s.retryGate(d.ID, "load source failed", err)
	}
	return s.gateRunAuthority(ctx, d, ap, route.UpdatedBy)
}

func (s *Service) gateRunAuthority(ctx context.Context, d db.LabrastroMessageDelivery, ap db.Autopilot, userID pgtype.UUID) *gateResult {
	err := sourceAuthority(ctx, s.Queries, ap, userID, false)
	switch {
	case errors.Is(err, ErrSourceUnavailable):
		return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceArchived, "source automation archived")
	case errors.Is(err, ErrAuthorizationLost):
		return rejectGate(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member no longer holds source write permission")
	case err != nil:
		return s.retryGate(d.ID, "check source authority failed", err)
	default:
		return nil
	}
}

// gateClaimed re-validates the world the decision was made in. A nil
// outcome means "cleared to send"; a non-nil outcome carries the recorded
// decision for a gate refusal. Every gate re-reads live state, which is
// what makes rule deletion, source archival and bot revocation race-safe
// without foreign keys. OL-27: the source checks branch per source kind —
// the automation path judges the run's autopilot, the personal path judges
// the recipient's membership and CURRENT mute state, the team path judges
// the authorizer's admin role and the source record's existence.
func (s *Service) gateClaimed(ctx context.Context, d db.LabrastroMessageDelivery) *gateResult {
	var snap targetSnapshot
	if err := json.Unmarshal(d.TargetSnapshot, &snap); err != nil {
		return rejectGate(DeliveryStatusFailed, ErrorCodeSendRejected, "corrupt target snapshot")
	}
	// Verify remotely first; local consent/source checks below observe changes
	// committed during that call. A missing verifier never bypasses approval.
	if out := s.reverifyTarget(ctx, d, snap); out != nil {
		return out
	}
	route, err := s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{ID: d.RouteID, WorkspaceID: d.WorkspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeRouteDeleted, "route deleted before send")
	}
	if err != nil {
		return s.retryGate(d.ID, "load route failed", err)
	}
	if !route.Enabled {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeRouteDisabled, "route disabled before send")
	}
	if !d.SourceScope.Valid || d.SourceScope.String != route.SourceKind {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "delivery source scope is unavailable")
	}
	if route.LastDisabledAt.Valid && !d.CreatedAt.Time.After(route.LastDisabledAt.Time) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeRouteDisabled, "delivery predates the last route disable")
	}
	if d.SourceProjectID.Valid {
		if _, err := s.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: d.SourceProjectID, WorkspaceID: d.WorkspaceID}); errors.Is(err, pgx.ErrNoRows) {
			return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "approved source project no longer exists")
		} else if err != nil {
			return s.retryGate(d.ID, "load source project failed", err)
		}
	}
	gate, ok := sourceGates[d.SourceKind]
	if !ok {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "unsupported delivery source")
	}
	if out := gate(s, ctx, d, route); out != nil {
		return out
	}
	return s.gateInstallation(ctx, d, snap)
}

func (s *Service) gateInstallation(ctx context.Context, d db.LabrastroMessageDelivery, snap targetSnapshot) *gateResult {
	if _, err := s.Queries.GetWorkspace(ctx, d.WorkspaceID); errors.Is(err, pgx.ErrNoRows) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source workspace unavailable")
	} else if err != nil {
		return s.retryGate(d.ID, "load workspace failed", err)
	}
	instID, err := util.ParseUUID(snap.Installation)
	if err != nil || instID != d.InstallationID {
		return rejectGate(DeliveryStatusFailed, ErrorCodeInstallationMissing, "invalid installation snapshot")
	}
	inst, err := s.Queries.GetChannelInstallationInWorkspace(ctx, db.GetChannelInstallationInWorkspaceParams{ID: instID, WorkspaceID: d.WorkspaceID, ChannelType: snap.ChannelType})
	if errors.Is(err, pgx.ErrNoRows) {
		return rejectGate(DeliveryStatusFailed, ErrorCodeInstallationMissing, "installation no longer exists")
	}
	if err != nil {
		return s.retryGate(d.ID, "load installation failed", err)
	}
	if inst.Status != "active" {
		return rejectGate(DeliveryStatusFailed, ErrorCodeInstallationRevoked, "installation revoked")
	}
	return nil
}

// gateTestSendSource authorizes a synchronous test send against the scope
// of the route it exercised. The authority is the delivery's PERSISTED
// requesting member (d.requested_by) — never the route's last editor, and
// a historical row without an actor fails closed. No source record is
// involved.
func (s *Service) gateTestSendSource(ctx context.Context, d db.LabrastroMessageDelivery, route db.LabrastroMessageRoute) *gateResult {
	if route.SourceKind == RouteSourceRun || route.AutopilotID.Valid {
		ap, err := s.Queries.GetAutopilotInWorkspace(ctx, db.GetAutopilotInWorkspaceParams{ID: route.AutopilotID, WorkspaceID: route.WorkspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source automation deleted")
		}
		if err != nil {
			return s.retryGate(d.ID, "load source failed", err)
		}
		return s.gateRunAuthority(ctx, d, ap, d.RequestedBy)
	}
	if !d.RequestedBy.Valid {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "diagnostic request carries no actor")
	}
	member, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		WorkspaceID: route.WorkspaceID, UserID: d.RequestedBy,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member is no longer a workspace member")
	}
	if err != nil {
		return s.retryGate(d.ID, "load authorizing member failed", err)
	}
	if route.SourceKind != RouteSourceInbox && member.Role != "owner" && member.Role != "admin" {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member no longer holds workspace admin")
	}
	return nil
}

// gateInboxSource re-checks the personal source before sending: the inbox
// item still exists and still belongs to the route's recipient, the
// recipient is still a member, and the item's category is STILL not muted —
// a preference that flipped after the decision stops the send here. A
// preference lookup failure re-queues the delivery (transient): unreadable
// state must never read as "not muted".
func (s *Service) gateInboxSource(ctx context.Context, d db.LabrastroMessageDelivery, route db.LabrastroMessageRoute) *gateResult {
	if !d.SourceRefID.Valid {
		return rejectGate(DeliveryStatusFailed, ErrorCodeSendRejected, "personal delivery without a source record")
	}
	item, err := s.Queries.GetInboxItem(ctx, d.SourceRefID)
	if errors.Is(err, pgx.ErrNoRows) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "inbox item no longer exists")
	}
	if err != nil {
		return s.retryGate(d.ID, "load inbox item failed", err)
	}
	if item.WorkspaceID != d.WorkspaceID || item.RecipientType != "member" || item.RecipientID != route.TargetUserID {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "inbox item no longer belongs to the route recipient")
	}
	if _, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		WorkspaceID: d.WorkspaceID, UserID: item.RecipientID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "recipient is no longer a workspace member")
	} else if err != nil {
		return s.retryGate(d.ID, "load recipient membership failed", err)
	}
	muted, err := s.inboxMuted(ctx, d.WorkspaceID, item.RecipientID, item.Type)
	if err != nil {
		return s.retryGate(d.ID, "check notification preference failed", err)
	}
	if muted {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeRecipientMuted, "recipient muted this notification category after the decision")
	}
	return nil
}

// gateTeamSource re-checks a team source before sending: the canonical
// record still exists (its issue may have been deleted), the issue still
// matches the delivery's frozen project range, and the member who LAST SAVED the
// route still holds workspace owner/admin — the same continuous
// authorization the automation source applies to its authorizer.
func (s *Service) gateTeamSource(ctx context.Context, d db.LabrastroMessageDelivery, route db.LabrastroMessageRoute) *gateResult {
	if !d.SourceRefID.Valid {
		return rejectGate(DeliveryStatusFailed, ErrorCodeSendRejected, "team delivery without a source record")
	}
	issueID, out := s.teamSourceIssue(ctx, d)
	if out != nil {
		return out
	}
	issue, err := s.Queries.GetIssue(ctx, issueID)
	if errors.Is(err, pgx.ErrNoRows) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source issue no longer exists")
	}
	if err != nil {
		return s.retryGate(d.ID, "load source issue failed", err)
	}
	if issue.WorkspaceID != d.WorkspaceID || (d.SourceProjectID.Valid && issue.ProjectID != d.SourceProjectID) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeConditionMismatch, "source issue left the decision's project scope")
	}
	authorizer, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		WorkspaceID: d.WorkspaceID, UserID: route.UpdatedBy,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member is no longer a workspace admin")
	}
	if err != nil {
		return s.retryGate(d.ID, "load authorizing member failed", err)
	}
	if authorizer.Role != "owner" && authorizer.Role != "admin" {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member no longer holds workspace admin")
	}
	return nil
}

// teamSourceIssue resolves the canonical team record before checking its scope.
func (s *Service) teamSourceIssue(ctx context.Context, d db.LabrastroMessageDelivery) (pgtype.UUID, *gateResult) {
	var issueID pgtype.UUID
	switch d.SourceKind {
	case SourceKindActivity:
		activity, err := s.Queries.GetActivity(ctx, d.SourceRefID)
		if errors.Is(err, pgx.ErrNoRows) {
			return pgtype.UUID{}, rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "activity record no longer exists")
		}
		if err != nil {
			return pgtype.UUID{}, s.retryGate(d.ID, "load activity record failed", err)
		}
		if activity.WorkspaceID != d.WorkspaceID {
			return pgtype.UUID{}, rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "activity belongs to another workspace")
		}
		issueID = activity.IssueID
	case SourceKindComment:
		comment, err := s.Queries.GetCommentInWorkspace(ctx, db.GetCommentInWorkspaceParams{ID: d.SourceRefID, WorkspaceID: d.WorkspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			return pgtype.UUID{}, rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "comment no longer exists")
		}
		if err != nil {
			return pgtype.UUID{}, s.retryGate(d.ID, "load comment failed", err)
		}
		if comment.DeletedAt.Valid {
			return pgtype.UUID{}, rejectGate(DeliveryStatusCancelled, ErrorCodeSourceMissing, "comment was deleted")
		}
		issueID = comment.IssueID
	}
	return issueID, nil
}

// reverifyTarget re-proves an external target against the live platform
// right before sending. nil means "cleared"; otherwise the recorded
// decision for the verification verdict.
func (s *Service) reverifyTarget(ctx context.Context, d db.LabrastroMessageDelivery, snap targetSnapshot) *gateResult {
	req := VerifyTargetRequest{
		WorkspaceID:    util.UUIDToString(d.WorkspaceID),
		InstallationID: snap.Installation,
		ChannelType:    snap.ChannelType,
		ChatID:         snap.ChatID,
		MessageID:      snap.MessageID,
	}
	// Approval is checked against the FROZEN target (delivery rows pin
	// installation + target_key at decision time), never against the
	// route's current configuration (repair contract §2). The approval
	// SCOPE follows the delivery's frozen source_scope: a team delivery checks the
	// team scope's own approval, never an automation's.
	if (snap.TargetType == TargetGroup || snap.TargetType == TargetTopic) && s.Verifier == nil {
		return s.retryGate(d.ID, "target verifier unavailable", nil)
	}
	switch snap.TargetType {
	case TargetGroup:
		if err := s.Verifier.VerifyGroupTarget(ctx, req); err != nil {
			return s.refuseVerification(d, err)
		}
		if err := s.deliveryTargetApproved(ctx, d, snap); err != nil {
			return s.refuseApproval(d, err)
		}
	case TargetTopic:
		verified, err := s.Verifier.VerifyTopicTarget(ctx, req)
		if err != nil {
			return s.refuseVerification(d, err)
		}
		if verified != snap.ChatID {
			// The anchor moved to a different chat between decision and
			// send: refusing is the only correct outcome.
			return rejectGate(DeliveryStatusFailed, ErrorCodeTopicAnchorMismatch,
				"anchor now lives in chat "+verified+", route pinned "+snap.ChatID)
		}
		if err := s.deliveryTargetApproved(ctx, d, snap); err != nil {
			return s.refuseApproval(d, err)
		}
	}
	return nil
}

// deliveryTargetApproved keys the send-time approval check on the
// delivery's OWN scope: team kinds check (workspace, source scope, project,
// bot, target) approval; automation deliveries keep the OL-25 per-automation
// check. An approval is never borrowed across scopes.
func (s *Service) deliveryTargetApproved(ctx context.Context, d db.LabrastroMessageDelivery, snap targetSnapshot) error {
	switch d.SourceScope.String {
	case RouteSourceActivity, RouteSourceComment:
		return s.sourceTargetApproved(ctx, d.WorkspaceID, d.SourceScope.String, d.SourceProjectID, d.InstallationID, snap.TargetKeyFor())
	case RouteSourceRun:
		return s.targetApproved(ctx, d.WorkspaceID, d.AutopilotID, d.InstallationID, snap.TargetKeyFor())
	default:
		return &TargetNotApprovedError{}
	}
}

// refuseApproval maps the approval verdict to a send outcome: a revoked or
// missing approval cancels the delivery — the workspace withdrew its
// consent, and queued siblings are cancelled by the revoke path with the
// same reason.
func (s *Service) refuseApproval(d db.LabrastroMessageDelivery, err error) *gateResult {
	var notApproved *TargetNotApprovedError
	if errors.As(err, &notApproved) {
		return rejectGate(DeliveryStatusCancelled, ErrorCodeTargetNotApproved, err.Error())
	}
	return s.retryGate(d.ID, "check approval failed", err)
}

// refuseVerification maps verification errors to send outcomes: a
// definitive refusal (including missing scopes) fails explainably; an unknown
// transport verdict retries without sending unverified.
func (s *Service) refuseVerification(d db.LabrastroMessageDelivery, err error) *gateResult {
	var unreachable *TargetUnreachableError
	var mismatch *TargetAnchorMismatchError
	switch {
	case errors.As(err, &mismatch):
		return rejectGate(DeliveryStatusFailed, ErrorCodeTopicAnchorMismatch, err.Error())
	case errors.As(err, &unreachable):
		return rejectGate(DeliveryStatusFailed, ErrorCodeTargetUnreachable, err.Error())
	case errors.Is(err, ErrTargetUnreachable):
		return rejectGate(DeliveryStatusFailed, ErrorCodeTargetUnreachable, err.Error())
	case errors.Is(err, ErrTargetAnchorMismatch):
		return rejectGate(DeliveryStatusFailed, ErrorCodeTopicAnchorMismatch, err.Error())
	}
	var sendErr *SendError
	if errors.As(err, &sendErr) && sendErr.Class == ClassPermanent {
		return rejectGate(DeliveryStatusFailed, ErrorCodeSendRejected, err.Error())
	}
	return s.retryGate(d.ID, "verify target failed", err)
}
