package handler

import (
	"context"
	"errors"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// writeComment is the shared persistence boundary for an already authorized
// actor. q may belong to a caller-owned transaction (for an inbound receipt).
// Transport parsing and actor/originator resolution stay with the caller.
func writeComment(ctx context.Context, q *db.Queries, p db.CreateCommentParams) (db.CreateCommentRow, *db.Comment, error) {
	p.Content = sanitizeNullBytes(p.Content)
	if p.Content == "" || !isClientAuthorableCommentType(p.Type) {
		return db.CreateCommentRow{}, nil, errors.New("invalid comment")
	}
	var root *db.Comment
	if p.ParentID.Valid {
		parent, err := q.GetCommentInWorkspace(ctx, db.GetCommentInWorkspaceParams{ID: p.ParentID, WorkspaceID: p.WorkspaceID})
		if err != nil || parent.IssueID != p.IssueID {
			return db.CreateCommentRow{}, nil, errors.New("invalid parent comment")
		}
		if r, err := q.GetThreadRoot(ctx, db.GetThreadRootParams{CommentID: p.ParentID, WorkspaceID: p.WorkspaceID}); err == nil {
			root = &r
		}
	}
	created, err := q.CreateComment(ctx, p)
	return created, root, err
}

// commentCommitted runs the common post-commit notification and thread actions.
// Agent trigger computation/enqueue remains in triggerTasksForComment so both
// transports use the existing routing, privacy and attribution rules.
func (h *Handler) commentCommitted(ctx context.Context, issue db.Issue, comment db.Comment, root *db.Comment, resp CommentResponse) {
	authorID := uuidToString(comment.AuthorID)
	h.publish(protocol.EventCommentCreated, uuidToString(issue.WorkspaceID), comment.AuthorType, authorID, map[string]any{
		"comment":             resp,
		"issue_title":         issue.Title,
		"issue_assignee_type": textToPtr(issue.AssigneeType),
		"issue_assignee_id":   uuidToPtr(issue.AssigneeID),
		"issue_status":        issue.Status,
		"issue_revision":      resp.IssueRevision,
	})
	h.TaskService.AutoUnresolveThreadOnReply(ctx, root, uuidToString(issue.WorkspaceID), comment.AuthorType, authorID)
}
