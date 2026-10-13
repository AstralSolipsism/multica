-- name: LabrastroYSKExistingTips :many
SELECT id, tag, line FROM labrastro_issue_tip
WHERE workspace_id = $1 AND issue_id = $2 AND status = 'valid'
ORDER BY created_at, id;

-- name: LabrastroYSKLatestHumanComment :one
SELECT left(content, 500)::text AS content FROM comment
WHERE workspace_id = $1 AND issue_id = $2 AND author_type = 'member' AND deleted_at IS NULL
ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: LabrastroYSKKnownTopics :many
SELECT topic FROM labrastro_known_topic
WHERE workspace_id = $1 AND user_id = $2
ORDER BY updated_at DESC, topic LIMIT 50;

-- name: LabrastroYSKListIssueTips :many
SELECT sqlc.embed(t), s.state AS user_state, s.feedback AS user_feedback,
       s.updated_at AS state_updated_at, i.number AS issue_number
FROM labrastro_issue_tip t
JOIN issue i ON i.id = t.issue_id AND i.workspace_id = t.workspace_id
LEFT JOIN labrastro_issue_tip_state s ON s.workspace_id = t.workspace_id
    AND s.tip_id = t.id AND s.user_id = sqlc.arg(user_id)
WHERE t.workspace_id = sqlc.arg(workspace_id)
  AND t.issue_id = sqlc.arg(issue_id)
  AND (sqlc.arg(include_invalid)::boolean OR t.status = 'valid')
ORDER BY t.created_at DESC, t.id DESC;

-- name: LabrastroYSKListActiveTips :many
WITH running AS MATERIALIZED (
    SELECT DISTINCT q.issue_id FROM agent_task_queue q
    JOIN agent a ON a.id = q.agent_id
    WHERE a.workspace_id = sqlc.arg(workspace_id) AND q.status = 'running'
      AND q.issue_id IS NOT NULL AND q.chat_session_id IS NULL AND q.autopilot_run_id IS NULL
      AND a.kind = 'user' AND a.archived_at IS NULL
)
SELECT sqlc.embed(t), s.state AS user_state, s.feedback AS user_feedback,
       s.updated_at AS state_updated_at, i.number AS issue_number
FROM running r
JOIN labrastro_issue_tip t ON t.workspace_id = sqlc.arg(workspace_id)
    AND t.issue_id = r.issue_id AND t.status = 'valid'
JOIN issue i ON i.id = t.issue_id AND i.workspace_id = t.workspace_id
LEFT JOIN labrastro_issue_tip_state s ON s.workspace_id = t.workspace_id
    AND s.tip_id = t.id AND s.user_id = sqlc.arg(user_id)
ORDER BY t.created_at DESC, t.id DESC;

-- name: LabrastroYSKGetTip :one
SELECT * FROM labrastro_issue_tip WHERE workspace_id = $1 AND id = $2;

-- name: LabrastroYSKLockWorkspace :one
SELECT id FROM workspace WHERE id = $1 FOR KEY SHARE;

-- name: LabrastroYSKLockMember :one
-- Serializes all known-topic writes for this member, across different issues.
SELECT id FROM member WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE;

-- name: LabrastroYSKCreateTip :one
-- The caller holds the issue lock. Duplicate/retried reports consume no quota.
INSERT INTO labrastro_issue_tip (workspace_id, issue_id, task_id, agent_id, anchor_comment_id, tag, line, title, explanation)
SELECT sqlc.arg(workspace_id), sqlc.arg(issue_id), sqlc.arg(task_id), sqlc.arg(agent_id),
       sqlc.narg(anchor_comment_id), sqlc.arg(tag), sqlc.arg(line), sqlc.arg(title), sqlc.arg(explanation)
WHERE (SELECT count(*) FROM labrastro_issue_tip
       WHERE workspace_id = sqlc.arg(workspace_id) AND task_id = sqlc.arg(task_id) AND tag = sqlc.arg(tag))
      < CASE WHEN sqlc.arg(tag)::text = 'heads_up' THEN 1 ELSE 3 END
ON CONFLICT (workspace_id, task_id, tag, line) DO NOTHING
RETURNING *;

-- name: LabrastroYSKOverturnTip :one
UPDATE labrastro_issue_tip
SET status = 'overturned', overturned_by_task_id = sqlc.arg(task_id),
    overturned_by_comment_id = sqlc.narg(comment_id), overturned_reason = sqlc.arg(reason), updated_at = now()
WHERE workspace_id = sqlc.arg(workspace_id) AND issue_id = sqlc.arg(issue_id)
  AND id = sqlc.arg(id) AND status = 'valid' AND task_id <> sqlc.arg(task_id)
RETURNING *;

-- name: LabrastroYSKInvalidateComment :many
UPDATE labrastro_issue_tip SET status = 'source_changed', updated_at = now()
WHERE workspace_id = $1 AND anchor_comment_id = $2 AND status <> 'source_changed'
RETURNING *;

-- name: LabrastroYSKSetState :one
INSERT INTO labrastro_issue_tip_state (workspace_id, tip_id, user_id, state, feedback)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (workspace_id, tip_id, user_id)
DO UPDATE SET state = EXCLUDED.state, feedback = EXCLUDED.feedback, updated_at = now()
RETURNING *;

-- name: LabrastroYSKRememberTopic :exec
INSERT INTO labrastro_known_topic (workspace_id, user_id, topic) VALUES ($1, $2, $3)
ON CONFLICT (workspace_id, user_id, topic) DO UPDATE SET updated_at = now();

-- name: LabrastroYSKPruneTopics :exec
DELETE FROM labrastro_known_topic k
WHERE k.workspace_id = $1 AND k.user_id = $2 AND k.topic IN (
    SELECT k2.topic FROM labrastro_known_topic k2 WHERE k2.workspace_id = $1 AND k2.user_id = $2
    ORDER BY k2.updated_at DESC, k2.topic OFFSET 50
);

-- name: LabrastroYSKDeleteIssue :exec
WITH states AS (
    DELETE FROM labrastro_issue_tip_state s WHERE s.workspace_id = $1
    AND s.tip_id IN (SELECT t.id FROM labrastro_issue_tip t WHERE t.workspace_id = $1 AND t.issue_id = $2)
)
DELETE FROM labrastro_issue_tip t WHERE t.workspace_id = $1 AND t.issue_id = $2;

-- name: LabrastroYSKDeleteWorkspace :exec
WITH chats AS (
    DELETE FROM labrastro_tip_chat WHERE workspace_id = $1
), states AS (
    DELETE FROM labrastro_issue_tip_state s WHERE s.workspace_id = $1
), topics AS (
    DELETE FROM labrastro_known_topic k WHERE k.workspace_id = $1
)
DELETE FROM labrastro_issue_tip t WHERE t.workspace_id = $1;

-- name: LabrastroYSKDeleteMember :exec
WITH chats AS (
    DELETE FROM labrastro_tip_chat WHERE workspace_id = $1 AND user_id = $2
), states AS (
    DELETE FROM labrastro_issue_tip_state s WHERE s.workspace_id = $1 AND s.user_id = $2
)
DELETE FROM labrastro_known_topic k WHERE k.workspace_id = $1 AND k.user_id = $2;
