-- name: GetIssueGraphAccess :one
-- Recheck membership inside the same snapshot as the graph, even if middleware
-- already admitted the request. No workspace metadata is read on a pool here.
SELECT w.issue_prefix, transaction_timestamp()::timestamptz AS captured_at
FROM workspace w JOIN member m ON m.workspace_id = w.id
WHERE w.id = $1 AND m.user_id = $2;

-- name: ListIssueGraphIssues :many
SELECT id, parent_issue_id, status, revision, title, number, project_id
FROM issue
WHERE workspace_id = $1 ORDER BY id;

-- name: ListIssueGraphBlockers :one
-- One row of aligned arrays over effective_issue_blocker: the manual
-- issue_blocker rows plus the same-parent stage order, exactly the edges that
-- gate execution. Stage edges are never materialized, so `via` plus the two
-- endpoints is the edge ID.
SELECT coalesce(array_agg(issue_id), '{}')::uuid[] AS issue_ids,
       coalesce(array_agg(blocker_issue_id), '{}')::uuid[] AS blocker_issue_ids,
       coalesce(array_agg(via), '{}')::text[] AS vias
FROM effective_issue_blocker WHERE workspace_id = $1;

-- name: ListIssueGraphWakeupEdges :one
-- Enabled `--until-issue` wakeups, awaited issue -> waiting issue, with the
-- awaited state. Platform-owned rules (system_rule) relate an issue to its own
-- sub-issues, not to another issue. Reads idx_wakeup_workspace_enabled.
SELECT coalesce(array_agg(w.issue_id), '{}')::uuid[] AS waiting_issue_ids,
       coalesce(array_agg((w.condition->>'issue_id')::uuid), '{}')::uuid[] AS target_issue_ids,
       coalesce(array_agg(coalesce(w.condition->>'state', 'done')), '{}')::text[] AS until_states
FROM issue_wakeup w
WHERE w.workspace_id = $1 AND w.enabled AND w.system_rule IS NULL
  AND w.condition->>'type' = 'other_issue'
  AND w.condition->>'issue_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND lower(w.condition->>'issue_id') <> w.issue_id::text;

-- name: ListIssueGraphMentionEdges :one
-- mention://issue/<uuid> in issue descriptions and the newest 20,000 comments
-- that carry one, citing issue -> cited issue. UNION deduplicates; A <-> B and
-- cycles are legal. Endpoint visibility is the service's, not this query's.
-- No content index exists (migrations 454 and 463 retired them), so both
-- branches scan the workspace. Splitting on the literal and checking the 36
-- following characters returns what regexp_matches(..., 'g') would, without
-- compiling that pattern once per row. The comment prefilter stays
-- case-insensitive: it decides which 20,000 comments enter the window.
WITH raw_mentions AS (
  SELECT i.id AS from_issue_id, m.target::uuid AS to_issue_id
  FROM issue i
  CROSS JOIN LATERAL unnest(string_to_array(i.description, 'mention://issue/')) WITH ORDINALITY p(part, n)
  CROSS JOIN LATERAL (SELECT substr(p.part, 1, 36) AS target) m
  WHERE i.workspace_id = $1 AND i.description IS NOT NULL
    AND i.description LIKE '%mention://issue/%' AND p.n > 1
    AND m.target ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  UNION
  SELECT c.issue_id, m.target::uuid
  FROM (
    SELECT issue_id, content
    FROM comment
    WHERE workspace_id = $1 AND deleted_at IS NULL
      AND LOWER(content) LIKE '%mention://issue/%'
    ORDER BY created_at DESC, id DESC
    LIMIT 20000
  ) c
  CROSS JOIN LATERAL unnest(string_to_array(c.content, 'mention://issue/')) WITH ORDINALITY p(part, n)
  CROSS JOIN LATERAL (SELECT substr(p.part, 1, 36) AS target) m
  WHERE p.n > 1
    AND m.target ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
)
SELECT coalesce(array_agg(from_issue_id ORDER BY from_issue_id, to_issue_id), '{}')::uuid[] AS from_issue_ids,
       coalesce(array_agg(to_issue_id ORDER BY from_issue_id, to_issue_id), '{}')::uuid[] AS to_issue_ids
FROM raw_mentions
WHERE from_issue_id <> to_issue_id;

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
