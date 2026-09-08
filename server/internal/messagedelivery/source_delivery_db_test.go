package messagedelivery

// OL-27 acceptance tests for the personal-inbox and team-event sources.
// Every test runs against the same isolated suite database with fake
// senders/verifiers (see TestMain); scans are judged through the same
// decide/gate code paths the workers run.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// srcFixture carries the shared rows one source test needs: an active
// installation, an issue, a project and a second (non-admin) member.
type srcFixture struct {
	install string
	issue   string
	project string
	memberB string
	routes  []string
}

func newSourceFixture(t *testing.T, label string) srcFixture {
	t.Helper()
	install := testFx.Insert(t, "channel_installation", testutil.Cols{
		"workspace_id":      testWSID,
		"agent_id":          testAgent,
		"channel_type":      "feishu",
		"config":            testutil.Raw(fmt.Sprintf(`'{"app_id":"cli_src_%d"}'::jsonb`, time.Now().UnixNano())),
		"status":            "active",
		"installer_user_id": testUID,
	})
	issue := testFx.Issue(t, "SRC "+label)
	project := testFx.Project(t, "SRC project "+label)
	memberB := testFx.User(t, "src-b-"+label, "src-b-"+label+"-"+testWSID[:8]+"@multica.test")
	testFx.Member(t, testWSID, memberB, "member")
	f := srcFixture{install: install, issue: issue, project: project, memberB: memberB}
	t.Cleanup(func() {
		ctx := context.Background()
		for _, routeID := range f.routes {
			testPool.Exec(ctx, `DELETE FROM labrastro_message_delivery WHERE route_id = $1::uuid`, routeID)
			testPool.Exec(ctx, `DELETE FROM labrastro_message_route WHERE id = $1::uuid`, routeID)
		}
	})
	return f
}

func (f *srcFixture) bindMember(t *testing.T, userID, openID string) string {
	t.Helper()
	return testFx.Insert(t, "channel_user_binding", testutil.Cols{
		"workspace_id":    testWSID,
		"multica_user_id": userID,
		"installation_id": f.install,
		"channel_type":    "feishu",
		"channel_user_id": openID,
	})
}

func (f *srcFixture) personalRoute(t *testing.T, label, userID string, over testutil.Cols) string {
	t.Helper()
	id := testFx.Insert(t, "labrastro_message_route", mergeCols(testutil.Cols{
		"id":              testutil.Raw("gen_random_uuid()"),
		"workspace_id":    testWSID,
		"installation_id": f.install,
		"channel_type":    "feishu",
		"target_type":     "member",
		"target_user_id":  userID,
		"target_key":      TargetKey(TargetMember, userID, "", ""),
		"source_kind":     RouteSourceInbox,
		"enabled":         true,
		"created_by":      userID,
		"updated_by":      userID,
	}, over))
	f.routes = append(f.routes, id)
	return id
}

func (f *srcFixture) teamRoute(t *testing.T, label, kind, chatID string, over testutil.Cols) string {
	t.Helper()
	cols := testutil.Cols{
		"id":              testutil.Raw("gen_random_uuid()"),
		"workspace_id":    testWSID,
		"installation_id": f.install,
		"channel_type":    "feishu",
		"target_type":     "group",
		"target_chat_id":  chatID,
		"target_key":      TargetKey(TargetGroup, "", chatID, ""),
		"source_kind":     kind,
		"enabled":         true,
		"created_by":      testUID,
		"updated_by":      testUID,
	}
	for k, v := range over {
		cols[k] = v
	}
	id := testFx.Insert(t, "labrastro_message_route", cols)
	f.routes = append(f.routes, id)
	return id
}

// approveTeam inserts an active team approval for the (scope, bot, target)
// scope — the workspace consent a team send requires.
func (f *srcFixture) approveTeam(t *testing.T, scope, chatID string) {
	t.Helper()
	testFx.Insert(t, "labrastro_message_approved_target", testutil.Cols{
		"workspace_id":    testWSID,
		"installation_id": f.install,
		"target_key":      TargetKey(TargetGroup, "", chatID, ""),
		"target_type":     TargetGroup,
		"source_kind":     scope,
		"approved_by":     testUID,
	})
}

func (f *srcFixture) inboxItem(t *testing.T, recipientID, itemType string, issueID string) string {
	t.Helper()
	cols := testutil.Cols{
		"workspace_id":   testWSID,
		"recipient_type": "member",
		"recipient_id":   recipientID,
		"type":           itemType,
		"severity":       "info",
		"title":          "SRC item " + itemType,
	}
	if issueID != "" {
		cols["issue_id"] = testutil.Raw("'" + issueID + "'::uuid")
	}
	return testFx.Insert(t, "inbox_item", cols)
}

func (f *srcFixture) activity(t *testing.T, issueID, action, details string) string {
	t.Helper()
	return testFx.Insert(t, "activity_log", testutil.Cols{
		"workspace_id": testWSID,
		"issue_id":     testutil.Raw("'" + issueID + "'::uuid"),
		"actor_type":   "member",
		"actor_id":     testutil.Raw("'" + testUID + "'::uuid"),
		"action":       action,
		"details":      testutil.Raw("'" + details + "'::jsonb"),
	})
}

func (f *srcFixture) comment(t *testing.T, issueID, content string) string {
	t.Helper()
	return testFx.Comment(t, issueID, content)
}

// countSourceDecisions counts decisions pinned to one source record id.
func countSourceDecisions(t *testing.T, sourceRefID string) int {
	t.Helper()
	return testFx.Count(t, `SELECT count(*) FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, sourceRefID)
}

// resetSourceScanCursors clears all three source scanner rows so a test
// starts a fresh cycle (the cursor table is global state).
func resetSourceScanCursors(t *testing.T) {
	t.Helper()
	resetScanCursor(t, scannerInboxSource)
	resetScanCursor(t, scannerActivitySource)
	resetScanCursor(t, scannerCommentSource)
}

// TestSourceDecisions_TeamEventOncePersonalDMsIndependent is the headline
// acceptance: one persisted team event decided ONCE per group target no
// matter how many equivalent routes or personal subscriptions exist, while
// every member's private forwarding stays its own decision.
func TestSourceDecisions_TeamEventOncePersonalDMsIndependent(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "once")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceActivity, "oc_team_once")
	fx.approveTeam(t, RouteSourceComment, "oc_team_once")

	// Two EQUIVALENT activity routes to the same target: workspace-wide and
	// project-scoped. Plus a comment route to the same chat.
	fx.teamRoute(t, "activity-wide", RouteSourceActivity, "oc_team_once", nil)
	fx.teamRoute(t, "activity-project", RouteSourceActivity, "oc_team_once", testutil.Cols{
		"project_id": testutil.Raw("'" + fx.project + "'::uuid"),
	})
	fx.teamRoute(t, "comment", RouteSourceComment, "oc_team_once", nil)

	// Two personal subscriptions to the same issue: two inbox items.
	fx.personalRoute(t, "inbox-a", testUID, nil)
	fx.personalRoute(t, "inbox-b", fx.memberB, nil)
	itemA := fx.inboxItem(t, testUID, "status_changed", fx.issue)
	itemB := fx.inboxItem(t, fx.memberB, "status_changed", fx.issue)

	activityID := fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"in_progress"}`)
	commentID := fx.comment(t, fx.issue, "a plain comment for the group")

	s := newTestService(&fakeSender{}, nil)
	s.decideSourcesOnce(ctx)

	if got := countSourceDecisions(t, activityID); got != 1 {
		t.Fatalf("team activity produced %d decisions, want exactly 1", got)
	}
	if got := countSourceDecisions(t, commentID); got != 1 {
		t.Fatalf("team comment produced %d decisions, want exactly 1", got)
	}
	if got := countSourceDecisions(t, itemA); got != 1 {
		t.Fatalf("member A inbox item produced %d decisions, want 1", got)
	}
	if got := countSourceDecisions(t, itemB); got != 1 {
		t.Fatalf("member B inbox item produced %d decisions, want 1", got)
	}

	// Repeated scans (a worker restart, another replica) decide nothing new.
	s.decideSourcesOnce(ctx)
	s.decideSourcesOnce(ctx)
	if got := countSourceDecisions(t, activityID); got != 1 {
		t.Fatalf("rescan produced a second team decision: %d", got)
	}

	// Web state is not a delivery event: reading and archiving the items
	// re-produces nothing.
	testFx.Exec(t, `UPDATE inbox_item SET read = true, archived = true WHERE id IN ($1::uuid, $2::uuid)`, itemA, itemB)
	s.decideSourcesOnce(ctx)
	if got := countSourceDecisions(t, itemA); got != 1 {
		t.Fatalf("read/archive produced a second personal decision: %d", got)
	}

	// The one team decision is a group send to the approved chat; the
	// personal decisions are member DMs.
	var kind, targetKey string
	testFx.QueryRow(t, `SELECT source_kind, target_key FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, activityID).Scan(&kind, &targetKey)
	if kind != SourceKindActivity || targetKey != "group:oc_team_once" {
		t.Fatalf("team decision = %s/%s", kind, targetKey)
	}
	for _, item := range []string{itemA, itemB} {
		testFx.QueryRow(t, `SELECT source_kind, target_key FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, item).Scan(&kind, &targetKey)
		if kind != SourceKindInbox || !strings.HasPrefix(targetKey, "member:") {
			t.Fatalf("personal decision = %s/%s", kind, targetKey)
		}
	}
}

// TestSourceDecisions_FilterEditDoesNotReplayOldEvents: a filtered-out
// event is RECORDED as suppressed, so widening the filter later cannot
// replay history; only events after the edit are delivered.
func TestSourceDecisions_FilterEditDoesNotReplayOldEvents(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "replay")
	resetSourceScanCursors(t)
	fx.personalRoute(t, "inbox-filter", testUID, testutil.Cols{
		"event_types": testutil.Raw(`'{issue_assigned}'::text[]`),
	})

	old := fx.inboxItem(t, testUID, "status_changed", fx.issue)
	s := newTestService(&fakeSender{}, nil)
	s.decideSourcesOnce(ctx)

	var status, code string
	testFx.QueryRow(t, `SELECT status, error_code FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, old).Scan(&status, &code)
	if status != DeliveryStatusSuppressed || code != ErrorCodeConditionMismatch {
		t.Fatalf("filtered item = %s/%s, want suppressed/condition_mismatch", status, code)
	}

	// Widen the filter: the old item stays decided (suppressed) — no replay.
	testFx.Exec(t, `UPDATE labrastro_message_route SET event_types = '{issue_assigned, status_changed}' WHERE id = $1::uuid`, fx.routes[0])
	s.decideSourcesOnce(ctx)
	if got := countSourceDecisions(t, old); got != 1 {
		t.Fatalf("filter edit replayed the old event: %d decisions", got)
	}

	// A NEW item inside the widened filter flows.
	fresh := fx.inboxItem(t, testUID, "status_changed", fx.issue)
	s.decideSourcesOnce(ctx)
	testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, fresh).Scan(&status)
	if status != DeliveryStatusQueued {
		t.Fatalf("fresh item after filter edit = %s, want queued", status)
	}
}

// TestSourceDecisions_MutedCategoryRecordedNotSent: mute semantics reuse
// notification_preference; a muted item is a suppressed decision, and a
// preference that flips AFTER the decision still stops the send at the gate.
func TestSourceDecisions_MutedCategoryRecordedNotSent(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "mute")
	resetSourceScanCursors(t)
	fx.personalRoute(t, "inbox-mute-a", testUID, nil)
	fx.personalRoute(t, "inbox-mute-b", fx.memberB, nil)
	fx.bindMember(t, testUID, "ou_src_mute_a")
	fx.bindMember(t, fx.memberB, "ou_src_mute_b")

	// Member B mutes status changes.
	testFx.Insert(t, "notification_preference", testutil.Cols{
		"workspace_id": testWSID,
		"user_id":      fx.memberB,
		"preferences":  testutil.Raw(`'{"status_changes":"muted"}'::jsonb`),
	})

	itemA := fx.inboxItem(t, testUID, "status_changed", fx.issue)
	itemB := fx.inboxItem(t, fx.memberB, "status_changed", fx.issue)
	s := newTestService(&fakeSender{}, nil)
	s.decideSourcesOnce(ctx)

	var status, code string
	testFx.QueryRow(t, `SELECT status, error_code FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, itemB).Scan(&status, &code)
	if status != DeliveryStatusSuppressed || code != ErrorCodeRecipientMuted {
		t.Fatalf("muted item = %s/%s, want suppressed/recipient_muted", status, code)
	}
	testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, itemA).Scan(&status)
	if status != DeliveryStatusQueued {
		t.Fatalf("unmuted item = %s, want queued", status)
	}

	// Muting AFTER the decision stops the send at the gate: cancelled, no
	// platform call, and the sibling still sends.
	testFx.Insert(t, "notification_preference", testutil.Cols{
		"workspace_id": testWSID,
		"user_id":      testUID,
		"preferences":  testutil.Raw(`'{"status_changes":"muted"}'::jsonb`),
	})
	sender := &fakeSender{}
	gate := newTestService(sender, nil)
	for {
		worked, err := gate.ProcessNext(ctx)
		if err != nil {
			t.Fatalf("process: %v", err)
		}
		if !worked {
			break
		}
	}
	testFx.QueryRow(t, `SELECT status, error_code FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, itemA).Scan(&status, &code)
	if status != DeliveryStatusCancelled || code != ErrorCodeRecipientMuted {
		t.Fatalf("post-decision mute = %s/%s, want cancelled/recipient_muted", status, code)
	}
	if sender.count() != 0 {
		t.Fatalf("muted member's message reached the platform %d times", sender.count())
	}
	testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, itemB).Scan(&status)
	if status != DeliveryStatusSuppressed {
		t.Fatalf("member B decision changed: %s", status)
	}
}

// TestSourceDecisions_ProjectFilterIsDecideTimeAndDeleteStops: the project
// filter matches the issue's project AT DECISION TIME, and deleting the
// project disables the scoped routes and cancels their queued sends.
func TestSourceDecisions_ProjectFilterIsDecideTimeAndDeleteStops(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "project")
	resetSourceScanCursors(t)
	other := testFx.Project(t, "SRC other project")

	inProject := fx.teamRoute(t, "activity-in-project", RouteSourceActivity, "oc_team_project", testutil.Cols{
		"project_id": testutil.Raw("'" + fx.project + "'::uuid"),
	})
	fx.approveTeam(t, RouteSourceActivity, "oc_team_project")
	issueIn := fx.issue
	issueOut := testFx.Issue(t, "SRC outside project")
	testFx.Exec(t, `UPDATE issue SET project_id = $1::uuid WHERE id = $2::uuid`, fx.project, issueIn)
	testFx.Exec(t, `UPDATE issue SET project_id = $1::uuid WHERE id = $2::uuid`, other, issueOut)

	hit := fx.activity(t, issueIn, "status_changed", `{"from":"todo","to":"done"}`)
	miss := fx.activity(t, issueOut, "status_changed", `{"from":"todo","to":"done"}`)
	s := newTestService(&fakeSender{}, nil)
	s.decideSourcesOnce(ctx)

	var status, code string
	testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, hit).Scan(&status)
	if status != DeliveryStatusQueued {
		t.Fatalf("in-project event = %s, want queued", status)
	}
	testFx.QueryRow(t, `SELECT status, error_code FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, miss).Scan(&status, &code)
	if status != DeliveryStatusSuppressed || code != ErrorCodeConditionMismatch {
		t.Fatalf("out-of-project event = %s/%s, want suppressed/condition_mismatch", status, code)
	}

	// Scope changed after the decision: the gate refuses the send.
	testFx.Exec(t, `UPDATE issue SET project_id = $1::uuid WHERE id = $2::uuid`, other, issueIn)
	sender := &fakeSender{}
	gate := newTestService(sender, nil)
	gate.ProcessNext(ctx)
	testFx.QueryRow(t, `SELECT status, error_code FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, hit).Scan(&status, &code)
	if status != DeliveryStatusCancelled || code != ErrorCodeConditionMismatch {
		t.Fatalf("post-decision scope change = %s/%s, want cancelled/condition_mismatch", status, code)
	}
	if sender.count() != 0 {
		t.Fatalf("out-of-scope send reached the platform")
	}

	// Deleting the project stops the scoped route and any remaining queue.
	testFx.Exec(t, `UPDATE issue SET project_id = $1::uuid WHERE id = $2::uuid`, fx.project, issueIn)
	testFx.Exec(t, `UPDATE labrastro_message_route SET enabled = true WHERE id = $1::uuid`, inProject)
	testFx.Exec(t, `DELETE FROM labrastro_message_delivery WHERE route_id = $1::uuid`, inProject)
	fresh := fx.activity(t, issueIn, "assignee_changed", `{"to_type":"member","to_id":"`+testUID+`"}`)
	s2 := newTestService(&fakeSender{}, nil)
	s2.decideSourcesOnce(ctx)
	testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, fresh).Scan(&status)
	if status != DeliveryStatusQueued {
		t.Fatalf("fresh in-project event = %s, want queued", status)
	}
	// The project-delete transaction's stop path:
	if _, err := testPool.Exec(ctx, `UPDATE labrastro_message_route SET enabled = false, revision = revision + 1 WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND source_kind IN ('activity','comment') AND enabled`, testWSID, fx.project); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool.Exec(ctx, `UPDATE labrastro_message_delivery SET status = 'cancelled', error_code = 'route_disabled' WHERE workspace_id = $1::uuid AND route_id IN (SELECT id FROM labrastro_message_route WHERE workspace_id = $1::uuid AND project_id = $2::uuid) AND status = 'queued'`, testWSID, fx.project); err != nil {
		t.Fatal(err)
	}
	testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, fresh).Scan(&status)
	if status != DeliveryStatusCancelled {
		t.Fatalf("queue after project stop = %s, want cancelled", status)
	}
	testFx.Exec(t, `DELETE FROM project WHERE id = $1::uuid`, other)
}

// TestSourceGates_TeamAuthorizerLostAdmin: a team route spends the
// authority of its last authorizer; demoting that member below admin stops
// the queued sends with route_authorization_lost and no platform call.
func TestSourceGates_TeamAuthorizerLostAdmin(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "authorizer")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceComment, "oc_team_authorizer")
	fx.teamRoute(t, "comment", RouteSourceComment, "oc_team_authorizer", nil)

	authorizer := fx.memberB
	testFx.Exec(t, `UPDATE labrastro_message_route SET updated_by = $1::uuid WHERE id = $2::uuid`, authorizer, fx.routes[0])
	commentID := fx.comment(t, fx.issue, "comment held for authorization check")
	s := newTestService(&fakeSender{}, nil)
	s.decideSourcesOnce(ctx)

	var status string
	testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, commentID).Scan(&status)
	if status != DeliveryStatusQueued {
		t.Fatalf("decision = %s, want queued", status)
	}

	testFx.Exec(t, `UPDATE member SET role = 'member' WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, testWSID, authorizer)
	sender := &fakeSender{}
	gate := newTestService(sender, nil)
	gate.ProcessNext(ctx)
	var code string
	testFx.QueryRow(t, `SELECT status, error_code FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, commentID).Scan(&status, &code)
	if status != DeliveryStatusCancelled || code != ErrorCodeAuthorizationLost {
		t.Fatalf("demoted authorizer = %s/%s, want cancelled/route_authorization_lost", status, code)
	}
	if sender.count() != 0 {
		t.Fatalf("unauthorized team send reached the platform")
	}
}

// TestSourceApprovals_RevocationCancelsQueuedAndBlocksSend: team approvals
// are their own scope; revoking cancels queued sends, and a later decision
// cannot send without a fresh approval.
func TestSourceApprovals_RevocationCancelsQueuedAndBlocksSend(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "revoke")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceActivity, "oc_team_revoke")
	fx.teamRoute(t, "activity", RouteSourceActivity, "oc_team_revoke", nil)

	activityID := fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"done"}`)
	s := newTestService(&fakeSender{}, nil)
	s.decideSourcesOnce(ctx)

	var status string
	testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, activityID).Scan(&status)
	if status != DeliveryStatusQueued {
		t.Fatalf("decision = %s, want queued", status)
	}

	// Revoke the team approval: the queued send is cancelled in the same
	// transaction (the service path under test).
	var approvalID string
	testFx.QueryRow(t, `SELECT id FROM labrastro_message_approved_target WHERE workspace_id = $1::uuid AND source_kind = 'activity' AND target_key = 'group:oc_team_revoke' AND revoked_at IS NULL`, testWSID).Scan(&approvalID)
	approval := loadApprovedTarget(t, approvalID)
	cancelled, err := s.RevokeSourceTarget(ctx, uuidOf(t, testWSID), RouteSourceActivity, approval)
	if err != nil || cancelled != 1 {
		t.Fatalf("revoke: cancelled=%d err=%v", cancelled, err)
	}
	testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, activityID).Scan(&status)
	if status != DeliveryStatusCancelled {
		t.Fatalf("queued send after revoke = %s, want cancelled", status)
	}

	// A later decision queues again, but the send gate refuses without an
	// active approval — nothing reaches the platform.
	fresh := fx.activity(t, fx.issue, "assignee_changed", `{"to_type":"member","to_id":"`+testUID+`"}`)
	s.decideSourcesOnce(ctx)
	sender := &fakeSender{}
	gate := newTestService(sender, nil)
	gate.ProcessNext(ctx)
	testFx.QueryRow(t, `SELECT status, error_code FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, fresh).Scan(&status, new(pgtype.Text))
	if status != DeliveryStatusCancelled {
		t.Fatalf("send without approval = %s, want cancelled", status)
	}
	if sender.count() != 0 {
		t.Fatalf("unapproved team send reached the platform")
	}
}

// TestSourceScanner_LateCommittingSourceFoundNextCycle: a source whose row
// committed after the cursor passed is invisible this cycle and decided in
// the next one — the keyset + cycle-restart contract, never a permanent skip.
func TestSourceScanner_LateCommittingSourceFoundNextCycle(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "late")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceActivity, "oc_team_late")
	fx.teamRoute(t, "activity", RouteSourceActivity, "oc_team_late", nil)
	s := newTestService(&fakeSender{}, nil)

	// A source that exists only inside an open transaction: invisible to
	// the scan.
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	lateID := util.UUIDToString(dbid.NewV7())
	if _, err := tx.Exec(ctx, `INSERT INTO activity_log (id, workspace_id, issue_id, actor_type, actor_id, action, details)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'member', $4::uuid, 'status_changed', '{"from":"todo","to":"done"}'::jsonb)`,
		lateID, testWSID, fx.issue, testUID); err != nil {
		t.Fatal(err)
	}
	s.decideSourcesOnce(ctx)
	if got := countSourceDecisions(t, lateID); got != 0 {
		t.Fatalf("uncommitted source was decided: %d", got)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// The cursor has already moved past the row this cycle; the next cycle
	// (cursor reset below) must find it.
	resetSourceScanCursors(t)
	s.decideSourcesOnce(ctx)
	if got := countSourceDecisions(t, lateID); got != 1 {
		t.Fatalf("late-committing source not decided in the next cycle: %d decisions", got)
	}
}

// TestSourceService_InboxRouteIsSelfOnly: the service refuses a personal
// route pointed at another member, and refuses team configuration to a
// non-admin — an ordinary member managing their own notifications never
// gains team outbound permission.
func TestSourceService_InboxRouteIsSelfOnly(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "self")
	fx.bindMember(t, testUID, "ou_src_self_a")
	fx.bindMember(t, fx.memberB, "ou_src_self_b")

	s := newTestService(&fakeSender{}, nil)
	memberA := db.Member{UserID: uuidOf(t, testUID), WorkspaceID: uuidOf(t, testWSID)}
	memberBFull, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, fx.memberB),
	})
	if err != nil {
		t.Fatal(err)
	}

	// Member A configuring member B's inbox: refused even though A is the
	// workspace owner — the inbox is the recipient's own surface.
	_, err = s.CreateSourceRoute(ctx, memberA, SourceRouteInput{
		Scope:          RouteSourceInbox,
		InstallationID: fx.install,
		TargetType:     TargetMember,
		TargetUserID:   fx.memberB,
	})
	var notSelf *RouteNotSelfError
	if !errors.As(err, &notSelf) {
		t.Fatalf("cross-user inbox route err = %v, want RouteNotSelfError", err)
	}

	// Member B (plain member) configuring a TEAM route: refused.
	_, err = s.CreateSourceRoute(ctx, memberBFull, SourceRouteInput{
		Scope:          RouteSourceActivity,
		InstallationID: fx.install,
		TargetType:     TargetGroup,
		TargetChatID:   "oc_denied",
	})
	if !errors.Is(err, ErrAuthorizationLost) {
		t.Fatalf("non-admin team route err = %v, want ErrAuthorizationLost", err)
	}

	// Member B configuring their OWN inbox: allowed.
	route, err := s.CreateSourceRoute(ctx, memberBFull, SourceRouteInput{
		Scope:          RouteSourceInbox,
		InstallationID: fx.install,
		TargetType:     TargetMember,
		TargetUserID:   fx.memberB,
	})
	if err != nil {
		t.Fatalf("own inbox route: %v", err)
	}
	fx.routes = append(fx.routes, util.UUIDToString(route.ID))
	if util.UUIDToString(route.TargetUserID) != fx.memberB {
		t.Fatalf("route recipient = %s, want the acting member", util.UUIDToString(route.TargetUserID))
	}
}

// TestSourceTestSend_RealPathWithSourceRoute: the synchronous test send
// runs the shared lifecycle for a personal route and records a test_send
// delivery with its receipt.
func TestSourceTestSend_RealPathWithSourceRoute(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "testsend")
	fx.bindMember(t, testUID, "ou_src_testsend")
	resetSourceScanCursors(t)

	s := newTestService(&fakeSender{}, nil)
	memberA := db.Member{UserID: uuidOf(t, testUID), WorkspaceID: uuidOf(t, testWSID)}
	route, err := s.CreateSourceRoute(ctx, memberA, SourceRouteInput{
		Scope:          RouteSourceInbox,
		InstallationID: fx.install,
		TargetType:     TargetMember,
		TargetUserID:   testUID,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	fx.routes = append(fx.routes, util.UUIDToString(route.ID))

	sender := &fakeSender{}
	ts := newTestService(sender, nil)
	d, err := ts.TestSourceSend(ctx, route, memberA)
	if err != nil {
		t.Fatalf("test send: %v", err)
	}
	if d.Status != DeliveryStatusSent || d.SourceKind != SourceKindTestSend {
		t.Fatalf("test send = %s (%s), want sent/test_send", d.Status, d.SourceKind)
	}
	if sender.count() != 1 {
		t.Fatalf("test send dialed the platform %d times", sender.count())
	}
}

// TestSourceWorker_EndToEndSendsThroughSharedChain ties it together: a team
// event and a personal item are decided by the scan and delivered by the
// SAME worker/sender/receipt chain the automation source uses.
func TestSourceWorker_EndToEndSendsThroughSharedChain(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "e2e")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceActivity, "oc_team_e2e")
	fx.teamRoute(t, "activity", RouteSourceActivity, "oc_team_e2e", nil)
	fx.personalRoute(t, "inbox", testUID, nil)
	fx.bindMember(t, testUID, "ou_src_e2e")

	fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"in_review"}`)
	fx.inboxItem(t, testUID, "issue_assigned", fx.issue)

	// Full-UUID external ids: two shards minted in the same millisecond
	// share a UUIDv7 prefix, and the receipt ledger's unique
	// (installation, external_message_id) must never collide.
	sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
		return SendResult{ExternalMessageID: "om_e2e_" + req.SendUUID}, nil
	}}
	s := newTestService(sender, nil)
	s.decideSourcesOnce(ctx)
	for {
		worked, err := s.ProcessNext(ctx)
		if err != nil {
			t.Fatalf("process: %v", err)
		}
		if !worked {
			break
		}
	}
	var sent int
	testFx.QueryRow(t, `SELECT count(*) FROM labrastro_message_delivery WHERE workspace_id = $1::uuid AND source_kind IN ('inbox','activity') AND status = 'sent'`, testWSID).Scan(&sent)
	if sent != 2 {
		rows, _ := testPool.Query(ctx, `SELECT source_kind, status, error_code, last_error FROM labrastro_message_delivery WHERE workspace_id = $1::uuid AND source_kind IN ('inbox','activity')`, testWSID)
		defer rows.Close()
		for rows.Next() {
			var kind, status string
			var code, lastErr pgtype.Text
			if err := rows.Scan(&kind, &status, &code, &lastErr); err == nil {
				t.Logf("decision %s/%s code=%q err=%q", kind, status, code.String, lastErr.String)
			}
		}
		t.Fatalf("sent deliveries = %d, want 2 (one group, one DM)", sent)
	}
	if sender.count() != 2 {
		t.Fatalf("platform calls = %d, want 2", sender.count())
	}
	var receipts int
	testFx.QueryRow(t, `SELECT count(*) FROM labrastro_message_receipt WHERE workspace_id = $1::uuid`, testWSID).Scan(&receipts)
	if receipts < 2 {
		t.Fatalf("receipts = %d, want >= 2", receipts)
	}
}

// ---- helpers ----

func loadApprovedTarget(t testing.TB, id string) db.LabrastroMessageApprovedTarget {
	t.Helper()
	rows, err := db.New(testPool).ListLabrastroMessageSourceApprovedTargets(context.Background(), uuidOf(t, testWSID))
	if err != nil {
		t.Fatal(err)
	}
	for _, ap := range rows {
		if util.UUIDToString(ap.ID) == id {
			return ap
		}
	}
	t.Fatal("approved target not found")
	return db.LabrastroMessageApprovedTarget{}
}
