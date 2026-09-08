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
	out := s.gateClaimed(ctx, d)
	if out == nil {
		v := s.sendDelivery(ctx, d)
		out = &v
	}

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
// without foreign keys.
func (s *Service) gateClaimed(ctx context.Context, d db.LabrastroMessageDelivery) *sendOutcome {
	refuse := func(status, code, detail string) *sendOutcome {
		return &sendOutcome{status: status, errorCode: code, detail: detail}
	}

	// Test sends skip the source/route gates: their route may be deleted
	// the moment after, and the audit record must still land.
	if d.SourceKind == SourceKindTestSend {
		return nil
	}

	if d.RouteID.Valid {
		route, err := s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{
			ID: d.RouteID, WorkspaceID: d.WorkspaceID,
		})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			return refuse(DeliveryStatusCancelled, ErrorCodeRouteDeleted, "route deleted before send")
		case err != nil:
			return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load route: "+err.Error())
		case !route.Enabled:
			return refuse(DeliveryStatusCancelled, ErrorCodeRouteDisabled, "route disabled before send")
		}
	}
	ap, err := s.Queries.GetAutopilot(ctx, d.AutopilotID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return refuse(DeliveryStatusCancelled, ErrorCodeSourceMissing, "source automation deleted before send")
	case err != nil:
		return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load autopilot: "+err.Error())
	case ap.Status == "archived":
		return refuse(DeliveryStatusCancelled, ErrorCodeSourceArchived, "source automation archived before send")
	}
	var snap targetSnapshot
	if err := json.Unmarshal(d.TargetSnapshot, &snap); err != nil {
		return refuse(DeliveryStatusFailed, ErrorCodeSendRejected, "corrupt target snapshot: "+err.Error())
	}
	instID, err := util.ParseUUID(snap.Installation)
	if err != nil {
		return refuse(DeliveryStatusFailed, ErrorCodeInstallationMissing, "target snapshot has no usable installation")
	}
	inst, err := s.Queries.GetChannelInstallationInWorkspace(ctx, db.GetChannelInstallationInWorkspaceParams{
		ID:          instID,
		WorkspaceID: d.WorkspaceID,
		ChannelType: snap.ChannelType,
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return refuse(DeliveryStatusFailed, ErrorCodeInstallationMissing, "installation no longer exists")
	case err != nil:
		return refuse(DeliveryStatusUncertain, ErrorCodeSendAmbiguous, "load installation: "+err.Error())
	case inst.Status != "active":
		return refuse(DeliveryStatusFailed, ErrorCodeInstallationRevoked, "installation is revoked")
	}
	return nil
}

func (s *Service) completeClaimed(ctx context.Context, d db.LabrastroMessageDelivery, out sendOutcome) {
	if _, err := s.Queries.CompleteClaimedLabrastroMessageDelivery(ctx, db.CompleteClaimedLabrastroMessageDeliveryParams{
		ID:         d.ID,
		LeaseToken: d.LeaseToken,
	}); err != nil {
		s.logLeaseLoss("complete", d, err)
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
// source that still lacks a decision for an enabled route target.
func (s *Service) scanLoop(ctx context.Context) {
	ticker := time.NewTicker(s.scanEvery())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if err := s.ScanOnce(ctx); err != nil {
			s.logger().Error("messagedelivery: compensation scan", "error", err)
		}
	}
}

// ScanOnce runs one bounded compensator pass. Exported for tests.
func (s *Service) ScanOnce(ctx context.Context) error {
	if err := s.requeueExpiredClaims(ctx); err != nil {
		return err
	}
	if s.Syncer != nil {
		if err := s.syncStaleSources(ctx); err != nil {
			return err
		}
	}
	return s.decideMissing(ctx)
}

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

// syncStaleSources finds tasks/issues whose automation run never heard
// about their terminal state and feeds them to the existing sync logic.
// This module runs no second state machine — it reuses the upstream one.
func (s *Service) syncStaleSources(ctx context.Context) error {
	tasks, err := s.Queries.ListStaleRunOnlyAutopilotTasks(ctx, scanBatchSize)
	if err != nil {
		return err
	}
	for _, task := range tasks {
		s.Syncer.SyncRunFromTask(ctx, task)
	}
	issues, err := s.Queries.ListStaleCreateIssueAutopilotIssues(ctx, scanBatchSize)
	if err != nil {
		return err
	}
	for _, issue := range issues {
		s.Syncer.SyncRunFromIssue(ctx, issue)
	}
	return nil
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
	for _, c := range candidates {
		ap := db.Autopilot{
			ID:            c.AutopilotID,
			WorkspaceID:   c.RunWorkspaceID,
			Title:         c.AutopilotTitle,
			ExecutionMode: c.AutopilotExecutionMode,
		}
		route := db.LabrastroMessageRoute{
			ID:              c.RouteID,
			WorkspaceID:     c.RunWorkspaceID,
			AutopilotID:     c.AutopilotID,
			InstallationID:  c.InstallationID,
			ChannelType:     c.ChannelType,
			TargetType:      c.TargetType,
			TargetUserID:    c.TargetUserID,
			TargetChatID:    c.TargetChatID,
			TargetMessageID: c.TargetMessageID,
			TargetThreadID:  c.TargetThreadID,
			TargetKey:       c.TargetKey,
			Conditions:      c.Conditions,
			ContentMode:     c.ContentMode,
			Revision:        c.RouteRevision,
		}
		in := decisionInput{
			WorkspaceID:         util.UUIDToString(c.RunWorkspaceID),
			AutopilotID:         util.UUIDToString(c.AutopilotID),
			RunID:               util.UUIDToString(c.RunID),
			RunStatus:           c.RunStatus,
			RunCompletedAt:      c.RunCompletedAt.Time,
			RunCompletedAtValid: c.RunCompletedAt.Valid,
			ExecutionMode:       c.AutopilotExecutionMode,
			Route:               route,
			Run: runFields{
				Result:        c.RunResult,
				FailureReason: c.RunFailureReason.String,
				ReasonCode:    c.RunReasonCode.String,
				IssueID:       util.UUIDToString(c.RunIssueID),
				IssueIDValid:  c.RunIssueID.Valid,
			},
		}
		if _, err := s.decideDelivery(ctx, ap, in); err != nil {
			return err
		}
	}
	return nil
}
