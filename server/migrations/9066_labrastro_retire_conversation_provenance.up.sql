-- Retire Feishu external conversations (OL-1274). Feishu chat now uses only
-- upstream's member-binding flow, so no pre-upgrade external work may keep or
-- regain execution rights:
-- 1. Revoke every conversation grant first. A rolling deploy's older binary
--    re-checks the live grant on ingress, enqueue, claim, every task-token
--    request and replies, so it fails closed from this commit on. Its lock on
--    the installation also orders an in-flight ingest before step 3.
-- 2. Drop the root-stamping trigger. Its table lock waits for in-flight task
--    writers, whose rows were stamped, so step 3 sees them.
-- 3. Cancel unfinished external roots and descendants; terminal tasks are
--    never retried, so nothing re-enters the queue.
-- 4. Delete their task tokens; the token user is the runtime owner, which the
--    removed policy used to replace with the grantor inside a sandbox.
-- 5. Consume pending wakeup inputs captured from external work so they do not
--    later dispatch as their rule creator.
-- Audit data (task rows, roots, frozen delivery snapshots) is kept.
UPDATE channel_installation
SET config = config - 'conversation' - 'private_chat_candidates', updated_at = now()
WHERE channel_type = 'feishu' AND (config ? 'conversation' OR config ? 'private_chat_candidates');

DROP TRIGGER IF EXISTS trg_task_conversation_root ON agent_task_queue;
DROP FUNCTION IF EXISTS stamp_task_conversation_root();

UPDATE agent_task_queue
SET status = 'cancelled', completed_at = now(), prepare_lease_expires_at = NULL,
    cancelled_by_type = 'system', cancelled_by_id = NULL, cancelled_by_name = NULL
WHERE (conversation_root_task_id IS NOT NULL OR originator_source = 'channel_integration')
  AND status IN ('queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred');

DELETE FROM task_token t USING agent_task_queue q
WHERE t.task_id = q.id
  AND (q.conversation_root_task_id IS NOT NULL OR q.originator_source = 'channel_integration');

UPDATE issue_wakeup_receipt SET processed_at = now()
WHERE processed_at IS NULL AND payload->>'conversation_root_task_id' IS NOT NULL;

-- The function below is upstream 579's capture_issue_wakeup, byte for byte,
-- replacing the 9009/9028 variants that also recorded conversation roots.
-- The nullable agent_task_queue.conversation_root_task_id column keeps its
-- historical values for audit; no code path uses it.
CREATE OR REPLACE FUNCTION capture_issue_wakeup(p_issue uuid, p_type text, p_key text, p_agent uuid, p_task uuid, p_payload jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE w issue_wakeup; owner_workspace uuid; evidence jsonb; violated_constraint text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM issue_wakeup WHERE issue_id=p_issue AND enabled AND kind='event' AND p_type=ANY(event_types)) THEN RETURN; END IF;
 IF p_agent IS NULL AND current_setting('multica.actor_type',true)='agent' THEN
  p_agent := NULLIF(current_setting('multica.actor_id',true),'')::uuid;
 END IF;
 SELECT i.workspace_id INTO owner_workspace FROM issue i
 WHERE i.id=p_issue AND i.status NOT IN ('done','cancelled') AND NOT EXISTS
 (SELECT 1 FROM issue_status s WHERE s.workspace_id=i.workspace_id AND s.key=i.status AND s.category IN ('done','closed'));
 IF owner_workspace IS NULL THEN RETURN; END IF;
 evidence := jsonb_build_object('event_id',p_key,'event_type',p_type,'version',1,
  'occurred_at',clock_timestamp(),'workspace_id',owner_workspace,'issue_id',p_issue,
  'source_task_id',p_task,'agent_id',p_agent,
  'actor_type',COALESCE(NULLIF(current_setting('multica.actor_type',true),''),CASE WHEN p_agent IS NOT NULL THEN 'agent' ELSE 'system' END),
  'actor_id',COALESCE(NULLIF(current_setting('multica.actor_id',true),''),p_agent::text)) || p_payload;
 FOR w IN SELECT * FROM issue_wakeup WHERE issue_id=p_issue AND workspace_id=owner_workspace AND enabled AND kind='event'
   AND p_type=ANY(event_types)
   AND (filter_actor_type IS NULL OR (filter_actor_type=evidence->>'actor_type' AND filter_actor_id::text=evidence->>'actor_id'))
   AND (filter_agent_id IS NULL OR filter_agent_id=p_agent)
   AND (filter_task_id IS NULL OR filter_task_id=p_task)
   AND (p_task IS NULL OR source_task_id IS DISTINCT FROM p_task)
   AND NOT EXISTS (SELECT 1 FROM agent_task_queue t WHERE t.id=p_task AND t.context->>'wakeup_id'=issue_wakeup.id::text)
   AND (p_type NOT LIKE 'issue.%' OR agent_id IS NULL OR agent_id IS DISTINCT FROM NULLIF(current_setting('multica.handed_to_agent',true),'')::uuid)
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
    'first_occurred_at',issue_wakeup_receipt.payload->'first_occurred_at')
   WHERE issue_wakeup_receipt.event_key<>p_key AND issue_wakeup_receipt.payload->>'event_id' IS DISTINCT FROM p_key;
  EXCEPTION WHEN unique_violation THEN
   GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
   -- A retained receipt already handled this exact source fact. This also
   -- fences the locked registration snapshot against terminal-task capture.
   IF violated_constraint <> 'issue_wakeup_receipt_key_idx' THEN RAISE; END IF;
  END;

 END LOOP;
END $$;
