CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_message_delivery_route_listing
ON labrastro_message_delivery (workspace_id, route_id, created_at DESC, id DESC)
WHERE autopilot_id IS NULL;
