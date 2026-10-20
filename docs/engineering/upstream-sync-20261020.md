# v0.6.3 integration

OL-927 integrates the fixed upstream release and the separately approved GitHub
snapshot patch. The PR targets Labrastro `main`; release publication, production
migration and native package installation are separate operations.

| Source | Commit |
| --- | --- |
| Fork base, `v0.6.1-labrastro.6` | `f83c9753bbf1c52690bee642b94af18b7d60c6b3` |
| Upstream `v0.6.3` | `18fa9f728a9e25f2465df2789631edb2a75442ad` |
| Two-parent merge | `fc73c28ad73fe84e37c7e6c78d4b6447ad7cc21f` |
| Approved upstream patch | `8d95e805596d05c1e68b3e5c81a525edee691cbb` |
| Patch cherry-pick with source attribution | `1699a7686c3c2d9fb4f2af9e16e3e47bec467b02` |

The merge includes the release's full history. The patch is a cherry-pick, so its
later upstream ancestors are not imported. Follow-up commits repair integration
points and update retained regression coverage.

## Resolved behavior

- Antigravity uses upstream's trailing transport-error classification and
  completion recovery. Master approved the review's recommended amendment to
  decision 2 on 2026-10-20: `stream_scanner.go` retains the fork's linear
  short-read splitter from `e80f05780` on top of the upstream file. This is the
  only scanner difference; upstream `readAgentStreamLine` and scanner tests
  remain unchanged. Independent fork skill-invocation and usage-accounting
  extensions remain. `antigravity-completion.md` records the adopted rules and
  the OL-910 protections relinquished by the decision.
- Workflow handoffs use the existing assignment checks and DAG transaction
  guards. The generated assignee must be included in the transaction's explicit
  write fields: otherwise refreshing untouched fields under the row lock
  silently restores the old assignee. Each batch item gets its own map.
- Both scheduler queues retain backlog exclusion for system rules, skipped IDs,
  bounded batches and upstream metrics. System dispatch still groups receipts
  by the authorized human and conversation root. Advancing a condition's next
  poll retains the latest PR diagnostic rather than clearing `last_error`.
- Workflow modals, status filtering and run-cost details coexist with DAG
  editing, partial-rejection feedback, YSK and subscription quota percentages.
  Desktop keeps the YSK provider and removes both obsolete onboarding mounts.
- Labrastro/Mizuki branding, the private update feed, Electron updater patch,
  Feishu grant and delivery boundaries remain. Release builds retain the private
  publishing flow while accepting upstream's Go 1.26.9 floor and build-commit
  metadata, including the full source SHA in backend archives and development
  Desktop CLIs. Deleted welcome strings are removed from the branding overlay.
- External conversation ingestion supplies the persisted `ChatMessageID` on
  both ordinary input and `/new` paths, preserving Feishu typing reactions.
  `TestConversationTypingReceivesPersistedMessageID` exercises the real channel
  router and asserts the typing notifier receives that exact database ID.

## Existing external-conversation routes

The comparison below is against the fork base above. `router.go` still maps each
listed method to the named handler. All routes first authenticate persisted task
ancestry, revalidate the live conversation grant and execute as its frozen human
grantor. Actor identity remains the executing agent. Neither request headers nor
the runtime owner's token record replace that grantor.

Exact old/new decoded fields are recorded in
`server/cmd/server/testdata/labrastro-external-requests.tsv`. Only the two update
routes gain fields: `enter_workflow_step` and `stop_previous_assignee_runs`, both
defaulting to false. The create routes' fields are unchanged but their workflow
behavior changes, so they are explicitly included below.

Evidence keys: **H** = full handler package, including the existing permission,
validation and mutation tests; **R** = real-router `cmd/server` suite, including
every denied route and conversation retry/descendant/wakeup cases; **W** =
`TestLabrastroWorkflowHandoffSurvivesAtomicRefresh`,
`TestLabrastroConversationWorkflowHandoffKeepsGrantor`,
`TestLabrastroWorkflowBatchKeepsPerIssueHandlers`, plus upstream workflow tests.
The workflow-specific real-router evidence is
`TestExternalConversationCannotStopPreviousWorkflowRuns` and
`TestExternalConversationWorkflowDispatchKeepsGrantor`: PUT/PATCH cancellation
denial, create/compound-create/status/project-entry dispatch, frozen grantor/root,
and denial of targets invocable only by the runtime owner.
Test outcomes and the delivered head belong in the PR validation record;
reviewer acceptance is still required.

| Method / route | Handler and dependencies | Request, defaults and validation | Effects and authority / evidence |
| --- | --- | --- | --- |
| `POST /api/issues/query` | `QueryIssues` → issue query helpers | Unchanged filter map; existing workspace/filter validation | Read only, no dispatch; H/R |
| `POST /api/issues` | `CreateIssue` → `IssueService.Create` / workflow / dispatch | Same fields and defaults; new project-workflow status check. Without explicit assignee, resolve the landing step's handler; children inherit parent project | Existing same-workspace parent, dependency, property, attachment and origin-ancestor checks remain. Derived assignee passes invocation validation; dispatch retains grantor/root; H/R/W |
| `POST /api/issues/with-dependencies` | `CreateIssueWithDependencies` → same create path | Same create fields; required dependency version/override validation remains | Same create effects, dependency writes in the existing atomic path; no new configuration authority; H/R/W |
| `PUT /api/issues/{id}` | `UpdateIssue` → workflow / guarded row update / dispatch | Adds the two false-default booleans. External conversations carrying `stop_previous_assignee_runs` receive 403 `external_conversation_forbidden`, including false/null and case-insensitive JSON names. Explicit assignee wins; triage suppresses handoff; stale workflow step returns conflict; existing revision/status validation remains | Workflow-generated assignment survives locked refresh. Status entry or opted-in project move dispatches under the same grantor/root. Rejected cancellation requests leave the issue and previous runs unchanged, including with `suppress_run`; H/R/W |
| `PATCH /api/issues/{id}/with-dependencies` | `UpdateIssueWithDependencies` → same update path and dependency transaction | Same additions and cancellation-field denial as PUT; dependency version, cycle and admission validation unchanged | Same workflow effects with atomic dependency update; rejection occurs before issue, dependency or task writes; H/R/W |
| `POST /api/issues/{id}/comments` | `CreateComment` → comment service / mentions / wakeup capture | Same content, parent, attachments, steering and suppression fields; existing validation. Internal DB errors no longer returned verbatim | Agent mentions retain invocation checks and persisted ancestry; comment/attachment/steering effects unchanged; H/R |
| `PUT /api/comments/{commentId}` | `UpdateComment` | No field/default/validation change | Own-agent authorship or grantor admin required; existing edit, attachment and wakeup effects; H/R |
| `DELETE /api/comments/{commentId}` | `DeleteComment` | Still bodyless; same lookup and authorship/admin checks | Existing deletion scope and activity; no new dispatch/configuration; H/R |
| `DELETE /api/comments/{commentId}/keep-replies` | `DeleteComment` (keep-replies mode) | Still bodyless; same authorship/admin checks | Existing reply-preserving deletion; H/R |
| `POST /api/comments/{commentId}/resolve` | `ResolveComment` | Still bodyless; same issue/workspace validation | Existing thread-resolution mutation/event; H/R |
| `DELETE /api/comments/{commentId}/resolve` | `UnresolveComment` | Still bodyless; same issue/workspace validation | Existing resolution removal/event; H/R |
| `POST /api/comments/{commentId}/reactions` | `AddCommentReaction` | Same emoji field and validation | Reaction attributed to authenticated actor, existing wakeup write; H/R |
| `DELETE /api/comments/{commentId}/reactions` | `RemoveCommentReaction` | Same emoji field and validation | Removes actor's reaction, existing wakeup write; H/R |
| `POST /api/issues/{id}/reactions` | `AddIssueReaction` | Same emoji field and validation | Same issue membership and actor-scoped reaction; H/R |
| `DELETE /api/issues/{id}/reactions` | `RemoveIssueReaction` | Same emoji field and validation | Same actor-scoped removal; H/R |
| `POST /api/issues/{id}/labels` | `AttachLabel` | Same `label_id`, issue/label workspace checks | Same link/revision/event; no catalog creation; H/R |
| `DELETE /api/issues/{id}/labels/{labelId}` | `DetachLabel` | Still bodyless; same workspace validation | Same unlink/revision/event; H/R |
| `PUT /api/issues/{id}/metadata/{key}` | `SetIssueMetadataKey` | Same JSON value, key/size/count validation | Same scoped metadata write; no-op behavior retained; H/R |
| `DELETE /api/issues/{id}/metadata/{key}` | `DeleteIssueMetadataKey` | Still bodyless; same key validation | Same deletion/no-op behavior; H/R |
| `PUT /api/issues/{id}/properties/{propertyId}` | `SetIssueProperty` | Same JSON value contract; upstream adds typed list values and validates against property definition | Same issue-scoped property mutation, no property-definition editing; H/R |
| `DELETE /api/issues/{id}/properties/{propertyId}` | `DeleteIssueProperty` | Still bodyless; same property/workspace checks | Same value deletion; H/R |
| `POST /api/upload-file` | `UploadFile` | Same multipart file/issue/comment/task/chat-session fields and limits | Same target ownership/workspace checks, storage and attachment linkage, wakeup provenance; H/R |
| `DELETE /api/attachments/{id}` | `DeleteAttachment` | Still bodyless; same uploader/grantor-admin validation | Same storage/reference deletion; no broadened actor access; H/R |

New workflow catalog, handoff-preview and project-workflow endpoints remain
denied, as does the new attachment download-metadata route. Removed onboarding
bootstrap endpoints disappear from the inventory. No allowlist entries were
added. The new workflow regression checks both new update fields, private-agent
grantor authority, denial when only the runtime owner can invoke the target,
live grant revocation and cancellation denial. First-party callers retain
upstream's optional cancellation behavior; the external-conversation capability
boundary is not expanded.

## Migration identities and execution order

All **36 incoming SQL files** (up/down for 564–579 and 581–582) match upstream
`18fa9f728a9e25f2465df2789631edb2a75442ad` byte for byte. There is no upstream
580 in this release. Comparing every shared migration identifies exactly these
two existing fork overrides; neither changed in this integration:

| Full filename | Upstream blob | Fork base and resulting blob |
| --- | --- | --- |
| `467_autopilot_trigger_creator_from_autopilot.up.sql` | `40a3888825985738469996a1596110ae62038ac6` | `9d9719921186f406855115c4a5a7e73b9c377896` |
| `467_autopilot_trigger_creator_from_autopilot.down.sql` | `1c32fd2368ae0ae78e2bf5dc8886b780cbed69eb` | `ee35bfe58e35fccdeee0e32d4ae077fac5136c15` |

The upstream up migration infers missing trigger principals from autopilot
creators. Labrastro's shipped 467 only documents the column: a missing principal
still fails closed and requires explicit recreation. Its down restores comments
without undoing data. Existing installations do not rerun either file. New
installations retain the no-backfill decision recorded in OL-110 T14 and the
previous sync; migration 449's historical publisher inference is unchanged.

`9009_labrastro_wakeup_conversation_provenance.up.sql` remains the same blob
`d041acc20cda075e42c4d408577fd02b9e16f703`. Neither it nor upstream 579 was edited.
New `9028_labrastro_wakeup_skip_handed_to_agent.up.sql` combines 9009's complete
function with 579's handed-to-agent predicate. Its down restores 9009's function
without the predicate.

`TestLabrastroWakeupHandoffMigrationOrders` creates an isolated transactional
schema with the wakeup, receipt and task columns used by the real functions.
It executes the real SQL in both orders:

1. Fresh installation: upstream 579 → fork 9009 → fork 9028.
2. Existing fork installation: fork 9009 → newly arriving upstream 579 → fork 9028.

Both check issue-event suppression only for the handed-to agent, continued
delivery to other agents and system rules, unaffected comment events, root
preservation after a first-party event coalesces, conflicting-root marking and
9028 down preserving provenance while restoring delivery. The migration
inventory includes 579, 9009 and 9028 only after this behavior test. The full
`cmd/migrate` tests separately exercise the production migration runner.

## Formatting and delivery gates

The ten existing Go formatting exceptions are still byte-identical to upstream
v0.6.3. Their blob IDs were checked against that source and their working files;
the manifest's source commit changed, no exemption was added. Fork edits remain
subject to gofmt. Both formatting scripts are part of validation.

The PR validation record includes SQL generation reproducibility, brand checks,
backend suites, frontend/mobile type checks and tests, and the isolated retained
browser gate. That gate builds the application from a clean detached worktree,
using only disposable local PostgreSQL, and runs both onboarding absence and DAG
specs. Browser evidence does not establish native installation behavior.

CI/release changes require two sequential expert approvals. The reviewer owns
merge after the final head's required CI gates pass.
