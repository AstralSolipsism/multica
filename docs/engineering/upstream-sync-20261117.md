# Upstream v0.10.0 sync — 2026-11-17 (OL-1414 / OL-1417)

Stages 1–3 share `sync/v0.10.0-ol-1414`, targeting
`AstralSolipsism/multica:main`. Stage 4 (OL-1418) owns release and deployment
of `v0.10.0-labrastro.1`. The PR and issue handoff pin the final archive commit.

## Ancestry

| Boundary | Full SHA |
| --- | --- |
| Merge base / v0.9.0 | `8cd8a2db978d532d8627c78cd29f05deab6c6f17` |
| Fork main / M1 first parent | `b3e05177c797e8f6f6bbd9f121a706a6fdb70e75` |
| Upstream v0.10.0 / M1 second parent | `2fcb424b72b024f65161809081009063846ea44d` |
| Two-parent merge M1 | `240eac1b38b7bd065b58876ff3ba0b19f06fc7fc` |
| Stage 1 reviewed head | `c5f20cb620dd897940c20e413231ab242e327312` |
| OL-1412 trigger preview cherry-pick | `b296239f831a43b54d9db0eb002be39b318a1060` |
| OL-1412 query-gated skills cherry-pick | `53294a8322cef5375c1f042c9001dd0ca2db635b` |
| Stage 2 reviewed implementation | `f4f2b7a2ef19b71d360722f2a87467adade4695a` |
| Stage 3 toolbar cursor regression | `cecb2621928c1e7177f1f5b48545269aab0a2976` |

The two OL-1412 commits retain `cherry-pick -x` provenance from
`ee09307c11c428f71507803505e508e7a4eed0cb` and
`1450563041999a68b085af97d007702e7cd29cb5`. Their staging branch was not merged:
its ancestry includes unreleased upstream work. No 661–680 migrations are
present. History is append-only. Stage 3 also restores the shared composer
toolbar's arrow cursor and updates the retained cursor/layout regression.
During validation, main advanced to `3bb098fcd0109467671132b3081c683dabbc2fa7`
with OL-1419's baseline lint. `git merge-tree --write-tree origin/main HEAD`
confirms a clean merge; that change adds no migrations. The recorded fork
parent remains the original integration base, without rebasing this branch.

## Migration identities and PostgreSQL 17 evidence

The ledger contains **798 full migration identities**. The measured split is
**726** in 001–660 (including retained historical fork stems) and **72** in
9001–9076. The issue's 722 + 76 split is incorrect: 9055–9058 are absent from
both released and current trees after the historical annotation renumbering
`e4f4f9664`. No migration is added or renumbered by this archive.

All eight incoming SQL files are byte-identical to upstream v0.10.0. Compare
`git rev-parse <upstream>:server/migrations/<filename>` with
`git hash-object --no-filters <filename>` for both directions of each stem:

| Incoming stem | Up/down identity |
| --- | --- |
| `657_inbox_item_snoozed_until` | byte-identical |
| `658_project_archive` | byte-identical |
| `659_issue_view_preference_projects_page` | byte-identical |
| `660_inbox_item_snoozed_at` | byte-identical |

All existing migration files from `v0.9.0-labrastro.1` and the fork main
baseline retain their bytes. Across the entire upstream migration inventory,
only the historical 467 pair differs:

| Filename | v0.10.0 blob | Fork blob |
| --- | --- | --- |
| `467_autopilot_trigger_creator_from_autopilot.down.sql` | `1c32fd2368ae0ae78e2bf5dc8886b780cbed69eb` | `ee35bfe58e35fccdeee0e32d4ae077fac5136c15` |
| `467_autopilot_trigger_creator_from_autopilot.up.sql` | `40a3888825985738469996a1596110ae62038ac6` | `9d9719921186f406855115c4a5a7e73b9c377896` |

467 changes column comments only; it never infers a trigger's principal from
the autopilot creator. Installed ledgers do not rerun it, and unresolved
triggers remain denied. `9066_labrastro_retire_conversation_provenance`
restores the upstream `579_wakeup_skip_handed_to_agent` definition of
`capture_issue_wakeup` after 9009/9028. Definition inventory, upstream identity,
and fresh/upgrade order tests all pass (`TestLabrastroWakeupCapture*`).

Validation uses a new native **PostgreSQL 17.12 / UTF8 / pgvector 0.8.7**
cluster bound to loopback, with task-owned data and no production credentials.
pgvector is installed and loadable (a separate probe database verifies vector
distance); application migrations do not create or use that extension.
The project owner explicitly accepts this native PG17 environment as equivalent
to the CI `pgvector/pgvector:pg17` service. Each baseline uses its own checked-out
production migration runner; the candidate runner applies the increments.

| Path | Ledger progression | Invalid indexes |
| --- | --- | --- |
| Fresh install | 0 → 798 | 0 |
| Released `v0.9.0-labrastro.1` upgrade | 0 → 793 → 798 (657–660 + 9076) | 0 |
| Fork main upgrade | 0 → 794 → 798 (657–660) | 0 |
| Clone, rollback only 660–657, reapply | 798 → 794 → 798 | 0 |

All four final schema SHA-256 values are identical:
`922f1afb7f1d64573df99a417279837e75d05e63beeb83800af3199e46db723b`.
The rollback schema also exactly matches the pre-upgrade 794-entry schema.
Normalization removes only randomized `\restrict` / `\unrestrict` lines from
`pg_dump --schema-only --no-owner --no-privileges`; it preserves column order,
functions, constraints, indexes and comments.

## Engineering insertion measurements

Measured with `git diff -U0 2fcb424b72b024f65161809081009063846ea44d HEAD -- <file>`
using the checklist's identifier-line metric. Exclude only the unrelated YSK
documentation reference and `tabStorage?.setBaseline`. All imports/calls and
their implementations survive: **22 files, 54/54 lines**, without budget changes.

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

Backend: seven files, 11/11 lines. Frontend: fifteen files, 43/43 lines.
The high-churn anchors also retain their fork-base counts:
`daemon.go` has two `heartbeatExtrasFor`, two `recordTaskPlanQuota`, one
`reportedTaskUsageEntries`, three `planQuotaCache.Delete` calls and the
`dshMissingProfileReason` constant. Its fork fields retain their separate
implementations; `planquota_kimi.go` is unchanged from the fork base.
`cmd_issue.go` retains one dependency command registration, two flag
registrations, one flag validation, two compound-write preparation calls and
two mutation-output calls. Attachment rewriting remains three upstream
`applyAttachmentLinks` calls, with no revived fork attachment implementation.

## Five approved decisions

1. **1A — Release anchor:** merge v0.10.0 and only the two OL-1412 leaf commits;
   release/deploy v0.10.0-labrastro.1 after review. No unreleased 661–680 chain.
2. **2B — What's New:** Web and Desktop mount `WhatsNewDeck`; `StarPrompt`
   remains unmounted and `SHOW_SOURCE_BACKFILL` remains false. The session
   store initializes `surveyPending` to false; the disabled source modal
   cannot block the deck. Comment/reply composers retain voice input and
   query-gated target-agent skills.
3. **3A — GitHub binding:** upstream #10705 OAuth authorization-code validation
   replaces OL-955 signing/binding helpers and their frontend error-code branch.
   The Labrastro callback label and OL-928 managed-installation reuse survive.
4. **4A — Notifications:** `inbox.Deliver`, `inbox.Group` and `inbox.Muted`
   own delivery/classification; reactions are supported and the three legacy
   event types leave personal Feishu filters. Personal/team Feishu delivery,
   `TeamSubscriptionsSection`, precise timestamps, priority payloads and
   grouped-inbox snooze filtering survive.
5. **5 — Themes and privacy:** upstream #10552 removes the theme-store off
   switch. #10618/#10723 enforce private-project membership and human-only
   owner recovery. Engineering Wiki events, embedded comment attachments and
   Feishu routing/approval/delivery records retain private-project guards.

## Validation and review handoff

Go 1.27.3; Node 24.21.0; pnpm 10.28.2; Playwright 1.58.2 Chromium;
Linux 5.15.0-157. All Go tests use the task-local PG17 database and the
repository's agent-CLI guard; no real-agent smoke tests run.

- All 110 Go packages are covered: 94 pass, 15 contain no tests, and the
  agent package has only the four accepted kernel failures below.
  Message delivery runs after Service, as required by `scripts/test-go.sh`.
- The system Git 2.39 caused seven execenv test failures because it lacks
  `merge-tree --merge-base`. The complete execenv package passes with
  task-local Git 2.45.2, without code/assertion changes.
- Linux 5.15 cannot provide Linux 6.9 process-group pidfd signaling:
  `TestCaptureCursorBackgroundLateDescendant`,
  `TestCaptureCursorBackgroundProcessReapsLeaderExitedGroup`,
  `TestCaptureCursorBackgroundSurvivesRootExitDuringCapture`, and
  `TestCursorBackgroundLifecycle` fail on that boundary. OL-1417 explicitly
  accepts this environment limitation; these are not reported as passes.
- `TestWorkspaceDeletionManifestCoversPublicSchema` and all
  `TestLabrastroWakeupCapture*` tests pass against the migrated environment.
- sqlc generates twice with zero diff. Go formatting/regressions, all eight
  pinned upstream formatting exceptions, brand sync/tests, dependency catalog,
  knip, typecheck (10 tasks), lint (7 tasks, existing warnings), and
  `git diff --check` pass.
- Final default `pnpm test`: 807 Vitest tests pass in 49.2 seconds, including
  the brand suite; script tests pass 180/181. The single script failure is
  the explicitly accepted missing local Docker executable for Compose validation.

The first complete retained E2E run took 291.20 seconds: 23 passed and one
failed on the retired `pb-9` assertion. Replacing that implementation assertion
with observable toolbar positioning exposed the real regression on the old
build: the reply toolbar inherited `cursor=text`. One `cursor-default` class
in the existing shared `ComposerToolbar` restores the arrow while preserving
pointer cursors on buttons. The regression still checks text-area cursors,
padding-click focus, avatar alignment, send locking and toolbar non-overlap.
The first run of the fixed commit in a second clean checkout reached the
300-second whole-command limit during the final route checks (21 passed,
no assertion failures). It is recorded as incomplete. The final run reuses
build caches on the same clean checkout with a newly recreated empty database;
the script, selected tests, assertions and timeout are unchanged.

**Final retained E2E: 24/24 passed, zero failures/skips/retries, 157.00 seconds
for the complete `bash scripts/test-retained-e2e.sh` command** (browser phase
1.9 minutes). It runs from a clean isolated checkout of `cecb2621928c1e7177f1f5b48545269aab0a2976`,
without root/Web dotenv overrides, against a recreated empty PG17 database.
Only sync documentation follows that tested commit. PostgreSQL is stopped
with `pg_ctl stop`; test servers, listeners and temporary checkouts are cleaned
before handoff. Evidence is attached to OL-1417 rather than committed.

This container has no DISPLAY/WAYLAND_DISPLAY. The explicit issue exception
permits delivery without graphical UI screenshots; only the requested retained
browser gate and its failure diagnosis run. Desktop packaging, native mobile
rendering, production deployment and release publication are not claimed.

## Deployment handoff

- Remove old `MULTICA_THEME_STORE=off`; preserve
  `MULTICA_GC_COMPLETED_TASK_TTL=0`.
- Merge `AstralSolipsism/Labrastro-runtime` PR #6. Refresh each host's
  `homes/zcode` from its live container state before mounting
  `./homes/zcode:/home/agent/.zcode` on 149/GCP.
- **Never export or restore any old test Project Baseline.** The older sync
  record's baseline-export instructions do not apply to this release.
- Stage 4 owns production backups, image/tag publication, runtime/CLI updates,
  and the separately scoped Outlune → PPT-Master skill organization migration.
- The branch was authored by GPT/Codex and Kimi families. Request two
  sequential high-risk reviews by experts from different families, both
  outside GPT/Codex and Kimi. The second reviewer merges after `CI required`
  passes; the author does not merge or poll remote CI.

No temporary screenshots, archives, raw logs or audit scripts belong in Git.
