-- The exactly-once DECISION guarantee: one delivery row per
-- "run:<run_id>:<installation_id>:<target_key>" across concurrent enqueuers
-- (event subscriber + compensator + multiple replicas). Suppressed and
-- cancelled decisions share the key, so a source that produced no send is
-- never re-decided.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_labrastro_message_delivery_dedup
    ON labrastro_message_delivery(dedup_key);
