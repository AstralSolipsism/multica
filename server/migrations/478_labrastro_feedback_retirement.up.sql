-- Stop old feedback recovery without deleting comments, receipts or audit.
-- Deploy with all old inbound/recovery workers stopped; never run mixed writers.
UPDATE labrastro_message_feedback
SET status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END,
    notice = CASE WHEN status = 'pending' THEN 'Legacy feedback retired; review existing comment/run before resubmitting to the agent.' ELSE notice END,
    acknowledged_at = COALESCE(acknowledged_at, now()), updated_at = now()
WHERE status = 'pending' OR acknowledged_at IS NULL;
