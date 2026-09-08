-- OL-27 source-scope rollback. Deliveries decided for the new sources keep
-- their rows: dropping the columns would erase the audit trail, and the
-- source_kind check below would refuse 'inbox'/'activity'/'comment' rows
-- anyway — so the rollback is only clean once those rows are gone. Orders
-- and workspaces are swept explicitly first.
DELETE FROM labrastro_message_delivery
WHERE source_kind IN ('inbox', 'activity', 'comment');
DELETE FROM labrastro_message_approved_target
WHERE source_kind IN ('activity', 'comment');
DELETE FROM labrastro_message_route
WHERE source_kind <> 'run';

ALTER TABLE labrastro_message_approved_target
    DROP CONSTRAINT IF EXISTS labrastro_message_approved_target_source_shape;
ALTER TABLE labrastro_message_approved_target DROP COLUMN IF EXISTS source_kind;
ALTER TABLE labrastro_message_approved_target ALTER COLUMN autopilot_id SET NOT NULL;

ALTER TABLE labrastro_message_delivery
    DROP CONSTRAINT IF EXISTS labrastro_message_delivery_source_kind_check;
ALTER TABLE labrastro_message_delivery
    ADD CONSTRAINT labrastro_message_delivery_source_kind_check
    CHECK (source_kind IN ('run_only', 'create_issue', 'test_send')
        OR (source_kind = 'unknown' AND status = 'suppressed' AND shard_total = 0));
ALTER TABLE labrastro_message_delivery
    DROP CONSTRAINT IF EXISTS labrastro_message_delivery_source_identity;
ALTER TABLE labrastro_message_delivery DROP COLUMN IF EXISTS source_ref_id;
ALTER TABLE labrastro_message_delivery ALTER COLUMN autopilot_id SET NOT NULL;

ALTER TABLE labrastro_message_route
    DROP CONSTRAINT IF EXISTS labrastro_message_route_source_shape;
ALTER TABLE labrastro_message_route
    DROP COLUMN IF EXISTS source_kind,
    DROP COLUMN IF EXISTS project_id,
    DROP COLUMN IF EXISTS event_types;
ALTER TABLE labrastro_message_route ALTER COLUMN autopilot_id SET NOT NULL;
