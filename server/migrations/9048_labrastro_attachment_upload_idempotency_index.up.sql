CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_attachment_upload_idempotency ON attachment_upload (workspace_id, initiating_principal_type, initiating_principal_id, idempotency_key);
