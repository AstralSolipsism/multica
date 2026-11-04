CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quota_source_due ON quota_source (next_poll_at) WHERE enabled;
