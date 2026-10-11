CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_ysk_tip_report ON labrastro_issue_tip (workspace_id, task_id, tag, line);
