-- OL-1369 stage 1: widen the quota_source kinds to the global quota and
-- service-status monitor set (DeepSeek balance, OpenCode account, OpenCode
-- Jev free channel) and let the credential-free kind store an empty
-- ciphertext, so jev_free rows work without MULTICA_QUOTA_SOURCE_SECRET_KEY.
ALTER TABLE quota_source DROP CONSTRAINT quota_source_kind_check;
ALTER TABLE quota_source ADD CONSTRAINT quota_source_kind_check
    CHECK (kind IN ('glm', 'zenmux', 'deepseek', 'opencode', 'jev_free'));

ALTER TABLE quota_source DROP CONSTRAINT quota_source_credential_ciphertext_check;
ALTER TABLE quota_source ADD CONSTRAINT quota_source_credential_ciphertext_check
    CHECK (kind = 'jev_free' OR octet_length(credential_ciphertext) > 0);
