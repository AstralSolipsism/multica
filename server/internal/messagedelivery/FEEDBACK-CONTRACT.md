# Feishu feedback contract (OL-29)

Baseline: fork main `36192101b94f51fbe178a90373a7ea443bfcf0b5`, including
OL-25 `790ab300efa67161b79161b2b28e863102f45356` and OL-27
`14f314e3d8f988fee79ab30f66eaf5659b039578`.
The shared comment extraction is a separate commit, `beffc1997`.

## Entry and source identity

`engine.Router.Handle` keeps installation resolution, persistent channel dedup,
the group @ filter, and actual sender binding/membership ahead of feedback.
`HandleMessageFeedback` runs before Chat creation. `/new`, `/clear`, `/issue`,
and forced-fresh inputs keep their existing control paths. A quote outside
this module continues ordinary Chat. An unavailable verification transport
retries the input instead of guessing whether it was a business report.

The locator is `(installation_id, quoted_message_id)` in the receipt table.
The Feishu adapter also fetches the actual quoted message with that bot's
credentials, verifies its sender is that app and its chat is the inbound chat.
Inbound quoted text, display names and user-pasted links never establish a
trusted route. `CommandTextSet` keeps an intentionally empty sender body from
being replaced by quote enrichment; only the sender's own `CommandText` becomes
a comment. Feedback accepts nonempty text up to 20,000 Unicode code points.

New sends append an HMAC-SHA256 locator to their source URL. It covers the
installation, installation agent, delivery ID, persisted shard send UUID and
shard index, using the encrypted-at-rest installation secret. This is a locator,
not an authorization token. Existing receipt-backed messages can be verified
without this new footer; a footer that is present must validate. A lost external
message ID is restored only after verifying the real bot message, signature and
the already-persisted exact shard. A concurrent first-ID winner is reread and
must agree. No shard is invented. Old messages without a signature cannot use
the lost-receipt recovery path. Rebinding the agent or rotating the app secret
invalidates previously signed locators.

`source_scope` is the configuration range; `source_kind` is the business origin.
`test_send` and `unknown` are rejected even if their scope looks actionable.
Run origins accept `run_only`/`create_issue`; inbox/activity/comment scopes must
match the frozen business kind. Routing uses frozen `source_ref`; contextual
report text uses frozen `content_snapshot`. Neither record nor original run is
rewritten by feedback. Restoring an external receipt ID does not assert that all
shards sent successfully or silently change an uncertain delivery to sent.

## Actual member authority and behavior

At intake and again before executing pending work, share locks fence the active
installation, exact sender binding, current workspace membership and applicable
group/topic approval. A change of binding user or installation agent rejects
pending work. Member deliveries accept only their frozen recipient; group/topic
deliveries require their frozen chat and exact source/project target approval.
Issue lookups and parent comments must belong to the same workspace and issue.
The workspace membership gate is the current HTTP issue-access boundary.

Single-issue feedback appends a member comment to the frozen issue, replying to
the original comment when one was recorded. HTTP and feedback share
`writeComment`, `commentCommitted`, and the existing comment trigger computation
and enqueue functions. Thread reopening, originator/accountable member identity,
private-agent invocation, explicit mentions, squad leader parent roles,
implicit triggers, `/note`, and task coalescing retain those functions' behavior.
Permission to comment does not imply permission to invoke a private agent.
Before durable enqueue, agent/allow-list locks and the same invocation predicate
recheck any triggers computed earlier in the transaction.

An explicit single existing task identifier can select the task of an unanchored
report. Conflicting or multiple identifiers require clarification. Task names in
report prose can signal ambiguity but cannot select a trusted target. Without
structured item anchors, the sender must name one task; “可以/继续” never changes
task status or approves a batch.

A substantive question about a pure `run_only` report lazily starts a real,
member-owned Chat using the original run's agent and the frozen report context.
The first Chat message, channel route, task and feedback completion commit
together. It rotates the existing chat/topic route using `StartSession`, so later
ordinary messages continue that conversation. It creates no issue and leaves the
old run unchanged. The context carries the existing automation detail URL plus
the exact original run UUID; the current frontend has no per-run deep-link
selection, and this backend-only change does not add one.

## Durable phases and recovery

`labrastro_message_feedback` has a concurrent unique index on
`(installation_id, inbound_message_id)`. The first accepted sender, source and
body win over duplicate or reordered callbacks. The channel's shorter-lived
dedup is not the business idempotency boundary.

| Phase | Transaction / recovery behavior |
| --- | --- |
| Intake | Lock workspace and optional issue; reauthorize; claim feedback identity; insert member comment and attach its ID/revision in **one transaction**. Any failure rolls both back. A losing replica writes nothing. |
| `pending` comment | Reload source, actor, issue and parent; serialize on the feedback row; run shared thread/comment actions and trigger enqueue on transaction-scoped queries; mark `complete` in **the same transaction** as enqueue/coalescing. Failure keeps the one comment and retries the pending work. |
| `pending` report | Reauthorize original source and agent; create real Chat, first message, channel route and task with feedback `complete` in the shared session transaction. A replica/restart reads the durable completion and cannot create another Chat/task. |
| `complete` / `rejected`, no acknowledgement | Retry only the acknowledgement. Recheck authority and lock the feedback row through the bounded send; revoked authority suppresses outbound delivery. The acknowledgement UUID is fixed. |
| `acknowledged_at` set | No more worker action. The inbound identity remains as a tombstone. |

The delivery service owns and joins one feedback scan loop. It reads at most
20 due records per pass, applies a 20-second context per record, and backs off
failures for 30 seconds. PostgreSQL locks, rather than process-local mutexes,
serialize replicas. The task completion reconciler leaves pending feedback to
this worker; existing durable planned/delivered comment receipts cover later
task recovery. Events are buffered until commit; daemon availability events are
hints and committed tasks remain discoverable if the process dies before publish.
No HTTP request, owner token, administrator impersonation or copied handler
implementation is used. Only comment-path dependencies are provided to the
transaction-scoped adapter.

Acknowledgement provider dedup remains finite (the same Feishu UUID contract as
outbound sends); an ambiguous acknowledgement outside that window may duplicate
the notice. It cannot create another comment or task. These tests establish
durable **enqueue** counts; they do not claim a distributed exactly-once agent
execution guarantee or retract work already accepted before a revocation.

## Deletion and downgrade

Workspace deletion explicitly removes feedback before receipt/delivery cleanup.
Issue and comment deletion redact copied feedback text and anchors in the same
transaction as deletion, retaining inbound identities so delayed callbacks
cannot resurrect comments. Recovery checks parents again. The existing deletion
manifest includes the table; no foreign keys or cascades are added.

Migrations `474…477_labrastro_message_feedback*` add the table and three separate
concurrent indexes. All index names are registered in the migration runner's
invalid-index cleanup map. A populated downgrade refuses **before** removing
the last migration's index: quietly dropping identities would re-enable replay.
An application rollback can retain the additive schema. Schema removal requires
stopping feedback workers and explicitly retiring/exporting the retained replay
identities. Empty-schema down/re-upgrade preserves the earlier deliveries and
receipts.

## Evidence matrix

All rows below use PostgreSQL. Handler tests enter via the real channel Router,
Feishu resolvers, bindings, membership and durable dedup, then drive the joined
worker's production callback. Only the external Feishu API/notice transport is
replaced. Fault injection wraps real SQL/COMMIT, with independent connections
observing committed state. Final commit SHA and actual command results belong in
the PR/issue evidence, avoiding a self-referential SHA in this document.

| Input / fault and observed interleaving | Expected durable outcome | Test |
| --- | --- | --- |
| Quote single comment; actual member body differs from quoted instructions | Intake: 1 member comment, 0 tasks. Recovery: 1 comment, 1 queued task/event; correct parent/originator/accountable member, reopened root | `TestFeedbackRouterSingleIssueParentAndOriginator` |
| Fail after actual comment INSERT, before transaction commit | 0 comments/feedback/tasks after rollback; retry 1 comment/1 task | `TestFeedbackCommentAndDedupRollbackTogether` |
| Intake committed; actual CreateAgentTask visible in its own transaction but 0 tasks from a separate connection; inject error | 1 comment, pending feedback, 0 durable tasks/events; fresh Handler/TaskService recovers to 1/1 | `TestFeedbackRecoveryAfterCommentCommitAndWakeFailure` |
| Actual task COMMIT succeeded but commit confirmation is lost, or acknowledgement send fails after a separate connection sees the task | 1 comment/1 task, completed feedback, unacknowledged; simulated daemon consumes the task; repeated recovery changes only acknowledgement | `TestFeedbackRecoveryAfterTaskCommitMissingConfirmation` |
| Two Routers, eight duplicate event callbacks, two worker instances competing on one row; later payload changes body/quote | First body wins; 1 comment/1 task/1 queued event | `TestFeedbackMultipleReplicasAndReorderedCallbacks` |
| Lost receipt, forged human/bot/chat, bad signature, diagnostic with actionable-looking scope | Valid recovery 1 comment/1 task; refusals 0/0 and no Chat | `TestFeedbackReceiptRecoveryAndTrustRefusals` |
| Real proactive HTTP send, then real HTTP GET + DB recovery; tamper signature, copy as human/other bot, move chat, delete message, rebind bot, mismatch shard | Only exact signed bot/shard restores the missing receipt; no untrusted association | `TestFeedbackSignedSourceRecoveryThroughHTTPAndDatabase` |
| Unbind/remove member/rebind bot/delete issue or parent/change private-agent owner after intake | 0 new tasks; deleted anchors/copy text redacted | `TestFeedbackRevocationAndParentDeletion` |
| Group approval revoked before intake, before wake, or via post-commit event before acknowledgement | Respectively comments/tasks 0/0, 1/0, 1/1; no acknowledgement after revoke | `TestFeedbackGroupApprovalRevokedAtEachStage` |
| Pure report, then automation agent selection changes; retry recovery and send ordinary next turn | One member-owned Chat/task with original agent/snapshot/run identity; original run unchanged; next message in same Chat | `TestFeedbackReportCreatesRealConversationAndPreservesRun` |
| Ambiguous or multiple task report; explicit task selection; private agent or removed source run | No batch/task-state action; only explicit task selection gives 1 comment/1 task; no refusal Chat | `TestFeedbackReportSelectionAndPrivateAgent` |
| Source-less/no quote, group @/no @, unbound/nonmember, `/new`/`/clear`/`/issue`, empty sender body containing enriched quote instructions | Existing Chat/control/filter paths; no invented feedback or quote-derived command | `TestFeedbackChannelCompatibility` |
| Reply to a squad leader's comment with its original `source_task_id` | One task preserving `is_leader_task`, squad and parent agent role | `TestFeedbackReplyKeepsSquadLeaderParentRole` |
| Delete workspace containing a feedback row with missing ownership links | Workspace-owned copied data removed; another workspace retained | `TestFeedbackWorkspaceDeletionRemovesOwnedData` |
| Populated earlier deliveries/receipts; real failed concurrent unique build; populated downgrade refusal; explicit empty down/re-upgrade | Invalid index repaired, identity preserved until explicit retirement, all 3 historical deliveries/receipts unchanged | `TestMessageFeedbackPopulatedUpgradeRollbackAndIndexRecovery` |

Full affected-package regression includes existing HTTP comment, parent/squad,
private invocation, completion reconciliation, route/control and message-delivery
repair tests; no existing behavior assertion is weakened.

Live Feishu testing remains outstanding: no explicitly authorized test bot/chat
was supplied. Verify actual platform bot sender fields, source-link preservation,
message lookup scopes, topic replies, and provider UUID acknowledgement behavior
against an approved test target before production rollout. No deployment or
automatic merge is part of this change.
