# Project engineering and the baseline wiki

OL-1329 evolves the Strixnova engineering module into a tree-shaped baseline
wiki: free-form page hierarchy, human/agent parity writes with optimistic
concurrency (`base_revision_number`), orthogonal auto-rebase, soft-delete
archive, per-page immutable full-snapshot revisions, link resolution and
full-text search. The candidate/annotation pipeline is retired. Wiki reads and writes are stored
in PostgreSQL; explicit agent/squad mentions in a discussion optionally use
the existing Issue/comment dispatch path. See
[labrastro-baseline-comments.md](labrastro-baseline-comments.md) for OL-1333's
comment API, anchoring and lazy carrier contract.

All endpoints require workspace membership and a project in the selected
workspace. Every workspace member (owner/admin/member) and every task-token
agent of the workspace can write pages and discussions. Comment edits require
authorship; deletion requires authorship or human owner/admin membership. Forged or
mismatched credentials return 403 `baseline_credential_denied`. Routes use
`/api/projects/{id}`:

| Method | Suffix | Result |
| --- | --- | --- |
| GET | `/engineering` | `engineering` configuration plus `chapters: []` (legacy shape kept for old clients); `with_chapters=false` returns only `engineering` |
| PATCH | `/engineering` | Updated `engineering` configuration (human-only; decider checks now error `engineering_not_decider`) |
| GET | `/baseline/tree` | Page tree with slugs, titles, versions, depths, section outlines and revision counts; `sections=false` drops outlines |
| POST | `/baseline/pages` | Create a page; publishes `create` revision v1 |
| GET | `/baseline/pages/{page}` | Page + revision; `?revision=N`, `?section=S`, `?with=links,backlinks,related_issues` |
| PUT | `/baseline/pages/{page}/content` | Whole-page or single-section write (`section` / `delete_section`), returns `rebased` |
| PATCH | `/baseline/pages/{page}` | Rename (`title`/`slug`) or move (`parent`/`after`) — one kind per request |
| POST | `/baseline/pages/{page}/archive` | Soft-delete; `recursive` archives the subtree, one revision per flipped page |
| POST | `/baseline/pages/{page}/restore` | Undo archive; `recursive` restores the same batch; `parent` retargets |
| GET | `/baseline/pages/{page}/revisions` | `revisions`, `has_more`, `next_before`; `with_content=false` strips bodies |
| GET | `/baseline/pages/{page}/revisions/{n}` | One revision with content |
| GET | `/baseline/pages/{page}/diff` | `structure` (only changed fields, `{from,to}`) plus section-level `sections` diff |
| POST | `/baseline/pages/{page}/rollback` | New `rollback` revision restoring vN (full snapshot default, `content_only` keeps live structure) |
| GET | `/baseline/pages/{page}/backlinks` | Pages whose resolved `[[links]]` target this page |
| GET | `/baseline/activity` | Project-wide recent revisions, including archived pages |
| GET | `/baseline/search` | Title/body search mapped to sections with ±60 rune snippets |

`{page}` accepts a UUID or a project-unique slug. Retired paths —
`GET /baseline`, `POST /baseline/candidates`, `POST /baseline/decisions`,
`GET /baseline/revisions`, `POST /baseline/reviews`,
`GET /baseline/annotation-batches…`, `POST /baseline/annotations/*` — return
410 `baseline_api_retired`.

## Data model

Two tables (migrations 9039–9048 created them; 9067 wiped the test-only
legacy rows and evolved the shapes in place; 9068–9070 add the wiki indexes):

- `project_baseline_page`: `id`, `parent_id` (NULL = root,
  `CHECK (parent_id IS DISTINCT FROM id)`), `slug` (unique per project,
  `^[a-z0-9][a-z0-9_-]{0,62}$`, never a UUID shape, still occupied while
  archived), `title` (1–200 runes), `position` (dense 0..n-1 per sibling set
  including archived slots), `current_revision_id`, `last_revision_number`
  (monotonic allocator), `archived_at`, timestamps.
- `project_baseline_revision`: immutable full snapshot per write — `page_id`,
  `revision_number` (> 0, unique per page), `revision_kind` ∈
  {create, content, rename, move, archive, restore, rollback}, structure
  snapshot columns (`title`, `slug`, `parent_id`, `position`, `archived_at`),
  `content_markdown` (≤ 64 KiB), `change_summary` (≤ 500), `base_revision_id`,
  `restored_from_revision_id`, `source_issue_id`, `created_by_*`, `created_at`.

`project_engineering` (configuration, deciders, stages) is unchanged. No
foreign keys; project/workspace deletion cascades in application transactions.
Indexes: `idx_project_baseline_doc_id` (kept name), `idx_project_baseline_revision_id`
(kept), `idx_project_baseline_page_slug` (unique, 9068),
`idx_project_baseline_revision_page` (unique, 9069),
`idx_project_baseline_revision_activity` (9070).

### Invariants (locked by tests)

- **I1** every visible page's `current_revision_id` is its newest revision.
- **I2/I2a** revisions are immutable; the **page row is the only live
  structure source**. New revisions snapshot the post-operation page row;
  structure fields never copy from older revisions and never write back.
- **I3** tree acyclic, depth ≤ 6, ≤ 500 unarchived pages, ≤ 200 siblings.
- **I3a** every sibling set (archived slots included) is dense 0..n-1 before
  each write commits. Passive shifts (another page's create/move/restore/
  rollback) update sibling page rows without creating revisions or consuming
  revision numbers.
- **I4** slugs are project-unique, archived pages keep theirs.
- **I5** comment data never enters Project Context, `tree` or page reads.

## Write model

Every page write except `create` carries `base_revision_number` (the version the
author read). Writes run inside the project row `FOR UPDATE` lock:

- **Full-page content**: rebases when every revision in `(base, current]` is
  `rename` or `move`; otherwise 409.
- **Section write/delete**: rebases when the window has no
  `archive`/`restore`/`rollback` **and** the target section subtree is
  byte-identical in base and current; the edit merges onto current content.
- **Rename**: rebases when the window has no `rename`/`archive`/`restore`/
  `rollback`.
- **Move**: rebases when the window has no `move`/`archive`/`restore`/
  `rollback` and the page's parent is unchanged since base.
- **Archive/restore/rollback**: strict CAS — stale base is always 409.

Conflict body: `{code: "baseline_conflict", error, current: {revision_number,
kind, created_at, created_by_type, created_by_id, change_summary,
source_issue_id?}}`; clients resubmit with `current.revision_number` as the
new base (never bypass the lock). Writes on archived pages return 409
`baseline_page_archived`; archived pages only accept `restore` or a full
rollback.

Tree guards: 409 `baseline_slug_taken` / `baseline_page_cycle` /
`baseline_page_has_children` (non-leaf archive without `recursive`) /
`baseline_parent_archived`; 422 `baseline_tree_too_deep` /
`baseline_tree_too_large` / `baseline_too_large` / `baseline_content_invalid` /
`baseline_section_ambiguous`; 404 `not_found` / `baseline_section_not_found`;
409 `engineering_disabled` gates all writes.

Rollback restores vN as a new revision: full snapshots restore body, title,
slug, parent and a clamped position (validating slug/cycle/depth/parent and
ending unarchived); `content_only` keeps the live structure. `restored_from_revision_id`
points at vN.

Server change summaries default to 新建页面 / 整页更新 / 更新小节「X」 /
删除小节「X」 / 改名 / 移动 / 调整顺序 / 归档 / 恢复 / 回滚到 vN when the
optional `change_summary` is empty. `source_issue_id` must belong to the
project.

## Links, search, activity

`[[target]]`, `[[target#section]]`, `[[target|display]]`, `[[#section]]` and
`[[stage:N]]` parse through a goldmark AST walk (code never links). Targets
resolve slug → unique unarchived title → project-unique section anchor; results
are `resolved`, `ambiguous` (with candidates) or `missing`. Forward `links`,
`backlinks`, search and Project Context share one per-request symbol table, so
both directions agree by construction; the shared golden fixture
`server/internal/engineering/testdata/wikilinks.json` runs in Go and vitest.

Search filters unarchived pages by `strpos` over lowercased title/body, maps
hits to sections and returns ±60 rune snippets (`match: title|section|body`).
Activity lists recent revisions including archived pages (kinds cover create /
rename / move / archive / rollback), powering the overview feed.

## Project Context

`resolveClaimProjectContext` appends a bounded tree outline (≤ 2000 runes):
pre-order listing of depth ≤ 3 with `slug 标题 vN`, root pages add an H2 title
outline (≤ 120 runes), overflow collapses into 「另有 K 页」, archived pages
are skipped, candidate and comment data contribute zero bytes, and the tail
carries the `tree` / `get` / `write --base` CLI hints. Any read failure leaves
the original description unchanged.
