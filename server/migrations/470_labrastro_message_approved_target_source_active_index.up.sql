-- OL-27: one ACTIVE team approval per (workspace, source kind, bot, target).
-- The OL-25 active index keys on autopilot_id and cannot dedupe rows whose
-- autopilot_id is NULL (Postgres treats NULLs as distinct); this partial
-- index covers the team kinds. A revoked approval never blocks a fresh
-- grant; re-approving inserts a new active row.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_labrastro_message_approved_target_source_active
    ON labrastro_message_approved_target (workspace_id, source_kind, installation_id, target_key)
    WHERE revoked_at IS NULL AND source_kind IN ('activity', 'comment');
