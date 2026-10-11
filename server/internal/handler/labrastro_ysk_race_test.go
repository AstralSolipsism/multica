package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func yskAssertBlockedRequest(t *testing.T, tx pgx.Tx, handler http.HandlerFunc, r *http.Request, afterBlocked func(), wantStatus int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	done := make(chan struct{})
	var status int
	go func() {
		defer close(done)
		w := httptest.NewRecorder()
		handler(w, r.WithContext(ctx))
		status = w.Code
	}()
	// A failed blocking assertion must release the transaction and join the
	// writer before fixture cleanup, including when running mutation probes.
	defer func() {
		_ = tx.Rollback(context.Background())
		cancel()
		<-done
	}()
	if !waitForWaiterBlockedBy(t, holderBackendPID(t, ctx, tx), 10*time.Second) {
		t.Fatal("YSK writer did not wait for cleanup's owning lock")
	}
	afterBlocked()
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		if status != wantStatus {
			t.Fatalf("writer returned %d, want %d", status, wantStatus)
		}
	case <-ctx.Done():
		t.Fatal("YSK writer did not finish after cleanup committed")
	}
}

func TestLabrastroYSKStateWriteWaitsForIssueDeletion(t *testing.T) {
	f := newYSKFixture(t)
	id := f.tip(t, "do not leave orphan state")
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := f.h.Queries.WithTx(tx)
	if _, err = q.LockIssueForDelete(ctx, db.LockIssueForDeleteParams{WorkspaceID: parseUUID(f.WorkspaceID), ID: parseUUID(f.issue)}); err != nil {
		t.Fatal(err)
	}
	if err = q.LabrastroYSKDeleteIssue(ctx, db.LabrastroYSKDeleteIssueParams{WorkspaceID: parseUUID(f.WorkspaceID), IssueID: parseUUID(f.issue)}); err != nil {
		t.Fatal(err)
	}
	yskAssertBlockedRequest(t, tx, f.h.LabrastroSetTipState, f.request("POST", map[string]any{"state": "known"}, "tipId", id), func() {
		if _, err = tx.Exec(ctx, `DELETE FROM issue WHERE id=$1`, f.issue); err != nil {
			t.Fatal(err)
		}
	}, 404)
	if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip_state WHERE workspace_id=$1`, f.WorkspaceID) != 0 ||
		f.Count(t, `SELECT count(*) FROM labrastro_known_topic WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
		t.Fatal("state write left personal data after issue deletion")
	}
}

func TestLabrastroYSKReportWaitsForWorkspaceDeletion(t *testing.T) {
	f := newYSKFixture(t)
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := f.h.Queries.WithTx(tx)
	if _, err = q.LockWorkspaceForDelete(ctx, parseUUID(f.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if err = q.LabrastroYSKDeleteWorkspace(ctx, parseUUID(f.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	r := f.request("POST", labrastroYSKReport{Version: 1, Kind: "light", Step: 1, Tips: []labrastroYSKInputTip{yskInput("do not leave orphan tips")}}, "taskId", f.task)
	yskAssertBlockedRequest(t, tx, f.h.LabrastroReportTaskTips, r, func() {
		if _, err = tx.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, f.WorkspaceID); err != nil {
			t.Fatal(err)
		}
	}, 404)
	if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
		t.Fatal("report left orphan tips after workspace deletion")
	}
}

func TestLabrastroYSKStateWriteWaitsForWorkspaceDeletion(t *testing.T) {
	f := newYSKFixture(t)
	id := f.tip(t, "do not leave orphan personal data")
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := f.h.Queries.WithTx(tx)
	if _, err = q.LockWorkspaceForDelete(ctx, parseUUID(f.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if err = q.LabrastroYSKDeleteWorkspace(ctx, parseUUID(f.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	yskAssertBlockedRequest(t, tx, f.h.LabrastroSetTipState, f.request("POST", map[string]any{"state": "known"}, "tipId", id), func() {
		if _, err = tx.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, f.WorkspaceID); err != nil {
			t.Fatal(err)
		}
	}, 404)
	if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip_state WHERE workspace_id=$1`, f.WorkspaceID) != 0 ||
		f.Count(t, `SELECT count(*) FROM labrastro_known_topic WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
		t.Fatal("state write left personal data after workspace deletion")
	}
}
