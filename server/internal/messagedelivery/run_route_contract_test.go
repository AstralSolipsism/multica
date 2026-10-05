package messagedelivery

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/multica-ai/multica/server/internal/messagedelivery/lifecycle"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type decisionInsertProbeStarter struct {
	txStarter
	probe func()
}

type decisionInsertProbeTx struct {
	pgx.Tx
	probe func()
}

func (s decisionInsertProbeStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.txStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return decisionInsertProbeTx{tx, s.probe}, nil
}

func (tx decisionInsertProbeTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.HasPrefix(sql, "-- name: CreateLabrastroMessageDelivery ") {
		tx.probe()
	}
	return tx.Tx.Query(ctx, sql, args...)
}

func TestRunDecisionLocksRouteUntilInsert(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "run-route-lock", nil)
	fx.bindMember(t, testUID, "ou_run_lock")
	route := loadRoute(t, fx.memberTargetRoute(t, "lock", testUID, nil))
	run := fx.run(t, "completed", nil)
	s := newTestService(nil, nil)
	probed := false
	s.Tx = decisionInsertProbeStarter{testPool, func() {
		// A second connection tries the lock that disable/delete needs at
		// the last moment before the decision insert. NOWAIT makes a missing
		// SHARE lock fail deterministically, without timing a goroutine.
		tx, err := testPool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		_, err = tx.Exec(ctx, `SELECT id FROM labrastro_message_route WHERE id=$1 AND workspace_id=$2 FOR UPDATE NOWAIT`, route.ID, route.WorkspaceID)
		var lockErr *pgconn.PgError
		if !errors.As(err, &lockErr) || lockErr.Code != "55P03" {
			t.Fatalf("route was not locked during decision insert: %v", err)
		}
		probed = true
	}}
	if err := s.decideMissing(ctx); err != nil {
		t.Fatal(err)
	}
	if !probed {
		t.Fatal("decision insert was not exercised")
	}
	s.Tx = testPool
	if _, err := s.SetRouteEnabled(ctx, route, loadMember(t), false, route.Revision); err != nil {
		t.Fatal(err)
	}
	if status, _, _, _ := deliveryStatus(t, firstDeliveryForRun(t, run)); status != DeliveryStatusCancelled {
		t.Fatalf("disable did not cancel the committed decision: %s", status)
	}
}

func TestRunDisableRollsBackWhenCancellationFails(t *testing.T) {
	for _, operation := range []string{"disable", "edit", "delete"} {
		t.Run(operation, func(t *testing.T) {
			ctx := context.Background()
			fx := newMDFixture(t, "run-atomic-"+operation, nil)
			fx.bindMember(t, testUID, "ou_run_atomic")
			route := loadRoute(t, fx.memberTargetRoute(t, "atomic", testUID, nil))
			run := fx.run(t, "completed", nil)
			s := newTestService(nil, nil)
			if err := s.decideMissing(ctx); err != nil {
				t.Fatal(err)
			}
			delivery := firstDeliveryForRun(t, run)
			stop := func() error {
				switch operation {
				case "disable":
					_, err := s.SetRouteEnabled(ctx, route, loadMember(t), false, route.Revision)
					return err
				case "edit":
					in := routeInput(route)
					enabled := false
					in.Enabled = &enabled
					_, err := s.UpdateRoute(ctx, route, loadMember(t), route.Revision, in)
					return err
				default:
					return s.DeleteRoute(ctx, route)
				}
			}
			s.Tx = sourceCancelFailureStarter{testPool}
			if err := stop(); err == nil || !strings.Contains(err.Error(), "synthetic source cancellation failure") {
				t.Fatalf("cancellation failure not propagated: %v", err)
			}
			got := loadRoute(t, util.UUIDToString(route.ID))
			if !got.Enabled || got.Revision != route.Revision || got.LastDisabledAt.Valid {
				t.Fatalf("failed cancellation partially changed route: %+v", got)
			}
			if status, _, _, _ := deliveryStatus(t, delivery); status != DeliveryStatusQueued {
				t.Fatalf("failed cancellation changed delivery to %s", status)
			}
			s.Tx = testPool
			if err := stop(); err != nil {
				t.Fatal(err)
			}
			if status, _, _, _ := deliveryStatus(t, delivery); status != DeliveryStatusCancelled {
				t.Fatalf("successful stop left delivery %s", status)
			}
			if operation != "delete" {
				got = loadRoute(t, util.UUIDToString(route.ID))
				if got.Enabled || !got.LastDisabledAt.Valid || got.Revision != route.Revision+1 {
					t.Fatalf("successful disable lacks fence/revision: %+v", got)
				}
			}
		})
	}
}

func TestRunDecisionRejectsStaleRouteCandidate(t *testing.T) {
	for _, operation := range []string{"disable", "edit", "delete", "reenable"} {
		t.Run(operation, func(t *testing.T) {
			ctx := context.Background()
			fx := newMDFixture(t, "run-stale-"+operation, nil)
			fx.bindMember(t, testUID, "ou_run_stale")
			route := loadRoute(t, fx.memberTargetRoute(t, "stale", testUID, nil))
			runID := fx.run(t, "completed", nil)
			s := newTestService(nil, nil)
			rows, err := s.Queries.ListLabrastroMessageDeliveryCandidateRoutes(ctx, db.ListLabrastroMessageDeliveryCandidateRoutesParams{RunID: uuidOf(t, runID), Limit: 10})
			if err != nil || len(rows) != 1 {
				t.Fatalf("candidate: count=%d err=%v", len(rows), err)
			}
			c := rows[0]
			c.AutopilotRun.TaskID = c.SourceTaskID
			in := s.decisionInputFromSource(c.Autopilot, c.LabrastroMessageRoute, sourceFactsFromRun(c.AutopilotRun))
			switch operation {
			case "delete":
				err = s.DeleteRoute(ctx, route)
			case "edit":
				edit := routeInput(route)
				edit.Conditions = ConditionFailure
				_, err = s.UpdateRoute(ctx, route, loadMember(t), route.Revision, edit)
			default:
				var disabled db.LabrastroMessageRoute
				disabled, err = s.SetRouteEnabled(ctx, route, loadMember(t), false, route.Revision)
				if err == nil && operation == "reenable" {
					_, err = s.SetRouteEnabled(ctx, disabled, loadMember(t), true, disabled.Revision)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if n, err := s.decideDelivery(ctx, c.Autopilot, in); err != nil || n != 0 {
				t.Fatalf("stale decision: count=%d err=%v", n, err)
			}
			if n := countDeliveries(t, `run_id=$1`, runID); n != 0 {
				t.Fatalf("stale decision inserted %d rows", n)
			}
			if err := s.decideMissing(ctx); err != nil {
				t.Fatal(err)
			}
			if operation == "edit" {
				if status, _, code, _ := deliveryStatus(t, firstDeliveryForRun(t, runID)); status != DeliveryStatusSuppressed || code != ErrorCodeConditionMismatch {
					t.Fatalf("fresh candidate did not use edited condition: %s %s", status, code)
				}
			} else if n := countDeliveries(t, `run_id=$1`, runID); n != 0 {
				t.Fatalf("stopped route backfilled %d decisions", n)
			}
		})
	}
}

func TestRunTargetEditRetainsUndecidedRun(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "run-edit-window", nil)
	route := loadRoute(t, fx.groupRoute(t, "oc_run_before_edit"))
	run := fx.run(t, "completed", nil)
	fx.approveGroup(t, "oc_run_after_edit")
	s := newTestService(nil, nil)
	in := routeInput(route)
	in.TargetChatID = "oc_run_after_edit"
	updated, err := s.UpdateRoute(ctx, route, loadMember(t), route.Revision, in)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.Enabled || updated.EffectiveFrom != route.EffectiveFrom {
		t.Fatalf("target edit changed eligibility window: before=%v after=%v enabled=%v", route.EffectiveFrom, updated.EffectiveFrom, updated.Enabled)
	}
	if err := s.decideMissing(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countDeliveries(t, `run_id=$1`, run); n != 1 {
		t.Fatalf("run completed before edit has %d decisions, want 1", n)
	}
	d, _, err := s.GetDelivery(ctx, route.WorkspaceID, route.AutopilotID, uuidOf(t, firstDeliveryForRun(t, run)))
	if err != nil {
		t.Fatal(err)
	}
	if d.Status != DeliveryStatusQueued || d.TargetKey != TargetKey(TargetGroup, "", in.TargetChatID, "") || d.RouteRevision.Int32 != updated.Revision {
		t.Fatalf("decision did not use the edited target/revision: %+v", d)
	}
}

// Revoke under the same installation row lock and transaction as the handler.
func revokeRunTestInstallation(t *testing.T, s *Service, route db.LabrastroMessageRoute) db.LabrastroMessageRoute {
	t.Helper()
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE channel_installation SET status='revoked' WHERE id=$1 AND workspace_id=$2`, route.InstallationID, route.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.StopInstallation(ctx, s.Queries.WithTx(tx), route.WorkspaceID, route.InstallationID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	disabled := loadRoute(t, util.UUIDToString(route.ID))
	if disabled.Enabled || !disabled.LastDisabledAt.Valid || disabled.Revision != route.Revision+1 {
		t.Fatalf("installation revocation did not disable and fence run route: %+v", disabled)
	}
	return disabled
}

func TestRunInstallationDisableFencesReenabledClaim(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "run-installation-fence", nil)
	fx.bindMember(t, testUID, "ou_run_installation_fence")
	route := loadRoute(t, fx.memberTargetRoute(t, "installation-fence", testUID, nil))
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	s := newTestService(sender, nil)
	if err := s.decideMissing(ctx); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.Queries.ClaimLabrastroMessageDeliveryByID(ctx, uuidOf(t, firstDeliveryForRun(t, run)))
	if err != nil {
		t.Fatal(err)
	}
	disabled := revokeRunTestInstallation(t, s, route)
	// Reinstall and explicitly enable the route before the old claim resumes.
	testFx.Exec(t, `UPDATE channel_installation SET status='active' WHERE id=$1`, route.InstallationID)
	if _, err := s.SetRouteEnabled(ctx, disabled, loadMember(t), true, disabled.Revision); err != nil {
		t.Fatal(err)
	}
	s.processClaimed(ctx, claimed)
	status, _, code, detail := deliveryStatus(t, util.UUIDToString(claimed.ID))
	if status != DeliveryStatusCancelled || code != ErrorCodeRouteDisabled || detail != "delivery predates the last route disable" || sender.count() != 0 {
		t.Fatalf("installation recovery revived old claim: status=%s code=%s detail=%q sends=%d", status, code, detail, sender.count())
	}
}

func TestRunManualRetryAfterReenableIsCancelled(t *testing.T) {
	for _, outcome := range []struct {
		status string
		class  ErrorClass
	}{
		{DeliveryStatusFailed, ClassPermanent},
		{DeliveryStatusUncertain, ClassAmbiguous},
	} {
		for _, stop := range []string{"disable", "edit", "installation"} {
			t.Run(outcome.status+"/"+stop, func(t *testing.T) {
				ctx := context.Background()
				fx := newMDFixture(t, "run-retry-fence", nil)
				fx.bindMember(t, testUID, "ou_run_retry_fence")
				route := loadRoute(t, fx.memberTargetRoute(t, "retry-fence", testUID, nil))
				run := fx.run(t, "completed", nil)
				sender := &fakeSender{fn: func(SendRequest) (SendResult, error) {
					return SendResult{}, &SendError{Class: outcome.class, Err: errors.New("synthetic send failure")}
				}}
				s := newTestService(sender, nil)
				if err := s.decideMissing(ctx); err != nil {
					t.Fatal(err)
				}
				deliveryID := uuidOf(t, firstDeliveryForRun(t, run))
				claimed, err := s.Queries.ClaimLabrastroMessageDeliveryByID(ctx, deliveryID)
				if err != nil {
					t.Fatal(err)
				}
				s.processClaimed(ctx, claimed)
				if status, _, _, _ := deliveryStatus(t, util.UUIDToString(deliveryID)); status != outcome.status || sender.count() != 1 {
					t.Fatalf("initial send: status=%s sends=%d", status, sender.count())
				}
				var disabled db.LabrastroMessageRoute
				switch stop {
				case "disable":
					disabled, err = s.SetRouteEnabled(ctx, route, loadMember(t), false, route.Revision)
				case "edit":
					in := routeInput(route)
					enabled := false
					in.Enabled = &enabled
					disabled, err = s.UpdateRoute(ctx, route, loadMember(t), route.Revision, in)
				case "installation":
					disabled = revokeRunTestInstallation(t, s, route)
					testFx.Exec(t, `UPDATE channel_installation SET status='active' WHERE id=$1`, route.InstallationID)
				}
				if err != nil {
					t.Fatal(err)
				}
				if _, err := s.SetRouteEnabled(ctx, disabled, loadMember(t), true, disabled.Revision); err != nil {
					t.Fatal(err)
				}
				queued, err := s.RetryDelivery(ctx, route.WorkspaceID, route.AutopilotID, deliveryID)
				if err != nil || queued.Status != DeliveryStatusQueued || queued.CreatedAt != claimed.CreatedAt {
					t.Fatalf("manual retry must retain original decision time: status=%s created=%v err=%v", queued.Status, queued.CreatedAt, err)
				}
				claimed, err = s.Queries.ClaimLabrastroMessageDeliveryByID(ctx, deliveryID)
				if err != nil {
					t.Fatal(err)
				}
				s.processClaimed(ctx, claimed)
				status, _, code, detail := deliveryStatus(t, util.UUIDToString(deliveryID))
				if status != DeliveryStatusCancelled || code != ErrorCodeRouteDisabled || detail != "delivery predates the last route disable" || sender.count() != 1 {
					t.Fatalf("manual retry crossed disable fence: status=%s code=%s detail=%q sends=%d", status, code, detail, sender.count())
				}
			})
		}
	}
}

func TestEnqueueRunDeliveriesOnlyDecidesRequestedRun(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "run-selection", nil)
	fx.bindMember(t, testUID, "ou_run_selection")
	fx.memberTargetRoute(t, "selection", testUID, nil)
	requested := fx.run(t, "completed", nil)
	other := fx.run(t, "completed", nil)
	s := newTestService(nil, nil)
	if n, err := s.EnqueueRunDeliveries(ctx, uuidOf(t, requested)); err != nil || n != 1 {
		t.Fatalf("enqueue requested run: count=%d err=%v", n, err)
	}
	if n := countDeliveries(t, `run_id=$1`, requested); n != 1 {
		t.Fatalf("requested run has %d decisions, want 1", n)
	}
	if n := countDeliveries(t, `run_id=$1`, other); n != 0 {
		t.Fatalf("enqueue decided %d deliveries for another run", n)
	}
	if err := s.decideMissing(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countDeliveries(t, `run_id=$1`, other); n != 1 {
		t.Fatalf("production scan did not decide the other eligible run: %d", n)
	}
}

func TestRunDisableAndReenableBetweenShardsStopsOldClaim(t *testing.T) {
	ctx := context.Background()
	fx := newMDFixture(t, "run-disable-shards", nil)
	fx.bindMember(t, testUID, "ou_run_disable_shards")
	route := loadRoute(t, fx.memberTargetRoute(t, "shards", testUID, nil))
	run := fx.run(t, "completed", testutil.Cols{"result": testutil.Raw(`'{"output":"` + strings.Repeat("report ", 3000) + `"}'::jsonb`)})
	sender := &fakeSender{}
	s := newTestService(sender, nil)
	if err := s.decideMissing(ctx); err != nil {
		t.Fatal(err)
	}
	sender.fn = func(req SendRequest) (SendResult, error) {
		if req.ShardTotal < 2 {
			t.Error("fixture needs multiple shards")
		}
		disabled, err := s.SetRouteEnabled(ctx, route, loadMember(t), false, route.Revision)
		if err != nil {
			return SendResult{}, err
		}
		if _, err := s.SetRouteEnabled(ctx, disabled, loadMember(t), true, disabled.Revision); err != nil {
			return SendResult{}, err
		}
		return SendResult{ExternalMessageID: "om_run_before_disable"}, nil
	}
	claimed, err := s.Queries.ClaimLabrastroMessageDeliveryByID(ctx, uuidOf(t, firstDeliveryForRun(t, run)))
	if err != nil {
		t.Fatal(err)
	}
	s.processClaimed(ctx, claimed)
	d, receipts, err := s.GetDelivery(ctx, claimed.WorkspaceID, claimed.AutopilotID, claimed.ID)
	if err != nil || sender.count() != 1 || d.Status != DeliveryStatusCancelled || d.ErrorCode.String != ErrorCodeRouteDisabled {
		t.Fatalf("old claim resumed: status=%s code=%s sends=%d err=%v", d.Status, d.ErrorCode.String, sender.count(), err)
	}
	if len(receipts) == 0 || receipts[0].ExternalMessageID.String != "om_run_before_disable" {
		t.Fatalf("accepted shard receipt lost: %+v", receipts)
	}
}
