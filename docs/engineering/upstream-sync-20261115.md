# Upstream v0.9.0 sync — 2026-11-15 (OL-1362 / OL-1365)

This record covers Stages 1–3 on `sync/v0.9.0-ol-1362`, targeting
`AstralSolipsism/multica:main` and the subsequent `v0.9.0-labrastro.1` release.
Deployment and release publication remain separate work.

## Ancestry

| Boundary | Full SHA |
| --- | --- |
| Merge base / v0.8.2 | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` |
| Fork base / M1 first parent | `809744df16f553a226dc1fb3b26cff11e1388231` |
| Upstream v0.9.0 / M1 second parent | `8cd8a2db978d532d8627c78cd29f05deab6c6f17` |
| Two-parent merge M1 | `1fe7db5fdb5426de3bf79ffafe0b44adc40f5dd8` |
| #10566 broken-stdio protection | `9ec95452cf779c42c6a0736807b7610f5a8f7351` |
| Stage 1 reviewed head | `1e38f69b60ed024a976e2dc2c052481c700a998b` |
| Stage 2 reviewed implementation | `2a5586dcefb5a5bd8cca0c427360b076f4da897e` |
| Stage 3 notification heading fix | `1bbfffe4b1738739380282cb06e9fb95b9f0ebd8` |
| Stage 3 claim fixture isolation | `64d5838336bef701013ea1bdcc18b1c498a0a977` |

#10566 comes from `dfcc633dda2e8ee865b2feb23a1778ce20f93988`; no other post-v0.9.0 commit was cherry-picked
in this sync. History is append-only, without rebase. The final archive commit
and its evidence are pinned by the full candidate SHA in the PR and issue handoff.

## Migration identities and PG17 evidence

All 40 incoming SQL files (20 pairs below) are byte-identical to v0.9.0.
Verification compares `git rev-parse <upstream>:server/migrations/<filename>`
with `git hash-object --no-filters <filename>` for every upstream migration.
Only the historical 467 pair differs. Existing full stems are preserved.

| Incoming migration stem (both `.up.sql` and `.down.sql`) | Upstream identity |
| --- | --- |
| `637_issue_environment_kind` | byte-identical |
| `638_issue_environment_control` | byte-identical |
| `639_issue_environment_command_pending_idx` | byte-identical |
| `640_issue_environment_command_issue_idx` | byte-identical |
| `641_issue_environment_command_logs_idx` | byte-identical |
| `642_issue_environment_config_issue_idx` | byte-identical |
| `643_issue_requester` | byte-identical |
| `644_issue_requester_index` | byte-identical |
| `645_issue_member_creator_index` | byte-identical |
| `646_theme_store_download` | byte-identical |
| `647_project_subscriber` | byte-identical |
| `648_project_subscriber_user_idx` | byte-identical |
| `649_task_context_receipt` | byte-identical |
| `650_task_context_receipt_workspace_idx` | byte-identical |
| `651_task_context_receipt_issue_idx` | byte-identical |
| `652_runtime_profile_add_droid` | byte-identical |
| `653_chat_submission_receipt` | byte-identical |
| `654_chat_submission_receipt_key` | byte-identical |
| `655_chat_submission_receipt_workspace` | byte-identical |
| `656_runtime_profile_add_amp` | byte-identical |

The retained 467 override never infers trigger authority from the autopilot
creator: it only documents the principal; unresolved triggers remain denied.
Installed ledgers do not rerun it. Its full identities remain:

| Filename | v0.9.0 blob | Fork blob |
| --- | --- | --- |
| `467_autopilot_trigger_creator_from_autopilot.down.sql` | `1c32fd2368ae0ae78e2bf5dc8886b780cbed69eb` | `ee35bfe58e35fccdeee0e32d4ae077fac5136c15` |
| `467_autopilot_trigger_creator_from_autopilot.up.sql` | `40a3888825985738469996a1596110ae62038ac6` | `9d9719921186f406855115c4a5a7e73b9c377896` |

`9066_labrastro_retire_conversation_provenance` still restores the
`579_wakeup_skip_handed_to_agent` definition of `capture_issue_wakeup` after
9009/9028. The definition inventory,
byte comparison and fresh/upgrade order tests protect this contract.

A new UTF-8 PostgreSQL 17 cluster with pgvector was used, with task-owned data
and loopback-only access. Neither production nor a shared development database
participated. The production migration runner was used throughout:

- Fresh: empty database, current 001–656 and 9001–9075, including released
  historical full stems; **793** ledger entries.
- Upgrade: fork-base runner and files at `809744df16` apply 001–636 and
  9001–9075 (**773** entries), then the current runner adds exactly 637–656.
- Rollback: clone of the upgraded database, a directory containing only the
  20 incoming pairs, production runner `down` in reverse order, then `up`.
  The ledger returns to 773 and then 793 entries.

All three normalized schema SHA-256 values are identical:
`9a7d755eb76c18d00223eb149c28b869e654abdee29ad8a1caac18325dcc593e`.
Each has **zero invalid indexes**. Normalization removes only randomized
`\restrict` / `\unrestrict` lines from
`pg_dump --schema-only --no-owner --no-privileges`; no schema object, column
order, function, constraint, index or comment is discarded.

## Engineering insertion measurements

Measured with `git diff -U0 8cd8a2db978d532d8627c78cd29f05deab6c6f17 HEAD -- <file>`
and the checklist identifier-line metric. The unrelated YSK documentation
reference and `tabStorage?.setBaseline` are excluded exactly as documented.
All imports/calls and their fork definitions survive; typecheck and Go package
checks validate the wiring. **22 files, 54 lines, no budget increases.**

| Upstream file | Measured / budget |
| --- | --- |
| `packages/views/projects/components/project-detail.tsx` | 2 / 2 |
| `packages/views/layout/panels/work-tree.tsx` | 2 / 2 |
| `packages/core/realtime/use-realtime-sync.ts` | 4 / 4 |
| `packages/core/types/events.ts` | 8 / 8 |
| `packages/core/projects/queries.ts` | 4 / 4 |
| `packages/core/projects/mutations.ts` | 2 / 2 |
| `packages/core/api/index.ts` | 1 / 1 |
| `apps/desktop/src/renderer/src/App.tsx` | 5 / 5 |
| `apps/desktop/src/renderer/src/stores/tab-store.ts` | 4 / 4 |
| `apps/desktop/src/renderer/src/routes.tsx` | 4 / 4 |
| `packages/core/paths/paths.ts` | 2 / 2 |
| `packages/views/projects/components/index.ts` | 1 / 1 |
| `packages/views/i18n/resources-types.ts` | 2 / 2 |
| `packages/core/diagnostics/diagnostic-context.ts` | 1 / 1 |
| `server/cmd/server/router.go` | 1 / 1 |
| `server/cmd/multica/main.go` | 1 / 1 |
| `server/cmd/multica/cmd_project.go` | 2 / 2 |
| `server/internal/handler/project_resource.go` | 1 / 1 |
| `server/internal/handler/project.go` | 2 / 2 |
| `server/internal/service/issue.go` | 3 / 3 |
| `server/internal/handler/workspace.go` | 1 / 1 |
| `packages/core/package.json` | 1 / 1 |

The seven backend plugs remain 11 lines; the fifteen frontend plugs remain
43. CLI attachment rewriting has no fork plug: upstream `applyAttachmentLinks`
owns it. The checklist now names the actual project deletion hook,
`projectKeys.engineeringAll`.

## Retained decisions and access boundaries

1. Duplicate implementations converge to upstream: #10362 owns attachment
   link rewriting; #10469 owns persisted `submission_id` receipts and
   `useChatController`. `client_message_id` / `ChatSendAttempt` are retired;
   execution history and YSK side-chat integration survive.
2. Workspace `TeamSubscriptionsSection` is mounted in Settings → Notifications,
   alongside personal delivery settings, with component regressions.
   Both OMP runtime configuration entry points remain.
3. Theme store access defaults off unless explicitly enabled. Five built-in
   themes and local zip/folder imports remain available.
4. Completed-task directory GC defaults to zero; an explicitly positive TTL
   still enables it.

Private-project verification covers hidden lists/search, issue descendants,
comments/attachments, run transcripts/context receipts, environment controls,
subscriber inbox events, membership revocation, and message delivery at send
time. Workspace deletion covers all five incoming tables:
`project_subscriber`, `task_context_receipt`, `issue_environment_command`,
`issue_environment_config`, `chat_submission_receipt`. Chat receipts retain
session ownership checks. GitHub connection return-state handling retains
OL-955 actor binding; marketing stays 404/noindex, StarPrompt unmounted,
`issue-chip` list queries disabled, and engineering/DAG/YSK entry points intact.

## Validation environment and results

Go 1.27.4; Git 2.45.2 with HTTPS transport; Node 24.21.0; pnpm 10.28.2;
PostgreSQL 17.11 / UTF8; Playwright 1.58.2 Chromium; Linux 5.15.0-157.
Go tests use an explicit task-local database and the repository agent-CLI guard.
No real-agent integration smoke is run.

- All **110 Go packages** are accounted for: **93 pass**, **16 have no test
  files**, and the agent package has only the four accepted failures below.
  Message delivery runs after Service, as required by `scripts/test-go.sh`.
- The agent race suite has only the four accepted Linux 5.15 failures:
  `TestCaptureCursorBackgroundLateDescendant`,
  `TestCaptureCursorBackgroundProcessReapsLeaderExitedGroup`,
  `TestCaptureCursorBackgroundSurvivesRootExitDuringCapture`, and
  `TestCursorBackgroundLifecycle`. The kernel lacks Linux 6.9 group-pidfd
  signaling; `server/pkg/agent` is byte-identical to the Stage 1 reviewed head.
  These failures are not a blocker under OL-1365’s explicit exception.
- Handler and Service pass complete race reruns, sequentially on separate new
  migrated databases. The initial Service run reported a missing wakeup
  diagnostic and an isolated-database cleanup timeout while the handler
  rerun was active; its final run passes with `-parallel 2`, without code or
  assertion changes. WeCom also passes a complete `-parallel 2` race rerun
  after its 160ms acceptance-window test overran under load. Initial failures
  remain in the attached logs.
- Frozen install, dependency catalog, brand sync and brand tests pass.
- Typecheck passes all nine non-Mobile tasks; lint and knip pass.
- Go vet, Go 1.27.4 formatting checks/regressions and sqlc twice with no
  generated diff pass. All pinned upstream formatter exceptions remain
  byte-identical to v0.9.0.
- Script tests pass 170/170 after installing the missing Docker Compose plugin;
  the first attempt failed only because `docker compose` was unavailable.
- Views: **10,152 tests pass**. The changed notifications/team section suites
  additionally pass 17/17 after the heading fix, with final typecheck/lint/knip passing.
- Core: 4,198 pass / one existing skip; UI: 482 pass / one existing skip;
  Desktop: 1,092 pass; Web: 506 pass; Docs: 30 pass; YSK: 20 pass.
- Mobile: typecheck/lint pass, 372 tests pass, and all iOS runner shell assertions pass.
- Wakeup capture inventory, upstream identity and both migration-order tests pass.
- The unmodified `bash scripts/test-retained-e2e.sh` passes **24/24** again on
  implementation `1bbfffe4b1738739380282cb06e9fb95b9f0ebd8`, zero
  failures/skips/retries, including production Go/Web builds and migrations,
  in the isolated task checkout without root/Web dotenv overrides. A separate production
  browser check confirms a single team-subscription heading after the fix.

**Container evidence remains distinct:** this host cannot create mount
namespaces. Docker starts, but the PG17 image cannot be registered:
`Error creating mount namespace before pivot: operation not permitted`.
The local E2E and schema evidence uses a disposable native PostgreSQL service,
not a container. A supported container-host run or explicit acceptance of this
environment difference is still required by OL-1365; the native pass alone
must not be represented as container validation.

Stage 3 browser evidence exposed a duplicated team-subscription heading and
description: both NotificationsTab and its self-contained team section owned
the header. The outer wrapper is removed. The notification test now renders
the real team section and requires a single heading/description plus the
member access explanation; it failed before the fix and passes afterwards.
Full backend runs exposed seven claim tests depending on shared agent/runtime
fixtures: five selected arbitrary rows (`LIMIT 1`), and two continuity-gap tests
used the oldest shared runtime. Each now uses the existing
`createRuntimeGuardAgent` fixture, preserving every response/security assertion
and leaving production claim logic unchanged.
The complete handler race suite passes on a new empty migrated database after
the fixture fix (`64d583833`), in 489.817 seconds. A previous run hit Go's default
ten-minute package timeout; the final run allows twenty minutes without changing
any individual test deadline. Its interrupted fixture database was discarded.

The runtime implementation commit is
`1bbfffe4b1738739380282cb06e9fb95b9f0ebd8`. Its runtime/CI/script/dependency
`git ls-tree -r` listing has SHA-256
`6859cd365145c3196c351b3c3fe8707631fdf00982a59190bab7ead88db096f1`.
The archive commit and final
retained-E2E evidence are pinned together in the issue handoff.
Raw logs, schema dumps and browser reports are delivered as issue attachments,
never committed to this repository. Desktop packaging, native mobile rendering,
production deployment and release publication are not claimed by these checks.

## Deployment handoff (mandatory)

Before deploying **v0.9.0-labrastro.1** and executing the destructive 9067
baseline reset, export the eight adopted documents from 网络环境管理
(`d6540cb5-2e7e-496c-91b4-161fd35dc241`) with
`"$MULTICA_CLI_PATH" project baseline export`. Preserve the on-disk backup
and per-document character counts (**36,882 total**). Immediately restore the
content into the new baseline Wiki tree after upgrade and verify every count.
This sync does not perform the export, restore or production migration.

Set both operational overrides explicitly:
`MULTICA_THEME_STORE=off` and `MULTICA_GC_COMPLETED_TASK_TTL=0`.

Two reviewers from different model families must review the final head
sequentially; the second reviewer owns merging after the required CI gate.
No screenshot, evidence archive or temporary audit script belongs in Git.
