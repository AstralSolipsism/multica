# Issues

Product contracts the runtime brief does not fully encode.

- [PR linking and close intent are two distinct contracts](#pr-linking-and-close-intent-are-two-distinct-contracts)
- [Reading a linked PR's real state](#reading-a-linked-prs-real-state)
- [Custom properties: typed workflow state](#custom-properties-typed-workflow-state)
- [Status changes have server side effects](#status-changes-have-server-side-effects)
- [Explicit prerequisites and execution admission](#explicit-prerequisites-and-execution-admission)
- [Claim ownership without duplicating a run](#claim-ownership-without-duplicating-a-run)
- [Who else is running right now](#who-else-is-running-right-now)
- [Sub-issues: todo starts work now, backlog parks it](#sub-issues-todo-starts-work-now-backlog-parks-it)
- [External Feishu conversations](#external-feishu-conversations)
- [Incorrect to correct](#incorrect-to-correct)

## External Feishu conversations

In an explicitly authorized Feishu conversation, speakers may have no Labrastro
account. Their message/sender/chat IDs are source evidence, not member identity.
The designated agent receives a workspace-scoped integration grant with a real
human grantor; ordinary task-token and private-agent invocation rules still
apply. Notification receipts and frozen reports supply context only.

Clarify the intended task/discussion when it is missing or ambiguous. Then use
the normal `multica issue comment add --content-file <path> --parent <comment-id>`
path to post as the agent, retaining important original wording and external
message sources. Do not claim a platform member personally submitted or approved
the feedback. A report question does not by itself request an automation rerun
or a new issue; a bare “yes/可以/继续” does not approve a batch of changes.

Receiving a message does not directly create a comment. The comment API has no
idempotency key: after a lost submission response, inspect existing comments
and run provenance before blindly repeating the write. Grant revocation stops
new authorized tool calls; it cannot undo side effects already accepted.

## PR linking and close intent are two distinct contracts

The GitHub webhook runs two separate scans over an incoming PR. They are not the
same gate and they read different fields.

**Linking** scans the PR **title, body, OR branch** for a routable issue key
(`PREFIX-NUMBER`, e.g. `MUL-123`). Each match writes an issue to PR link row.
This is the link that `multica issue pull-requests` reads back — but see the
reference-only rule below: a key that appears **only** as a bare mention in the
body is linked yet hidden from that list.

```text
MUL-123: add the thing the issue asks for        # title prefix → links, shown
agent/dana/mul-123-add-the-thing             # branch ref   → links, shown
```

**Close intent** is stricter and is a separate scan over **title or body only —
never the branch**. It fires only for a key placed immediately after a closing
keyword (`Closes` / `Fixes` / `Resolves`, optional `:` then whitespace). That
adjacency is what sets the link row's close-intent flag, the gate that
auto-advances the issue to `done` when the PR merges.

```text
Closes MUL-123                                    # links AND records close intent
Fixes MUL-123
Resolves MUL-123
Fix login MUL-123                                 # links only — keyword not adjacent
```

Consequence: a bare title prefix or a branch reference links the PR but does not
close the issue on merge. A closing keyword immediately adjacent to the issue key
records close intent; on merge, that close intent can move the linked issue to
`done`.

**Reference-only links (hidden from the PR list).** A key that appears **only**
as a bare mention in the body — no closing keyword, and not in the title or
branch — still writes a link row, but the row is flagged `reference_only` and
**excluded from `multica issue pull-requests`** (and the issue's right-side PR
list in the UI). This keeps passing mentions like `Related MUL-123` or
`Follow up in MUL-123` from surfacing an unrelated PR as if it were working on
that issue. To make a PR show up for an issue, put the key in the title, the
branch, or after a closing keyword in the body — not as a loose body reference.

```text
Closes MUL-123 in the body                        # links and shown
Related to MUL-123 in the body (no title/branch)  # links but reference_only → hidden
```

### Default for code-changing issue work

When an issue run changes code in a checked-out GitHub repo, the default handoff
is to open or update a PR before posting the final Multica issue comment, unless
the user explicitly asked for a local-only change or no PR. This is a default, not
an unconditional command: if no code changed, say no PR is needed; if PR creation
is blocked by auth, failing tests, or missing remote state, report that blocker
instead of pretending the run is complete.

Use a routable issue key in the PR title, body, or branch so the webhook can link
the PR back to the issue. If the PR should close the issue on merge, put the key
immediately after a closing keyword in the title or body, for example:

```text
MUL-123: fix login redirect        # links only
Closes MUL-123                     # links and records close intent
```

In the final issue comment, include the PR URL when a PR exists. If the task did
not produce a PR because no code changed or the user asked not to create one, say
that explicitly.

## Reading a linked PR's real state

When a step depends on PR state, query Multica's link table — do not infer it
from branch names, GitHub search, memory, or stale values left on the issue by
an earlier run.

```bash
multica issue pull-requests <issue-id> --output json
```

Returns `{"pull_requests": [...]}`. Each element exposes:

- `number`, `html_url`, `title`
- `state` — the PR lifecycle as a **single enum**, one of `merged`, `closed`,
  `draft`, `open`. There is no separate `draft` or `merged` boolean in the
  response; the server folds them into `state` (merged wins, then closed, then
  draft, else open).
- `merged_at` — non-null once merged; a second confirmation of `state: merged`.
- `provider` — `github`, `forgejo`, `gitea`, or `gitlab`.
- `mergeable_state` — mirrors GitHub (`clean` / `dirty` surfaced; other values
  round-trip as unknown; retained for compatibility).
- GitHub API snapshot fields: `snapshot_available`, `mergeable`,
  `merge_state_status`, `checks_rollup`, `checks_total`, `checks_passed`,
  `checks_failed`, `checks_running`, `failed_check_names`,
  `snapshot_fetched_at`, and `snapshot_stale`. `snapshot_available == true`
  means the feature is enabled and the snapshot matches the PR's current head.
  Only then does `checks_rollup == null` mean "no checks"; false means the
  snapshot feature is disabled, has not fetched yet, or only has an old head.
- `checks_conclusion` — coarse CI compatibility status: `passed`, `failed`,
  `pending`, or `null`. GitHub derives it from the current API snapshot;
  Forgejo/Gitea/GitLab derive it from webhook commit statuses. Backed by the
  provider-appropriate check counts.

So "is it merged?" is `state == "merged"` (or `merged_at != null`); "is it still
a draft?" is `state == "draft"`; coarse CI status is `checks_conclusion`.

If the command returns no linked PRs after a PR was opened, the link scanner did
not observe a routable issue key in the PR title/body/branch — or the only match
was a bare body mention, which links as `reference_only` and is hidden from this
list (see the reference-only rule above).

## Custom properties: typed workflow state

Workspaces may define custom issue properties (Severity, Environment, QA
Status, Reviewer, ...). They are the place for durable, typed issue state:
values are validated against the definition (select options, date format,
http(s) URL, member reference), visible in the issue sidebar, and addressed
by name.

- Read what exists before writing: `multica property list` shows the catalog;
  `multica issue property list <issue-id>` shows values set on the issue.
- Set values by property name and option name — the CLI translates to ids:

```bash
multica issue property set <issue-id> --name Environment --value staging
multica issue property set <issue-id> --name Platforms --value "iOS,Android"
multica issue property set <issue-id> --name Reviewer --value Bohan
multica issue property unset <issue-id> --name Environment
```

- A validation error lists the legal options — fix the value and retry.
- `actor` / `multi_actor` properties (Reviewer, Escalation contact, ...) hold
  workspace members only. `--value` takes a member name, email, UUID, short id,
  or an explicit `member:<uuid>`; `multi_actor` takes a comma-separated list
  (duplicates dropped, order kept, max 20).
- Definitions may include an optional catalog icon for visual identification;
  it does not change the property's type or value validation.
- Agents cannot create or edit property definitions (owner/admin humans only).
  If a needed property does not exist, propose it in a comment instead.
- Where state belongs: workflow state a human should see and filter by goes in
  a property; the stage the issue is at goes in its status; everything else —
  what you did this run, what you found — goes in the result comment.
- `issue list` filters and sorts by property with the same name addressing:

```bash
multica issue list --property "Impact=High" --property "Impact=Medium" --output json
multica issue list --property "QA Status=__none__" --status in_review --output json
multica issue list --sort property:Impact --direction desc --output json
```

- `--property` takes one `Name=Value` per flag. Repeating the same property
  matches ANY of its values; different properties must ALL match. Values are
  option names or ids (select types), `true`/`false` (checkbox), a member
  name/email/id (actor types), or the value itself for text, url, number,
  and date (`YYYY-MM-DD`). The reserved value `__none__` matches
  issues where the property is unset (works for every type; it is not
  index-backed, so use it for targeted audits rather than as a default
  listing filter). Only `=` is supported today; the `>=`, `<=` and `!=`
  spellings are reserved for comparison filters and are rejected.
- `--sort property:<name-or-id>` orders select properties by option order —
  an ordinal scale (Low < Medium < High) sorts by meaning — and number/date/
  text/url by value; issues without the property sort last either way.
  Archived properties and types without an order (multi_select, checkbox,
  actor kinds) are rejected up front.
- `issue list` and `issue get` return `properties` as a map of definition id
  to stored value. Add `--resolve-properties` in JSON mode to get the rows
  `issue property list` prints instead (name, type, stored value, display
  names); the CLI makes at most one catalog request for the whole page, so
  no `property list` call is needed:

```bash
multica issue list --status in_progress --output json --resolve-properties
multica issue get <issue-id> --resolve-properties
```

  Read `display` for a single value and `display_values` for a multi_select
  or multi_actor value; `value` keeps the stored ids.

## Status changes have server side effects

A status change is not cosmetic — the server enqueues or skips agent work based
on it. These are the contracts, not advice.

Read them as category rules: a custom status inherits its category's behavior in
full. Two writes are literal-key exceptions, not category rules — the failed-task
rollback below writes the literal `todo` key, and a merged PR with close intent
writes the literal `done` key.

- **`backlog`** parks an agent-assigned issue: the assignee is set but no task
  fires. Moving `backlog → todo` (or any non-done/non-cancelled status) enqueues
  the assigned agent then.
- **`in_progress` / `in_review`** are agent-managed CLI mutations, not automatic
  side effects of a task starting or finishing. The runtime brief asks agents to
  write the state the issue is in whenever their work changes it — not from
  the trigger type or the run's lifecycle, and not gated on being the
  assignee. Writes happen whenever the state changes, mid-turn included: a
  turn that advances the issue's own ask sets `in_progress` as soon as that
  is known, so the board shows the work while it runs; a blocker is recorded
  when it is hit; and the turn must not exit with a stale value — delivered
  the issue's own ask → `in_review`; work continues beyond the turn
  (dispatched sub-issues, partial delivery) → `in_progress`; stuck →
  `blocked`. A turn that produces none of the issue's own deliverable —
  answering a question, consulting on work owned elsewhere — writes nothing
  at any point. The kind of activity never decides this: research, design,
  planning, and review all count as the work exactly when they are what the
  issue asks for (a review-the-PR issue is being worked the moment reviewing
  starts). Questions, discussion, or acknowledgements never move the status.
  Squad leaders: dispatching members is not delivery — a dispatch turn
  leaves the parent `in_progress`, and it moves to `in_review` only when a
  later re-trigger confirms the overall goal is met.
- **`in_review`** is an accepted issue status. Some workflows use it while a PR
  is open and awaiting review; moving to it is an explicit mutation.
- **`done`** on a child issue posts a system comment on its parent. If a PR
  carries close intent (`Closes MUL-XXXX`), it advances the issue to `done`
  itself on merge — you do not also need to flip it manually.
- **`cancelled`** is a terminal, user-driven decision to close the issue. Like
  `done` it enqueues no new agent work, but it does **not** stop tasks already in
  flight — a run in progress keeps going. To stop a running task, cancel the
  task itself.
- **Failed issue-triggered tasks** may roll an issue from `in_progress` back to
  `todo` when no active task / retry remains — that is the main server-owned
  status write on the agent-run path.

## Explicit prerequisites and execution admission

`GET /api/issues/{id}/dependencies` returns direct and inherited prerequisites,
direct successors, unfinished prerequisites, a restricted-blocker flag and an
opaque `dependency_version`. A task inherits the explicit prerequisites of its
ancestors; parentage alone does not block execution. Only each prerequisite's
own current effective `done` category satisfies it. Existing status-write
permissions remain unchanged; `in_review` and `cancelled` are not satisfaction.

Register known prerequisites when creating the plan. Parentage and stages do
not substitute for explicit dependency edges. These commands accept issue keys
or full UUIDs; repeat `--blocked-by` once per prerequisite (no `--depends-on`
alias). Cross-project prerequisites are allowed within one workspace.

```bash
multica issue create --title "Checkout API" --parent MUL-32 --stage 3 \
  --project <project-uuid> --blocked-by MUL-39 --blocked-by MUL-41 --status backlog
multica issue dependency list MUL-42 --output json
multica issue dependency add MUL-42 --blocked-by MUL-40
multica issue dependency remove MUL-42 --blocked-by MUL-40
multica issue update MUL-42 --blocked-by MUL-39 --blocked-by MUL-41
multica issue update MUL-42 --clear-blocked-by
```

`create` writes the issue, parent/project/stage, prerequisites and any allowed
dispatch together. `update --blocked-by` **replaces all direct prerequisites**;
it does not append. `--clear-blocked-by` explicitly clears them and is mutually
exclusive with `--blocked-by`. Omitting both leaves prerequisites unchanged.
`dependency add/remove` read the direct set and submit an edited set. All three
update forms carry the server version from that read; a conflict exits nonzero
without automatic rereading or retrying. Read again and decide before a new edit.
Inherited prerequisites are shown separately; edit their source issue to change
them. The CLI does not decide whether a prerequisite is complete or removable.

The compound API paths are
`POST /api/issues/with-dependencies` and
`PATCH /api/issues/{id}/with-dependencies`; writes use the same dependency
admission as enqueue, claim and retry.
The CLI fails explicitly on 404/405 (unsupported/disabled API or inaccessible
issue); it never falls back to ordinary create/update. On an older CLI that
does not recognize these flags, stop and report the missing capability. Never
omit dependencies to make creation or dispatch succeed. Commands without new
dependency flags keep their original HTTP paths and behavior.

`blocked_by` is an array of UUIDs/identifiers:
omission preserves direct relations, `[]` clears them, and `null` is invalid.
PATCH replacement requires `expected_dependency_version`; a stale version
returns 409. New machine assignments with unfinished prerequisites reject the
whole mutation, even for backlog or `suppress_run`. Unassigned backlog planning
is valid. Removing unfinished constraints, reparenting away from them or
deleting tasks to remove them requires a trusted human JWT; a PAT or task
credential is not a human override. This is not a new completion policy.

Errors expose `reason_code`: `dependency_unsatisfied`, `dependency_cycle`,
`dependency_ancestor_conflict`, `dependency_version_conflict`,
`dependency_change_not_allowed`, `dependency_override_not_allowed`,
`dependency_override_stale`, `dependency_override_expired`,
`dependency_data_unverified`, or `not_found`. Missing/malformed dependency data or hidden
unfinished prerequisites must never be interpreted as ready. No automatic
dispatch along arbitrary dependency edges is added.

Unverified historical relations keep dependency GET/compound writes unavailable
until the workspace is audited. Ordinary issue operations check their affected
parent/`blocked_by` component, so unrelated historical anomalies do not block
assignment, reparenting or deletion workspace-wide. `blocks` is not interpreted
as a prerequisite. Canonical constraints still apply with compound writes off;
an affected invalid canonical reference fails closed. A successful ordinary
operation does not mean the workspace is verified.

A human may preassign a blocked issue without starting it. To intentionally start
one execution early, a human JWT client must preview the exact complete mutation
with `POST /api/issues/preview-trigger` (`mutation`, plus `issue_ids` or
`is_create`), display every blocker, and submit the returned `request_id` and
`challenge` as `dependency_override` on the compound write. The challenge expires
in five minutes; first claim expires fifteen minutes after confirmation. Never
invent or infer confirmation from a comment, a PAT, an owner, or an originator.
Agents should report `dependency_unsatisfied` and propose backlog work or ask the
human for help. They must not replay a human session or confirmation themselves.
The mutation must be a JSON object. A malformed mutation (including `null`)
returns HTTP 400 `invalid mutation payload` before any write or confirmation;
correct the request body before retrying. Batch confirmations validate the
shared `updates` object before any item is written.

The committed response includes `dispatch`: `queued`, `coalesced`, `deferred`,
or `blocked`, with `reason_code` and task/run IDs when available. Identical
confirmation retries return the same execution. Modified input, later reruns,
provider retries, Squad members/children and ordinary comments need their own
normal admission. Comment saves remain successful when dispatch is blocked;
inspect `trigger_outcomes` rather than assuming a mention ran. Batch updates use
`dependency_overrides` keyed by issue ID and retain per-item results. Missing or
malformed outcome fields mean unknown, never permission to retry a write.

CLI `--output json` preserves the server's dependency and dispatch fields, and
dependency HTTP refusals print the structured error body on stdout with guidance
on stderr. `--output table` prints readable refusal guidance on stderr only;
choose JSON when a caller needs the structured error body. Keep the streams
separate. Issue error bodies are bounded at 1 MiB (other paths retain 4 KiB).
An oversized body produces a local JSON diagnostic with `body_truncated: true`,
`http_status` and `error`, not a partial server payload. Complete diagnostics
are unavailable; do not retry the write automatically. The HTTP failure and
its nonzero exit classification are preserved.
Exit codes retain the existing contract:
409/conflict = 1, 403/permission = 3, 404 = 4, 400/422 = 5; a 405 is 1.
`issue comment add` can exit 1 **after the comment was saved** when any
`trigger_outcomes` entry is blocked. Its JSON is the saved comment, including
the comment ID and all target outcomes, even when other targets did start.
Do not repost the comment or treat a nonzero exit as proof that no write happened.

When prerequisites are ready, advance the issue using ordinary assignment and
status commands under the existing stage/Squad/automation workflow. When
`dependency_unsatisfied` is returned, stop dispatching and suggest next steps or
request human handling. `--no-start` is not an exemption for a new machine
assignment. CLI task tokens, PATs and cloud PATs never become human authority
through an owner/originator, a header, a flag, or a confirmation string. This
CLI supplies no force/override flag; the explicit human interaction belongs to
the authenticated UI/API flow above.

## Complete issue graph: Stage 3 API contract

`GET /api/workspaces/{workspaceId}/issues/graph` reads a complete compact
snapshot in one read-only REPEATABLE READ transaction. The default includes
every project and unprojected/undated issue in the workspace. `project_id`
selects a project; URL-encoded `query` accepts the shared Issue Table query
spec with workspace/project scope and filters. There is no pagination or
scheduled-only default; unsupported parameters fail instead of truncating.
`focus_issue_id` locates one visible issue and its prerequisite/ancestor
context, even when filters exclude it; an excluded focus remains context.

The response has `schema_version: 1`, opaque `snapshot_id` and `topology_id`,
`captured_at`, `complete: true`, separate `matched_count`/`context_count`,
nodes, direct edges and project titles. Edges point from prerequisite to
dependent and retain the stored `source_edge_id`. Parent fields explain
inherited prerequisites. Collapsed project arrows are display projections;
opposing project arrows are not evidence of an Issue cycle.

Each node carries its revision, current effective status category, dependency
summary/version and actual queued/dispatched/running/waiting task counts.
`in_progress` alone is not a run. Restricted prerequisites still block, but
only boolean restricted-context/blocker/parent markers are exposed; no hidden
IDs, titles or counts. Current authorization is workspace membership, matching
ordinary issue reads. Graph reads recheck it inside the snapshot. Foreign
workspace/project/focus references are not readable. Invalid dependency data
returns 422; query failures/timeouts return 500/504, never a partial success.

Missing/malformed graph data is unavailable, not an empty graph or readiness.
Unknown run/dependency summaries remain unknown. Details loaded afterward do
not patch topology; changed revisions require a graph refresh. Shared React
Query helpers own this cache and existing committed events/reconnects
invalidate it. The shared invalidation helper cancels graph reads before
refetching, including an initial request with no cached snapshot, so a late
pre-event response cannot erase a committed change's refresh signal.
There is no graph CLI command or new navigation in this stage. Use the
complete graph endpoint for topology and the dependency endpoint for decisions.

## Claim ownership without duplicating a run

Assigning an active issue to an agent normally starts a run. When the work is
already underway and the write only records ownership or progress, pass
`--no-start` on every command in that flow:

```bash
multica issue assign <issue-id> --to-id <agent-id> --no-start
multica issue update <issue-id> --assignee-id <agent-id> --no-start
multica issue status <issue-id> in_progress --no-start
```

Before self-assigning, check the target issue's comment history for an existing
claim. The server also suppresses a trusted self-assignment when the exact
target `(issue, agent)` pair already has a non-terminal task, but it
deliberately keeps same-agent handoffs to a fresh issue starting runs:
cross-issue serial chains and triage batches rely on that.

## Who else is running right now

Nothing about concurrent runs is pushed into your prompt: the answer changes
while a turn is running, and most turns never need it. Ask the server on the
turns that do — before opening a PR against code a sibling issue also touches:

```bash
multica issue runs <issue-id> --active --output json     # in-flight runs on this issue
multica issue runs <issue-id> --siblings --output json   # ...and across the sub-issue family
```

`--active` drops the execution history and returns only `queued` / `dispatched`
/ `running` / `waiting_local_directory` runs. `--siblings` widens the same read
to the issue's family — its parent (or itself, when it has no parent) plus every
child of that parent — and labels each row with the issue it belongs to, which
is how you find another agent already working on a sibling sub-issue before you
open a second PR against the same code.

The family read returns a compact row — task, issue, agent, status, started —
not the full execution-log record. If you need a run's detail, follow the task
id with `multica issue run-messages`.

Rows come back running-first, newest-first within a status, and the family read
is capped at 20. When the cap truncates the answer the CLI prints a warning on
stderr — read it. Without that warning a short list means "nobody else is
there"; with it, the list proves nothing about the runs it did not return.

Both are advisory reads. Nothing here reserves an issue or serialises anything:
a run you see may finish a second later, and one you don't see may start a
second later. Coordinate through the issue's comments — the reads tell you whom
to coordinate with.

## Sub-issues: todo starts work now, backlog parks it

On an agent-assigned issue, create status decides whether the assignee fires
immediately. A non-backlog status (e.g. `todo`) enqueues the agent at create
time; `backlog` sets the assignee without triggering.

Parallel children — all start now:

```bash
multica issue create --title "..." --parent <issue-id> --assignee <agent> --status todo
```

Strictly serial children — park later steps, promote one at a time:

```bash
multica issue create --title "Step 2: ..." --parent <issue-id> --assignee <agent> --status backlog
multica issue status <child-id> todo   # promote when the previous step is truly done
```

Creating every serial step as `todo` enqueues the whole chain at once.

### Stages: order sub-issues into barrier groups

`--stage <N>` (N >= 1) groups sub-issues under the same parent into ordered
stages. The parent assignee is woken **once, when a whole stage finishes** —
i.e. every sub-issue in the lowest unfinished stage has reached a terminal
status (`done`/`cancelled`). A completion that does not close a stage is silent
(no comment, no wake). A sibling set with **no** stages is one implicit stage,
so the parent is woken once when the *last* sub-issue finishes — not on every
child.

Advancement is agent-driven: the server only detects the closed barrier and
wakes the parent assignee, who then decides whether to promote the next stage's
`backlog` sub-issues to `todo`.

```bash
# Stage 1 runs now; later stages parked until promoted
multica issue create --title "Research A" --parent <id> --assignee <agent> --stage 1 --status todo
multica issue create --title "Research B" --parent <id> --assignee <agent> --stage 1 --status todo
multica issue create --title "Build"      --parent <id> --assignee <agent> --stage 2 --status backlog
multica issue create --title "Ship"       --parent <id> --assignee <agent> --stage 3 --status backlog
```

When both Stage 1 sub-issues finish you (the parent assignee) are woken with a
"Stage 1 complete" comment. Inspect the layout, then promote the next stage:

```bash
multica issue children <parent-id>             # sub-issues grouped by stage
multica issue status <stage-2-child-id> todo   # promote when its deps are met
```

`issue children --output json` reports per-stage `done` counts. A custom status
counts as done here when its category is `done` or `cancelled`, which is what
`status_category` on each child carries. Read `status_category` rather than
matching `status` against the built-in names.

Read each sub-issue's description before promoting and only promote items whose
stated dependencies are met; if a description conflicts with the parent's
breakdown, leave it `backlog` and comment to confirm first.

## Incorrect to correct

PR title (link the issue):

```text
Fix login redirect                  # incorrect — no issue key, won't link
MUL-123: fix login redirect        # correct — links the PR
```

Serial / phased sub-issues (don't start the whole chain at once):

```bash
# incorrect — all fire immediately, no ordering
multica issue create --title "Step 2" --parent <issue-id> --assignee <agent> --status todo
multica issue create --title "Step 3" --parent <issue-id> --assignee <agent> --status todo

# correct — stage them; Stage 1 runs, later stages park and are promoted as
# each stage's barrier closes
multica issue create --title "Step 1" --parent <issue-id> --assignee <agent> --stage 1 --status todo
multica issue create --title "Step 2" --parent <issue-id> --assignee <agent> --stage 2 --status backlog
multica issue create --title "Step 3" --parent <issue-id> --assignee <agent> --stage 3 --status backlog
```
