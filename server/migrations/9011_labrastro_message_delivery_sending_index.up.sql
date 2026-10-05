CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_delivery_sending
ON labrastro_message_delivery (lease_expires_at)
WHERE status = 'sending';
