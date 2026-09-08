-- The send queue scan: only due, queued rows. Partial on status so the
-- terminal majority of the table stays out of the claim path.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_delivery_queue
    ON labrastro_message_delivery(next_attempt_at, created_at)
    WHERE status = 'queued';
