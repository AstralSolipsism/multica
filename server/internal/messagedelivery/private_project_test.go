package messagedelivery

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func privateMessageMember(t *testing.T, project, user string) {
	t.Helper()
	testFx.InsertNoID(t, "project_member", testutil.Cols{"workspace_id": testWSID, "project_id": project, "user_id": user}, "project_id=$1 AND user_id=$2", project, user)
}

func processPrivateMessage(t *testing.T, s *Service, id string) {
	t.Helper()
	d, err := s.Queries.ClaimLabrastroMessageDeliveryByID(t.Context(), mustUUID(id))
	if err != nil {
		t.Fatal(err)
	}
	s.processClaimed(t.Context(), d)
}

func sourceDeliveryID(t *testing.T, source string) string {
	t.Helper()
	var id string
	testFx.QueryRow(t, "SELECT id FROM labrastro_message_delivery WHERE source_ref_id=$1", source).Scan(&id)
	return id
}

func TestPrivateProjectTeamRoutes(t *testing.T) {
	for _, scope := range []string{RouteSourceActivity, RouteSourceComment} {
		t.Run(scope, func(t *testing.T) {
			fx := newSourceFixture(t, "private-team-"+scope)
			privateMessageMember(t, fx.project, testUID)
			resetSourceScanCursors(t)
			testFx.Exec(t, "UPDATE project SET visibility='private' WHERE id=$1", fx.project)
			testFx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", fx.issue, fx.project)
			wide := fx.teamRoute(t, "wide", scope, "oc_public", nil)
			fx.approveTeam(t, scope, "oc_public")
			event := "status_changed"
			if scope == RouteSourceComment {
				event = "comment"
			}
			testFx.Exec(t, "UPDATE member SET role='admin' WHERE workspace_id=$1 AND user_id=$2", testWSID, fx.memberB)
			stale := fx.teamRoute(t, "stale-scoped", scope, "oc_public", testutil.Cols{"project_id": fx.project, "updated_by": fx.memberB, "event_types": []string{event}})
			// The same destination can have an explicit private-project route;
			// the broad rule must not win dedup selection over that scoped rule.
			scoped := fx.teamRoute(t, "scoped", scope, "oc_public", testutil.Cols{"project_id": fx.project})
			fx.approveTeam(t, scope, "oc_public", fx.project)
			fx.teamRoute(t, "other-wide", scope, "oc_other_public", nil)
			fx.approveTeam(t, scope, "oc_other_public")
			source := ""
			if scope == RouteSourceActivity {
				source = fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"done"}`)
			} else {
				source = fx.comment(t, fx.issue, "private comment body")
			}
			sender := &fakeSender{}
			s := newTestService(sender, nil)
			if errs := s.decideSourcesErr(t.Context()); len(errs) > 0 {
				t.Fatal(errs)
			}
			if countSourceDecisions(t, source) != 1 || testFx.Count(t, "SELECT count(*) FROM labrastro_message_delivery WHERE route_id IN ($1, $2)", wide, stale) != 0 || testFx.Count(t, "SELECT count(*) FROM labrastro_message_delivery WHERE route_id=$1 AND status='queued'", scoped) != 1 {
				t.Fatal("private event reached a broad rule or missed the explicit project rule")
			}
			processPrivateMessage(t, s, sourceDeliveryID(t, source))
			if sender.count() != 1 {
				t.Fatal("explicit project route could not send")
			}
		})
	}
}

func TestPrivateProjectTeamSendGate(t *testing.T) {
	for _, scope := range []string{RouteSourceActivity, RouteSourceComment} {
		t.Run(scope, func(t *testing.T) {
			fx := newSourceFixture(t, "private-team-gate-"+scope)
			resetSourceScanCursors(t)
			testFx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", fx.issue, fx.project)
			fx.teamRoute(t, "wide", scope, "oc_wide", nil)
			fx.approveTeam(t, scope, "oc_wide")
			source := ""
			if scope == RouteSourceActivity {
				source = fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"done"}`)
			} else {
				source = fx.comment(t, fx.issue, "previously public")
			}
			sender := &fakeSender{}
			s := newTestService(sender, nil)
			if errs := s.decideSourcesErr(t.Context()); len(errs) > 0 {
				t.Fatal(errs)
			}
			id := sourceDeliveryID(t, source)
			testFx.Exec(t, "UPDATE project SET visibility='private' WHERE id=$1", fx.project)
			processPrivateMessage(t, s, id)
			status, _, code, _ := deliveryStatus(t, id)
			if status != DeliveryStatusCancelled || code != ErrorCodeConditionMismatch || sender.count() != 0 {
				t.Fatalf("private team send: %s/%s, calls=%d", status, code, sender.count())
			}
		})
	}
}

func TestPrivateProjectInboxDecisionsAndRetry(t *testing.T) {
	for _, change := range []string{"membership", "issue_moved"} {
		t.Run(change, func(t *testing.T) {
			fx := newSourceFixture(t, "private-inbox-"+change)
			resetSourceScanCursors(t)
			testFx.Exec(t, "UPDATE project SET visibility='private' WHERE id=$1", fx.project)
			if change == "membership" {
				testFx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", fx.issue, fx.project)
				privateMessageMember(t, fx.project, fx.memberB)
			}
			fx.bindMember(t, fx.memberB, "ou_private_inbox")
			fx.personalRoute(t, "personal", fx.memberB, nil)
			item := fx.inboxItem(t, fx.memberB, "status_changed", fx.issue)
			sender := &fakeSender{fn: func(SendRequest) (SendResult, error) {
				return SendResult{}, &SendError{Class: ClassTransient, Err: errors.New("temporary transport failure")}
			}}
			s := newTestService(sender, nil)
			if errs := s.decideSourcesErr(t.Context()); len(errs) > 0 {
				t.Fatal(errs)
			}
			id := sourceDeliveryID(t, item)
			processPrivateMessage(t, s, id)
			if status, _, _, _ := deliveryStatus(t, id); status != DeliveryStatusQueued || sender.count() != 1 {
				t.Fatalf("initial authorized send: %s, calls=%d", status, sender.count())
			}
			if change == "membership" {
				testFx.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", fx.project, fx.memberB)
			} else {
				testFx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", fx.issue, fx.project)
			}
			// Retry the original frozen decision, after the source became hidden.
			testFx.Exec(t, "UPDATE labrastro_message_delivery SET status='queued', next_attempt_at=now() WHERE id=$1", id)
			processPrivateMessage(t, s, id)
			status, _, code, _ := deliveryStatus(t, id)
			if status != DeliveryStatusCancelled || code != ErrorCodeAuthorizationLost || sender.count() != 1 {
				t.Fatalf("revoked retry sent: %s/%s, calls=%d", status, code, sender.count())
			}
			item2 := fx.inboxItem(t, fx.memberB, "status_changed", fx.issue)
			resetSourceScanCursors(t)
			if errs := s.decideSourcesErr(t.Context()); len(errs) > 0 {
				t.Fatal(errs)
			}
			if countSourceDecisions(t, item2) != 0 {
				t.Fatal("hidden inbox item remained a forwarding candidate")
			}
		})
	}
}

func TestPrivateProjectAutopilotRouteAuthority(t *testing.T) {
	for _, revoke := range []string{"recipient", "authorizer", "previous_recipient"} {
		t.Run(revoke, func(t *testing.T) {
			project := testFx.Project(t, "private autopilot", testutil.Cols{"visibility": "private"})
			privateMessageMember(t, project, testUID)
			user := testFx.User(t, "private route member", "private-route-"+project+"@test.invalid")
			testFx.Member(t, testWSID, user, "member")
			fx := newMDFixture(t, "private-run-"+revoke, testutil.Cols{"project_id": project, "created_by_id": user})
			fx.bindMember(t, user, "ou_private_run")
			sender := &fakeSender{}
			s := newTestService(sender, nil)
			in := RouteInput{InstallationID: fx.install, TargetType: TargetMember, TargetUserID: user, Conditions: ConditionSuccess, ContentMode: ContentWithOutput}
			ap := loadAutopilot(t, fx.autopilot)
			if _, err := s.CreateRoute(t.Context(), ap, loadMember(t), in); !errors.Is(err, ErrAuthorizationLost) {
				t.Fatalf("saved route to a private-project outsider: %v", err)
			}
			privateMessageMember(t, project, user)
			authorizer := loadMember(t)
			if revoke == "authorizer" {
				var err error
				authorizer, err = s.Queries.GetMemberByUserAndWorkspace(t.Context(), db.GetMemberByUserAndWorkspaceParams{WorkspaceID: mustUUID(testWSID), UserID: mustUUID(user)})
				if err != nil {
					t.Fatal(err)
				}
				fx.bindMember(t, testUID, "ou_owner_run")
				in.TargetUserID = testUID
			}
			route, err := s.CreateRoute(t.Context(), ap, authorizer, in)
			if err != nil {
				t.Fatal(err)
			}
			run := fx.run(t, "completed", nil)
			if n, err := s.EnqueueRunDeliveries(t.Context(), mustUUID(run)); err != nil || n != 1 {
				t.Fatalf("enqueue %d: %v", n, err)
			}
			id := firstDeliveryForRun(t, run)
			testFx.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", project, user)
			if revoke == "previous_recipient" {
				fx.bindMember(t, testUID, "ou_replacement_recipient")
				in.TargetUserID = testUID
				if _, err := s.UpdateRoute(t.Context(), route, authorizer, route.Revision, in); err != nil {
					t.Fatal(err)
				}
			}
			processPrivateMessage(t, s, id)
			status, _, code, _ := deliveryStatus(t, id)
			if status != DeliveryStatusCancelled || code != ErrorCodeAuthorizationLost || sender.count() != 0 {
				t.Fatalf("revoked %s delivered: %s/%s, calls=%d", revoke, status, code, sender.count())
			}
			run2 := fx.run(t, "completed", nil)
			if _, err := s.EnqueueRunDeliveries(t.Context(), mustUUID(run2)); err != nil {
				t.Fatal(err)
			}
			queued := testFx.Count(t, "SELECT count(*) FROM labrastro_message_delivery WHERE run_id=$1 AND status='queued'", run2)
			if revoke == "previous_recipient" {
				if queued != 1 {
					t.Fatal("authorized replacement recipient lost new deliveries")
				}
				processPrivateMessage(t, s, firstDeliveryForRun(t, run2))
				if sender.count() != 1 {
					t.Fatal("authorized replacement recipient could not receive")
				}
			} else if queued != 0 {
				t.Fatal("revoked principal passed decision-time authorization")
			}
			if revoke == "authorizer" {
				if _, err := s.UpdateRoute(t.Context(), route, authorizer, route.Revision, in); !errors.Is(err, ErrAuthorizationLost) {
					t.Fatalf("revoked authorizer could save route: %v", err)
				}
			}
		})
	}
}

func TestPrivateProjectInboxRevokedAfterCandidateRead(t *testing.T) {
	fx := newSourceFixture(t, "private-inbox-stale-candidate")
	testFx.Exec(t, "UPDATE project SET visibility='private' WHERE id=$1", fx.project)
	testFx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", fx.issue, fx.project)
	privateMessageMember(t, fx.project, fx.memberB)
	fx.bindMember(t, fx.memberB, "ou_stale_inbox")
	fx.personalRoute(t, "personal", fx.memberB, nil)
	item := fx.inboxItem(t, fx.memberB, "status_changed", fx.issue)
	s := newTestService(&fakeSender{}, nil)
	rows, err := s.Queries.ListLabrastroMessageInboxSourceCandidates(t.Context(), db.ListLabrastroMessageInboxSourceCandidatesParams{
		ScanFrom: pgtype.Timestamptz{Time: time.Unix(0, 0), Valid: true}, ScanThrough: pgtype.Timestamptz{Time: time.Now(), Valid: true},
		AfterID: scanCursorStart.id, UpperID: mustUUID(item), Limit: 200,
	})
	if err != nil {
		t.Fatal(err)
	}
	var candidate db.ListLabrastroMessageInboxSourceCandidatesRow
	for _, row := range rows {
		if row.ItemID == mustUUID(item) {
			candidate = row
		}
	}
	if !candidate.ItemID.Valid {
		t.Fatal("authorized item was not a candidate")
	}
	testFx.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", fx.project, fx.memberB)
	if err := s.decideInboxPair(t.Context(), candidate); err != nil {
		t.Fatal(err)
	}
	id := sourceDeliveryID(t, item)
	status, _, code, _ := deliveryStatus(t, id)
	if status != DeliveryStatusSuppressed || code != ErrorCodeAuthorizationLost {
		t.Fatalf("stale candidate escaped decision guard: %s/%s", status, code)
	}
	var content, ref string
	testFx.QueryRow(t, "SELECT content_snapshot::text, source_ref::text FROM labrastro_message_delivery WHERE id=$1", id).Scan(&content, &ref)
	var snapshot contentSnapshot
	var source sourceRef
	if err := json.Unmarshal([]byte(content), &snapshot); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(ref), &source); err != nil {
		t.Fatal(err)
	}
	if snapshot != (contentSnapshot{}) || source != (sourceRef{}) {
		t.Fatalf("unauthorized decision retained private content: %s / %s", content, ref)
	}
}

func TestPrivateProjectTeamRouteRequiresProjectMembers(t *testing.T) {
	for _, scope := range []string{RouteSourceActivity, RouteSourceComment} {
		t.Run(scope, func(t *testing.T) {
			fx := newSourceFixture(t, "private-config-"+scope)
			testFx.Exec(t, "UPDATE project SET visibility='private' WHERE id=$1", fx.project)
			s := newTestService(&fakeSender{}, nil)
			member := loadMember(t)
			in := SourceRouteInput{Scope: scope, ProjectID: fx.project, InstallationID: fx.install, TargetType: TargetGroup, TargetChatID: "oc_private_config"}
			verifier := s.Verifier.(*fakeVerifier)
			var invalid *InvalidRouteError
			if _, err := s.ResolveSourceTargetForApproval(t.Context(), member, scope, in); !errors.As(err, &invalid) || invalid.Field != "project_id" {
				t.Fatalf("non-member owner resolved private target: %v", err)
			}
			if verifier.calls.Load() != 0 {
				t.Fatal("unauthorized resolution contacted Feishu")
			}
			privateMessageMember(t, fx.project, testUID)
			target, err := s.ResolveSourceTargetForApproval(t.Context(), member, scope, in)
			if err != nil {
				t.Fatal(err)
			}
			// Removal between resolution and save must still be refused.
			testFx.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", fx.project, testUID)
			if _, err := s.ApproveSourceTarget(t.Context(), member.WorkspaceID, scope, member, target); !errors.Is(err, ErrAuthorizationLost) {
				t.Fatalf("removed owner approved private project: %v", err)
			}
			testFx.Exec(t, "INSERT INTO project_member (workspace_id, project_id, user_id) VALUES ($1,$2,$3)", testWSID, fx.project, testUID)
			approval, err := s.ApproveSourceTarget(t.Context(), member.WorkspaceID, scope, member, target)
			if err != nil {
				t.Fatal(err)
			}
			testFx.Cleanup(t, "DELETE FROM labrastro_message_approved_target WHERE id=$1", approval.ID)
			route, err := s.CreateSourceRoute(t.Context(), member, in)
			if err != nil {
				t.Fatal(err)
			}
			var deliveries []pgtype.UUID
			for _, status := range []string{DeliveryStatusQueued, DeliveryStatusFailed} {
				id := testFx.Insert(t, "labrastro_message_delivery", testutil.Cols{
					"id": testutil.Raw("gen_random_uuid()"), "workspace_id": testWSID, "route_id": route.ID,
					"installation_id": fx.install, "target_key": route.TargetKey,
					"dedup_key": fx.project + status, "source_kind": scope, "source_scope": scope,
					"source_ref_id": testutil.Raw("gen_random_uuid()"), "source_project_id": fx.project,
					"status": status, "content_snapshot": `{"body":"private comment"}`, "target_snapshot": "{}",
				})
				deliveries = append(deliveries, mustUUID(id))
			}
			testFx.Exec(t, "UPDATE member SET role='admin' WHERE workspace_id=$1 AND user_id=$2", testWSID, fx.memberB)
			outsider, err := s.Queries.GetMemberByUserAndWorkspace(t.Context(), db.GetMemberByUserAndWorkspaceParams{WorkspaceID: member.WorkspaceID, UserID: mustUUID(fx.memberB)})
			if err != nil {
				t.Fatal(err)
			}
			checks := []struct {
				name string
				call func() error
			}{
				{"update", func() error {
					_, err := s.UpdateSourceRoute(t.Context(), route, outsider, route.Revision, in)
					return err
				}},
				{"disable", func() error {
					_, err := s.SetSourceRouteEnabled(t.Context(), route, outsider, false, route.Revision)
					return err
				}},
				{"enable", func() error {
					_, err := s.SetSourceRouteEnabled(t.Context(), route, outsider, true, route.Revision)
					return err
				}},
				{"test_send", func() error { _, err := s.TestSourceSend(t.Context(), route, outsider); return err }},
				{"list_deliveries", func() error { _, err := s.ListRouteDeliveries(t.Context(), outsider, route.ID, nil, 50, 0); return err }},
				{"get_delivery", func() error {
					_, _, err := s.GetSourceDelivery(t.Context(), outsider, route.ID, deliveries[0])
					return err
				}},
				{"retry", func() error {
					_, err := s.RetryRouteDelivery(t.Context(), outsider, route.ID, deliveries[1])
					return err
				}},
				{"delete", func() error { return s.DeleteRoute(t.Context(), route, outsider) }},
				{"revoke", func() error { _, err := s.RevokeSourceTarget(t.Context(), outsider, approval); return err }},
			}
			for _, check := range checks {
				t.Run(check.name, func(t *testing.T) {
					if err := check.call(); !errors.Is(err, ErrAuthorizationLost) {
						t.Fatalf("non-member admin %s: %v", check.name, err)
					}
				})
			}
			rows, err := s.ListSourceApprovedTargets(t.Context(), outsider)
			if err != nil || len(rows) != 0 {
				t.Fatalf("private approvals visible to non-member: %+v, %v", rows, err)
			}
			calls := verifier.calls.Load()
			in.TargetChatID = "oc_private_new"
			if _, err := s.CreateSourceRoute(t.Context(), outsider, in); !errors.As(err, &invalid) || invalid.Field != "project_id" {
				t.Fatalf("non-member admin created private route: %v", err)
			}
			if verifier.calls.Load() != calls {
				t.Fatal("unauthorized create contacted Feishu")
			}
			fresh := loadRoute(t, util.UUIDToString(route.ID))
			if !fresh.Enabled || fresh.Revision != route.Revision {
				t.Fatalf("denied operation changed route: %+v", fresh)
			}
			for i, id := range deliveries {
				status, _, _, _ := deliveryStatus(t, util.UUIDToString(id))
				if status != []string{DeliveryStatusQueued, DeliveryStatusFailed}[i] {
					t.Fatalf("denied operation changed delivery: %s", status)
				}
			}
			// The same admin gains access only after joining the project.
			privateMessageMember(t, fx.project, fx.memberB)
			rows, err = s.ListSourceApprovedTargets(t.Context(), outsider)
			if err != nil || len(rows) != 1 || rows[0].ID != approval.ID {
				t.Fatalf("member approval list: %+v, %v", rows, err)
			}
			records, err := s.ListRouteDeliveries(t.Context(), outsider, route.ID, nil, 50, 0)
			if err != nil || len(records) != 2 {
				t.Fatalf("member delivery list: %+v, %v", records, err)
			}
			d, _, err := s.GetSourceDelivery(t.Context(), outsider, route.ID, deliveries[0])
			if err != nil || !strings.Contains(string(d.ContentSnapshot), "private comment") {
				t.Fatalf("member snapshot missing: %+v, %v", d, err)
			}
			if _, err := s.RetryRouteDelivery(t.Context(), outsider, route.ID, deliveries[1]); err != nil {
				t.Fatal(err)
			}
			if n, err := s.RevokeSourceTarget(t.Context(), outsider, approval); err != nil || n != 2 {
				t.Fatalf("member revoke: cancelled=%d err=%v", n, err)
			}
			if err := s.DeleteRoute(t.Context(), route, outsider); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPrivateProjectTeamSendRechecksBothPrincipals(t *testing.T) {
	for _, scope := range []string{RouteSourceActivity, RouteSourceComment} {
		for _, revoke := range []string{"authorizer", "approver"} {
			t.Run(scope+"/"+revoke, func(t *testing.T) {
				fx := newSourceFixture(t, "private-principals-"+scope+revoke)
				resetSourceScanCursors(t)
				testFx.Exec(t, "UPDATE project SET visibility='private' WHERE id=$1", fx.project)
				testFx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", fx.issue, fx.project)
				testFx.Exec(t, "UPDATE member SET role='admin' WHERE workspace_id=$1 AND user_id=$2", testWSID, fx.memberB)
				privateMessageMember(t, fx.project, testUID)
				privateMessageMember(t, fx.project, fx.memberB)
				fx.teamRoute(t, "scoped", scope, "oc_principals", testutil.Cols{"project_id": fx.project, "updated_by": fx.memberB})
				fx.approveTeam(t, scope, "oc_principals", fx.project)
				var source string
				if scope == RouteSourceActivity {
					source = fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"done"}`)
				} else {
					source = fx.comment(t, fx.issue, "private body")
				}
				sender := &fakeSender{}
				s := newTestService(sender, nil)
				if errs := s.decideSourcesErr(t.Context()); len(errs) > 0 {
					t.Fatal(errs)
				}
				id := sourceDeliveryID(t, source)
				principal := fx.memberB
				if revoke == "approver" {
					principal = testUID
				}
				testFx.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", fx.project, principal)
				processPrivateMessage(t, s, id)
				status, _, code, _ := deliveryStatus(t, id)
				if status != DeliveryStatusCancelled || code != ErrorCodeAuthorizationLost || sender.count() != 0 {
					t.Fatalf("revoked %s sent: %s/%s calls=%d", revoke, status, code, sender.count())
				}
				route, err := s.Queries.GetLabrastroMessageRoute(t.Context(), db.GetLabrastroMessageRouteParams{ID: mustUUID(fx.routes[0]), WorkspaceID: mustUUID(testWSID)})
				if err != nil {
					t.Fatal(err)
				}
				out := s.gateTestSendSource(t.Context(), db.LabrastroMessageDelivery{WorkspaceID: mustUUID(testWSID), SourceProjectID: mustUUID(fx.project), RequestedBy: mustUUID(principal)}, route)
				if out == nil || out.errorCode != ErrorCodeAuthorizationLost {
					t.Fatalf("non-member diagnostic passed: %+v", out)
				}
			})
		}
	}
}

func TestPrivateProjectInboxOwnerHasNoBypass(t *testing.T) {
	fx := newSourceFixture(t, "private-inbox-owner")
	resetSourceScanCursors(t)
	testFx.Exec(t, "UPDATE project SET visibility='private' WHERE id=$1", fx.project)
	testFx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", fx.issue, fx.project)
	fx.bindMember(t, testUID, "ou_private_owner")
	fx.personalRoute(t, "owner", testUID, nil)
	item := fx.inboxItem(t, testUID, "status_changed", fx.issue)
	s := newTestService(&fakeSender{}, nil)
	if errs := s.decideSourcesErr(t.Context()); len(errs) > 0 {
		t.Fatal(errs)
	}
	if countSourceDecisions(t, item) != 0 {
		t.Fatal("non-member owner remained an inbox candidate")
	}
}
