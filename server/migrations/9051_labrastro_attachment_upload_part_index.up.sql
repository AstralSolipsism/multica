CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_attachment_upload_part ON attachment_upload_part (workspace_id, upload_id, part_index);
