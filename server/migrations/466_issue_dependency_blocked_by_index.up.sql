CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_dependency_blocked_by ON issue_dependency (issue_id, depends_on_issue_id) WHERE type = 'blocked_by';
