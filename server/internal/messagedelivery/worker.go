package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	// workerConcurrency bounds the per-process send pool. SKIP LOCKED
	// spreads the same queue across every replica's pool.
	workerConcurrency = 2
	// pollInterval is the idle sweep cadence; Notify coalesces faster.
	pollInterval = time.Second
	// defaultScanEvery is the compensator cadence.
	defaultScanEvery = 30 * time.Second
	// scanBatchSize bounds each compensator pass.
	scanBatchSize = 200
)

// Run starts the send workers, the compensator and the wakeup listener, and
// blocks until ctx is cancelled. WaitWithTimeout joins it during shutdown.
func (s *Service) Run(ctx context.Context) {
	if s == nil || s.Queries == nil {
		return
	}
	defer close(s.done)

	var wg sync.WaitGroup
	wg.Add(workerConcurrency)
	for range workerConcurrency {
		go func() {
			defer wg.Done()
			s.sendLoop(ctx)
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.scanLoop(ctx)
	}()

	wg.Wait()
}

// WaitWithTimeout reports whether the workers exited within timeout.
func (s *Service) WaitWithTimeout(timeout time.Duration) bool {
	if s == nil {
		return true
	}
	done := s.done
	if done == nil {
		return true
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

// Notify hints the send pool that new work exists. Non-blocking and
// lossy-by-design: the poll loop and the compensator are the safety net.
// The server assembly subscribes this to the EventBus's
// autopilot:run_done event as a latency hint only.
func (s *Service) Notify() {
	if s == nil {
		return
	}
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

// NotifyDecide hints the scan loop that new persisted sources may exist.
// The server assembly subscribes it to inbox:new / activity:created /
// comment:created — wakeups only; the compensation scanner re-derives the
// missing set from persisted rows, so a lost event is always recovered.
func (s *Service) NotifyDecide() {
	if s == nil || s.decideNotify == nil {
		return
	}
	select {
	case s.decideNotify <- struct{}{}:
	default:
	}
}

func (s *Service) sendLoop(ctx context.Context) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		worked, err := s.ProcessNext(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			s.logger().Error("messagedelivery: process delivery", "error", err)
		}
		if worked {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-s.notify:
		case <-ticker.C:
		}
	}
}

// ProcessNext claims and processes ONE due delivery. Exported for tests.
func (s *Service) ProcessNext(ctx context.Context) (bool, error) {
	d, err := s.Queries.ClaimDueLabrastroMessageDelivery(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	s.processClaimed(ctx, d)
	return true, nil
}

// processClaimed runs the pre-send gates, performs the send pass and writes
// the terminal transition. Every gate failure is a recorded decision with a
// stable reason — never a silent drop and never a source the compensator
// will see again.
func (s *Service) processClaimed(ctx context.Context, d db.LabrastroMessageDelivery) {
	v := s.sendDelivery(ctx, d)
	out := &v
	if out.lost {
		// Lease ownership was lost mid-pass (review R9): the row's new
		// owner owns the outcome; this worker writes nothing.
		s.logger().Warn("messagedelivery: abandoned send pass, lease lost mid-flight",
			"delivery_id", util.UUIDToString(d.ID),
			"detail", out.detail,
		)
		return
	}

	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	ctx = writeCtx
	switch out.status {
	case DeliveryStatusSent:
		s.completeClaimed(ctx, d, *out)
	case DeliveryStatusCancelled:
		s.cancelClaimed(ctx, d, *out)
	case DeliveryStatusUncertain:
		s.uncertainClaimed(ctx, d, *out)
	case DeliveryStatusFailed:
		if out.errorCode == ErrorCodeSendTransient && d.Attempts+1 < int32(s.maxAttempts()) {
			s.retryClaimed(ctx, d, *out)
			return
		}
		if out.errorCode == ErrorCodeSendTransient {
			out.errorCode = ErrorCodeAttemptsExhausted
			out.detail = "exhausted " + strconv.Itoa(int(d.Attempts+1)) + " attempts; last: " + out.detail
		}
		s.failClaimed(ctx, d, *out)
	default:
		s.failClaimed(ctx, d, sendOutcome{
			status:    DeliveryStatusFailed,
			errorCode: ErrorCodeSendRejected,
			detail:    "unclassified send outcome " + out.status,
		})
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
func (s *Service) gateClaimed(ctx context.Context, d db.LabrastroMessageDelivery) *sendOutcome {
	refuse := func(status, code, detail string) *sendOutcome {
		return &sendOutcome{status: status, errorCode: code, detail: detail}
	}
	var snap targetSnapshot
	if err := json.Unmarshal(d.TargetSnapshot, &snap); err != nil {
		return refuse(DeliveryStatusFailed, ErrorCodeSendRejected, "corrupt target snapshot")
	}
	// Verify remotely first; local consent/source checks below observe changes
	// committed during that call. A missing verifier never bypasses approval.
	if out := s.reverifyTarget(ctx, d, snap); out != nil {
		return out
	}
	route, err := s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{ID: d.RouteID, WorkspaceID: d.WorkspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return refuse(DeliveryStatusCancelled, ErrorCodeRouteDeleted, "route deleted before send")
	}
	if err != nil {
		return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load route failed")
	}
	if !route.Enabled {
		return refuse(DeliveryStatusCancelled, ErrorCodeRouteDisabled, "route disabled before send")
	}
	if !d.SourceScope.Valid || d.SourceScope.String != route.SourceKind {
		return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "delivery source scope is unavailable")
	}
	if route.LastDisabledAt.Valid && !d.CreatedAt.Time.After(route.LastDisabledAt.Time) {
		return refuse(DeliveryStatusCancelled, ErrorCodeRouteDisabled, "delivery predates the last route disable")
	}
	if d.SourceProjectID.Valid {
		if _, err := s.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: d.SourceProjectID, WorkspaceID: d.WorkspaceID}); errors.Is(err, pgx.ErrNoRows) {
			return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "approved source project no longer exists")
		} else if err != nil {
			return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load source project failed")
		}
	}
	// Source checks branch per scope. A TEST send carries no source record
	// — it is judged against the scope of the route it exercised, with the
	// requesting member as the authority; a real delivery is judged against
	// its own source kind.
	if d.SourceKind == SourceKindTestSend {
		if out := s.gateTestSendSource(ctx, d, route); out != nil {
			return out
		}
	} else {
		switch d.SourceKind {
		case SourceKindInbox:
			if out := s.gateInboxSource(ctx, d, route, snap); out != nil {
				return out
			}
		case SourceKindActivity, SourceKindComment:
			if out := s.gateTeamSource(ctx, d, route); out != nil {
				return out
			}
		default:
			// Automation runs: the OL-25 source authority.
			if route.AutopilotID != d.AutopilotID {
				return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source mismatch")
			}
			ap, err := s.Queries.GetAutopilotInWorkspace(ctx, db.GetAutopilotInWorkspaceParams{ID: d.AutopilotID, WorkspaceID: d.WorkspaceID})
			if errors.Is(err, pgx.ErrNoRows) {
				return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source automation deleted")
			}
			if err != nil {
				return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load source failed")
			}
			if ap.Status == "archived" {
				return refuse(DeliveryStatusCancelled, ErrorCodeSourceArchived, "source automation archived")
			}
			if err := sourceAuthority(ctx, s.Queries, ap, route.UpdatedBy, false); err != nil {
				return refuse(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member no longer holds source write permission")
			}
		}
	}
	if _, err := s.Queries.GetWorkspace(ctx, d.WorkspaceID); err != nil {
		return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source workspace unavailable")
	}
	instID, err := util.ParseUUID(snap.Installation)
	if err != nil || instID != d.InstallationID {
		return refuse(DeliveryStatusFailed, ErrorCodeInstallationMissing, "invalid installation snapshot")
	}
	inst, err := s.Queries.GetChannelInstallationInWorkspace(ctx, db.GetChannelInstallationInWorkspaceParams{ID: instID, WorkspaceID: d.WorkspaceID, ChannelType: snap.ChannelType})
	if errors.Is(err, pgx.ErrNoRows) {
		return refuse(DeliveryStatusFailed, ErrorCodeInstallationMissing, "installation no longer exists")
	}
	if err != nil {
		return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load installation failed")
	}
	if inst.Status != "active" {
		return refuse(DeliveryStatusFailed, ErrorCodeInstallationRevoked, "installation revoked")
	}
	return nil
}

// gateTestSendSource authorizes a synchronous test send against the scope
// of the route it exercised. The authority is the delivery's PERSISTED
// requesting member (d.requested_by) — never the route's last editor, and
// a historical row without an actor fails closed. No source record is
// involved.
func (s *Service) gateTestSendSource(ctx context.Context, d db.LabrastroMessageDelivery, route db.LabrastroMessageRoute) *sendOutcome {
	refuse := func(status, code, detail string) *sendOutcome {
		return &sendOutcome{status: status, errorCode: code, detail: detail}
	}
	if route.SourceKind == RouteSourceRun || route.AutopilotID.Valid {
		ap, err := s.Queries.GetAutopilotInWorkspace(ctx, db.GetAutopilotInWorkspaceParams{ID: route.AutopilotID, WorkspaceID: route.WorkspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source automation deleted")
		}
		if err != nil {
			return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load source failed")
		}
		if ap.Status == "archived" {
			return refuse(DeliveryStatusCancelled, ErrorCodeSourceArchived, "source automation archived")
		}
		if err := sourceAuthority(ctx, s.Queries, ap, d.RequestedBy, false); err != nil {
			return refuse(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member no longer holds source write permission")
		}
		return nil
	}
	if !d.RequestedBy.Valid {
		return refuse(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "diagnostic request carries no actor")
	}
	member, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		WorkspaceID: route.WorkspaceID, UserID: d.RequestedBy,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return refuse(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member is no longer a workspace member")
	}
	if err != nil {
		return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load authorizing member failed")
	}
	if route.SourceKind != RouteSourceInbox && member.Role != "owner" && member.Role != "admin" {
		return refuse(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member no longer holds workspace admin")
	}
	return nil
}

// gateInboxSource re-checks the personal source before sending: the inbox
// item still exists and still belongs to the route's recipient, the
// recipient is still a member, and the item's category is STILL not muted —
// a preference that flipped after the decision stops the send here. A
// preference lookup failure re-queues the delivery (transient): unreadable
// state must never read as "not muted".
func (s *Service) gateInboxSource(ctx context.Context, d db.LabrastroMessageDelivery, route db.LabrastroMessageRoute, snap targetSnapshot) *sendOutcome {
	refuse := func(status, code, detail string) *sendOutcome {
		return &sendOutcome{status: status, errorCode: code, detail: detail}
	}
	if !d.SourceRefID.Valid {
		return refuse(DeliveryStatusFailed, ErrorCodeSendRejected, "personal delivery without a source record")
	}
	item, err := s.Queries.GetInboxItem(ctx, d.SourceRefID)
	if errors.Is(err, pgx.ErrNoRows) {
		return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "inbox item no longer exists")
	}
	if err != nil {
		return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load inbox item failed")
	}
	if item.WorkspaceID != d.WorkspaceID || item.RecipientType != "member" || item.RecipientID != route.TargetUserID {
		return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "inbox item no longer belongs to the route recipient")
	}
	if _, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		WorkspaceID: d.WorkspaceID, UserID: item.RecipientID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return refuse(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "recipient is no longer a workspace member")
	} else if err != nil {
		return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load recipient membership failed")
	}
	muted, err := s.inboxMuted(ctx, d.WorkspaceID, item.RecipientID, item.Type)
	if err != nil {
		return refuse(DeliveryStatusFailed, ErrorCodeSendTransient, "check notification preference: "+err.Error())
	}
	if muted {
		return refuse(DeliveryStatusCancelled, ErrorCodeRecipientMuted, "recipient muted this notification category after the decision")
	}
	return nil
}

// gateTeamSource re-checks a team source before sending: the canonical
// record still exists (its issue may have been deleted), the issue still
// matches the delivery's frozen project range, and the member who LAST SAVED the
// route still holds workspace owner/admin — the same continuous
// authorization the automation source applies to its authorizer.
func (s *Service) gateTeamSource(ctx context.Context, d db.LabrastroMessageDelivery, route db.LabrastroMessageRoute) *sendOutcome {
	refuse := func(status, code, detail string) *sendOutcome {
		return &sendOutcome{status: status, errorCode: code, detail: detail}
	}
	if !d.SourceRefID.Valid {
		return refuse(DeliveryStatusFailed, ErrorCodeSendRejected, "team delivery without a source record")
	}
	var issueID pgtype.UUID
	switch d.SourceKind {
	case SourceKindActivity:
		activity, err := s.Queries.GetActivity(ctx, d.SourceRefID)
		if errors.Is(err, pgx.ErrNoRows) {
			return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "activity record no longer exists")
		}
		if err != nil {
			return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load activity record failed")
		}
		if activity.WorkspaceID != d.WorkspaceID {
			return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "activity belongs to another workspace")
		}
		issueID = activity.IssueID
	case SourceKindComment:
		comment, err := s.Queries.GetCommentInWorkspace(ctx, db.GetCommentInWorkspaceParams{ID: d.SourceRefID, WorkspaceID: d.WorkspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "comment no longer exists")
		}
		if err != nil {
			return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load comment failed")
		}
		issueID = comment.IssueID
	}
	{
		issue, err := s.Queries.GetIssue(ctx, issueID)
		if errors.Is(err, pgx.ErrNoRows) {
			return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source issue no longer exists")
		}
		if err != nil {
			return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load source issue failed")
		}
		if issue.WorkspaceID != d.WorkspaceID || (d.SourceProjectID.Valid && issue.ProjectID != d.SourceProjectID) {
			return refuse(DeliveryStatusCancelled, ErrorCodeConditionMismatch, "source issue left the decision's project scope")
		}
	}
	authorizer, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		WorkspaceID: d.WorkspaceID, UserID: route.UpdatedBy,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return refuse(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member is no longer a workspace admin")
	}
	if err != nil {
		return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load authorizing member failed")
	}
	if authorizer.Role != "owner" && authorizer.Role != "admin" {
		return refuse(DeliveryStatusCancelled, ErrorCodeAuthorizationLost, "authorizing member no longer holds workspace admin")
	}
	return nil
}

// reverifyTarget re-proves an external target against the live platform
// right before sending. nil means "cleared"; otherwise the recorded
// decision for the verification verdict.
func (s *Service) reverifyTarget(ctx context.Context, d db.LabrastroMessageDelivery, snap targetSnapshot) *sendOutcome {
	refuse := func(status, code, detail string) *sendOutcome {
		return &sendOutcome{status: status, errorCode: code, detail: detail}
	}
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
		return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "target verifier unavailable")
	}
	switch snap.TargetType {
	case TargetGroup:
		if err := s.Verifier.VerifyGroupTarget(ctx, req); err != nil {
			return refuseVerification(err)
		}
		if err := s.deliveryTargetApproved(ctx, d, snap); err != nil {
			return refuseApproval(err)
		}
	case TargetTopic:
		verified, err := s.Verifier.VerifyTopicTarget(ctx, req)
		if err != nil {
			return refuseVerification(err)
		}
		if verified != snap.ChatID {
			// The anchor moved to a different chat between decision and
			// send: refusing is the only correct outcome.
			return refuse(DeliveryStatusFailed, ErrorCodeTopicAnchorMismatch,
				"anchor now lives in chat "+verified+", route pinned "+snap.ChatID)
		}
		if err := s.deliveryTargetApproved(ctx, d, snap); err != nil {
			return refuseApproval(err)
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
func refuseApproval(err error) *sendOutcome {
	var notApproved *TargetNotApprovedError
	if errors.As(err, &notApproved) {
		return &sendOutcome{status: DeliveryStatusCancelled,
			errorCode: ErrorCodeTargetNotApproved, detail: err.Error()}
	}
	return &sendOutcome{status: DeliveryStatusUncertain,
		errorCode: ErrorCodeSendAmbiguous, detail: "check approval: " + err.Error()}
}

// refuseVerification maps verification errors to send outcomes: a
// definitive refusal fails explainably; an unknown verdict (transport,
// scopes) parks the delivery as uncertain rather than sending unverified.
func refuseVerification(err error) *sendOutcome {
	var unreachable *TargetUnreachableError
	var mismatch *TargetAnchorMismatchError
	switch {
	case errors.As(err, &mismatch):
		return &sendOutcome{status: DeliveryStatusFailed,
			errorCode: ErrorCodeTopicAnchorMismatch, detail: err.Error()}
	case errors.As(err, &unreachable):
		return &sendOutcome{status: DeliveryStatusFailed,
			errorCode: ErrorCodeTargetUnreachable, detail: err.Error()}
	case errors.Is(err, ErrTargetUnreachable):
		return &sendOutcome{status: DeliveryStatusFailed,
			errorCode: ErrorCodeTargetUnreachable, detail: err.Error()}
	case errors.Is(err, ErrTargetAnchorMismatch):
		return &sendOutcome{status: DeliveryStatusFailed,
			errorCode: ErrorCodeTopicAnchorMismatch, detail: err.Error()}
	}
	return &sendOutcome{status: DeliveryStatusUncertain,
		errorCode: ErrorCodeSendAmbiguous, detail: "verify target: " + err.Error()}
}

func (s *Service) completeClaimed(ctx context.Context, d db.LabrastroMessageDelivery, out sendOutcome) {
	if _, err := s.Queries.CompleteClaimedLabrastroMessageDelivery(ctx, db.CompleteClaimedLabrastroMessageDeliveryParams{
		ID:         d.ID,
		LeaseToken: d.LeaseToken,
	}); err != nil {
		s.logLeaseLoss("complete", d, err)
		return
	}
	s.logger().Info("messagedelivery: delivery sent",
		"delivery_id", util.UUIDToString(d.ID),
		"run_id", util.UUIDToString(d.RunID),
	)
}

func (s *Service) failClaimed(ctx context.Context, d db.LabrastroMessageDelivery, out sendOutcome) {
	if _, err := s.Queries.FailClaimedLabrastroMessageDelivery(ctx, db.FailClaimedLabrastroMessageDeliveryParams{
		ID:         d.ID,
		LeaseToken: d.LeaseToken,
		ErrorCode:  pgtype.Text{String: out.errorCode, Valid: out.errorCode != ""},
		LastError:  pgtype.Text{String: out.detail, Valid: out.detail != ""},
	}); err != nil {
		s.logLeaseLoss("fail", d, err)
	}
}

func (s *Service) cancelClaimed(ctx context.Context, d db.LabrastroMessageDelivery, out sendOutcome) {
	if _, err := s.Queries.CancelClaimedLabrastroMessageDelivery(ctx, db.CancelClaimedLabrastroMessageDeliveryParams{
		ID:         d.ID,
		LeaseToken: d.LeaseToken,
		ErrorCode:  pgtype.Text{String: out.errorCode, Valid: out.errorCode != ""},
		LastError:  pgtype.Text{String: out.detail, Valid: out.detail != ""},
	}); err != nil {
		s.logLeaseLoss("cancel", d, err)
	}
}

func (s *Service) uncertainClaimed(ctx context.Context, d db.LabrastroMessageDelivery, out sendOutcome) {
	if _, err := s.Queries.UncertainClaimedLabrastroMessageDelivery(ctx, db.UncertainClaimedLabrastroMessageDeliveryParams{
		ID:         d.ID,
		LeaseToken: d.LeaseToken,
		ErrorCode:  pgtype.Text{String: out.errorCode, Valid: out.errorCode != ""},
		LastError:  pgtype.Text{String: out.detail, Valid: out.detail != ""},
	}); err != nil {
		s.logLeaseLoss("uncertain", d, err)
	}
	s.logger().Warn("messagedelivery: delivery outcome uncertain",
		"delivery_id", util.UUIDToString(d.ID),
		"reason_code", out.errorCode,
	)
}

func (s *Service) retryClaimed(ctx context.Context, d db.LabrastroMessageDelivery, out sendOutcome) {
	backoff := backoffFor(int(d.Attempts))
	if _, err := s.Queries.RetryClaimedLabrastroMessageDelivery(ctx, db.RetryClaimedLabrastroMessageDeliveryParams{
		ID:            d.ID,
		LeaseToken:    d.LeaseToken,
		NextAttemptAt: pgtype.Timestamptz{Time: s.now().Add(backoff), Valid: true},
		ErrorCode:     pgtype.Text{String: out.errorCode, Valid: out.errorCode != ""},
		LastError:     pgtype.Text{String: out.detail, Valid: out.detail != ""},
	}); err != nil {
		s.logLeaseLoss("retry", d, err)
		return
	}
	s.logger().Warn("messagedelivery: delivery deferred",
		"delivery_id", util.UUIDToString(d.ID),
		"attempt", d.Attempts+1,
		"backoff", backoff.String(),
		"reason_code", out.errorCode,
	)
}

// backoffFor is the automatic retry schedule for transient failures.
func backoffFor(attempt int) time.Duration {
	backoff := time.Second << min(attempt, 5)
	if backoff > 30*time.Second {
		backoff = 30 * time.Second
	}
	return backoff
}

func (s *Service) logLeaseLoss(operation string, d db.LabrastroMessageDelivery, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		// Lease ownership changed hands; the new owner owns the outcome.
		s.logger().Debug("messagedelivery: lease ownership changed",
			"operation", operation,
			"delivery_id", util.UUIDToString(d.ID),
		)
		return
	}
	s.logger().Error("messagedelivery: lease-guarded write failed",
		"operation", operation,
		"delivery_id", util.UUIDToString(d.ID),
		"error", err,
	)
}

// ---- compensation scan ----

func (s *Service) scanEvery() time.Duration {
	if s.ScanEvery > 0 {
		return s.ScanEvery
	}
	return defaultScanEvery
}

// scanLoop is the compensator: recover expired claims, re-sync stale run
// terminals through the EXISTING sync logic, and decide any persisted
// source (automation run or OL-27 inbox/activity/comment record) that still
// lacks a decision for an enabled route target. A source-event wakeup
// triggers a decide pass immediately — a latency hint only.
func (s *Service) scanLoop(ctx context.Context) {
	ticker := time.NewTicker(s.scanEvery())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.decideNotify:
			s.decideSourcesOnce(ctx)
			continue
		case <-ticker.C:
		}
		if err := s.ScanOnce(ctx); err != nil {
			s.logger().Error("messagedelivery: compensation scan", "error", err)
		}
	}
}

// ScanOnce runs one bounded compensator pass. Exported for tests. Each
// scanner's failure is contained: one class failing must not permanently
// block the others (repair contract §4).
func (s *Service) ScanOnce(ctx context.Context) error {
	var failures []error
	if err := s.requeueExpiredClaims(ctx); err != nil {
		failures = append(failures, err)
	}
	if s.Syncer != nil {
		for scanner, run := range map[string]func(context.Context, scanCursor) (scanCursor, error){
			scannerRunOnlyTask:   s.syncStaleRunOnlyTasks,
			scannerIssueStatus:   s.syncStaleCreateIssueIssues,
			scannerLinkedFailure: s.syncStaleLinkedTaskFailures,
		} {
			if _, err := s.advanceScanner(ctx, scanner, run); err != nil && !errors.Is(err, errScanCursorMoved) {
				failures = append(failures, err)
			}
		}
	}
	if err := s.decideMissing(ctx); err != nil {
		failures = append(failures, err)
	}
	// OL-27: the three persisted personal/team sources advance on their
	// own cursors, independent of the run machinery and of each other —
	// one source class's backlog never holds another's position hostage.
	failures = append(failures, s.decideSourcesErr(ctx)...)
	return errors.Join(failures...)
}

// sourceScanners maps each OL-27 scanner cursor onto its candidate page —
// see sourceScannerFuncs.

// sourceScannerFuncs returns the scanner name → page function pairs.
func (s *Service) sourceScannerFuncs() map[string]func(context.Context, scanCursor) (scanCursor, error) {
	return map[string]func(context.Context, scanCursor) (scanCursor, error){
		scannerInboxSource:    s.scanInboxSourceDecisions,
		scannerActivitySource: s.scanActivitySourceDecisions,
		scannerCommentSource:  s.scanCommentSourceDecisions,
	}
}

// decideSourcesErr advances every source scanner, containing each failure.
func (s *Service) decideSourcesErr(ctx context.Context) []error {
	var failures []error
	for scanner, page := range s.sourceScannerFuncs() {
		if _, err := s.advanceScanner(ctx, scanner, page); err != nil && !errors.Is(err, errScanCursorMoved) {
			failures = append(failures, err)
		}
	}
	return failures
}

// decideSourcesOnce runs one bounded decide pass over the persisted
// sources — the body a wakeup or a periodic tick executes.
func (s *Service) decideSourcesOnce(ctx context.Context) {
	for _, err := range s.decideSourcesErr(ctx) {
		s.logger().Error("messagedelivery: source decide scan", "error", err)
	}
}

// ---- persistent per-scanner cursors (repair contract §4, review R4) ----

// Scanner names. ONE cursor row per scanner: the source classes advance
// independently, so one class's backlog can never hold another's position
// hostage. The first three are the OL-25 run-side scanners; the last three
// are the OL-27 persisted-source decide scans.
const (
	scannerRunOnlyTask    = "run_only_terminal_task"
	scannerIssueStatus    = "create_issue_issue_status"
	scannerLinkedFailure  = "create_issue_linked_task_failure"
	scannerInboxSource    = "inbox_source_delivery"
	scannerActivitySource = "activity_source_delivery"
	scannerCommentSource  = "comment_source_delivery"
)

const (
	// scanPageLimit bounds one page.
	scanPageLimit = 200
	// scanRowBudgetPerTick is the per-tick work budget in ROWS; when it
	// runs out the position is saved and the NEXT tick continues from it.
	scanRowBudgetPerTick = 20_000
)

// requeueExpiredClaims moves crashed claims to uncertain. The send may
// have left the process, so "uncertain" is the only honest state; manual
// verify-and-retry with the fixed send UUID resolves it.
func (s *Service) requeueExpiredClaims(ctx context.Context) error {
	expired, err := s.Queries.RequeueExpiredLabrastroMessageDeliveryClaims(ctx, db.RequeueExpiredLabrastroMessageDeliveryClaimsParams{
		ErrorCode: pgtype.Text{String: ErrorCodeLeaseExpired, Valid: true},
		LastError: pgtype.Text{String: "send claim expired mid-flight; outcome unknown", Valid: true},
	})
	if err != nil {
		return err
	}
	for _, d := range expired {
		s.logger().Warn("messagedelivery: expired claim parked as uncertain",
			"delivery_id", util.UUIDToString(d.ID),
			"reason_code", ErrorCodeLeaseExpired,
		)
	}
	return nil
}

// scanCursor carries one bounded cycle. The generation guards every completed
// page; a stale replica must reload instead of advancing or resetting it.
type scanCursor struct {
	ts           time.Time
	id           pgtype.UUID
	upperID      pgtype.UUID
	generation   int64
	cycleStarted time.Time
	// nonempty distinguishes another target page at the same source ID from exhaustion; never persisted.
	nonempty bool
}

var scanCursorStart = scanCursor{id: pgtype.UUID{Valid: true}}
var errScanCursorMoved = errors.New("scan cursor advanced by another replica")

func cursorFromRow(row db.LabrastroMessageScanCursor) scanCursor {
	return scanCursor{ts: row.CursorTs.Time, id: row.CursorID, upperID: row.CycleUpperID,
		generation: row.Generation, cycleStarted: row.CycleStartedAt.Time}
}

// Each page is persisted only AFTER its sync calls finish. Crashes replay at
// most the unfinished page; shutdown never resets a partially scanned cycle.
func (s *Service) advanceScanner(ctx context.Context, scanner string, page func(context.Context, scanCursor) (scanCursor, error)) (scanCursor, error) {
	cur, err := s.loadCursor(ctx, scanner)
	if err != nil {
		return cur, err
	}
	for budget := scanRowBudgetPerTick; budget > 0; budget -= scanPageLimit {
		last, err := page(ctx, cur)
		if err != nil {
			return cur, err
		}
		if last.id == cur.id && !last.nonempty {
			// Exhausted this fixed bound. The next tick freezes a new bound.
			cur.id, cur.upperID = scanCursorStart.id, pgtype.UUID{}
			return s.saveCursor(ctx, scanner, cur)
		}
		cur, err = s.saveCursor(ctx, scanner, last)
		if err != nil {
			return cur, err
		}
	}
	return cur, nil
}

func (s *Service) loadCursor(ctx context.Context, scanner string) (scanCursor, error) {
	return s.loadCursorWithBound(ctx, scanner, func() (pgtype.UUID, error) {
		if scope := sourceScopeForScanner(scanner); scope != "" {
			return s.Queries.GetLabrastroMessageSourceScanUpperBound(ctx, scope)
		}
		return s.Queries.GetLabrastroMessageScanUpperBound(ctx, scanner == scannerIssueStatus)
	})
}

// loadCursorWithBound is loadCursor with an injectable cycle upper bound —
// the OL-27 source scanners freeze their bound over their own source table.
func (s *Service) loadCursorWithBound(ctx context.Context, scanner string, upperBound func() (pgtype.UUID, error)) (scanCursor, error) {
	row, err := s.Queries.GetLabrastroMessageScanCursor(ctx, scanner)
	if errors.Is(err, pgx.ErrNoRows) {
		row, err = s.Queries.InitLabrastroMessageScanCursor(ctx, scanner)
		if errors.Is(err, pgx.ErrNoRows) {
			row, err = s.Queries.GetLabrastroMessageScanCursor(ctx, scanner)
		}
	}
	if err != nil {
		return scanCursorStart, err
	}
	cur := cursorFromRow(row)
	if cur.upperID.Valid && cur.id.Valid {
		return cur, nil
	}
	upper, err := upperBound()
	if err != nil {
		return cur, err
	}
	cur.id, cur.upperID, cur.cycleStarted = scanCursorStart.id, upper, s.now()
	return s.saveCursor(ctx, scanner, cur)
}

// sourceScopeForScanner maps a source scanner name onto the route scope
// (and source table) it scans.
func sourceScopeForScanner(scanner string) string {
	switch scanner {
	case scannerInboxSource:
		return RouteSourceInbox
	case scannerActivitySource:
		return RouteSourceActivity
	case scannerCommentSource:
		return RouteSourceComment
	}
	return ""
}

func (s *Service) saveCursor(ctx context.Context, scanner string, cur scanCursor) (scanCursor, error) {
	row, err := s.Queries.SaveLabrastroMessageScanCursor(ctx, db.SaveLabrastroMessageScanCursorParams{
		Scanner: scanner, CursorTs: pgtype.Timestamptz{Time: cur.ts, Valid: true},
		CursorID: cur.id, CycleUpperID: cur.upperID,
		CycleStartedAt:     pgtype.Timestamptz{Time: cur.cycleStarted, Valid: true},
		ExpectedGeneration: cur.generation,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return cur, errScanCursorMoved
	}
	if err != nil {
		return cur, err
	}
	return cursorFromRow(row), nil
}

// syncStaleRunOnlyTasks finds run_only tasks whose run never heard about
// their terminal state and feeds them to the EXISTING sync logic. This
// module runs no second state machine — it reuses the upstream one.
func (s *Service) syncStaleRunOnlyTasks(ctx context.Context, cur scanCursor) (scanCursor, error) {
	tasks, err := s.Queries.ListStaleRunOnlyAutopilotTasks(ctx, db.ListStaleRunOnlyAutopilotTasksParams{
		AfterID: cur.id,
		UpperID: cur.upperID,
		Limit:   scanPageLimit,
	})
	if err != nil {
		return cur, err
	}
	for _, task := range tasks {
		s.Syncer.SyncRunFromTask(ctx, task)
	}
	if len(tasks) == 0 {
		return cur, nil
	}
	last := tasks[len(tasks)-1]
	cur.id = last.ID
	return cur, nil
}

func (s *Service) syncStaleCreateIssueIssues(ctx context.Context, cur scanCursor) (scanCursor, error) {
	issues, err := s.Queries.ListStaleCreateIssueAutopilotIssues(ctx, db.ListStaleCreateIssueAutopilotIssuesParams{
		AfterID: cur.id,
		UpperID: cur.upperID,
		Limit:   scanPageLimit,
	})
	if err != nil {
		return cur, err
	}
	for _, issue := range issues {
		s.Syncer.SyncRunFromIssue(ctx, issue)
	}
	if len(issues) == 0 {
		return cur, nil
	}
	last := issues[len(issues)-1]
	cur.id = last.ID
	return cur, nil
}

// syncStaleLinkedTaskFailures covers the third persisted source class
// (review R12): create_issue tasks that reached terminal failure through
// their ISSUE link while the run stayed active. SyncRunFromLinkedIssueTask
// is the existing state machine — including its HasActiveTaskForIssue guard,
// so an in-flight retry is never declared failed early.
func (s *Service) syncStaleLinkedTaskFailures(ctx context.Context, cur scanCursor) (scanCursor, error) {
	tasks, err := s.Queries.ListStaleLinkedIssueTaskFailures(ctx, db.ListStaleLinkedIssueTaskFailuresParams{
		AfterID: cur.id,
		UpperID: cur.upperID,
		Limit:   scanPageLimit,
	})
	if err != nil {
		return cur, err
	}
	for _, task := range tasks {
		s.Syncer.SyncRunFromLinkedIssueTask(ctx, task)
	}
	if len(tasks) == 0 {
		return cur, nil
	}
	last := tasks[len(tasks)-1]
	cur.id = last.ID
	return cur, nil
}

// decideMissing freezes a decision for every (terminal run, enabled route
// target) pair the candidate query still finds. Decisions — sends,
// suppressions and cancellations alike — shrink the set, so the scan is a
// full missing-set sweep whose cost decays as sources are judged.
func (s *Service) decideMissing(ctx context.Context) error {
	candidates, err := s.Queries.ListLabrastroMessageDeliveryCandidateRoutes(ctx, scanBatchSize)
	if err != nil {
		return err
	}
	visited := make(map[pgtype.UUID]bool)
	for _, c := range candidates {
		if visited[c.RunID] {
			continue
		}
		visited[c.RunID] = true
		if _, err := s.EnqueueRunDeliveries(ctx, c.RunID); err != nil {
			return err
		}
	}
	return nil
}
