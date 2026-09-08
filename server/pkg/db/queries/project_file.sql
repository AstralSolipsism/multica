-- name: LockProjectFileProject :one
SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE;

-- name: AuthorizeProjectFileMember :one
SELECT m.id FROM member m
JOIN "user" u ON u.id = m.user_id
JOIN project p ON p.workspace_id = m.workspace_id
WHERE p.id = $1 AND p.workspace_id = $2 AND m.user_id = $3
FOR SHARE OF m, u;

-- name: AuthorizeProjectFilePAT :one
SELECT id FROM personal_access_token
WHERE token_hash = $1 AND user_id = $2 AND revoked = false
AND (expires_at IS NULL OR expires_at > clock_timestamp())
FOR SHARE;

-- name: AuthorizeProjectFileRun :one
SELECT t.issue_id, t.chat_session_id FROM task_token tok
JOIN agent_task_queue t ON t.id = tok.task_id AND t.agent_id = tok.agent_id
JOIN agent a ON a.id = tok.agent_id AND a.workspace_id = tok.workspace_id
WHERE tok.token_hash = $1 AND tok.user_id = $2
  AND tok.workspace_id = $3 AND tok.agent_id = $4 AND tok.task_id = $5
  AND tok.expires_at > clock_timestamp()
  AND t.status IN ('running', 'dispatched') AND t.completed_at IS NULL
  AND a.archived_at IS NULL
FOR SHARE OF tok, t, a;

-- name: AuthorizeProjectFileIssue :one
SELECT id FROM issue WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR SHARE;

-- name: AuthorizeProjectFileChat :one
SELECT id FROM chat_session WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR SHARE;

-- name: GetProjectFileOperation :one
SELECT * FROM project_file_operation
WHERE workspace_id = $1 AND project_id = $2 AND actor_type = $3 AND actor_id = $4 AND operation_key = $5;

-- name: CreateProjectFileOperation :one
INSERT INTO project_file_operation (workspace_id, project_id, actor_type, actor_id, operation_key, request)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;

-- name: CompleteProjectFileOperation :execrows
UPDATE project_file_operation SET result = $4, completed_at = clock_timestamp()
WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND result IS NULL;

-- name: CreateProjectFileUpload :one
INSERT INTO project_file_upload (id, workspace_id, project_id, operation_id, object_key)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: FinishProjectFileUpload :execrows
UPDATE project_file_upload SET state = $4, updated_at = clock_timestamp()
WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND state = 'pending';

-- name: GetProjectFile :one
SELECT * FROM project_file WHERE workspace_id = $1 AND project_id = $2 AND path = $3;

-- name: FindProjectFilePathCollision :one
SELECT id FROM project_file
WHERE workspace_id = $1 AND project_id = $2
AND (path = ANY(sqlc.arg('ancestors')::text[]) OR starts_with(path, sqlc.arg('descendant_prefix')::text))
LIMIT 1;

-- name: CreateProjectFile :one
INSERT INTO project_file (workspace_id, project_id, path) VALUES ($1, $2, $3) RETURNING *;

-- name: AdvanceProjectFile :execrows
UPDATE project_file SET revision = revision + 1, current_version_id = $5, updated_at = clock_timestamp()
WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND revision = $4;

-- name: CreateProjectFileVersion :one
INSERT INTO project_file_version (workspace_id, project_id, file_id, revision, base_revision,
    object_key, size_bytes, sha256, content_type, author_type, author_id, source_task_id, operation_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *;

-- name: CreateProjectFileCandidate :one
INSERT INTO project_file_candidate (workspace_id, project_id, file_id, version_id)
VALUES ($1, $2, $3, $4) RETURNING *;

-- name: ResolveProjectFileCandidate :execrows
UPDATE project_file_candidate SET resolved_at = clock_timestamp(), resolved_by_operation_id = $4
WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND resolved_at IS NULL;

-- name: ListProjectFiles :many
SELECT f.id, f.path, f.revision, v.base_revision, v.id AS version_id, v.size_bytes, v.sha256, v.content_type,
       v.author_type, v.author_id, v.source_task_id, f.updated_at
FROM project_file f JOIN project_file_version v ON v.id = f.current_version_id
  AND v.file_id = f.id AND v.workspace_id = f.workspace_id AND v.project_id = f.project_id
WHERE f.workspace_id = $1 AND f.project_id = $2
  AND starts_with(f.path, sqlc.arg('prefix')::text) AND f.path > sqlc.arg('after_path')::text
ORDER BY f.path LIMIT sqlc.arg('page_limit')::int;

-- name: ReadProjectFile :one
SELECT f.path, v.* FROM project_file f
JOIN project_file_version v ON v.file_id = f.id AND v.workspace_id = f.workspace_id AND v.project_id = f.project_id
WHERE f.workspace_id = $1 AND f.project_id = $2 AND f.path = $3
  AND ((sqlc.narg('revision')::bigint IS NULL AND v.id = f.current_version_id)
       OR v.revision = sqlc.narg('revision')::bigint);

-- name: GetProjectFileCandidate :one
SELECT c.id AS candidate_id, c.resolved_at, f.path, v.* FROM project_file_candidate c
JOIN project_file f ON f.id = c.file_id AND f.workspace_id = c.workspace_id AND f.project_id = c.project_id
JOIN project_file_version v ON v.id = c.version_id AND v.file_id = f.id
  AND v.workspace_id = c.workspace_id AND v.project_id = c.project_id
WHERE c.workspace_id = $1 AND c.project_id = $2 AND c.id = $3;

-- name: ListProjectFileCandidates :many
SELECT c.id AS candidate_id, f.path, v.id AS version_id, v.file_id, v.base_revision,
       v.size_bytes, v.sha256, v.content_type, v.author_type, v.author_id, v.source_task_id, c.created_at
FROM project_file_candidate c
JOIN project_file f ON f.id = c.file_id AND f.workspace_id = c.workspace_id AND f.project_id = c.project_id
JOIN project_file_version v ON v.id = c.version_id AND v.file_id = f.id
  AND v.workspace_id = c.workspace_id AND v.project_id = c.project_id
WHERE c.workspace_id = $1 AND c.project_id = $2 AND f.path = $3 AND c.resolved_at IS NULL
  AND c.id > sqlc.arg('after_id')::uuid
ORDER BY c.id LIMIT sqlc.arg('page_limit')::int;
