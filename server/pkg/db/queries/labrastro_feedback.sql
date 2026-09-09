-- name: GetLabrastroFeedbackReceipt :one
SELECT * FROM labrastro_message_receipt
WHERE installation_id = $1 AND external_message_id = $2 AND workspace_id = $3;

-- name: GetLabrastroFeedback :one
SELECT * FROM labrastro_message_feedback
WHERE installation_id = $1 AND inbound_message_id = $2;

-- name: LockLabrastroFeedback :one
SELECT * FROM labrastro_message_feedback
WHERE installation_id = $1 AND inbound_message_id = $2
FOR UPDATE;

-- name: CreateLabrastroFeedback :one
INSERT INTO labrastro_message_feedback (
    installation_id, inbound_message_id, workspace_id, delivery_id, quoted_message_id,
    sender_id, user_id, installation_agent_id, chat_id, thread_id, content, kind,
    issue_id, parent_comment_id, comment_id, issue_revision, status, notice
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
ON CONFLICT (installation_id, inbound_message_id) DO NOTHING
RETURNING *;

-- name: ListLabrastroPendingFeedback :many
SELECT * FROM labrastro_message_feedback
WHERE acknowledged_at IS NULL AND next_attempt_at <= now()
ORDER BY next_attempt_at, created_at LIMIT 20;

-- name: CompleteLabrastroFeedback :one
UPDATE labrastro_message_feedback
SET status = $3, notice = $4, chat_session_id = $5, updated_at = now()
WHERE installation_id = $1 AND inbound_message_id = $2
RETURNING *;

-- name: AttachLabrastroFeedbackComment :exec
UPDATE labrastro_message_feedback SET comment_id = $3, issue_revision = $4
WHERE installation_id = $1 AND inbound_message_id = $2 AND status = 'pending';

-- name: RejectLabrastroPendingFeedback :exec
UPDATE labrastro_message_feedback SET status = 'rejected', notice = $3, updated_at = now()
WHERE installation_id = $1 AND inbound_message_id = $2 AND status = 'pending';

-- name: AcknowledgeLabrastroFeedback :exec
UPDATE labrastro_message_feedback SET acknowledged_at = now(), updated_at = now()
WHERE installation_id = $1 AND inbound_message_id = $2 AND status <> 'pending';

-- name: RetryLabrastroFeedback :exec
UPDATE labrastro_message_feedback SET next_attempt_at = now() + interval '30 seconds', updated_at = now()
WHERE installation_id = $1 AND inbound_message_id = $2 AND acknowledged_at IS NULL;

-- name: LockLabrastroFeedbackMember :one
SELECT * FROM member WHERE workspace_id = $1 AND user_id = $2 FOR SHARE;

-- name: LockLabrastroFeedbackBinding :one
SELECT * FROM channel_user_binding
WHERE workspace_id = $1 AND installation_id = $2 AND channel_user_id = $3 FOR SHARE;

-- name: LockLabrastroFeedbackParent :one
SELECT * FROM comment WHERE workspace_id = $1 AND issue_id = $2 AND id = $3 FOR SHARE;

-- name: LockLabrastroFeedbackInvocationTargets :many
SELECT * FROM agent_invocation_target WHERE agent_id = $1 FOR SHARE;

-- name: IsPendingLabrastroFeedbackComment :one
SELECT EXISTS (SELECT 1 FROM labrastro_message_feedback WHERE comment_id = $1 AND status = 'pending');

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
WHERE workspace_id = $1 AND (comment_id = $2 OR parent_comment_id = $2);
