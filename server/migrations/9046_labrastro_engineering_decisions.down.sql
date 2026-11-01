-- The removed permission setting is restored disabled; its old value is not retained.
ALTER TABLE project_engineering ADD COLUMN IF NOT EXISTS agent_decisions_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE project_baseline_revision
    DROP CONSTRAINT IF EXISTS project_baseline_revision_decision_credential_check;
UPDATE project_baseline_revision SET decision_credential = 'task'
    WHERE decision_credential = 'agent_task';
ALTER TABLE project_baseline_revision
    ADD CONSTRAINT project_baseline_revision_decision_credential_check
    CHECK (decision_credential IN ('session', 'pat', 'task'));
