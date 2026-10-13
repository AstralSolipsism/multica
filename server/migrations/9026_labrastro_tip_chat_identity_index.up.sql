CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_tip_chat_identity ON labrastro_tip_chat (workspace_id, user_id, tip_id);
