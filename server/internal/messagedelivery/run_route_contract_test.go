package messagedelivery

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
