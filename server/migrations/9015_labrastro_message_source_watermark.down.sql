ALTER TABLE labrastro_message_scan_cursor DROP COLUMN IF EXISTS cycle_stable_at;

UPDATE labrastro_message_scan_cursor
SET cursor_ts = 'epoch', cursor_id = '00000000-0000-0000-0000-000000000000',
    cycle_upper_id = NULL, generation = generation + 1
WHERE scanner IN ('inbox_source_delivery', 'activity_source_delivery', 'comment_source_delivery');
