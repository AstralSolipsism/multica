CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_ysk_tip_anchor ON labrastro_issue_tip (workspace_id, anchor_comment_id) WHERE anchor_comment_id IS NOT NULL;
