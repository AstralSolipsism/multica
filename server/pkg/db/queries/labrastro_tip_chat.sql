-- name: LabrastroGetTipChat :one
SELECT * FROM labrastro_tip_chat
WHERE workspace_id = $1 AND user_id = $2 AND tip_id = $3;

-- name: LabrastroSaveTipChat :one
-- Caller serializes opens with LockSubscriberWrites and locks the session
-- before replacing a stale reference. Tasks are not a source of provenance:
-- their chat_session_id is cleared by session deletion.
INSERT INTO labrastro_tip_chat (workspace_id, user_id, tip_id, chat_session_id,
    issue_id, source_task_id, issue_identifier, tip_snapshot)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (workspace_id, user_id, tip_id) DO UPDATE
SET chat_session_id = EXCLUDED.chat_session_id, issue_id = EXCLUDED.issue_id,
    source_task_id = EXCLUDED.source_task_id, issue_identifier = EXCLUDED.issue_identifier,
    tip_snapshot = EXCLUDED.tip_snapshot, created_at = now()
RETURNING *;

-- name: LabrastroListTipChatSources :many
SELECT * FROM labrastro_tip_chat
WHERE workspace_id = $1 AND user_id = $2 AND chat_session_id = ANY(sqlc.arg(session_ids)::uuid[]);

-- name: LabrastroDeleteTipChatSession :exec
DELETE FROM labrastro_tip_chat WHERE chat_session_id = $1;

-- name: LabrastroTipChatAnchorExcerpt :one
SELECT left(content, 500)::text FROM comment
WHERE workspace_id = $1 AND issue_id = $2 AND id = $3 AND deleted_at IS NULL;

-- name: LabrastroChatHasHiddenContext :one
SELECT EXISTS (
    SELECT 1 FROM chat_message WHERE chat_session_id = $1
    AND message_kind IN ('onboarding_kickoff', 'hidden_context')
);
