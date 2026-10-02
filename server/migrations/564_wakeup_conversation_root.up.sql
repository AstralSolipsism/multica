-- Keep scheduled instructions under the consent that created them, even after
-- the creating descendant's task history is removed. The frozen grant remains
-- on the original channel delivery; this column is only its durable reference.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SELECT set_config('multica.backfill_wakeup_conversation_root', (
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'issue_wakeup'
                  AND column_name = 'conversation_root_task_id')
)::text, true);
ALTER TABLE issue_wakeup ADD COLUMN IF NOT EXISTS conversation_root_task_id UUID;

CREATE OR REPLACE FUNCTION stamp_task_conversation_root()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id UUID;
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
    ELSIF NEW.originator_source = 'trigger_owner' AND NEW.trigger_evidence_kind = 'issue_wakeup' THEN
        SELECT conversation_root_task_id INTO NEW.conversation_root_task_id
        FROM issue_wakeup WHERE id = NEW.trigger_evidence_ref_id
          AND source_task_id IS NOT DISTINCT FROM NEW.delegated_from_task_id
          AND created_by = NEW.originator_user_id;
        IF FOUND THEN RETURN NEW; END IF;
        parent_id := NEW.delegated_from_task_id;
    ELSIF NEW.originator_source IN ('delegation', 'comment_source', 'trigger_owner') THEN
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
        NEW.conversation_root_task_id := NEW.id;
    ELSE
        SELECT conversation_root_task_id INTO NEW.conversation_root_task_id
        FROM agent_task_queue WHERE id = parent_id FOR KEY SHARE;
        IF NOT FOUND THEN NEW.conversation_root_task_id := NEW.id; END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION stamp_wakeup_conversation_root()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.source_task_id IS NOT DISTINCT FROM OLD.source_task_id THEN
        NEW.conversation_root_task_id := OLD.conversation_root_task_id;
    ELSIF NEW.source_task_id IS NULL THEN
        NEW.conversation_root_task_id := NULL;
    ELSE
        SELECT conversation_root_task_id INTO NEW.conversation_root_task_id
        FROM agent_task_queue WHERE id = NEW.source_task_id FOR KEY SHARE;
        -- Missing history cannot prove that an old agent-authored rule was
        -- first-party. A missing root fails closed during authorization.
        IF NOT FOUND THEN NEW.conversation_root_task_id := NEW.source_task_id; END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wakeup_conversation_root ON issue_wakeup;
CREATE TRIGGER trg_wakeup_conversation_root
BEFORE INSERT OR UPDATE OF source_task_id ON issue_wakeup
FOR EACH ROW EXECUTE FUNCTION stamp_wakeup_conversation_root();

DO $$
BEGIN
IF current_setting('multica.backfill_wakeup_conversation_root') = 'true' THEN
    -- Scan history once for unresolved parent links. Recursion and cycle
    -- detection use only that materialized subset, not the full task table at
    -- every depth. Existing roots and ordinary parentless history need no writes.
    WITH RECURSIVE links AS MATERIALIZED (
        SELECT id, CASE WHEN retry_of_task_id IS NOT NULL THEN retry_of_task_id
            ELSE delegated_from_task_id END AS parent_id
        FROM agent_task_queue
        WHERE conversation_root_task_id IS NULL
          AND (retry_of_task_id IS NOT NULL
               OR (originator_source IN ('delegation', 'comment_source', 'trigger_owner')
                   AND delegated_from_task_id IS NOT NULL))
    ), lineage AS (
        SELECT child.id, CASE WHEN parent.id IS NULL THEN child.id
            ELSE parent.conversation_root_task_id END AS root_id
        FROM links child LEFT JOIN agent_task_queue parent ON parent.id = child.parent_id
        WHERE NOT EXISTS (SELECT 1 FROM links ancestor WHERE ancestor.id = child.parent_id)
        UNION ALL
        SELECT child.id, parent.root_id FROM links child JOIN lineage parent ON parent.id = child.parent_id
    ), backfill AS (
        -- Missing ancestors and cycles cannot prove first-party authority.
        SELECT links.id, CASE WHEN lineage.id IS NULL THEN links.id ELSE lineage.root_id END AS root_id
        FROM links LEFT JOIN lineage ON lineage.id = links.id
        WHERE lineage.id IS NULL OR lineage.root_id IS NOT NULL
    )
    UPDATE agent_task_queue task SET conversation_root_task_id = backfill.root_id
    FROM backfill WHERE task.id = backfill.id AND task.conversation_root_task_id IS NULL;

    UPDATE issue_wakeup w SET conversation_root_task_id = source.conversation_root_task_id
    FROM agent_task_queue source WHERE source.id = w.source_task_id;
    UPDATE issue_wakeup w SET conversation_root_task_id = w.source_task_id
    WHERE w.source_task_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agent_task_queue source WHERE source.id = w.source_task_id);
END IF;
END;
$$;
COMMIT;
