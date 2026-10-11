CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_ysk_state_identity ON labrastro_issue_tip_state (workspace_id, tip_id, user_id);
