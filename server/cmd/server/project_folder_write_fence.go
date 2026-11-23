package main

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/util"
)

// Project folders carry no foreign key between project.folder_id and
// project_folder: upstream 681 maintains the reference by clearing filed
// projects in the delete transaction, and the filing statement reads the
// folder it names with its own snapshot, so a filing racing a folder deletion
// can commit a folder_id the delete already removed. server/ee stays
// byte-identical to upstream, so the host serializes the write kinds here:
// one advisory lock per workspace, held for the whole request, makes a filing
// either finish before the delete's clear (which then drops it) or see the
// folder gone (the handler's 400). The workspace, not the folder, is the key
// because a filing names its folder only inside the request body, and folder
// writes are rare and human-paced, so per-workspace is fine.
const (
	projectFolderWriteLockSQL   = "SELECT pg_advisory_lock(hashtext('labrastro:project-folder-writes'), hashtext($1))"
	projectFolderWriteUnlockSQL = "SELECT pg_advisory_unlock(hashtext('labrastro:project-folder-writes'), hashtext($1))"
)

// projectFolderWriteFence serializes project-folder write requests per
// workspace; reads pass straight through. Mounting nothing (an -tags oss
// build) leaves it inert.
func projectFolderWriteFence(h *handler.Handler, pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			// An unresolvable workspace is the handler's own 400 to answer;
			// pass it through unfenced.
			workspaceID := h.WorkspaceID(r)
			if _, err := util.ParseUUID(workspaceID); err != nil {
				next.ServeHTTP(w, r)
				return
			}
			conn, err := pool.Acquire(r.Context())
			if err != nil {
				handler.WriteError(w, http.StatusInternalServerError, "failed to serialize project folder writes")
				return
			}
			defer conn.Release()
			if _, err := conn.Exec(r.Context(), projectFolderWriteLockSQL, workspaceID); err != nil {
				handler.WriteError(w, http.StatusInternalServerError, "failed to serialize project folder writes")
				return
			}
			defer func() {
				// The request context is done by now; the unlock still has to
				// run to hand the lock to the next writer. A failed unlock on
				// a broken connection is fine: the session dies with it and
				// Postgres releases the advisory lock.
				_, _ = conn.Exec(context.Background(), projectFolderWriteUnlockSQL, workspaceID)
			}()
			next.ServeHTTP(w, r)
		})
	}
}
