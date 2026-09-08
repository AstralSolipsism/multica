# Labrastro Message Delivery — Backend Contract (OL-25)

This is the API/contract reference for the standalone result-delivery module
("自动化结果投递"): automation runs finish → saved rules push the result to
Feishu → deliveries and receipts are queryable and retryable. Frontend work
MUST read this document and must not guess field names, statuses or error
codes. Code lives in:

| Path | Responsibility |
| --- | --- |
| `server/internal/messagedelivery/` | decisions, content normalization, send worker, compensator |
| `server/internal/handler/labrastro_message_delivery.go` | HTTP surface |
| `server/internal/integrations/lark/labrastro_delivery.go` | Feishu proactive send (open_id / chat_id / topic reply + fixed UUID) |
| `server/cmd/server/labrastro_messaging.go` | the single assembly point (sender selection, EventBus wakeup) |
| `server/pkg/db/queries/labrastro_message.sql` | all SQL; generated code via `make sqlc` |
| `server/migrations/452…458_labrastro_*` | tables + concurrent indexes |

## Concepts

- **Route** (`labrastro_message_route`) — a saved rule: one automation
  (autopilot), one bot installation, one target, a condition and a content
  mode. Writes are revision-guarded (`expected_revision`); a stale save is a
  409, never a silent overwrite. Only enabled rules decide, and only for runs
  completing at/after the rule's `effective_from` (set at creation, reset at
  every enable — re-enabling never backfills the disabled window).
- **Delivery** (`labrastro_message_delivery`) — one immutable DECISION per
  `(source event, normalized target)`, keyed by `dedup_key`
  (`run:<run_id>:<installation_id>:<target_key>`). Created exactly once per
  key across concurrent enqueuers and replicas. Content and target are frozen
  snapshots at decision time; later rule edits never rewrite an enqueued
  message.
- **Receipt** (`labrastro_message_receipt`) — one row per message shard with
  a FIXED `send_uuid` (idempotency key) and the platform's
  `external_message_id` (unique per installation, traceable back to the
  source for the feedback stage).

### Delivery statuses

| status | meaning |
| --- | --- |
| `queued` | decided, waiting to send |
| `sending` | lease held, HTTP call in flight (crash → `uncertain`, never silently back to `queued`) |
| `sent` | every shard accepted, receipts recorded |
| `failed` | definitive failure; `error_code` says why |
| `uncertain` | the send may have landed (lost response / lost receipt / crashed claim); only manual verify-and-retry resolves it |
| `cancelled` | route disabled/deleted, source archived/deleted, or installation revoked before the send started |
| `suppressed` | condition mismatch (incl. skipped runs); recorded so the source is not rescanned |

### Source semantics

- `run_only` (`source_kind="run_only"`): delivers the run's terminal state.
  `content_mode=with_output` includes the final output **only** — the
  extracted `output` string from the task completion payload. Session ids,
  work dirs, branch names and the raw result JSON are never sent, logged, or
  returned. Empty output renders `(no report body)`. Failed runs show a
  curated `reason_code` when one exists, never the raw error text.
- `create_issue` (`source_kind="create_issue"`): delivers the FIRST terminal
  state and a task link (`{appURL}/{workspaceSlug}/issues/{IDENTIFIER}` —
  workspace-scoped per the frontend conventions). The first-terminal status
  is frozen by the run terminal sync (`SyncRunFromIssue` persists it on the
  run); a run without that frozen signal — completed before it existed —
  degrades to wording that does NOT name a possibly-later status. Later
  issue status changes are not re-delivered by this module. The source kind
  comes from the run's persisted links, never the autopilot's current
  configuration. No report body is attached — attaching requires an
  explicit delivery-comment anchor (feedback stage).
- Manual **test sends** (`source_kind="test_send"`) run the real send path
  synchronously with a synthetic message and are recorded like deliveries.
- Send failures NEVER re-run or re-queue an automation; execution modes,
  quotas and the execution state machine are untouched.

### Target types

| type | saved fields | send addressing |
| --- | --- | --- |
| `member` | `target_user_id` | DM via `receive_id_type=open_id`, resolved live from `(workspace, installation, user)` binding immediately before every send |
| `group` | `target_chat_id` | `receive_id_type=chat_id` |
| `topic` | `target_chat_id` + `target_message_id` (+ optional `target_thread_id`) | reply to the anchor message with `reply_in_thread=true` |

Member binding is installation-precise. The legacy "most recent binding of
the channel" query is deliberately NOT used: with multiple bots in one
workspace it picks the wrong app.

### Approved external targets (workspace-admin consent)

Group and topic targets additionally require an ACTIVE approval scoped to
the exact **(workspace, automation, bot, target)** triple — approving
automation A's outbound target is never borrowed by automation B. Approval
and revocation are workspace owner/admin acts
(`POST|DELETE /api/autopilots/{id}/message-approved-targets`); approving
consents to sharing that automation's rule-permitted result content with
that target, nothing more. The route save and EVERY execution path (enable,
test-send, worker send, retry) check the approval — send-time checks key on
the delivery's FROZEN target identity. Revocation cancels queued sends;
platform-accepted requests are not recallable. Member targets stay out of
the approval table: their binding proves address ownership and the route
authorizer's source permission covers the sharing decision.

The current repair contract (round-2 review response, four boundaries,
acceptance matrix A1–E1) ships as `REPAIR-CONTRACT-v1.md` in this directory.

### Target verification (save-time AND send-time)

External group/topic targets are verified against the live platform before
a route referencing them may be SAVED and again before every send:

- **group**: the pinned bot must be able to see the chat (chat-info probe).
- **topic**: the anchor message must provably live in the declared chat; the
  VERIFIED chat id is what the route stores and sends against, so a
  declared-but-foreign chat can never redirect a topic reply. The
  anchor→chat relationship is re-proved at send time and a moved anchor
  fails the delivery with `route_topic_anchor_mismatch`.

A deployment without the channel transport has no way to verify and FAILS
CLOSED: group/topic saves return `route_target_unverifiable`. A
definitive platform refusal fails the save with `route_target_unreachable`.
An optional later test-send does not substitute for this check.

### Continuous authorization

A rule spends the authority of the member who LAST SAVED it (`updated_by`).
The send gate re-checks on every claim that this member is still a
workspace member AND still holds write on the source automation (owner/
admin, creator, or granted collaborator — the same predicate the HTTP gate
enforces at edit time). When authorization is lost, the delivery is
recorded as `cancelled` with `route_authorization_lost` and the rule
delivers nothing further until someone authorized edits it (which
re-stamps `updated_by` and re-arms the rule).

## HTTP API

All endpoints live under the authenticated workspace-scoped group and are
gated by the SAME autopilot write gate as the rest of the automation surface
(`requireAutopilotWrite` → an agent caller acts for its run's originator; no
resolvable human → 403 `autopilot_no_originator`). Config author, automation
authorizer and message recipient are distinct identities; `created_by` /
`updated_by` record the config author.

| Method & path | purpose |
| --- | --- |
| `GET /api/autopilots/{id}/message-routes` | list rules |
| `POST /api/autopilots/{id}/message-routes` | create rule (revision 1) |
| `PUT /api/autopilots/{id}/message-routes/{routeId}` | update rule, `expected_revision` required |
| `POST /api/autopilots/{id}/message-routes/{routeId}/enable` | enable/disable, `{"enabled":bool,"expected_revision":N}` |
| `DELETE /api/autopilots/{id}/message-routes/{routeId}` | delete rule (queued sends cancelled) |
| `POST /api/autopilots/{id}/message-routes/{routeId}/test-send` | real-path reachability check |
| `GET /api/autopilots/{id}/message-deliveries?status=&limit=&offset=` | records page (projection, no snapshots) |
| `GET /api/autopilots/{id}/message-deliveries/{deliveryId}` | detail incl. snapshots + receipts |
| `POST /api/autopilots/{id}/message-deliveries/{deliveryId}/retry` | re-queue a `failed`/`uncertain` delivery |

### Create rule — request / response example

`POST /api/autopilots/{id}/message-routes`

```json
{
  "installation_id": "9f1c…",
  "target_type": "member",
  "target_user_id": "0d4b…",
  "conditions": "success",
  "content_mode": "with_output",
  "enabled": true
}
```

`201`:

```json
{
  "route": {
    "id": "c1ab…",
    "workspace_id": "bc8c…",
    "autopilot_id": "0a77…",
    "installation_id": "9f1c…",
    "channel_type": "feishu",
    "target_type": "member",
    "target_user_id": "0d4b…",
    "target_chat_id": null,
    "target_message_id": null,
    "target_thread_id": null,
    "target_key": "member:0d4b…",
    "conditions": "success",
    "content_mode": "with_output",
    "enabled": true,
    "revision": 1,
    "created_by": "55e0…",
    "updated_by": "55e0…",
    "effective_from": "2026-09-08T02:30:00Z",
    "created_at": "2026-09-08T02:30:00Z",
    "updated_at": "2026-09-08T02:30:00Z"
  }
}
```

Group target: `"target_type":"group"`, `"target_chat_id":"oc_…"`.
Topic target: `"target_type":"topic"`, `"target_chat_id":"oc_…"`,
`"target_message_id":"om_…"`.

### Delivery record example

`GET …/message-deliveries` page items:

```json
{
  "id": "e452…",
  "workspace_id": "bc8c…",
  "route_id": "c1ab…",
  "route_revision": 3,
  "autopilot_id": "0a77…",
  "run_id": "77bd…",
  "source_kind": "run_only",
  "status": "sent",
  "attempts": 1,
  "next_attempt_at": "2026-09-08T02:30:01Z",
  "error_code": null,
  "last_error": null,
  "shard_total": 1,
  "installation_id": "9f1c…",
  "target_key": "member:0d4b…",
  "delivered_at": "2026-09-08T02:30:02Z",
  "first_attempt_at": "2026-09-08T02:30:01Z",
  "created_at": "2026-09-08T02:30:01Z",
  "updated_at": "2026-09-08T02:30:02Z"
}
```

Detail adds `content_snapshot` (`{"text","summary","run_status","has_output","link"}`),
`target_snapshot` (`{"target_type","channel_type","installation_id","user_id","open_id","chat_id","message_id","thread_id"}`),
`source_ref` (feedback anchors: `run_id`, `execution_mode`, `issue_id`,
`issue_identifier`, `issue_status`) and `receipts`:

```json
{
  "receipts": [
    {
      "id": "aa31…",
      "delivery_id": "e452…",
      "workspace_id": "bc8c…",
      "installation_id": "9f1c…",
      "shard_index": 0,
      "shard_total": 1,
      "send_uuid": "5c07…",
      "external_message_id": "om_9f2…",
      "created_at": "2026-09-08T02:30:01Z",
      "updated_at": "2026-09-08T02:30:02Z"
    }
  ]
}
```

### Error codes (stable strings; the human sentence is not contract)

| code | HTTP | when |
| --- | --- | --- |
| `route_invalid` | 400 | malformed rule payload; message names the field |
| `route_installation_invalid` | 400 | installation missing from workspace or revoked |
| `route_member_not_bound` | 400 | member target has no binding on this installation |
| `route_target_not_member` | 400 | member target is not a workspace member |
| `route_not_found` | 404 | route id not in this workspace/automation |
| `route_revision_conflict` | 409 | stale `expected_revision` |
| `route_already_exists` | 409 | equivalent rule already exists |
| `route_target_unverifiable` | 400 | no channel transport is wired to verify the external target; nothing was saved |
| `route_target_unreachable` | 400 | the bot definitively cannot reach the declared chat; nothing was saved |
| `route_topic_anchor_mismatch` | 400 | the anchor message provably lives in a different chat; nothing was saved |
| `route_disabled` | 409 | test-send on a disabled rule |
| `delivery_not_found` | 404 | delivery id not in this workspace/automation |
| `delivery_not_retryable` | 409 | retry on a status other than `failed`/`uncertain` |
| `autopilot_no_originator` / `autopilot_forbidden` | 403 | from the shared autopilot gate (see its docs) |

Delivery `error_code` values recorded by the pipeline:
`route_disabled`, `route_deleted`, `source_archived`, `source_missing`,
`condition_mismatch`, `member_unbound`, `installation_revoked`,
`installation_missing`, `send_rejected`, `send_transient`,
`sender_unavailable`, `attempts_exhausted`, `lease_expired`,
`send_ambiguous`, `route_target_unreachable`, `route_topic_anchor_mismatch`,
`route_authorization_lost`.

## Reliability guarantees and boundaries

- **One decision per (source, target).** Unique index on `dedup_key`; the
  event wakeup, the compensator and other replicas race safely.
- **Compensation.** A scanner pass (default 30s) (1) parks expired send
  claims as `uncertain`, (2) feeds three PERSISTED source classes whose
  automation run missed the terminal event to the EXISTING sync logic
  (`SyncRunFromTask`, `SyncRunFromIssue`, `SyncRunFromLinkedIssueTask` — no
  second state machine) and (3) decides every persisted terminal run that
  still lacks a decision for an enabled rule target. Each scanner holds a
  persistent per-scanner cursor (compare-and-set generation, immutable-id
  keyset, fixed per-cycle bound and per-tick row budget): a tick resumes
  where the last stopped, a completed cycle restarts from the set's
  beginning, so late-committing sources and pages of long-running candidates
  can never permanently starve anyone.
- **Workspace deletion.** Decision and receipt inserts share a short
  transaction with a `FOR SHARE` lock on the workspace row (the delete flow
  takes the same row `FOR UPDATE` before sweeping), so a stale snapshot can
  never commit content-bearing rows into a deleted workspace.
- **Test sends.** A synchronous test send carries a bounded lease like a
  claimed row and writes its outcome on a detached context: an interrupted
  test send is recovered by the expiry sweep to `uncertain` and is then
  retryable — it can never strand in `sending`.
- **Exactly-once send is bounded, not absolute.** Retries replay the fixed
  per-shard `send_uuid`, carried in the request BODY per Lark's
  `CreateMessageReqBody` (the platform's dedup window is finite, ~1h).
  Beyond the verifiable window the delivery stays `uncertain` until a human
  resolves it. Shards already carrying an `external_message_id` are never
  re-sent, and a worker re-validates its lease before starting each new
  shard — an expired claim stops dialing immediately.
- **No side effects on execution.** Delivery never triggers runs, consumes
  quota or mutates the execution state machine.
- **Cleanup hooks.** Rule disable/delete and bot revocation cancel queued
  sends; workspace deletion sweeps routes, deliveries and receipts; the
  worker re-reads route/source/installation state on every claim, so a
  delete racing a send cancels or fails the delivery explainably instead of
  misdelivering.
- **Feishu integration boundary.** Sends go through `lark.DeliverySender` →
  the optional `DeliveryAPIClient` capability (open_id / chat_id /
  reply+thread, fixed uuid). No existing interface was widened; deployments
  without `MULTICA_LARK_SECRET_KEY` record deliveries that fail with
  `sender_unavailable`.

## Known gaps (explicitly out of this stage)

- Real-Feishu verification (member/group/topic, service-side dedup window)
  requires an authorized test bot; the contract above is covered by DB-backed
  tests with fake senders/verifiers plus HTTP-contract tests on the real
  client.
- Personal inbox and team-event sources, and the frontend configuration UI,
  are later stages of the same parent plan.
- Feedback (reply-to-deliver → comment) is a later stage; `source_ref` is
  reserved for it.
