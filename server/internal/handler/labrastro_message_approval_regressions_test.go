package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// These review regressions exercise the public HTTP handlers against the
// confirmed OL-25 repair contract v1, A1. Only the Feishu transport is fake.

func v1ReviewApprovalCleanup(t *testing.T, autopilotID string) {
	t.Helper()
	t.Cleanup(func() {
		for _, query := range []string{
			`DELETE FROM labrastro_message_approved_target WHERE autopilot_id = $1`,
			`DELETE FROM autopilot_collaborator WHERE autopilot_id = $1`,
		} {
			if _, err := testPool.Exec(context.Background(), query, autopilotID); err != nil {
				t.Errorf("review fixture cleanup: %v", err)
			}
		}
	})
}

func TestContractHTTPApprovalManagementUsesActingHuman(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		for _, admin := range []bool{false, true} {
			label := method + "_member"
			if admin {
				label = method + "_owner"
			}
			t.Run(label, func(t *testing.T) {
				fx := newMDFixture(t, label, "run_only")
				v1ReviewApprovalCleanup(t, fx.autopilotID)
				testutil.Call(t, testHandler.ApproveMessageTarget, v1ReviewApprovalRequest(fx, actingCaller{authUserID: testUserID}, "oc_manage")).Want(http.StatusCreated)
				var approvalID, approvedBy string
				dbfx.QueryRow(t, `SELECT id,approved_by FROM labrastro_message_approved_target WHERE autopilot_id=$1`, fx.autopilotID).Scan(&approvalID, &approvedBy)
				if approvedBy != testUserID {
					t.Fatal("approval audit did not record the acting human")
				}
				member := plainMember(t, "contract-manager")
				grantAutopilotAccess(t, "", fx.autopilotID, member, http.StatusCreated)
				auth, origin := testUserID, member
				want := http.StatusForbidden
				if admin {
					auth, origin = member, testUserID
					want = http.StatusOK
				}
				var agent string
				dbfx.QueryRow(t, `SELECT assignee_id FROM autopilot WHERE id=$1`, fx.autopilotID).Scan(&agent)
				caller := actingCaller{authUserID: auth, agentID: agent, taskID: callerTask(t, agent, origin)}
				path := "/api/autopilots/" + fx.autopilotID + "/message-approved-targets"
				if method == http.MethodDelete {
					path += "/" + approvalID
				}
				req := withURLParams(caller.request(method, path+"?workspace_id="+testWorkspaceID, nil), "id", fx.autopilotID, "targetId", approvalID)
				handler := testHandler.ListMessageApprovedTargets
				if method == http.MethodDelete {
					handler = testHandler.RevokeMessageTarget
				}
				testutil.Call(t, handler, req).Want(want)
				if !admin {
					var active bool
					dbfx.QueryRow(t, `SELECT revoked_at IS NULL FROM labrastro_message_approved_target WHERE id=$1`, approvalID).Scan(&active)
					if !active {
						t.Fatal("unauthorized manager revoked approval")
					}
				}
			})
		}
	}
}

func TestContractHTTPRevokeKeepsOtherInstallationApproval(t *testing.T) {
	fx := newMDFixture(t, "scope-one", "run_only")
	other := newMDFixture(t, "scope-two", "run_only")
	v1ReviewApprovalCleanup(t, fx.autopilotID)
	first := v1ReviewApprovalRequest(fx, actingCaller{authUserID: testUserID}, "oc_same_target")
	testutil.Call(t, testHandler.ApproveMessageTarget, first).Want(http.StatusCreated)
	testutil.Call(t, testHandler.ApproveMessageTarget, v1ReviewApprovalRequest(mdFixture{autopilotID: fx.autopilotID, installID: other.installID}, actingCaller{authUserID: testUserID}, "oc_same_target")).Want(http.StatusCreated)
	var id string
	dbfx.QueryRow(t, `SELECT id FROM labrastro_message_approved_target WHERE autopilot_id=$1 AND installation_id=$2`, fx.autopilotID, fx.installID).Scan(&id)
	revoke := func() {
		req := withURLParams(newRequest(http.MethodDelete, "/api/autopilots/"+fx.autopilotID+"/message-approved-targets/"+id, nil), "id", fx.autopilotID, "targetId", id)
		testutil.Call(t, testHandler.RevokeMessageTarget, req).Want(http.StatusOK)
	}
	revoke()
	var active int
	dbfx.QueryRow(t, `SELECT count(*) FROM labrastro_message_approved_target WHERE autopilot_id=$1 AND installation_id=$2 AND revoked_at IS NULL`, fx.autopilotID, other.installID).Scan(&active)
	if active != 1 {
		t.Fatal("revocation crossed installation scope")
	}
	req := withURLParams(newRequest(http.MethodDelete, "/api/autopilots/"+fx.autopilotID+"/message-approved-targets/"+id, nil), "id", fx.autopilotID, "targetId", id)
	testutil.Call(t, testHandler.RevokeMessageTarget, req).Want(http.StatusNotFound)
}

func TestContractLifecycleStopsApprovedDeliveries(t *testing.T) {
	for _, entry := range []string{"archive", "installation", "runtime"} {
		t.Run(entry, func(t *testing.T) {
			ctx := context.Background()
			fx := newMDFixture(t, "lifecycle_"+entry, "run_only")
			v1ReviewApprovalCleanup(t, fx.autopilotID)
			fx.bindMember(t, testUserID, "ou_lifecycle")
			fx.createMemberRoute(t, testUserID, true)
			testutil.Call(t, testHandler.ApproveMessageTarget, v1ReviewApprovalRequest(fx, actingCaller{authUserID: testUserID}, "oc_lifecycle")).Want(http.StatusCreated)
			run := dbfx.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": fx.autopilotID, "source": "schedule", "status": "completed", "result": testutil.Raw(`'{"output":"synthetic lifecycle result"}'::jsonb`), "completed_at": testutil.Raw("now()")})
			svc := requireDeliveryService(t)
			sender := &mdSender{}
			previous := svc.Sender
			svc.Sender = sender
			t.Cleanup(func() { svc.Sender = previous })
			if n, err := svc.EnqueueRunDeliveries(ctx, mustUUIDFrom(t, run)); err != nil || n != 1 {
				t.Fatalf("enqueue: %d %v", n, err)
			}
			switch entry {
			case "archive":
				req := withURLParams(newRequest(http.MethodDelete, "/api/autopilots/"+fx.autopilotID, nil), "id", fx.autopilotID)
				testutil.Call(t, testHandler.DeleteAutopilot, req).Want(http.StatusNoContent)
			case "installation":
				wireLarkInstallServices(t)
				req := withURLParams(newRequest(http.MethodDelete, "/api/workspaces/"+testWorkspaceID+"/lark/installations/"+fx.installID, nil), "id", testWorkspaceID, "installationId", fx.installID)
				testutil.Call(t, testHandler.RevokeLarkInstallation, req).Want(http.StatusNoContent)
			case "runtime":
				runtime := dbfx.Runtime(t, "delivery system runtime", nil)
				agent := dbfx.Agent(t, "delivery system agent", runtime, testutil.Cols{"kind": "system", "system_key": "delivery_cleanup"})
				dbfx.Exec(t, `UPDATE channel_installation SET agent_id=$1 WHERE id=$2`, agent, fx.installID)
				tx, err := testPool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				if _, err := service.TeardownRuntime(ctx, testHandler.Queries.WithTx(tx), mustUUIDFrom(t, runtime), service.RuntimeTeardownOptions{}); err != nil {
					t.Fatal(err)
				}
				if err := tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				var count int
				dbfx.QueryRow(t, `SELECT count(*) FROM channel_installation WHERE id=$1`, fx.installID).Scan(&count)
				if count != 0 {
					t.Fatal("runtime teardown did not delete installation")
				}
			}
			var approvals int
			dbfx.QueryRow(t, `SELECT count(*) FROM labrastro_message_approved_target WHERE autopilot_id=$1`, fx.autopilotID).Scan(&approvals)
			var status string
			dbfx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE run_id=$1`, run).Scan(&status)
			if approvals != 0 || status != "cancelled" {
				t.Fatalf("lifecycle incomplete: approvals=%d delivery=%s", approvals, status)
			}
			if _, err := svc.ProcessNext(ctx); err != nil {
				t.Fatal(err)
			}
			sender.mu.Lock()
			sends := len(sender.calls)
			sender.mu.Unlock()
			if sends != 0 {
				t.Fatal("lifecycle left a sendable row")
			}
		})
	}
}

func v1ReviewApprovalRequest(fx mdFixture, caller actingCaller, chatID string) *http.Request {
	return withURLParams(caller.request(http.MethodPost,
		"/api/autopilots/"+fx.autopilotID+"/message-approved-targets?workspace_id="+testWorkspaceID,
		map[string]any{
			"installation_id": fx.installID,
			"target_type":     "group",
			"target_chat_id":  chatID,
		}), "id", fx.autopilotID)
}

func TestV1ReviewHTTPApprovalRejectsCollaboratorOnOwnerRuntime(t *testing.T) {
	fx := newMDFixture(t, "v1_approve_collaborator", "run_only")
	v1ReviewApprovalCleanup(t, fx.autopilotID)
	orderingHuman := plainMember(t, "v1-approval-collaborator")
	grantAutopilotAccess(t, "", fx.autopilotID, orderingHuman, http.StatusCreated)
	if !autopilotCanWrite(t, orderingHuman, fx.autopilotID) {
		t.Fatal("setup: ordering human is not an automation writer")
	}
	var agentID string
	dbfx.QueryRow(t, `SELECT assignee_id FROM autopilot WHERE id = $1`, fx.autopilotID).Scan(&agentID)
	caller := actingCaller{
		authUserID: testUserID,
		agentID:    agentID,
		taskID:     callerTask(t, agentID, orderingHuman),
	}
	resp := testutil.Call(t, testHandler.ApproveMessageTarget,
		v1ReviewApprovalRequest(fx, caller, "oc_v1_collaborator"))
	var active int
	dbfx.QueryRow(t, `SELECT count(*) FROM labrastro_message_approved_target
		WHERE autopilot_id = $1 AND revoked_at IS NULL`, fx.autopilotID).Scan(&active)
	t.Logf("ordinary collaborator originator, owner runtime: HTTP=%d active_approvals=%d body=%s",
		resp.Code, active, resp.Body.String())
	if resp.Code != http.StatusForbidden || active != 0 {
		t.Fatalf("A1: a collaborator must not borrow the runtime owner's approval authority; want HTTP 403 and 0 approvals, got HTTP %d and %d", resp.Code, active)
	}
}

func TestV1ReviewHTTPApprovalAcceptsOwnerOnMemberRuntime(t *testing.T) {
	fx := newMDFixture(t, "v1_approve_owner", "run_only")
	v1ReviewApprovalCleanup(t, fx.autopilotID)
	machineOwner := plainMember(t, "v1-approval-machine-member")
	var agentID string
	dbfx.QueryRow(t, `SELECT assignee_id FROM autopilot WHERE id = $1`, fx.autopilotID).Scan(&agentID)
	caller := actingCaller{
		authUserID: machineOwner,
		agentID:    agentID,
		taskID:     callerTask(t, agentID, testUserID),
	}
	resp := testutil.Call(t, testHandler.ApproveMessageTarget,
		v1ReviewApprovalRequest(fx, caller, "oc_v1_owner"))
	t.Logf("owner originator, ordinary member runtime: HTTP=%d body=%s", resp.Code, resp.Body.String())
	if resp.Code != http.StatusCreated {
		t.Fatalf("A1: owner originator must retain approval authority on a member's runtime; want HTTP 201, got HTTP %d", resp.Code)
	}
}

func TestV1ReviewHTTPApprovalRevocationStopsQueuedDelivery(t *testing.T) {
	fx := newMDFixture(t, "v1_revoke", "run_only")
	v1ReviewApprovalCleanup(t, fx.autopilotID)
	svc := requireDeliveryService(t)
	sender := &mdSender{}
	previousSender := svc.Sender
	svc.Sender = sender
	t.Cleanup(func() { svc.Sender = previousSender })

	approve := testutil.Call(t, testHandler.ApproveMessageTarget,
		v1ReviewApprovalRequest(fx, actingCaller{authUserID: testUserID}, "oc_v1_revoke"))
	approve.Want(http.StatusCreated)
	var approval struct {
		ApprovedTarget struct {
			ID string `json:"id"`
		} `json:"approved_target"`
	}
	approve.JSON(&approval)
	if approval.ApprovedTarget.ID == "" {
		t.Fatal("setup: approval response has no ID")
	}

	createRoute := withURLParams(newRequest(http.MethodPost,
		"/api/autopilots/"+fx.autopilotID+"/message-routes", map[string]any{
			"installation_id": fx.installID,
			"target_type":     "group",
			"target_chat_id":  "oc_v1_revoke",
			"conditions":      "success",
			"content_mode":    "with_output",
			"enabled":         true,
		}), "id", fx.autopilotID)
	testutil.Call(t, testHandler.CreateMessageRoute, createRoute).Want(http.StatusCreated)
	runID := dbfx.Insert(t, "autopilot_run", testutil.Cols{
		"autopilot_id": fx.autopilotID,
		"source":       "schedule",
		"status":       "completed",
		"result":       testutil.Raw(`'{"output":"synthetic approved result"}'::jsonb`),
		"completed_at": testutil.Raw("now()"),
	})
	if count, err := svc.EnqueueRunDeliveries(context.Background(), mustUUIDFrom(t, runID)); err != nil || count != 1 {
		t.Fatalf("setup: enqueue count=%d error=%v", count, err)
	}

	revokeRequest := withURLParams(newRequest(http.MethodDelete,
		"/api/autopilots/"+fx.autopilotID+"/message-approved-targets/"+approval.ApprovedTarget.ID, nil),
		"id", fx.autopilotID, "targetId", approval.ApprovedTarget.ID)
	revoke := testutil.Call(t, testHandler.RevokeMessageTarget, revokeRequest)
	revoke.Want(http.StatusOK)
	var active bool
	dbfx.QueryRow(t, `SELECT revoked_at IS NULL FROM labrastro_message_approved_target WHERE id = $1`, approval.ApprovedTarget.ID).Scan(&active)
	t.Logf("revoke HTTP=%d approval_still_active=%t body=%s", revoke.Code, active, revoke.Body.String())
	if active {
		t.Error("A1: successful revoke left the exact approval active")
	}

	worked, err := svc.ProcessNext(context.Background())
	if err != nil {
		t.Fatalf("process after revoke: %v", err)
	}
	var status string
	dbfx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE run_id = $1`, runID).Scan(&status)
	sender.mu.Lock()
	sends := len(sender.calls)
	sender.mu.Unlock()
	t.Logf("after revoke: worked=%t sender_calls=%d delivery_status=%s", worked, sends, status)
	if sends != 0 || status != "cancelled" {
		t.Errorf("A1: revoked queued result must not send; want sender_calls=0/status=cancelled, got %d/%s", sends, status)
	}
}
