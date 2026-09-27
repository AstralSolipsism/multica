# Upstream adaptation: retained Feishu extensions

Integration target: `multica-ai/multica@12f8f3f`.
The [owner-confirmed scope](../../../docs/engineering/upstream-sync-20260926.md)
governs future synchronization decisions.

| Integration point | Retained extension | Required regression |
| --- | --- | --- |
| Channel Router and Feishu identity resolver | Bound workspace members follow upstream; only unbound/nonmembers may use an explicit conversation grant | Missing grants preserve native account binding; granted speakers act under the recorded grantor |
| Chat transaction and TaskService enqueue | Freeze grant provenance with accepted input/task/delivery; use the upstream Chat lifecycle | Atomic rollback, uncertain commit, duplicate intake, controls, queued recovery |
| Claim response, task-token middleware, reply sender | Recheck current consent and retry/delegation ancestry | Revoked work cannot launch/use tools/send replies; ordinary member work keeps upstream authority |
| Ordinary issue/comment tools | Agent authorship and source_task_id; upstream invocation and runtime access | Grantor differs from installer; private targets still require permission; no dependency execution admission |
| Proactive delivery worker and Lark message encoder | Automation results, personal inbox and project events; explicit source URL/run ID | Stable send identity, target approval, revoked/deleted source suppression, ordinary quotes |
| Installation config and existing settings panels | Explicit chat grant; no fabricated membership | Owner/admin validation, malformed response handling, draft preservation, grant revocation |
| Historical migrations and legacy feedback identities | Keep existing ledger/data; suppress old inbound replays | Upgrade preserves authored history, repeated migration is harmless, old IDs cannot reactivate work |

Signed report recovery and frozen-report context injection are retired. Keep
outbound receipts for delivery idempotency and historical inbound tombstones for
replay suppression; neither is a source of quoted-message authority. Do not
restore the deleted report resolver to resolve future merge conflicts.

Run the regression matrix in [FEEDBACK-CONTRACT.md](FEEDBACK-CONTRACT.md) after
changes to channel routing, claim, retries, coalescing, attribution or comment
tools. The derived task root reference avoids ordinary task-history traversal and
distinguishes authorization denial from retryable database failure. Default tests use fake
external APIs and fake agent processes; live Feishu/model checks require a
separate explicitly approved target.
