-- Fork-owned usage queries (labrastro). Kept out of the upstream-hot
-- task_usage.sql to shrink future merge conflicts; accounting must stay in
-- sync with GetIssueUsageSummary in that file.

-- name: ListWorkspaceIssueUsage :many
-- Same accounting as GetIssueUsageSummary, retaining issue/provider/model so
-- cards can estimate only unpriced tokens without fetching each run history.
-- The inner joins omit issues with no usage, but preserve metered zeroes.
-- The handler drops the five cost-split fields on rows where nothing was
-- priced; the front-end treats their absence as all-uncosted (compat).
SELECT
    atq.issue_id,
    LOWER(tu.provider)::text AS provider,
    tu.model,
    COALESCE(SUM(tu.input_tokens), 0)::bigint AS input_tokens,
    COALESCE(SUM(tu.output_tokens), 0)::bigint AS output_tokens,
    COALESCE(SUM(tu.cache_read_tokens), 0)::bigint AS cache_read_tokens,
    COALESCE(SUM(tu.cache_write_tokens), 0)::bigint AS cache_write_tokens,
    COALESCE(SUM(tu.cost_usd_ticks), 0)::bigint AS cost_usd_ticks,
    COALESCE(SUM(tu.input_tokens)       FILTER (WHERE tu.cost_usd_ticks IS NULL), 0)::bigint AS uncosted_input_tokens,
    COALESCE(SUM(tu.output_tokens)      FILTER (WHERE tu.cost_usd_ticks IS NULL), 0)::bigint AS uncosted_output_tokens,
    COALESCE(SUM(tu.cache_read_tokens)  FILTER (WHERE tu.cost_usd_ticks IS NULL), 0)::bigint AS uncosted_cache_read_tokens,
    COALESCE(SUM(tu.cache_write_tokens) FILTER (WHERE tu.cost_usd_ticks IS NULL), 0)::bigint AS uncosted_cache_write_tokens
FROM task_usage tu
JOIN agent_task_queue atq ON atq.id = tu.task_id
JOIN issue i ON i.id = atq.issue_id
WHERE i.workspace_id = $1
GROUP BY atq.issue_id, LOWER(tu.provider), tu.model
ORDER BY atq.issue_id, LOWER(tu.provider), tu.model;
