package handler

import (
	"net/http"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/util"
)

// Autopilots and their webhook credentials outlive the request that creates or
// changes them. They do not persist external consent, so even a currently valid
// conversation grant cannot authorize this surface. Ordinary delegated member
// work keeps its existing rights. The auth middleware owns the actor/task headers.
func (h *Handler) autopilotExternalCaller(r *http.Request, workspaceID string) (bool, error) {
	actorType, _ := h.resolveActor(r, requestUserID(r), workspaceID)
	if actorType != "agent" {
		return false, nil
	}
	id, err := util.ParseUUID(r.Header.Get("X-Task-ID"))
	if err != nil {
		// The shared acting-member gate rejects a missing/malformed originator.
		return false, nil
	}
	task, err := h.Queries.GetAgentTask(r.Context(), id)
	if err != nil {
		return false, err
	}
	return task.ConversationRootTaskID.Valid || task.OriginatorSource.String == channel.ConversationOrigin, nil
}
