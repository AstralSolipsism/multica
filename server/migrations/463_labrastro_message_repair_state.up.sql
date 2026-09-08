-- Persist each scan cycle's immutable bound. Existing cursors restart once
-- because earlier versions did not record a trustworthy bound.
ALTER TABLE labrastro_message_scan_cursor ADD COLUMN cycle_upper_id UUID;

-- Unknown historical origins get a durable suppressed decision, never content
-- inferred from the automation's current execution_mode.
ALTER TABLE labrastro_message_delivery
    DROP CONSTRAINT labrastro_message_delivery_source_kind_check;
ALTER TABLE labrastro_message_delivery
    ADD CONSTRAINT labrastro_message_delivery_source_kind_check
    CHECK (source_kind IN ('run_only', 'create_issue', 'test_send')
        OR (source_kind = 'unknown' AND status = 'suppressed' AND shard_total = 0));
ALTER TABLE labrastro_message_delivery
    DROP CONSTRAINT labrastro_message_delivery_shard_total_check;
ALTER TABLE labrastro_message_delivery
    ADD CONSTRAINT labrastro_message_delivery_shard_total_check
    CHECK (shard_total > 0 OR (source_kind = 'unknown' AND status = 'suppressed' AND shard_total = 0));

-- The diagnostic sender's actor is audit state, separate from the feedback
-- locator source_ref. Historical rows without this evidence fail closed.
ALTER TABLE labrastro_message_delivery ADD COLUMN requested_by UUID;
