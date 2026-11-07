# Upstream adaptation: retained Feishu extensions

Integration target: `multica-ai/multica@12f8f3f`.
The [owner-confirmed scope](../../../docs/engineering/upstream-sync-20260926.md)
governs future synchronization decisions.

| Integration point | Retained extension | Required regression |
| --- | --- | --- |
| Proactive delivery worker and Lark message encoder | Automation results, personal inbox and project events; explicit source URL/run ID | Stable send identity, target approval, revoked/deleted source suppression, ordinary quotes |

Feishu chat ingress, task enqueue, claim and replies follow upstream's
member-binding flow; the fork no longer adds external-conversation grants
(retired in OL-1274). Retired feedback and report tables stay in the schema
for history only; no code reads them. Do not restore the deleted report
resolver to resolve future merge conflicts.

Default tests use fake external APIs and fake agent processes; live
Feishu/model checks require a separate explicitly approved target.
