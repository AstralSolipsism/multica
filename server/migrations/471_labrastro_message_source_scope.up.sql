-- Freeze authorization independently of delivery purpose (notably test_send).
ALTER TABLE labrastro_message_delivery
    ADD COLUMN source_scope TEXT DEFAULT 'run',
    ADD COLUMN source_project_id UUID;
ALTER TABLE labrastro_message_approved_target ADD COLUMN project_id UUID;
ALTER TABLE labrastro_message_route ADD COLUMN last_disabled_at TIMESTAMPTZ;

UPDATE labrastro_message_delivery d
SET source_scope = CASE
    WHEN d.source_kind IN ('inbox', 'activity', 'comment') THEN d.source_kind
    WHEN d.source_kind = 'test_send' AND d.autopilot_id IS NULL THEN (
        SELECT r.source_kind FROM labrastro_message_route r
        WHERE r.id = d.route_id AND r.workspace_id = d.workspace_id
    )
    ELSE 'run'
END;

-- Preview approvals expressed only workspace-wide consent. Do not infer a
-- historical project grant from a mutable route. Preserve audit/dedup rows,
-- withdraw old consent, and require explicit team approval + re-enable.
UPDATE labrastro_message_approved_target
SET revoked_at = now()
WHERE source_kind IN ('activity', 'comment') AND revoked_at IS NULL;
UPDATE labrastro_message_delivery
SET status = 'cancelled', error_code = 'route_authorization_lost',
    last_error = 'source scope upgrade requires fresh authorization',
    lease_token = NULL, lease_expires_at = NULL, updated_at = now()
WHERE autopilot_id IS NULL
  AND source_kind IN ('inbox', 'activity', 'comment', 'test_send')
  AND status IN ('queued', 'sending', 'failed', 'uncertain');
UPDATE labrastro_message_route
SET enabled = CASE WHEN source_kind = 'inbox' THEN enabled ELSE false END,
    effective_from = clock_timestamp(), last_disabled_at = clock_timestamp(),
    revision = revision + 1, updated_at = now()
WHERE source_kind <> 'run';

ALTER TABLE labrastro_message_delivery
    ADD CONSTRAINT labrastro_message_delivery_scope_shape CHECK (
        (source_scope = 'run' AND autopilot_id IS NOT NULL AND source_project_id IS NULL
            AND source_kind IN ('run_only', 'create_issue', 'test_send', 'unknown'))
        OR (source_scope = 'inbox' AND autopilot_id IS NULL AND source_project_id IS NULL
            AND source_kind IN ('inbox', 'test_send'))
        OR (source_scope IN ('activity', 'comment') AND autopilot_id IS NULL
            AND source_kind IN (source_scope, 'test_send'))
        OR (source_scope IS NULL AND autopilot_id IS NULL AND source_kind = 'test_send'
            AND status IN ('sent', 'cancelled', 'suppressed'))
    ),
    ADD CONSTRAINT labrastro_message_delivery_scope_known CHECK (
        source_scope IS NOT NULL OR (source_kind = 'test_send' AND status IN ('sent', 'cancelled', 'suppressed'))
    );
ALTER TABLE labrastro_message_approved_target
    ADD CONSTRAINT labrastro_message_approved_target_project_shape
    CHECK (source_kind IN ('activity', 'comment') OR project_id IS NULL);
