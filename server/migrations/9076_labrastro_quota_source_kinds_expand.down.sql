-- OL-1369 stage 1 down: restore the original two-kind, always-encrypted
-- quota_source constraints. Rows of the widened kinds must be deleted first
-- (the up kinds no longer satisfy the restored checks).
DELETE FROM quota_source WHERE kind IN ('deepseek', 'opencode', 'jev_free');

ALTER TABLE quota_source DROP CONSTRAINT quota_source_kind_check;
ALTER TABLE quota_source ADD CONSTRAINT quota_source_kind_check
    CHECK (kind IN ('glm', 'zenmux'));

ALTER TABLE quota_source DROP CONSTRAINT quota_source_credential_ciphertext_check;
ALTER TABLE quota_source ADD CONSTRAINT quota_source_credential_ciphertext_check
    CHECK (octet_length(credential_ciphertext) > 0);
