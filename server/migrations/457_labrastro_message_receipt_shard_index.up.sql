-- Stable shard identity: a retry reuses the same (delivery, shard) row and
-- its send_uuid; it can never renumber or re-split the message.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_labrastro_message_receipt_shard
    ON labrastro_message_receipt(delivery_id, shard_index);
