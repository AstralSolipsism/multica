-- Reopening pending member writes would silently reauthorize impersonation.
DO $$ BEGIN
    RAISE EXCEPTION 'Feedback retirement cannot be undone. Keep Feishu inbound disabled on older binaries; retain comments and audit.';
END $$;
