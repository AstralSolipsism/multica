-- User-scoped subscription quota sources (OL-1205 scenario 3). All access is
-- owner-scoped in application code (id AND owner_id); no FKs by house rule.

-- name: CreateQuotaSource :one
INSERT INTO quota_source (
    owner_id, kind, name, base_url, credential_ciphertext, credential_hint,
    enabled, visibility, snapshot, last_polled_at, next_poll_at
) VALUES (
    @owner_id, @kind, @name, @base_url, @credential_ciphertext, @credential_hint,
    @enabled, @visibility, @snapshot, @last_polled_at, @next_poll_at
)
RETURNING *;

-- name: GetQuotaSourceForOwner :one
-- Owner fence: a non-owner (including admins) sees 404, never a row.
SELECT * FROM quota_source
WHERE id = @id AND owner_id = @owner_id;

-- name: ListQuotaSourcesByOwner :many
SELECT * FROM quota_source
WHERE owner_id = @owner_id
ORDER BY created_at ASC;

-- name: ListDueQuotaSources :many
-- Poll targets: enabled sources whose backoff window has elapsed.
SELECT * FROM quota_source
WHERE enabled AND next_poll_at <= @now
ORDER BY next_poll_at ASC
LIMIT @max_sources;

-- name: UpdateQuotaSourceFields :execrows
-- Partial update; NULL fields leave the stored value. Returns rows=0 when the
-- id does not exist under this owner.
UPDATE quota_source SET
    updated_at = now(),
    name = COALESCE(sqlc.narg('name'), name),
    base_url = COALESCE(sqlc.narg('base_url'), base_url),
    credential_ciphertext = COALESCE(sqlc.narg('credential_ciphertext'), credential_ciphertext),
    credential_hint = COALESCE(sqlc.narg('credential_hint'), credential_hint),
    enabled = COALESCE(sqlc.narg('enabled'), enabled),
    visibility = COALESCE(sqlc.narg('visibility'), visibility)
WHERE id = @id AND owner_id = @owner_id;

-- name: ApplyQuotaSourcePollSuccess :execrows
-- Fail-soft poll outcome: store the snapshot, clear the failure counters,
-- schedule the next regular interval. now() (server clock) rather than a
-- passed timestamp: sqlc's named-param rewriter chokes on `secs => @param`
-- next to another @arg.
UPDATE quota_source SET
    snapshot = @snapshot,
    last_polled_at = now(),
    last_error_code = NULL,
    last_error_message = NULL,
    consecutive_failures = 0,
    next_poll_at = now() + make_interval(secs => @next_poll_secs::double precision),
    updated_at = now()
WHERE id = @id;

-- name: ApplyQuotaSourcePollFailure :execrows
-- Keep the previous snapshot; record the error and the caller-computed
-- backoff deadline (base << consecutive_failures, capped).
UPDATE quota_source SET
    last_polled_at = now(),
    last_error_code = sqlc.narg('last_error_code'),
    last_error_message = sqlc.narg('last_error_message'),
    consecutive_failures = consecutive_failures + 1,
    next_poll_at = @next_poll_at,
    updated_at = now()
WHERE id = @id;

-- name: MarkQuotaSourcePolled :execrows
-- A manual refresh that produced no write still moves the poll clock so the
-- cooldown reflects reality.
UPDATE quota_source SET last_polled_at = now(), updated_at = now()
WHERE id = @id;

-- name: SetQuotaSourceNextPollAt :execrows
-- Re-arm polling after a config edit (probe passed, enabled flipped, ...).
UPDATE quota_source SET next_poll_at = @next_poll_at, updated_at = now()
WHERE id = @id;

-- name: DeleteQuotaSource :execrows
DELETE FROM quota_source WHERE id = @id AND owner_id = @owner_id;

-- name: CountQuotaSourcesByOwner :one
SELECT count(*)::int FROM quota_source WHERE owner_id = @owner_id;

-- name: ListVisibleQuotaSourcesForWorkspace :many
-- Workspace read model (OL-1205 final baseline). A source is visible to the
-- member when:
--   * it is theirs (owners always see their own cards), OR
--   * visibility = 'shared' AND the owner has at least one runtime visible
--     to this member in this workspace ("follows machine visibility": the
--     card only appears where the owner actually shares machines).
-- Strict ListVisibleAgentRuntimes semantics — the admin governance widening
-- in ListAgentRuntimes deliberately does NOT apply here.
SELECT qs.*
FROM quota_source qs
WHERE qs.owner_id = @member_id
   OR (
        qs.visibility = 'shared'
        AND EXISTS (
            SELECT 1 FROM agent_runtime ar
            WHERE ar.workspace_id = @workspace_id
              AND ar.owner_id = qs.owner_id
              AND (ar.visibility = 'public'
                   OR (ar.visibility = 'private' AND @member_id = ANY(ar.shared_with)))
        )
      )
ORDER BY qs.created_at ASC;
