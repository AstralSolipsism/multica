-- Unknown decisions contain no externally delivered content and can be
-- rediscovered if this version is installed again.
DELETE FROM labrastro_message_delivery WHERE source_kind = 'unknown';
ALTER TABLE labrastro_message_delivery
    DROP CONSTRAINT labrastro_message_delivery_source_kind_check;
ALTER TABLE labrastro_message_delivery
    ADD CONSTRAINT labrastro_message_delivery_source_kind_check
    CHECK (source_kind IN ('run_only', 'create_issue', 'test_send'));
ALTER TABLE labrastro_message_delivery DROP CONSTRAINT labrastro_message_delivery_shard_total_check;
ALTER TABLE labrastro_message_delivery ADD CONSTRAINT labrastro_message_delivery_shard_total_check CHECK (shard_total > 0);
ALTER TABLE labrastro_message_scan_cursor DROP COLUMN cycle_upper_id;

ALTER TABLE labrastro_message_delivery DROP COLUMN requested_by;
