# Upstream synchronization scope

Owner-confirmed on 2026-09-26 after reviewing individual user-facing differences.
This decision supersedes the provisional analysis documents outside this repository.

Source baseline: `AstralSolipsism/multica@430d785f4ad3d37088807b313ad22691d472803a`.
Upstream integration target: `multica-ai/multica@12f8f3f31111564e5e1b9aac3f7f916e8bba4039`.

For each future sync, complete the [upstream sync checklist](upstream-sync-checklist.md).

| Capability | Confirmed disposition |
| --- | --- |
| Dispatch, claim, retry, recovery, lifecycle categories and wakeups | Adopt upstream behavior; remove fork prerequisite execution admission and one-shot early-dispatch approvals. |
| Cross-project dependency graph and relationship editing | Retain as collaboration information, without preventing or authorizing execution. |
| Provider plan quotas, reset times and host CPU/memory | Retain the implemented user-facing capability; upstream token/cost accounting is not a substitute for subscription quotas. |
| Feishu conversations with people without platform accounts | Retain explicit conversation grants and the recorded grantor's execution authority. External speakers are source identities, not fabricated workspace members. |
| Automation result delivery to Feishu | Retain configured proactive delivery. |
| Personal inbox forwarding to Feishu | Retain. |
| Project activity/comment delivery to groups or topics | Retain. |
| Quoted report replies | Use ordinary upstream quoted-message context and explicit source links in outgoing messages. Do not retain the full signed-report source recovery and frozen-report injection mechanism. |
| MCP configuration | Adopt upstream forms/JSON; retire snippet import and automatic name suggestions. |
| Webhook configuration | Adopt upstream; retire historical-delivery filter suggestions and non-executing draft previews. |
| Non-Git project shared files, versions and conflict candidates | Exclude from the active product. Do not add an experimental switch or replacement store for this sync. |
| Custom statuses, including discussion/tracking states | Adopt upstream behavior without extra custom-status execution rules or automatic relabeling. |

Future project-level sharing of domain documents, PRDs and ADRs across multiple
GitHub repositories is a deferred product direction, not an implementation
requirement of this integration.

Preserve historical migration identities and existing data. Removing an active
feature does not authorize deleting its historical tables or rewriting its ledger.
Keep the fork's necessary deployment/update-source configuration and retained
extension data; do not switch installed clients to unmodified upstream binaries.

Validation must demonstrate the selected capabilities against the merged source.
Upstream tests, textual merge success and this scope approval do not establish
candidate readiness. Production migration, deployment, release publication and
active download-feed changes remain separate from updating the fork's main branch.

## Integration notes

Upstream migration 492 converts status categories to `unstarted`, `started`,
`done`, and `closed`. Existing status keys and display names remain: for example,
`backlog_2` / 讨论中 becomes category `unstarted`, while `in_progress_2` / 追踪中
becomes `started`. This is the accepted upstream classification, not a renamed
status or a fork execution mapping.

Migration 551 adds a derived conversation-root reference to external tasks and
their retries/delegations. The existing frozen grant remains the sole consent
record. Ordinary tasks retain upstream authority when an older parent task is
deleted; external descendants still honor live revocation. The migration only
backfills on first column creation, so replay cannot overwrite established
references after history is deleted. Unresolvable historical ancestry retains
the previous fork's denial and is not automatically repaired.

French is new relative to the fork. Upstream French text is retained; retained
extension messages without a French translation currently use English.
The internal download page has French copy and dependency informational notices
are translated. No language change is required for the Chinese deployment.

The current server uses Linux `5.15.0-157-generic`. Upstream Cursor background
process ownership uses `PIDFD_SIGNAL_PROCESS_GROUP`, introduced in Linux 6.9
([Linux system-call reference](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html)).
That upstream implementation and its tests are unchanged by this merge. The
older host returns `EINVAL` for the capability probe, so its four Cursor
background test groups cannot pass here. Keep the upstream fail-closed behavior;
using that capability requires a supporting kernel. No production kernel change
or weaker process-killing fallback is part of this synchronization.

## Retained fork product constraints

`467_autopilot_trigger_creator_from_autopilot` was deliberately rewritten in both
directions by OL-49 (`245b1cf07`). Its up now changes column comments only: it must not
infer a legacy trigger's execution principal from the autopilot's creator, who may never
have created or authorized that trigger. The earlier `449_autopilot_trigger_created_by`
publisher backfill remains as shipped; unresolved triggers fail closed and require
explicit recreation by an authorized member. The down restores comments and does not
undo or infer principals. Future syncs must preserve this fork version rather than
directly adopting upstream's up or down SQL. Already-applied migrations are not rerun by
this documentation change.

User-visible branding must remain Labrastro / Mizuki, and the brand guards
must not be relaxed. Keep fork translations in the per-locale brand overlays;
validate the effective resources and server copy after every upstream sync.
See [the overlay and guard contract](branding.md).
Command names, environment variables, package/protocol identifiers, licenses,
attribution and upstream repository links retain their technical/legal identity.

Upstream-first capability updates do not revoke previously confirmed product
choices. Keep OL-14's non-marketing experience unless the owner explicitly
changes it: first-use setup has no source, role or use-case questionnaire; Web
and Desktop show no cloud-computer promotion; community entries open the
instance's Feishu QR dialog; the help menu and download/update paths retain
their internal destinations. Source-backfill prompts remain unmounted. Retired public marketing pages such as
/about and /homepage remain unavailable; the sitemap excludes retired marketing
routes, and the internal download page does not emit upstream organization
promotion. Keep software license and attribution notices.

Retire marketing at the fork-owned boundaries instead of deleting upstream
implementations (OL-133):

- `apps/web/lib/labrastro-marketing.ts` owns the retired public route trees
  (`/about`, `/homepage`, `/changelog`, `/contact-sales`, `/usecases`, including
  descendants). `proxy.ts` calls it before other routing and rewrites to Next's
  not-found page with HTTP 404 and noindex; its matcher must include dotted
  slugs. `sitemap.ts` filters upstream entries through the same policy and uses
  the instance's deployment URL.
- `packages/core/onboarding/step-order.ts` continues to exclude `about_you`.
  The restored questionnaire, its handlers and translations remain upstream
  code, but welcome/forward/back/rail navigation cannot enter the step. The
  completion-time questionnaire flush is gated by the same step list so setup
  never rewrites historical answers when the questionnaire is retired.
- `packages/views/onboarding/labrastro-marketing.ts` disables the cloud-card
  mounts in `step-platform-fork.tsx` and `step-runtime-connect.tsx` for both
  Web and Desktop. Keep the upstream card implementations behind that gate.
- Keep the help menu's internal download, feedback and Feishu entries, the
  internal root/download pages, and the landing layout without upstream
  Organization JSON-LD. These serve active fork behavior; restoring their
  upstream versions would reintroduce promotion. The unused backend
  contact-sales handler remains deleted and `/api/contact-sales` unregistered;
  restoring it offers no routing benefit and would add unused server code.

The initial restoration uses the fork/upstream common version
`2ea01ae4ef55de4310b99af192d2dbd367832883`. The six retired page files, four
use-case MDX files, `source.config.ts`, `use-cases-source.ts`,
`use-case-locale-fallback.ts` and its test, `step-about-you.tsx` and its test,
onboarding `types.ts`, and all five upstream `onboarding.json` files are
byte-identical to that version. Flow/runtime components retain only the gates
described above. Restored questionnaire branding lives in the existing fork
brand overlays; retired page metadata has narrowly listed source-guard
exceptions, backed by route 404 tests. Do not exempt active product copy.

On future syncs, update the policy for newly introduced marketing routes or
steps and verify absence at the entry points, as well as continued availability
of the dormant upstream implementations. Existing absence tests must remain;
the positive component tests for dormant code do not authorize mounting it.

During an upstream merge, review the resulting user paths and their tests
against these constraints. Do not replace a fork's absence assertion with an
upstream test expecting the removed feature. New-account setup and an existing
account are separate regression cases; a healthy login or an existing-account
smoke test cannot establish first-use behavior.

Before publishing affected Web/Desktop builds, run the shared onboarding,
runtime-empty-state and community-entry component tests, then
`e2e/onboarding-smoke.spec.ts` against the candidate in an isolated test stack.
The browser test must register a fresh user, continue directly to workspace
creation without persona questions, and reach runtime setup without a cloud
promotion. Check retired public routes, the sitemap and download-page metadata. Verify the desktop entry uses the same tested flow, and publish the
rebuilt desktop packages and feeds when shared UI changes. Record what actually
ran in the deployment handoff; test totals alone are not acceptance evidence.

The DAG task-line view is also a retained product behavior: keep bounded task
lines, stage separators, only real dependency arrows, and the independent-issue
group's separate manual expansion. Global expansion must not open independent
issues or auto-shrink the canvas. Shared Web/Desktop regression must exercise
actual layout output, cross-line folded/expanded endpoints and detail-return
viewport state; a screenshot of clustered summaries alone is insufficient.
See [the graph view contract](../issue-graph-api.md#grouped-webdesktop-canvas).
