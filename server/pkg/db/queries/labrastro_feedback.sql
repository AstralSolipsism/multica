-- name: GetLabrastroFeedbackReceipt :one
SELECT * FROM labrastro_message_receipt
WHERE installation_id = $1 AND external_message_id = $2 AND workspace_id = $3;

-- name: GetLabrastroFeedback :one
SELECT * FROM labrastro_message_feedback
WHERE installation_id = $1 AND inbound_message_id = $2;

-- name: IsRetiredLabrastroFeedbackComment :one
SELECT EXISTS (SELECT 1 FROM labrastro_message_feedback WHERE comment_id = $1 AND (status = 'pending' OR (status = 'rejected' AND notice LIKE 'Legacy feedback retired;%')));

-- name: DeleteLabrastroFeedbackByWorkspace :exec
DELETE FROM labrastro_message_feedback WHERE workspace_id = $1;

-- name: RedactLabrastroFeedbackByIssue :exec
-- Keep the inbound identity tombstone: deleting it would permit a replay to
-- recreate a comment after the source was removed.
UPDATE labrastro_message_feedback
SET content = '', issue_id = NULL, parent_comment_id = NULL, comment_id = NULL,
    status = 'rejected', notice = '任务已删除，无法回填。', updated_at = now()
WHERE workspace_id = $1 AND issue_id = ANY($2::uuid[]);

-- name: RedactLabrastroFeedbackByComment :exec
UPDATE labrastro_message_feedback
SET content = '', parent_comment_id = NULL, comment_id = NULL,
    status = 'rejected', notice = '评论已删除，无法回填。', updated_at = now()
WHERE labrastro_message_feedback.workspace_id = $1 AND labrastro_message_feedback.issue_id = $3
  AND (labrastro_message_feedback.comment_id = $2 OR labrastro_message_feedback.parent_comment_id = $2
    -- The existing comment FK may have cascaded through deeper descendants.
    -- This query runs after DeleteComment, with its issue lock still held.
    OR (labrastro_message_feedback.comment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comment c WHERE c.id = labrastro_message_feedback.comment_id))
    OR (labrastro_message_feedback.parent_comment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comment c WHERE c.id = labrastro_message_feedback.parent_comment_id)));
