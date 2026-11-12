-- name: LabrastroListBaselineThreads :many
SELECT * FROM project_baseline_thread WHERE workspace_id = $1 AND project_id = $2 AND page_id = $3
ORDER BY updated_at DESC, id;

-- name: LabrastroGetBaselineThread :one
SELECT * FROM project_baseline_thread WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroLockBaselineThread :one
SELECT * FROM project_baseline_thread WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE;

-- name: LabrastroCreateBaselineThread :one
INSERT INTO project_baseline_thread (workspace_id, project_id, page_id, anchor_kind, section_anchor, section_title,
    quote_exact, quote_prefix, quote_suffix, quote_start, anchor_revision_number, issue_id, created_by_type, created_by_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *;

-- name: LabrastroBindBaselineThread :exec
UPDATE project_baseline_thread SET issue_id = $4 WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroTouchBaselineThread :exec
UPDATE project_baseline_thread SET updated_at = now() WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroResolveBaselineThread :exec
UPDATE project_baseline_thread SET resolved_at = $4, resolved_by_type = $5, resolved_by_id = $6, updated_at = now()
WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroDeleteEmptyBaselineThread :exec
DELETE FROM project_baseline_thread t WHERE t.workspace_id = $1 AND t.project_id = $2 AND t.id = $3
AND NOT EXISTS (SELECT 1 FROM project_baseline_comment c WHERE c.workspace_id = t.workspace_id AND c.project_id = t.project_id AND c.thread_id = t.id);

-- name: LabrastroListBaselineComments :many
SELECT * FROM project_baseline_comment WHERE workspace_id = $1 AND project_id = $2 AND thread_id = ANY(sqlc.arg('thread_ids')::uuid[])
ORDER BY created_at, id;

-- name: LabrastroGetBaselineComment :one
SELECT * FROM project_baseline_comment WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroCreateBaselineComment :one
INSERT INTO project_baseline_comment (workspace_id, project_id, thread_id, body_markdown, author_type, author_id, author_task_id)
VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;

-- name: LabrastroEditBaselineComment :exec
UPDATE project_baseline_comment SET body_markdown = $4, edited_at = now() WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroDeleteBaselineComment :exec
DELETE FROM project_baseline_comment WHERE workspace_id = $1 AND project_id = $2 AND id = $3;
