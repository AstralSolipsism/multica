# Wiki passage comments (OL-1333)

A page discussion contains an immutable anchor snapshot and ordered Markdown
comments. Members and task-token agents create, reply, resolve and reopen;
only an author edits, while an author or human owner/admin may delete. Removing
the last comment removes its thread. Creating/replying on archived pages returns
409 `baseline_page_archived`. Workspace/project checks and project write locks
reuse the Wiki page mechanism. Limits are 500 threads/page and 200 comments/thread.

## HTTP and CLI

Paths below are under `/api/projects/{id}/baseline`. `{page}` is a slug or UUID.
[comment CLI](labrastro-project-baseline-cli.md#passage-discussions) uses
`project baseline comment <action> <pid>`.

| Method | Path | Request/result |
| --- | --- | --- |
| GET | `/pages/{page}/threads?state=open\|resolved\|all` | `{threads}`; default open, ordered by latest activity, inline comments |
| POST | `/pages/{page}/threads` | `{anchor, body_markdown, carrier_issue_id?}` or CLI `{quote?, section?, body_markdown, carrier_issue_id?}` → `{thread, comment, woke}` |
| GET | `/threads/{id}?with_section=true` | `{thread}` including current own-section Markdown when locatable |
| POST | `/threads/{id}/comments` | `{body_markdown}` → `{thread, comment, woke}` |
| PATCH | `/comments/{id}` | `{body_markdown}` → `{ok:true}` |
| DELETE | `/comments/{id}` | `{ok:true}` |
| POST | `/threads/{id}/resolve` | `{resolved:boolean}` → `{ok:true}` |

Threads return `anchor`, `anchor_state`, `location`, optional `issue_id` and
`identifier`, grouped resolution metadata and ordered `comments`. Bodies are
1–4000 code points. The browser supplies `{kind, section_anchor, section_title,
exact, prefix, suffix, start, revision_number}`; the server verifies its source
revision and supplies the authoritative title. CLI completion finds a unique
quote (optionally scoped by title/anchor) or returns 422
`baseline_quote_ambiguous` / `baseline_quote_not_found`. Section-only creation
uses `--section`. Quotes are ≤500 code points, context ≤64 each; `start` is UTF-16.

## Anchoring and rendering

Own sections use the existing H1–H3 scanner and `_preamble`; descendants are
excluded. CommonMark + GFM rendered text collapses ECMAScript whitespace and
block boundaries. Wiki chips contribute their visible label, without previews;
code chrome contributes nothing. Rich diagram/HTML fences retain their GFM code
source as an atomic text block, independent of preview labels and controls.

Locate exact text in the original section first. Prefer both prefix/suffix,
then one, then neither; break ties by distance from UTF-16 `start`, then document
order. A page-wide move requires one exact occurrence. Otherwise keep a
`section_only` pin if the original section exists, or show an `orphaned` snapshot.
Section anchors fall back to a unique matching title. Reads compute these states;
page writes never rewrite comment anchors. The Go and real WikiMarkdown DOM
suites share `server/internal/engineering/testdata/anchors.json`.

The default right column remains the outline. Selection, a count bubble, a
highlight click or `?page=&section=&thread=` opens discussion. Selections stop
at their starting section; Ctrl/Cmd+Alt+M also opens a comment. CSS Custom
Highlight paints ranges without modifying the reader DOM. Resolved threads are
hidden from highlights and available in the resolved filter. Narrow containers
use an opaque, keyboard-contained drawer; Escape returns to the outline.

## Explicit wake and isolation

After the Wiki comment commits, parse only its original body with
`util.ParseMentions`. Without an explicit agent/squad mention outside code,
there are zero carrier Issues, Issue comments and tasks. Editing never wakes.
With explicit targets, reuse `carrier_issue_id` or lazily create one through
`IssueCreateOpts.BaselineThreadID`. The helper locks project then thread and
binds the carrier inside the creation transaction. It chooses the first
unstarted workflow step without an effective handoff and leaves it unassigned.
Concurrent mentions reuse one carrier. No finalize-time enqueue plug is added.

Copy only this comment into the carrier, prefixed with inert page/section/quote
snapshots, a deep link and CLI read/reply/write instructions. All user text in
the header passes through `AnnotationTicketText`; only the original body has
active mentions. Existing `triggerTasksForComment` handles permissions,
readiness, deduplication and squad routing. `woke` describes individual outcomes;
a dispatch failure never rolls back the Wiki comment.

`project_baseline_comment:changed` carries only `{project_id,page_id,thread_id}`.
Clients refresh that page's thread list, the named thread and the page footer;
they do not invalidate the tree. `tree`, plain page reads and all four claim
paths contain no comments, thread IDs or comment counts. Related issues union
the last 20 revision source issues and last 20 carrier issues, deduplicated and
scoped to the same workspace/project.

## Migrations and verification

Only new migrations are added: `9071_labrastro_baseline_comment_tables`, then
`9072_labrastro_baseline_thread_identity_index`,
`9073_labrastro_baseline_thread_page_index`,
`9074_labrastro_baseline_comment_identity_index`, and
`9075_labrastro_baseline_comment_thread_index`. Every index has its own concurrent
statement and registered recovery hooks. There are no foreign keys, legacy
backfills or `legacy_agent` authors. Resolution's three fields are all set or
all NULL. Project/workspace teardown removes both tables' scoped rows.

Focused suites cover migration up/down and invalid-index recovery, author/admin
boundaries, malformed credentials, project isolation, anchor movement, limits,
empty-thread deletion, cascade cleanup, ordinary-comment zero side effects,
concurrent carrier creation, inert snapshots, blocked dispatch persistence and
byte-identical claim context. CLI tests cover all eight commands and pre-network
validation. Frontend tests cover schema failures, precise realtime invalidation,
selection endpoints, editor retry, edit/delete/resolve/reopen and shared fixtures.
`e2e/labrastro-wiki-comments.spec.ts` exercises real API/WS/editor integration,
unchanged reader DOM, two live views, resolved highlights and narrow deep links.
