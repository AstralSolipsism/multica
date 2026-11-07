-- Repair pre-9540 Default snapshots without changing named workflow boundaries.
-- Keep active custom statuses used by Default issues, even if a named workflow
-- also includes them. Insert before the fixed tail, as issueworkflow.Arrange does.
WITH additions AS (
    SELECT wf.id,
           jsonb_agg(jsonb_build_object('status_key', s.key, 'handler',
                     jsonb_build_object('type', 'none')) ORDER BY s.position, s.key) AS steps
    FROM issue_workflow wf
    JOIN issue_status s ON s.workspace_id = wf.workspace_id
    WHERE wf.is_default AND NOT s.is_system AND s.archived_at IS NULL
      AND NOT wf.steps @> jsonb_build_array(jsonb_build_object('status_key', s.key))
      AND (
          NOT EXISTS (
              SELECT 1 FROM issue_workflow named
              WHERE named.workspace_id = wf.workspace_id AND NOT named.is_default
                AND named.steps @> jsonb_build_array(jsonb_build_object('status_key', s.key))
          )
          OR EXISTS (
              SELECT 1 FROM issue i
              WHERE i.workspace_id = wf.workspace_id AND i.status = s.key
                AND (i.project_id IS NULL OR EXISTS (
                    SELECT 1 FROM project p
                    WHERE p.id = i.project_id AND p.workspace_id = wf.workspace_id AND p.workflow_id IS NULL
                ))
          )
      )
    GROUP BY wf.id
), repaired AS (
    SELECT wf.id,
           COALESCE(parts.before_tail, '[]'::jsonb) || additions.steps ||
           COALESCE(parts.tail, '[]'::jsonb) AS steps
    FROM issue_workflow wf
    JOIN additions ON additions.id = wf.id
    CROSS JOIN LATERAL (
        SELECT COALESCE(min(ord), jsonb_array_length(wf.steps) + 1) AS ordinal
        FROM jsonb_array_elements(wf.steps) WITH ORDINALITY AS step(value, ord)
        WHERE value->>'status_key' IN ('blocked', 'done', 'cancelled')
    ) boundary
    CROSS JOIN LATERAL (
        SELECT jsonb_agg(value ORDER BY ord) FILTER (WHERE ord < boundary.ordinal) AS before_tail,
               jsonb_agg(value ORDER BY ord) FILTER (WHERE ord >= boundary.ordinal) AS tail
        FROM jsonb_array_elements(wf.steps) WITH ORDINALITY AS step(value, ord)
    ) parts
)
UPDATE issue_workflow wf
SET steps = repaired.steps, updated_at = now()
FROM repaired
WHERE wf.id = repaired.id;
