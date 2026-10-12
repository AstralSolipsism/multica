CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_ysk_topic_identity ON labrastro_known_topic (workspace_id, user_id, topic);
