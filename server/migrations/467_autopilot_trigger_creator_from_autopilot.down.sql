-- OL-49: restore the earlier column comments. The Labrastro up migration
-- did not backfill any principals, so there is no data change to undo.
COMMENT ON COLUMN autopilot_trigger.created_by_type IS
    'Actor type of the trigger''s immutable creator: member | agent. Only ''member'' yields a run principal. NULL for triggers created before MUL-6951 that had no published_by to backfill from.';

COMMENT ON COLUMN autopilot_trigger.created_by_id IS
    'The member a schedule/webhook run fires AS: dispatch admission, the task''s originator/accountable, and every delegated run all resolve to this one human (MUL-6951). Written once at creation and never re-stamped, so editing the trigger cannot re-authorize its runs as the editor. NULL means no provable principal and the dispatch fails closed. No FK; workspace membership is re-validated on every dispatch.';
