package handler

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestMediaExpiredTerminalJobsRemainUnchanged(t *testing.T) {
	for _, state := range []string{"completed", "cancelled", "failed"} {
		for _, action := range []string{"get", "cancel", "claim"} {
			t.Run(state+"/"+action, func(t *testing.T) {
				job := createTestMediaJob(t, testHandler, protocol.MediaRequest{Provider: "codex", Capability: "image-generate", Prompt: "image"})
				message := ""
				if state == "failed" {
					message = "provider failed"
				}
				dbfx.Exec(t, "UPDATE media_job SET state=$2,error=$3 WHERE id=$1", job.ID, state, message)
				attachmentID := ""
				if state == "completed" {
					attachmentID = dbfx.Insert(t, "attachment", testutil.Cols{
						"workspace_id": testWorkspaceID, "uploader_type": "member", "uploader_id": testUserID,
						"filename": "completed.png", "content_type": "image/png", "size_bytes": 1, "url": "/uploads/completed.png",
					})
					dbfx.Exec(t, "UPDATE media_job SET attachment_id=$2 WHERE id=$1", job.ID, attachmentID)
				}
				var before protocol.MediaJob
				testutil.Call(t, testHandler.GetMediaJob, withURLParam(newRequest(http.MethodGet, "/", nil), "id", job.ID)).Want(200).JSON(&before)
				if before.State != state || before.Error != message || before.AttachmentID != attachmentID ||
					(state == "completed" && (before.MarkdownURL == "" || before.Markdown == "")) {
					t.Fatalf("invalid terminal fixture: %+v", before)
				}
				if state == "completed" && (strings.Contains(before.MarkdownURL, "/uploads/") || !strings.Contains(before.MarkdownURL, "/api/attachments/"+attachmentID+"/download")) {
					t.Fatalf("legacy upload URL must resolve through authenticated attachment download: %s", before.MarkdownURL)
				}
				dbfx.Exec(t, "UPDATE media_job SET expires_at=now()-interval '1 second' WHERE id=$1", job.ID)
				if action == "claim" {
					rt := mediaTestRuntime(t, "codex", 0)
					if claim := claimTestMediaJob(t, testHandler, rt); claim != nil {
						t.Fatalf("terminal job was assigned: %+v", claim)
					}
				}
				method, handler := http.MethodGet, testHandler.GetMediaJob
				if action == "cancel" {
					method, handler = http.MethodPost, testHandler.CancelMediaJob
				}
				var after protocol.MediaJob
				testutil.Call(t, handler, withURLParam(newRequest(method, "/", nil), "id", job.ID)).Want(200).JSON(&after)
				if after.State != before.State || after.Error != before.Error || after.AttachmentID != before.AttachmentID ||
					after.MarkdownURL != before.MarkdownURL || after.Markdown != before.Markdown {
					t.Fatalf("expired terminal job changed: before=%+v after=%+v", before, after)
				}
				stored, err := testHandler.Queries.GetMediaJob(t.Context(), db.GetMediaJobParams{ID: parseUUID(job.ID), WorkspaceID: parseUUID(testWorkspaceID)})
				if err != nil || stored.State != state || stored.Error != message || uuidToString(stored.AttachmentID) != attachmentID {
					t.Fatalf("terminal state was not preserved in storage: %+v, %v", stored, err)
				}
			})
		}
	}
}

func TestMediaGetDoesNotWaitForOtherExpiredJob(t *testing.T) {
	rt := mediaTestRuntime(t, "codex", 0)
	request := protocol.MediaRequest{Provider: "codex", Capability: "image-generate", Prompt: "image"}
	other := createTestMediaJob(t, testHandler, request)
	target := createTestMediaJob(t, testHandler, request)
	dbfx.Exec(t, "UPDATE media_job SET expires_at=now()-interval '1 second' WHERE id=$1", other.ID)
	tx, err := testPool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(t.Context(), "SELECT id FROM media_job WHERE id=$1 FOR UPDATE", other.ID); err != nil {
		t.Fatal(err)
	}
	req := withURLParam(newRequest("GET", "/", nil), "id", target.ID)
	ctx, cancel := context.WithTimeout(req.Context(), time.Second)
	defer cancel()
	var got protocol.MediaJob
	testutil.Call(t, testHandler.GetMediaJob, req.WithContext(ctx)).Want(200).JSON(&got)
	if got.ID != target.ID || got.State != "queued" {
		t.Fatalf("unexpected target: %+v", got)
	}
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	claim := claimTestMediaJob(t, testHandler, rt)
	if claim == nil || claim.Job.ID != target.ID {
		t.Fatal("claim did not select the live target")
	}
	row, err := testHandler.Queries.GetMediaJob(t.Context(), db.GetMediaJobParams{ID: parseUUID(other.ID), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil || row.State != "failed" || row.Error != "job deadline exceeded" {
		t.Fatalf("claim did not expire the other job: %+v, %v", row, err)
	}
}

type mediaQueryTrace struct {
	mu     sync.Mutex
	counts map[string]int
}

func (tr *mediaQueryTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if name, _, ok := strings.Cut(strings.TrimPrefix(data.SQL, "-- name: "), " "); ok {
		tr.mu.Lock()
		tr.counts[name]++
		tr.mu.Unlock()
	}
	return ctx
}

func (*mediaQueryTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestMediaIdleClaimQueryBudget(t *testing.T) {
	for _, tc := range []struct {
		name       string
		metadata   string
		wantQueued int
	}{
		{"empty queue", `{"capabilities":["media-image-codex-v1"]}`, 1},
		{"no capability", `{"capabilities":[]}`, 0},
		{"cooldown", `{"capabilities":["media-image-codex-v1"],"media_cooldowns":{"media-image-codex-v1":4102444800}}`, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rt := mediaTestRuntime(t, "codex", 0)
			dbfx.Exec(t, "UPDATE agent_runtime SET metadata=$2 WHERE id=$1", rt, tc.metadata)
			if tc.wantQueued == 0 {
				createTestMediaJob(t, testHandler, protocol.MediaRequest{Provider: "codex", Capability: "image-generate", Prompt: "waiting"})
			}
			trace := &mediaQueryTrace{counts: make(map[string]int)}
			cfg := testPool.Config()
			cfg.ConnConfig.Tracer = trace
			pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			h := *testHandler
			h.Queries, h.TxStarter = db.New(pool), pool
			if claim := claimTestMediaJob(t, &h, rt); claim != nil {
				t.Fatalf("unexpected assignment: %+v", claim)
			}
			trace.mu.Lock()
			defer trace.mu.Unlock()
			for name, want := range map[string]int{
				"QueuedMediaJobs":        tc.wantQueued,
				"AvailableMediaRuntimes": 0,
				"SettleMediaRuntimeJobs": 1,
				"ExpireMediaJobs":        1,
			} {
				if got := trace.counts[name]; got != want {
					t.Errorf("%s executed %d times, want %d", name, got, want)
				}
			}
		})
	}
}

func TestMediaModelRejectedBeforeJobCreation(t *testing.T) {
	request := protocol.MediaRequest{Provider: "auto", Capability: "image-generate", Prompt: "image", Model: "unsupported-model"}
	dbfx.Cleanup(t, "DELETE FROM media_job WHERE workspace_id=$1 AND request->>'model'=$2", testWorkspaceID, request.Model)
	testutil.Call(t, testHandler.CreateMediaJob, newRequest("POST", "/", request)).Want(400)
	var count int
	dbfx.QueryRow(t, "SELECT count(*) FROM media_job WHERE workspace_id=$1 AND request->>'model'=$2", testWorkspaceID, request.Model).Scan(&count)
	if count != 0 {
		t.Fatal("unsupported model created a job")
	}
}
