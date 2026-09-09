package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func sourceRecord(t *testing.T, s *Service, sourceID string) db.LabrastroMessageDelivery {
	t.Helper()
	var id string
	testFx.QueryRow(t, `SELECT id FROM labrastro_message_delivery WHERE source_ref_id=$1`, sourceID).Scan(&id)
	d, err := s.Queries.GetLabrastroMessageDelivery(context.Background(), db.GetLabrastroMessageDeliveryParams{
		ID: uuidOf(t, id), WorkspaceID: uuidOf(t, testWSID),
	})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestSourceAssignmentSnapshotRetainsTransition(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "assignment")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceActivity, "oc_assignment")
	fx.teamRoute(t, "assignment", RouteSourceActivity, "oc_assignment", nil)
	// A display name alone cannot distinguish a member from an agent.
	testFx.Exec(t, `UPDATE "user" SET name='Sam' WHERE id=$1`, fx.memberB)
	agentID := testFx.Agent(t, "Sam", "")
	otherWS := testFx.Workspace(t, "Other assignment workspace", "assignment-"+fx.memberB)
	otherMember := testFx.User(t, "Outside member", "assignment-"+fx.memberB+"@multica.test")
	testFx.Member(t, otherWS, otherMember, "owner")
	otherAgent := testFx.Agent(t, "Outside agent", "", testutil.Cols{"workspace_id": otherWS, "owner_id": otherMember})
	missingMember, missingAgent := "00000000-0000-0000-0000-000000000011", "00000000-0000-0000-0000-000000000012"
	cases := []struct {
		name, fromType, fromID, toType, toID, want string
	}{
		{"member_to_agent", "member", fx.memberB, "agent", agentID, "Member Sam → Agent Sam"},
		{"agent_to_member", "agent", agentID, "member", fx.memberB, "Agent Sam → Member Sam"},
		{"unassign_member", "member", fx.memberB, "", "", "Member Sam → Unassigned"},
		{"unassign_agent", "agent", agentID, "", "", "Agent Sam → Unassigned"},
		{"assign_member", "", "", "member", fx.memberB, "Unassigned → Member Sam"},
		{"assign_agent", "", "", "agent", agentID, "Unassigned → Agent Sam"},
		{"missing_names", "member", missingMember, "agent", missingAgent, "Member " + missingMember + " → Agent " + missingAgent},
		{"outside_workspace", "member", otherMember, "agent", otherAgent, "Member " + otherMember + " → Agent " + otherAgent},
	}
	s := newTestService(nil, nil)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := map[string]string{"from_type": tc.fromType, "from_id": tc.fromID, "to_type": tc.toType, "to_id": tc.toID}
			// The canonical listener omits the empty side on assignment/removal.
			details := map[string]string{}
			for key, value := range want {
				if value != "" {
					details[key] = value
				}
			}
			encoded, err := json.Marshal(details)
			if err != nil {
				t.Fatal(err)
			}
			sourceID := fx.activity(t, fx.issue, "assignee_changed", string(encoded))
			if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
				t.Fatal(errs)
			}
			d := sourceRecord(t, s, sourceID)
			var content struct {
				Text           string            `json:"text"`
				Change         string            `json:"change"`
				AssigneeChange map[string]string `json:"assignee_change"`
			}
			if err := json.Unmarshal(d.ContentSnapshot, &content); err != nil {
				t.Fatal(err)
			}
			if d.Status != DeliveryStatusQueued || !strings.Contains(content.Change, tc.want) || !strings.Contains(content.Text, tc.want) {
				t.Errorf("assignment delivery status=%s snapshot=%s; want transition %q", d.Status, d.ContentSnapshot, tc.want)
			}
			for key, value := range want {
				if got, ok := content.AssigneeChange[key]; !ok || got != value {
					t.Errorf("frozen %s=%q (present=%v), want %q", key, got, ok, value)
				}
			}
		})
	}
	// Other activity kinds must not acquire a fabricated assignment change.
	statusID := fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"done"}`)
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	if snapshot := sourceRecord(t, s, statusID).ContentSnapshot; strings.Contains(string(snapshot), "assignee_change") {
		t.Fatalf("status event contains assignment metadata: %s", snapshot)
	}
}

func TestSourceAssignmentRetryKeepsFrozenTransition(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "assignment-retry")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceActivity, "oc_assignment_retry")
	fx.teamRoute(t, "assignment", RouteSourceActivity, "oc_assignment_retry", nil)
	agentID := testFx.Agent(t, "Original agent", "")
	sourceID := fx.activity(t, fx.issue, "assignee_changed", fmt.Sprintf(
		`{"from_type":"member","from_id":%q,"to_type":"agent","to_id":%q}`, fx.memberB, agentID))
	sender := &fakeSender{fn: func(SendRequest) (SendResult, error) {
		return SendResult{}, &SendError{Class: ClassPermanent, Err: errors.New("test rejection")}
	}}
	s := newTestService(sender, nil)
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	frozen := sourceRecord(t, s, sourceID)
	if ok, err := s.ProcessNext(ctx); err != nil || !ok {
		t.Fatalf("initial send: processed=%v err=%v", ok, err)
	}
	if failed := sourceRecord(t, s, sourceID); failed.Status != DeliveryStatusFailed {
		t.Fatalf("initial send status=%s, want failed", failed.Status)
	}
	// Display names and the current assignment are mutable; a persisted
	// historical delivery must retain both its identity and rendered text.
	testFx.Exec(t, `UPDATE "user" SET name='Renamed member' WHERE id=$1`, fx.memberB)
	testFx.Exec(t, `DELETE FROM agent WHERE id=$1 AND workspace_id=$2`, agentID, testWSID)
	testFx.Exec(t, `UPDATE issue SET assignee_type='member', assignee_id=$1 WHERE id=$2`, fx.memberB, fx.issue)
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	if _, err := s.RetryRouteDelivery(ctx, frozen.WorkspaceID, frozen.RouteID, frozen.ID); err != nil {
		t.Fatal(err)
	}
	sender.fn = nil
	if ok, err := s.ProcessNext(ctx); err != nil || !ok {
		t.Fatalf("retry: processed=%v err=%v", ok, err)
	}
	got := sourceRecord(t, s, sourceID)
	if got.Status != DeliveryStatusSent || string(got.ContentSnapshot) != string(frozen.ContentSnapshot) || countSourceDecisions(t, sourceID) != 1 {
		t.Fatalf("retry changed the historical decision: status=%s snapshot=%s", got.Status, got.ContentSnapshot)
	}
	requests := sender.requests()
	if len(requests) != 2 {
		t.Fatalf("send requests=%d, want one original and one retry", len(requests))
	}
	if requests[0].Text != requests[1].Text || requests[0].SendUUID != requests[1].SendUUID || !strings.Contains(requests[1].Text, "Agent Original agent") {
		t.Fatalf("retry changed body or send identity: %+v", requests)
	}
}

func TestSourceScanOverlappingTargetsAcrossPagesAndWorkers(t *testing.T) {
	for _, kind := range []string{RouteSourceActivity, RouteSourceComment} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			fx := newSourceFixture(t, "paged-"+kind)
			resetSourceScanCursors(t)
			// One source has more targets than a page. Each target also has
			// overlapping rules, in both creation orders, only one matching.
			for i := 0; i <= scanPageLimit; i++ {
				chat := fmt.Sprintf("oc_paged_%s_%03d", kind, i)
				fx.approveTeam(t, kind, chat)
				if i%2 == 0 {
					fx.teamRoute(t, "unmatched", kind, chat, testutil.Cols{"project_id": fx.project})
				}
				fx.teamRoute(t, "matched", kind, chat, nil)
				if i%2 != 0 {
					fx.teamRoute(t, "unmatched", kind, chat, testutil.Cols{"project_id": fx.project})
				}
			}
			var sourceID string
			if kind == RouteSourceActivity {
				sourceID = fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"done"}`)
			} else {
				sourceID = fx.comment(t, fx.issue, "one source, many distinct destinations")
			}
			results := make(chan []error, 2)
			for i := 0; i < 2; i++ {
				go func() { results <- newTestService(nil, nil).decideSourcesErr(ctx) }()
			}
			for i := 0; i < 2; i++ {
				if errs := <-results; len(errs) != 0 {
					t.Error(errs)
				}
			}
			// A worker restart and another complete cycle must add nothing.
			if errs := newTestService(nil, nil).decideSourcesErr(ctx); len(errs) != 0 {
				t.Fatal(errs)
			}
			var total, queued, wrongRoute int
			testFx.QueryRow(t, `SELECT count(*), count(*) FILTER (WHERE d.status='queued'),
				count(*) FILTER (WHERE r.project_id IS NOT NULL)
				FROM labrastro_message_delivery d JOIN labrastro_message_route r ON r.id=d.route_id
				WHERE d.source_ref_id=$1`, sourceID).Scan(&total, &queued, &wrongRoute)
			if total != scanPageLimit+1 || queued != total || wrongRoute != 0 {
				t.Fatalf("paged decisions: total=%d queued=%d wrong_route=%d", total, queued, wrongRoute)
			}
		})
	}
}

func TestSourceScanLateCommitFoundByNaturalCycle(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "natural-cycle")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceActivity, "oc_natural_cycle")
	fx.teamRoute(t, "natural", RouteSourceActivity, "oc_natural_cycle", nil)
	lateID, highID := "00000000-0000-0000-0000-000000000001", "ffffffff-ffff-ffff-ffff-ffffffffffff"
	testFx.Insert(t, "activity_log", testutil.Cols{
		"id": highID, "workspace_id": testWSID, "issue_id": fx.issue,
		"action": "status_changed", "details": testutil.Raw(`'{"from":"todo","to":"done"}'::jsonb`),
	})
	testFx.Cleanup(t, `DELETE FROM activity_log WHERE id=$1 AND workspace_id=$2`, lateID, testWSID)
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO activity_log(id,workspace_id,issue_id,action,details)
		VALUES ($1,$2,$3,'status_changed','{"from":"todo","to":"done"}')`, lateID, testWSID, fx.issue); err != nil {
		t.Fatal(err)
	}
	s := newTestService(nil, nil)
	cur, err := s.loadCursor(ctx, scannerActivitySource)
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.scanActivitySourceDecisions(ctx, cur)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveCursor(ctx, scannerActivitySource, page); err != nil {
		t.Fatal(err)
	}
	if countSourceDecisions(t, highID) != 1 || countSourceDecisions(t, lateID) != 0 {
		t.Fatal("uncommitted source entered the first page")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := s.advanceScanner(ctx, scannerActivitySource, s.scanActivitySourceDecisions); err != nil {
			t.Fatal(err)
		}
	}
	if countSourceDecisions(t, highID) != 1 || countSourceDecisions(t, lateID) != 1 {
		t.Fatal("natural cycle did not recover exactly one late decision")
	}
}

func TestSourceProjectConsentRemainsFrozenAfterRouteEdit(t *testing.T) {
	for _, kind := range []string{RouteSourceActivity, RouteSourceComment} {
		for _, change := range []string{"keep_project", "leave_project", "revoke_project"} {
			t.Run(kind+"/"+change, func(t *testing.T) {
				ctx := context.Background()
				fx := newSourceFixture(t, "frozen-"+kind+"-"+change)
				resetSourceScanCursors(t)
				testFx.Exec(t, `UPDATE issue SET project_id=$1 WHERE id=$2`, fx.project, fx.issue)
				chat := "oc_frozen_" + kind + "_" + change
				fx.approveTeam(t, kind, chat, fx.project)
				sender := &fakeSender{}
				s := newTestService(sender, nil)
				member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
				route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
					Scope: kind, InstallationID: fx.install, TargetType: TargetGroup,
					TargetChatID: chat, ProjectID: fx.project,
				})
				if err != nil {
					t.Fatal(err)
				}
				addSource := func() string {
					if kind == RouteSourceActivity {
						return fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"done"}`)
					}
					return fx.comment(t, fx.issue, "content authorized for the original project")
				}
				sourceID := addSource()
				if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
					t.Fatal(errs)
				}
				d := sourceRecord(t, s, sourceID)
				if d.SourceProjectID != uuidOf(t, fx.project) || d.SourceScope.String != kind {
					t.Fatalf("decision lost authorization scope: %+v", d)
				}
				in := sourceRouteInputFromRoute(route)
				in.ProjectID = ""
				_, err = s.UpdateSourceRoute(ctx, route, member, route.Revision, in)
				var notApproved *TargetNotApprovedError
				if !errors.As(err, &notApproved) {
					t.Fatalf("scope widening borrowed project approval: %v", err)
				}
				fx.approveTeam(t, kind, chat)
				if _, err := s.UpdateSourceRoute(ctx, route, member, route.Revision, in); err != nil {
					t.Fatal(err)
				}
				wantStatus, wantCalls := DeliveryStatusSent, 1
				switch change {
				case "leave_project":
					testFx.Exec(t, `UPDATE issue SET project_id=NULL WHERE id=$1`, fx.issue)
					wantStatus, wantCalls = DeliveryStatusCancelled, 0
				case "revoke_project":
					freshID := addSource()
					if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
						t.Fatal(errs)
					}
					approval, err := s.Queries.GetActiveLabrastroMessageSourceApprovedTarget(ctx, db.GetActiveLabrastroMessageSourceApprovedTargetParams{
						WorkspaceID: member.WorkspaceID, SourceKind: kind, ProjectID: uuidOf(t, fx.project),
						InstallationID: route.InstallationID, TargetKey: route.TargetKey,
					})
					if err != nil {
						t.Fatal(err)
					}
					if n, err := s.RevokeSourceTarget(ctx, member.WorkspaceID, kind, approval); err != nil || n != 1 {
						t.Fatalf("revoke frozen project: cancelled=%d err=%v", n, err)
					}
					if sourceRecord(t, s, freshID).Status != DeliveryStatusQueued || sourceRecord(t, s, sourceID).Status != DeliveryStatusCancelled {
						t.Fatal("revocation did not isolate the frozen project range")
					}
					return
				}
				claimed, err := s.Queries.ClaimLabrastroMessageDeliveryByID(ctx, d.ID)
				if err != nil {
					t.Fatal(err)
				}
				s.processClaimed(ctx, claimed)
				if got := sourceRecord(t, s, sourceID).Status; got != wantStatus || sender.count() != wantCalls {
					t.Fatalf("frozen scope send: status=%s calls=%d, want %s/%d", got, sender.count(), wantStatus, wantCalls)
				}
			})
		}
	}
}

func TestSourceDisableAndReenableBetweenShardsStopsOldClaim(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "disable-shards")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceComment, "oc_disable_shards")
	sender := &fakeSender{}
	s := newTestService(sender, nil)
	member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
	route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
		Scope: RouteSourceComment, InstallationID: fx.install, TargetType: TargetGroup, TargetChatID: "oc_disable_shards",
	})
	if err != nil {
		t.Fatal(err)
	}
	sourceID := fx.comment(t, fx.issue, strings.Repeat("x", shardRunes*2))
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	d := sourceRecord(t, s, sourceID)
	if d.ShardTotal < 2 {
		t.Fatal("fixture must require multiple shards")
	}
	sender.fn = func(req SendRequest) (SendResult, error) {
		disabled, err := s.SetSourceRouteEnabled(ctx, route, member, false, route.Revision)
		if err != nil {
			return SendResult{}, err
		}
		if _, err := s.SetSourceRouteEnabled(ctx, disabled, member, true, disabled.Revision); err != nil {
			return SendResult{}, err
		}
		return SendResult{ExternalMessageID: "om_first_accepted"}, nil
	}
	claimed, err := s.Queries.ClaimLabrastroMessageDeliveryByID(ctx, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	s.processClaimed(ctx, claimed)
	d = sourceRecord(t, s, sourceID)
	if sender.count() != 1 || d.Status != DeliveryStatusCancelled || d.ErrorCode.String != ErrorCodeRouteDisabled {
		t.Fatalf("old lease resumed: calls=%d status=%s code=%s", sender.count(), d.Status, d.ErrorCode.String)
	}
	if n := testFx.Count(t, `SELECT count(*) FROM labrastro_message_receipt WHERE delivery_id=$1 AND external_message_id='om_first_accepted'`, d.ID); n != 1 {
		t.Fatalf("accepted shard receipt lost: %d", n)
	}
}

type sourceCancelFailureStarter struct{ txStarter }
type sourceCancelFailureTx struct{ pgx.Tx }

func (s sourceCancelFailureStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.txStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return sourceCancelFailureTx{tx}, nil
}

func (tx sourceCancelFailureTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "-- name: CancelLabrastroMessageDeliveriesByRoute") {
		return nil, errors.New("synthetic source cancellation failure")
	}
	return tx.Tx.Query(ctx, sql, args...)
}

func TestSourceDisableRollsBackWhenCancellationFails(t *testing.T) {
	for _, operation := range []string{"disable", "edit", "delete"} {
		t.Run(operation, func(t *testing.T) {
			ctx := context.Background()
			fx := newSourceFixture(t, "atomic-"+operation)
			resetSourceScanCursors(t)
			fx.bindMember(t, testUID, "ou_atomic_"+operation)
			s := newTestService(nil, nil)
			member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
			route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
				Scope: RouteSourceInbox, InstallationID: fx.install, TargetType: TargetMember, TargetUserID: testUID,
			})
			if err != nil {
				t.Fatal(err)
			}
			sourceID := fx.inboxItem(t, testUID, "status_changed", fx.issue)
			if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
				t.Fatal(errs)
			}
			s.Tx = sourceCancelFailureStarter{testPool}
			switch operation {
			case "disable":
				_, err = s.SetSourceRouteEnabled(ctx, route, member, false, route.Revision)
			case "edit":
				in := sourceRouteInputFromRoute(route)
				enabled := false
				in.Enabled = &enabled
				_, err = s.UpdateSourceRoute(ctx, route, member, route.Revision, in)
			case "delete":
				err = s.DeleteRoute(ctx, route)
			}
			if err == nil || !strings.Contains(err.Error(), "synthetic source cancellation failure") {
				t.Fatalf("cancellation failure not propagated: %v", err)
			}
			got, err := s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{ID: route.ID, WorkspaceID: route.WorkspaceID})
			if err != nil || !got.Enabled || got.Revision != route.Revision || got.LastDisabledAt.Valid {
				t.Fatalf("failed cancellation partially changed route: %+v err=%v", got, err)
			}
			if sourceRecord(t, s, sourceID).Status != DeliveryStatusQueued {
				t.Fatal("failed cancellation changed the delivery")
			}
		})
	}
}

func TestSourceReferencesKeepInboxCommentAndParentAnchors(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "anchors")
	resetSourceScanCursors(t)
	fx.bindMember(t, testUID, "ou_anchors")
	fx.personalRoute(t, "personal", testUID, nil)
	fx.approveTeam(t, RouteSourceComment, "oc_anchors")
	fx.teamRoute(t, "team", RouteSourceComment, "oc_anchors", nil)
	parentID := fx.comment(t, fx.issue, "parent")
	commentID := testFx.Comment(t, fx.issue, "reply", testutil.Cols{"parent_id": parentID})
	itemID := fx.inboxItem(t, testUID, "new_comment", fx.issue)
	testFx.Exec(t, `UPDATE inbox_item SET details=jsonb_build_object('comment_id',$1::text) WHERE id=$2`, commentID, itemID)
	s := newTestService(nil, nil)
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	for _, id := range []string{commentID, itemID} {
		d := sourceRecord(t, s, id)
		var ref sourceRef
		if err := json.Unmarshal(d.SourceRef, &ref); err != nil {
			t.Fatal(err)
		}
		if ref.CommentID != commentID || ref.IssueID != fx.issue || (id == commentID && ref.ParentCommentID != parentID) {
			t.Fatalf("lost feedback locator in %s: %+v", util.UUIDToString(d.ID), ref)
		}
	}
}

func TestSourceNoopEditsRetainEligibilityWindow(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "noop-edits")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceActivity, "oc_noop_edits")
	s := newTestService(nil, nil)
	member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
	route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
		Scope: RouteSourceActivity, InstallationID: fx.install, TargetType: TargetGroup,
		TargetChatID: "oc_noop_edits", EventTypes: []string{"status_changed", "assignee_changed"},
	})
	if err != nil {
		t.Fatal(err)
	}
	window := route.EffectiveFrom
	sourceID := fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"done"}`)
	route, err = s.SetSourceRouteEnabled(ctx, route, member, true, route.Revision)
	if err != nil {
		t.Fatal(err)
	}
	in := sourceRouteInputFromRoute(route)
	in.EventTypes = []string{"status_changed", "assignee_changed", "status_changed"}
	route, err = s.UpdateSourceRoute(ctx, route, member, route.Revision, in)
	if err != nil {
		t.Fatal(err)
	}
	if route.EffectiveFrom != window {
		t.Fatal("equivalent filter/enable request reset eligibility")
	}
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	if sourceRecord(t, s, sourceID).Status != DeliveryStatusQueued {
		t.Fatal("no-op configuration lost an eligible event")
	}
}

func TestSourceInstallationDisableFencesReenabledClaim(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "installation-fence")
	resetSourceScanCursors(t)
	fx.bindMember(t, testUID, "ou_installation_fence")
	sender := &fakeSender{}
	s := newTestService(sender, nil)
	member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
	route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
		Scope: RouteSourceInbox, InstallationID: fx.install, TargetType: TargetMember, TargetUserID: testUID,
	})
	if err != nil {
		t.Fatal(err)
	}
	sourceID := fx.inboxItem(t, testUID, "status_changed", fx.issue)
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	d := sourceRecord(t, s, sourceID)
	claimed, err := s.Queries.ClaimLabrastroMessageDeliveryByID(ctx, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The lifecycle stop path disables every rule on the installation.
	if err := s.Queries.DisableLabrastroMessageRoutesByInstallation(ctx, db.DisableLabrastroMessageRoutesByInstallationParams{
		WorkspaceID: route.WorkspaceID, InstallationID: route.InstallationID,
	}); err != nil {
		t.Fatal(err)
	}
	route, err = s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{ID: route.ID, WorkspaceID: route.WorkspaceID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetSourceRouteEnabled(ctx, route, member, true, route.Revision); err != nil {
		t.Fatal(err)
	}
	s.processClaimed(ctx, claimed)
	if sourceRecord(t, s, sourceID).Status != DeliveryStatusCancelled || sender.count() != 0 {
		t.Fatal("installation recovery revived a pre-disable claim")
	}
}
