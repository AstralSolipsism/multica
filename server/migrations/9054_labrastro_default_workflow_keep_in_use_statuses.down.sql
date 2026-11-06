-- Irreversible data repair: migrated steps cannot be distinguished from steps
-- subsequently added by a user. Keep them so rollback cannot strand issues.
SELECT 1;
