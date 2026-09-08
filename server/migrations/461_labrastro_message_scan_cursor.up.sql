-- OL-25 repair contract §4 (review R4): persistent, per-scanner compensation
-- cursors. ONE ROW PER SCANNER (run_only terminal task / create_issue issue
-- status / create_issue linked-task failure advance independently). Each row
-- carries the current keyset position, the cycle's fixed upper bound and a
-- generation counter used as compare-and-set guard so a stale replica cannot
-- write back a position from an older cycle. Cross-workspace by design: the
-- table belongs to no workspace and is kept by workspace deletion
-- (manifest: keep), rebuilt from scratch if a row is lost.
CREATE TABLE labrastro_message_scan_cursor (
    scanner          TEXT PRIMARY KEY,
    cursor_ts        TIMESTAMPTZ NOT NULL DEFAULT 'epoch'::timestamptz,
    cursor_id        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
    cycle_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    generation       BIGINT NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
