-- Clear snapshots written by the retired daemon-side ZenMux collector: with
-- the collector gone no daemon will refresh or clear them, so reset those
-- rows to the "not reported" state. Rows pushed by the external BYO endpoint
-- (source=external) and any other provider are untouched.
UPDATE agent_runtime SET plan_quota = NULL
WHERE plan_quota->>'provider' = 'zenmux' AND plan_quota->>'source' = 'daemon';
