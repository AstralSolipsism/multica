\set ON_ERROR_STOP on
DO $$
BEGIN
 IF (SELECT count(*) FROM schema_migrations WHERE version IN ('551_channel_conversation_root','551_pr_merge_status')) <> 2 THEN
  RAISE EXCEPTION 'Both 551 full stems must be recorded';
 END IF;
 IF (SELECT settings->>'pr_merge_status' FROM workspace WHERE slug='ol98-disabled') IS DISTINCT FROM 'none'
  OR (SELECT settings->>'pr_merge_status' FROM workspace WHERE slug='ol98-explicit') IS DISTINCT FROM 'in_review'
  OR (SELECT settings ? 'pr_merge_status' FROM workspace WHERE slug='ol98-default') IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'PR setting migration changed the wrong workspace';
 END IF;
 IF (SELECT count(*) FROM agent_task_queue WHERE agent_id='98000000-0000-4000-8000-000000000003'
  AND conversation_root_task_id='98000000-0000-4000-8000-000000000007') <> 2 THEN
  RAISE EXCEPTION 'External root/retry provenance changed';
 END IF;
 IF (SELECT config->'conversation'->>'authorized_by' FROM channel_task_delivery WHERE task_id='98000000-0000-4000-8000-000000000007') IS DISTINCT FROM '98000000-0000-4000-8000-000000000001'
  OR (SELECT config->'conversation'->>'id' FROM channel_installation WHERE id='98000000-0000-4000-8000-000000000009') IS DISTINCT FROM 'upgrade-grant' THEN
  RAISE EXCEPTION 'Frozen or live conversation grant changed';
 END IF;
 IF (SELECT count(*) FROM issue_dependency WHERE issue_id='98000000-0000-4000-8000-000000000005') <> 1
  OR (SELECT content FROM chat_message WHERE chat_session_id='98000000-0000-4000-8000-000000000006') IS DISTINCT FROM 'Preserve external source text' THEN
  RAISE EXCEPTION 'Retained DAG/chat data changed';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM issue_wakeup WHERE id='98000000-0000-4000-8000-000000000010'
  AND instruction='Existing wakeup' AND condition IS NULL AND max_fires IS NULL AND fire_count=0 AND system_rule IS NULL) THEN
  RAISE EXCEPTION 'Existing wakeup defaults changed';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_index WHERE indrelid IN ('agent_task_queue'::regclass,'issue_wakeup'::regclass,'issue_child_event'::regclass,'search_index_change'::regclass) AND NOT indisvalid) THEN
  RAISE EXCEPTION 'Invalid index after upgrade';
 END IF;
END $$;
SELECT count(*) AS recorded_migrations, max(version) AS latest FROM schema_migrations;
SELECT version FROM schema_migrations WHERE version LIKE '551_%' ORDER BY version;
