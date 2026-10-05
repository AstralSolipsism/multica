CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_comment_scan
ON comment (created_at, id)
WHERE type = 'comment' AND deleted_at IS NULL;
