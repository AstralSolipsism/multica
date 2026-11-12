# Upstream sync checklist

Complete this checklist in the sync PR against explicit fork-base, upstream
and resulting head SHAs. The [retained product decisions](upstream-sync-20260926.md)
remain acceptance criteria. A clean merge is insufficient. The external
conversation boundary of [upstream-sync-20261002.md](upstream-sync-20261002.md)
was retired by OL-1274; Feishu ingress, task tokens and wakeups follow upstream.

## Migration identity and execution order

- [ ] Compare **all** incoming migration files with their upstream originals and
  the fork ledger. Record every upstream migration previously rewritten by the
  fork, including unchanged exceptions carried forward. Record filename/full
  identity, upstream SHA, fork SHA, before/after behavior, rationale, affected
  existing installations and new-install/upgrade evidence in the sync record.
- [ ] Carry forward at least the known override
  `467_autopilot_trigger_creator_from_autopilot.up.sql`: the fork does not infer
  a legacy trigger's principal from its autopilot creator. Its no-backfill
  behavior and unresolved-trigger denial must survive. Reconcile the historical
  record with OL-110 T14; do not silently restore upstream DML or rewrite a
  migration already recorded on an installed database.
- [ ] Inventory upstream functions redefined by fork migrations, including
  `capture_issue_wakeup` (fork 9009/9028, restored to upstream 579 by 9066).
  Run from `server/`:
  `go test ./internal/migrations -run '^TestLabrastroWakeupCapture' -count=1`.
- [ ] If that inventory fails after an upstream replacement, add a **new fork
  migration** after every existing 9xxx one that re-applies the newest
  upstream definition verbatim; a fresh install runs 9009/9028/9066 after any
  upstream migration and would otherwise end on the older body. Do not merely
  update the expected filenames. Point `TestLabrastroWakeupCaptureMatchesUpstream`
  at the new pair and verify both fresh-install and upgrade order.

## Go formatting scope

- [ ] Reconcile `scripts/gofmt-upstream-exceptions.txt` against the explicit
  upstream commit being merged. List only unformatted upstream originals whose
  resulting fork files are byte-identical. Record that full source commit and
  obtain each blob ID with `git rev-parse "<upstream-sha>:<path>"`; compare it
  with `git hash-object --no-filters -- "<path>"` before adding an exception.
  Do not generate exemptions from the fork's current files or exempt an entire
  directory. CI needs neither the upstream ref nor its history.
- [ ] Remove exceptions for deleted files, upstream files that are now
  formatted, or files the fork modifies. If upstream supplies new unformatted
  originals, update the list using their upstream bytes and IDs instead of
  reformatting them. A changed or renamed path is checked automatically until
  its new upstream identity is reviewed; fork edits must always pass gofmt.
- [ ] Run `bash scripts/check-gofmt.test.sh` and
  `bash scripts/check-gofmt.sh`. Confirm the listed originals remain identical
  to upstream after the check. Record list changes and the upstream commit in
  the sync PR; manifest-only changes must still run `backend-format`.

## Product and delivery gates

- [ ] Before the merge, run `git config merge.labrastro-brand.driver true` so
  the reviewed brand assets keep the fork copy instead of conflicting. After
  it, `node scripts/brand/sync.mjs --check` must pass; restore any reported
  asset from the fork parent (see [scripts/brand/README.md](../../scripts/brand/README.md)).
- [ ] Preserve the [branding overlay and guard contract](branding.md). Do not
  relax source/resource guards or expand exceptions to accept restored upstream
  product branding. Run `pnpm test:brand` and, from `server/`,
  `go test ./internal/branding` alongside the affected platform checks.
- [ ] Keep absence assertions for marketing/onboarding surfaces. Keep DAG
  stage order, real edges, independent expansion and detail-return viewport
  restoration. Shared Web/Desktop wiring still needs review; Chromium Web
  evidence alone does not establish Desktop packaging or installation behavior.
- [ ] Run `bash scripts/check-gofmt.sh` and the
  [isolated retained E2E gate](ci-gates.md), including
  `e2e/onboarding-smoke.spec.ts`, `e2e/dag-task-lines.spec.ts` and
  `e2e/issue-dependencies.spec.ts`. Record the exact
  head SHA, run URL, test outcomes and report artifact. A skipped, failed or
  missing selected job is not a pass; never substitute a production smoke run.
- [ ] Require `CI required` (both validated aggregates) on the final PR head, with the branch
  protection settings in [CI gates](ci-gates.md#main-branch-protection).
  Follow the workspace review rule, including two sequential expert approvals
  for CI/release changes. Leave merge to the reviewer; migration/deployment,
  release publication and live feed activation remain separately authorized.

## Engineering module upstream insertion ledger

The engineering module (project engineering overview / baseline wiki,
[labrastro-engineering-api.md](labrastro-engineering-api.md))
lives in fork-owned files. Upstream files may only carry thin registration or
call plugs. Before and after every upstream sync, walk this table and confirm
each plug survived the merge: the import/registration line exists, the called
fork symbol exists, and the residual footprint is within the expected range.

New engineering features default to fork-owned files only. Adding or widening
an upstream insertion requires updating this ledger in the same PR.

| Upstream file | Purpose | Fork symbols used | Expected lines |
| --- | --- | --- | --- |
| `packages/views/projects/components/project-detail.tsx` | header entry links | `ProjectEngineeringHeaderActions` (`project-engineering-entry.tsx`) | 2 |
| `packages/views/layout/panels/work-tree.tsx` | sidebar row menu entry | `ProjectEngineeringMenuItems` (`project-engineering-menu-item.tsx`) | 2 |
| `packages/core/realtime/use-realtime-sync.ts` | WS subscriptions + workspace-wide invalidation | `subscribeLabrastroEngineeringEvents` (`labrastro-engineering-realtime.ts`), `projectKeys.engineeringRoot` | 4 |
| `packages/core/types/events.ts` | event names + payload-map entries | `Eng.*` from `labrastro-engineering-events.ts` (re-exported) | 8 |
| `packages/core/projects/queries.ts` | engineering keys merged into `projectKeys` + option re-exports | `engineeringProjectKeys` (`engineering-queries.ts`) | 4 |
| `packages/core/projects/mutations.ts` | delete-project cleanup + hook re-exports | `engineeringProjectKeys`, `export * from "./engineering-mutations"` | 2 |
| `packages/core/api/index.ts` | schema/type re-exports | `export * from "./labrastro-engineering-exports"` | 1 |
| `apps/desktop/src/renderer/src/App.tsx` | re-auth destination restore, logout clear, expiry preserve | `engineeringReauthDestination` etc. (`platform/engineering-deep-links.ts`) | 5 |
| `apps/desktop/src/renderer/src/stores/tab-store.ts` | `?page=&section=&thread=` landing on a matched tab | `applyEngineeringWikiLanding` (`platform/engineering-deep-links.ts`) | 4 |
| `apps/desktop/src/renderer/src/routes.tsx` | desktop route entry | `ProjectEngineeringPage` | 4 |
| `packages/core/paths/paths.ts` | `projectEngineering(id, target?: {page?, section?, thread?})` path builder | — | 2 |
| `packages/views/projects/components/index.ts` | barrel export | `EngineeringOverview` | 1 |
| `packages/views/i18n/resources-types.ts` | locale resource typing | `engineering.json` | 2 |
| `packages/core/diagnostics/diagnostic-context.ts` | redacted path pattern | — | 1 |
| `server/cmd/server/router.go` | route registration | `RegisterLabrastroEngineeringRoutes` | 1 |
| `server/cmd/multica/main.go` | baseline CLI exit code hook | `labrastroBaselineExitCode` | 1 |
| `server/cmd/multica/cmd_project.go` | CLI subcommand registration | `newLabrastroProjectBaselineCmd`, `newLabrastroProjectEngineeringCmd` | 2 |
| `server/internal/handler/project_resource.go` | claim-time engineering context injection | `appendEngineeringProjectDescription` | 1 |
| `server/internal/handler/project.go` | delete-project cascade | `deleteProjectEngineering` (`labrastro_engineering.go`) | 2 |
| `server/internal/handler/workspace.go` | delete-workspace cascade | `deleteWorkspaceEngineeringAndProjects` | 1 |
| `packages/core/package.json` | engineering subpath export | `./projects/baseline-wiki-diff.ts` | 1 |

"Expected lines" uses one mechanical metric: added lines vs the recorded
upstream base that mention an engineering/baseline identifier
(`git diff -U0 <base> HEAD -- <file>`). Table total: 55 lines. When a file's
residual exceeds its expected value after a sync, restore the thin plug before
merging.

Key-generation guard: `engineeringProjectKeys.wikiRoot` keeps wiki reads under
`project-engineering/{wsId}/{projectId}/wiki`, outside the `projects/{wsId}`
prefix that issue and project events invalidate;
`packages/core/projects/queries.test.ts` pins the key shapes so an upstream
key reshape fails tests instead of silently missing cache invalidation.

## Plugin-route re-evaluation triggers

OL-1298 (Master, 2026-11-09) decided the engineering module stays in the fork
core repo. Re-evaluate migrating it to an upstream plugin service only when
ALL of the following hold; until then, do not reopen the question:

1. Upstream provides a project-level `Surface` mount point (`project_page`)
   that supports a fill (viewport-covering) layout.
2. The upstream `surface-bridge` natively supports URL-route synchronization
   and deep-link navigation.
3. Upstream fixes #8960 (daemon token issuance with HTTP-only agent hooks),
   agent hooks carry `task`/`issue` context, and Antigravity supports MCP (or
   our agents no longer run on AGY).
4. Upstream provides plugin-triggered agent runs (#8851-class) plus read
   interfaces for projects, members and roles.
