-- Keep external consent provenance independent of ordinary task-history retention.
-- This is a reference to the existing frozen grant, not a second authorization store.
BEGIN;
-- Remember whether this transaction introduced the column. A runner may replay
-- SQL after its commit but before recording the migration ledger entry.
SELECT set_config('multica.backfill_conversation_root', (
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'agent_task_queue'
                  AND column_name = 'conversation_root_task_id')
)::text, true);

ALTER TABLE agent_task_queue
    ADD COLUMN IF NOT EXISTS conversation_root_task_id UUID;

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

DROP TRIGGER IF EXISTS trg_task_conversation_root ON agent_task_queue;
CREATE TRIGGER trg_task_conversation_root
BEFORE INSERT OR UPDATE OF originator_source, retry_of_task_id, delegated_from_task_id
ON agent_task_queue FOR EACH ROW EXECUTE FUNCTION stamp_task_conversation_root();

-- Each task has at most one relevant parent. Cycles and missing ancestors are
-- unreachable from a root; preserve the old fork's denial for these historical
-- ambiguous records instead of silently dropping possible external consent.
DO $$
BEGIN
IF current_setting('multica.backfill_conversation_root') = 'true' THEN
WITH RECURSIVE links AS (
    SELECT id, originator_source,
           CASE WHEN retry_of_task_id IS NOT NULL THEN retry_of_task_id
                WHEN originator_source IN ('delegation', 'comment_source')
                    THEN delegated_from_task_id END AS parent_id
    FROM agent_task_queue
), resolved AS (
    SELECT id, CASE WHEN originator_source = 'channel_integration'
                    THEN id END AS root_id
    FROM links WHERE parent_id IS NULL
    UNION ALL
    SELECT child.id, parent.root_id
    FROM links child JOIN resolved parent ON child.parent_id = parent.id
), backfill AS (
    SELECT links.id, CASE WHEN resolved.id IS NULL THEN links.id
                          ELSE resolved.root_id END AS root_id
    FROM links LEFT JOIN resolved ON resolved.id = links.id
)
UPDATE agent_task_queue task SET conversation_root_task_id = backfill.root_id
FROM backfill WHERE task.id = backfill.id
AND task.conversation_root_task_id IS DISTINCT FROM backfill.root_id;
END IF;
END;
$$;
COMMIT;
