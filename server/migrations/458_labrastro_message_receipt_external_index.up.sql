-- An external platform message id identifies at most one send per bot
-- installation. This is the reverse-lookup anchor for the feedback stage:
-- an inbound reply to a delivered message resolves back to its delivery and
-- from there to the source run. Rows with no external id (claimed but
-- unconfirmed sends) stay out of the unique set.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_labrastro_message_receipt_external
    ON labrastro_message_receipt(installation_id, external_message_id)
    WHERE external_message_id IS NOT NULL;
