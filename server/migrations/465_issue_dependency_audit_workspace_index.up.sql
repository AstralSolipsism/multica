CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_dependency_audit_workspace ON issue_dependency_audit (workspace_id, created_at, id);
