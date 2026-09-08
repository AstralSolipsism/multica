package messagedelivery

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestContractUnknownSourceIsDurablySuppressed(t *testing.T) {
	for _, mode := range []string{SourceKindRunOnly, SourceKindCreateIssue} {
		t.Run(mode, func(t *testing.T) {
			fx := newMDFixture(t, "unknown", testutil.Cols{"execution_mode": mode})
			fx.groupRoute(t, "oc_unknown")
			run := fx.run(t, "failed", testutil.Cols{"result": nil, "failure_reason": "synthetic private error"})
			sender := &fakeSender{}
			s := newTestService(sender, nil)
			if n, err := s.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil || n != 1 {
				t.Fatalf("enqueue %d: %v", n, err)
			}
			d, _, err := s.GetDelivery(context.Background(), uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, firstDeliveryForRun(t, run)))
			if err != nil {
				t.Fatal(err)
			}
			if d.SourceKind != SourceKindUnknown || d.Status != DeliveryStatusSuppressed || d.ErrorCode.String != "source_unresolved" || d.ShardTotal != 0 {
				t.Fatalf("unknown source decision: %+v", d)
			}
			if strings.Contains(string(d.ContentSnapshot), "synthetic") || strings.Contains(string(d.ContentSnapshot), "report") {
				t.Fatal("unknown source exposed content")
			}
			if n, err := s.EnqueueRunDeliveries(context.Background(), uuidOf(t, run)); err != nil || n != 0 {
				t.Fatalf("duplicate decision: %d %v", n, err)
			}
			if worked, err := s.ProcessNext(context.Background()); worked || err != nil || sender.count() != 0 {
				t.Fatalf("suppressed source sent: %v %v", worked, err)
			}
		})
	}
}

func TestContractMemberBindingIsCheckedBetweenShards(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "member-shards", nil)
	fx.bindMember(t, testUID, "ou_contract_shards")
	fx.memberTargetRoute(t, "member", testUID, nil)
	run := fx.run(t, "completed", testutil.Cols{"result": testutil.Raw(`'{"output":"` + strings.Repeat("report ", 3000) + `"}'::jsonb`)})
	sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
		if req.ShardTotal < 2 {
			t.Fatal("fixture did not create multiple shards")
		}
		testFx.Exec(t, `DELETE FROM channel_user_binding WHERE installation_id=$1`, fx.install)
		return SendResult{ExternalMessageID: "om_first_only"}, nil
	}}
	s := newTestService(sender, nil)
	if _, err := s.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProcessNext(ctx); err != nil {
		t.Fatal(err)
	}
	if sender.count() != 1 {
		t.Fatalf("sent %d shards after unbinding", sender.count())
	}
	d, receipts, err := s.GetDelivery(ctx, uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, firstDeliveryForRun(t, run)))
	if err != nil {
		t.Fatal(err)
	}
	accepted := 0
	for _, r := range receipts {
		if r.ExternalMessageID.Valid {
			accepted++
		}
	}
	if d.Status != DeliveryStatusFailed || d.ErrorCode.String != ErrorCodeMemberUnbound || accepted != 1 {
		t.Fatalf("lost accepted receipt or sent past unbinding: %s %s accepted=%d", d.Status, d.ErrorCode.String, accepted)
	}
}

func TestContractMissingVerifierFailsClosed(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "no-verifier", nil)
	fx.groupRoute(t, "oc_no_verifier")
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	s := newTestService(sender, nil)
	s.Verifier = nil
	if _, err := s.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProcessNext(ctx); err != nil {
		t.Fatal(err)
	}
	status, _, _, _ := deliveryStatus(t, firstDeliveryForRun(t, run))
	if sender.count() != 0 || status != DeliveryStatusUncertain {
		t.Fatalf("missing verifier: sends=%d status=%s", sender.count(), status)
	}
}

func TestContractTestSendReturnsLiveStateAfterLostLease(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "diagnostic-lost-lease", nil)
	route := loadRoute(t, fx.groupRoute(t, "oc_diagnostic_lease"))
	sender := &fakeSender{}
	s := newTestService(sender, nil)
	verified := 0
	s.Verifier = rereviewVerifier{onGroup: func() error {
		verified++
		if verified == 2 {
			testFx.Exec(t, `UPDATE labrastro_message_delivery SET lease_expires_at=now()-interval '1 second' WHERE route_id=$1`, route.ID)
			return s.requeueExpiredClaims(ctx)
		}
		return nil
	}}
	d, err := s.TestSend(ctx, route, loadMember(t))
	if err != nil || !d.ID.Valid || d.Status != DeliveryStatusUncertain || sender.count() != 0 || verified != 2 {
		t.Fatalf("diagnostic did not return recovered state: id=%v status=%s sends=%d verifications=%d err=%v", d.ID.Valid, d.Status, sender.count(), verified, err)
	}
}

func TestContractTestSendRecoveryUsesPersistedActor(t *testing.T) {
	for _, reason := range []string{"actor_left", "historical_actor_unknown"} {
		t.Run(reason, func(t *testing.T) {
			ctx := context.Background()
			fx := newMDFixture(t, "diagnostic-actor", nil)
			route := loadRoute(t, fx.groupRoute(t, "oc_diagnostic_actor"))
			actorID := testFx.User(t, "diagnostic actor", "diagnostic-"+fx.autopilot+"@example.invalid")
			testFx.Member(t, testWSID, actorID, "admin")
			q := db.New(testPool)
			actor, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: route.WorkspaceID, UserID: uuidOf(t, actorID)})
			if err != nil {
				t.Fatal(err)
			}
			sender := &fakeSender{fn: func(SendRequest) (SendResult, error) {
				return SendResult{}, &SendError{Class: ClassPermanent, Err: errors.New("synthetic diagnostic rejection")}
			}}
			s := newTestService(sender, nil)
			d, err := s.TestSend(ctx, route, actor)
			if err != nil || d.Status != DeliveryStatusFailed || d.RequestedBy != actor.UserID || strings.Contains(string(d.SourceRef), actorID) {
				t.Fatalf("diagnostic actor was not persisted separately: status=%s actor=%v err=%v", d.Status, d.RequestedBy, err)
			}
			if reason == "actor_left" {
				testFx.Exec(t, `DELETE FROM member WHERE workspace_id=$1 AND user_id=$2`, testWSID, actorID)
			} else {
				testFx.Exec(t, `UPDATE labrastro_message_delivery SET requested_by=NULL WHERE id=$1`, d.ID)
			}
			if _, err := s.RetryDelivery(ctx, route.WorkspaceID, route.AutopilotID, d.ID); err != nil {
				t.Fatal(err)
			}
			if worked, err := s.ProcessNext(ctx); !worked || err != nil {
				t.Fatalf("retry: worked=%v err=%v", worked, err)
			}
			d, _, err = s.GetDelivery(ctx, route.WorkspaceID, route.AutopilotID, d.ID)
			if err != nil || d.Status != DeliveryStatusCancelled || d.ErrorCode.String != ErrorCodeAuthorizationLost || sender.count() != 1 {
				t.Fatalf("route author's authority replaced diagnostic actor: status=%s code=%s sends=%d err=%v", d.Status, d.ErrorCode.String, sender.count(), err)
			}
		})
	}
}

func TestContractLateOutcomesCannotRestoreSendingAuthority(t *testing.T) {
	for _, entry := range []string{"worker", "test_send"} {
		for _, outcome := range []string{"accepted", "transient", "permanent", "ambiguous"} {
			t.Run(entry+"/"+outcome, func(t *testing.T) {
				ctx := context.Background()
				fx := newMDFixture(t, "late-outcome", nil)
				route := loadRoute(t, fx.groupRoute(t, "oc_late_outcome"))
				var deliveryID string
				sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
					testFx.QueryRow(t, `SELECT id FROM labrastro_message_delivery WHERE route_id=$1`, route.ID).Scan(&deliveryID)
					testFx.Exec(t, `UPDATE labrastro_message_delivery SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, deliveryID)
					switch outcome {
					case "accepted":
						return SendResult{ExternalMessageID: "om_late_accepted"}, nil
					case "transient":
						return SendResult{}, &SendError{Class: ClassTransient, Err: errors.New("synthetic transient")}
					case "permanent":
						return SendResult{}, &SendError{Class: ClassPermanent, Err: errors.New("synthetic rejection")}
					default:
						return SendResult{}, &SendError{Class: ClassAmbiguous, Err: errors.New("synthetic ambiguity")}
					}
				}}
				s := newTestService(sender, nil)
				if entry == "worker" {
					if _, err := s.EnqueueRunDeliveries(ctx, uuidOf(t, fx.run(t, "completed", nil))); err != nil {
						t.Fatal(err)
					}
					if _, err := s.ProcessNext(ctx); err != nil {
						t.Fatal(err)
					}
				} else if _, err := s.TestSend(ctx, route, loadMember(t)); err != nil {
					t.Fatal(err)
				}
				if deliveryID == "" || sender.count() != 1 {
					t.Fatal("late-response injection was not reached")
				}
				status, _, _, _ := deliveryStatus(t, deliveryID)
				if status != DeliveryStatusSending && status != DeliveryStatusUncertain {
					t.Fatalf("expired owner wrote %s", status)
				}
				if err := s.requeueExpiredClaims(ctx); err != nil {
					t.Fatal(err)
				}
				d, receipts, err := s.GetDelivery(ctx, uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, deliveryID))
				if err != nil {
					t.Fatal(err)
				}
				if d.Status != DeliveryStatusUncertain {
					t.Fatalf("expiry recovery: %s", d.Status)
				}
				if outcome == "accepted" && (len(receipts) != 1 || receipts[0].ExternalMessageID.String != "om_late_accepted") {
					t.Fatal("late accepted receipt was lost")
				}
				if worked, err := s.ProcessNext(ctx); worked || err != nil {
					t.Fatalf("automatic retry after expired result: %v %v", worked, err)
				}
			})
		}
	}
}

// Fault injection occurs after the approval UPDATE inside the real transaction.
type contractCancelFailureStarter struct {
	txStarter
	reached bool
}
type contractCancelFailureTx struct {
	pgx.Tx
	owner *contractCancelFailureStarter
}

func (s *contractCancelFailureStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.txStarter.Begin(ctx)
	return &contractCancelFailureTx{Tx: tx, owner: s}, err
}
func (t *contractCancelFailureTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "-- name: CancelLabrastroMessageDeliveriesByTarget") {
		t.owner.reached = true
		return nil, errors.New("synthetic cancellation failure")
	}
	return t.Tx.Query(ctx, sql, args...)
}
func TestContractRevocationRollsBackWhenCancellationFails(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "revoke-rollback", nil)
	fx.groupRoute(t, "oc_revoke_rollback")
	s := newTestService(nil, nil)
	ap := loadAutopilot(t, fx.autopilot)
	if _, err := s.EnqueueRunDeliveries(ctx, uuidOf(t, fx.run(t, "completed", nil))); err != nil {
		t.Fatal(err)
	}
	targets, err := s.ListApprovedTargets(ctx, ap)
	if err != nil || len(targets) != 1 {
		t.Fatalf("fixture approvals: %v %v", targets, err)
	}
	fault := &contractCancelFailureStarter{txStarter: testPool}
	s.Tx = fault
	if _, err := s.RevokeTarget(ctx, ap, targets[0]); err == nil {
		t.Fatal("cancellation error was ignored")
	}
	if !fault.reached {
		t.Fatal("cancellation fault was not reached")
	}
	targets, err = s.ListApprovedTargets(ctx, ap)
	if err != nil || len(targets) != 1 {
		t.Fatal("failed revoke partially committed")
	}
	if n := countDeliveries(t, `autopilot_id=$1 AND status='queued'`, fx.autopilot); n != 1 {
		t.Fatalf("queued state changed: %d", n)
	}
}

func TestContractScanBoundAndGenerationFence(t *testing.T) {
	ctx := context.Background()
	resetScanCursor(t, scannerIssueStatus)
	fx := newMDFixture(t, "scan-bound", nil)
	add := func(id string) {
		issue := testFx.Issue(t, "scan bound", testutil.Cols{"id": id, "origin_type": "autopilot", "status": "in_progress"})
		fx.run(t, "issue_created", testutil.Cols{"issue_id": issue, "result": nil, "completed_at": nil})
	}
	first := "ffffffff-ffff-ffff-ffff-fffffffffff0"
	newTail := "ffffffff-ffff-ffff-ffff-fffffffffff1"
	lateOld := "00000000-0000-0000-0000-000000000010"
	add(first)
	syncer := &fakeSyncer{}
	s := newTestService(nil, syncer)
	cur, err := s.loadCursor(ctx, scannerIssueStatus)
	if err != nil {
		t.Fatal(err)
	}
	stale := cur
	page, err := s.syncStaleCreateIssueIssues(ctx, cur)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := s.saveCursor(ctx, scannerIssueStatus, page)
	if err != nil {
		t.Fatal(err)
	}
	add(newTail)
	add(lateOld)
	if _, err := s.saveCursor(ctx, scannerIssueStatus, stale); !errors.Is(err, errScanCursorMoved) {
		t.Fatalf("old replica could reset cursor: %v", err)
	}
	persisted, err := s.loadCursor(ctx, scannerIssueStatus)
	if err != nil || persisted != saved {
		t.Fatalf("CAS changed saved cursor: %v", err)
	}
	syncer.issues = nil
	if _, err := s.advanceScanner(ctx, scannerIssueStatus, s.syncStaleCreateIssueIssues); err != nil {
		t.Fatal(err)
	}
	if len(syncer.issues) != 0 {
		t.Fatal("fixed cycle admitted a new tail or revisited an old key")
	}
	if _, err := s.advanceScanner(ctx, scannerIssueStatus, s.syncStaleCreateIssueIssues); err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, i := range syncer.issues {
		for _, id := range []string{newTail, lateOld} {
			if uuidEqual(i.ID, id) {
				found[id] = true
			}
		}
	}
	if !found[newTail] || !found[lateOld] {
		t.Fatalf("next cycle missed late commits: %v", found)
	}
	row, err := db.New(testPool).GetLabrastroMessageScanCursor(ctx, scannerIssueStatus)
	if err != nil || row.CycleUpperID.Valid {
		t.Fatalf("finite cycle did not end: %v", err)
	}
}
