-- name: GetIssueGraphAccess :one
-- Recheck membership inside the same snapshot as the graph, even if middleware
-- already admitted the request. No workspace metadata is read on a pool here.
SELECT w.issue_prefix, transaction_timestamp()::timestamptz AS captured_at
FROM workspace w JOIN member m ON m.workspace_id = w.id
WHERE w.id = $1 AND m.user_id = $2;

-- name: ListIssueGraphDetails :many
-- Compact display fields only: no descriptions, comments, attachments or logs.
SELECT i.id, i.project_id, i.stage, i.priority, i.assignee_type, i.assignee_id,
       p.title AS project_title
FROM issue i LEFT JOIN project p ON p.id = i.project_id AND p.workspace_id = i.workspace_id
WHERE i.workspace_id = $1 ORDER BY i.id;

-- name: ListIssueGraphRuns :many
-- The same active set as ListActiveTasksByIssue. Count actual rows, independent
-- of the issue's status and assignee, without exposing runtime or log data.
SELECT t.issue_id, t.status, count(*)::bigint AS count
FROM agent_task_queue t JOIN issue i ON i.id = t.issue_id
JOIN agent a ON a.id = t.agent_id AND a.workspace_id = i.workspace_id
WHERE i.workspace_id = $1
  AND t.status IN ('queued', 'dispatched', 'running', 'waiting_local_directory')
GROUP BY t.issue_id, t.status ORDER BY t.issue_id, t.status;
