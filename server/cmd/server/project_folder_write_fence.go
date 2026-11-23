package main

import (
	"net/http"

	"github.com/google/uuid"

	"github.com/multica-ai/multica/server/internal/advisorylock"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/util"
)

// projectFolderLockKeySpace keeps folder-write locks off the seat-capacity
// lock keys.
const projectFolderLockKeySpace = "labrastro:project-folder-writes:"

// Project folders carry no foreign key between project.folder_id and
// project_folder: upstream 681 maintains the reference by clearing filed
// projects in the delete transaction, and the filing statement reads the
// folder it names with its own snapshot, so a filing racing a folder deletion
// can commit a folder_id the delete already removed. server/ee stays
// byte-identical to upstream, so the host serializes the write kinds here:
// the advisory lock makes a filing either finish before the delete's clear
// (which then drops it) or see the folder gone (the handler's 400). The
// workspace, not the folder, is the key because a filing names its folder
// only inside the request body; writes are rare and human-paced, so
// per-workspace is fine. The locker queues same-process waiters without a
// connection and bounds the ones it pins, so the fence cannot starve the
// pool the handlers themselves draw from.
func projectFolderWriteFence(h *handler.Handler, locker *advisorylock.Locker) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			if locker == nil {
				// A router built without a pool (the CORS contract probe)
				// mounts no working folder routes to fence.
				next.ServeHTTP(w, r)
				return
			}
			// The lock keys on the parsed UUID, so every spelling of the
			// workspace id a request carries shares one lock. An unparseable
			// workspace is the handler's own 400 to answer; pass it through
			// unfenced.
			wsUUID, err := util.ParseUUID(h.WorkspaceID(r))
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			_, release, err := locker.Lock(r.Context(), uuid.UUID(wsUUID.Bytes))
			if err != nil {
				handler.WriteError(w, http.StatusServiceUnavailable, "project folder writes are busy; retry")
				return
			}
			defer release()
			next.ServeHTTP(w, r)
		})
	}
}
