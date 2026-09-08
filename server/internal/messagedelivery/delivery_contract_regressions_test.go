package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// B2: the agreed SQL boundary explicitly preserves an existing result when
// ordinary failure callers have no replacement structured payload to supply.
func TestV1ReviewFailedTerminalPreservesResultWithoutReplacement(t *testing.T) {
	if testPool == nil {
		t.Skip("database unavailable")
	}
	fx := newMDFixture(t, "v1-failed-result", nil)
	run := fx.run(t, "running", testutil.Cols{"completed_at": nil})
	q := db.New(testPool)
	before, err := q.GetAutopilotRun(context.Background(), uuidOf(t, run))
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Result) == 0 {
		t.Fatal("fixture: no existing result")
	}
	// Same SQL arguments used by failAutopilotRun -> failAutopilotRunWithResult(nil).
	after, err := q.UpdateAutopilotRunTerminalWithQuota(context.Background(), db.UpdateAutopilotRunTerminalWithQuotaParams{
		RunID: before.ID, TerminalStatus: "failed", Result: nil,
		FailureReason: pgtype.Text{String: "synthetic ordinary task failure", Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(after.Result) != string(before.Result) {
		t.Fatalf("failure without replacement erased persisted result: before=%s after=%s", before.Result, after.Result)
	}
}

// B3: a historical row without persisted source evidence must degrade
// consistently; changing a live automation setting is not historical evidence.
func TestV1ReviewUnknownSourceDoesNotFollowCurrentMode(t *testing.T) {
	a := sourceKindFromRun(false, false, nil, "run_only")
	b := sourceKindFromRun(false, false, nil, "create_issue")
	if a != b {
		t.Fatalf("identical historical evidence resolved differently after mode edit: %s -> %s", a, b)
	}
}

// A1/D2: verification is a remote call. Archive the source while it is in
// flight. A test-send must still pass the common live-source gate afterwards.
func TestV1ReviewTestSendRechecksSource(t *testing.T) {
	if testPool == nil {
		t.Skip("database unavailable")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "v1-test-source", nil)
	route := loadRoute(t, fx.groupRoute(t, "oc_v1_source"))
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	verified := false
	svc.Verifier = rereviewVerifier{onGroup: func() error {
		verified = true
		_, err := testPool.Exec(ctx, `UPDATE autopilot SET status='archived' WHERE id=$1`, fx.autopilot)
		return err
	}}
	d, err := svc.TestSend(ctx, route, loadMember(t))
	if !verified {
		t.Fatal("fixture: remote verifier was not reached")
	}
	if sender.count() != 0 {
		t.Fatalf("source archived during verification, yet test-send dispatched %d request(s), status=%s err=%v", sender.count(), d.Status, err)
	}
}

// A1: enable has to use the same approval predicate as save and send.
func TestV1ReviewEnableRequiresApproval(t *testing.T) {
	if testPool == nil {
		t.Skip("database unavailable")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "v1-enable", nil)
	routeID := fx.groupRoute(t, "oc_v1_enable")
	testFx.Exec(t, `UPDATE labrastro_message_route SET enabled=false WHERE id=$1`, routeID)
	testFx.Exec(t, `UPDATE labrastro_message_approved_target SET revoked_at=now() WHERE autopilot_id=$1`, fx.autopilot)
	svc := newTestService(nil, nil)
	route := loadRoute(t, routeID)
	got, err := svc.SetRouteEnabled(ctx, route, loadMember(t), true, route.Revision)
	if err == nil || got.Enabled {
		t.Fatalf("revoked target was enabled: enabled=%v err=%v", got.Enabled, err)
	}
}

// A1/D2: revocation after the first accepted shard cannot recall that shard,
// but must stop NEW sends. Change persisted consent directly to isolate the
// send gate from the separately reproduced broken HTTP revocation operation.
func TestV1ReviewRevocationStopsNewShards(t *testing.T) {
	if testPool == nil {
		t.Skip("database unavailable")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "v1-shard-revoke", nil)
	routeID := fx.groupRoute(t, "oc_v1_shards")
	testFx.Exec(t, `UPDATE labrastro_message_route SET content_mode='with_output' WHERE id=$1`, routeID)
	run := fx.run(t, "completed", nil)
	result, err := json.Marshal(map[string]any{"output": strings.Repeat("report ", 3000)})
	if err != nil {
		t.Fatal(err)
	}
	testFx.Exec(t, `UPDATE autopilot_run SET result=$1::jsonb WHERE id=$2`, string(result), run)
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	if n, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil || n != 1 {
		t.Fatalf("enqueue=%d err=%v", n, err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	var total int
	testFx.QueryRow(t, `SELECT shard_total FROM labrastro_message_delivery WHERE id=$1`, deliveryID).Scan(&total)
	if total < 2 {
		t.Fatalf("fixture: wanted multiple shards, got %d", total)
	}
	sender.fn = func(req SendRequest) (SendResult, error) {
		if req.ShardIndex == 0 {
			if _, err := testPool.Exec(ctx, `UPDATE labrastro_message_approved_target SET revoked_at=now() WHERE autopilot_id=$1`, fx.autopilot); err != nil {
				return SendResult{}, err
			}
		}
		return SendResult{ExternalMessageID: fmt.Sprintf("om_v1_shard_%d", req.ShardIndex)}, nil
	}
	if worked, err := svc.ProcessNext(ctx); err != nil || !worked {
		t.Fatalf("process worked=%v err=%v", worked, err)
	}
	if sender.count() != 1 {
		t.Fatalf("consent revoked after shard 0; sent %d/%d shards instead of stopping new sends", sender.count(), total)
	}
}

// D2: expiry without a sweep already ends the claim. A late transient result
// must not grant automatic retry permission to the expired owner.
func TestV1ReviewExpiredWorkerCannotRequeue(t *testing.T) {
	if testPool == nil {
		t.Skip("database unavailable")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "v1-expired-result", nil)
	fx.groupRoute(t, "oc_v1_expired")
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	if n, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil || n != 1 {
		t.Fatalf("enqueue=%d err=%v", n, err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	sender.fn = func(SendRequest) (SendResult, error) {
		if _, err := testPool.Exec(ctx, `UPDATE labrastro_message_delivery SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, deliveryID); err != nil {
			return SendResult{}, err
		}
		return SendResult{}, &SendError{Class: ClassTransient, Err: errors.New("synthetic late transient response")}
	}
	if worked, err := svc.ProcessNext(ctx); err != nil || !worked {
		t.Fatalf("process worked=%v err=%v", worked, err)
	}
	if got, _, _, _ := deliveryStatus(t, deliveryID); got != DeliveryStatusSending && got != DeliveryStatusUncertain {
		t.Fatalf("expired owner changed delivery to %s; expected expiry recovery / uncertain, never automatic requeue", got)
	}
}

// Delete only this fixture's workspace, using the production parent lock order.
func v1ReviewDeleteWorkspace(ctx context.Context, ws string) error {
	tx, err := testPool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	if err := tx.QueryRow(ctx, `SELECT id FROM workspace WHERE id=$1 FOR UPDATE`, ws).Scan(&id); err != nil {
		return err
	}
	for _, table := range []string{"labrastro_message_receipt", "labrastro_message_delivery", "labrastro_message_route", "labrastro_message_approved_target", "channel_installation", "autopilot"} {
		if _, err := tx.Exec(ctx, "DELETE FROM "+table+" WHERE workspace_id=$1", ws); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, ws); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func v1ReviewMoveWorkspace(t *testing.T, fx mdFixture) string {
	t.Helper()
	ws := testFx.Insert(t, "workspace", testutil.Cols{"name": "v1 parent race", "slug": "v1-parent-" + fx.autopilot, "description": "", "issue_prefix": "V1"})
	testFx.Exec(t, `UPDATE autopilot SET workspace_id=$1 WHERE id=$2`, ws, fx.autopilot)
	testFx.Exec(t, `UPDATE channel_installation SET workspace_id=$1 WHERE id=$2`, ws, fx.install)
	testFx.Exec(t, `UPDATE labrastro_message_route SET workspace_id=$1 WHERE autopilot_id=$2`, ws, fx.autopilot)
	testFx.Exec(t, `UPDATE labrastro_message_approved_target SET workspace_id=$1 WHERE autopilot_id=$2`, ws, fx.autopilot)
	return ws
}

// D1: this is the same resolve-then-approve sequence as the actual handler.
func TestV1ReviewApprovalCannotRecreateDeletedWorkspace(t *testing.T) {
	if testPool == nil {
		t.Skip("database unavailable")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "v1-approve-delete", nil)
	ws := v1ReviewMoveWorkspace(t, fx)
	svc := newTestService(nil, nil)
	ap := loadAutopilot(t, fx.autopilot)
	called := false
	svc.Verifier = rereviewVerifier{onGroup: func() error { called = true; return v1ReviewDeleteWorkspace(ctx, ws) }}
	target, err := svc.ResolveTargetForApproval(ctx, ap.WorkspaceID, ap.ID, RouteInput{InstallationID: fx.install, TargetType: TargetGroup, TargetChatID: "oc_v1_approve_deleted", Conditions: ConditionSuccess, ContentMode: ContentSummary})
	if err != nil {
		t.Fatalf("fixture: remote validation: %v", err)
	}
	if !called {
		t.Fatal("fixture: deletion callback not reached")
	}
	_, approveErr := svc.ApproveTarget(ctx, ap, loadMember(t), target)
	var n int
	testFx.QueryRow(t, `SELECT count(*) FROM labrastro_message_approved_target WHERE workspace_id=$1`, ws).Scan(&n)
	t.Cleanup(func() {
		if _, err := testPool.Exec(ctx, `DELETE FROM labrastro_message_approved_target WHERE workspace_id=$1`, ws); err != nil {
			t.Error(err)
		}
	})
	if n != 0 {
		t.Fatalf("approval created %d orphan row after parent deletion committed; err=%v", n, approveErr)
	}
}

// Interpose AFTER a successful approval query has materialized its row, i.e.
// after target validation and before the subsequent parent/INSERT operation.
// SQL results and production methods are otherwise unmodified.
type v1ReviewAfterApprovalDB struct {
	db.DBTX
	after func() error
}

func (d *v1ReviewAfterApprovalDB) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	row := d.DBTX.QueryRow(ctx, query, args...)
	if strings.Contains(query, "-- name: GetActiveLabrastroMessageApprovedTarget") && d.after != nil {
		after := d.after
		d.after = nil
		return v1ReviewAfterRow{Row: row, after: after}
	}
	return row
}

type v1ReviewAfterRow struct {
	pgx.Row
	after func() error
}

func (r v1ReviewAfterRow) Scan(dest ...any) error {
	if err := r.Row.Scan(dest...); err != nil {
		return err
	}
	return r.after()
}

func TestV1ReviewParentRaceAfterValidatedTarget(t *testing.T) {
	for _, operation := range []string{"create_route", "test_send"} {
		t.Run(operation, func(t *testing.T) {
			if testPool == nil {
				t.Skip("database unavailable")
			}
			ctx := context.Background()
			fx := newMDFixture(t, "v1-parent-"+operation, nil)
			chat := "oc_v1_parent_" + operation
			routeID := ""
			if operation == "test_send" {
				routeID = fx.groupRoute(t, chat)
			} else {
				fx.approveGroup(t, chat)
			}
			ws := v1ReviewMoveWorkspace(t, fx)
			ap := loadAutopilot(t, fx.autopilot)
			svc := newTestService(&fakeSender{}, nil)
			called := false
			svc.Queries = db.New(&v1ReviewAfterApprovalDB{DBTX: testPool, after: func() error { called = true; return v1ReviewDeleteWorkspace(ctx, ws) }})
			var gotErr error
			if operation == "create_route" {
				_, gotErr = svc.CreateRoute(ctx, ap, loadMember(t), RouteInput{InstallationID: fx.install, TargetType: TargetGroup, TargetChatID: chat, Conditions: ConditionSuccess, ContentMode: ContentSummary})
			} else {
				route, err := svc.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{ID: uuidOf(t, routeID), WorkspaceID: ap.WorkspaceID})
				if err != nil {
					t.Fatal(err)
				}
				_, gotErr = svc.TestSend(ctx, route, loadMember(t))
			}
			if !called {
				t.Fatal("fixture: successful target validation did not reach deletion barrier")
			}
			for _, table := range []string{"labrastro_message_route", "labrastro_message_delivery", "labrastro_message_receipt", "labrastro_message_approved_target"} {
				var n int
				testFx.QueryRow(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", ws).Scan(&n)
				if n != 0 {
					t.Errorf("%s created %d orphan %s rows after deletion; err=%v", operation, n, table, gotErr)
				}
			}
			if gotErr == nil {
				t.Error("operation must refuse the deleted parent")
			}
		})
	}
}

// C1: simulate a >10-minute outage after one budget has been durably scanned.
// Resuming must retain its position until the fixed cycle upper bound is met.
func TestV1ReviewCursorRetainsProgressAcrossDowntime(t *testing.T) {
	if testPool == nil {
		t.Skip("database unavailable")
	}
	ctx := context.Background()
	resetScanCursor(t, scannerIssueStatus)
	fx := newMDFixture(t, "v1-cursor-age", nil)
	ws := v1ReviewMoveWorkspace(t, fx)
	t.Cleanup(func() {
		for _, query := range []string{`DELETE FROM autopilot_run WHERE autopilot_id=$1`, `DELETE FROM issue WHERE workspace_id=$1`} {
			key := fx.autopilot
			if strings.Contains(query, "workspace_id") {
				key = ws
			}
			if _, err := testPool.Exec(ctx, query, key); err != nil {
				t.Error(err)
			}
		}
	})
	testFx.Exec(t, `WITH inserted AS (
		INSERT INTO issue (workspace_id, number, title, status, priority, creator_type, creator_id, position, origin_type)
		SELECT $1::uuid,n,'v1 long running','in_progress','none','member',$2::uuid,0,'autopilot'
		FROM generate_series(1,$4::integer) AS n RETURNING id
	) INSERT INTO autopilot_run(autopilot_id,source,status,issue_id)
	SELECT $3::uuid,'schedule','issue_created',id FROM inserted`, ws, testUID, fx.autopilot, scanRowBudgetPerTick)
	terminal := testFx.Issue(t, "v1 tail", testutil.Cols{"id": "ffffffff-ffff-4fff-bfff-ffffffffffff", "workspace_id": ws, "status": "done", "origin_type": "autopilot"})
	fx.run(t, "issue_created", testutil.Cols{"issue_id": terminal, "completed_at": nil, "result": nil})
	first := &fakeSyncer{}
	if err := newTestService(nil, first).ScanOnce(ctx); err != nil {
		t.Fatal(err)
	}
	for _, got := range first.issues {
		if uuidEqual(got.ID, terminal) {
			t.Fatal("fixture: terminal was not beyond the first budget")
		}
	}
	var visited int
	testFx.QueryRow(t, `SELECT count(*) FROM labrastro_message_scan_cursor WHERE scanner=$1 AND cursor_id<>'00000000-0000-0000-0000-000000000000'`, scannerIssueStatus).Scan(&visited)
	if visited != 1 {
		t.Fatal("fixture: first tick did not persist progress")
	}
	testFx.Exec(t, `UPDATE labrastro_message_scan_cursor SET cycle_started_at=now()-interval '11 minutes' WHERE scanner=$1`, scannerIssueStatus)
	resumed := &fakeSyncer{}
	if err := newTestService(nil, resumed).ScanOnce(ctx); err != nil {
		t.Fatal(err)
	}
	for _, got := range resumed.issues {
		if uuidEqual(got.ID, terminal) {
			return
		}
	}
	t.Fatalf("resumed tick revisited %d prefix candidates and missed terminal tail; persisted progress was discarded solely for cycle age", len(resumed.issues))
}
