CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_media_job_running ON media_job (runtime_id) WHERE state = 'running';
