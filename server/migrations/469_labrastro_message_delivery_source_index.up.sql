-- OL-27: the "does this persisted source already have a decision for this
-- normalized target" probe behind the NOT EXISTS filters of the
-- inbox/activity/comment candidate scans. Partial on source_ref_id so the
-- OL-25 run-decision majority (source_ref_id IS NULL) stays out of the index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_delivery_source
    ON labrastro_message_delivery (source_ref_id, installation_id, target_key)
    WHERE source_ref_id IS NOT NULL;
