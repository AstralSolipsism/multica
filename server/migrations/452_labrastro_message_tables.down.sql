-- Reverse of 452_labrastro_message_tables.up.sql. Receipts are dropped
-- before deliveries and deliveries before routes only as documentation —
-- there are no foreign keys, the order is free.
DROP TABLE IF EXISTS labrastro_message_receipt;
DROP TABLE IF EXISTS labrastro_message_delivery;
DROP TABLE IF EXISTS labrastro_message_route;
