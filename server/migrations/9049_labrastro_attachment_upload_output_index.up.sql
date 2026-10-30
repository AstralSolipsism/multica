CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_attachment_upload_output ON attachment_upload (workspace_id, job_id, attempt_id, output_index) WHERE purpose = 'media_output';
