-- One ACTIVE approval per (workspace, automation, bot, normalized target).
-- Partial on revoked_at so a revoked approval never blocks a fresh grant and
-- the audit history stays queryable.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_labrastro_message_approved_target_active
    ON labrastro_message_approved_target(workspace_id, autopilot_id, installation_id, target_key)
    WHERE revoked_at IS NULL;
