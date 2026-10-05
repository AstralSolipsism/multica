-- Reverse of 452_labrastro_message_tables.up.sql. Receipts are dropped
-- before deliveries and deliveries before routes only as documentation —
-- there are no foreign keys, the order is free.
-- Destructive: deletes route configuration, delivery history/dedup identities,
-- and external receipts. Reapplying up recreates empty tables, not this data.
-- Stop delivery workers and restore a backup with the matching binary to recover.
DROP TABLE IF EXISTS labrastro_message_receipt;
DROP TABLE IF EXISTS labrastro_message_delivery;
DROP TABLE IF EXISTS labrastro_message_route;
