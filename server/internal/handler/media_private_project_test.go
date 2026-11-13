package handler

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/daemonws"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestMediaPrivateProjectInputs(t *testing.T) {
	for _, origin := range []string{"issue", "comment"} {
		t.Run(origin, func(t *testing.T) {
			f := newPrivateProjectFixture(t)
			h := *testHandler
			t.Setenv("LOCAL_UPLOAD_DIR", t.TempDir())
			h.Storage = storage.NewLocalStorageFromEnv()
			cols := testutil.Cols{"issue_id": f.secretIssue}
			if origin == "comment" {
				cols = testutil.Cols{"comment_id": f.secretComment}
			}
			input := mediaInputFixture(t, &h, cols)
			req := protocol.MediaRequest{Provider: "codex", Capability: "image-generate", Prompt: "edit", Inputs: []protocol.MediaInput{{AttachmentID: input}}}
			denied := testutil.Call(t, h.CreateMediaJob, asUser(newRequest("POST", "/", req), f.outsider)).Want(404).Text()
			missingReq := req
			missingReq.Inputs = []protocol.MediaInput{{AttachmentID: uuid.NewString()}}
			missing := testutil.Call(t, h.CreateMediaJob, asUser(newRequest("POST", "/", missingReq), f.outsider)).Want(404).Text()
			if denied != missing {
				t.Fatal("media creation discloses hidden attachment existence")
			}
			rt := mediaTestRuntime(t, "codex", 0)
			dbfx.Exec(t, "UPDATE agent_runtime SET visibility='public' WHERE id=$1", rt)
			var job protocol.MediaJob
			testutil.Call(t, h.CreateMediaJob, asUser(newRequest("POST", "/", req), f.insider)).Want(202).JSON(&job)
			dbfx.Cleanup(t, "DELETE FROM media_job WHERE id=$1", job.ID)
			// A queued job must use the caller's current access, not its old creation check.
			dbfx.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", f.projectID, f.insider)
			if claimTestMediaJob(t, &h, rt) != nil {
				t.Fatal("claim issued a token to a caller outside the input project")
			}
			addProjectMemberRow(t, f.projectID, f.insider)
			a := claimTestMediaJob(t, &h, rt)
			if a == nil || a.Job.ID != job.ID {
				t.Fatal("authorized input was not assigned")
			}
			testutil.Call(t, h.DownloadMediaInput, mediaTransferRequest(a, "GET", nil, input)).Want(200)
			dbfx.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", f.projectID, f.insider)
			testutil.Call(t, h.DownloadMediaInput, mediaTransferRequest(a, "GET", nil, input)).Want(404)
		})
	}
}

func TestMediaPrivateProjectRuntimeOwnerAndMovedInput(t *testing.T) {
	f := newPrivateProjectFixture(t)
	h := *testHandler
	t.Setenv("LOCAL_UPLOAD_DIR", t.TempDir())
	h.Storage = storage.NewLocalStorageFromEnv()
	input := mediaInputFixture(t, &h, testutil.Cols{"issue_id": f.publicIssue})
	rt := mediaTestRuntime(t, "codex", 0)
	dbfx.Exec(t, "UPDATE agent_runtime SET owner_id=$2, visibility='private', shared_with=ARRAY[$3::uuid] WHERE id=$1", rt, f.outsider, testUserID)
	job := createTestMediaJob(t, &h, protocol.MediaRequest{Provider: "codex", Capability: "image-generate", Prompt: "edit", Inputs: []protocol.MediaInput{{AttachmentID: input}}})
	claim := func() *protocol.MediaAssignment {
		body, _ := json.Marshal(protocol.MediaClaimRequest{RuntimeID: rt})
		status, raw, err := h.DaemonRPCHandler(t.Context(), daemonws.ClientIdentity{UserID: f.outsider, WorkspaceID: testWorkspaceID, RuntimeIDs: []string{rt}}, "media.claim", body)
		if err != nil || status != 200 {
			t.Fatalf("claim: %d %s %v", status, raw, err)
		}
		var result protocol.MediaClaimResponse
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		return result.Assignment
	}
	a := claim()
	if a == nil || a.Job.ID != job.ID {
		t.Fatal("public input not assigned")
	}
	testutil.Call(t, h.DownloadMediaInput, mediaTransferRequest(a, "GET", nil, input)).Want(200)
	dbfx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", f.publicIssue, f.projectID)
	testutil.Call(t, h.DownloadMediaInput, mediaTransferRequest(a, "GET", nil, input)).Want(404)
	dbfx.Exec(t, "UPDATE media_job SET state='queued' WHERE id=$1", job.ID)
	if claim() != nil {
		t.Fatal("runtime sharing granted its owner private project input access")
	}
	addProjectMemberRow(t, f.projectID, f.outsider)
	if claim() == nil {
		t.Fatal("authorized runtime owner could not claim")
	}
}

func TestMediaPrivateProjectTaskPrincipals(t *testing.T) {
	for _, revoked := range []string{"originator", "agent_owner"} {
		t.Run(revoked, func(t *testing.T) {
			f := newPrivateProjectFixture(t)
			addProjectMemberRow(t, f.projectID, f.outsider)
			h := *testHandler
			t.Setenv("LOCAL_UPLOAD_DIR", t.TempDir())
			h.Storage = storage.NewLocalStorageFromEnv()
			input := mediaInputFixture(t, &h, testutil.Cols{"issue_id": f.secretIssue})
			rt := mediaTestRuntime(t, "codex", 0)
			agent := dbfx.Agent(t, "private media producer", rt, testutil.Cols{"owner_id": f.outsider})
			task := dbfx.Task(t, agent, testutil.Cols{"issue_id": f.secretIssue, "runtime_id": rt, "originator_user_id": f.insider, "accountable_user_id": f.insider})
			req := newRequest("POST", "/", protocol.MediaRequest{Capability: "image-generate", Provider: "codex", Prompt: "edit", Inputs: []protocol.MediaInput{{AttachmentID: input}}})
			req.Header.Set("X-Actor-Source", "task_token")
			req.Header.Set("X-Task-ID", task)
			req.Header.Set("X-Agent-ID", agent)
			var job protocol.MediaJob
			testutil.Call(t, h.CreateMediaJob, req).Want(202).JSON(&job)
			dbfx.Cleanup(t, "DELETE FROM media_job WHERE id=$1", job.ID)
			a := claimTestMediaJob(t, &h, rt)
			if a == nil || a.Job.ID != job.ID {
				t.Fatal("authorized task input was not assigned")
			}
			testutil.Call(t, h.DownloadMediaInput, mediaTransferRequest(a, "GET", nil, input)).Want(200)
			user := f.insider
			if revoked == "agent_owner" {
				user = f.outsider
			}
			dbfx.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", f.projectID, user)
			testutil.Call(t, h.DownloadMediaInput, mediaTransferRequest(a, "GET", nil, input)).Want(404)
			dbfx.Exec(t, "UPDATE media_job SET state='queued' WHERE id=$1", job.ID)
			if claimTestMediaJob(t, &h, rt) != nil {
				t.Fatal("privileged task-token user bypassed the revoked run principal")
			}
		})
	}
}
