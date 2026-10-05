CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_activity_scan
ON activity_log (created_at, id)
WHERE action IN ('status_changed', 'assignee_changed');
