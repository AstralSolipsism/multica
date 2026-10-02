# v0.6.1 integration: security and migration compatibility

OL-98 is batch A of OL-97. It integrates the fixed upstream v0.6.1 source into
the Labrastro business branch for review. Production migration, publishing,
download feeds, native packages and the batch B end-to-end acceptance remain
separate work. No production database or main branch was changed by this run.

## Source and decisions

| Source | Commit |
| --- | --- |
| Fork business `main` before integration | `f89cba43ee9f57076d172b2670f6789033f32303` |
| Reported running `0.5.3-labrastro.9` binary | `ba3233fd771def15b50dfd15214db0ddfd4b3dfa` |
| Fixed upstream `v0.6.1` target | `2ea01ae4ef55de4310b99af192d2dbd367832883` |
| Common ancestor | `12f8f3f31111564e5e1b9aac3f7f916e8bba4039` |
| Two-parent merge | `7c56bb61edc305ccc20900d808f3c9e9ee34b337` |
| Follow-up locale correction | `4da81dce1` |
| Verified build after sqlc regeneration | `4c69a2fa038d9f9ea8286b4a46720cfdc9513466` |

The difference between the reported running commit and the business base was
the release record. `origin/main` and `origin/upstream` still matched the pinned
sources when checked before delivery. The PR targets Fork `main` from the
isolated task branch; it does not merge or publish it.

The [retained product contract](upstream-sync-20260926.md#retained-fork-product-constraints)
continues to apply: Labrastro branding and internal release/update sources,
informational DAGs, provider quotas and host metrics, explicit external Feishu
conversation grants, and configured notification/result delivery remain.
No marketing/onboarding promotion was restored. Existing absence and retained
feature tests were kept. Local search remains enabled according to upstream
configuration; this merge does not add a default-off switch.

The 26 textual conflicts were resolved by responsibility:

- Preserve both sets of E2E fixtures and retained DAG cache invalidation while
  adopting upstream bounded issue/activity refresh and membership failure handling.
- Merge the 15 conflicting locale JSON files structurally, keeping distinct
  upstream and Fork keys. Complete DAG count plurals in French, Japanese,
  Korean and Chinese to satisfy the shared locale parity contract.
- Start the lockfile from upstream, replay Fork dependencies (`elkjs`,
  `@xyflow/react`), and keep the Tiptap family at `3.31.3`.
- Carry the Labrastro co-author text into the new Code settings tab, keep
  upstream inline-save behavior and WeCom localization, and move retained
  WeCom brand strings to the new localized string definitions.
- Retain dependency graph and external conversation authority instructions in
  the built-in platform skill alongside upstream PR/wakeup behavior.

`make sqlc` also corrected the new `SetClaimedTaskContext` return projection:
it now includes the retained `dependency_admission` and
`conversation_root_task_id` fields. A second generation produced no diff.

## Channel invocation authority

There are two distinct human authority sources, both checked before creating a
chat session or accepting a turn:

1. A bound workspace member uses their own invocation rights, through
   `server/internal/integrations/channel/engine/router.go`. A denied member
   cannot fall through and borrow the installation's external conversation grant.
2. An unbound speaker, or a notification binding without workspace membership,
   uses the explicit conversation grant. The speaker is a source identity;
   the recorded grantor is the execution principal. Before persistence,
   `server/internal/handler/labrastro_conversation.go` calls
   `channel.AuthorizeConversation` to validate the live installation, grant
   identity/scope/chat, current membership and target-agent invocation rights.
   Frozen grants and the conversation-root reference continue to govern
   retries, delegation and revocation.

Workspace administration does not authorize private-agent invocation. The
existing ownership/`public_to` rules are retained for the grantor rather than
replaced with the external speaker's optional account binding.

`server/internal/handler/channel_invocation_merge_test.go` exercises the real
Feishu resolver/router/service with 80 cases: eight authority arrangements,
private/group chat, and ordinary text, `/new` with text, bare `/new`, `/clear`
and `/issue`. It checks denied writes (session/input/run/issue), permitted
execution identity and duplicate redelivery. Existing conversation grant,
retry, revocation, delivery and provider tests also ran.

## Selected policy: one default-deny boundary (option B)

External Feishu tasks and their descendants now pass one capability check in
`server/internal/middleware/auth.go`. The check uses the persisted task ancestry
already introduced by the shipped Fork migration 551, after validating the live
conversation grant. It does not rely on caller-supplied actor or task headers.
Normal member credentials and first-party task tokens keep upstream behavior.

`labrastro_conversation_policy.go` owns a small, explicit method/route allowlist:
reading collaboration content, creating/updating issues, comments and
attachments. The existing handler checks still enforce workspace, ownership and
invocation permissions. It denies everything else, including wakeups,
Autopilots, account credentials, invitations, notifications, integrations and
configuration. Reads are enumerated too: GET is not a blanket exception for
webhook credentials, MCP configuration or credential lists. Denials return
`403 external_conversation_forbidden` before entering the business handler.

An additional real-router regression found that assigning an existing
member-created issue from an external task lost its ancestry: the new run had a
NULL root and would receive ordinary task authority. A request-scoped external
task context now reaches the **shared issue-run attribution function**, which
classifies that assign/promote as delegation from the actual caller. Existing
comment-source classification and first-party behavior remain. This second
shared boundary is necessary to make the allowed operations preserve the
policy; an HTTP method allowlist alone cannot do that. It adds no per-feature
denial checks or new persistence model.

The lookup resolves the real production Chi route, with a separate route
context. A newly added literal `/api/issues/future-secret` cannot inherit the
permission of `/api/issues/{id}`. Missing routing context and unknown methods or
routes fail closed. Existing daemon and plugin credential boundaries remain
separate; the external task token gains no daemon or plugin credential.

The production route inventory currently contains **443 user-authenticated
routes: 60 allowed and 383 denied**, plus 69 routes with separate authentication
or public/capability handling. The test calls every denied user route with a
real, otherwise-valid external task token and requires the central error code.
It also records method, route, authentication boundary and decision in
`server/cmd/server/testdata/labrastro-external-routes.tsv`. New or changed routes
fail the inventory check until reviewed, while the runtime already denies new
routes. This detects route changes, not semantic changes inside an existing
handler; upstream sync still requires reviewing the latter.

After reviewing a changed route, update and inspect the inventory explicitly:

```bash
LABRASTRO_UPDATE_ROUTE_INVENTORY=1 go -C server test ./cmd/server \
  -run '^TestExternalConversationRouteInventory$' -count=1
git diff -- server/cmd/server/testdata/labrastro-external-routes.tsv
```

The Autopilot-specific gates and the wakeup consent extension from the earlier
review rounds are removed. The **unreleased** 564 migration and its dedicated
backfill/scale tests are removed; released 551 and upstream 551–563 are intact.
The final expected ledger is **631**, matching the initial v0.6.1 merge. The
previous 632-migration and 564 performance results describe a superseded design,
not this PR's final implementation. Only the managed disposable test database
was taken back through 564 down; no production migration was run.

Two independent correctness fixes remain: the Feishu private invocation-denial
notice, and the object-intent cleanup query's materialized single-row claim.
The latter prevents a nested-loop plan from leasing several objects while the
caller consumes one row; its existing regression failed five times before the
fix and passed five times afterwards. The wakeup-management test also retains
its dedicated runtime to remove fixture lock contention. None of these changes
adds capabilities to the external-conversation policy.

The grant instructions and all five existing grant-UI translations describe the
reduced capability set. Real-router tests cover root/delegated/retried tasks,
pruned intermediate history, revocation, successful issue/comment/attachment
operations, and an actual delegated issue preserving its root. Ordinary member
and first-party task calls retain their previous behavior. The separate
middleware regression covers new literal routes, methods and malformed paths.

## Deployment prerequisite: retire earlier delegated authority

An API allowlist prevents new operations through an external task token. It
**cannot undo credentials or automation created before this change**, and
removing 564 means the final implementation does not track consent on historical
manual wakeup rules. Do not deploy this version with such rules still active.
Before reopening external conversation grants, an operator must:

- Pause external conversation input and drain/cancel its in-flight work while
  retiring the old rules, including queued tasks and joined wakeup instructions.
- Disable external-origin or unverified manual wakeups, Autopilots and team
  notification routes; review their approved external delivery targets.
- Review the runtime owners' API/login credentials, invitations and join links;
  revoke unknown credentials and rotate webhook secrets already shared outside.
  Revoking the conversation grant alone does not revoke these independent items.
- Treat missing source-task history as unverified, rather than assuming that the
  rule was first-party. Existing Autopilots/notification rules do not record
  sufficient task provenance, so creation timestamps are not proof of consent.

A starting read-only query for manual wakeups on the shipped 551 schema is:

```sql
SELECT w.id, w.workspace_id, w.source_task_id, w.enabled
FROM issue_wakeup w
LEFT JOIN agent_task_queue t ON t.id = w.source_task_id
WHERE w.system_rule IS NULL AND w.source_task_id IS NOT NULL
  AND (t.id IS NULL OR t.conversation_root_task_id IS NOT NULL
       OR t.originator_source = 'channel_integration');
```

This is an audit candidate list, not a complete historical lineage reconstruction
or an automatic deletion script. Already materialized descendants without a
root and old joined instructions also require review. No production data,
configuration or credentials were inspected or changed. HTTP authorization is
not an operating-system sandbox for an agent's local tools.

## Migration results

All 618 historical up-migration identities remain. The merge adds the 13
upstream stems `551_pr_merge_status` through `563_search_index_change_changed_at_index`.
No upstream migration in this range was renamed or edited. Both shipped 551
stems coexist; the lint exemption admits exactly
`551_channel_conversation_root` and `551_pr_merge_status`, not a third 551.

Rehearsal used PostgreSQL 15.19 and two databases created by the managed
worktree environment. The fixture is synthetic; it contains no production data.

| Check | Observed result |
| --- | --- |
| Baseline migration ledger | 618 full stems |
| Upgrade and repeated `up` | 631 full stems; second run skips applied migrations |
| Retained data | DAG edge, chat text, frozen/live grant and two external root/retry references preserved |
| PR settings | Disabled legacy setting becomes `none`; explicit setting preserved; absent setting remains absent |
| Existing wakeup | Instruction preserved; new fields have expected defaults |
| Real HTTP readiness | 200 with complete ledger; 503 after removing either 551 ledger row; 200 after restoring both |
| Interrupted concurrent index builds | All seven builds leave an actual invalid index after interruption; production cleanup/retry yields ready, valid indexes |
| Lost index ledger entry | Valid index retained and full stem recorded on replay |
| Search trigger lock wait | Actual `55P03` at the configured two-second lock bound, no partial table or ledger entry |
| Search trigger statement budget | Scoped DDL fault injection reaches actual `57014` at the ten-second bound; DDL rolls back; retry creates working triggers |
| Restore to pre-upgrade snapshot | 618 stems and two external root references preserved; old migrator succeeds; subsequent upgrade returns to 631 |
| Restore post-upgrade snapshot after lossy downs | PR setting, system rule/receipt, wakeup condition/counters/pause and child events restored |

The index/timeout regression is in
`server/cmd/migrate/migrate_v061_retry_test.go`. It uses the production migration
runner and hooks. The statement-timeout fault injector uses an event trigger
limited to its scratch schema and therefore requires a PostgreSQL superuser.
That branch ran here; with a non-superuser fixture the test logs that only the
configured statement bound is checked, while the lock-timeout test still runs.

## Reproducing the upgrade and restore rehearsal

Create separate baseline and merged worktrees at the commits above. Use each
worktree's `make up C=api` / `make down` and `.env.worktree` to create isolated
databases, then stop the APIs before restoring or changing schema. Never point
the following fixture commands at a shared or production database.

In this container, the managed API identity check expected a short commit while
the Makefile supplied a full commit. The successful readiness launch used:

```bash
make up C=api ARGS='--ephemeral --name ol98-merged' COMMIT="$(git rev-parse --short HEAD)"
```

`lsof` was needed by the environment scripts. After `make down`, the listeners
were verified absent; the container's non-reaping PID 1 left zombie wrapper
PIDs which caused the stop command to report an error. This did not leave an
API listener running. These are harness limitations, not changes to production
startup or process supervision.

The following sequence describes the commands used. `DATABASE_URL` comes from
the disposable baseline worktree's `.env.worktree`; `BASELINE_ROOT`,
`MERGED_ROOT` and `BACKUP_DIR` identify the two checkouts and a private backup
directory. Do not print connection credentials or add backups to Git.

```bash
set -a
source "$BASELINE_ROOT/.env.worktree"
set +a
go -C "$BASELINE_ROOT/server" run ./cmd/migrate up
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MERGED_ROOT/server/cmd/migrate/testdata/v061-upgrade-seed.sql"
pg_dump -Fc --no-owner --no-acl "$DATABASE_URL" -f "$BACKUP_DIR/pre-v061.dump"
go -C "$MERGED_ROOT/server" run ./cmd/migrate up
go -C "$MERGED_ROOT/server" run ./cmd/migrate up
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MERGED_ROOT/server/cmd/migrate/testdata/v061-upgrade-assert.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MERGED_ROOT/server/cmd/migrate/testdata/v061-rollback-seed.sql"
pg_dump -Fc --no-owner --no-acl "$DATABASE_URL" -f "$BACKUP_DIR/post-v061.dump"
```

Only in that disposable database, execute the actual down SQL to demonstrate
the data loss. This is a destructive fixture probe, not a recommended migrator
rollback procedure. Restore the post-upgrade dump afterwards:

```bash
for stem in 558_issue_child_event 557_wakeup_conditions 555_wakeup_system_rule 551_pr_merge_status; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MERGED_ROOT/server/migrations/$stem.down.sql"
done
pg_restore --clean --if-exists --exit-on-error --no-owner --no-acl \
  -d "$DATABASE_URL" "$BACKUP_DIR/post-v061.dump"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MERGED_ROOT/server/cmd/migrate/testdata/v061-rollback-assert.sql"
```

For the old-binary recovery rehearsal, empty the **disposable** database's
public schema first, then restore `pre-v061.dump`. Merely restoring an older
dump over a newer schema can leave newer objects that are absent from the
backup. Run the baseline migrator, verify 618 ledger rows and retained root
references, then run merged `up` and `v061-upgrade-assert.sql` again. This
sequence passed and returned to 631 migrations.

Production recovery, if separately approved, should stop all writers,
schedulers, daemons and channel ingress; back up the database plus uploaded
files, deployment configuration and secret/encryption-key material using the
operator's secure backup system; and test restoration before changing schema.
Record the old and new binary/image digests and the full migration ledger.
Restore into a clean database and pair it with the corresponding old binary
and configuration. Reconcile any writes since the backup before resuming
traffic. Database restoration alone does not undo notifications already sent
to external channels.

Do not describe these downs as lossless:

- `551_pr_merge_status` removes the selected PR-merge status setting. Its up
  migration also writes the legacy `pr_auto_complete_enabled=false` setting
  in affected workspaces; down does not restore the previous value.
- `555_wakeup_system_rule` removes system wakeups and their receipts.
- `557_wakeup_conditions` drops condition, fire-limit/count and pause data.
- `558_issue_child_event` removes the child-event history/queue.

## Verification commands and limits

Toolchain: Go `1.26.6`, Node `24.21.0`, pnpm `10.28.2`, PostgreSQL `15.19`,
Linux `5.15.0-157-generic`. Go commands used `GOMAXPROCS=4` and `GOFLAGS=-p=4`.
DB-backed tests sourced the managed `.env.worktree`; the tests did not use
real agent accounts or installed agent CLIs.

Option B was verified at `92fe902fec287338f85fed9a5f7da98e195ac5d3`:

| Command / scope | Result |
| --- | --- |
| `tini -s -- bash scripts/test-go.sh --race --only regular` in the detached test checkout | All 71 tested packages pass: 33 executed, 38 valid cached results; 16 other packages have no test files |
| Real production-router policy tests | All 383 denied routes return the central 403 code; collaboration writes/reads, delegation, retry, deleted intermediate history and revocation pass |
| Existing member-created issue assigned by an external task | Failed before the shared attribution fix with NULL conversation root; assignment and comment-mention cases now pass |
| `go vet` for server, middleware, channel, handler and service | Pass |
| `make build` | Server, CLI and migrator pass; only this report was uncommitted during the build |
| Repeated `make sqlc` and `git diff --check` | Pass; generated wakeup code matches the pre-extension implementation |
| `pnpm --filter @multica/views exec vitest run locales/parity.test.ts --maxWorkers=2` | All 220 tests pass |
| Final disposable `migrate up` and audit-query `EXPLAIN` | Pass against the 631-row migration ledger |

The regular suite includes the migration recovery/timeout tests and retained
channel-invocation regressions. Agent implementation and frontend application
logic did not change in this correction; the agent host limitation below remains,
and this round reran locale parity rather than the full frontend/mobile suites.
No external CI run was awaited; current checks are reported on the PR.

The initial v0.6.1 integration was checked as follows. These frontend/mobile
results precede option B.

| Command / scope | Result |
| --- | --- |
| `go build ./...`, then `make build` after regeneration | Pass; server, CLI and migrator built |
| `make sqlc`, repeated with generated-file diff check | Pass; second generation unchanged |
| `bash scripts/test-go.sh --race` / regular packages | All regular packages pass after the CLI environment correction below |
| `go test -race ./cmd/migrate ./internal/handler ./internal/service -run 'TestV061\|TestChannelInvocationAuthority\|TestBuiltinSkills' -count=1` | Pass, including the 80-case authority matrix and actual timeout injection |
| `go test -race ./internal/service` after sqlc regeneration | Pass |
| `pnpm typecheck` | Pass, 10 tasks |
| `pnpm lint` | Pass, 7 tasks; existing warnings remain |
| `pnpm exec turbo test --filter='!@multica/mobile' --continue --concurrency=1` | Core 2,402; desktop 724; web 272; docs 16; UI lab 46 tests pass; views rerun below |
| `pnpm --filter @multica/views exec vitest run --maxWorkers=4` | Pass; 515 files, 6,342 tests |
| Mobile `typecheck`, `lint`, `test` | Pass; 234 Vitest tests and iOS runner script assertions |
| `git diff --check` | Pass |

The first frontend runs found and corrected retained DAG contrast/plural
incompatibilities. An ignored Electron install script was run to supply the
local test executable. With unrestricted Vitest workers, the issue-title
loading assertion also failed once; the views suite was rerun with four workers
without changing that assertion or its timeout.

The runtime places a daemon-task marker in an ancestor of workspace checkouts.
CLI tests intentionally reject incomplete daemon credentials there. They pass
in a detached checkout outside that ancestor, with inherited `MULTICA_*`
variables removed from the **test child process only**. The platform marker
and CLI security checks were not modified. The successful CLI command was
`tini -s -- bash scripts/go-test-with-agent-cli-guard.sh -- go -C server test -race ./cmd/multica`.
The same subreaper harness makes the daemon process-tree cancellation test
pass under this container's PID 1. All regular non-CLI packages passed in the
managed DB environment; the CLI rerun passed all its tests.

The complete Go suite is **not green on this host**.
`tini -s -- bash scripts/test-go.sh --race --only agent` fails in exactly four
top-level groups:

- `TestCaptureCursorBackgroundLateDescendant`
- `TestCaptureCursorBackgroundProcessReapsLeaderExitedGroup`
- `TestCaptureCursorBackgroundSurvivesRootExitDuringCapture`
- `TestCursorBackgroundLifecycle`

They report unsupported process-group retention (`invalid argument`) and its
cleanup consequences on this Linux 5.15 host. This is the previously recorded
Cursor `PIDFD_SIGNAL_PROCESS_GROUP` limitation in the prior sync report; the
relevant tests and implementation are unchanged from the Fork base. No
production safety fallback or test exclusion was added. The subsequently
completed [backend-agent-tests CI job](https://github.com/AstralSolipsism/multica/actions/runs/36954862210/job/110675534025)
passed at the prior PR head `a0d914f2b`, so the failure above is a local-host
limitation, not a failure in that CI environment. It is not a CI result for the
new correction commit.

Not run: browser E2E, live Feishu delivery, real agent smoke, native device or
desktop package execution, migrations against production-shaped data or
production search load, production deployment, or release publication.
Unit/component coverage does not substitute
for batch B acceptance. External CI is triggered by the PR and is not awaited.
