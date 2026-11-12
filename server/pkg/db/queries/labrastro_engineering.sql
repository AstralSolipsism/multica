-- name: LabrastroLockEngineeringProject :one
-- Serializes wiki writes, configuration changes and project deletion.
SELECT * FROM project WHERE workspace_id = $1 AND id = $2 FOR UPDATE;

-- name: LabrastroReadEngineeringProject :one
SELECT * FROM project WHERE workspace_id = $1 AND id = $2 FOR SHARE;

-- name: LabrastroLockEngineeringMember :one
SELECT * FROM member WHERE workspace_id = $1 AND user_id = $2 FOR SHARE;

-- name: LabrastroGetEngineering :one
SELECT * FROM project_engineering WHERE workspace_id = $1 AND project_id = $2;

-- name: LabrastroPutEngineering :one
INSERT INTO project_engineering (workspace_id, project_id, enabled, current_stage, mode_summary,
    decider_member_ids, updated_by_type, updated_by_id, stages)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (workspace_id, project_id) DO UPDATE SET
    enabled = EXCLUDED.enabled, current_stage = EXCLUDED.current_stage, mode_summary = EXCLUDED.mode_summary,
    decider_member_ids = EXCLUDED.decider_member_ids, stages = EXCLUDED.stages,
    updated_by_type = EXCLUDED.updated_by_type, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()
RETURNING *;

-- name: LabrastroListBaselinePages :many
SELECT * FROM project_baseline_page WHERE workspace_id = $1 AND project_id = $2
    ORDER BY parent_id NULLS FIRST, position, created_at, id;

-- name: LabrastroLockBaselinePage :one
SELECT * FROM project_baseline_page WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE;

-- name: LabrastroSetBaselinePage :exec
UPDATE project_baseline_page SET parent_id = $4, position = $5, archived_at = $6, updated_at = now()
WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroSetBaselinePagePosition :exec
UPDATE project_baseline_page SET position = $4, updated_at = now()
WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroRenameBaselinePage :exec
UPDATE project_baseline_page SET title = $4, slug = $5, updated_at = now()
WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroAllocateBaselineRevisionNumber :one
-- The page-row allocator keeps numbers monotonic under the project lock and
-- never reuses numbers from rolled-back transactions.
UPDATE project_baseline_page SET last_revision_number = last_revision_number + 1, updated_at = now()
WHERE workspace_id = $1 AND project_id = $2 AND id = $3
RETURNING last_revision_number;

-- name: LabrastroCreateBaselinePage :one
INSERT INTO project_baseline_page (workspace_id, project_id, parent_id, slug, title, position,
    current_revision_id, last_revision_number, archived_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *;

-- name: LabrastroCreateBaselineWikiRevision :one
INSERT INTO project_baseline_revision (workspace_id, project_id, page_id, revision_number, revision_kind,

    title, slug, parent_id, position, archived_at, content_markdown, change_summary,
    base_revision_id, restored_from_revision_id, source_issue_id, created_by_type, created_by_id, created_by_task_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *;

-- name: LabrastroListBaselineRevisionsByID :many
-- Loads the current revision of every page in one round trip.
SELECT * FROM project_baseline_revision WHERE workspace_id = $1 AND project_id = $2 AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: LabrastroSetBaselineCurrentRevision :exec
UPDATE project_baseline_page SET current_revision_id = $4, updated_at = now()
WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroGetBaselineRevisionByNumber :one
SELECT * FROM project_baseline_revision WHERE workspace_id = $1 AND project_id = $2
    AND page_id = $3 AND revision_number = $4;

-- name: LabrastroGetBaselineRevision :one
SELECT * FROM project_baseline_revision WHERE workspace_id = $1 AND project_id = $2 AND id = $3;

-- name: LabrastroListBaselineWikiRevisions :many
SELECT * FROM project_baseline_revision WHERE workspace_id = $1 AND project_id = $2 AND page_id = $3
    AND (sqlc.narg('before_number')::int IS NULL OR revision_number < sqlc.narg('before_number'))
ORDER BY revision_number DESC LIMIT sqlc.arg('page_limit');

-- name: LabrastroListBaselineWikiRevisionSummaries :many
-- Same page as LabrastroListBaselineWikiRevisions without detoasting page bodies.
SELECT id, workspace_id, project_id, page_id, revision_number, revision_kind, title, slug, parent_id,
    position, archived_at, ''::text AS content_markdown, change_summary, base_revision_id,
    restored_from_revision_id, source_issue_id, created_by_type, created_by_id, created_by_task_id, created_at
FROM project_baseline_revision WHERE workspace_id = $1 AND project_id = $2 AND page_id = $3
    AND (sqlc.narg('before_number')::int IS NULL OR revision_number < sqlc.narg('before_number'))
ORDER BY revision_number DESC LIMIT sqlc.arg('page_limit');

-- name: LabrastroListBaselineRevisionsBetween :many
-- The half-open (base, current] window drives orthogonal auto-rebase checks.
SELECT * FROM project_baseline_revision WHERE workspace_id = $1 AND project_id = $2 AND page_id = $3
    AND revision_number > $4 AND revision_number <= $5 ORDER BY revision_number;

-- name: LabrastroListBaselinePageBodies :many
-- Current content of every unarchived page; feeds the WikiIndex symbol table.
SELECT p.id AS page_id, p.slug, p.title, r.revision_number, r.content_markdown
FROM project_baseline_page p
JOIN project_baseline_revision r ON r.id = p.current_revision_id
WHERE p.workspace_id = $1 AND p.project_id = $2 AND p.archived_at IS NULL
ORDER BY p.parent_id NULLS FIRST, p.position, p.created_at, p.id;

-- name: LabrastroCountBaselinePageRevisions :many
SELECT page_id, count(*)::int AS revision_count FROM project_baseline_revision
WHERE workspace_id = $1 AND project_id = $2 GROUP BY page_id;

-- name: LabrastroBaselineActivity :many
SELECT r.page_id, p.slug, p.title, r.id AS revision_id, r.revision_number, r.revision_kind,
    r.change_summary, r.source_issue_id, r.created_by_type, r.created_by_id, r.created_at
FROM project_baseline_revision r
JOIN project_baseline_page p ON p.id = r.page_id
WHERE r.workspace_id = $1 AND r.project_id = $2
    AND (sqlc.narg('before_time')::timestamptz IS NULL OR r.created_at < sqlc.narg('before_time'))
ORDER BY r.created_at DESC, r.id DESC LIMIT sqlc.arg('page_limit');

-- name: LabrastroSearchBaselinePages :many
SELECT p.id AS page_id, p.slug, p.title, r.revision_number, r.content_markdown
FROM project_baseline_page p
JOIN project_baseline_revision r ON r.id = p.current_revision_id
WHERE p.workspace_id = $1 AND p.project_id = $2 AND p.archived_at IS NULL
    AND (strpos(lower(p.title), sqlc.arg('query')) > 0 OR strpos(lower(r.content_markdown), sqlc.arg('query')) > 0)
ORDER BY p.parent_id NULLS FIRST, p.position, p.created_at, p.id
LIMIT sqlc.arg('page_limit');

-- name: LabrastroBaselineRelatedIssues :many
WITH sources AS (
    SELECT r.source_issue_id AS id, max(r.created_at) AS at FROM project_baseline_revision r
    WHERE r.workspace_id = $1 AND r.project_id = $2 AND r.page_id = $3 AND r.source_issue_id IS NOT NULL
    GROUP BY r.source_issue_id ORDER BY at DESC, id LIMIT 20
), carriers AS (
    SELECT t.issue_id AS id, max(t.updated_at) AS at FROM project_baseline_thread t
    WHERE t.workspace_id = $1 AND t.project_id = $2 AND t.page_id = $3 AND t.issue_id IS NOT NULL
    GROUP BY t.issue_id ORDER BY at DESC, id LIMIT 20
), related AS (
    SELECT id, max(at) AS at FROM (SELECT * FROM sources UNION ALL SELECT * FROM carriers) refs GROUP BY id
)
SELECT i.id, i.number, i.title, i.status FROM related r JOIN issue i ON i.id = r.id
WHERE i.workspace_id = $1 AND i.project_id = $2 ORDER BY r.at DESC, i.id;

-- name: LabrastroBaselineOpenIssues :many
SELECT i.id, i.title, i.status, i.number, i.assignee_type, i.assignee_id
FROM issue i WHERE i.workspace_id = $1 AND i.project_id = $2 AND i.status = ANY(sqlc.arg('status_keys')::text[])
ORDER BY i.created_at, i.id LIMIT 201;

-- name: LabrastroDeleteProjectEngineering :exec
WITH comments AS (DELETE FROM project_baseline_comment WHERE workspace_id = $1 AND project_id = $2),
threads AS (DELETE FROM project_baseline_thread WHERE workspace_id = $1 AND project_id = $2),
revisions AS (DELETE FROM project_baseline_revision WHERE project_baseline_revision.workspace_id = $1 AND project_baseline_revision.project_id = $2),
pages AS (DELETE FROM project_baseline_page WHERE project_baseline_page.workspace_id = $1 AND project_baseline_page.project_id = $2)
DELETE FROM project_engineering WHERE project_engineering.workspace_id = $1 AND project_engineering.project_id = $2;

-- name: LabrastroDeleteWorkspaceEngineering :exec
WITH comments AS (DELETE FROM project_baseline_comment WHERE workspace_id = $1),
threads AS (DELETE FROM project_baseline_thread WHERE workspace_id = $1),
revisions AS (DELETE FROM project_baseline_revision WHERE project_baseline_revision.workspace_id = $1),
pages AS (DELETE FROM project_baseline_page WHERE project_baseline_page.workspace_id = $1)
DELETE FROM project_engineering WHERE project_engineering.workspace_id = $1;
