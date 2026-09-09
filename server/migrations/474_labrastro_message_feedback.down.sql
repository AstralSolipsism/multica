DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM labrastro_message_feedback) THEN
        RAISE EXCEPTION 'retain feedback identities or explicitly retire them before downgrading feedback';
    END IF;
END $$;
DROP TABLE IF EXISTS labrastro_message_feedback;
