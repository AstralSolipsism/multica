# Project engineering and managed baselines

OL-90 implements OL-464 contract v3.1 sections 2–6. This module stores project
configuration and immutable Markdown revisions in PostgreSQL. It has no runtime,
claim, skill-binding, Git repository, or model dependency.

All endpoints require workspace membership and a project in the selected
workspace. External conversation credentials are denied by the existing router
policy. Routes use `/api/projects/{id}`:

| Method | Suffix | Result |
| --- | --- | --- |
| GET | `/engineering` | `engineering` and four `chapters`, each with nullable `adopted` and `candidate` |
| PATCH | `/engineering` | Updated `engineering` configuration |
| POST | `/baseline/candidates` | New revision, including structured `anchors_diff` |
| POST | `/baseline/decisions` | Four updated `chapters` and `open_issues` |
| GET | `/baseline/revisions` | `revisions`, `has_more`, `next_before`, or a historical Diff |

Configuration defaults to disabled. Only owner/admin can change `enabled`,
`decider_member_ids` or `agent_decisions_enabled`. Other configuration fields are
also writable by deciders. As with project `lead_id` and member actors elsewhere
in the platform, decider IDs are **user IDs**, validated against current workspace
membership. Empty lists use owner/admin and the human project lead; explicit lists
replace the lead default while retaining owner/admin.

The first enable adopts the accepted `[Risk-1]` text from contract 5.6 into
`exclusions_and_risks`, attributed to the enabling member and their credential.
Disabling preserves all history; re-enabling does not reseed or overwrite it.

Candidate requests contain `chapter`, `content_markdown`, `change_summary`, and
`base_revision_id` (null for the first version). Existing candidates can only be
replaced with their exact `replaces_candidate_id`; replaced versions become
`withdrawn`. Optional `source_issue_id` must belong to the same project.

Decisions contain `action: adopt|reject` and one to four `revisions`, each with
`revision_id` and `expected_adopted_revision_id`. All revisions are checked before
any changes commit. Session/PAT callers must be deciders. Task credentials require
`agent_decisions_enabled`; adoption with `rule_removed`, `rule_shrunk` or
`rule_deferred` warnings requires a human. Rejection and `defer_missing_pool`
remain available to delegated agents. Cloud PATs and unknown credentials fail
closed. Audit fields come exclusively from authentication, never request JSON.

Revision content is limited to 64 KiB and summaries to 500 Unicode characters.
Anchors support Chinese suffixes and chapter-specific prefixes. Diff normalization
unifies newlines, removes trailing whitespace, and collapses blank lines. Fenced
examples do not create anchors. `_preamble` compares text before the first anchor;
`_unanchored` preserves text outside anchored sections after an H1–H3 boundary so
such edits are never silently omitted. Rule shrink warnings use Unicode character
counts and require a reduction strictly greater than 40%.

Diffs are stored on proposal and recomputed at decision time. Deferred-rule checks
use the exclusions candidate when present, otherwise its adopted revision. A
changed Diff returns `409 baseline_base_stale`; refresh and explicitly replace the
candidate before deciding again. Rollback uses a historical body as a new candidate.

History requires `chapter`, with optional `limit` (default 50, maximum 200) and
`before` revision number. `diff_from` and `diff_to` together return a Diff instead.
`open_issues` uses the same lifecycle-category expansion as issue listing, groups
`started` into `in_flight` and `unstarted` into `queued`, and returns at most 200
items with an explicit `truncated` flag.

Mutations lock workspace lifetime, then the project, then membership and baseline
documents. Project serialization protects first writes and cross-chapter Diff
inputs; document row locks cover multi-chapter decisions. Project/workspace
cleanup uses the same transactions as existing deletion. Migration
`9039_labrastro_engineering_tables` creates three tables with no foreign keys;
`9040_labrastro_engineering_config_identity_index` through
`9045_labrastro_engineering_candidate_index` build six separate concurrent indexes.
The migration runner can recover interrupted index builds; down migrations remove
indexes before tables.

After commit, `project_engineering:updated` and `project_baseline:changed` publish
only project/chapter identifiers. Shared API clients parse all responses through
Zod and `parseWithFallback`; unknown statuses, warnings and credentials remain
explicitly unknown. The CLI and overview UI are separate follow-up issues.
