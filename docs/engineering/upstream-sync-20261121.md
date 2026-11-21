# Upstream v0.11.1 sync — 2026-11-21 (OL-1472 / OL-1481)

Stages 1–4 share `sync/v0.11.1-ol-1472`, targeting
`AstralSolipsism/multica:main`. Stage 1 (OL-1479) owns the two-parent merge
base, six security/reliability backports, `server/ee` OSS stripping and
server/CLI/migration gates; Stage 2 (OL-1480) owns three-way frontend/Core/Web/
Desktop fusion, `packages/ee` OSS stripping and unified Runtime quota
convergence; Stage 3 (OL-1481) owns independent PG17 four-path migration
parity, isolated retained E2E, this sync record and opening the sole formal PR
(PR #332, kept **OPEN** pending Stage 4 after two-stage cross-family review and
green remote `CI required`); Stage 4 (OL-1483) owns the whole-branch
file-by-file, line-by-line restraint and necessity audit (plus any trimming on
the same branch before merge); Stage 5 (OL-1482) owns release and deployment of
`v0.11.1-labrastro.1` only after project-owner sign-off.

## Ancestry

| Boundary | Full SHA |
| --- | --- |
| Merge base / v0.10.0 | `2fcb424b72b024f65161809081009063846ea44d` |
| Fork main / M1 first parent | `3eaed6ed6518bece74626ba69b6c0d06fd99479f` |
| Upstream v0.11.1 / M1 second parent | `e1fe10d6694848e35dd1aa00e08cd11d93e545ac` |
| Two-parent merge M1 | `a4e718a8e3f536bd76353aa8feed8df8291c619b` |
| `#10977` wakeup stage handoff (`cherry-pick -x`) | `3f2b75692a6fe312a16df7397f399b77fdb0bf3e` |
| `#10984` task-token workspace list scope (`cherry-pick -x`) | `12821ec3778c1eb0d136e0ef832ae1c051a9f868` |
| `#10994` refuse machine-credential workspace delete (`cherry-pick -x`) | `548580f24923cbd6617b776b38ec51205035cc29` |
| `#10950` Antigravity subturn background waits (`cherry-pick -x`) | `b4663abbbd626aa4ffe3b59d05d1362842b153cc` |
| `#11000` insufficient balance quota classification (`cherry-pick -x`) | `9e672985f05898d025493efff8d0b16541ce182f` |
| `#10999` missed chat completion reply recovery (`cherry-pick -x`) | `677579813e111caea499b90473880c9aeb188976` |
| Stage 1 reviewed head (OL-1479) | `b7e599992bacbd5e43c95e95b634cd04bcbb3083` |
| Stage 2 reviewed head (OL-1480) | `1604840cd820504adec21976c6f1e0de12ca14cc` |

All six backports retain `cherry-pick -x` provenance from
`v0.11.1..upstream/main` (zero database migrations):

| Upstream PR | Upstream source SHA | Fork branch SHA | Summary |
| --- | --- | --- | --- |
| `#10977` | `ee5de54e00025ab05a8a8c632caef5b7c52f0b61` | `3f2b75692a6fe312a16df7397f399b77fdb0bf3e` | Prevent duplicate stage handoffs (MUL-9643) |
| `#10984` | `474cf3568ce8e11a547dc89f5f22213bc6d73271` | `12821ec3778c1eb0d136e0ef832ae1c051a9f868` | List only the bound workspace for a task token |
| `#10994` | `d0d0b1f49eb06842fd5c0343fec30083d22e165b` | `548580f24923cbd6617b776b38ec51205035cc29` | Refuse workspace deletion from machine credentials |
| `#10950` | `3724ccd8ce3ae184978389866ddf444e2a02488d` | `b4663abbbd626aa4ffe3b59d05d1362842b153cc` | Allow Antigravity subturn waits for managed background tasks |
| `#11000` | `72286e56ed025bb01faac611fbc37d4ca78fbdbd` | `9e672985f05898d025493efff8d0b16541ce182f` | Classify explicit insufficient balance as quota failure |
| `#10999` | `967fc4e17d5babf2671de4a6389318a46ac35cb7` | `677579813e111caea499b90473880c9aeb188976` | Recover a saved chat reply after missed completion event |

History is strictly append-only (no rebase). Unreleased upstream guest
migrations (`697`–`702`) are not merged. `origin/main` remains at
`3eaed6ed6518bece74626ba69b6c0d06fd99479f` (zero drift) and
`git merge-tree --write-tree origin/main HEAD` confirms a clean merge.
External upstream-PR branches in the fork were untouched.

## Pure open-source boundary (`server/ee` and `packages/ee` stripping)

Upstream v0.11.1 added proprietary all-rights-reserved code under `server/ee/`
and `packages/ee/` (project folders). Per Decision 2A, all 32 commercial files
introduced by `v0.11.1` are stripped cleanly:

- **Backend (10 files removed in Stage 1)**: `server/ee/` (9 files: `LICENSE`,
  `README.md`, `ee.go`, `projectfolder/handler.go`, `handler_test.go`,
  `queries.sql`, `folderdb/{db,models,queries.sql}.go`) and
  `server/cmd/server/ee.go`. Also removed `ee/projectfolder` from
  `server/sqlc.yaml`, the commercial exception paragraph from root `LICENSE`,
  and residual `server/ee` path filters from `.github/ci-paths.json` and
  `.github/workflows/ci.yml`. Both `go build ./...` and
  `go build -tags oss ./cmd/...` compile on the pure open-source path;
  `go test ./internal/extension` verifies the OSS boundary.
- **Frontend (22 files removed in Stage 2)**: entire `packages/ee/` workspace
  removed (`LICENSE`, `README.md`, `package.json`, `index.ts`,
  `project-folders/*`, locales and tests). Removed all `@multica/ee`
  dependencies and `registerEE()` wiring from root `package.json`,
  `pnpm-lock.yaml`, `apps/web`, `apps/desktop`, `apps/web/next.config.ts`,
  `Dockerfile.web`, both Web/Desktop `globals.css` `@source` directives and
  `knip.jsonc`. `ProjectFoldersExtension` keeps its open-source no-op fallback.
  `git grep` confirms zero non-comment/non-archive references to `@multica/ee`,
  `registerEE`, or commercial imports; `pnpm knip` reports zero issues.
- **Migration ledger preserved**: `server/migrations/681_project_folder.{up,down}.sql`
  and `682_project_folder_name_idx.{up,down}.sql` remain byte-identical to
  `v0.11.1` so the `661`–`696` migration sequence stays 100% continuous.

## Fork candidate release chain retained (`ours` in M1)

Three release-orchestration files changed between upstream v0.10.0 and v0.11.1
and intentionally took `ours` in `M1` (byte-identical to fork `M1^1`
`3eaed6ed6518bece74626ba69b6c0d06fd99479f`) to preserve Labrastro's offline
single-tag `candidate` release contract (recorded per OL-1479 second-review
note):

| File | M1 resolution | Rationale |
| --- | --- | --- |
| `.github/workflows/release.yml` | fork `ours` (0 diff vs `3eaed6ed65`) | Preserves Labrastro's ten-job `candidate` assembly, checksum/feed verification and draft-only release gate |
| `.goreleaser.yml` | fork `ours` (0 diff vs `3eaed6ed65`) | Preserves offline single-tag CLI packaging, `release.disable: true` and dual CLI archive names without GitHub changelog calls |
| `.github/RELEASING.md` | fork `ours` (0 diff vs `3eaed6ed65`) | Documents `scripts/candidate.py` as the draft-note writer and Labrastro's Go security floor (`setup-candidate` `~1.27.4`) |

Stage 3 verified this release contract live (Go 1.27.4, GoReleaser v2.18.0,
Python 3.12.14, Node 24.21.0, task-local QEMU 7.2.22, with GitHub/GitLab/Gitea
token env vars unset):

- `goreleaser check`: 1 configuration file validated.
- `actionlint .github/workflows/release.yml .github/workflows/ci.yml`: clean.
- `python3 scripts/candidate.test.py`: **PASS in 50.62 seconds** (all 12 CLI
  archives built, linux/amd64 + linux/arm64 backend verification, complete
  offline contract assembly, 32 job-failure gates, receipt/archive/feed/API/
  traversal tamper checks). Synthetic fixtures only; no Release published.

## Migration identities and PostgreSQL 17 evidence

The ledger contains **836 full migration identities**: **762** in `001`–`696`
(including retained historical fork stems) and **74** in `9001`–`9078`
(`9055`–`9058` remain absent after historical renumbering `e4f4f9664`;
`9077`–`9078` landed in fork `main` via PR #316 before `M1`). Zero migrations
are added or renumbered by this sync, and no unreleased `697`–`702` migrations
exist.

All **36 incoming stems (`661`–`696`, 72 up/down SQL files)** are 100%
byte-identical to upstream `v0.11.1` (`e1fe10d6694848e35dd1aa00e08cd11d93e545ac`),
verified by comparing `git rev-parse <upstream>:server/migrations/<file>` with
`git hash-object --no-filters <file>`:

| Range | Incoming stems (36 stems / 72 SQL files) | Up/down identity |
| --- | --- | --- |
| `661`–`664` | `661_chat_task_supplement`, `662_chat_task_supplement_message`*, `663_chat_task_supplement_task`*, `664_chat_task_supplement_workspace`* | byte-identical |
| `665`–`672` | `665_weixin_state`, `666_weixin_login_expiry_idx`*, `667_issue_origin_weixin_chat`, `668_issue_origin_weixin_chat_validate`, `669_weixin_login_session_unique_index`*, `670_weixin_login_session_primary_key`, `671_weixin_account_state_unique_index`*, `672_weixin_account_state_primary_key` | byte-identical |
| `673`–`674` | `673_runtime_rate_limit`, `674_runtime_profile_daemon` | byte-identical |
| `675`–`678` | `675_chat_wakeup`, `676_chat_wakeup_due_idx`*, `677_chat_wakeup_session_idx`*, `678_chat_wakeup_requester_idx`* | byte-identical |
| `679`–`684` | `679_entitlement_limit_overage`, `680_entitlement_limit_overage_scope_idx`*, `681_project_folder`, `682_project_folder_name_idx`*, `683_entitlement_feature_attempt`, `684_entitlement_feature_attempt_scope_idx`* | byte-identical |
| `685`–`694` | `685_docs`, `686_doc_folder_pkey_index`*, `687_doc_folder_pkey`, `688_doc_pkey_index`*, `689_doc_pkey`, `690_doc_version_pkey_index`*, `691_doc_version_pkey`, `692_doc_folder_workspace_idx`*, `693_doc_workspace_idx`*, `694_doc_version_workspace_idx`* | byte-identical |
| `695`–`696` | `695_inbox_item_returned_at`, `696_inbox_item_active_shown_idx`* | byte-identical |

`*` denotes all 19 incoming `CREATE INDEX CONCURRENTLY` migrations registered in
`concurrentIndexCleanups` (`server/cmd/migrate/main.go`); `go test ./cmd/migrate`
(including `TestEveryConcurrentUpBuildHasCleanup`) passes in 44.98s.

All existing migrations from `v0.10.0-labrastro.2` (`9183a35d06`, 798 stems) and
fork `origin/main` (`3eaed6ed65`, 800 stems) retain identical bytes. Across the
entire upstream migration inventory (`001`–`696`), only the historical `467`
override differs:

| Filename | v0.11.1 blob | Fork blob |
| --- | --- | --- |
| `467_autopilot_trigger_creator_from_autopilot.down.sql` | `1c32fd2368ae0ae78e2bf5dc8886b780cbed69eb` | `ee35bfe58e35fccdeee0e32d4ae077fac5136c15` |
| `467_autopilot_trigger_creator_from_autopilot.up.sql` | `40a3888825985738469996a1596110ae62038ac6` | `9d9719921186f406855115c4a5a7e73b9c377896` |

`467` updates `autopilot_trigger` column comments only (verified live in
`pg_description`) and never backfills or infers a trigger principal from the
autopilot creator; unresolved triggers continue to fail closed.
`9066_labrastro_retire_conversation_provenance` continues to restore upstream
`579_wakeup_skip_handed_to_agent`'s `capture_issue_wakeup` verbatim after
`9009`/`9028`: `TestLabrastroWakeupCapture*` (`Inventory`, `MatchesUpstream`,
`MigrationOrders/fresh`, `MigrationOrders/upgrade`) all pass, and live
`pg_get_functiondef` SHA-256 is identical across all four migrated databases
(`917ae5a18b0340ee588b5c38069920ad74f02f1503291fe6ef793d8555032f7f`).

Four-path validation ran against a newly initialized native **PostgreSQL 17.12
(Debian 17.12-1.pgdg12+1) / UTF8** cluster bound to `127.0.0.1:15432`, with
task-owned data and no production credentials (`postgresql-17-pgvector` is not
installed on this container; application migrations do not create or use
`pgvector`, and remote CI runs against `pgvector/pgvector:pg17`). Each baseline
ran its own archived `cmd/migrate` runner; the candidate `cmd/migrate` runner
applied increments and executed the `696`→`661` rollback/reapply pass.

| Path | Ledger progression | Invalid indexes |
| --- | --- | --- |
| Fresh install | 0 → 836 | 0 |
| Released `v0.10.0-labrastro.2` (`9183a35d06`) upgrade | 0 → 798 → 836 (`661`–`696` + `9077`–`9078`) | 0 |
| Fork `origin/main` (`3eaed6ed65`) upgrade | 0 → 800 → 836 (`661`–`696`) | 0 |
| Clone upgraded DB, rollback `696`→`661`, reapply `661`→`696` | 836 → 800 → 836 | 0 |

All four final normalized `pg_dump --schema-only --no-owner --no-privileges`
SHA-256 values (stripping only randomized `\restrict` / `\unrestrict` lines)
are identical:

- Final 836-entry schema SHA-256 (all 4 paths):
  `926455a58b0261f3b94e0e931871dee354de8bec62d25a243129c22acf2a2bd3`
- Pre-upgrade `origin/main` 800-entry schema & rollback mid-state 800-entry
  schema SHA-256 (exact match):
  `9367f892dda995f7228526f9738dfbcad4fff0b2e83bb5125cb745e5ae034a53`

`TestWorkspaceDeletionManifestCoversPublicSchema`, full `./internal/migrations`
and `./cmd/migrate` all pass against the migrated PG17 database.

## Engineering insertion measurements

Measured with `git diff -U0 <base> HEAD -- <file>` using the checklist's
identifier-line metric against both `2fcb424b72b024f65161809081009063846ea44d`
(v0.10.0) and `e1fe10d6694848e35dd1aa00e08cd11d93e545ac` (v0.11.1), excluding
only the unrelated YSK documentation reference in `events.ts` and
`tabStorage?.setBaseline`. Both bases yield the exact same counts:
**22 files, 61/61 lines** (backend 7 files `17/17`, frontend 15 files `44/44`),
zero budget widening introduced by this sync (the 54→61 delta landed on
`origin/main` prior to `3eaed6ed65` and was re-calibrated in `85835dffb`).

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
| `server/internal/handler/project.go` | 4 / 4 |
| `server/internal/service/issue.go` | 3 / 3 |
| `server/internal/handler/workspace.go` | 5 / 5 |
| `packages/core/package.json` | 2 / 2 |

High-churn anchors survive with unchanged counts:

- `server/internal/daemon/daemon.go`: two `heartbeatExtrasFor` calls (~lines
  4777, 4934), two `recordTaskPlanQuota` calls (~lines 9500, 9832), one
  `reportedTaskUsageEntries` call (~line 9840), three `planQuotaCache.Delete`
  evictions (~lines 1539, 1609, 1619), `dshMissingProfileReason` (~line 2557),
  and all fork struct fields (`planQuotaCache`, `jevClient`, `jevSamples`,
  `jevProbe`, `hostMetrics`, `stepEffort`, `nativeMedia*`).
  `server/internal/daemon/planquota_kimi.go` has zero diff vs `3eaed6ed65`,
  keeping its loopback same-UID peer-proof boundary (`/proc/net/tcp` + `lsof`)
  untouched.
- `server/cmd/multica/cmd_issue.go`: one `newIssueDependencyCmd` registration
  (line 654), two `registerIssueDependencyFlags` calls (lines 723, 746), one
  `issueDependencyFlagValues` validation (line 1733), two
  `prepareIssueDependencyWrite` calls (lines 1884, 2121), two
  `printIssueMutation` calls (lines 1937, 2206), and three upstream
  `applyAttachmentLinks` calls (lines 1912, 2161, 2927).

## Four approved decisions

1. **1A — Release anchor and 6 backports**: merge official tag `v0.11.1`
   (`e1fe10d6694848e35dd1aa00e08cd11d93e545ac`) via two-parent `--no-ff` merge
   `M1` and `cherry-pick -x` only `#10977`, `#10984`, `#10994`, `#10950`,
   `#11000` and `#10999` (zero DB migrations); exclude unreleased `697`–`702`
   guest migrations. After Stage 4 (OL-1483) completes the whole-branch
   restraint audit and project-owner sign-off, Stage 5 (OL-1482) releases and
   deploys `v0.11.1-labrastro.1`.
2. **2A — Pure open-source boundary**: completely strip commercial `server/ee/`,
   `server/cmd/server/ee.go`, `packages/ee/`, `@multica/ee`, `registerEE()` and
   root `LICENSE` commercial clauses, while retaining `681`–`682` SQL migrations
   byte-identically. Self-hosted private projects remain unrestricted when
   `h.Features == nil` (`requireFeatureAddition` bypass verified).
3. **3A — Unified 8-provider Runtime quota UI**: keep `673_runtime_rate_limit`
   and `@multica/core` protocol compatibility, while Web/Desktop Runtime list
   and detail views continue rendering Labrastro's 8-provider unified
   `RuntimeQuotaCell` / `RuntimeQuotaCard` without mounting upstream's duplicate
   Claude/Codex-only `RateLimitCell` or `RateLimitSection`.
4. **4 — Product defaults and environment toggles**:
   - `FF_DOCS_V1` stays default `false` (commented out in `.env.example`, API
     gated behind `RequireDocsV1` 403, hidden in UI and agent prompts) to avoid
     colliding with Labrastro's engineering baseline Wiki (`9067`–`9078`).
   - Notification defaults adopt upstream `status_changes = "muted"` (`#10778`)
     while keeping Labrastro's independent `you_should_know = "all"` default
     (`TestNotificationPreferencesReportStatusChangesMutedByDefault` passes).
   - `MULTICA_WEIXIN_SECRET_KEY=` remains blank/optional in `.env.example`;
     startup logs `weixin integration disabled` when unset.
   - Explicit slash skills align with upstream `#10772`/`#10774`; `WhatsNewDeck`
     stays mounted while `StarPrompt` remains unmounted and
     `SHOW_SOURCE_BACKFILL` remains `false`.

## Go formatting scope

`scripts/gofmt-upstream-exceptions.txt` was reconciled against
`e1fe10d6694848e35dd1aa00e08cd11d93e545ac` (`v0.11.1`, updated in `85835dffb`).
All eight listed files were re-verified in Stage 3: every recorded Git blob ID
matches both `git rev-parse e1fe10d6694848e35dd1aa00e08cd11d93e545ac:<path>` and
`git hash-object --no-filters -- <path>`, and all eight remain genuinely
flagged by `gofmt -l`. Both `bash scripts/check-gofmt.test.sh` and
`bash scripts/check-gofmt.sh` pass cleanly.

## Validation and review handoff

Stage 3 verification environment: Go 1.27.4, Node 24.21.0, pnpm 10.28.2,
Python 3.12.14, GoReleaser v2.18.0, Playwright 1.58.2 (Chrome Headless Shell
145.0.7632.6 / chromium v1208), native PostgreSQL 17.12, Linux 5.15.0-157.

- **Static & brand gates**: `bash scripts/check-gofmt.test.sh`,
  `bash scripts/check-gofmt.sh`, `node scripts/brand/sync.mjs --check`,
  `pnpm test:brand` (13 node + 19 Vitest), `go test ./internal/branding`,
  `pnpm knip` (zero issues), `pnpm check:ui-exports` (74 files),
  `pnpm check:ui-radii` (2,990 files), `pnpm check:deps-catalog` (13 workspaces)
  and `git diff --check` all pass.
- **Unit & script suites**:
  - `pnpm test` (bounded local unit contract suite): **859 passed** (846 Vitest
    across `ysk`, `core`, `brand`, `desktop`, `mobile`, `web`, `views` + 13
    brand node tests) in **51.4 seconds** (< 1-minute budget).
  - `pnpm test:scripts`: **188/189 passed** in 15.11 seconds; the sole failure
    is `Compose builds share version/SHA/date` in `scripts/local-images.test.mjs`
    due to missing local `docker` executable in this container (authoritative on
    remote CI).
- **Backend / PG17 tests (zero `server/` diff since Stage 1 `b7e599992`)**:
  `go build ./...`, `go build -tags oss ./cmd/...`, `./internal/migrations`
  (including `TestLabrastroWakeupCapture*`), `./cmd/migrate`,
  `./internal/extension`, `./internal/branding`, `./cmd/server` (private-project
  route probe), `./internal/inbox`, `./pkg/taskfailure`, `./internal/handler`
  (`TestWorkspaceDeletionManifestCoversPublicSchema`, `#10977`, `#10984`,
  `#10994`, notification defaults, attachment isolation, docs),
  `./internal/service` (autopilot/trigger/wakeup), `./internal/daemon`
  (planquota/kimi/chatskill/dsh), `./pkg/agent` (explicit skills/antigravity),
  and `./cmd/multica` all pass. Per OL-1479 second-review handoff, container
  environment boundaries (`./internal/daemon/execenv` 7 `TestPrepareLocalWorktree*`
  requiring git >= 2.40, `repocache` hardlink check, and Linux 5.15 pidfd
  limitations) are deferred to remote CI `CI required` as authoritative.
- **Isolated retained E2E gate (`bash scripts/test-retained-e2e.sh`)**:
  - Tested exact application HEAD: `1604840cd820504adec21976c6f1e0de12ca14cc`
    (subsequent Stage 3 commit touches sync documentation only; application
    code is unchanged).
  - An initial invocation failed before browser launch because this container's
    pre-cached Playwright browsers only had chromium v1243/v1248 while
    `@playwright/test 1.58.2` requires v1208. After installing chromium v1208
    into a task-local `PLAYWRIGHT_BROWSERS_PATH` and recreating an empty
    `labrastro_e2e` PG17 database (without root/Web dotenv overrides), the
    unmodified `bash scripts/test-retained-e2e.sh` passed completely:
  - **Result: 24/24 passed, 0 failed, 0 skipped, 0 retries** (`e2e/comments.spec.ts`
    4/4, `e2e/dag-task-lines.spec.ts` 2/2, `e2e/issue-dependencies.spec.ts` 5/5,
    `e2e/onboarding-smoke.spec.ts` 13/13); Playwright browser phase **1.9m**,
    complete command **157.26 seconds** (< 5-minute budget).
  - The task-local PG17 cluster was stopped via `pg_ctl stop`, and all temporary
    directories, browsers, test outputs and binaries were cleaned up before
    handoff. Real-browser screenshots for key interactive views (Runtimes quota,
    long issue timeline virtualization, HTML attachment inline rendering, slash
    skill menu, engineering baseline Wiki) were delivered in Stage 2 (OL-1480);
    the retained E2E HTML report is attached to OL-1481 rather than committed.

- **Stage 3 first-review rework (`Makefile:107` & stage handoff alignment)**:
  - Remote CI run `44909678077` on `0098ed19045a45343b65930ddaf2ad2f7a1fa3ae`
    passed 23/24 independent checks (including `retained-e2e-tests`,
    `backend-tests`, `backend-agent-tests`, `frontend`, `candidate-checks`,
    `sqlc-check`, `backend-format`, `go-vulnerability-scan` and all installer
    jobs) and failed solely in `script-checks` (`scripts/selfhost-config.test.sh`:
    first-run `make selfhost` / `make selfhost-build` with `.env.worktree`
    present). Root cause: `Makefile:5` selected `.env.worktree` and
    `Makefile:29` exported `ENV_FILE=.env.worktree`, so the recursive
    `$(MAKE) --no-print-directory selfhost` at `Makefile:107` kept reading
    `.env.worktree` instead of the newly generated `.env`.
  - Fixed by pinning `ENV_FILE=.env` on `Makefile:107` (`@$(MAKE)
    --no-print-directory selfhost ENV_FILE=.env`), matching upstream `#10523`
    while preserving Labrastro's local development build flow and candidate-tag
    guards. Verified with an isolated real-`make` Compose-env capture harness
    across all four combinations (`selfhost` / `selfhost-build` × empty /
    `.env.worktree`-only), plus full `init-worktree-env.sh` worktree layout and
    candidate-tag rejection (`MULTICA_IMAGE_TAG=v1.2.3-labrastro.1`,
    `VERSION=1.2.3`, `LABRASTRO_RELEASE_TAG=...`). Application Go/TS code
    remains unchanged from `1604840cd820504adec21976c6f1e0de12ca14cc`.

## Deployment and cross-family review handoff

- **Author model families & Stage 3 review handoff (keep PR #332 OPEN)**:
  commits on `sync/v0.11.1-ol-1472` were authored jointly by the **DeepSeek**
  family (`全栈补位专员`, Stage 1 + initial Stage 2) and the **Gemini** family
  (`排障师`, Stage 2 convergence + Stage 3). Two sequential high-risk reviews
  must be completed by experts from two different model families outside
  DeepSeek and Gemini (First review: **Codex**; Second review: e.g., **Claude**).
  Per OL-1481 handoff directive `01a1fe45-3c93-7a54-8f37-0a668cd0d4fe`, **do
  NOT run `gh pr merge` in Stage 3**: after the second reviewer approves and
  remote `CI required` passes on the final PR head, keep PR #332 **OPEN** and
  advance OL-1481 to `done_2` (总结中); the author never merges or polls remote
  CI.
- **Stage 4 (OL-1483 — whole-branch restraint & necessity audit)**: perform a
  file-by-file, line-by-line restraint and necessity audit on
  `sync/v0.11.1-ol-1472` (applying any trimming directly on the open PR branch
  and re-running gates). Merge PR #332 into `AstralSolipsism/multica:main` only
  after Stage 4 concludes and the project owner explicitly approves release.
- **Stage 5 (OL-1482 — release & production deployment)**: unlocked only after
  Stage 4 sign-off and PR #332 merges into `AstralSolipsism/multica:main` with
  green `CI required`. Tag and publish `v0.11.1-labrastro.1` from the merged
  `main` SHA. Keep `FF_DOCS_V1` unset/`false` and `MULTICA_WEIXIN_SECRET_KEY`
  unset in production; note upstream `#10778` changes default `status_changes`
  notifications to `"muted"` for members without an explicit preference
  (`you_should_know` stays `"all"`). Preserve existing Feishu and
  environment-proxy settings.

No temporary screenshots, archives, raw logs or audit scripts belong in Git.
