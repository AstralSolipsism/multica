# Upstream adaptation: external Feishu conversations

Fork baseline: `ec7f334be1b00700c4b5537323ad483547e58c14`.
This change contains no upstream merge, quota change or branding migration.
The desired divergence is external conversation consent and provenance; normal
Chat/task/comment semantics remain upstream-owned.

| Integration point | Fork customization to preserve | Check after upstream sync |
| --- | --- | --- |
| `channel/engine/router.go`, `conversation.go` | Hook after installation/dedup/group filter, before member lookup; default path for other channels unchanged | Unbound and bound Feishu reach one hook; idle groups create nothing; missing hook cannot reactivate member writes |
| `handler/labrastro_conversation.go`, `channel/engine/session.go` | Explicit grant; source-bearing input; existing Chat transaction `BeforeCommit`; `/issue` conversational | Input, dedup completion, run, input ownership and frozen delivery commit together; normal media/control behavior and list events remain |
| `channel/conversation.go`, `service/task.go` | Workspace grantor membership/invocation checks; grant epoch frozen in delivery; integration provenance only for channel enqueue | New first-party sends use direct human authority and have no external reply; retry/delegation cannot escape grant revocation |
| `middleware/auth.go`, `handler/daemon.go`, `lark/outbound.go` | Recheck current consent at task tool requests, daemon claim payload and conversation replies | Revoked queues fail before launch; running tokens and delegated private targets are denied; ordinary task tokens and notification sends keep their gates |
| `handler/agent_access.go`, `handler/comment.go` | Reuse normal actor and trigger rules; remove only the retired feedback-specific recovery wrapper | Author is agent, `source_task_id` is real run, parent/squad/private/dependency behavior survives; no new direct member feedback writer |
| `messagedelivery/feedback.go`, `lark/labrastro_feedback.go` | Keep bot/receipt/HMAC/frozen source resolution as context; no execution permission from a quote | Real signed-shard recovery and forged sender/chat/source refusal; Inbox, subscriptions and automation retry/history tests pass |
| `lark/store.go`, `labrastro_conversation.sql`, generated queries | Optional installation grant, scoped save and row lock; encrypted bot secret untouched | Regenerate sqlc; replacement installation clears consent; save uses actual authenticated grantor; bot metadata backfills patch only their own JSON fields |
| Migration 478 and legacy feedback queries | Retire pending/acks, retain identities and authored history; only reads/deletion redaction survive | Populated upgrade/idempotent rerun/down refusal; new hook drops legacy IDs even without channel dedup |
| `core/lark`, `core/api/client.ts`, existing settings/agent integration panels | Optional versioned fields and capability flag; explicit workspace consent; retain draft on read/save error | Old backend listing works; malformed response never shows success; owner and admin entry points stay aligned with server |
| `attribution/attribution.go`, attribution badge/locales | `channel_integration` names an authorization source | UI never presents external speaker or installer as the human author of a comment |

Before adopting new upstream dispatch, coalescing, retry, channel retention or
comment-tool changes, rerun the evidence matrix in `FEEDBACK-CONTRACT.md`.
Specifically inspect whether a retry still follows `retry_of_task_id`, whether
comment/delegation provenance still follows `delegated_from_task_id`, whether
channel task delivery is frozen with input ownership, and whether task-token
workspace/human-only checks still execute before tool handlers. Do not silently
copy integration authority into fresh human actions or unrelated agents.

Run `TestConversationInvocationMatchesMemberGate` whenever the ordinary human
invoke predicate changes. Conversation intake, transactional enqueue and task
execution intentionally validate different live/frozen inputs through the same
grant validator. Preserve the task-token database-failure behavior and 64-task
lineage boundary documented in the contract; the initial task read also affects
ordinary platform tokens. Legacy retirement is the explicit `retired` status,
independent of notice wording.

Keep migrations 474–477 intact. Never restore the removed feedback worker to
resolve a merge conflict. An old/new mixed-writer deployment is not a supported
migration plan; apply the stopped-worker cutover in the contract. If future
product requirements need project-only consent, a durable comment idempotency
key or isolated tool runtimes, reassess those requirements explicitly instead
of expanding this workspace grant by inference.
