DROP TRIGGER IF EXISTS trg_task_conversation_root ON agent_task_queue;
DROP FUNCTION IF EXISTS stamp_task_conversation_root();
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS conversation_root_task_id;
