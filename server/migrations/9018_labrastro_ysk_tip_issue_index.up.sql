CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_ysk_tip_issue ON labrastro_issue_tip (workspace_id, issue_id, created_at DESC, id);
