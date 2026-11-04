-- User-scoped subscription quota sources (OL-1205 scenario 3, final
-- baseline): a user-registered third-party subscription credential polled
-- server-side. Deliberately NOT bound to any machine or runtime — manual
-- subscriptions render as standalone cards above the runtimes list.
-- No FKs by house rule; ownership is enforced in application code.
CREATE TABLE IF NOT EXISTS quota_source (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('glm', 'zenmux')),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    -- NULL = driver default endpoint.
    base_url TEXT CHECK (base_url IS NULL OR char_length(base_url) <= 256),
    credential_ciphertext BYTEA NOT NULL CHECK (octet_length(credential_ciphertext) > 0),
    credential_hint TEXT NOT NULL DEFAULT '' CHECK (char_length(credential_hint) <= 4),
    enabled BOOLEAN NOT NULL DEFAULT true,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
    snapshot JSONB,
    last_polled_at TIMESTAMPTZ,
    last_error_code TEXT,
    last_error_message TEXT CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 300),
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
