-- Source scanners retain cursor_ts as the stable watermark; cycle_started_at
-- is the fixed time upper bound. Only a completed cycle promotes its captured
-- stable horizon. Run repair scanners keep their existing ID-cycle semantics.
ALTER TABLE labrastro_message_scan_cursor ADD COLUMN cycle_stable_at TIMESTAMPTZ;

UPDATE labrastro_message_scan_cursor
SET cursor_ts = 'epoch', cursor_id = '00000000-0000-0000-0000-000000000000',
    cycle_upper_id = NULL, generation = generation + 1
WHERE scanner IN ('inbox_source_delivery', 'activity_source_delivery', 'comment_source_delivery');
