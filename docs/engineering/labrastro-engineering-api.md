# Project engineering and managed baselines

OL-90 and OL-1171 implement OL-464 contract v3.2 sections 2–6. This module stores project
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

Configuration defaults to disabled. Only owner/admin can change `enabled`
or `decider_member_ids`. Other configuration fields are
also writable by deciders. As with project `lead_id` and member actors elsewhere
in the platform, decider IDs are **user IDs**, validated against current workspace
membership. Empty lists use owner/admin and the human project lead; explicit lists
replace the lead default while retaining owner/admin. Configuration remains human-only
(`RequireHumanActor`); removed or unknown request fields return 400 `invalid_request`.

The first enable adopts the accepted `[Risk-1]` text from contract 5.6 into
`exclusions_and_risks`, attributed to the enabling member and their credential.
Disabling preserves all history; re-enabling does not reseed or overwrite it.

Candidate requests contain `chapter`, `content_markdown`, `change_summary`, and
`base_revision_id` (null for the first version). Existing candidates can only be
replaced with their exact `replaces_candidate_id`; replaced versions become
`withdrawn`. Optional `source_issue_id` must belong to the same project.

Decisions contain `action: adopt|reject` and one to four `revisions`, each with
`revision_id` and `expected_adopted_revision_id`. All revisions are checked before
any changes commit. Session/PAT callers must be deciders, otherwise they receive
403 `baseline_not_decider`. Tasks bound to the selected workspace can adopt or
reject without a second switch or decider-list check. All four warning types
remain visible and do not block adoption. Cloud PATs, tasks bound to a different
workspace and unknown credentials receive 403 `baseline_credential_denied`.
Audit fields come exclusively from authentication, never request JSON:
`decision_credential` is `session`, `pat` or `agent_task` (the authentication
layer still calls task credentials `task`). The server does not verify whether
a decider approved the version in conversation; this accepted risk is seeded
for newly enabled projects, while existing risk text is preserved.

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
indexes before tables. Migration `9046_labrastro_engineering_decision_credentials`
removes the redundant configuration column and converts historical `task` audit
values to `agent_task`. It installs the new CHECK as NOT VALID before the
backfill, then validates it in the same transaction. Down converts audit values
back and restores the column with a false default; previous switch values
cannot be recovered. Released migration `9039_labrastro_engineering_tables`
remains unchanged. Regenerate query code with `make sqlc`.

After commit, `project_engineering:updated` and `project_baseline:changed` publish
only project/chapter identifiers. Shared API clients parse all responses through
Zod and `parseWithFallback`; unknown statuses, warnings and credentials remain
explicitly unknown. The [baseline CLI](labrastro-project-baseline-cli.md) exposes
these APIs; Web/Desktop share the engineering overview and credential badges.
