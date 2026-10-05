CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_labrastro_message_feedback_identity ON labrastro_message_feedback (installation_id, inbound_message_id);
