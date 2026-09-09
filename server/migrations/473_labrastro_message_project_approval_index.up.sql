CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_labrastro_message_approved_target_project_active
    ON labrastro_message_approved_target (workspace_id, source_kind, installation_id, target_key, project_id)
    NULLS NOT DISTINCT
    WHERE source_kind IN ('activity', 'comment') AND revoked_at IS NULL;
