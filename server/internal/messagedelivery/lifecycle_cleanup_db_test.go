package messagedelivery

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/messagedelivery/lifecycle"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Reuse this package's TestMain and fixture cleanup; each lifecycle case owns
// its workspaces so destructive assertions never depend on suite-global rows.
func lifecycleWorkspace(t *testing.T, label string) *testutil.Fixture {
	t.Helper()
	slug := fmt.Sprintf("lifecycle-%s-%d", label, time.Now().UnixNano())
	ws := testFx.Workspace(t, label, slug)
	fx := testutil.New(testPool, ws, testUID)
	fx.Member(t, ws, testUID, "owner")
	return fx
}

func lifecycleRoute(t *testing.T, fx *testutil.Fixture, kind, userID, projectID string) db.LabrastroMessageRoute {
	t.Helper()
	agent := fx.Agent(t, fmt.Sprintf("lifecycle-%s-%d", kind, time.Now().UnixNano()), "")
	installation := fx.Insert(t, "channel_installation", testutil.Cols{
		"workspace_id": fx.WorkspaceID, "agent_id": agent,
		"channel_type": "feishu", "status": "active", "installer_user_id": fx.UserID,
		"config": testutil.Raw(fmt.Sprintf(`'{"app_id":"cli_%s"}'::jsonb`, agent)),
	})
	cols := testutil.Cols{
		"id": testutil.Raw("gen_random_uuid()"), "workspace_id": fx.WorkspaceID,
		"installation_id": installation, "channel_type": "feishu",
		"source_kind": kind, "enabled": true, "revision": 3,
		"created_by": fx.UserID, "updated_by": fx.UserID,
	}
	if kind == "inbox" {
		cols["target_type"], cols["target_user_id"] = "member", userID
		cols["target_key"] = "member:" + userID
	} else {
		cols["target_type"], cols["target_chat_id"] = "group", "oc_lifecycle"
		cols["target_key"] = "group:oc_lifecycle"
		if projectID != "" {
			cols["project_id"] = projectID
		}
	}
	return loadLifecycleRoute(t, fx.WorkspaceID, fx.Insert(t, "labrastro_message_route", cols))
}

func loadLifecycleRoute(t *testing.T, workspaceID, id string) db.LabrastroMessageRoute {
	t.Helper()
	route, err := db.New(testPool).GetLabrastroMessageRoute(context.Background(), db.GetLabrastroMessageRouteParams{
		ID: uuidOf(t, id), WorkspaceID: uuidOf(t, workspaceID),
	})
	if err != nil {
		t.Fatalf("load lifecycle route %s: %v", id, err)
	}
	return route
}

func lifecycleDelivery(t *testing.T, fx *testutil.Fixture, route db.LabrastroMessageRoute, status string) string {
	t.Helper()
	return fx.Insert(t, "labrastro_message_delivery", testutil.Cols{
		"id": testutil.Raw("gen_random_uuid()"), "workspace_id": fx.WorkspaceID,
		"route_id": route.ID, "route_revision": route.Revision,
		"installation_id": route.InstallationID, "target_key": route.TargetKey,
		"dedup_key":   testutil.Raw("gen_random_uuid()::text"),
		"source_kind": "test_send", "source_scope": route.SourceKind,
		"source_project_id": route.ProjectID, "status": status,
		"content_snapshot": testutil.Raw(`'{"text":"lifecycle history"}'::jsonb`),
		"target_snapshot":  testutil.Raw(`'{}'::jsonb`),
		"lease_token":      testutil.Raw("gen_random_uuid()"),
		"lease_expires_at": testutil.Raw("now() + interval '1 minute'"),
	})
}

func lifecycleApproval(t *testing.T, fx *testutil.Fixture, route db.LabrastroMessageRoute) string {
	t.Helper()
	return fx.Insert(t, "labrastro_message_approved_target", testutil.Cols{
		"workspace_id": fx.WorkspaceID, "installation_id": route.InstallationID,
		"target_key": route.TargetKey, "target_type": route.TargetType,
		"source_kind": route.SourceKind, "project_id": route.ProjectID, "approved_by": fx.UserID,
	})
}

// Compare every persisted column, including revision, timestamps and snapshots.
// Table/column names are test constants; row identities are always parameters.
func lifecycleSnapshot(t *testing.T, table, column, id string) string {
	t.Helper()
	var snapshot string
	testFx.QueryRow(t, fmt.Sprintf(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)::text
		FROM %s r WHERE %s = $1`, table, column), id).Scan(&snapshot)
	return snapshot
}

func TestLifecycleSweepWorkspaceDeletesOnlyItsRows(t *testing.T) {
	ctx := context.Background()
	target, other := lifecycleWorkspace(t, "delete"), lifecycleWorkspace(t, "keep")
	for _, fx := range []*testutil.Fixture{target, other} {
		route := lifecycleRoute(t, fx, "activity", "", fx.Project(t, "project"))
		lifecycleApproval(t, fx, route)
		delivery := lifecycleDelivery(t, fx, route, "sent")
		fx.Insert(t, "labrastro_message_receipt", testutil.Cols{
			"workspace_id": fx.WorkspaceID, "delivery_id": delivery, "installation_id": route.InstallationID,
			"shard_index": 0, "shard_total": 1, "send_uuid": "lifecycle-send", "external_message_id": "om_sent",
		})
		var installationAgent string
		fx.QueryRow(t, `SELECT agent_id FROM channel_installation WHERE id=$1`, route.InstallationID).Scan(&installationAgent)
		fx.InsertNoID(t, "labrastro_message_feedback", testutil.Cols{
			"workspace_id": fx.WorkspaceID, "installation_id": route.InstallationID,
			"delivery_id": delivery, "inbound_message_id": "om_reply", "quoted_message_id": "om_sent",
			"sender_id": "ou_owner", "user_id": fx.UserID, "installation_agent_id": installationAgent,
			"chat_id": "oc_lifecycle", "content": "feedback history", "kind": "comment",
		}, "installation_id = $1 AND inbound_message_id = $2", route.InstallationID, "om_reply")
	}
	tables := []string{
		"labrastro_message_feedback", "labrastro_message_approved_target",
		"labrastro_message_receipt", "labrastro_message_delivery", "labrastro_message_route",
	}
	preserved := make(map[string]string)
	for _, table := range tables {
		if got := lifecycleSnapshot(t, table, "workspace_id", target.WorkspaceID); got == "[]" {
			t.Fatalf("target fixture has no %s rows", table)
		}
		preserved[table] = lifecycleSnapshot(t, table, "workspace_id", other.WorkspaceID)
		if preserved[table] == "[]" {
			t.Fatalf("control fixture has no %s rows", table)
		}
	}
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := lifecycle.SweepWorkspace(ctx, db.New(tx), uuidOf(t, target.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range tables {
		if got := lifecycleSnapshot(t, table, "workspace_id", target.WorkspaceID); got != "[]" {
			t.Errorf("SweepWorkspace left target %s rows: %s", table, got)
		}
		if got := lifecycleSnapshot(t, table, "workspace_id", other.WorkspaceID); got != preserved[table] {
			t.Errorf("SweepWorkspace changed the other workspace's %s rows: before=%s after=%s", table, preserved[table], got)
		}
	}
}

func TestLifecycleStopMemberPreservesOtherRecipientsAndHistory(t *testing.T) {
	ctx := context.Background()
	fx, otherWS := lifecycleWorkspace(t, "members"), lifecycleWorkspace(t, "other-members")
	otherUser := fx.User(t, "other member", fx.WorkspaceID+"@lifecycle.test")
	fx.Member(t, fx.WorkspaceID, otherUser, "member")
	target := lifecycleRoute(t, fx, "inbox", testUID, "")
	other := lifecycleRoute(t, fx, "inbox", otherUser, "")
	crossWS := lifecycleRoute(t, otherWS, "inbox", testUID, "")
	queued := lifecycleDelivery(t, fx, target, "queued")
	preserved := map[string]string{}
	for _, row := range []struct {
		fx    *testutil.Fixture
		route db.LabrastroMessageRoute
	}{{fx, other}, {otherWS, crossWS}} {
		id := lifecycleDelivery(t, row.fx, row.route, "queued")
		preserved[id] = lifecycleSnapshot(t, "labrastro_message_delivery", "id", id)
	}
	for _, status := range []string{"sending", "sent", "failed", "uncertain", "cancelled", "suppressed"} {
		id := lifecycleDelivery(t, fx, target, status)
		preserved[id] = lifecycleSnapshot(t, "labrastro_message_delivery", "id", id)
	}
	otherBefore := lifecycleSnapshot(t, "labrastro_message_route", "id", util.UUIDToString(other.ID))
	crossBefore := lifecycleSnapshot(t, "labrastro_message_route", "id", util.UUIDToString(crossWS.ID))
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := lifecycle.StopMember(ctx, db.New(tx), target.WorkspaceID, uuidOf(t, testUID)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	disabled := loadLifecycleRoute(t, fx.WorkspaceID, util.UUIDToString(target.ID))
	if disabled.Enabled || !disabled.LastDisabledAt.Valid || disabled.Revision != target.Revision+1 {
		t.Errorf("StopMember did not disable and fence the removed member's route: %+v", disabled)
	}
	var status, code string
	var leaseCleared bool
	testFx.QueryRow(t, `SELECT status, error_code, lease_token IS NULL AND lease_expires_at IS NULL
		FROM labrastro_message_delivery WHERE id=$1`, queued).Scan(&status, &code, &leaseCleared)
	if status != "cancelled" || code != "route_disabled" || !leaseCleared {
		t.Errorf("removed member's queued delivery: status=%s code=%s leaseCleared=%v", status, code, leaseCleared)
	}
	for id, before := range preserved {
		if got := lifecycleSnapshot(t, "labrastro_message_delivery", "id", id); got != before {
			t.Errorf("StopMember changed preserved delivery %s: before=%s after=%s", id, before, got)
		}
	}
	for id, before := range map[string]string{util.UUIDToString(other.ID): otherBefore, util.UUIDToString(crossWS.ID): crossBefore} {
		if got := lifecycleSnapshot(t, "labrastro_message_route", "id", id); got != before {
			t.Errorf("StopMember changed another member/workspace route %s: before=%s after=%s", id, before, got)
		}
	}
}

func TestLifecycleStopProjectPreservesOtherProjectsAndHistory(t *testing.T) {
	ctx := context.Background()
	fx := lifecycleWorkspace(t, "projects")
	project, otherProject := fx.Project(t, "delete"), fx.Project(t, "keep")
	targets := []db.LabrastroMessageRoute{
		lifecycleRoute(t, fx, "activity", "", project),
		lifecycleRoute(t, fx, "comment", "", project),
	}
	otherRoutes := []db.LabrastroMessageRoute{
		lifecycleRoute(t, fx, "activity", "", otherProject),
		lifecycleRoute(t, fx, "comment", "", otherProject),
		lifecycleRoute(t, fx, "activity", "", ""),
	}
	preserved := map[string]map[string]string{}
	for _, table := range []string{"labrastro_message_route", "labrastro_message_delivery", "labrastro_message_approved_target"} {
		preserved[table] = make(map[string]string)
	}
	for _, route := range otherRoutes {
		for table, id := range map[string]string{
			"labrastro_message_route":           util.UUIDToString(route.ID),
			"labrastro_message_delivery":        lifecycleDelivery(t, fx, route, "queued"),
			"labrastro_message_approved_target": lifecycleApproval(t, fx, route),
		} {
			preserved[table][id] = lifecycleSnapshot(t, table, "id", id)
		}
	}
	var queued, approvals []string
	for _, route := range targets {
		queued = append(queued, lifecycleDelivery(t, fx, route, "queued"))
		approvals = append(approvals, lifecycleApproval(t, fx, route))
		for _, status := range []string{"sending", "sent", "failed", "uncertain", "cancelled", "suppressed"} {
			id := lifecycleDelivery(t, fx, route, status)
			preserved["labrastro_message_delivery"][id] = lifecycleSnapshot(t, "labrastro_message_delivery", "id", id)
		}
	}
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := lifecycle.StopProject(ctx, db.New(tx), uuidOf(t, fx.WorkspaceID), uuidOf(t, project)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for _, route := range targets {
		disabled := loadLifecycleRoute(t, fx.WorkspaceID, util.UUIDToString(route.ID))
		if disabled.Enabled || !disabled.LastDisabledAt.Valid || disabled.Revision != route.Revision+1 {
			t.Errorf("StopProject did not disable and fence %s route: %+v", route.SourceKind, disabled)
		}
	}
	for _, id := range queued {
		var status, code string
		var leaseCleared bool
		testFx.QueryRow(t, `SELECT status, error_code, lease_token IS NULL AND lease_expires_at IS NULL
			FROM labrastro_message_delivery WHERE id=$1`, id).Scan(&status, &code, &leaseCleared)
		if status != "cancelled" || code != "route_disabled" || !leaseCleared {
			t.Errorf("deleted project's queued delivery %s: status=%s code=%s leaseCleared=%v", id, status, code, leaseCleared)
		}
	}
	for _, id := range approvals {
		var revoked bool
		testFx.QueryRow(t, `SELECT revoked_at IS NOT NULL FROM labrastro_message_approved_target WHERE id=$1`, id).Scan(&revoked)
		if !revoked {
			t.Errorf("StopProject left approval %s active", id)
		}
	}
	for table, rows := range preserved {
		for id, before := range rows {
			if got := lifecycleSnapshot(t, table, "id", id); got != before {
				t.Errorf("StopProject changed preserved %s row %s: before=%s after=%s", table, id, before, got)
			}
		}
	}
}
