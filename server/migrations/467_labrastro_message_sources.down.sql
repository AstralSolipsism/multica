-- Rolling back this feature removes its audit data. Export it first if it
-- must be retained. Include source test sends, and remove receipts before
-- deliveries: this repository has no foreign keys or cascade cleanup.
DELETE FROM labrastro_message_receipt r
USING labrastro_message_delivery d
WHERE r.delivery_id = d.id
  AND (d.source_kind IN ('inbox', 'activity', 'comment')
       OR (d.source_kind = 'test_send' AND d.autopilot_id IS NULL));
DELETE FROM labrastro_message_delivery
WHERE source_kind IN ('inbox', 'activity', 'comment')
   OR (source_kind = 'test_send' AND autopilot_id IS NULL);
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
