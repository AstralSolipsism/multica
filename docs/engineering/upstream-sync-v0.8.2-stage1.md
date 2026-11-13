# v0.8.2 Stage 1 handoff (OL-1350 / OL-1342)

Shared branch: `sync/v0.8.2-ol-1342`. Stage 2 restores the retained frontend
customizations before Stage 3 opens the single PR to `AstralSolipsism/multica`.
The intermediate branch is not a release candidate.

## Merge ancestry

- Fork parent: `821d811f9a368e3709bec2ea467336d785ba57e0`.
- Upstream parent (`v0.8.2`): `b7f8efcaae6c5f3273c0038252b5d10c81b41068`.
- Two-parent merge M1: `3d213215f4e18f9dc22d2dd75ee67083bc1c44fb` (parents in the order above).
- No rebase; subsequent upstream patches retain their source SHA with `-x`.

| Source commit | Branch commit |
| --- | --- |
| `f4dc21c2babe5eea9140c8c2b19f3be4ebc04622` | `16e1337913188886400319a55c03ec1e2c35320f` |
| `e692d03e234ffa3c1f63e6eef1b368532f1cdab3` | `fb86d8b17a45a096b78ad9b4c4fb2f1e5ac6c5cb` |
| `e17f76553eed99fc0f8446119523de679ecb4b84` | `086f77a6d4b0083a2a0e7889d0c65aad0362c137` |
| `31f27f16a4235636bf8283dc2e3717343fb304f7` | `1a4e5feb5ecdda48c872d41c92ade9ed7a29f818` |
| `d31322dd87daddfb226fe41c2ba6550880fa2969` | `2c88f8a686878110f312af06a8bf6f5f707693b3` |
| `61f84be54164eddcca013fac1bc87e63c0c8ea57` | `8006c6c7a6619e75229ba7b89cfcd19f5d28df91` |
| `018107609d5f00a3be6b86d38e3babe2e0e164a1` | `f549f6059196f8ce7d9661dad5c96982bf11a60c` |
| `6ccbdd178ac7dcaf970acfc9a3836be2ca864c49` | `490e1c917cc2c69c90cebcd3f0485e55a7c89aed` |
| `984c2145a0ed41c06cfe35d1885411d27370660d` | `83f51a84b0ded8b4d75db9b16ebf2d915b20550b` |
| `c3a9d8fd1e460f9cf79be7160f19cd1a12624332` | `9cb66530694eccd78959100c838c0e034277145e` |
| `9abc71ae9aa72c8e5acee84462677506568d1082` | `6c3adf03eeb0083ef895d3555da9431c2a8190e2` |

`#10274` / `e17f76553` is an empty cherry-pick recorded deliberately: the fork
already contained its entire patch. `antigravityStepTerminal`, `SkillInvocation`,
and both `legacy resumed EOF exit 0/1` tests remain present. The fallback has no
`opts.ResumeSessionID == ""` restriction.

`#10173` was not conflict-free: `e2e/fixtures.ts` retains `deleteIssueView` and
adds upstream's optional parent argument to `createComment`;
`packages/core/realtime/use-realtime-sync.ts` retains its fork plugs and adopts
the task-event refresh hunk. `packages/views/issues/components/issue-detail.tsx`
was taken from that source commit so `#10298` can apply consistently. **Stage 2
must also three-way reconcile this extra file against M1^1**, including the HTML
comment callbacks and fork comment-landing behavior. The temporary `/deliverables`
route from `#10173` is removed by `#10298`.

## Stage 2 conflict inventory

The actual initial conflict count is 88: 59 frontend/desktop/docs paths and 29
server/root/tooling paths (the issue's 58/30 breakdown is off by one). The 59
paths below use the upstream side in M1; deleted `features-section.tsx` stays
deleted. The first parent retains every original fork customization. Reconcile
against the current branch, preserving the subsequent security/performance patches,
not by restoring whole files from M1^1.

```text
apps/desktop/package.json
apps/desktop/scripts/package.mjs
apps/desktop/src/main/runtime-config-loader.test.ts
apps/desktop/src/preload/index.d.ts
apps/desktop/src/renderer/src/components/desktop-layout.test.tsx
apps/desktop/src/renderer/src/components/desktop-layout.workspace-gate.test.tsx
apps/desktop/src/renderer/src/components/issue-window.tsx
apps/desktop/src/renderer/src/platform/workspace-window-bridge.tsx
apps/desktop/test/setup.ts
apps/docs/content/docs/cli.fr.mdx
apps/docs/content/docs/cli.ja.mdx
apps/docs/content/docs/cli.ko.mdx
apps/docs/content/docs/cli.mdx
apps/docs/content/docs/cli.zh-Hant.mdx
apps/docs/content/docs/cli.zh.mdx
apps/docs/content/docs/developers/contributing.zh-Hant.mdx
apps/web/app/(landing)/download/download-client.tsx
apps/web/app/(landing)/download/page.tsx
apps/web/app/(landing)/layout.tsx
apps/web/app/(landing)/page.tsx
apps/web/app/custom.css
apps/web/app/globals.css
apps/web/app/sitemap.ts
apps/web/app/text-contrast.test.ts
apps/web/features/landing/components/features-section.tsx
apps/web/next.config.test.ts
packages/core/inbox/queries.ts
packages/core/issues/mutations.test.tsx
packages/core/issues/mutations.ts
packages/core/issues/queries.ts
packages/core/package.json
packages/core/projects/queries.ts
packages/core/realtime/use-realtime-sync-ws-instance.test.tsx
packages/core/types/events.ts
packages/ui/components/common/multica-graphics.tsx
packages/ui/components/common/submit-button.tsx
packages/ui/components/ui/dropdown-menu.tsx
packages/ui/package.json
packages/views/agents/create/builder-conversation.tsx
packages/views/autopilots/components/autopilot-detail-page.tsx
packages/views/chat/chat-page.tsx
packages/views/chat/components/chat-window.tsx
packages/views/issues/components/comment-composers.test.tsx
packages/views/issues/components/comment-input.tsx
packages/views/issues/components/issue-detail-route.test.tsx
packages/views/issues/components/issue-detail.test.tsx
packages/views/issues/components/reply-input.tsx
packages/views/layout/dashboard-layout.tsx
packages/views/layout/help-launcher.test.tsx
packages/views/layout/help-launcher.tsx
packages/views/layout/panels/sidebar-tree.tsx
packages/views/layout/panels/team-panel.tsx
packages/views/layout/panels/views-section.tsx
packages/views/layout/panels/work-panel.tsx
packages/views/layout/panels/work-tree.tsx
packages/views/package.json
packages/views/rich-content/rich-content.tsx
packages/views/skills/components/create-skill-dialog.test.tsx
packages/views/skills/components/create-skill-dialog.tsx
```

The automatically merged frontend files also need the Stage 2 insertion-ledger,
branding, locale, marketing, StarPrompt mount, catalog and lint checks. M1's
lockfile was regenerated from the combined catalog; Stage 2 must regenerate it
again after restoring fork package manifest dependencies.

## Server changes and retained contracts

- Dependency reads and write-response projections resolve hidden projects;
  cycle witnesses crossing hidden issues omit their paths. DAG matching,
  context expansion, parent references and edge projections use the same policy.
- The issue loader preserves its caller's not-found response for hidden projects,
  including graph focus and dependency endpoints.
- Engineering, baseline wiki and passage-comment realtime events reach project
  members and workspace managers only. Their HTTP routes use the existing
  project-resource visibility gate. Tip-chat creation/reopening checks the
  locked source issue's project before creating a chat.
- The fork's grouped inbox query includes upstream filter projections and
  hidden-project filtering; deterministic `created_at, id` ordering remains.
- StarPrompt is fixed off at the server: claims are rejected, click requests
  do not mutate bookkeeping, and user responses exhaust the display allowance
  for installed clients. Migration 629 and storage fields remain unchanged.
- Local `/uploads/*` serving stays removed. Media's legacy upload fixture now
  asserts an authenticated attachment download URL in its delivered Markdown.
- CLI dependency envelopes, scope/offset/include-closed and PR auto-completion
  coexist. Comment attachments upload unbound and are bound by comment creation.
- Qoder's bridge is byte-identical to the fork parent, already including the
  single-repository token, credential preflight fallback and per-resource refresh.
  Host metrics, quota probes, OMP and Codex probe throttling remain present.
- CI retains its Ubuntu 24.04 pins, `CI required`, retained E2E and formatting/
  branding gates while adding the upstream catalog and tooling checks.

## Migration and insertion audit

All 40 up/down files for migrations 617–636 are byte-identical to v0.8.2.
`467_autopilot_trigger_creator_from_autopilot.up.sql` is unchanged from the fork
parent and retains no-backfill semantics. Wakeup capture inventory and upstream
579/9066 parity tests pass. The actual fork ledger at this base ends at **9075**;
Stage 3 should include 9071–9075 in its two-path schema comparison.

The formatting manifest has 12 byte-identical upstream exceptions. Its source
is v0.8.2 except `daemon_auth_test.go`, whose source is `9abc71ae9`. The newly
unformatted upstream `issue_environment.go` is pinned, and the daemon-auth blob
is updated. No guard was weakened.

Server engineering insertion counts against ledger base
`12f8f3f31111564e5e1b9aac3f7f916e8bba4039`:

| File | Actual / budget |
| --- | --- |
| `server/cmd/server/router.go` | 1 / 1 |
| `server/cmd/multica/main.go` | 1 / 1 |
| `server/cmd/multica/cmd_project.go` | 2 / 2 |
| `server/internal/handler/project_resource.go` | 1 / 1 |
| `server/internal/handler/project.go` | 2 / 2 |
| `server/internal/service/issue.go` | 3 / 3 |
| `server/internal/handler/workspace.go` | 1 / 1 |

## Validation environment

The regular race run, the separate `--only agent` run and the guarded
message-delivery race run cover all **109 Go packages** (including packages
without test files). The latter two groups were run explicitly because the
regular script stops after a failed group. All regular packages other than the
initial environment failures described below passed, as did message delivery.

Go 1.27.3 and a task-local PostgreSQL 17 cluster were used. All fresh migrations
through 9075 applied successfully. The initial `ol1350_test` database inherited
`SQL_ASCII`, which caused the three Chinese text groups
`TestLabrastroTipChatMaterialIsBoundedAndScoped`,
`TestLabrastroYSKSingleAndBatchClaims` and
`TestLabrastroYSKReportsValidateDeduplicateAndOverturn` to fail. They pass without
source changes on the replacement `ol1350_utf8_test` database with explicit UTF-8.
That guarded race rerun covers every `TestLabrastro` handler test, StarPrompt,
dependency/DAG and search regressions (64.542 seconds).
Go tests run through the repository's agent-CLI guard; no real agent smoke tests
were authorized or run.

The host's Git 2.39.5 cannot run the upstream worktree normalization cases
(`merge-tree --merge-base` requires Git 2.40+). A task-local Git 2.47.3 build
passed the complete `internal/daemon/execenv` race package without source changes.

The full agent race run completed with four failing test groups on this host's
Linux 5.15 kernel. Cursor's durable process-group implementation requires Linux
6.9's `PIDFD_SIGNAL_PROCESS_GROUP`; its probe returns `EINVAL` here:

- `TestCaptureCursorBackgroundLateDescendant`
- `TestCaptureCursorBackgroundProcessReapsLeaderExitedGroup`
- `TestCaptureCursorBackgroundSurvivesRootExitDuringCapture`
- `TestCursorBackgroundLifecycle` (`budget`, `multiple`, `finish`, `cancel`)

The Linux implementation and all four test groups are byte-identical to the
fork parent. No fallback or test skip was added. They still need a Linux 6.9+
runner; the complete suite is **not all green** on this host. The separate
`-race -run TestAntigravity -count=1` run passes, including both legacy resumed
EOF recovery cases.

The following checks pass:

- `go -C server vet ./...`.
- Two consecutive `make sqlc` runs with zero tracked diff.
- `bash scripts/check-gofmt.test.sh` and `bash scripts/check-gofmt.sh`.
- `bash scripts/dev-env.test.sh` and `bash scripts/test-retained-e2e.test.sh`.
- Node tests for CI scope, image budget, PR screenshots and brand sync.
- `node scripts/brand/sync.mjs --check` and `git diff --check`.
- Targeted wakeup-capture migration inventory/parity tests.

Frontend builds/tests, browser E2E, mobile/native packaging and the final
fresh-install-versus-upgrade schema comparison remain Stage 2/3 work. The
retained-E2E gate's script tests do not substitute for browser E2E.
