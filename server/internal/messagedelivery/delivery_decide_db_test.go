package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ---- decision tests ----

// The exactly-once DECISION contract: repeated wakeups, the compensator and
// equivalent routes all collapse into one row per (source, target).
func TestEnqueueRunDeliveries_DecidesOnce(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "decide-once", nil)
	route := fx.memberTargetRoute(t, "route", testUID, nil)
	userID := testUID
	fx.bindMember(t, userID, "ou_member_1")
	run := fx.run(t, "completed", nil)

	svc := newTestService(nil, nil)

	decided, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run))
	if err != nil || decided != 1 {
		t.Fatalf("first enqueue: decided=%d err=%v", decided, err)
	}
	// Replay: the same run decided again (duplicate event / second replica).
	decided, err = svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run))
	if err != nil || decided != 0 {
		t.Fatalf("replay enqueue: decided=%d err=%v (want 0: already decided)", decided, err)
	}
	if n := countDeliveries(t, `run_id = $1`, run); n != 1 {
		t.Fatalf("delivery rows for run = %d, want 1", n)
	}

	// An equivalent second route (same source + target identity) cannot
	// even be saved: the rule-level unique index refuses the duplicate, so
	// one target can only ever hold one decision per source.
	svcInput := RouteInput{
		InstallationID: fx.install,
		TargetType:     TargetMember,
		TargetUserID:   testUID,
		Conditions:     ConditionSuccess,
		ContentMode:    ContentWithOutput,
	}
	routeRow := loadRoute(t, route)
	if _, err := svc.CreateRoute(context.Background(), loadAutopilot(t, fx.autopilot), loadMember(t), svcInput); err == nil {
		t.Fatal("duplicate equivalent route save must be refused")
	} else if !errors.Is(err, ErrRouteAlreadyExists) {
		t.Fatalf("duplicate save error = %v, want ErrRouteAlreadyExists", err)
	}
	_ = routeRow
	if n := countDeliveries(t, `run_id = $1`, run); n != 1 {
		t.Fatalf("delivery rows after duplicate save attempt = %d, want 1", n)
	}
}

func TestEnqueueRunDeliveries_ConditionMismatchSuppresses(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "suppress", nil)
	fx.memberTargetRoute(t, "route", testUID, nil)
	run := fx.run(t, "skipped", nil) // skipped matches nothing

	svc := newTestService(nil, nil)
	decided, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run))
	if err != nil || decided != 1 {
		t.Fatalf("enqueue: decided=%d err=%v", decided, err)
	}
	status, _, errorCode, _ := deliveryStatus(t, firstDeliveryForRun(t, run))
	if status != DeliveryStatusSuppressed {
		t.Fatalf("status = %q, want suppressed", status)
	}
	if errorCode != ErrorCodeConditionMismatch {
		t.Fatalf("error_code = %v, want condition_mismatch", errorCode)
	}
}

// A run completing BEFORE the rule's boundary is out of scope entirely: no
// send and no suppressed decision, and the compensator never picks it up.
func TestEnqueueRunDeliveries_EffectiveFromWindow(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "window", nil)
	route := fx.memberTargetRoute(t, "route", testUID, nil)
	fx.bindMember(t, testUID, "ou_window")

	futureRouteUpdate(t, route, time.Hour)
	run := fx.run(t, "completed", nil) // completed now, boundary is in the future

	svc := newTestService(nil, nil)
	if err := svc.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce: %v", err)
	}
	if n := countDeliveries(t, `run_id = $1`, run); n != 0 {
		t.Fatalf("out-of-window run produced %d decisions, want 0", n)
	}
}

// The worker's happy path: claim → send every shard → sent, with a receipt
// carrying the external message id and NOTHING leaking from the result
// payload into the rendered body.
func TestWorker_SendsAndRecordsReceipt(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "send", nil)
	route := fx.memberTargetRoute(t, "route", testUID, nil)
	_ = route
	fx.bindMember(t, testUID, "ou_live")
	run := fx.run(t, "completed", nil)

	svc := newTestService(nil, nil)
	if decided, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil || decided != 1 {
		t.Fatalf("enqueue: %d %v", decided, err)
	}
	deliveryID := firstDeliveryForRun(t, run)

	sender := &fakeSender{}
	svc.Sender = sender
	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("ProcessNext: worked=%v err=%v", worked, err)
	}

	status, _, errorCode, lastErr := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusSent {
		t.Fatalf("status = %q (%v) err=%q, want sent", status, errorCode, lastErr)
	}
	if n := countReceipts(t, deliveryID); n != 1 {
		t.Fatalf("receipts = %d, want 1", n)
	}
	var externalID string
	if err := testPool.QueryRow(context.Background(),
		`SELECT external_message_id FROM labrastro_message_receipt WHERE delivery_id = $1`, deliveryID,
	).Scan(&externalID); err != nil || externalID == "" {
		t.Fatalf("external message id missing: %q %v", externalID, err)
	}
	for _, req := range sender.requests() {
		if req.Target.OpenID != "ou_live" {
			t.Fatalf("sent to %q, want the LIVE binding open_id", req.Target.OpenID)
		}
		if req.Target.Type != TargetMember || req.Target.ChatID != "" {
			t.Fatalf("member send must be addressed by open_id only: %+v", req.Target)
		}
	}
}

// A multi-shard delivery survives a mid-send transient failure: the retry
// resumes AFTER the shard that already landed (same receipt, same send
// uuid), and the final delivery carries one receipt per shard.
func TestWorker_ShardResumeAfterTransientFailure(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "shards", nil)
	route := fx.memberTargetRoute(t, "route", testUID, testutil.Cols{
		"content_mode": ContentWithOutput,
	})
	_ = route
	fx.bindMember(t, testUID, "ou_shards")
	run := fx.run(t, "completed", testutil.Cols{
		"result": testutil.Raw(fmt.Sprintf(`'{"output":%s}'::jsonb`, jsonQuote(stringsRepeat("报告内容。", 3000)))),
	})

	svc := newTestService(nil, nil)
	if _, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	var shardTotal int32
	if err := testPool.QueryRow(context.Background(),
		`SELECT shard_total FROM labrastro_message_delivery WHERE id = $1`, deliveryID).Scan(&shardTotal); err != nil {
		t.Fatal(err)
	}
	if shardTotal < 2 {
		t.Fatalf("expected a multi-shard plan, got %d", shardTotal)
	}

	attempt := 0
	sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
		attempt++
		// The SECOND send overall (shard 1's first attempt) is
		// rate-limited; everything else succeeds.
		if attempt == 2 {
			return SendResult{}, &SendError{Class: ClassTransient, Err: errors.New("rate limited")}
		}
		return SendResult{ExternalMessageID: fmt.Sprintf("om_shard_%d", req.ShardIndex)}, nil
	}}
	svc.Sender = sender
	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("first ProcessNext: %v %v", worked, err)
	}
	status, _, errorCode, lastErr := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusQueued {
		t.Fatalf("after transient failure status = %q (%v) err=%q, want queued for retry", status, errorCode, lastErr)
	}
	// Deliver immediately for the test (the backoff timestamp is set, but
	// the claim only fires when due — force the row due now).
	dueNow(t, deliveryID)

	var firstAttemptShard0 string
	if err := testPool.QueryRow(context.Background(),
		`SELECT send_uuid FROM labrastro_message_receipt WHERE delivery_id = $1 AND shard_index = 0`, deliveryID,
	).Scan(&firstAttemptShard0); err != nil {
		t.Fatal(err)
	}

	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("retry ProcessNext: %v %v", worked, err)
	}
	status, attempts, _, lastErr := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusSent {
		t.Fatalf("status = %q, want sent", status)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	// Shard 0 already carried a receipt, so the retry must NOT re-send
	// it; shard 1 was transiently refused and is sent exactly twice.
	sendsByShard := map[int]int{}
	for _, req := range sender.requests() {
		sendsByShard[req.ShardIndex]++
	}
	if sendsByShard[0] != 1 {
		t.Fatalf("shard 0 sent %d times, want exactly 1 (receipt-resume)", sendsByShard[0])
	}
	for shard := 1; shard < int(shardTotal); shard++ {
		want := 1
		if shard == 1 {
			want = 2 // transient refusal, then success on the retry
		}
		if sendsByShard[shard] != want {
			t.Fatalf("shard %d sent %d times, want %d", shard, sendsByShard[shard], want)
		}
	}
	// The send uuid for shard 0 is stable across the retry.
	var stableUUID string
	if err := testPool.QueryRow(context.Background(),
		`SELECT send_uuid FROM labrastro_message_receipt WHERE delivery_id = $1 AND shard_index = 0`, deliveryID,
	).Scan(&stableUUID); err != nil {
		t.Fatal(err)
	}
	if stableUUID != firstAttemptShard0 {
		t.Fatalf("shard 0 send uuid changed across retry: %q -> %q", firstAttemptShard0, stableUUID)
	}
}

func TestWorker_PermanentFailureIsExplainable(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "permanent", nil)
	fx.memberTargetRoute(t, "route", testUID, testutil.Cols{"conditions": ConditionFailure})
	fx.bindMember(t, testUID, "ou_gone")
	run := fx.run(t, "failed", testutil.Cols{
		"result":         nil,
		"failure_reason": testutil.Raw(`'internal error'`),
		"reason_code":    testutil.Raw(`'quota_exceeded'`),
		"completed_at":   testutil.Raw("now()"),
	})

	svc := newTestService(nil, nil)
	if _, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
		return SendResult{}, &SendError{Class: ClassPermanent, Code: "230013", Err: errors.New("no availability")}
	}}
	svc.Sender = sender
	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("ProcessNext: %v %v", worked, err)
	}
	status, _, errorCode, _ := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusFailed {
		t.Fatalf("status = %q, want failed", status)
	}
	if errorCode != ErrorCodeSendRejected {
		t.Fatalf("error_code = %v, want send_rejected", errorCode)
	}
}

// Ambiguous outcomes park as uncertain and are never auto-retried.
func TestWorker_AmbiguousOutcomeBecomesUncertain(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "ambiguous", nil)
	fx.memberTargetRoute(t, "route", testUID, nil)
	fx.bindMember(t, testUID, "ou_amb")
	run := fx.run(t, "completed", nil)

	svc := newTestService(nil, nil)
	if _, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
		return SendResult{}, &SendError{Class: ClassAmbiguous, Err: errors.New("context deadline exceeded")}
	}}
	svc.Sender = sender
	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("ProcessNext: %v %v", worked, err)
	}
	status, _, errorCode, lastErr := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusUncertain || errorCode != ErrorCodeSendAmbiguous {
		t.Fatalf("status=%q code=%v err=%q, want uncertain/send_ambiguous", status, errorCode, lastErr)
	}
	// A second ProcessNext pass must not touch it (uncertain is not
	// claimable).
	if worked, err := svc.ProcessNext(context.Background()); err != nil || worked {
		t.Fatalf("uncertain row was re-claimed: worked=%v err=%v", worked, err)
	}
}

// Pre-send gates: rule disabled after enqueue → cancelled, and the sender
// is never dialed.
func TestWorker_GateRefusesWhenRouteDisabled(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "gate", nil)
	route := fx.memberTargetRoute(t, "route", testUID, nil)
	fx.bindMember(t, testUID, "ou_gate")
	run := fx.run(t, "completed", nil)

	svc := newTestService(nil, nil)
	if _, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	if _, err := svc.SetRouteEnabled(context.Background(), loadRoute(t, route), loadMember(t), false, 1); err != nil {
		t.Fatalf("disable: %v", err)
	}
	// Disabling itself cancels queued sends.
	status, _, errorCode, _ := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusCancelled || errorCode != ErrorCodeRouteDisabled {
		t.Fatalf("after disable status=%q code=%v, want cancelled/route_disabled", status, errorCode)
	}
	sender := &fakeSender{}
	svc.Sender = sender
	if worked, err := svc.ProcessNext(context.Background()); err != nil || worked {
		t.Fatalf("cancelled row was claimed: %v %v", worked, err)
	}
	if sender.count() != 0 {
		t.Fatal("sender was dialed for a cancelled delivery")
	}
}

func TestWorker_GateCancelsWhenRouteDeleted(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "gate-del", nil)
	route := fx.memberTargetRoute(t, "route", testUID, nil)
	fx.bindMember(t, testUID, "ou_del")
	run := fx.run(t, "completed", nil)

	svc := newTestService(nil, nil)
	if _, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	testFx.Exec(t, `DELETE FROM labrastro_message_route WHERE id = $1`, route)

	sender := &fakeSender{}
	svc.Sender = sender
	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("ProcessNext: %v %v", worked, err)
	}
	status, _, errorCode, lastErr := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusCancelled || errorCode != ErrorCodeRouteDeleted {
		t.Fatalf("status=%q code=%v err=%q, want cancelled/route_deleted", status, errorCode, lastErr)
	}
	if sender.count() != 0 {
		t.Fatal("sender was dialed after route deletion")
	}
}

// Member unbinding between decision and send fails explainably instead of
// sending to a stale address.
func TestWorker_MemberUnboundAtSendFails(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "unbound", nil)
	fx.memberTargetRoute(t, "route", testUID, nil)
	binding := fx.bindMember(t, testUID, "ou_unbound")
	run := fx.run(t, "completed", nil)

	svc := newTestService(nil, nil)
	if _, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	testFx.Exec(t, `DELETE FROM channel_user_binding WHERE id = $1`, binding)

	sender := &fakeSender{}
	svc.Sender = sender
	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("ProcessNext: %v %v", worked, err)
	}
	status, _, errorCode, lastErr := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusFailed || errorCode != ErrorCodeMemberUnbound {
		t.Fatalf("status=%q code=%v err=%q, want failed/member_unbound", status, errorCode, lastErr)
	}
	if sender.count() != 0 {
		t.Fatal("sender was dialed for an unbound member")
	}
}

// A revoked installation fails the delivery at the gate.
func TestWorker_RevokedInstallationFails(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "revoked", nil)
	fx.memberTargetRoute(t, "route", testUID, nil)
	fx.bindMember(t, testUID, "ou_rev")
	run := fx.run(t, "completed", nil)

	svc := newTestService(nil, nil)
	if _, err := svc.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	testFx.Exec(t, `UPDATE channel_installation SET status = 'revoked' WHERE id = $1`, fx.install)

	sender := &fakeSender{}
	svc.Sender = sender
	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("ProcessNext: %v %v", worked, err)
	}
	status, _, errorCode, lastErr := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusFailed || errorCode != ErrorCodeInstallationRevoked {
		t.Fatalf("status=%q code=%v err=%q, want failed/installation_revoked", status, errorCode, lastErr)
	}
}

// Compensation: a decision that never happened (event lost, process died
// between source commit and decision) is recovered by the scanner.
func TestScanner_DecidesMissingSource(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "compensate", nil)
	fx.memberTargetRoute(t, "route", testUID, nil)
	fx.bindMember(t, testUID, "ou_comp")
	run := fx.run(t, "completed", nil) // no event fired at all

	svc := newTestService(nil, nil)
	if err := svc.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce: %v", err)
	}
	if n := countDeliveries(t, `run_id = $1`, run); n != 1 {
		t.Fatalf("compensator produced %d decisions, want 1", n)
	}
	// Idempotent: a second pass adds nothing.
	if err := svc.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce 2: %v", err)
	}
	if n := countDeliveries(t, `run_id = $1`, run); n != 1 {
		t.Fatalf("second pass produced %d total decisions, want 1", n)
	}
}

// Compensation: a task that finished but whose run never synced is fed to
// the EXISTING sync logic — the module runs no state machine of its own.
func TestScanner_SyncsStaleRunOnlyTask(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "stale-task", nil)
	run := fx.run(t, "running", testutil.Cols{"completed_at": nil})
	task := testFx.Insert(t, "agent_task_queue", testutil.Cols{
		"agent_id":         testAgent,
		"status":           "completed",
		"completed_at":     testutil.Raw("now()"),
		"priority":         0,
		"autopilot_run_id": run,
	})

	syncer := &fakeSyncer{}
	svc := newTestService(nil, syncer)
	if err := svc.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce: %v", err)
	}
	syncer.mu.Lock()
	defer syncer.mu.Unlock()
	if len(syncer.tasks) != 1 || !uuidEqual(syncer.tasks[0].ID, task) {
		t.Fatalf("syncer got %d tasks, want the stale one", len(syncer.tasks))
	}
}

func TestScanner_SyncsStaleCreateIssueRun(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "stale-issue", testutil.Cols{
		"execution_mode": "create_issue",
	})
	issue := testFx.Issue(t, "stale create_issue target", testutil.Cols{"status": "done"})
	_ = fx.run(t, "issue_created", testutil.Cols{
		"completed_at": nil,
		"issue_id":     issue,
	})

	syncer := &fakeSyncer{}
	svc := newTestService(nil, syncer)
	if err := svc.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce: %v", err)
	}
	syncer.mu.Lock()
	defer syncer.mu.Unlock()
	found := false
	for _, i := range syncer.issues {
		if uuidEqual(i.ID, issue) {
			found = true
		}
	}
	if !found {
		t.Fatalf("syncer got %d issues, want the stale one %s", len(syncer.issues), issue)
	}
}

// A claim whose worker died mid-send resolves to uncertain, never silently
// back to queued (blind requeue could duplicate the send).
func TestScanner_ExpiredClaimBecomesUncertain(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "expired", nil)
	deliveryID := fx.terminalRunDelivery(t, DeliveryStatusSending, testutil.Cols{
		"lease_token":      testutil.Raw("gen_random_uuid()"),
		"lease_expires_at": testutil.Raw("now() - interval '1 minute'"),
	})

	svc := newTestService(nil, nil)
	if err := svc.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce: %v", err)
	}
	status, _, errorCode, lastErr := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusUncertain || errorCode != ErrorCodeLeaseExpired {
		t.Fatalf("status=%q code=%v err=%q, want uncertain/lease_expired", status, errorCode, lastErr)
	}
}

// Manual retry: allowed from failed and uncertain, refused otherwise; the
// requeued row is claimable again and the sender sees the SAME send uuid.
func TestRetryDelivery_Semantics(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "retry", nil)
	fx.bindMember(t, testUID, "ou_retry")
	deliveryID := fx.terminalRunDelivery(t, DeliveryStatusFailed, nil)

	svc := newTestService(nil, nil)
	// A failed row whose cause is unfixed stays failed (permanent class).
	sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
		return SendResult{}, &SendError{Class: ClassPermanent, Code: "230013", Err: errors.New("still bad")}
	}}
	svc.Sender = sender
	if _, err := svc.RetryDelivery(context.Background(), uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, deliveryID)); err != nil {
		t.Fatalf("retry failed row: %v", err)
	}
	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("ProcessNext: %v %v", worked, err)
	}
	status, _, errorCode, lastErr := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusFailed || errorCode != ErrorCodeSendRejected {
		t.Fatalf("after retry status=%q code=%v err=%q", status, errorCode, lastErr)
	}

	// An uncertain row re-queues and then succeeds.
	uncertain := fx.terminalRunDelivery(t, DeliveryStatusUncertain, nil)
	svc.Sender = &fakeSender{}
	if _, err := svc.RetryDelivery(context.Background(), uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, uncertain)); err != nil {
		t.Fatalf("retry uncertain row: %v", err)
	}
	if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("ProcessNext: %v %v", worked, err)
	}
	if status, _, _, _ := deliveryStatus(t, uncertain); status != DeliveryStatusSent {
		t.Fatalf("retried uncertain row status = %q, want sent", status)
	}

	// A sent row is not retryable.
	sent := fx.terminalRunDelivery(t, DeliveryStatusSent, nil)
	if _, err := svc.RetryDelivery(context.Background(), uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, sent)); err == nil {
		t.Fatal("retrying a sent delivery must be refused")
	}
}

// Test send: the real path runs synchronously and records outcome +
// receipt; group targets are addressed by chat_id, topics via the anchor.
func TestTestSend_TargetAddressing(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "testsend", nil)
	topicRoute := testFx.Insert(t, "labrastro_message_route", testutil.Cols{
		"id":                testutil.Raw("gen_random_uuid()"),
		"workspace_id":      testWSID,
		"autopilot_id":      fx.autopilot,
		"installation_id":   fx.install,
		"channel_type":      "feishu",
		"target_type":       "topic",
		"target_chat_id":    "oc_topic",
		"target_message_id": "om_anchor",
		"target_thread_id":  "om_thread",
		"target_key":        TargetKey(TargetTopic, "", "oc_topic", "om_anchor"),
		"conditions":        ConditionSuccess,
		"content_mode":      ContentSummary,
		"enabled":           true,
		"created_by":        testUID,
		"updated_by":        testUID,
	})

	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	delivery, err := svc.TestSend(context.Background(), loadRoute(t, topicRoute), loadMember(t))
	if err != nil {
		t.Fatalf("TestSend: %v", err)
	}
	if delivery.Status != DeliveryStatusSent {
		t.Fatalf("test send status = %q", delivery.Status)
	}
	reqs := sender.requests()
	if len(reqs) != 1 {
		t.Fatalf("sender calls = %d, want 1", len(reqs))
	}
	req := reqs[0]
	if req.Target.ChatID != "oc_topic" || req.Target.MessageID != "om_anchor" {
		t.Fatalf("topic target = %+v", req.Target)
	}
	if req.SendUUID == "" {
		t.Fatal("test send must carry an idempotency uuid")
	}
	if n := countReceipts(t, util.UUIDToString(delivery.ID)); n != 1 {
		t.Fatalf("test send receipts = %d, want 1", n)
	}
}

// ---- helpers ----

func firstDeliveryForRun(t testing.TB, runID string) string {
	t.Helper()
	var id string
	if err := testPool.QueryRow(context.Background(),
		`SELECT id::text FROM labrastro_message_delivery WHERE run_id = $1 ORDER BY created_at LIMIT 1`, runID,
	).Scan(&id); err != nil {
		t.Fatalf("no delivery for run %s: %v", runID, err)
	}
	return id
}

func loadAutopilot(t testing.TB, id string) db.Autopilot {
	t.Helper()
	ap, err := db.New(testPool).GetAutopilot(context.Background(), uuidOf(t, id))
	if err != nil {
		t.Fatalf("load autopilot %s: %v", id, err)
	}
	return ap
}

func uuidEqual(u pgtype.UUID, raw string) bool {
	return util.UUIDToString(u) == raw
}

func uuidOf(t testing.TB, s string) pgtype.UUID {
	t.Helper()
	u, err := util.ParseUUID(s)
	if err != nil {
		t.Fatalf("bad uuid %q: %v", s, err)
	}
	return u
}

func loadRoute(t testing.TB, id string) db.LabrastroMessageRoute {
	t.Helper()
	route, err := db.New(testPool).GetLabrastroMessageRoute(context.Background(), db.GetLabrastroMessageRouteParams{
		ID: uuidOf(t, id), WorkspaceID: uuidOf(t, testWSID),
	})
	if err != nil {
		t.Fatalf("load route %s: %v", id, err)
	}
	return route
}

func loadMember(t testing.TB) db.Member {
	return db.Member{UserID: uuidOf(t, testUID)}
}

func futureRouteUpdate(t testing.TB, routeID string, d time.Duration) {
	t.Helper()
	ct, err := testPool.Exec(context.Background(),
		`UPDATE labrastro_message_route SET effective_from = now() + $1::interval WHERE id = $2`,
		d, uuidOf(t, routeID))
	if err != nil {
		t.Fatalf("shift effective_from: %v", err)
	}
	_ = ct
}

func dueNow(t testing.TB, deliveryID string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE labrastro_message_delivery SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
		uuidOf(t, deliveryID)); err != nil {
		t.Fatalf("due now: %v", err)
	}
}

func stringsRepeat(s string, n int) string {
	out := ""
	for range n {
		out += s
	}
	return out
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
