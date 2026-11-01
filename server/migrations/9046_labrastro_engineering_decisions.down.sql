BEGIN;

ALTER TABLE project_baseline_revision
    DROP CONSTRAINT IF EXISTS project_baseline_revision_decision_credential_check;
ALTER TABLE project_baseline_revision
    ADD CONSTRAINT project_baseline_revision_decision_credential_check
    CHECK (decision_credential IN ('session', 'pat', 'task')) NOT VALID;
UPDATE project_baseline_revision SET decision_credential = 'task'
WHERE decision_credential = 'agent_task';
ALTER TABLE project_baseline_revision
    VALIDATE CONSTRAINT project_baseline_revision_decision_credential_check;

ALTER TABLE project_engineering
    ADD COLUMN IF NOT EXISTS agent_decisions_enabled BOOLEAN NOT NULL DEFAULT false;

COMMIT;
