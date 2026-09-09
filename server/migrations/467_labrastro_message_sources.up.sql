-- OL-27: personal-inbox and team-event delivery sources. The delivery
-- pipeline built in OL-25 (route → frozen decision → lease worker → receipt)
-- is reused unchanged; what changes is the SOURCE SCOPE a route may name.
-- Legacy rows keep their automation meaning exactly:
--
--   route.autopilot_id NOT NULL + source_kind='run'  → OL-25 behavior
--   route.autopilot_id NULL + source_kind IN
--     ('inbox','activity','comment')                 → OL-27 sources
--
-- A personal or project id NEVER impersonates an autopilot id: non-run
-- routes must leave autopilot_id NULL and name their scope through
-- source_kind (+ project_id for team filters). No virtual autopilot row is
-- created anywhere.
--
-- House rules honored: no foreign keys (relationships re-validated in
-- application code); existing migrations are not rewritten; every index
-- lives in its own single-statement CONCURRENTLY migration (468-470).

-- =====================
-- labrastro_message_route
-- =====================
ALTER TABLE labrastro_message_route ALTER COLUMN autopilot_id DROP NOT NULL;

ALTER TABLE labrastro_message_route
    ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'run'
        CHECK (source_kind IN ('run', 'inbox', 'activity', 'comment')),
    -- Team event filter: only issues in this project match. NULL = whole
    -- workspace. Evaluated against the issue's project AT DECISION TIME
    -- (the source has no historical project attribution to restore).
    ADD COLUMN project_id UUID,
    -- Personal route filter: which inbox item types this route forwards.
    -- Empty array = every type. Team sources ignore it.
    ADD COLUMN event_types TEXT[] NOT NULL DEFAULT '{}';

-- One row-shape constraint per source kind:
--   run       → autopilot scope, no project/event filter (OL-25 columns rule)
--   inbox     → no autopilot, member DM target only (personal = own DM)
--   activity  → no autopilot, external group/topic target only (team events
--   comment     never fan out to private DMs; the personal inbox source is
--               the DM surface)
ALTER TABLE labrastro_message_route
    ADD CONSTRAINT labrastro_message_route_source_shape CHECK (
        (source_kind = 'run'
            AND autopilot_id IS NOT NULL
            AND project_id IS NULL
            AND event_types = '{}')
     OR (source_kind = 'inbox'
            AND autopilot_id IS NULL
            AND target_type = 'member'
            AND target_user_id IS NOT NULL)
     OR (source_kind IN ('activity', 'comment')
            AND autopilot_id IS NULL
            AND target_type IN ('group', 'topic'))
    );

-- =====================
-- labrastro_message_delivery
-- =====================
ALTER TABLE labrastro_message_delivery ALTER COLUMN autopilot_id DROP NOT NULL;

ALTER TABLE labrastro_message_delivery
    ADD COLUMN source_ref_id UUID;

-- Every decision must name a real source: an automation run (run_id, OL-25
-- rows and test sends keep run_id NULL but name their kind) or a persisted
-- OL-27 source record (source_ref_id = inbox_item.id / activity_log.id /
-- comment.id). The scope is derived from the existing source_kind column —
-- no second vocabulary to drift. The two id columns never blend: a run
-- decision is never re-keyed onto a domain record and vice versa.
ALTER TABLE labrastro_message_delivery
    ADD CONSTRAINT labrastro_message_delivery_source_identity CHECK (
        (source_kind IN ('run_only', 'create_issue', 'test_send', 'unknown')
            AND source_ref_id IS NULL)
     OR (source_kind IN ('inbox', 'activity', 'comment')
            AND source_ref_id IS NOT NULL
            AND autopilot_id IS NULL
            AND run_id IS NULL)
    );

-- The source_kind vocabulary widens for the new persistent sources. The
-- 'unknown' guard from migration 463 is preserved verbatim.
ALTER TABLE labrastro_message_delivery
    DROP CONSTRAINT labrastro_message_delivery_source_kind_check;
ALTER TABLE labrastro_message_delivery
    ADD CONSTRAINT labrastro_message_delivery_source_kind_check
    CHECK (source_kind IN ('run_only', 'create_issue', 'test_send')
        OR (source_kind = 'unknown' AND status = 'suppressed' AND shard_total = 0)
        OR source_kind IN ('inbox', 'activity', 'comment'));

-- =====================
-- labrastro_message_approved_target
-- =====================
-- Team approvals get their own scope: (workspace, source_kind, installation,
-- target). An approval of an automation's outbound target is not borrowed by
-- a team source, and team approvals of different kinds (activity vs comment)
-- do not cover each other — scope widening requires a fresh approval.
ALTER TABLE labrastro_message_approved_target ALTER COLUMN autopilot_id DROP NOT NULL;

ALTER TABLE labrastro_message_approved_target
    ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'run';

ALTER TABLE labrastro_message_approved_target
    ADD CONSTRAINT labrastro_message_approved_target_source_shape CHECK (
        (source_kind = 'run' AND autopilot_id IS NOT NULL)
     OR (source_kind IN ('activity', 'comment') AND autopilot_id IS NULL)
    );
