# Project engineering and managed baselines

OL-1189 implements the Strixnova v3.3 contract, with the approved stages-only scope.
This module stores project configuration and immutable Markdown revisions in PostgreSQL. It has no runtime,
claim, skill-binding, Git repository, or model dependency.

All endpoints require workspace membership and a project in the selected
workspace. External conversation credentials are denied by the existing router
policy. Routes use `/api/projects/{id}`:

| Method | Suffix | Result |
| --- | --- | --- |
| GET | `/engineering` | `engineering` and all `chapters` (four built-ins plus persisted modules), with `title`, `position`, nullable `adopted` and `candidate`; `with_chapters=false` returns only `engineering`, the PATCH response shape |
| PATCH | `/engineering` | Updated `engineering` configuration |
| POST | `/baseline/candidates` | New revision, including structured `anchors_diff` |
| POST | `/baseline/decisions` | All updated `chapters` and `open_issues` |
| GET | `/baseline?index=true` | Chapter metadata and H1–H3 outlines, without content or Diffs |
| GET | `/baseline?section=<query>` | Matching section subtrees and one-hop referenced definitions |
| GET | `/baseline/revisions` | `revisions`, `has_more`, `next_before`, or a historical Diff; `with_content=false` keeps metadata and `anchors_diff` but returns empty `content_markdown` |

Configuration defaults to disabled. Only owner/admin can change `enabled`
or `decider_member_ids`. Other configuration fields are
also writable by deciders. As with project `lead_id` and member actors elsewhere
in the platform, decider IDs are **user IDs**, validated against current workspace
membership. Empty lists use owner/admin and the human project lead; explicit lists
replace the lead default while retaining owner/admin. Configuration remains human-only
(`RequireHumanActor`); removed or unknown request fields return 400 `invalid_request`.

Enabling engineering writes configuration only. All four chapters initially have
`adopted: null` and `candidate: null`; no baseline document or revision is seeded.
Disabling and re-enabling preserve existing history.

`current_stage` is a positive integer, independent of configured stage numbers;
values above five are supported. `stages` is a JSON array, defaulting to `[]`,
with entries `{stage, title, goal}`. A patch replaces the entire array; omission
or `null` leaves it unchanged, while `[]` clears it. There can be at most 50
entries with distinct positive integer stage numbers. Titles are trimmed to
1–60 Unicode characters; goals are trimmed to at most 280 characters and default
to an empty string. Both are single-line, without CR, LF or NUL. Unknown nested
fields return 400 `invalid_request`; invalid stage values return 422
`invalid_request`. Entries are sorted by stage number before saving and returned
as a JSON array, never as base64. No mainline issue field is part of this API.

Candidate requests contain `chapter`, `content_markdown`, `change_summary`, and
`base_revision_id` (null for the first version). Existing candidates can only be
replaced with their exact `replaces_candidate_id`; replaced versions become
`withdrawn`. Optional `source_issue_id` must belong to the same project.

Decisions contain `action: adopt|reject` and one to 100 `revisions`, each with
`revision_id` and `expected_adopted_revision_id`. All revisions are checked before
any changes commit. Session/PAT callers must be deciders, otherwise they receive
403 `baseline_not_decider`. A task token bound to the selected workspace receives
403 `baseline_human_required` for both adoption and rejection, before the body is
parsed and without changing state. Tasks can still read, propose candidates and
compare history. Cloud PATs, tasks bound to a different workspace and unknown
credentials receive 403 `baseline_credential_denied`.
Audit fields come exclusively from authentication, never request JSON. New
decisions record `session` or `pat`; historical `agent_task` decisions remain
readable and the database credential CHECK is unchanged.

Revision content is limited to 65536 bytes and summaries to 500 Unicode
characters. Oversized content returns 422 `baseline_too_large`; NUL or invalid
UTF-8 returns 422 `baseline_content_invalid` (JSON decoding replaces invalid UTF-8
before parsing). Invalid chapter names return 400 `invalid_request`.

Diff normalization unifies newlines, removes trailing whitespace and collapses
blank lines. Non-empty ATX headings from `#` through `###` start sections;
fenced examples, `####` and lower, empty headings and Setext headings stay in
the body. The text before the first heading is `_preamble` when non-empty.
Each section ends at the next H1–H3 heading, including a child heading.

Normal heading keys collapse internal whitespace. An H3 key is prefixed by the
nearest preceding H1/H2 key as `Parent / Child`; H1/H2 keys have no prefix.
An optional `[prefix-number]` at any heading level provides a stable key across
title changes or moves. Its prefix accepts letters, numbers and underscores;
the suffix is 1–64 characters. Prefixes are unrestricted by chapter.
Non-matching brackets such as `[Draft] Title` remain ordinary titles. Repeated
keys receive ` (2)`, ` (3)`, etc., avoiding collisions with existing keys.

Diffs pair sections by key into `added`, `modified` and `removed`; a plain
heading rename is a removal and addition. Explicit-key title edits appear in
`before`/`after`. New diffs always have `warnings: []` and omit `before_chars`
and `after_chars`. Historical warnings and audit values remain readable.

Diffs are stored on proposal and recomputed at decision time. A changed Diff
returns `409 baseline_base_stale`; refresh and explicitly replace the candidate
before deciding again. Other chapters and workspace issue prefixes no longer
influence the Diff. Some candidates stored under the old algorithm therefore
need replacement after upgrading. Rollback uses a historical body as a new
candidate.

History requires `chapter`, with optional `limit` (default 50, maximum 200) and
`before` revision number. `diff_from` and `diff_to` together return a Diff instead.
`open_issues` uses the same lifecycle-category expansion as issue listing, groups
`started` into `in_flight` and `unstarted` into `queued`, and returns at most 200
items with an explicit `truncated` flag.

Mutations lock workspace lifetime, then the project, then membership and baseline
documents. Project serialization protects first writes and atomic decisions;
document row locks cover multi-chapter decisions. Project/workspace cleanup uses the same transactions as existing deletion. Migration
`9039_labrastro_engineering_tables` creates three tables with no foreign keys;
`9040_labrastro_engineering_config_identity_index` through
`9045_labrastro_engineering_candidate_index` build six separate concurrent indexes.
The migration runner can recover interrupted index builds; down migrations remove
indexes before tables. Migration `9046_labrastro_engineering_decisions`
removes the redundant configuration column and converts historical `task` audit
values to `agent_task`. It installs the new CHECK as NOT VALID before the
backfill, then validates it in the same transaction. Down converts audit values
back and restores the column with a false default; previous switch values
cannot be recovered. Released migration `9039_labrastro_engineering_tables`
remains unchanged.

Migration `9047_labrastro_engineering_stages` adds only the non-null JSONB
`stages` column with default `[]` and `project_engineering_stages_check`.
The CHECK uses CASE to validate the array type before checking its length (50
maximum). It requires no concurrent-index registration. It preserves existing
baselines and audit rows. Apply the migration before deploying the new binary;
old binaries use explicit columns and leave stages intact. To roll back, restore
the old binary before running down; down removes configured stages. Migrations
9039–9046 remain unchanged. Regenerate query code with `make sqlc`.

Before release, count enabled configurations, open candidates and historical
`agent_task` decisions. Review any old candidates that fail the new Diff check;
remove obsolete seeded risk text through a new candidate and human decision.
No existing baseline content is rewritten by the migration.

After commit, `project_engineering:updated` and `project_baseline:changed` publish
only project/chapter identifiers. Shared API clients parse all responses through
Zod and `parseWithFallback`; unknown statuses, warnings and credentials remain
explicitly unknown. The [baseline CLI](labrastro-project-baseline-cli.md) exposes
these APIs; Web/Desktop share the engineering overview and credential badges.

## Dynamic module chapters and section access

Migration `9048_labrastro_baseline_module_chapters` adds `title TEXT NOT NULL
DEFAULT ''` and `position INTEGER NOT NULL DEFAULT 0` to the existing document
table and widens both chapter CHECK constraints. The published keys remain
`overview`, `domain_rules`, `architecture`, `exclusions_and_risks`; dynamic keys
match `^module:[a-z0-9][a-z0-9_-]{0,62}$`. No new baseline tables are created.
Built-ins appear first in their established order, followed by modules sorted
by position and chapter key. Unset titles are empty. Module creation is lazy,
through the first successful proposal. Optional `chapter_title` (single line,
at most 200 Unicode characters) updates document metadata in that transaction;
it is not a versioned content field. Position is reserved metadata with default 0.

Apply 9048 before deploying the binary. Downgrade refuses while either table
contains a module chapter, preserving revision history rather than deleting it.
Once module data has been explicitly handled, down restores the old constraints
and drops title/position; that metadata is not recoverable. Migrations 9039–9047
are unchanged. This migration has no concurrent index and is discovered by stem.

Both compact GET modes accept `chapter` and `candidate=true`. They require exactly
one of `index=true` or a nonempty `section`. Index JSON is `{chapters: [{chapter,
title, position, revision_id, revision_number, status, sections: [{anchor, title,
level}]}]}`. Missing versions have null ID, number 0, empty status and outline.
Ordered levels represent the heading tree. Neither mode sends other chapter
bodies or a full engineering overview over HTTP.

Section reads match exact title/anchor first across the selected scope, then
case-insensitive substrings. All read matches are returned. Reads and local edits
include descendant headings up to the next heading of equal or lower depth;
Diff still compares each individual H1–H3 anchor. Slice JSON is `{sections:
[{chapter, anchor, title, level, content_markdown}], referenced_sections:
[{chapter, anchor, title, level, definition, why}]}`. References come from
`[[title]]`, `[[anchor]]` or literal occurrences of another heading title in the
selected bodies, case-insensitively. Resolution can cross chapters even with a
chapter filter. Each definition is its first paragraph; `why` extracts a paragraph
labelled 为什么/原因/理由/Why/Rationale, including a descendant heading. Missing
rationale stays empty. Referenced text is not scanned again. Already selected
sections and descendants are excluded from references.

Candidate requests may include `section`. Local proposals and deletions match
only an exact, case-sensitive title or anchor, with no substring fallback.
`content_markdown` then contains only that section subtree; a missing H1–H3
heading is filled with the original heading (or `## <section>` when appending).
An explicit replacement heading must preserve the original depth and may have
descendants, but not siblings. `delete_section: true` requires `section` and
empty/omitted content, and removes that subtree.
Multiple matches return 422 `baseline_section_ambiguous`; a missing section on
delete/read returns 404 `baseline_section_not_found`. A replacement with no exact
match appends, even if another title or anchor contains the query. Existing
base/candidate checks run before merge, and the merged chapter must still fit
65536 bytes. The normal Diff, candidate creation and human decision flow is
unchanged; unrelated source bytes are preserved.

## Baseline annotations

Baseline annotations are decider instructions attached to one chapter revision.
They reach exactly one carrier issue's runs and never enter any other context.
The full interaction model, isolation boundaries, ticket template and CLI
formats live in [labrastro-baseline-annotations.md](labrastro-baseline-annotations.md);
this section records the HTTP contract.

Migrations `9059_labrastro_baseline_annotations` (three tables, no foreign
keys: batch, review, annotation) and `9060_labrastro_baseline_review_client_key_index`
through `9063_labrastro_baseline_review_batch_index` (four concurrent indexes:
unique `client_key` idempotency, unique one-active-batch-per-chapter partial
index, unique batch ordinal, review batch ordering) store the data. Human
replies are annotation rows with `parent_annotation_id`; anchors are `text`,
`lines` or `section` with relocations recomputed against the working version.

Routes under `/api/projects/{id}/baseline`:

| Method | Suffix | Actor | Result |
| --- | --- | --- | --- |
| POST | `/reviews` | human decider | Finish a review: `{client_key, chapter, reviewed_revision_id, assignee?, summary?, annotations: [1..20]}` → `201 {batch, review, carrier, woke}`; same `client_key` replays the stored result |
| GET | `/annotation-batches?chapter=&state=&issue_id=` | member or task | Batch summaries and counts, never annotation bodies |
| GET | `/annotation-batches/{batch}?state=open\|all&with_sections=true` | member or task | `{batch, reviews, annotations, sections}`; default-open filtering happens server-side; `with_sections` returns deduped annotated section subtrees only |
| POST | `/annotations/responses` | task token whose issue is the batch carrier | `{responses: [1..50]{annotation_id, response}}`; 409 `baseline_batch_closed`; wakes nobody |
| POST | `/annotations/resolve` | human decider | `{annotation_ids: [1..50], resolved}` |
| POST | `/annotation-batches/{batch}/close` | human decider | Manual close (`manual`) |

Each annotation carries `ordinal` (per batch), `anchor_kind`, section anchor,
target revision, `line_start/line_end`, `quote`, `note`, optional `response`,
`state` (`open`/`resolved`/`archived`), `location` (`exact`/`moved`/
`section_only`/`outdated`) and the recomputed `located` coordinates. `side` is
derived from `target_revision_id`: the reviewed candidate's base revision is
`before`, otherwise `after`.

`POST /baseline/decisions` accepts an optional `annotation_batch_action`
(`close` default, or `keep`); it applies only to related batches — the candidate
was submitted by the batch carrier or is itself a reviewed revision of that
batch. Admitting or rejecting an unrelated candidate never touches batches.
Cancelling or deleting the carrier issue closes its batch as `issue_closed`
(read-time effective state, persisted on next write). Closing a batch never
rewrites the carrier issue's workflow status. Limits: ≤20 annotations per
review, ≤50 per batch including replies, `note`/`response` ≤1000 characters,
`quote` ≤500, `prefix`/`suffix` ≤64, lines spans ≤50.
