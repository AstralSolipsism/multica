CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_feedback_comment ON labrastro_message_feedback (comment_id) WHERE comment_id IS NOT NULL;
