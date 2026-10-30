-- name: ListGroupedInboxItems :many
-- Keep every active group, with its newest row and newest comment anchor.
-- Joining full rows only after selecting IDs avoids copying historical bodies.
-- No LIMIT: this list must cover the same groups as the unread summary.
WITH active AS MATERIALIZED (
    SELECT i.id, COALESCE(i.issue_id, i.id) AS group_id, i.created_at, i.details
    FROM inbox_item i
    WHERE i.workspace_id = $1 AND i.recipient_type = $2 AND i.recipient_id = $3
      AND i.archived = false
), newest AS (
    SELECT DISTINCT ON (group_id) id
    FROM active
    ORDER BY group_id, created_at DESC, id DESC
), anchors AS (
    SELECT DISTINCT ON (group_id) id
    FROM active
    WHERE NULLIF(details->>'comment_id', '') IS NOT NULL
    ORDER BY group_id, created_at DESC, id DESC
), selected AS (
    SELECT id FROM newest
    UNION
    SELECT id FROM anchors
)
SELECT i.*, iss.status AS issue_status, iss.priority AS issue_priority
FROM inbox_item i
JOIN selected ON selected.id = i.id
LEFT JOIN issue iss ON iss.id = i.issue_id
ORDER BY i.created_at DESC, i.id DESC;
