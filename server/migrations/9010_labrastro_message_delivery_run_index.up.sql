CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_delivery_run
ON labrastro_message_delivery (run_id, installation_id, target_key)
WHERE run_id IS NOT NULL;
