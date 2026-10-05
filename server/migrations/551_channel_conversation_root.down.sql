-- Destructive: removes frozen conversation-root references and their trigger.
-- Up can only derive roots from surviving ancestry; pruned parents make those
-- references unrecoverable. Back up the database and stop external task dispatch
-- before an intentional rollback; restore with the matching binary to recover.
DROP TRIGGER IF EXISTS trg_task_conversation_root ON agent_task_queue;
DROP FUNCTION IF EXISTS stamp_task_conversation_root();
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS conversation_root_task_id;
