-- Downgrading removes durable wakeup consent references; restore a snapshot instead
-- when recovering the old binary. Existing task roots are deliberately retained.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
CREATE OR REPLACE FUNCTION stamp_task_conversation_root()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    parent_id UUID;
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.originator_source IS NOT DISTINCT FROM OLD.originator_source
       AND NEW.retry_of_task_id IS NOT DISTINCT FROM OLD.retry_of_task_id
       AND NEW.delegated_from_task_id IS NOT DISTINCT FROM OLD.delegated_from_task_id THEN
        NEW.conversation_root_task_id := OLD.conversation_root_task_id;
        RETURN NEW;
    END IF;
    IF NEW.retry_of_task_id IS NOT NULL THEN
        parent_id := NEW.retry_of_task_id;
    ELSIF NEW.originator_source IN ('delegation', 'comment_source') THEN
        parent_id := NEW.delegated_from_task_id;
    ELSIF NEW.originator_source = 'channel_integration' THEN
        NEW.conversation_root_task_id := NEW.id;
        RETURN NEW;
    ELSE
        NEW.conversation_root_task_id := NULL;
        RETURN NEW;
    END IF;

    IF parent_id IS NULL THEN
        NEW.conversation_root_task_id := NULL;
    ELSIF parent_id = NEW.id THEN
        -- Invalid ancestry must not erase a possible external grant.
        NEW.conversation_root_task_id := NEW.id;
    ELSE
        SELECT conversation_root_task_id INTO NEW.conversation_root_task_id
        FROM agent_task_queue WHERE id = parent_id FOR KEY SHARE;
        IF NOT FOUND THEN
            NEW.conversation_root_task_id := NEW.id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wakeup_conversation_root ON issue_wakeup;
DROP FUNCTION IF EXISTS stamp_wakeup_conversation_root();
ALTER TABLE issue_wakeup DROP COLUMN IF EXISTS conversation_root_task_id;
COMMIT;
