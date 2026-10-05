package messagedelivery

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Fail a named database read without damaging the database or intercepting
// outcome writes. The real queue, transactions and lease guards still run.
type failingDeliveryRead struct {
	db.DBTX
	name string
	hits int
}

func (f *failingDeliveryRead) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.HasPrefix(sql, "-- name: "+f.name+" ") {
		f.hits++
		return failedDeliveryRow{}
	}
	return f.DBTX.QueryRow(ctx, sql, args...)
}

type failedDeliveryRow struct{}

func (failedDeliveryRow) Scan(...any) error { return errors.New("injected database read failure") }

type failedReceiptTransaction struct{}

func (failedReceiptTransaction) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("injected receipt transaction failure")
}

func TestWorkerPreSendReadFailuresRetry(t *testing.T) {
	for _, name := range []string{
		"GetLabrastroMessageRoute", "GetAutopilotInWorkspace",
		"GetMemberByUserAndWorkspace", "IsAutopilotCollaborator", "GetWorkspace",
		"GetChannelInstallationInWorkspace", "GetChannelUserBindingForDelivery",
		"GetLabrastroMessageDeliveryLease", "GetActiveLabrastroMessageApprovedTarget",
		"receipt_transaction",
	} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			fx := newMDFixture(t, "read-failure", nil)
			fx.bindMember(t, testUID, "ou_read_failure")
			var route string
			if name == "GetActiveLabrastroMessageApprovedTarget" {
				route = fx.groupRoute(t, "oc_read_failure")
			} else {
				route = fx.memberTargetRoute(t, "member", testUID, nil)
			}
			run := fx.run(t, "completed", nil)
			sender := &fakeSender{}
			svc := newTestService(sender, nil)
			if n, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil || n != 1 {
				t.Fatalf("enqueue: %d %v", n, err)
			}
			delivery := firstDeliveryForRun(t, run)
			if name == "IsAutopilotCollaborator" {
				user := testFx.User(t, "collaborator", "collaborator-"+fx.autopilot+"@test.invalid")
				testFx.Member(t, testWSID, user, "member")
				testFx.Exec(t, `INSERT INTO autopilot_collaborator (autopilot_id,user_type,user_id,granted_by) VALUES ($1,'member',$2,$3)`, fx.autopilot, user, testUID)
				testFx.Cleanup(t, `DELETE FROM autopilot_collaborator WHERE autopilot_id=$1`, fx.autopilot)
				testFx.Exec(t, `UPDATE labrastro_message_route SET updated_by=$2 WHERE id=$1`, route, user)
			}
			fault := &failingDeliveryRead{DBTX: testPool, name: name}
			svc.Queries = db.New(fault)
			var logs bytes.Buffer
			svc.Log = slog.New(slog.NewTextHandler(&logs, nil))
			if name == "receipt_transaction" {
				svc.Tx = failedReceiptTransaction{}
			}
			if worked, err := svc.ProcessNext(ctx); err != nil || !worked {
				t.Fatalf("process: %v %v", worked, err)
			}
			if name != "receipt_transaction" && fault.hits == 0 {
				t.Fatal("fault was never exercised")
			}
			status, attempts, code, detail := deliveryStatus(t, delivery)
			if status != DeliveryStatusQueued || code != ErrorCodeSendTransient || attempts != 1 || sender.count() != 0 {
				t.Fatalf("known unsent failure: status=%s code=%s attempts=%d sends=%d", status, code, attempts, sender.count())
			}
			if detail == "" || strings.Contains(detail, "injected") || !strings.Contains(logs.String(), "injected") || !strings.Contains(logs.String(), "delivery_id="+delivery) {
				t.Fatalf("database error must appear only in logs: detail=%q logs=%s", detail, logs.String())
			}
			// The same delivery remains recoverable once the database recovers.
			svc.Queries = db.New(testPool)
			svc.Tx = testPool
			testFx.Exec(t, `UPDATE labrastro_message_delivery SET next_attempt_at=now() WHERE id=$1`, delivery)
			if worked, err := svc.ProcessNext(ctx); err != nil || !worked {
				t.Fatalf("recovery: %v %v", worked, err)
			}
			if status, _, _, _ := deliveryStatus(t, delivery); status != DeliveryStatusSent || sender.count() != 1 {
				t.Fatalf("recovered status=%s sends=%d", status, sender.count())
			}
		})
	}
}

func TestWorkerDefinitiveVerificationFailureDoesNotRetry(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "verification-rejected", nil)
	fx.groupRoute(t, "oc_verification_rejected")
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	if n, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil || n != 1 {
		t.Fatalf("enqueue: %d %v", n, err)
	}
	svc.Verifier = &fakeVerifier{groupErr: &SendError{Class: ClassPermanent, Err: errors.New("provider denied access")}}
	if worked, err := svc.ProcessNext(ctx); err != nil || !worked {
		t.Fatalf("process: %v %v", worked, err)
	}
	id := firstDeliveryForRun(t, run)
	status, attempts, code, _ := deliveryStatus(t, id)
	if status != DeliveryStatusFailed || code != ErrorCodeSendRejected || attempts != 1 || sender.count() != 0 {
		t.Fatalf("rejected verification: status=%s code=%s attempts=%d sends=%d", status, code, attempts, sender.count())
	}
	// Even after the backoff window, a definitive refusal is never reclaimed.
	testFx.Exec(t, `UPDATE labrastro_message_delivery SET next_attempt_at=now() WHERE id=$1`, id)
	if worked, err := svc.ProcessNext(ctx); worked || err != nil || sender.count() != 0 {
		t.Fatalf("retried refusal: %v %v sends=%d", worked, err, sender.count())
	}
}

func TestDiagnosticSourceReadFailureIsTransient(t *testing.T) {
	fx := newMDFixture(t, "test-send-read-failure", nil)
	fx.bindMember(t, testUID, "ou_test_send_failure")
	route := loadRoute(t, fx.memberTargetRoute(t, "member", testUID, nil))
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	fault := &failingDeliveryRead{DBTX: testPool, name: "GetAutopilotInWorkspace"}
	svc.Queries = db.New(fault)
	d, err := svc.TestSend(context.Background(), route, loadMember(t))
	if err != nil {
		t.Fatal(err)
	}
	if fault.hits == 0 || d.Status != DeliveryStatusFailed || d.ErrorCode.String != ErrorCodeSendTransient || sender.count() != 0 {
		t.Fatalf("diagnostic read failure: hits=%d status=%s code=%s sends=%d", fault.hits, d.Status, d.ErrorCode.String, sender.count())
	}
}

type cancelAfterLeaseRead struct {
	db.DBTX
	cancel context.CancelFunc
}

func (f cancelAfterLeaseRead) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	row := f.DBTX.QueryRow(ctx, sql, args...)
	if strings.HasPrefix(sql, "-- name: GetLabrastroMessageDeliveryLease ") {
		return cancelAfterRow{Row: row, cancel: f.cancel}
	}
	return row
}

type cancelAfterRow struct {
	pgx.Row
	cancel context.CancelFunc
}

func (r cancelAfterRow) Scan(dest ...any) error {
	err := r.Row.Scan(dest...)
	r.cancel()
	return err
}

func TestWorkerCancellationAfterLeaseCheckDoesNotDial(t *testing.T) {
	fx := newMDFixture(t, "cancel-before-dial", nil)
	fx.bindMember(t, testUID, "ou_cancel_before_dial")
	fx.memberTargetRoute(t, "member", testUID, nil)
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if n, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil || n != 1 {
		t.Fatalf("enqueue: %d %v", n, err)
	}
	svc.Queries = db.New(cancelAfterLeaseRead{DBTX: testPool, cancel: cancel})
	if worked, err := svc.ProcessNext(ctx); err != nil || !worked {
		t.Fatalf("process: %v %v", worked, err)
	}
	status, attempts, code, _ := deliveryStatus(t, firstDeliveryForRun(t, run))
	if ctx.Err() == nil || status != DeliveryStatusQueued || code != ErrorCodeSendTransient || attempts != 1 || sender.count() != 0 {
		t.Fatalf("pre-dial cancellation: ctx=%v status=%s code=%s attempts=%d sends=%d", ctx.Err(), status, code, attempts, sender.count())
	}
}

func TestWorkerRetryLimitBoundary(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "retry-limit", nil)
	fx.bindMember(t, testUID, "ou_retry_limit")
	fx.memberTargetRoute(t, "member", testUID, nil)
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{fn: func(SendRequest) (SendResult, error) {
		return SendResult{}, &SendError{Class: ClassTransient, Err: errors.New("rate limited")}
	}}
	svc := newTestService(sender, nil)
	svc.MaxSendAttempts = 3
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	delivery := firstDeliveryForRun(t, run)
	for attempt := 1; attempt <= 3; attempt++ {
		testFx.Exec(t, `UPDATE labrastro_message_delivery SET next_attempt_at=now() WHERE id=$1`, delivery)
		if worked, err := svc.ProcessNext(ctx); err != nil || !worked {
			t.Fatalf("attempt %d: %v %v", attempt, worked, err)
		}
		wantStatus, wantCode := DeliveryStatusQueued, ErrorCodeSendTransient
		if attempt == 3 {
			wantStatus, wantCode = DeliveryStatusFailed, ErrorCodeAttemptsExhausted
		}
		status, attempts, code, _ := deliveryStatus(t, delivery)
		if status != wantStatus || code != wantCode || attempts != int32(attempt) {
			t.Fatalf("attempt %d: status=%s code=%s attempts=%d", attempt, status, code, attempts)
		}
	}
	if worked, err := svc.ProcessNext(ctx); worked || err != nil || sender.count() != 3 {
		t.Fatalf("retry after limit: %v %v sends=%d", worked, err, sender.count())
	}
}

func TestWorkerDoesNotClaimDuringBackoff(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "backoff", nil)
	id := fx.terminalRunDelivery(t, DeliveryStatusQueued, testutil.Cols{"next_attempt_at": testutil.Raw("now()+interval '1 hour'")})
	svc := newTestService(&fakeSender{}, nil)
	if _, err := svc.Queries.ClaimDueLabrastroMessageDelivery(ctx); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("claimed deferred delivery: %v", err)
	}
	testFx.Exec(t, `UPDATE labrastro_message_delivery SET next_attempt_at=now()-interval '1 second' WHERE id=$1`, id)
	claim, err := svc.Queries.ClaimDueLabrastroMessageDelivery(ctx)
	if err != nil || !uuidEqual(claim.ID, id) {
		t.Fatalf("did not claim due delivery: %v %v", claim.ID, err)
	}
}

func TestWorkerExpiredLeaseWithoutSweepDoesNotDial(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "expired-unswept", nil)
	fx.bindMember(t, testUID, "ou_expired_unswept")
	fx.memberTargetRoute(t, "member", testUID, nil)
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	claim, err := svc.Queries.ClaimDueLabrastroMessageDelivery(ctx)
	if err != nil {
		t.Fatal(err)
	}
	testFx.Exec(t, `UPDATE labrastro_message_delivery SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, claim.ID)
	// Status and token still match: only the expiry predicate can refuse this.
	svc.processClaimed(ctx, claim)
	if sender.count() != 0 {
		t.Fatalf("expired worker sent %d shards", sender.count())
	}
	status, attempts, _, _ := deliveryStatus(t, firstDeliveryForRun(t, run))
	if status != DeliveryStatusSending || attempts != 0 {
		t.Fatalf("expired owner wrote status=%s attempts=%d", status, attempts)
	}
}

func TestEnqueueRunDeliveriesSecondRouteWindow(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "second-window", nil)
	early := fx.groupRoute(t, "oc_early")
	late := fx.groupRoute(t, "oc_late")
	boundary := time.Now().UTC().Truncate(time.Second)
	testFx.Exec(t, `UPDATE labrastro_message_route SET effective_from=$2 WHERE id=$1`, early, boundary.Add(-time.Hour))
	testFx.Exec(t, `UPDATE labrastro_message_route SET effective_from=$2 WHERE id=$1`, late, boundary)
	old := fx.run(t, "completed", testutil.Cols{"completed_at": boundary.Add(-time.Second)})
	svc := newTestService(&fakeSender{}, nil)
	if n, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, old)); err != nil || n != 1 {
		t.Fatalf("old run: %d %v", n, err)
	}
	if n := countDeliveries(t, `run_id=$1 AND route_id=$2`, old, late); n != 0 {
		t.Fatalf("late route received %d old decisions", n)
	}
	current := fx.run(t, "completed", testutil.Cols{"completed_at": boundary})
	if n, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, current)); err != nil || n != 2 {
		t.Fatalf("boundary run: %d %v", n, err)
	}
}

type contextDeliverySender func(context.Context, SendRequest) (SendResult, error)

func (f contextDeliverySender) Send(ctx context.Context, req SendRequest) (SendResult, error) {
	return f(ctx, req)
}

func TestWorkerShutdownFinishesInflightShard(t *testing.T) {
	for _, rejected := range []bool{false, true} {
		name := "accepted"
		if rejected {
			name = "rejected"
		}
		t.Run(name, func(t *testing.T) {
			fx := newMDFixture(t, "shutdown-"+name, nil)
			fx.bindMember(t, testUID, "ou_shutdown")
			fx.memberTargetRoute(t, "member", testUID, nil)
			run := fx.run(t, "completed", nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			started := make(chan context.Context, 1)
			release := make(chan struct{})
			svc := newTestService(contextDeliverySender(func(sendCtx context.Context, _ SendRequest) (SendResult, error) {
				started <- sendCtx
				select {
				case <-release:
				case <-sendCtx.Done():
					return SendResult{}, sendCtx.Err()
				}
				if rejected {
					return SendResult{}, &SendError{Class: ClassPermanent, Err: errors.New("provider refused")}
				}
				return SendResult{ExternalMessageID: "om_shutdown"}, nil
			}), nil)
			svc.ScanEvery = time.Hour
			if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
				t.Fatal(err)
			}
			go svc.Run(ctx)
			t.Cleanup(func() { cancel(); svc.WaitWithTimeout(ShutdownTimeout) })
			var sendCtx context.Context
			select {
			case sendCtx = <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("worker never entered Send")
			}
			cancel()
			if sendCtx.Err() != nil {
				close(release)
				t.Fatal("shutdown cancelled an in-flight shard")
			}
			if deadline, ok := sendCtx.Deadline(); !ok || time.Until(deadline) > ShutdownTimeout {
				close(release)
				t.Fatal("in-flight send has no bounded deadline")
			}
			close(release)
			if !svc.WaitWithTimeout(3 * time.Second) {
				t.Fatal("worker did not drain")
			}
			want := DeliveryStatusSent
			if rejected {
				want = DeliveryStatusFailed
			}
			d, receipts, err := svc.GetDelivery(context.Background(), uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, firstDeliveryForRun(t, run)))
			if err != nil || d.Status != want {
				t.Fatalf("shutdown outcome: %s %v", d.Status, err)
			}
			if !rejected && (len(receipts) != 1 || receipts[0].ExternalMessageID.String != "om_shutdown") {
				t.Fatalf("receipt lost: %+v", receipts)
			}
		})
	}
}

func TestWorkerCancellationBeforeDialRetries(t *testing.T) {
	fx := newMDFixture(t, "cancel-before-dial", nil)
	fx.bindMember(t, testUID, "ou_cancel_before_dial")
	fx.memberTargetRoute(t, "member", testUID, nil)
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	claim, err := svc.Queries.ClaimDueLabrastroMessageDelivery(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	svc.processClaimed(ctx, claim)
	status, _, code, _ := deliveryStatus(t, firstDeliveryForRun(t, run))
	if status != DeliveryStatusQueued || code != ErrorCodeSendTransient || sender.count() != 0 {
		t.Fatalf("pre-dial cancellation: %s %s sends=%d", status, code, sender.count())
	}
}

func (f *failingDeliveryRead) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.HasPrefix(sql, "-- name: "+f.name+" ") {
		f.hits++
		return nil, errors.New("injected database read failure")
	}
	return f.DBTX.Query(ctx, sql, args...)
}

func TestWorkerPersonalAndTeamGateReadFailuresRetry(t *testing.T) {
	for _, tc := range []struct{ kind, name string }{
		{RouteSourceInbox, "GetInboxItem"}, {RouteSourceInbox, "GetMemberByUserAndWorkspace"},
		{RouteSourceInbox, "ListNotificationPreferencesByUsers"},
		{RouteSourceActivity, "GetProjectInWorkspace"},
		{RouteSourceActivity, "GetActivity"}, {RouteSourceActivity, "GetIssue"},
		{RouteSourceActivity, "GetMemberByUserAndWorkspace"},
		{RouteSourceComment, "GetCommentInWorkspace"},
		{RouteSourceComment, "GetActiveLabrastroMessageSourceApprovedTarget"},
	} {
		t.Run(tc.kind+"/"+tc.name, func(t *testing.T) {
			resetSourceScanCursors(t)
			fx := newSourceFixture(t, "gate-read-"+tc.name)
			var ref string
			if tc.kind == RouteSourceInbox {
				fx.bindMember(t, testUID, "ou_personal_read")
				fx.personalRoute(t, "personal", testUID, nil)
				ref = fx.inboxItem(t, testUID, "status_changed", fx.issue)
			} else {
				if tc.name == "GetProjectInWorkspace" {
					testFx.Exec(t, `UPDATE issue SET project_id=$2 WHERE id=$1`, fx.issue, fx.project)
					fx.teamRoute(t, "team", tc.kind, "oc_team_read", testutil.Cols{"project_id": fx.project})
					fx.approveTeam(t, tc.kind, "oc_team_read", fx.project)
				} else {
					fx.teamRoute(t, "team", tc.kind, "oc_team_read", nil)
					fx.approveTeam(t, tc.kind, "oc_team_read")
				}
				if tc.kind == RouteSourceActivity {
					ref = fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"in_progress"}`)
				} else {
					ref = fx.comment(t, fx.issue, "body")
				}
			}
			sender := &fakeSender{}
			svc := newTestService(sender, nil)
			svc.decideSourcesOnce(context.Background())
			var id string
			testFx.QueryRow(t, `SELECT id FROM labrastro_message_delivery WHERE source_ref_id=$1`, ref).Scan(&id)
			fault := &failingDeliveryRead{DBTX: testPool, name: tc.name}
			svc.Queries = db.New(fault)
			if worked, err := svc.ProcessNext(context.Background()); err != nil || !worked {
				t.Fatalf("process: %v %v", worked, err)
			}
			status, _, code, _ := deliveryStatus(t, id)
			if fault.hits == 0 || status != DeliveryStatusQueued || code != ErrorCodeSendTransient || sender.count() != 0 {
				t.Fatalf("gate read: hits=%d status=%s code=%s sends=%d", fault.hits, status, code, sender.count())
			}
		})
	}
}

func TestWorkerTargetVerificationFailureRetries(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "verify-retry", nil)
	fx.groupRoute(t, "oc_verify_retry")
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	svc.Verifier = &fakeVerifier{groupErr: errors.New("verification timed out before send")}
	if worked, err := svc.ProcessNext(ctx); err != nil || !worked {
		t.Fatalf("process: %v %v", worked, err)
	}
	status, _, code, _ := deliveryStatus(t, firstDeliveryForRun(t, run))
	if status != DeliveryStatusQueued || code != ErrorCodeSendTransient || sender.count() != 0 {
		t.Fatalf("verification failure: %s %s sends=%d", status, code, sender.count())
	}
}

func TestWorkerShutdownBetweenShardsPreservesProgress(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fx := newMDFixture(t, "shutdown-between-shards", nil)
	fx.bindMember(t, testUID, "ou_shutdown_shards")
	fx.memberTargetRoute(t, "member", testUID, nil)
	run := fx.run(t, "completed", testutil.Cols{"result": testutil.Raw(`'{"output":"` + strings.Repeat("report ", 3000) + `"}'::jsonb`)})
	sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
		if req.ShardTotal < 2 {
			t.Error("fixture has no remaining shard")
		}
		cancel()
		return SendResult{ExternalMessageID: "om_first_shard"}, nil
	}}
	svc := newTestService(sender, nil)
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	if worked, err := svc.ProcessNext(ctx); err != nil || !worked {
		t.Fatalf("process: %v %v", worked, err)
	}
	d, receipts, err := svc.GetDelivery(context.Background(), uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, firstDeliveryForRun(t, run)))
	if err != nil || d.Status != DeliveryStatusQueued || d.ErrorCode.String != ErrorCodeSendTransient || sender.count() != 1 {
		t.Fatalf("cancelled next shard: status=%s code=%s sends=%d err=%v", d.Status, d.ErrorCode.String, sender.count(), err)
	}
	if len(receipts) != 1 || receipts[0].ExternalMessageID.String != "om_first_shard" {
		t.Fatalf("accepted shard lost its receipt: %+v", receipts)
	}
}

// An accepted send whose receipt cannot be persisted is ambiguous. It must
// remain parked until an explicit retry, which reuses the same send UUID.
func TestWorkerReceiptWriteFailureIsUncertain(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "receipt-write-failure", nil)
	fx.bindMember(t, testUID, "ou_receipt_failure")
	fx.memberTargetRoute(t, "receipt", testUID, nil)
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	s := newTestService(sender, nil)
	if err := s.decideMissing(ctx); err != nil {
		t.Fatal(err)
	}
	id := uuidOf(t, firstDeliveryForRun(t, run))
	fault := &failingDeliveryRead{DBTX: testPool, name: "RecordLabrastroMessageReceiptExternalID"}
	s.Queries = db.New(fault)
	claimed, err := s.Queries.ClaimLabrastroMessageDeliveryByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	s.processClaimed(ctx, claimed)
	d, receipts, err := s.GetDelivery(ctx, claimed.WorkspaceID, claimed.AutopilotID, id)
	if err != nil || fault.hits != 1 || sender.count() != 1 || d.Status != DeliveryStatusUncertain || d.ErrorCode.String != ErrorCodeSendAmbiguous {
		t.Fatalf("receipt failure: status=%s code=%s hits=%d sends=%d err=%v", d.Status, d.ErrorCode.String, fault.hits, sender.count(), err)
	}
	if len(receipts) != 1 || receipts[0].ExternalMessageID.Valid || receipts[0].SendUuid != sender.requests()[0].SendUUID {
		t.Fatalf("ambiguous receipt lost its identity: %+v", receipts)
	}
	s.Queries = db.New(testPool)
	if err := s.decideMissing(ctx); err != nil {
		t.Fatal(err)
	}
	if worked, err := s.ProcessNext(ctx); err != nil || worked || sender.count() != 1 {
		t.Fatalf("ambiguous send retried automatically: worked=%v sends=%d err=%v", worked, sender.count(), err)
	}
	if _, err := s.RetryDelivery(ctx, d.WorkspaceID, d.AutopilotID, d.ID); err != nil {
		t.Fatal(err)
	}
	if worked, err := s.ProcessNext(ctx); err != nil || !worked {
		t.Fatalf("explicit retry: worked=%v err=%v", worked, err)
	}
	d, receipts, err = s.GetDelivery(ctx, d.WorkspaceID, d.AutopilotID, d.ID)
	requests := sender.requests()
	if err != nil || d.Status != DeliveryStatusSent || len(requests) != 2 || requests[0].SendUUID != requests[1].SendUUID || len(receipts) != 1 || !receipts[0].ExternalMessageID.Valid {
		t.Fatalf("retry did not reconcile the original receipt: status=%s receipts=%+v requests=%+v err=%v", d.Status, receipts, requests, err)
	}
}
