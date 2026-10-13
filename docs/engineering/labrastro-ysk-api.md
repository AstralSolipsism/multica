# You should know: server API

Implements OL-187 section 13, server work OL-188. The daemon adapter owns version
checking, mod installation and keeping this side channel out of the main agent
conversation. Frontend clients own presentation, response schemas and personal
preference handling.

## Claim and report

The capability constant is `protocol.DaemonCapabilityYouShouldKnowV1`
(`you-should-know-v1`). Both claim endpoints add `task.you_should_know` only for
Claude issue runs when the request advertises this capability and workspace
`settings.you_should_know_enabled` is explicitly `true`. Batch claims put this
field on each eligible entry in `tasks`. Ordinary task APIs omit it.

The version 1 context uses the shape in OL-187 B, implemented by
`protocol.YouShouldKnowContext`. `anchor_comment_id` is a UUID or `null`;
`existing_tips` and `known_topics` are always arrays. The latest non-deleted member
comment is limited to 500 Unicode code points. Known topics belong to
`attribution.initiator` (`accountable_user_id`), scoped to this workspace, newest
first, up to 50. An unattributed run gets an empty array.

`POST /api/daemon/tasks/{taskId}/tips` accepts OL-187 D unchanged and returns
`204` without tip content. Daemon credentials must match the task runtime;
PAT/JWT fallback requires the runtime owner and workspace membership. Agent
task tokens cannot authenticate on the daemon API.

Reports for disabled workspaces, ineligible/terminal runs, or changed/deleted
source comments are discarded. Malformed reports and invalid tips are logged
without logging their content. Within a valid report, invalid tips/overturns are
discarded individually. Length limits count Unicode code points (40/12/200).
Each run can persist at most three light tips and one heads-up, including under
concurrent requests. A repeated `(task_id, tag, line)` is a no-op. Overturns only
affect valid tips from earlier runs on the same issue and preserve the reporting
task, its trigger comment and the reason. Storage failures return a server error.

## Human APIs

These routes require workspace membership and reject machine credentials with
`403`, including `mat_` tokens. The workspace comes from the usual request
context (`X-Workspace-ID` or slug).

- `GET /api/issues/{issueId}/tips?status=valid|all`: defaults to `valid`;
  accepts the usual issue UUID or identifier.
- `GET /api/tips/active`: valid tips on issues with a running user agent, with
  the same running-task criteria as `/api/working-agents` for issue work. A
  dedicated query selects distinct running issue IDs first and looks up their
  tips through the workspace/issue index; completed issues' valid history is
  not scanned on each refresh.
- `POST /api/tips/{tipId}/state`: accepts OL-187 G's `state` and optional nullable
  `feedback`. Returns the personal event payload described below. `known` stores
  the tip's `line` as a topic, refreshing duplicates and retaining the latest 50
  per workspace/member. `dismissed` does not change known topics.

Both GET routes return `{ "tips": [...] }`, newest first. Tips from one
report carry strictly increasing `created_at` in report order
(`9024_labrastro_ysk_tip_created_at` defaults both timestamp columns to
`clock_timestamp()`, so consecutive inserts in the same transaction differ at
microsecond granularity); the RFC3339Nano `created_at` strings preserve those
digits and clients should compare them at full precision — parse them first,
not string-compare, since trailing zeros are trimmed (`.173Z` sorts after
`.173221Z` as text). Each tip has:

```ts
type Tip = {
  id: string; workspace_id: string; issue_id: string; issue_identifier: string;
  task_id: string; agent_id: string; anchor_comment_id: string | null;
  tag: "you_should_know" | "heads_up";
  line: string; title: string; explanation: string;
  status: "valid" | "overturned" | "source_changed";
  overturned_by_task_id: string | null;
  overturned_by_comment_id: string | null;
  overturned_reason: string | null;
  created_at: string; updated_at: string;
  user_state?: {
    state: "known" | "dismissed";
    feedback: "helpful" | "not_relevant" | "not_understood" | null;
    updated_at: string;
  };
};
```

GET results include the current viewer's state without filtering out dismissed
or known tips. Clients can use that state for rotation and keep the full archive.
The `you_should_know` notification preference accepts `all`/`muted`, defaults to
`all`, and affects presentation only. No tip data is added to issue, comment,
timeline, ordinary task, or CLI projections.

## Events and lifetime

`issue_tip:created` and `issue_tip:updated` carry `{ "tip": Tip }` with no
`user_state`, and use the same workspace broadcast as `comment:created`.
Consumers must preserve personal state when applying a shared update.

`issue_tip_state:changed` goes only to the affected user's connections, including
other devices and other tabs in this workspace. Its payload is:

```ts
type TipStateChanged = {
  workspace_id: string; issue_id: string; tip_id: string; user_id: string;
  state: "known" | "dismissed";
  feedback: "helpful" | "not_relevant" | "not_understood" | null;
  updated_at: string;
};
```

Comment edits and deletes invalidate anchored tips in the same transaction and
publish updates only after commit. Deleted comments keep their historical UUID
on the tips, including when the comment becomes a thread tombstone.

Source-change detection currently has a conservative admission boundary: a
comment's `updated_at` later than task dispatch rejects new reports. Resolving
or reopening a comment also advances that timestamp, so it rejects subsequent
reports from an already running task while leaving existing tips valid. Editing
comment attachments invalidates tips through the comment revision; standalone
`DELETE /api/attachments/{id}` does not change that revision or invalidate tips.

Issue deletion removes tips and their personal states; workspace deletion removes all
YSK data; member removal clears that member's states and topics. The independent
known-topic list survives an individual issue deletion.

Tables and indexes are installed by `9016_labrastro_ysk` through
`9024_labrastro_ysk_tip_created_at`. All indexes have their own concurrent
migration and recovery registration. There are no foreign keys or cascades.
