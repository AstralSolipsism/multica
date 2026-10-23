# v0.6.5 integration

OL-1091 integrates the released upstream commit into Labrastro `main`. The
default auxiliary model remains `gpt-5.6-luna`, which the deployed gateway
supports. Publishing `v0.6.5-labrastro.1`, production migrations and deployment
are separate work after this change and OL-1083 have both merged.

| Source | Commit |
| --- | --- |
| Actual fork baseline | `6e6965ec0914dc1cc5dedbd3e4616d7fbae7999b` |
| Upstream release commit, `v0.6.5^{}` | `654b8ca954034f8181eb6bbb4fc298dede760156` |
| Previous upstream release / merge base | `18fa9f728a9e25f2465df2789631edb2a75442ad` |
| Two-parent merge | `89e2a1958887d9bd8553b3b4d99a436c550a3aba` |
| Main refreshed before review | `b8b17d477b343ced3eb02091c0d366faa09ea714` |
| Production migration starting point | `f83c9753bbf1c52690bee642b94af18b7d60c6b3` (`v0.6.1-labrastro.6`) |

The release contributes 55 commits. No commits from the post-release upstream
branch were selected. The merge temporarily retains the fork side of conflicted
files; the following commits implement the issue's decisions. Future main
updates must be merged, not rebased across this merge. Before review, main
advanced through PR #147 and was merged without conflicts. That refresh contains
review cleanup for Kimi quota sampling, attachment UUID handling, dependency
error wording and a Desktop CLI-cache test; its migration directory is unchanged.
Main then advanced through PR #183 (OL-1083) and was merged without conflicts.
The approved per-field decision bounds and untrimmed step-state behavior are
retained byte-for-byte; the overlapping environment-variable documents preserve
both its guidance and this sync's `gpt-5.6-luna` default. Neither refresh changes
migration files. Daemon tests (including embedded hook installation) and
affected UI tests are rerun after this merge. The standalone Claude hook-engine
TypeScript suite is not included in this environment's validation.

The live upstream tag lookup on 2026-10-23 reports annotation object
`8a4d3eeb521e699eb977a6a5709bc834bb1927bb`, unlike the annotation recorded in the
issue's preflight. Both the checkout tag and the live tag peel to the exact
authorized release commit above; the merge uses that commit explicitly.
`8d95e805596d05c1e68b3e5c81a525edee691cbb` (#9332), previously cherry-picked
with approval, is now an upstream ancestor. `server/internal/integrations/ghsnapshot` is
byte-identical to this release; no second cherry-pick is needed.

## Conflict decisions

- Floating chat uses upstream's `ChatWindowMessages`, `AnimatePresence` and
  `active` lifecycle. Only message observers leave during close; the composer
  stays mounted. `ChatMessageList` retains `useChatMessageWindowIndex` and
  row-identity indexing, with no pagination-derived `firstItemIndex` prop.
  `resumeFollowNonce` passes through the new component and `useStickToBottom`
  keeps both `active` and `resumeLiveEnd`. Tip sessions still show
  `TipSideChatStarters` before their first message; the banner, send guards and
  regenerate action remain. The existing side-chat surface fixture now opens
  the window before asserting visible messages, matching the new lifetime.
- Deep links retain `comment-deep-link.ts`, the `replaceCanonical` guard and
  the navigation adapter's hash. Upstream `IssuePeekHost` is retained in both
  the route and inbox. `issueHighlightMementoKey` still has one definition.
  Inbox retains `WithoutTipAnchors`, surface activity, no-agent-work filtering,
  persistent unread filtering and foreground-only unread summary fetching.
- Agent options contain the three fork callbacks and `CursorHookCommand`.
  Claude initializes for skill discovery even without supplements, passes
  `EnableTaskSupplement` to hook setup, and honors `HandshakeTimeout` with the
  existing 60-second zero/default fallback.
- Codex scans its own rollout when usage, usable live quota, or model is
  missing. The three signals are recovered independently: JSON-RPC usage and a
  configured model win; usable live quota wins over scanned quota. A model-only
  or quota-only scan survives even without a completed turn. Regression tests
  cover default-model attribution with live usage/quota, quota recovery with a
  configured model, quota before the first turn and usage fallback.
- DSH has one manifest-state entry point, `dshMulticaProfileState(executablePath)`.
  It resolves literal launcher `DSH_HOME`; a parsed manifest without the runtime
  dependency/bundle is missing. Unreadable, non-regular, invalid or unresolvable
  input is unknown and defers to protocol probing. No daemon-home presence
  helper was restored. Probe, refresh, installation and indirect-shim fixtures
  retain launcher semantics.
- Desktop is `0.6.5`, product name Labrastro. The UI/views dependencies are the
  union, including the fork formula dependencies and upstream `jsdom`,
  `mdast-util-gfm-table` and `mdast-util-math`. `pnpm install` regenerated the
  lockfile. The performance README retains comment typing, DAG and the new
  floating-chat scenario.
- `FallbackModel`, built-in-default assertions, `.env.example`, chat-title
  commentary and all five environment-variable documents use `gpt-5.6-luna`.
  Explicit `gpt-6-luna` still receives `reasoning_effort: none` for JSON calls.
  No deployment environment values changed.

## Automatically merged behavior

| Area | Conclusion and evidence |
| --- | --- |
| Runtime access revocation (#7580, #8981) | The confirmation dialog and `RuntimeQuotaCard` coexist. The sole new user-auth route, `POST /api/runtimes/{runtimeId}/revoke-workspace-access`, is denied for external conversations. `TestRevokeRuntimeWorkspaceAccess` now also asserts that the unbound teammate agent keeps its folder placement and owner. Existing lock-order, stale-plan, cancellation and private-binding tests remain. Regenerated sqlc includes fork `dependency_admission`, `conversation_root_task_id` and `plan_quota` in the new queries. |
| Explicit comment cancellation (#9300) | Reconciliation suppresses unchanged trigger/coalesced comments explicitly cancelled by a member or agent; automatic cancellation and later edits remain replayable. `comment_reconcile_cancel_test.go` covers these distinctions. Authorization and dispatch ancestry are unchanged. |
| Supplement root ownership (#9061) | A delivered supplement establishes conversation-thread ownership; pending/failed delivery does not. The query joins the same issue and task. Root ownership is routing data, not a substitute for the frozen grantor or persisted task ancestry. `comment_root_projection_test.go`, `comment_steer_test.go` and `task_supplement_test.go` cover routing and settlement. |
| Assignment reply threads (#9171) | This release change is UI projection in `comment-runs.ts`, not an authority change. `comment-runs.test.ts` and `issue-detail.test.tsx` retain assignment replies under their actual thread. |
| Wakeups (#9039, #9069) | Self-hosted VCS conditions use their own PR/head status; completed evaluation can clear an earlier failure. Both system queues and dispatch still exclude backlog. `AdvanceWakeupNextFire` still leaves `last_error` intact; `TestWakeupConditionPRDiagnosticPolling`, PR recovery, VCS and system-rule tests cover the distinction between advancing a poll and completing an evaluation. |
| Default workflow (#9389) | Status pickers, batch actions and menus retain dependency guards and partial-rejection feedback. Integration found that Default-scope search used the unfiltered catalog; it now applies `allowedStatuses` too. The regression denies a restricted completion status while still selecting `backlog_2` from search. |
| Markdown tables (#9321) | Rendered table cells retain the fork single-dollar formula plugin. Table span detection disables permissive multiline single-dollar parsing, matching the renderer's block grammar. A `RichTable` regression renders `$x_i^2$`, keeps `$5` literal and copies the original Markdown. Table model, table rendering and shared math suites cover source mapping. |
| Document title (#9067) | Web title branding remains Labrastro, including new fallback title tests. Brand guards and locale overlays remain unchanged. |
| Thinking levels (#9392) | Unknown Claude models keep upstream effort support; the fork `_adapt` decision path and per-turn callbacks remain. Agent thinking tests and daemon adaptive-thinking tests cover both paths. New upstream test calls pass the fork's existing context argument. |
| CA distribution (#9312) | No deployment configuration values changed. Before deployment, review every certificate in non-system `SSL_CERT_DIR` directories: subject/issuer, SHA-256 identity, validity, CA purpose and whether it should be shared with every connected daemon for Git trust. Avoid unrelated private roots or whole system bundles. `gitca` and daemon `repocache` tests verify backend trust filtering and preservation of operator trust. |

## External-conversation route review

The baseline is the fork commit in the first table. The allowlist is unchanged:
60 allowed routes and 418 denied user-auth routes, with one newly denied route.
The exact decoded field inventory in
`server/cmd/server/testdata/labrastro-external-requests.tsv` is unchanged for all
23 entries below. `TestExternalConversationRequestInventory` verifies it;
`TestExternalConversationRouteInventory` walks the production router, and
`TestExternalConversationEveryDeniedProductionRoute` exercises the denial gate.

Every write still authenticates persisted ancestry, revalidates the live grant,
and uses its frozen human grantor. The acting agent remains the actor. The
runtime owner's token is never a replacement principal. Existing channel,
handler and real-router regressions cover descendants, retries, wakeups,
delayed dispatch, missing evidence, revocation, workspace and invocation checks.

Evidence **H** means handler tests (including fork authorization regressions),
**R** means the real-router suite, **C** means comment cancellation/root/steering
tests, and **W** means workflow/dependency/wakeup regressions. All refer to the
commands and final-head results delivered with the PR; reviewer acceptance is
separate.

| Method / route | Handler and dependencies | Request/default/validation comparison | Side effects and authority / evidence |
| --- | --- | --- | --- |
| `POST /api/issues/query` | `QueryIssues` / query helpers | Filter map, defaults and workspace validation unchanged | Read only; H/R |
| `POST /api/issues` | `CreateIssue` / `IssueService.Create` / dispatch | All create fields unchanged; parent, project, stage, dependency, attachment and invocation validation retained | Same issue/dependency/attachment writes and assignment dispatch under frozen grantor/root; H/R/W |
| `POST /api/issues/with-dependencies` | `CreateIssueWithDependencies` / atomic create | Same fields, required dependency version and override checks | Same atomic issue/edge writes and authorized dispatch; H/R/W |
| `PUT /api/issues/{id}` | `UpdateIssue` / workflow / dispatch | Same update fields and false-default handoff flags; external `stop_previous_assignee_runs` field still rejected | Same revision and DAG transaction gates; generated handoff preserves grantor/root; H/R/W |
| `PATCH /api/issues/{id}/with-dependencies` | `UpdateIssueWithDependencies` / dependency transaction | Same update/dependency fields and cancellation-field denial | Same atomic issue/edge effects and partial-rejection behavior; H/R/W |
| `POST /api/issues/{id}/comments` | `CreateComment` / mentions / supplements / reconciliation | Content, parent, type, attachment, steering and suppression fields unchanged | Cursor can now receive authenticated supplements. Explicit cancellation and delivered-root rules above apply; invocation, authorship and task ancestry gates unchanged; H/R/C |
| `PUT /api/comments/{commentId}` | `UpdateComment` / edit reconciliation | Same revision, merge-base, content, attachment and suppression fields | Same own-agent/admin gate; updated content may replay after explicit cancellation, unchanged content does not; H/R/C. OL-1092 later removed the grantor-admin path: external conversations may edit only their own agent's comments |
| `DELETE /api/comments/{commentId}` | `DeleteComment` | Bodyless; same lookup and authorship/admin checks | Same deletion scope, activity and task invalidation; H/R |
| `DELETE /api/comments/{commentId}/keep-replies` | `DeleteComment`, keep-replies mode | Bodyless; same workspace and author checks | Same reply-preserving deletion; H/R |
| `POST /api/comments/{commentId}/resolve` | `ResolveComment` | Bodyless; same issue/workspace validation | Same thread resolution and event; H/R |
| `DELETE /api/comments/{commentId}/resolve` | `UnresolveComment` | Bodyless; same validation | Same resolution removal/event; H/R |
| `POST /api/comments/{commentId}/reactions` | `AddCommentReaction` | Same emoji field/validation | Same actor-scoped reaction and wakeup provenance; H/R |
| `DELETE /api/comments/{commentId}/reactions` | `RemoveCommentReaction` | Same emoji field/validation | Same actor-scoped removal; H/R |
| `POST /api/issues/{id}/reactions` | `AddIssueReaction` | Same emoji and membership checks | Same actor-scoped write; H/R |
| `DELETE /api/issues/{id}/reactions` | `RemoveIssueReaction` | Same emoji and membership checks | Same actor-scoped deletion; H/R |
| `POST /api/issues/{id}/labels` | `AttachLabel` | Same `label_id`, issue/label workspace checks | Same association/revision/event, no label-catalog editing; H/R |
| `DELETE /api/issues/{id}/labels/{labelId}` | `DetachLabel` | Bodyless; same scoped lookups | Same association deletion/revision/event; H/R |
| `PUT /api/issues/{id}/metadata/{key}` | `SetIssueMetadataKey` | Same JSON value, key/size/count validation | Same scoped metadata write and no-op handling; H/R |
| `DELETE /api/issues/{id}/metadata/{key}` | `DeleteIssueMetadataKey` | Bodyless; same key validation | Same deletion/no-op handling; H/R |
| `PUT /api/issues/{id}/properties/{propertyId}` | `SetIssueProperty` | Same JSON value and typed-definition validation | Same issue-scoped property mutation; no definition editing; H/R |
| `DELETE /api/issues/{id}/properties/{propertyId}` | `DeleteIssueProperty` | Bodyless; same property/workspace checks | Same scoped value deletion; H/R |
| `POST /api/upload-file` | `UploadFile` | Same multipart file and issue/comment/task/chat-session IDs and limits | Same target ownership, storage/reference writes and wakeup ancestry; H/R |
| `DELETE /api/attachments/{id}` | `DeleteAttachment` | Bodyless; same uploader/grantor-admin validation | Same storage/reference deletion; H/R |

No new scheduling or configuration capability was added to these routes.
Quick-action optional targets and runtime revocation use existing denied
configuration/action routes. Their UI and service changes do not expand the
external-conversation allowlist.

## Migration identities and execution order

All four incoming SQL files match upstream byte for byte:

| Full filename | SHA-256 |
| --- | --- |
| `583_runtime_profile_add_muse.up.sql` | `12a58c12b4d699cc77f8a8e87809efeda35389118fdae5ea912c62b166461496` |
| `583_runtime_profile_add_muse.down.sql` | `c6bf58629868ea1bc55451164de930f286f550c11eda359ea21c4c5dbbb5cedd` |
| `584_quick_action_optional_target.up.sql` | `4581467ce6826f2b1defcd0cf327ac5f51c7e1ee2b590d519ee843d897a39585` |
| `584_quick_action_optional_target.down.sql` | `297b708c620901ee6b4c3dcc6e454a83b942bb6de1abe8cb6a328c113ca71f32` |

Every SQL file already present in the fork baseline is unchanged. Comparing all
shared migrations against upstream leaves exactly the two inherited overrides:

| Full filename | Upstream blob | Fork baseline/result blob |
| --- | --- | --- |
| `467_autopilot_trigger_creator_from_autopilot.up.sql` | `40a3888825985738469996a1596110ae62038ac6` | `9d9719921186f406855115c4a5a7e73b9c377896` |
| `467_autopilot_trigger_creator_from_autopilot.down.sql` | `1c32fd2368ae0ae78e2bf5dc8886b780cbed69eb` | `ee35bfe58e35fccdeee0e32d4ae077fac5136c15` |

As recorded in OL-110 T14 and the previous sync, upstream 467 infers a missing
trigger principal from the autopilot creator. The shipped fork deliberately
does no backfill, and unresolved triggers fail closed until explicitly recreated.
Its down restores comments, not data. Existing installations never rerun either
file. No released identity was rewritten.

`capture_issue_wakeup` is still defined by upstream 579, fork
`9009_labrastro_wakeup_conversation_provenance` and
`9028_labrastro_wakeup_skip_handed_to_agent`. Neither 583 nor 584 touches it.
There are no fork overrides of the protocol whitelist or quick-action
constraints to reconcile. Fork migrations 9028–9034 and
`TestLabrastroWakeupCaptureMigrationInventory` remain intact.

The production migration runner, built with Go 1.26.9, ran against disposable
PostgreSQL 15 databases. Starting directories were extracted from the exact
commits above. This verifies migration execution, not production data sampling.

| Path | Starting ledger | New execution order | Final ledger |
| --- | --- | --- | --- |
| Fresh install | Empty | All upstream files in lexical full-stem order, including 583 then 584, followed by fork 9001–9034 | 685 |
| Production direct upgrade | 658 entries from `f83c9753b` | 564–579, 581–584, then 9028–9034 (27 files; no upstream 580) | 685 |
| Current main upgrade | 683 entries from `6e6965ec0`, already through 9034 | 583, then 584 (2 files, after already-recorded 9034) | 685 |

The validation attachment records each applied full stem and every incoming
file hash. Migration inventory and runner tests supplement these three actual
database runs.

## Validation and checklist

- Handler route semantics, field inventory and frozen-principal review are
  enumerated above. The sole new route remains denied by default.
- Migration identities, inherited overrides, function inventory and all three
  execution orders are recorded above. No new fork migration is required.
- The ten gofmt exceptions remain the exact unformatted upstream blobs at
  `654b8ca954034f8181eb6bbb4fc298dede760156`. Only their source comment changed;
  no exemption was added or widened. Both gofmt scripts pass.
- sqlc v1.31.1 regenerated all affected queries. Repeated generation leaves all
  81 generated Go files byte-identical.
- Branding and absence guards remain active. The Cursor supplement's new
  user-facing product name is Labrastro. Marketing/onboarding implementations
  remain behind the existing route, step-list and mount gates.
- Go validation uses Go 1.26.9. Git 2.50.1 is used for worktree tests requiring
  `merge-tree --merge-base`; the host Git 2.39 is insufficient. The four Cursor
  process-group tests requiring Linux 6.9 pidfd flags run in a disposable Linux
  6.12.95 QEMU guest, all passing. The rest of `pkg/agent` runs on the host with
  exactly those four tests partitioned out; no source skip or weakened process
  ownership fallback was added. The validation logs identify both partitions.
- Frontend verification includes root typecheck/lint, all affected workspace
  suites, Mobile typecheck/lint/tests, `pnpm test:brand`, backend branding and
  Desktop build. Concurrency is bounded when running the large test suites;
  unbounded runs exhausted PostgreSQL connections and caused packaging-test
  timeouts. No assertions or timeout thresholds were relaxed.
- The isolated retained gate must run from a clean detached worktree at the
  exact delivered head, including onboarding-smoke, dag-task-lines and
  issue-dependencies. Its head, outcome and report attachment are recorded in
  the PR and issue handoff, avoiding a self-referential SHA in this file.
- The only CI workflow change adds upstream's `scripts/check.test.sh` step.
  Retained E2E and `CI required` gates remain. Claude reviews first, then GLM;
  the final reviewer verifies `CI required` for the exact head and merges.
  Local browser tests and Desktop build do not verify native installation or
  mobile simulator rendering.
