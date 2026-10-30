CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attachment_upload_pending ON attachment_upload (state, expires_at) WHERE state IN ('uploading','finalizing');
