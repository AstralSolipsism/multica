ALTER TABLE project_engineering DROP COLUMN IF EXISTS agent_decisions_enabled;

ALTER TABLE project_baseline_revision
    DROP CONSTRAINT IF EXISTS project_baseline_revision_decision_credential_check;
UPDATE project_baseline_revision SET decision_credential = 'agent_task'
    WHERE decision_credential = 'task';
ALTER TABLE project_baseline_revision
    ADD CONSTRAINT project_baseline_revision_decision_credential_check
    CHECK (decision_credential IN ('session', 'pat', 'agent_task'));
