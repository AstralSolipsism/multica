-- Restore 9028's capture function and 551's root-stamping trigger. Tasks
-- created while 9066 was applied keep a NULL root; up never backfilled them.
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

DROP TRIGGER IF EXISTS trg_task_conversation_root ON agent_task_queue;
CREATE TRIGGER trg_task_conversation_root
BEFORE INSERT OR UPDATE OF originator_source, retry_of_task_id, delegated_from_task_id
ON agent_task_queue FOR EACH ROW EXECUTE FUNCTION stamp_task_conversation_root();

CREATE OR REPLACE FUNCTION capture_issue_wakeup(p_issue uuid, p_type text, p_key text, p_agent uuid, p_task uuid, p_payload jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE w issue_wakeup; owner_workspace uuid; evidence jsonb; violated_constraint text; conversation_root uuid;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM issue_wakeup WHERE issue_id=p_issue AND enabled AND kind='event' AND p_type=ANY(event_types)) THEN RETURN; END IF;
 IF p_agent IS NULL AND current_setting('multica.actor_type',true)='agent' THEN
  p_agent := NULLIF(current_setting('multica.actor_id',true),'')::uuid;
 END IF;
 SELECT i.workspace_id INTO owner_workspace FROM issue i
 WHERE i.id=p_issue AND i.status NOT IN ('done','cancelled') AND NOT EXISTS
 (SELECT 1 FROM issue_status s WHERE s.workspace_id=i.workspace_id AND s.key=i.status AND s.category IN ('done','closed'));
 IF owner_workspace IS NULL THEN RETURN; END IF;
 -- A bounded summary survives replacement by a later first-party event.
 -- Conflicting roots remain denied rather than selecting one grant arbitrarily.
 IF p_task IS NOT NULL THEN
  SELECT conversation_root_task_id INTO conversation_root FROM agent_task_queue WHERE id=p_task;
  IF NOT FOUND THEN conversation_root := p_task; END IF;
 END IF;
 evidence := jsonb_build_object('event_id',p_key,'event_type',p_type,'version',1,
  'occurred_at',clock_timestamp(),'workspace_id',owner_workspace,'issue_id',p_issue,
  'source_task_id',p_task,'agent_id',p_agent,'conversation_root_task_id',conversation_root,
  'actor_type',COALESCE(NULLIF(current_setting('multica.actor_type',true),''),CASE WHEN p_agent IS NOT NULL THEN 'agent' ELSE 'system' END),
  'actor_id',COALESCE(NULLIF(current_setting('multica.actor_id',true),''),p_agent::text)) || p_payload;
 FOR w IN SELECT * FROM issue_wakeup WHERE issue_id=p_issue AND workspace_id=owner_workspace AND enabled AND kind='event'
   AND p_type=ANY(event_types)
   AND (p_type NOT LIKE 'issue.%' OR agent_id IS NULL OR agent_id IS DISTINCT FROM NULLIF(current_setting('multica.handed_to_agent',true),'')::uuid)
   AND (filter_actor_type IS NULL OR (filter_actor_type=evidence->>'actor_type' AND filter_actor_id::text=evidence->>'actor_id'))
   AND (filter_agent_id IS NULL OR filter_agent_id=p_agent)
   AND (filter_task_id IS NULL OR filter_task_id=p_task)
   AND (p_task IS NULL OR source_task_id IS DISTINCT FROM p_task)
   AND NOT EXISTS (SELECT 1 FROM agent_task_queue t WHERE t.id=p_task AND t.context->>'wakeup_id'=issue_wakeup.id::text)
   ORDER BY id
 LOOP
  -- One pending notification per event type. Preserve the first key for
  -- duplicate suppression and the latest source reference for state reads.
  BEGIN
   INSERT INTO issue_wakeup_receipt(id,wakeup_id,revision,event_key,event_type,payload,coalesce_key)
    VALUES(gen_random_uuid(),w.id,w.revision,p_key,p_type,
     evidence || jsonb_build_object('coalesced_count',1,'first_occurred_at',evidence->'occurred_at'),p_type)
   ON CONFLICT(wakeup_id,revision,coalesce_key) WHERE processed_at IS NULL AND coalesce_key IS NOT NULL
   -- Rotate the receipt identity on merge. An older dispatcher that read
   -- without FOR UPDATE can only consume its observed version, leaving the
   -- replacement pending instead of silently consuming unseen evidence.
   DO UPDATE SET id=EXCLUDED.id,payload=EXCLUDED.payload || jsonb_build_object(
    'coalesced_count',COALESCE((issue_wakeup_receipt.payload->>'coalesced_count')::bigint,1)+1,
    'first_occurred_at',issue_wakeup_receipt.payload->'first_occurred_at',
    'conversation_root_task_id',COALESCE(NULLIF(issue_wakeup_receipt.payload->'conversation_root_task_id','null'::jsonb),EXCLUDED.payload->'conversation_root_task_id'),
    'conversation_roots_conflict',COALESCE((issue_wakeup_receipt.payload->>'conversation_roots_conflict')::boolean,false) OR
      (issue_wakeup_receipt.payload->>'conversation_root_task_id' IS NOT NULL AND
       EXCLUDED.payload->>'conversation_root_task_id' IS NOT NULL AND
       issue_wakeup_receipt.payload->>'conversation_root_task_id' <> EXCLUDED.payload->>'conversation_root_task_id'))
   WHERE issue_wakeup_receipt.event_key<>p_key AND issue_wakeup_receipt.payload->>'event_id' IS DISTINCT FROM p_key;
  EXCEPTION WHEN unique_violation THEN
   GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
   -- A retained receipt already handled this exact source fact. This also
   -- fences the locked registration snapshot against terminal-task capture.
   IF violated_constraint <> 'issue_wakeup_receipt_key_idx' THEN RAISE; END IF;
  END;

 END LOOP;
END $$;
