package handler

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// deleteCommentWithFeedback retains the receipt tombstone and removes copied
// text/anchors in the same transaction as the existing comment deletion.
func (h *Handler) deleteCommentWithFeedback(ctx context.Context, issueID pgtype.UUID, p db.DeleteCommentParams) (db.DeleteCommentRow, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.DeleteCommentRow{}, err
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	deleted, err := q.DeleteComment(ctx, p)
	if err != nil {
		return deleted, err
	}
	if deleted.Changed {
		if err := q.RedactLabrastroFeedbackByComment(ctx, db.RedactLabrastroFeedbackByCommentParams{WorkspaceID: p.WorkspaceID, CommentID: p.ID, IssueID: issueID}); err != nil {
			return deleted, err
		}
	}
	return deleted, tx.Commit(ctx)
}
