-- Delivery records listing (run list "已发送/待重试/失败/结果不确定" columns
-- and the records API): newest-first per workspace + automation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_delivery_listing
    ON labrastro_message_delivery(workspace_id, autopilot_id, created_at DESC);
