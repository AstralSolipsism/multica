CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_inbox_scan
ON inbox_item (created_at, id)
WHERE recipient_type = 'member';
