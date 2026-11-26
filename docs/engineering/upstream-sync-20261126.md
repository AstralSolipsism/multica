# Upstream v0.13.0 sync — 2026-11-26 (OL-1517 / OL-1520)

Stages 1–4 share `sync/v0.13.0-ol-1517`, targeting
`AstralSolipsism/multica:main`. Stage 1 (OL-1518) owns the two-parent merge
base `M1`, server/CLI three-way fusion, retiring the fork's `issue_dependency`
backend/CLI in favor of upstream's native `issue_blocker`, pure data migration
`9079` and retargeting `GET /api/workspaces/{workspaceId}/issues/graph` onto
`effective_issue_blocker`. Stage 2 (OL-1519) owns frontend/Core/Web/Desktop
three-way fusion, retiring duplicate dependency UI, retargeting the retained
DAG canvas onto native blockers, realigning engineering and HTML dynamic-block
thin plugs, and real-browser screenshots. Stage 3 (OL-1520) owns independent
PostgreSQL 17 four-path migration parity (including `9079` live-data and
cycle-conflict verification), isolated retained E2E execution, this sync
record and opening the sole formal PR (kept **OPEN** pending Stage 4 after
cross-family dual review and green remote `CI required`). Stage 4 (OL-1521)
owns the whole-branch file-by-file, line-by-line restraint and necessity audit
before Master's release sign-off; Stage 5 (OL-1522) owns tagging and deploying
`v0.13.0-labrastro.1`.

## Ancestry

| Boundary | Full SHA |
| --- | --- |
| Merge base / `v0.11.1` | `e1fe10d6694848e35dd1aa00e08cd11d93e545ac` |
| Released production baseline (`v0.11.1-labrastro.2`) | `055423a63c999b3ca940fec61134c3b485c7097c` |
| Fork `origin/main` / `M1` first parent | `d0fde9ffc33feafc25c68cb88cdec6915ebfd95c` |
| Upstream `v0.13.0` / `M1` second parent | `35b54a3742bb51bdf5ffa688655367ec98044862` |
| Two-parent merge `M1` | `f5014b69b12c16e328a931e7054c625a34e2753a` |
| Stage 1 primary fusion commit (OL-1518) | `af079ef47d1971d0b91571a938775c56dcac634d` |
| Stage 1 reviewed head (OL-1518) | `30d98d18e751ed1d4372df1fac8c93a87cd5390a` |
| Stage 2 primary fusion commit (OL-1519) | `0873827fe8ad497723815082da619890bf055a4c` |
| Stage 2 DAG review fix commit (OL-1519) | `05de82adad1e673478ad2e44a1f83d436e83d249` |
| Stage 2 reviewed head / Stage 3 tested application head | `58e5b762c8ecc17d3cc37bb981e1ddbbf260eb14` |
| Stage 3 reviewed head / Stage 4 audit baseline (`H0`) | `f6c6d9b050c56e6a6a791bbac46b8f92d30a96c6` |

`v0.11.1..v0.13.0` spans **361 commits** across `v0.12.0`, `v0.12.1`, `v0.12.2`
and `v0.13.0` (59 new migration stems `697`–`755`). Zero unreleased commits
from `v0.13.0..upstream/main` were cherry-picked. History is strictly
append-only (no rebase), `origin/main` remains at
`d0fde9ffc33feafc25c68cb88cdec6915ebfd95c`, `git merge-tree --write-tree
origin/main HEAD` confirms a clean merge, and all external upstream-PR
candidate branches (`upstream-pr/*`, `upstream-base/*`, `feat/*`, `fix/*`)
were untouched.

## Approved decisions (1A + 2A + 3) and pre-stage rulings

1. **1A — Converge blocking dependencies onto upstream native `issue_blocker` (`MUL-8860`, migrations `743`–`746`, `754`) while retaining Labrastro's DAG canvas**:
   - **Backend & CLI retirement**: deleted 27 fork `issue_dependency` files
     (`server/internal/service/issue_dependency*.go`,
     `server/internal/handler/issue_dependency*.go`,
     `server/internal/handler/dependency_*.go`,
     `server/internal/issuedependency/`,
     `server/cmd/multica/cmd_issue_dependency*.go`,
     `server/cmd/audit_issue_dependencies/`,
     `server/pkg/db/queries/issue_dependency.sql`,
     `server/internal/service/builtin_skills/multica-platform/references/issue-dependencies.md`).
     All six historical `issue_dependency` plugs in
     `server/cmd/multica/cmd_issue.go` are removed; blockers use upstream's
     native `--blocked-by`, `--remove-blocked-by` and `--blocked` flags.
   - **Frontend redundant UI retirement**: removed
     `packages/views/issues/components/issue-dependencies-section.tsx`,
     `dependency-prerequisites.tsx`, `packages/views/modals/edit-dependencies*.tsx`,
     `packages/core/api/labrastro-dependency-api.ts`,
     `packages/core/api/dependency-schemas*.ts`,
     `packages/views/locales/*/dependencies.json`, obsolete dependency unit
     tests and `e2e/issue-dependencies.spec.ts`. Detail Relations (`#11414`),
     menu/context add-blocker (`#11394`), list/board blocked badge & hover card
     (`#11396`), `Blocked` filter (`#11395`) and right sidebar slimming
     (`#11352`) are adopted verbatim from upstream `v0.13.0`.
   - **R2 ruling — `filter-dependency.ts` retained**:
     `packages/core/issues/surface/filter-dependency.ts` and
     `packages/core/issues/surface/filter-dependency.test.ts` are upstream
     `MUL-8591` generic client-side filter prerequisite coordination (unrelated
     to the retired `issue_dependency` table). Both were removed from the
     deletion set and restored to **0-diff** against `v0.13.0`
     (`35b54a3742bb51bdf5ffa688655367ec98044862`).
   - **Retained DAG topology canvas (`List | Board | Table | DAG`)**: kept
     fork-owned `packages/views/issues/dag/*`, `packages/core/issues/dag/*` and
     read-only `GET /api/workspaces/{workspaceId}/issues/graph`
     (`issue_graph.{go,sql}`), switching the graph query to upstream
     `effective_issue_blocker`. The canvas distinguishes editable
     `manual:<issue>:<blocker>` edges from read-only `stage:<issue>:<blocker>`
     edges, delegates writes to upstream native blocker mutations, enforces the
     workspace Guest 403 boundary and `projectaccess` private-project
     isolation, and keeps minimal thin plugs in host files.
2. **2A — Lossless historical data migration `9079` (`issue_dependency` → `issue_blocker`)**:
   - Added pure data migration
     `server/migrations/9079_labrastro_migrate_issue_dependency_to_blocker.{up,down}.sql`
     with zero DDL (`issue_dependency` and `issue_dependency_audit` stay intact
     so schema parity and historical records are never lost).
   - **R1 attribution ruling**: both forward `type = 'blocked_by'` and reverse
     `type = 'blocks'` edges preserve the dependent issue's
     `(creator_type, creator_id)` pair (`member` or `agent`).
   - Non-blocking `'related'`, self-loop and cross-workspace rows are ignored;
     any legacy edge violating upstream's cycle (`issue_blocker_cycle`) or
     ancestor-descendant (`issue_blocker_ancestor`) triggers is caught by
     `EXCEPTION WHEN check_violation`, logged via `RAISE NOTICE` and skipped
     without failing the upgrade. `9079.down.sql` is a safe no-op (`SELECT 1;`).
3. **3 — Retained fork capabilities, release contract and production toggles**:
   - **Project folders (`server/ee` & `packages/ee`)**: kept **0-diff** vs
     `v0.13.0` (`35b54a3742bb51bdf5ffa688655367ec98044862`), absorbing all four
     upstream `packages/ee` updates while preserving OL-1485 private-project
     realtime fencing and workspace folder-write locking; both default and
     `-tags oss` builds and `./cmd/server/...` suites pass.
   - **Engineering module & baseline Wiki (`OL-1494`)**: all 22 upstream thin
     plugs survived at **60 lines** total (within the prior 61-line budget),
     with `ProjectEngineeringHeaderActions` mounted on the `#10627` refactored
     project detail header.
   - **Same-entity HTML attachment `src` & decision-card bridge (`OL-1422`/`OL-1494`)**:
     aligned with upstream `#11163` dynamic-block refactoring
     (`editor/utils/fence-title.ts`, `dynamic-block.tsx`,
     `html-block-preview.tsx`, `streaming-fence.ts`).
   - **8-provider unified Runtime quota (`OL-1472` 3A)**: continues rendering
     `RuntimeQuotaCell` / `RuntimeQuotaCard` (upstream `RateLimitSection` /
     `RateLimitCell` remain absent) alongside `#11557` inline runtime
     visibility editing.
   - **Recent thin plugs**: preserved Antigravity managed MCP (`OL-1513`),
     Chat streaming folding and intermediate reply visibility (`OL-1510`) and
     optional `NEXT_ASSET_PREFIX` (`OL-1508`).
   - **Self-hosted defaults, branding & security boundaries**: commercial
     entitlement gates stay `off` when `h.Features == nil`; `StarPrompt` stays
     unmounted; `SHOW_SOURCE_BACKFILL = false`; `you_should_know = "all"`
     coexists with upstream `status_changes = "muted"`, `auto_archive_prompt`
     and `squad_handoff`; `server/internal/daemon/planquota_kimi.go` has
     **0-diff** vs fork `main` `d0fde9ffc3` (same-UID peer-proof boundary
     untouched).
   - **Production 149 toggles (Stage 5)**: keep `FF_DOCS_V1=false` and
     `FF_ISSUE_DESCRIPTION_LIVE=false` and do **not** deploy `multica-collab`;
     generate and inject a 32-byte base64 `MULTICA_APPS_SECRET_KEY` (zero
     plaintext secrets in logs/docs) into `multica-backend` so Connected Apps
     with Composio (`OL-1516`) also support remote OAuth MCP.

## Fork candidate release chain retained (`ours` in M1)

The three release-orchestration files keep **0-diff** vs fork `main`
(`d0fde9ffc33feafc25c68cb88cdec6915ebfd95c`), preserving Labrastro's offline
single-tag `candidate` release contract (no `multica-collab` image built or
published):

| File | Resolution vs `d0fde9ffc3` | Verification in Stage 3 / 4 |
| --- | --- | --- |
| `.github/workflows/release.yml` | 0-diff (fork `ours`) | `actionlint .github/workflows/release.yml .github/workflows/ci.yml`: clean |
| `.goreleaser.yml` | 0-diff (fork `ours`) | `goreleaser check` (v2.18.0): 1 configuration file validated |
| `.github/RELEASING.md` | 0-diff (fork `ours`) | Offline single-tag `candidate` contract intact |

CI workflow policy note (`.github/workflows/ci.yml`): Labrastro intentionally
replaces upstream's broad Playwright `e2e` job with the isolated
`retained-e2e-tests` job (`scripts/test-retained-e2e.sh` +
`playwright.retained.config.ts`, covering `e2e/onboarding-smoke.spec.ts`,
`e2e/dag-task-lines.spec.ts` and `e2e/comments.spec.ts`) as documented in
[CI gates](ci-gates.md). Both `CI required` aggregates enforce
`retained-e2e-tests` alongside `backend-format`, `frontend-test`,
`frontend-build`, `backend-tests` and `script-checks`.

## Migration identities and PostgreSQL 17 evidence

The ledger contains **896 full migration identities**: **821** in `001`–`755`
(762 carried forward from `v0.11.1` + 59 incoming `697`–`755`) and **75** in
`9001`–`9079` (`9055`–`9058` remain historically absent; `9079` is the sole new
fork migration). Every stem has a complete `.up.sql` / `.down.sql` pair.

All **59 incoming upstream stems (`697`–`755`, 118 SQL files)** are 100%
byte-identical to upstream `v0.13.0`
(`35b54a3742bb51bdf5ffa688655367ec98044862`), verified by comparing
`git rev-parse <upstream>:server/migrations/<file>` with `git ls-tree HEAD`:

| Range | Incoming stems (59 stems / 118 SQL files) | Up/down identity |
| --- | --- | --- |
| `697`–`702` | `697_autopilot_run_idempotency_key`, `698_autopilot_run_idempotency_key_idx`\*, `699_member_guest_role`, `700_member_search_access`, `701_member_search_access_pkey_index`\*, `702_member_search_access_pkey` | byte-identical |
| `703`–`709` | `703_doc_comment`, `704_doc_comment_pkey_index`\*, `705_doc_comment_pkey`, `706_doc_comment_doc_idx`\*, `707_doc_comment_workspace_idx`\*, `708_attachment_workspace_size_idx`\*, `709_drop_attachment_workspace_index`† | byte-identical |
| `710`–`717` | `710_autopilot_quota_limit_notice`, `711_dashboard_range_view`, `712_dashboard_range_view_scope_idx`\*, `713_doc_collab`, `714_doc_collab_state_pkey_index`\*, `715_doc_collab_state_pkey`, `716_doc_revision_pkey_index`\*, `717_doc_revision_pkey` | byte-identical |
| `718`–`722` | `718_auto_archive_prompt`, `719_remote_app_connection`, `720_remote_app_oauth_client_idx`\*, `721_remote_app_connection_owner_idx`\*, `722_auto_archive_agent_trigger_prompt` | byte-identical |
| `723`–`730` | `723_issue_description_collab`, `724_issue_description_collab_state_pkey_index`\*, `725_issue_description_collab_state_pkey`, `726_issue_description_revision_pkey_index`\*, `727_issue_description_revision_pkey`, `728_app_account_requests`, `729_remote_app_connection_workspace_idx`\*, `730_drop_remote_app_connection_owner_idx`† | byte-identical |
| `731`–`734` | `731_skill_revision`, `732_comment_idempotency_receipt`, `733_comment_idempotency_receipt_key`\*, `734_comment_idempotency_receipt_created`\* | byte-identical |
| `735`–`742` | `735_task_usage_hourly_squad_col`, `736_task_usage_hourly_squad_uq_idx`\*, `737_task_usage_hourly_dirty_squad_uq_idx`\*, `738_task_usage_hourly_workspace_squad_idx`\*, `739_task_usage_hourly_squad_pipeline`, `740_task_usage_hourly_drop_legacy_key`†, `741_task_usage_hourly_dirty_drop_legacy_key`†, `742_task_usage_hourly_squad_rollback_merge` | byte-identical |
| `743`–`747` | `743_issue_blocker`, `744_issue_blocker_unique`\*, `745_issue_blocker_reverse`\*, `746_issue_blocker_rules`, `747_squad_handoff_mode` | byte-identical |
| `748`–`755` | `748_app_tool_call_quota_period`, `749_app_tool_call_quota_period_scope_idx`\*, `750_app_tool_call_quota_columns`, `751_app_tool_call_workspace_metered_idx`\*, `752_doc_comment_agent_runs`, `753_agent_task_queue_doc_idx`\*, `754_issue_stage_blockers_skip_top_level`, `755_task_usage_hourly_rollup_hour_key` | byte-identical |

\* denotes the **24** incoming `CREATE INDEX CONCURRENTLY` up-migrations
registered in `concurrentIndexCleanups`; † denotes the **4** incoming
`CREATE INDEX CONCURRENTLY` down-migrations registered in
`concurrentDownIndexCleanups` (`server/cmd/migrate/main.go`).
`go test -count=1 ./cmd/migrate` (including `TestEveryConcurrentUpBuildHasCleanup`
and `TestLabrastroIssueDependencyMigratesToBlockers`) passes in **60.19s**.

All 836 existing migrations from `v0.11.1-labrastro.2` (`055423a63c`) and fork
`origin/main` (`d0fde9ffc3`) retain identical bytes. Across the entire upstream
inventory (`001`–`755`), only the historical `467` override differs:

| Filename | `v0.13.0` blob | Fork blob |
| --- | --- | --- |
| `467_autopilot_trigger_creator_from_autopilot.down.sql` | `1c32fd2368ae0ae78e2bf5dc8886b780cbed69eb` | `ee35bfe58e35fccdeee0e32d4ae077fac5136c15` |
| `467_autopilot_trigger_creator_from_autopilot.up.sql` | `40a3888825985738469996a1596110ae62038ac6` | `9d9719921186f406855115c4a5a7e73b9c377896` |

`467` continues to update `autopilot_trigger` column comments only (verified
live via `pg_description` on `created_by_type` / `created_by_id` across all
four databases) and never infers a trigger principal from the autopilot
creator. `9066_labrastro_retire_conversation_provenance` continues to restore
upstream `579_wakeup_skip_handed_to_agent`'s `capture_issue_wakeup` verbatim:
`go test -count=1 ./internal/migrations` (including all
`TestLabrastroWakeupCapture*` cases) passes in **0.92s**, and live
`pg_get_functiondef('capture_issue_wakeup'::regproc)` SHA-256 is identical
across all four databases
(`917ae5a18b0340ee588b5c38069920ad74f02f1503291fe6ef793d8555032f7f`).

Four-path validation ran against a newly initialized task-private native
**PostgreSQL 17.12 (Debian 17.12-1.pgdg12+1) / UTF8** cluster bound to
`127.0.0.1:15432` (stopped and deleted before handoff). Each baseline ran its
own archived `cmd/migrate` runner; the candidate `cmd/migrate` runner applied
increments and executed the `9079` + `755`→`697` rollback/reapply pass:

| Path | Ledger progression | Invalid indexes | Final normalized schema SHA-256 |
| --- | --- | --- | --- |
| 1. Fresh empty DB | `0 → 896` | 0 | `1320dff84a988762601b9e6f066074b8eca9d1c983eef6415142735b17220659` |
| 2. Released `v0.11.1-labrastro.2` (`055423a63c`) upgrade | `0 → 836 → 896` (`697`–`755` + `9079`) | 0 | `1320dff84a988762601b9e6f066074b8eca9d1c983eef6415142735b17220659` |
| 3. Fork `origin/main` (`d0fde9ffc3`) upgrade + `9079` data injection | `0 → 836 → 896` (`697`–`755` + `9079`) | 0 | `1320dff84a988762601b9e6f066074b8eca9d1c983eef6415142735b17220659` |
| 4. Clone Path 3 → rollback `9079` & `755`→`697` → reapply `697`→`755` + `9079` | `896 → 836 → 896` | 0 | `1320dff84a988762601b9e6f066074b8eca9d1c983eef6415142735b17220659` |

- **Final 896-entry normalized schema SHA-256** (`pg_dump --schema-only
  --no-owner --no-privileges`, stripping randomized `\restrict` / `\unrestrict`
  lines): **all four paths 100% equal** at
  `1320dff84a988762601b9e6f066074b8eca9d1c983eef6415142735b17220659`.
- **Pre-upgrade & rollback mid-state 836-entry SHA-256**: both pre-upgrade
  baselines (`v0.11.1-labrastro.2` and `origin/main`) match the previously
  recorded 836-entry schema
  (`926455a58b0261f3b94e0e931871dee354de8bec62d25a243129c22acf2a2bd3`). The Path
  4 mid-state after rolling back `9079` and `755`→`697` hashes to
  `6976bcd7e1a11781636dcdef8d58707e3632a51f22699b203baea7c2abd9f186` solely due
  to upstream's own down-migrations (`739.down.sql` restores 3 task-usage
  functions without inline `--` comments; `699.down.sql` and `750.down.sql`
  re-add `member_role_check`, `workspace_invitation_role_check` and
  `app_tool_call_outcome_check` with `NOT VALID` to avoid table-scan locks).
  Replaying `697`→`755` + `9079` converges identically back to
  `1320dff84a988762601b9e6f066074b8eca9d1c983eef6415142735b17220659`.
- **Path 3 & Path 4 live `9079` regression evidence**:
  - Eight historical rows were injected into `issue_dependency` on the 836-entry
    `origin/main` database before upgrading: (1) open `blocked_by` (member),
    (2) done historical `blocked_by` (member), (3) reverse `type = 'blocks'`
    pointing to an agent-created in-progress issue, (4) `type = 'related'`,
    (5) stage-order cycle dirty edge (`stage 1 blocked_by stage 2` under the
    same parent), (6) parent-child ancestor dirty edge (`child blocked_by
    parent`), (7) self-loop edge, and (8) cross-workspace edge.
  - After upgrading (`836 → 896`) and again after Path 4 rollback/replay
    (`896 → 836 → 896`):
    - All **8** historical `issue_dependency` rows remain untouched.
    - Exactly **3** valid edges landed in `issue_blocker`: open member edge
      `(member, 33333333-...)`, finished historical edge `(member, 33333333-...)`,
      and agent-created reverse `blocks` edge preserving `(agent, 44444444-...)`.
    - Exactly **2** `blockers_done` system wakeups were armed automatically for
      the two open dependent issues (`enabled=true, blockers=1`), and **0** for
      the finished historical issue and conflicting stage child.
    - `'related'`, self-loop and cross-workspace rows were ignored (`0` foreign
      rows); both conflicting edges were caught cleanly by `check_violation`
      with zero migration error, emitting PostgreSQL `RAISE NOTICE` entries:
      `Parent and child issues cannot block each other` and
      `Blockers cannot form a cycle (including stages)`.

`TestWorkspaceDeletionManifestCoversPublicSchema`, `./internal/migrations`,
`./cmd/migrate`, `./ee/...`, `./cmd/server/...` (both default and `-tags oss`),
`./internal/branding` and targeted `TestIssueGraph*` /
`TestNotificationPreferencesReportStatusChangesMutedByDefault` all pass against
the migrated PG17 database.

## Engineering insertion measurements and high-churn plugs

Measured with `git diff -U0 <base> HEAD -- <file>` matching
`engineering|baseline|wikilink` identifiers (excluding `tabStorage?.setBaseline`
and the unrelated YSK documentation reference in `events.ts`) against both
`e1fe10d6694848e35dd1aa00e08cd11d93e545ac` (`v0.11.1`) and
`35b54a3742bb51bdf5ffa688655367ec98044862` (`v0.13.0`). Both bases yield
identical counts: **22 files, 60/60 lines** (backend 7 files `17/17`, frontend
15 files `43/43`; down 1 from 61 after upstream `v0.13.0` removed per-route
`handle.title` from `apps/desktop/src/renderer/src/routes.tsx`):

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
| `apps/desktop/src/renderer/src/routes.tsx` | 3 / 3 (was 4 in v0.11.1) |
| `packages/core/paths/paths.ts` | 2 / 2 |
| `packages/views/projects/components/index.ts` | 1 / 1 |
| `packages/views/i18n/resources-types.ts` | 2 / 2 |
| `packages/core/diagnostics/diagnostic-context.ts` | 1 / 1 |
| `server/cmd/server/router.go` | 1 / 1 |
| `server/cmd/multica/main.go` | 1 / 1 |
| `server/cmd/multica/cmd_project.go` | 2 / 2 |
| `server/internal/handler/project_resource.go` | 1 / 1 |
| `server/internal/handler/project.go` | 4 / 4 |
| `server/internal/service/issue.go` | 3 / 3 |
| `server/internal/handler/workspace.go` | 5 / 5 |
| `packages/core/package.json` | 2 / 2 |

High-churn file anchors:

- **`server/cmd/multica/cmd_issue.go`**: all six historical `issue_dependency`
  plugs are cleared (`0` dependency plugs). After Stage 4 dead-guard slimming,
  the full diff against `v0.13.0` (`35b54a3742bb51bdf5ffa688655367ec98044862`)
  is strictly `+77 / -28` across the three documented non-dependency in-place
  differences (1 brand string in `runIssuePullRequestsLink`, local flag
  validation in `runIssueCommentList`, OL-458 `--scope`/`--offset`/
  `issueSearchMaxLimit`/`has_more` in `issueSearchCmd`/`runIssueSearch` +
  `boolVal`).
- **`server/internal/daemon/daemon.go`**: two `heartbeatExtrasFor` calls
  (~lines 4814, 4971), two `recordTaskPlanQuota` calls (~lines 9673, 9988), one
  `reportedTaskUsageEntries` call (~line 9996), three `planQuotaCache.Delete`
  evictions (~lines 1565, 1635, 1645), `dshMissingProfileReason` (~line 2585),
  and all fork struct fields (`planQuotaCache`, `jevClient`, `jevSamples`,
  `jevProbe`, `hostMetrics`, `stepEffort`, `nativeMedia*`).
  `server/internal/daemon/planquota_kimi.go` has **0-diff** vs fork `main`
  `d0fde9ffc3`.

## Go formatting scope

`scripts/gofmt-upstream-exceptions.txt` is reconciled against
`35b54a3742bb51bdf5ffa688655367ec98044862` (`v0.13.0`): 8 → **11** entries
(`-2` upstream-formatted Lark files `ws_chunk_assembler.go` and
`ws_chunk_assembler_test.go`, `+5` new unformatted upstream test files, `6`
unchanged). All 11 entries were verified in Stage 3: every recorded Git blob ID
matches both `git rev-parse 35b54a3742bb51bdf5ffa688655367ec98044862:<path>` and
`git hash-object --no-filters -- <path>`, and all 11 are genuinely flagged by
`gofmt -l`. Both `bash scripts/check-gofmt.test.sh` and
`bash scripts/check-gofmt.sh` pass cleanly:

| Blob ID (`v0.13.0`) | Path | Change vs `v0.11.1` |
| --- | --- | --- |
| `b1b8dd45e3f24caeb7df018969ce11be48bd6e0a` | `server/cmd/multica/cmd_quick_action_test.go` | added |
| `eda4419b3475e58bc2d86a9b39814da1e4d2c6ba` | `server/cmd/multica/cmd_squad_test.go` | added |
| `f90234704257dffc4ed7345d9f9f4273d5215fdb` | `server/internal/auth/cloud_pat_test.go` | unchanged |
| `ad7d259dec1d351b8482db2a81ef9e1a942c9fde` | `server/internal/auth/membership_cache_test.go` | unchanged |
| `2295b12ea2f93382201e1996a4854c259f5f7151` | `server/internal/handler/dashboard_squad_integration_test.go` | added |
| `766b722dbad2d88f0174291aed08d2821704e679` | `server/internal/handler/doc_comment_test.go` | added |
| `12153b91e33754a517f7b6e173de66185058d259` | `server/internal/handler/team_app_feature_test.go` | added |
| `fa16c63ab8b87beda8104898b29b06a96e7d340d` | `server/internal/integrations/lark/markdown_detect.go` | unchanged |
| `31e8b12d48ef29d696024552dede3a9c3931fd65` | `server/internal/integrations/lark/ws_frame_test.go` | unchanged |
| `f2574a29d596239b2131b16d0f9c61b4ca49a1bd` | `server/internal/middleware/daemon_auth_test.go` | unchanged |
| `620746cb12de71098d96282a23dc0c6331677b8f` | `server/pkg/featureflag/eval_context_test.go` | unchanged |

## Validation and isolated retained E2E gate

Stage 3 verification environment: Go 1.27.4, Node 24.21.0, pnpm 10.28.2,
GoReleaser v2.18.0, Playwright 1.58.2 (Chrome Headless Shell 145.0.7632.6 /
chromium v1208), native PostgreSQL 17.12. Initial PG17 four-path parity and
isolated retained E2E ran against `58e5b762c8ecc17d3cc37bb981e1ddbbf260eb14`
(zero migrations changed afterward), and the Stage 3 CI-admission rework below
was re-verified locally across all affected Go, frontend, docs, mobile, brand
and cache-input gates.

- **Static, brand, UI & script gates**: `pnpm install --frozen-lockfile`,
  `bash scripts/check-gofmt.test.sh`, `bash scripts/check-gofmt.sh`,
  `node scripts/brand/sync.mjs --check`, `pnpm test:brand` (13 node + 19
  Vitest), `go test -count=1 ./internal/branding`, `pnpm knip` (zero issues),
  `pnpm check:ui-exports` (76 files), `pnpm check:ui-radii` (3,183 files),
  `pnpm check:ui-outlines` (3,337 files), `pnpm check:deps-catalog` (15
  workspaces), `pnpm typecheck` (14/14 tasks), `bash scripts/test-retained-e2e.test.sh`,
  `node scripts/ci-scope.test.mjs` (109/109), `bash scripts/dev-env.test.sh`,
  `goreleaser check`, `actionlint .github/workflows/release.yml .github/workflows/ci.yml`
  and `git diff --check` all pass. (`scripts/selfhost-config.test.sh` requires
  local `docker` not present in this container; remote CI `script-checks` is
  authoritative.)
- **Bounded unit contract suite (`pnpm test`)**: **909 passed** (`ysk` 20,
  `core` 102, `desktop` 19, `brand` 13 node + 19 Vitest, `mobile` 442, `web`
  101, `views` 193) in **57.3 seconds** (< 1-minute budget).
- **Backend / PG17 tests**: `go build ./...`, `go build -tags oss ./cmd/...`,
  `go vet ./...`, `./internal/migrations` (0.92s), `./cmd/migrate` (60.19s,
  covering `9079` and all concurrent index cleanup hooks),
  `TestWorkspaceDeletionManifestCoversPublicSchema` (0.10s), `./ee/...`
  (0.10s), `./cmd/server/...` default (9.64s) and `-tags oss` (8.72s),
  `./internal/branding` (1.65s) and targeted `TestIssueGraph*` /
  `TestNotificationPreferencesReportStatusChangesMutedByDefault` (0.55s) all
  pass.
- **Isolated retained E2E gate (`bash scripts/test-retained-e2e.sh`)**:
  - Calibrated in Stage 2 (`scripts/test-retained-e2e.sh`,
    `scripts/test-retained-e2e.test.sh`, `playwright.retained.config.ts`,
    `docs/engineering/ci-gates.md`) to retire `e2e/issue-dependencies.spec.ts`
    and cover `e2e/onboarding-smoke.spec.ts`, `e2e/dag-task-lines.spec.ts`
    (wiring native `PUT /api/issues/:id { blocked_by }` + DAG canvas navigation
    and canonical identifier detail routes) and `e2e/comments.spec.ts`.
  - Executed unmodified against a fresh disposable `labrastro_e2e` PG17.12
    database on `127.0.0.1:15432` with Chromium v1208 in a task-local
    `PLAYWRIGHT_BROWSERS_PATH` and zero dotenv overrides:
  - **Result: 20/20 passed, 0 failed, 0 skipped, 0 retries**
    (`e2e/comments.spec.ts` 4/4, `e2e/dag-task-lines.spec.ts` 2/2,
    `e2e/onboarding-smoke.spec.ts` 14/14); Playwright browser phase **1.3m**,
    complete command **286.28 seconds** (< 5-minute budget).
  - The task-private PG17 cluster was stopped via `pg_ctl stop`, and all
    temporary directories, browsers, `test-results/` and built server binaries
    were removed before commit. The retained E2E HTML report and logs archive
    are attached to OL-1520 (not committed).

## Stage 3 admission CI rework (PR #340 runs `45770931139` & `45770932289`)

Initial remote CI on `e5b967ae89e35359fec50cce5c6f66e6792a61e4` passed
`retained-e2e-tests` (4m42s), `backend-format`, `frontend-test`, `sqlc-check`,
`backend-agent-tests`, `image-budget`, `installer`, `windows-execenv`,
`go-vulnerability-scan`, `candidate-checks`, `macos-processtree`,
`backend-darwin-vet` and `Migration numbers`, and surfaced six deterministic
failure groups fixed in the linear follow-up commit on
`sync/v0.13.0-ol-1517`:

1. **`CI/script-checks` (`docker-compose.selfhost.yml:287`,
   `scripts/selfhost-config.test.sh:118-132`)**: decoupled the optional
   `collab` service image tag from `MULTICA_IMAGE_TAG` (which holds local
   `dev-<sha>` or `v0.13.0-labrastro.N` application tags that do not exist on
   upstream GHCR) via `${MULTICA_COLLAB_IMAGE_TAG:-v0.13.0}`, and aligned the
   compose config assertion to `ghcr.io/multica-ai/multica-collab:v0.13.0`
   (149 production continues to keep `collab` disabled).
2. **`CI/docs-test` (`apps/docs/content/docs/tutorial.zh-Hant.mdx:202`)**: fixed
   broken internal heading anchor `/mentioning-agents#給正在運行的-ai-代理插話`
   → `/mentioning-agents#給正在執行的-ai-代理插話`.
3. **`Mobile Verify/mobile` (`apps/mobile/components/brand/multica-logo.tsx`,
   `scripts/brand/labrastro-assets.json`)**: added upstream-consistent
   `// eslint-disable-next-line no-restricted-syntax -- brand proper noun`
   directives for the two `Labrastro` brand literals and updated the tracked
   SHA-256 in `scripts/brand/labrastro-assets.json`.
4. **`CI/frontend-build` (`apps/desktop/turbo.json`, `packages/core/turbo.json`,
   `packages/views/turbo.json`, `.github/ci-paths.json`,
   `scripts/ci-scope.test.mjs`)**: declared the four cross-package test input
   files (`scripts/check-release.mjs`,
   `server/pkg/agent/testdata/adapt_thinking_candidates.json`,
   `server/internal/engineering/testdata/wikilinks.json`,
   `server/internal/engineering/testdata/anchors.json`) in Turbo `test` inputs
   and `.github/ci-paths.json` `"frontend"` scope, and aligned
   `scripts/ci-scope.test.mjs` (`candidate release preflight` now includes
   `frontend`).
5. **`CI/backend-tests` (`server/internal/notify/notify.go`,
   `server/internal/handler/attachment_dimensions_test.go`)**: registered
   upstream `doc_comment` and `doc_mentioned` in `notify.inboxTypes` so
   `TestInboxTypesMatchRegistry` matches the notification registry; guarded the
   `store.files` read in `TestUploadFileImageDimensions` with `store.mu.Lock()`
   to eliminate the `-race` data race with background thumbnail prewarming.
6. **`CI/frontend-views-test` (17 test files + dependent assertions)**:
   - Production fixes (3 files): removed the stray 3-way-merge
     `setLoadedSrc(src)` call from `onError` in
     `packages/views/editor/attachment.tsx`; synced `delimiter` attribute and
     `data-delimiter` HTML codec onto `InlineMathSchema` in
     `packages/views/editor/schema/math.ts` to match `InlineMathExtension`;
     restored `tCommon(($) => $.more_actions)` (`"More actions"`) on the issue
     detail actions trigger in `packages/views/issues/components/issue-detail.tsx`.
   - Locale copy hygiene (`packages/views/locales/copy-hygiene.test.ts`):
     normalized all 15 English Unicode ellipses (`…` → `...`) across
     `en/{chat,dag,engineering,fork-ui,lark}.json` and all 53 `zh-Hans`
     violations (ASCII `...`, straight `"..."`, lowercase `skill` / `Skills`)
     across `zh-Hans/{agents,dag,engineering,fork-ui,message-delivery,runtimes,skill-packages}.json`,
     updating corresponding test assertions (`code-tab.test.tsx`,
     `engineering-baseline.test.tsx`, `e2e/perf/dag-view.spec.ts`).
   - Test mock & v0.13.0 contract updates: `issue-detail.test.tsx` (use
     production `staleTime: Infinity` in the cold-detail sharing test),
     `update-section.test.tsx` (`version` manifest shape),
     `attachment-html-block.test.tsx` / `readonly-content.test.tsx` /
     `skill-picker-list.test.tsx` (ASCII `...`), `message-deliveries-section.test.tsx` /
     `route-deliveries-dialog.test.tsx` / `archive-section.test.tsx` (export
     `issueRouteRef` in `@multica/core/paths` mock),
     `side-chat-surfaces.test.tsx` (canonical `/acme/issues/OL-1`),
     `ysk-settings-toggles.test.tsx` (`QueryClientProvider` around
     `useSettingsSearchIndex`), `workspace-agent-working-chip.tip-anchor.test.tsx` /
     `sub-issues-agent-working-chip.tip-anchor.test.tsx` (`agentTaskSnapshotOptions`),
     `tip-anchor-headers.test.tsx` (`useIsGuest`), and
     `agents-page.folder-explorer.test.tsx` (`queryOptions` + `importOriginal`
     for `@multica/core/agents`).

Post-rework local verification: full `packages/views` suite (890/890 files
across both shards, with the 8 CPU-contended shard-1 files re-verified 8/8 /
242 tests green), all 6 other frontend workspace suites (`core`, `ui`, `web`,
`desktop`, `collab`, `ee`), `pnpm test`, `pnpm --filter @multica/mobile test` &
`lint`, `pnpm --filter @multica/docs test` (1,150/1,150), `pnpm test:brand`,
`node scripts/check-test-cache-inputs.mjs`, `node scripts/ci-scope.test.mjs`
(109/109), `pnpm check:ui-{exports,radii,outlines}`, `pnpm check:deps-catalog`,
`pnpm typecheck` (14/14), `pnpm knip` (0 issues), `bash scripts/check-gofmt.sh`,
and Go `-race` tests (`./internal/notify` + `TestUploadFileImageDimensions`
against a fresh migrated disposable PG17.12 database, torn down cleanly) all
pass.

## Stage 3 first-review fixes (R1–R4, PR #340 follow-up)

Following cross-family first review on `6ad12e1d52e36083d43a0b6f466d60cab89ca173`
(where remote `CI required` passed on run `45777113564`), four blocking items
were resolved in a single linear follow-up commit on `sync/v0.13.0-ol-1517`:

1. **R1 — DAG cancelled prerequisite = satisfied (`packages/core/issues/dag/state.ts`,
   `projection.ts`, `model-index.ts`, `packages/views/issues/dag/dag-toolbar.tsx`)**:
   unified `dagDependencyState` so both `done` and `closed` (`cancelled`)
   categories return `"satisfied"` matching native `issue_has_open_blockers`
   (`docs/issue-graph-api.md:84`), stopped promoting cancelled prerequisites into
   `cancelledBlockedIds` / `attention: "exception"`, removed the legacy
   `keptCancelled` pull-out walk in `dagCompletedVisibility` so finished
   (done/cancelled) lines and singles hide uniformly when `showCompleted` is
   off, removed the retired cancelled-blocking legend entry and aligned
   `legend_lit_flow` across all six `dag.json` locales (`en`, `fr`, `ja`, `ko`,
   `ru`, `zh-Hans`), and updated `models.test.ts` and views DAG tests
   accordingly.
2. **R2 — DAG non-inheritance of parent blockers (`packages/core/issues/dag/traversal.ts`,
   `redundancy.ts`, `detail.ts`, `model-index.ts`, `packages/views/issues/dag/dag-scene-inputs.ts`)**:
   removed parent/child blocker inheritance from `dagDependencyClosure`,
   `markDagRedundancy` and `dagDependencyState` (`dagIssueFinished(target)`
   instead of `subtreeFinished`), and restricted focus edges to real closure
   endpoints while keeping parent-child display frames intact
   (`docs/issue-graph-api.md:18`). Updated `redundancy.test.ts`,
   `models.test.ts`, `use-dag-data.test.tsx`, `dag-scene-inputs.test.ts` and
   `dag-scene-flow.test.ts`.
3. **R3 — `9079` reverse-edge (`blocks`) test kill power
   (`server/cmd/migrate/labrastro_issue_dependency_to_blocker_test.go`)**:
   moved dual-spelling deduplication onto `(dependent, blocker)` and made
   `reverse` (agent-created) carry only `(blocker, reverse, "blocks")`. Verified
   against PG17.12 using the same compiled test binary on an out-of-repo copy:
   unmutated `9079` passes, while disabling `WHERE d.type = 'blocks'` fails red
   on the missing agent-attributed reverse blocker row.
4. **R4 — Self-host optional `collab` image tag
   (`docker-compose.selfhost.yml:287`, `scripts/selfhost-config.test.sh`)**:
   switched `collab.image` tag to `${MULTICA_COLLAB_IMAGE_TAG:-v0.13.0}` so
   enabling `COMPOSE_PROFILES=collab` pulls the compatible published `v0.13.0`
   upstream image instead of nonexistent `dev-<sha>` / `v0.13.0-labrastro.1`,
   and updated `scripts/selfhost-config.test.sh:118-132` to assert
   `ghcr.io/multica-ai/multica-collab:v0.13.0`.

## Stage 4 whole-branch restraint & necessity audit (OL-1521)

Before release authorization, all **11,101** union paths across the three
immutable anchors (`B = v0.11.1`, `M = origin/main`, `U = v0.13.0`) and Stage 3
reviewed head (`H0 = f6c6d9b050`) were mechanically partitioned:

| Mechanical bucket at `H0` | Count | Stage 4 action |
| --- | ---: | --- |
| Trivial upstream (`h == u && m == b`) | 8,464 | Mechanically excluded (zero fork divergence) |
| Untouched fork-only (`h == m && u == b`) | 1,905 | Retained (21 dependent files slimmed/fixed, 2 dead files deleted, 1 restored to `v0.13.0` 0-diff in lockstep) |
| **Non-trivial audited 100% file-by-file** | **732** | **51 restored to `v0.13.0` 0-diff, 2 deleted, 118 slimmed/fixed, 561 verified keep** |

Key Stage 4 fixes and slimming outcomes (all applied as linear commits
on `sync/v0.13.0-ol-1517`, no rebase):

1. **52 files restored to exact `v0.13.0` 0-diff** (51 from the 732 non-trivial
   set + `packages/views/modals/run-confirm.test.tsx`), eliminating obsolete
   conflict carry-overs across CLI/backend (`cmd_user.go`, `daemon_test.go`,
   `reserved_slugs.json`, `issue_trigger.go`, `issue_workflow_test.go` with its
   sole fork test moved into `labrastro_default_workflow_test.go`),
   Core/Views (`reserved-slugs.ts`, `types/issue.ts`, `issue-actions-menu-items.tsx`,
   `comment-annotation-selection.ts`, `issue-environments-section.tsx`,
   `issue-load-failure.test.tsx`, `source-context-viewer{,.test}.tsx`,
   `status-picker{,.test}.tsx`, `batch-action-toolbar{,.confirm.test}.tsx`,
   `run-confirm{,.test}.tsx`, `content-editor-quick-actions.test.tsx`,
   `search/root-view.tsx`), locales (`settings.json` ×6, `layout.json` ×7,
   `ru/{common,onboarding,autopilots,projects}.json`), apps/docs/E2E
   (`updater.ts`, `auth/callback/page.tsx`, `github-integration.*.mdx` ×5,
   `squads.{mdx,zh.mdx}`, `landing/i18n/{en,ja,ko,zh}.ts`, `e2e/settings.spec.ts`).
2. **4 dead files deleted**: `packages/core/api/dispatch-schemas.ts`,
   `packages/views/issues/dag/use-prefers-reduced-motion.ts`,
   `scripts/stage5-shots/stage5-shots.spec.ts`,
   `scripts/stage5-shots/playwright.stage5-shots.config.ts`.
3. **Real defects fixed during line-by-line review**:
   - `server/internal/handler/issue_graph.go`: fixed MVCC snapshot leak
     (`h.loadIssueForUser` → `snapshot.loadIssueForUser`) and snapshot-init
     HTTP status (`409` → `500`); regenerated
     `packages/core/api/testdata/issue-graph.json` against live PG17 and
     updated `packages/core/api/issue-graph-schemas.test.ts` (8 edges,
     `visibleUnsatisfiedCount = 1`).
   - `packages/core/issues/testing/issue-graph-fixture.{ts,test.ts}` (plus
     `packages/views/issues/dag/dag-scene-layout.test.ts` dense-line selector):
     aligned shared synthetic DAG fixture (`ISSUE_GRAPH_FIXTURE_VERSION =
     2.3.0`) with native `effective_issue_blocker` (migration `746`) — merges
     explicit `manual:<target>:<source>` rows with all same-parent
     earlier-stage sibling pairs as `stage:<target>:<source>` (retaining
     `manual:` precedence on shared endpoints), treats both `done` and
     `cancelled` as satisfied, counts direct effective blockers only (no
     ancestor inheritance), achieves 0 edge/summary drift against migration
     `746`'s SQL view across all 6 datasets and the Go reference snapshot, and
     replaced legacy `cancelledStillBlocking` with `cancelledSatisfiedEdges`.
   - `server/internal/service/autopilot.go`: restored missing
     `errors.Is(err, errRunAlreadyTerminal)` early return; inlined unused
     `failAutopilotRunWithResult` in `autopilot_quota.go`; restored `NULL` in
     `CreateAutopilotTask` (`server/pkg/db/queries/autopilot.sql`) and
     regenerated `server/pkg/db/generated/autopilot.sql.go` via `make sqlc`.
   - `apps/desktop/src/renderer/src/platform/navigation.tsx`: added missing
     `clearCommentHighlightMemento(path)` in `routeIssueDeepLinkPath` with
     regression test in `navigation.test.tsx`.
   - `packages/views/settings/components/repositories-section.test.tsx`:
     restored upstream `MUL-9021` `repositorySelectionRef` +
     `preselects only explicitly selected authorizations` test dropped during
     merge resolution.
   - `packages/views/issues/surface/issue-surface.test.tsx`: fixed corrupted
     `issues` → `issues: rows` mock and removed duplicate `summaryScopeIssues`
     test + dead `issuesHeaderProps`.
   - `server/migrations/9079_labrastro_migrate_issue_dependency_to_blocker.up.sql`:
     fixed broken header comment sentence and prefixed `RAISE NOTICE` with
     `migration report: ` to align with `server/cmd/migrate/main.go:982`
     (zero DDL change; normalized 896-entry PG17 schema SHA-256 unchanged at
     `1320dff84a988762601b9e6f066074b8eca9d1c983eef6415142735b17220659`).
4. **Dead-code, over-defense & copy hygiene slimming**:
   - Removed the entire unreachable DAG `cancelled-blocking` / `keptCancelled` /
     `cancelledBlockedIds` / `subtreeFinished` / `dag-edge-breathe` /
     `legend_edge_cancelled` / `cancelled_blocking` chain across
     `packages/core/issues/dag/*`, `packages/views/issues/dag/*`,
     `packages/views/locales/*/dag.json` (×6), `dag/README.md` and
     `docs/issue-graph-api.md`; replaced `use-prefers-reduced-motion.ts` and
     `you-should-know/bubble/page-signals.ts`'s pass-through wrapper with
     direct `@multica/core/appearance` `useReducedMotion`.
   - Removed 8 resurrected dead `ApiClient` methods (`getRuntimeProfile`,
     `getActiveTasksForIssue`, `getWorkspace`, `listAgentSkills`,
     `deleteAttachment`, `dryRunIssueWorkflowUpdate`, `beginComposioConnect`,
     `getAppRules`), `DispatchOutcomeSchema`, `IssueBatchUpdateSchema`,
     obsolete `readIssueDetail` dedup map, 3 duplicate `graph` invalidations
     already run by `invalidateIssueDerivatives`, 9 dead OL-33 CORS headers in
     `router.go`, dead OL-42 `/api/issues*` client error cap, dead
     `deferEnqueueNotifications` in `task.go`, duplicate `uploadLimit` check in
     `file.go`, retired OL-77/OL-78 section in `autopilots.md`, dead
     `MULTICA_KEEP_ENV_AFTER_TASK` & stale OL-955 clause in
     `environment-variables.*.mdx` (plus `ja.mdx` table fix and `fr.mdx`
     `MULTICA_KIMI_QUOTA_POLL_INTERVAL` row), no-op keys in `locales/brand/*.json`,
     30 redundant RU brand strings, dead `omp.panel.create_section` (×6),
     redundant 2.7s-sleep upstream highlight block in `issue-detail.test.tsx`,
     3 duplicated upstream `describe` blocks in
     `use-realtime-sync-ws-instance.test.tsx`, and reset `cli.zh-Hant.mdx`,
     `tutorial.zh-Hant.mdx` and `contributing.zh-Hant.mdx` to `v0.13.0` with
     only the minimal fork hunks re-applied.
5. **Non-blocking observations deliberately deferred from Stage 4**:
   - `apps/desktop/src/renderer/src/components/desktop-layout.tsx`: retains
     pre-existing `title-bar-actions` + `globalActions={false}` (upstream
     `MUL-9348` moved actions to rail); left visually unchanged pending Master
     sign-off to avoid unrequested UI layout drift right before deployment.
   - Pre-existing helper extraction opportunities in
     `server/internal/handler/file.go` (`createBaselinePageAttachment`) and
     `server/internal/daemon/daemon.go` remain deferred to avoid unnecessary
     structural churn before Stage 5.

## Cross-family review and Stage 4/5 handoff

- **Author model families & reviewer exclusion**: commits on
  `sync/v0.13.0-ol-1517` were authored across **GLM** (Stage 1 / OL-1518),
  **Kimi** (Stage 2 / OL-1519) and **Gemini** (Stage 3 / OL-1520). Sequential
  high-risk dual review on the sole formal PR must therefore be performed by
  **Codex** (`审阅专家·Codex`) and **Claude** (`审阅专家·Claude`).
- **Keep formal PR OPEN after Stage 3 dual review**: once both reviewers
  approve and remote `CI required` turns green, **do NOT run `gh pr merge`**.
  Leave the PR **OPEN** and advance OL-1520 to `done_2` so Stage 4 (OL-1521)
  can complete the whole-branch file-by-file, line-by-line restraint and
  necessity audit on the same open PR branch and report to Master for explicit
  release authorization.
- **Stage 5 (OL-1522 — release & production deployment)**: unlocked only after
  Stage 4 completes, Master approves release on OL-1517 and the PR merges into
  `AstralSolipsism/multica:main` with green `CI required`. Tag and publish
  `v0.13.0-labrastro.1`, keep `FF_DOCS_V1=false` /
  `FF_ISSUE_DESCRIPTION_LIVE=false` with no `multica-collab` container, and
  provision/forward `MULTICA_APPS_SECRET_KEY` on 149 `multica-backend`.

No temporary screenshots, archives, raw logs or audit scripts belong in Git.
