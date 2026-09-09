-- Preserve dedup identities until an operator explicitly retires their replay
-- horizon. An older binary can run with this additive schema intact.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM labrastro_message_feedback) THEN
        RAISE EXCEPTION 'retain feedback identities or explicitly retire them before downgrading feedback';
    END IF;
END $$;
DROP INDEX IF EXISTS idx_labrastro_message_feedback_comment;
