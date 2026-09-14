# Autopilots

An autopilot is not an agent. It is a rule that dispatches work to an agent, or
to a squad's leader agent.

## Core model

The chain is: trigger fires (`schedule`, `webhook`, or `manual`) → an autopilot
run is recorded → `execution_mode` decides the output → assignee readiness check
→ issue/task execution → run status sync.

Webhooks have a durable admission step in front: HTTP ingress stores a queued
webhook delivery, synchronously creates or reuses its idempotent run, and
returns `200` with `status=accepted|skipped` plus `run_id`; a leased worker then
resumes accepted runs and owns recoverable issue/task dispatch.

Execution modes:

- `create_issue` creates a Multica issue, making the run visible as issue state.
- `run_only` creates an agent task directly. No issue is created; any durable
  report location has to come from other task context or instructions.

`issue-title-template` only supports `{{date}}`. Do not invent `{{trigger_id}}`,
`{{branch}}`, or other variables.

## CLI

```bash
multica autopilot list --output json
multica autopilot get <autopilot-id> --output json
multica autopilot create --title "<title>" --description "<task prompt>" --agent <agent-name-or-id> --mode create_issue|run_only --output json
multica autopilot update <autopilot-id> --status active|paused --output json
multica autopilot runs <autopilot-id> --output json
multica autopilot trigger-add <autopilot-id> --kind schedule --cron "0 9 * * *" --timezone Asia/Shanghai --output json
multica autopilot trigger-add <autopilot-id> --kind webhook --label "ci" --output json
multica autopilot trigger <autopilot-id> --output json
multica autopilot trigger-rotate-url <autopilot-id> <trigger-id> --yes --output json
```

Do not run `trigger`, `delete`, `trigger-delete`, or `trigger-rotate-url` to
test — those are real side effects. Use `trigger` only when the user explicitly
asks for a manual run, and `trigger-rotate-url` only when rotating a webhook
URL; the old URL stops being valid immediately.

`trigger` exits non-zero when the run did not start. Only `issue_created` and
`running` mean work was dispatched; a `skipped` run — admission refused, runtime
offline, quota exhausted, a duplicate already in flight — dispatched nothing, and
its `failure_reason` says which. Do not report a manual run as done without
seeing one of those two statuses.

A schedule trigger without `--timezone` runs in **UTC**. Name the zone whenever
a human confirmed a wall-clock time, or they will confirm a morning job and
receive an afternoon one.

`autopilot get` redacts `webhook_token`, `webhook_path`, and `webhook_url` by
default while reporting whether a token exists and its non-sensitive hint. Only
add `--show-secrets` when the user explicitly asks to retrieve the live webhook
credential; the command warns on stderr. Do not paste webhook tokens or signing
material into comments, logs, docs, or PRs.

## Debugging "why didn't it run"

Manual dispatch runs as the member who requested it. Schedule/webhook dispatch
runs as the trigger's recorded member principal; ordinary edits do not transfer
that identity. Labrastro leaves legacy triggers without a member principal
unresolved instead of inferring authority from the autopilot creator. Such a
trigger stays skipped until an authorized member recreates it; recreating a
webhook changes its URL. A receipt alone does not prove a task executed: read the
run's status and failure reason.

1. `multica autopilot get <id> --output json` — status, mode, assignee, triggers.
2. `multica autopilot runs <id> --output json` — run status and failure reason.
3. If assigned to a squad, inspect the squad: `multica squad get <squad-id> --output json`; execution goes to the leader.
4. Inspect the target agent/runtime: `multica agent get <agent-id> --output json` and `multica runtime list --output json`.
5. For webhooks, inspect delivery status: `queued` means the worker has not completed dispatch; `failed` carries the worker error. A provider retry with the same `X-GitHub-Delivery` / `Idempotency-Key` reuses the original delivery.
6. For `create_issue`, inspect the created issue if the run records one.

## Webhook filter suggestions and draft matching (authenticated API)

`GET /api/autopilots/{id}/deliveries/{deliveryId}` includes a detail-only
`filter_context`. To preview a complete draft, pass `event_filters` once as a
URL-encoded JSON array using the same `{event, actions?}` shape as trigger
create/update. For example, the query value before URL encoding is:

```json
[{"event":"workflow_run","actions":["requested"]},{"event":"workflow_run","actions":["success"]}]
```

The request path is:

```text
GET /api/autopilots/{id}/deliveries/{deliveryId}?event_filters=%5B%7B%22event%22%3A%22workflow_run%22%2C%22actions%22%3A%5B%22requested%22%5D%7D%2C%7B%22event%22%3A%22workflow_run%22%2C%22actions%22%3A%5B%22success%22%5D%7D%5D
```

For a stored GitHub delivery with `X-GitHub-Event: workflow_run` and raw body
`{"action":"completed","conclusion":"success"}`, the relevant response fields
are below (other existing delivery fields are unchanged):

```json
{
  "event": "github.workflow_run.completed",
  "filter_context": {
    "suggestion": {"event":"workflow_run","actions":["completed","success"]},
    "matches": true
  }
}
```

The server reuses `normalizeWebhookPayload` on the stored raw body and captured
headers, just as the delivery worker does. It then uses `splitWebhookEvent` and
`webhookActionCandidates` to produce the suggestion; it does not split the
delivery metadata's `event` independently or invent future events. The optional
preview calls `webhookEventAllowedByTriggerScope` with that same envelope and
the full draft. Frontends consume this result instead of duplicating these rules:

- Known prefixes `github`, `gitlab`, `bitbucket`, and `gitea` are stripped from
  the filter event name. Remaining dot-separated suffix segments form one action.
  For other prefixes the first segment is the event: `stripe.charge.succeeded`
  suggests event `stripe` and action `charge.succeeded`. An unqualified `custom`
  remains event `custom`. Prefixes and values are case-sensitive.
- Candidate actions are the event suffix plus string values from **only** the
  normalized payload's top-level `action`, `state`, `conclusion`, and `status`.
  Values are trimmed, empty values discarded, duplicates removed, and the result
  sorted lexicographically. Nested fields, array elements, non-string values and
  fields outside an explicit `eventPayload` do not contribute candidates.
- Multiple candidates are alternatives (OR), not simultaneous conditions or a
  priority order. Multiple rows, including rows with the same event, also use OR.
  Draft strings are validated but not trimmed or case-folded by the matcher.
- With no action candidates, the suggestion is `{"event":"custom"}`: omitted,
  null or empty `actions` means **any action for that event**, not “no action”.
  A restrictive non-empty action list cannot match a delivery with no candidates.
- Omitting the query means suggestion only (`matches: null`). `event_filters=[]`
  explicitly previews unrestricted event scope. This never reads the saved filters
  as a fallback. Saving still uses the existing trigger create/update endpoints
  and their existing authorization, validation and publication behavior.
- An absent raw body yields `suggestion: null`, `matches: null`, and
  `unavailable_reason: "raw_body_missing"`. An invalid JSON body or a top-level
  scalar/null raw body similarly yields `raw_body_invalid`. Neither case returns
  a guessed match, even for `[]`. Detail still returns HTTP 200 for inspection.
- A valid envelope with null, scalar, or array `eventPayload` is normalizable;
  only its event suffix can supply an action. If splitting yields an empty or
  whitespace-only event name (e.g. event `github`), the suggestion is null with
  `unavailable_reason: "event_empty"`; a supplied draft still gets the real
  matcher result, so an unrestricted draft can match.

`matches` tests only event/action scope. It does not predict execution admission:
signature rejection, a paused autopilot, a disabled trigger, permissions, quota,
concurrency and other dispatch gates still apply. Suggestions from a rejected
delivery do not establish trust in its sender.

The route keeps authenticated workspace membership and task-token workspace
binding. It loads the autopilot and delivery within that workspace, verifies the
delivery's autopilot and source webhook trigger, and accepts no alternative
trigger or payload input. There is no additional write grant for preview: anyone
who can read that delivery can inspect these derived fields. It neither replays
the delivery nor writes a trigger, delivery, rule version, run, or task. List and
replay responses omit `filter_context`.

Errors use the existing `{"error":"..."}` shape:

| HTTP | Condition |
| --- | --- |
| 400 | Malformed resource/workspace UUID; repeated, missing-value, null, non-array or malformed `event_filters`; blank event/action or wrong field type. `[]` is the explicit empty draft. |
| 401 | Unauthenticated request. |
| 404 | Unavailable workspace/autopilot/delivery, delivery from another autopilot/workspace, or missing/mismatched/non-webhook source trigger. No delivery content is returned. |
| 500 | Delivery or source-trigger database lookup failure. |

`filter_context` is additive and absent on older servers. The frontend follow-up
must extend its API schema/type, preserve nullable results, and treat absent or
malformed context as unavailable; it must not fall back to guessing from raw JSON.

## Access

Reads (list / get / runs / deliveries) are open to any workspace member, but
`get` redacts the webhook token for callers without write access — the token
alone can trigger the autopilot.

Editing, deleting, triggering, replaying deliveries, and managing
triggers/webhook secrets require the autopilot's creator, a workspace
owner/admin, or an explicit collaborator. Granting or revoking a collaborator is
narrower still: creator or workspace owner/admin only, so a granted collaborator
keeps write/execute but cannot re-grant or revoke peers. `get` stamps two
per-caller booleans — `can_write` and the narrower `can_manage_access` — read
those rather than inferring from role.

When YOU do any of this — `trigger`, `create`, `update`, `delete`, the
`trigger-*` commands, or a webhook-secret or collaborator change over the API —
the request is authorized as the human who asked you to (your run's originator),
not as the owner of the machine you execute on, whose grants are not consulted.
So the person who gave you the instruction needs that write access, and you
cannot change or trigger an autopilot they could not themselves. The same human
is stamped into what you write: an autopilot you create is theirs, and a trigger
you add fires as them for as long as it exists.

A run that carries no originator cannot write here at all: the server
answers `403` naming the missing originator rather than failing quietly, and the
CLI prints that reason instead of a generic permission error. Reads are
unaffected — except that `get` redacts the webhook token unless the human you
act for may write, since holding that token is equivalent to being able to
trigger.

## Side effects

These mutate durable state or start work: `create`, `update`, `delete`, trigger
add/update/delete/rotate, `trigger`, and webhook calls to
`/api/webhooks/autopilots/{token}`.
