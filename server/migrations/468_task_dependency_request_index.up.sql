CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_task_dependency_request ON agent_task_queue ((dependency_admission->>'request_id')) WHERE dependency_admission IS NOT NULL;
