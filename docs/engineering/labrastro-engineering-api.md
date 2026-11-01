# Project engineering and managed baselines

OL-90 implements OL-464 contract v3.1 sections 2–6, with the owner-approved
OL-1171 decision-policy update. This module stores project
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
or `decider_member_ids`. `enabled` is the sole capability switch. Other configuration fields are
also writable by deciders. As with project `lead_id` and member actors elsewhere
in the platform, decider IDs are **user IDs**, validated against current workspace
membership. Empty lists use owner/admin and the human project lead; explicit lists
replace the lead default while retaining owner/admin.

The first enable adopts the accepted `[Risk-1]` PAT risk, with the current
task-token mitigation, into
`exclusions_and_risks`, attributed to the enabling member and their credential.
Disabling preserves all history; re-enabling does not reseed or overwrite it.

Candidate requests contain `chapter`, `content_markdown`, `change_summary`, and
`base_revision_id` (null for the first version). Existing candidates can only be
replaced with their exact `replaces_candidate_id`; replaced versions become
`withdrawn`. Optional `source_issue_id` must belong to the same project.

Decisions contain `action: adopt|reject` and one to four `revisions`, each with
`revision_id` and `expected_adopted_revision_id`. All revisions are checked before
any changes commit. When engineering is enabled, session/PAT callers must be
deciders; workspace task tokens (`mat_`) can adopt or reject directly. The four
warnings (`rule_removed`, `rule_shrunk`, `rule_deferred`, `defer_missing_pool`)
remain visible and never block a decision. Cloud PATs (`mcn_`) remain denied by
the router. The handler rejects unknown or cross-workspace task identities with
`baseline_credential_denied`.
Audit fields come exclusively from authentication, never request JSON:
`decided_by_type`, `decided_by_id`, `decided_by_task_id`, `decided_at`, and
`decision_credential` (`session`, `pat`, `agent_task`). Candidate creation remains
a separate step and does not adopt the candidate.

Revision content is limited to 64 KiB and summaries to 500 Unicode characters.
Anchors support Chinese suffixes and chapter-specific prefixes. Diff normalization
unifies newlines, removes trailing whitespace, and collapses blank lines. Fenced
examples do not create anchors. `_preamble` compares text before the first anchor;
`_unanchored` preserves text outside anchored sections after an H1–H3 boundary so
such edits are never silently omitted. Rule shrink warnings use Unicode character
counts and require a reduction strictly greater than 40%.

`defer_missing_pool` checks each `[Defer-*]` title and body for an Issue reference:
an identifier using the current workspace prefix (bare or in an `/issues/` URL),
a `mention://issue/<uuid>` link, or an `/issues/<uuid>` URL. References such as
`ADR-3`, `UTF-8` and `PR-201` do not count unless their prefix matches the workspace.

Diffs are stored on proposal and recomputed at decision time. Deferred-rule checks
use the exclusions candidate when present, otherwise its adopted revision. A
changed Diff returns `409 baseline_base_stale`; refresh and explicitly replace the
candidate before deciding again. Renaming the workspace Issue prefix can also
change the recomputed Diff and require candidate replacement. Rollback uses a
historical body as a new candidate.

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
indexes before tables. Migration `9046_labrastro_engineering_decisions` removes
the obsolete agent permission column and converts historical `task` credentials
to `agent_task`, preserving revision content, actor IDs and timestamps. Its down
migration restores the old credential vocabulary and a disabled agent setting;
previous setting values cannot be recovered. Existing Risk-1 revisions are never
rewritten by enabling or migrating.

After commit, `project_engineering:updated` and `project_baseline:changed` publish
only project/chapter identifiers. Shared API clients parse all responses through
Zod and `parseWithFallback`; unknown statuses, warnings and credentials remain
explicitly unknown. The API boundary normalizes the older `task` credential to
`agent_task` so existing servers still display an agent badge. The [baseline CLI](labrastro-project-baseline-cli.md) exposes
these APIs; the overview retains credential badges, warning highlights and
`?candidate=` links that view the selected revision without adopting it.
