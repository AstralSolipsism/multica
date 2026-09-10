# Feishu agent conversation contract

Baseline: fork main `ec7f334be1b00700c4b5537323ad483547e58c14`.
This contract replaces the member-authored feedback workflow. Feishu provides
notifications and a conversation with one designated agent. Participants may
have no Labrastro account. The agent clarifies and summarizes feedback, then
uses ordinary tools to write comments under its own identity. Receiving a
message never directly writes a task comment or changes an issue's status.

## Explicit authority and provenance

An active Feishu installation names one workspace and agent. Its optional
`config.conversation` grants the agent its normal tools **throughout that
workspace** for an explicit list of `{chat_id, chat_type: group|p2p}` targets.
There is no project-only or read-only conversation scope in this version. Use
this grant only for conversations whose participants may request those actions.
Notification/team-subscription approvals are separate and remain required for
their respective outbound sends.

Configure the grant on the existing workspace/agent Feishu integration panel,
or `PUT /api/workspaces/{id}/lark/installations/{installationId}/conversation`:

```json
{"scope":"workspace","chats":[{"chat_id":"oc_example","chat_type":"group"}]}
```

The authenticated human must be the agent owner or a workspace owner/admin,
and must currently be able to invoke the agent. Administration alone does not
bypass private-agent invocation. The server records the actual human as
`authorized_by` and issues a new grant `id` on each save. Neither value is
accepted from request input. Task tokens and cloud-node credentials cannot
create/revoke this consent. Empty `chats` revokes it. Limit: 50 targets; only
`workspace` scope is accepted. The installation list exposes
`conversation_supported` and optional `conversation`; older list responses are
readable. Malformed responses fail the query/save without inventing success;
configuration read failures preserve the last data and draft but disable writes.

| Identity / record | Meaning |
| --- | --- |
| External sender/chat/thread/message IDs in the committed Chat input | Source evidence; no membership or approval assertion |
| Chat creator, task originator and accountable user | The explicitly recorded grantor, who may differ from the installer |
| `OriginatorSource=channel_integration`, evidence kind `channel_conversation` | Integration consent, never a claim that the grantor spoke the external message |
| Evidence ref = channel binding ID; `channel_task_delivery.config.conversation` | Immutable grant snapshot used to check a task against current consent |
| Task-token agent ID and comment `source_task_id` | Actual executing agent/run; ordinary comment API sets the agent author |

Intake and transactional enqueue validate active installation, exact workspace,
agent, chat and grant ID, current grantor membership and current agent invocation
rights. Enqueue locks the installation row. Claim-response construction checks
again before handing work to the daemon. Task-token API requests check live
consent, including existing retry/delegation lineage and the delegated target's
invocation rights. Outbound conversation replies check live consent too.
Malformed/missing consent fails closed; database failures remain retryable errors.
Grant edits, revocation, installation replacement, membership removal, or loss
of invocation rights invalidate previous external work at these boundaries.
An already accepted side effect or a local tool running on a daemon cannot be
recalled. This is not a filesystem/network sandbox for agent runtimes.

A fresh first-party action in the same Chat follows normal human authorization
and has no external delivery snapshot. Normal task-token, workspace and
human-only endpoint gates remain in force. No shadow members, system author,
installer impersonation, or parallel comment-trigger engine are introduced.

## Inbound conversation and notification context

The connector's existing bot/event verification remains in front of the Router.
Installation lookup, persistent dedup and explicit group-address filtering run
before the conversation hook. Bound and unbound senders take the same hook;
Feishu identity fallback fails closed if the hook is missing. Idle group
messages do not start runs. Routes are keyed by installation, grant epoch,
chat type, chat ID, and group topic; an old member-owned route is never reused.

Text, selected context and media use existing Chat storage, task ownership and
media scheduling. `/new` rotates a Chat and `/clear` starts fresh context;
bare controls do not enqueue a model run. `/issue` is conversational input and
cannot directly exercise the member command path. The agent receives runtime
instructions to clarify ambiguous/multiple targets, retain important original
wording and message sources, and use normal issue/comment tools. Bare
“可以/继续/yes” is not batch approval. A pure report question continues this
Chat; intake does not rerun the original automation or force issue creation.
These interpretation rules are agent instructions, not claims of deterministic
model understanding.

A quoted notification supplies context only after the existing source resolver
fetches the actual bot message using that installation's credentials, checks
bot sender and same chat, and resolves its receipt/frozen source. Existing
receipt/HMAC shard recovery is retained: a lost message ID is restored only
for the exact persisted signed shard; pasted links or human-copied messages
cannot create trusted associations. A present signature must validate; old
unsigned messages need an existing receipt. Diagnostic/unknown sources are not
actionable. Group/topic context retains current source/range approval checks.
Ordinary non-notification quotes remain conversation text.

Verified issue/comment/run/delivery IDs, frozen report text and source link are
added to the input. They neither change the configured agent nor expand its
workspace rights. Ordinary comment handlers validate issue/parent membership,
set agent authorship and `source_task_id`, and preserve discussion, mention,
private-agent, squad-role and dependency behavior. Notification delivery,
personal Inbox addressing/member bindings, subscriptions and retries retain
their existing authorization and storage.

## Commit, retry and ordering guarantees

| Boundary / failure | Durable behavior |
| --- | --- |
| Installation/chat route setup | May leave an empty route on failure; no user input, run or comment has been accepted |
| Input acceptance | User input, fenced inbound dedup completion, task, input ownership and delivery/grant snapshot commit in one shared Chat transaction |
| Failure after input or task INSERT | Transaction rolls back; callback retry can accept the input |
| COMMIT succeeds but caller loses confirmation | Input/run remain committed; reconnect/retry sees processed dedup and cannot enqueue them again |
| Process exits before task-queued event | Event is a hint; normal durable task claiming discovers the queued run |
| Duplicate replicas or old callback payload | The accepted `(installation_id, message_id)` wins; duplicates cannot replace its body or enqueue another run while the identity is retained |
| Distinct events arrive out of order | Each is accepted once in server arrival order; external timestamps are not a sequence/reordering guarantee |
| Comment commit response is lost | The normal comment API has no idempotency key: blindly resending can create a second comment with the same `source_task_id` |

Inspect task/run and comment history after an uncertain tool result before
resubmitting. Channel dedup is **not** end-to-end exactly-once execution or
comment delivery. At this baseline `PurgeChannelInboundDedup` has no scheduled
caller; installation/workspace cleanup can remove identities, and any future
retention policy must account for the provider replay window. Legacy feedback
identities are additionally checked even if the channel dedup row is absent.
No new generic worker, execution ledger, or permanent comment-idempotency API
is introduced.

## Cutover, pending legacy rows and rollback

1. Stop **all** old Feishu inbound instances and feedback recovery workers;
   drain/stop active legacy callbacks before migration. Mixed old/new writers
   are unsupported: an old binary can still write new feedback. Take a database
   backup and inventory legacy `pending` rows with their comment/Chat/run IDs.
2. Apply the additive migration `478_labrastro_feedback_retirement.up.sql`
   with the normal runner after migrations through 477. It marks old pending
   rows `rejected` with a retirement notice and sets missing `acknowledged_at`.
   Complete/rejected rows keep their outcome. It does not delete comments,
   receipts, source data, Chat/run anchors or inbound replay identities.
3. Start only the new binary. It has no legacy member writer, recovery callback
   or acknowledgement worker. Reconciliation skips pending/retired legacy
   comments; a matching old inbound ID is dropped by the new hook. Review
   previously committed comments/runs before intentionally resubmitting an
   unresolved item as a **new** conversation message. Existing scheduled runs
   may already have acted; migration does not cancel or re-author them.
4. Existing installations initially have no conversation grant. A human must
   configure allowed chats and review workspace scope before they accept new
   input. Notification-only installations can remain without a grant.
5. Verify no legacy pending/unacknowledged rows remain, old comments still
   have their historical authors, duplicate old callbacks create no new input,
   and an authorized fresh message creates an agent Chat/run. Then check the
   resulting normal agent comment and its provenance before wider rollout.

Rollback must keep migration 478 and all historical audit data. Its down
migration refuses intentionally: restoring legacy recovery would silently
re-enable member impersonation. If rolling the application back, keep Feishu
inbound **and** legacy feedback workers disabled on the older binary; prefer a
forward fix. Do not treat downgrading schema, deleting tombstones or clearing
retirement markers as a routine rollback. Issue/comment deletion still redacts
legacy copied text and anchors transactionally, retaining the inbound tombstone;
workspace deletion follows the existing ownership cleanup.

## Evidence and limits

Handler tests use the production Router, Feishu resolvers, PostgreSQL Chat/task
transactions and the real task-token middleware/comment handlers. Only the
external message API is replaced; a deterministic agent stand-in calls normal
HTTP tools. Faults surround actual SQL/COMMIT and independent connections
observe committed counts. Signed-source tests also use the production HTTP
client, encrypted credentials and receipt recovery.

| Behavior | Regression |
| --- | --- |
| Bound/unbound group input → same agent; correct issue/thread and `source_task_id` | `TestConversationUnboundAndBoundAgentComment` |
| Unconfigured/revoked/private/removed-member refusal; commands, report and ambiguous input; group/topic/DM isolation | `TestConversationScopeCommandsAndIsolation` |
| Real INSERT rollback and missing COMMIT confirmation; separate-connection counts | `TestConversationAtomicIntakeAndLostCommit` |
| Two Routers, eight duplicates; cross-workspace denial; real token and member-only gate | `TestConversationDuplicateReplicasAndRevocation` |
| Reordered distinct inputs; fresh first-party continuation after consent revocation | `TestConversationReorderedInputAndFirstPartyContinuation` |
| Actual grantor differs from installer; server-issued grant; machine denial | `TestConversationGrantUsesActualAuthorizerAndRejectsMachines` |
| Private target and normal comment delegation retain source revocation | `TestConversationPrivateInvocationAndDelegatedRevocation` |
| Normal comment dependency gate; lost comment response gives two comments, not a claimed exactly-once result | `TestConversationCommentDependencyGateAndLostResponse`, `TestConversationLegacyTombstoneAndCommentRetryLimit` |
| Bare controls; committed queue recovered through normal claim; revoke before daemon payload | `TestConversationControlCommandsAndQueuedRecovery` |
| Bot identity backfill cannot overwrite consent revoked immediately before its write | `TestConversationRevocationSurvivesBotBackfill` |
| Source context cannot authorize an unapproved group or a forged/diagnostic quote | `TestConversationNotificationContextCannotAuthorize` |
| Replies use the real chat ID and fail closed on revoked/unavailable consent | `TestConversationOutboundUsesRealChatAndLiveConsent` |
| Real signed bot source / shard recovery and forgery refusals | `TestFeedbackSignedSourceRecoveryThroughHTTPAndDatabase` |
| Populated old outcomes/anchors retained; repeated upgrade and down refusal | `TestConversationRetirementPreservesHistoryAndRefusesDowngrade` |
| Old list response, malformed read/save, revoke payload, saved-data/draft error state | `lark-conversation.test.ts`, `lark-conversation-form.test.tsx` |

The PR records actual commands/results and final head. No live Feishu bot/chat
or model run is implied: those require an explicitly approved test target.
Remaining live checks include connector sender fields, topic reply routing,
media download, source-link preservation, provider dedup, and the agent's actual
clarification/summarization/tool choices. See
[UPSTREAM-ADAPTATION.md](UPSTREAM-ADAPTATION.md) before syncing upstream.
