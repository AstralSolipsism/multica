package handler

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) lookupDownloadAttachment(r *http.Request, attachmentID pgtype.UUID) (db.Attachment, error) {
	if _, external := channel.ConversationTaskFromContext(r.Context()); external {
		// Auth stamps the token's workspace here. The grantor's membership in
		// another workspace cannot widen the external conversation's grant.
		workspaceID, err := util.ParseUUID(r.Header.Get("X-Workspace-ID"))
		if err != nil {
			return db.Attachment{}, err
		}
		return h.Queries.GetAttachment(r.Context(), db.GetAttachmentParams{
			ID: attachmentID, WorkspaceID: workspaceID,
		})
	}
	// Preserve MUL-3130's self-resolving links for first-party credentials.
	return h.Queries.GetAttachmentByIDOnly(r.Context(), attachmentID)
}
