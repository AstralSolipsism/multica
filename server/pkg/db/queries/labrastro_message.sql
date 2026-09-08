-- =====================
-- Labrastro message delivery (OL-25)
-- =====================
-- SQL is the only source for this module's reads and writes; the generated
-- code under pkg/db/generated is rebuilt with `make sqlc` and never edited.

-- =====================
-- labrastro_message_route
-- =====================

-- name: CreateLabrastroMessageRoute :one
INSERT INTO labrastro_message_route (
    id, workspace_id, autopilot_id, installation_id, channel_type,
    target_type, target_user_id, target_chat_id, target_message_id,
    target_thread_id, target_key, conditions, content_mode,
    enabled, revision, created_by, updated_by, effective_from
) VALUES (
    $1, $2, $3, $4, $5,
    $6, sqlc.narg('target_user_id'), sqlc.narg('target_chat_id'),
    sqlc.narg('target_message_id'), sqlc.narg('target_thread_id'),
    $7, $8, $9,
    $10, 1, $11, $11, now()
) RETURNING *;

-- name: GetLabrastroMessageRoute :one
-- Workspace-scoped: a route id from another workspace is not found.
SELECT * FROM labrastro_message_route
WHERE id = $1 AND workspace_id = $2;

-- name: ListLabrastroMessageRoutesByAutopilot :many
SELECT * FROM labrastro_message_route
WHERE workspace_id = $1 AND autopilot_id = $2
ORDER BY created_at, id;

-- name: ListEnabledLabrastroMessageRoutesByAutopilot :many
-- The enqueue decision set: only enabled rules decide, and only for runs
-- completing at or after the rule's effective_from boundary.
SELECT * FROM labrastro_message_route
WHERE workspace_id = $1 AND autopilot_id = $2 AND enabled = true
ORDER BY created_at, id;

-- name: UpdateLabrastroMessageRoute :one
-- Revision-guarded edit: the WHERE clause carries the revision the caller
-- read, so a stale save conflicts (zero rows) instead of silently
-- overwriting a newer edit. Config edits never rewrite deliveries already
-- decided — those hold frozen snapshots.
UPDATE labrastro_message_route
SET installation_id = sqlc.arg('installation_id'),
    channel_type = sqlc.arg('channel_type'),
    target_type = sqlc.arg('target_type'),
    target_user_id = sqlc.narg('target_user_id'),
    target_chat_id = sqlc.narg('target_chat_id'),
    target_message_id = sqlc.narg('target_message_id'),
    target_thread_id = sqlc.narg('target_thread_id'),
    target_key = sqlc.arg('target_key'),
    conditions = sqlc.arg('conditions'),
    content_mode = sqlc.arg('content_mode'),
    enabled = sqlc.arg('enabled'),
    revision = revision + 1,
    updated_by = sqlc.arg('updated_by'),
    updated_at = now(),
    -- Enabling through an edit restarts the eligibility boundary with the
    -- same semantics as an explicit enable: no backfill of the disabled
    -- window. Staying enabled keeps the existing boundary.
    effective_from = CASE
        WHEN sqlc.arg('enabled')::boolean AND NOT enabled THEN now()
        ELSE effective_from
    END
WHERE id = sqlc.arg('id')
  AND workspace_id = sqlc.arg('workspace_id')
  AND revision = sqlc.arg('expected_revision')
RETURNING *;

-- name: SetLabrastroMessageRouteEnabled :one
-- Enable/disable with revision bump. Disable keeps history; the queued
-- deliveries are cancelled by the service layer. Enable resets
-- effective_from so the disabled window is never backfilled.
UPDATE labrastro_message_route
SET enabled = sqlc.arg('enabled'),
    revision = revision + 1,
    updated_by = sqlc.arg('updated_by'),
    updated_at = now(),
    effective_from = CASE
        WHEN sqlc.arg('enabled')::boolean THEN now()
        ELSE effective_from
    END
WHERE id = sqlc.arg('id')
  AND workspace_id = sqlc.arg('workspace_id')
  AND revision = sqlc.arg('expected_revision')
RETURNING *;

-- name: DeleteLabrastroMessageRoute :exec
DELETE FROM labrastro_message_route
WHERE id = $1 AND workspace_id = $2;

-- =====================
-- labrastro_message_delivery
-- =====================

-- name: CreateLabrastroMessageDelivery :many
-- The decision insert. ON CONFLICT DO NOTHING against
-- uq_labrastro_message_delivery_dedup is the exactly-once guard: two
-- replicas deciding the same (source, target) race safely, the loser sees
-- zero rows. Empty result means a decision already exists.
INSERT INTO labrastro_message_delivery (
    id, workspace_id, route_id, route_revision, autopilot_id, run_id,
    dedup_key, source_kind, status, content_snapshot, target_snapshot,
    shard_total, source_ref, target_key, installation_id, error_code
) VALUES (
    $1, $2, sqlc.narg('route_id'), sqlc.narg('route_revision'), $3,
    sqlc.narg('run_id'), $4, $5, $6, $7, $8, $9, sqlc.narg('source_ref'),
    $10, $11, sqlc.narg('error_code')
)
ON CONFLICT (dedup_key) DO NOTHING
RETURNING *;

-- name: GetLabrastroMessageDelivery :one
SELECT * FROM labrastro_message_delivery
WHERE id = $1 AND workspace_id = $2;

-- name: ClaimDueLabrastroMessageDelivery :one
-- Claims one due delivery. SKIP LOCKED distributes the queue across
-- workers and replicas; the lease token makes a crashed claim visible to
-- the expiry sweep. The lease is a scheduling optimization, not the
-- exactly-once guard — the fixed per-shard send UUID and the receipt
-- ledger carry that.
WITH candidate AS (
    SELECT id
    FROM labrastro_message_delivery
    WHERE status = 'queued'
      AND next_attempt_at <= now()
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    ORDER BY next_attempt_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE labrastro_message_delivery AS d
SET status = 'sending',
    lease_token = gen_random_uuid(),
    lease_expires_at = now() + interval '2 minutes',
    first_attempt_at = COALESCE(first_attempt_at, now()),
    updated_at = now()
FROM candidate
WHERE d.id = candidate.id
RETURNING d.*;

-- name: RetryClaimedLabrastroMessageDelivery :one
-- Transient send failure: back off and requeue under the same lease guard.
UPDATE labrastro_message_delivery
SET status = 'queued',
    next_attempt_at = sqlc.arg('next_attempt_at'),
    attempts = attempts + 1,
    error_code = sqlc.narg('error_code'),
    last_error = sqlc.narg('last_error'),
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')
  AND lease_token = sqlc.arg('lease_token')
  AND status = 'sending'
RETURNING *;

-- name: CompleteClaimedLabrastroMessageDelivery :one
-- Every shard accepted with receipts recorded.
UPDATE labrastro_message_delivery
SET status = 'sent',
    delivered_at = now(),
    attempts = attempts + 1,
    error_code = NULL,
    last_error = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')
  AND lease_token = sqlc.arg('lease_token')
  AND status = 'sending'
RETURNING *;

-- name: FailClaimedLabrastroMessageDelivery :one
-- Definitive failure under the lease guard: bad target, revoked
-- installation, exhausted attempts. error_code is stable and
-- machine-readable; last_error carries the human explanation.
UPDATE labrastro_message_delivery
SET status = 'failed',
    attempts = attempts + 1,
    error_code = sqlc.narg('error_code'),
    last_error = sqlc.narg('last_error'),
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')
  AND lease_token = sqlc.arg('lease_token')
  AND status = 'sending'
RETURNING *;

-- name: CancelClaimedLabrastroMessageDelivery :one
-- Pre-send gate refused (route disabled/deleted, source archived/missing)
-- while the claim was held. Recorded as a decision, not an error.
UPDATE labrastro_message_delivery
SET status = 'cancelled',
    error_code = sqlc.narg('error_code'),
    last_error = sqlc.narg('last_error'),
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')
  AND lease_token = sqlc.arg('lease_token')
  AND status = 'sending'
RETURNING *;

-- name: UncertainClaimedLabrastroMessageDelivery :one
-- Same transition without the attempts increment, for a worker that
-- classified an ambiguous HTTP outcome while still holding its lease.
UPDATE labrastro_message_delivery
SET status = 'uncertain',
    error_code = sqlc.narg('error_code'),
    last_error = sqlc.narg('last_error'),
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')
  AND lease_token = sqlc.arg('lease_token')
  AND status = 'sending'
RETURNING *;

-- name: RequeueExpiredLabrastroMessageDeliveryClaims :many
-- Crash recovery for claims whose worker died mid-send. The lease lapsed
-- while the row was 'sending', so the HTTP call may or may not have left
-- this process — the row goes to 'uncertain', not 'queued'. Bounded by
-- the same unique send UUID as manual retries.
UPDATE labrastro_message_delivery
SET status = 'uncertain',
    error_code = sqlc.narg('error_code'),
    last_error = sqlc.narg('last_error'),
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE status = 'sending'
  AND lease_expires_at <= now()
RETURNING *;

-- name: SetLabrastroMessageDeliveryOutcome :one
-- Terminal write for a SYNCHRONOUS send that never entered the lease queue
-- (manual test sends). Status-guarded on 'sending' so a row can never be
-- flipped twice by two racing writers.
UPDATE labrastro_message_delivery
SET status = sqlc.arg('status'),
    delivered_at = CASE
        WHEN sqlc.arg('status')::text = 'sent' THEN now()
        ELSE delivered_at
    END,
    attempts = attempts + 1,
    error_code = sqlc.narg('error_code'),
    last_error = sqlc.narg('last_error'),
    updated_at = now()
WHERE id = sqlc.arg('id')
  AND status = 'sending'
RETURNING *;

-- name: RetryLabrastroMessageDeliveryManually :one
-- Operator verify-and-retry. Allowed from 'failed' (cause fixed) and
-- 'uncertain' (operator checked; the fixed send UUID keeps the retry
-- idempotent inside the platform's dedup window). A zero-row result is a
-- status that is not retryable, or a lost race with a worker.
UPDATE labrastro_message_delivery
SET status = 'queued',
    next_attempt_at = now(),
    error_code = sqlc.narg('error_code'),
    last_error = sqlc.narg('last_error'),
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')
  AND workspace_id = sqlc.arg('workspace_id')
  AND status IN ('failed', 'uncertain')
RETURNING *;

-- name: CancelLabrastroMessageDeliveriesByRoute :many
-- Route disabled or deleted: cancel sends that have not started. Sends the
-- platform already received cannot be recalled; their records stay.
UPDATE labrastro_message_delivery
SET status = 'cancelled',
    error_code = sqlc.narg('error_code'),
    last_error = sqlc.narg('last_error'),
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE route_id = sqlc.arg('route_id')
  AND status = 'queued'
RETURNING *;

-- name: CancelLabrastroMessageDeliveriesByInstallation :many
-- The bot was disconnected/revoked: stop everything this installation had
-- not started yet. The worker's own installation re-check covers the race
-- where a claim lands between revoke and this sweep.
UPDATE labrastro_message_delivery
SET status = 'cancelled',
    error_code = sqlc.narg('error_code'),
    last_error = sqlc.narg('last_error'),
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE installation_id = sqlc.arg('installation_id')
  AND workspace_id = sqlc.arg('workspace_id')
  AND status = 'queued'
RETURNING *;

-- name: ListLabrastroMessageDeliveriesByAutopilot :many
-- Records API projection. content_snapshot / target_snapshot / source_ref
-- are deliberately excluded — a page of deliveries must not carry full
-- message bodies or target snapshots just to render a status list.
SELECT
    d.id, d.workspace_id, d.route_id, d.route_revision, d.autopilot_id,
    d.run_id, d.dedup_key, d.source_kind, d.status, d.attempts,
    d.next_attempt_at, d.error_code, d.last_error, d.shard_total,
    d.delivered_at, d.first_attempt_at, d.created_at, d.updated_at,
    d.installation_id, d.target_key
FROM labrastro_message_delivery d
WHERE d.workspace_id = sqlc.arg('workspace_id')
  AND d.autopilot_id = sqlc.arg('autopilot_id')
  AND (sqlc.narg('status')::text IS NULL OR d.status = sqlc.narg('status')::text)
ORDER BY d.created_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- =====================
-- labrastro_message_receipt
-- =====================

-- name: ClaimLabrastroMessageReceipt :one
-- Creates the receipt row for one shard on FIRST attempt, or returns the
-- existing row. The send_uuid is written once and never changes, so a
-- retry replays the identical idempotency key. DO UPDATE (not DO NOTHING)
-- so the fixed row comes back either way.
INSERT INTO labrastro_message_receipt (
    delivery_id, workspace_id, installation_id,
    shard_index, shard_total, send_uuid
) VALUES (
    sqlc.arg('delivery_id'), sqlc.arg('workspace_id'),
    sqlc.arg('installation_id'), sqlc.arg('shard_index'),
    sqlc.arg('shard_total'), sqlc.arg('send_uuid')
)
ON CONFLICT (delivery_id, shard_index) DO UPDATE SET
    updated_at = now()
RETURNING *;

-- name: RecordLabrastroMessageReceiptExternalID :one
-- First external id wins. A duplicate-accepted retry response must not
-- overwrite the id the platform first reported.
UPDATE labrastro_message_receipt
SET external_message_id = sqlc.arg('external_message_id'),
    updated_at = now()
WHERE id = sqlc.arg('id')
  AND external_message_id IS NULL
RETURNING *;

-- name: ListLabrastroMessageReceiptsByDelivery :many
SELECT * FROM labrastro_message_receipt
WHERE delivery_id = sqlc.arg('delivery_id')
  AND workspace_id = sqlc.arg('workspace_id')
ORDER BY shard_index;

-- =====================
-- Compensation scan
-- =====================

-- name: ListLabrastroMessageDeliveryCandidateRoutes :many
-- (run, route) pairs where the run reached a terminal state inside the
-- route's eligibility window but the normalized target still has NO
-- delivery decision. Suppressed/cancelled decisions count — a source the
-- module has already judged is never re-decided. Full-missing-set scan by
-- design: a monotonic cursor would skip runs that committed late, so the
-- NOT EXISTS shrinking set IS the cursor.
SELECT
    r.id AS run_id, r.autopilot_id, a.workspace_id AS run_workspace_id,
    r.status AS run_status, r.completed_at AS run_completed_at,
    r.issue_id AS run_issue_id, r.task_id AS run_task_id,
    r.result AS run_result, r.failure_reason AS run_failure_reason,
    r.reason_code AS run_reason_code,
    a.execution_mode AS autopilot_execution_mode, a.title AS autopilot_title,
    rt.id AS route_id, rt.revision AS route_revision,
    rt.installation_id, rt.channel_type,
    rt.target_type, rt.target_user_id, rt.target_chat_id,
    rt.target_message_id, rt.target_thread_id, rt.target_key,
    rt.conditions, rt.content_mode
FROM autopilot_run r
JOIN autopilot a ON a.id = r.autopilot_id
JOIN labrastro_message_route rt
  ON rt.autopilot_id = r.autopilot_id
 AND rt.workspace_id = a.workspace_id
 AND rt.enabled = true
WHERE r.status IN ('completed', 'failed', 'skipped')
  AND r.completed_at >= rt.effective_from
  AND NOT EXISTS (
      SELECT 1 FROM labrastro_message_delivery d
      WHERE d.run_id = r.id
        AND d.installation_id = rt.installation_id
        AND d.target_key = rt.target_key
  )
ORDER BY r.completed_at, r.id, rt.id
LIMIT sqlc.arg('limit');

-- name: ListStaleRunOnlyAutopilotTasks :many
-- Tasks whose run_only automation has not reached a terminal run state even
-- though the task itself is terminal — the event the run sync listens for
-- was lost. The scanner feeds these to the EXISTING SyncRunFromTask logic;
-- this module runs no state machine of its own.
SELECT t.* FROM agent_task_queue t
JOIN autopilot_run r ON r.id = t.autopilot_run_id
JOIN autopilot a ON a.id = r.autopilot_id
WHERE a.execution_mode = 'run_only'
  AND r.status IN ('pending', 'issue_created', 'running')
  AND t.status IN ('completed', 'failed', 'cancelled')
ORDER BY t.completed_at NULLS LAST, t.id
LIMIT sqlc.arg('limit');

-- name: ListStaleCreateIssueAutopilotIssues :many
-- Issues whose create_issue automation run never saw the terminal
-- transition. No status filter here on purpose: custom statuses inherit
-- canonical terminal states through Effective() inside SyncRunFromIssue,
-- and this query cannot see that mapping. The non-terminal run join keeps
-- the candidate set small; a non-terminal issue is a harmless no-op sync.
SELECT i.* FROM issue i
JOIN autopilot_run r ON r.issue_id = i.id
JOIN autopilot a ON a.id = r.autopilot_id
WHERE a.execution_mode = 'create_issue'
  AND r.status IN ('pending', 'issue_created', 'running')
ORDER BY i.updated_at, i.id
LIMIT sqlc.arg('limit');

-- =====================
-- Member binding (installation-precise)
-- =====================

-- name: GetChannelUserBindingForDelivery :one
-- Resolves a member target through ONE pinned installation. Deliberately
-- NOT FindChannelBindingForMember: that query picks the most recent
-- binding per channel_type, which picks the wrong bot when a workspace runs
-- several installations of the same channel (OL-24 §4.2). The join re-checks
-- the installation row is still active so a revoked bot never resolves.
SELECT b.* FROM channel_user_binding b
JOIN channel_installation ci ON ci.id = b.installation_id
WHERE b.workspace_id = sqlc.arg('workspace_id')
  AND b.installation_id = sqlc.arg('installation_id')
  AND b.multica_user_id = sqlc.arg('multica_user_id')
  AND b.channel_type = ci.channel_type
  AND ci.status = 'active';

-- =====================
-- Workspace teardown
-- =====================

-- name: DeleteLabrastroMessageReceiptsByWorkspace :exec
DELETE FROM labrastro_message_receipt
WHERE workspace_id = $1;

-- name: DeleteLabrastroMessageDeliveriesByWorkspace :exec
DELETE FROM labrastro_message_delivery
WHERE workspace_id = $1;

-- name: DeleteLabrastroMessageRoutesByWorkspace :exec
DELETE FROM labrastro_message_route
WHERE workspace_id = $1;
