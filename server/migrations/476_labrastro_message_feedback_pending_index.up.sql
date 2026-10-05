CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_feedback_pending ON labrastro_message_feedback (next_attempt_at, created_at) WHERE acknowledged_at IS NULL;
