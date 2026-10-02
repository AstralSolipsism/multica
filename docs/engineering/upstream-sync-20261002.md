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

## Review corrections: wakeup consent and private denial notices

Commit `a93435936` closes the two merge-blocking findings. The external root is
now recorded on the wakeup itself by the additive
`564_wakeup_conversation_root` migration. `trigger_owner` tasks inherit that
root, so source-task retention and a human disable/enable do not detach existing
instructions from the grant that authorized them. The migration backfills
existing wakeups and their already-created descendants, preserves recorded roots
on replay, and denies ambiguous historical rules whose source was already lost.
A human can explicitly replace such a rule with fresh instructions; merely
enabling it does not establish new consent.

Dispatch, claim and joined-wakeup handling reuse `channel.AuthorizeConversationTask`
to check the frozen grant against current installation consent, membership and
invocation rights. Joining also requires the same conversation root and execution
principal. A queued ordinary run cannot absorb external instructions or indefinitely
defer the external rule. In-place instruction edits and manual triggers from an
external task cannot modify a rule with a different root. Old joined instructions
are checked again even when another transaction holds the rule lock. Claimed
external descendants receive the external-input trust instructions; an issue
wakeup does not acquire an unsolicited Feishu delivery route.

The Feishu replier now handles `invoke_denied` by sending a generic Chinese
permission notice privately to the denied sender's `open_id`, for both private
and group input. It includes no agent name and creates no binding token. If the
sender is missing or the private send fails, it logs the failure without sending
anything to the group or original thread. Live Feishu reachability remains an
integration check; transport tests cover the HTTP address and failure behavior.

The added regressions cover revoked/replaced grants, removed grantors, lost target
invocation rights, missing roots, ordinary versus same-root joins, stale joins
under contention, source-history deletion, rule management and claim payloads.
Migration tests execute the production runner through upgrade, lost-ledger replay,
and the documented lossy down/up. The managed test database upgraded to **632**
full migration stems; the 631-stem rehearsal below records the original upstream
merge before this correction.

Validation at `a93435936`: `make build` passed; a second `make sqlc` produced no
generated-file changes; `tini -s -- bash scripts/test-go.sh --race --only regular`
passed all regular packages, including handler, service, channel engine, Lark,
migrations and message delivery. It used the same isolated test-child environment
described below. The new service regressions also passed two consecutive runs.
No frontend or agent-package implementation changed in this correction.

## Autopilot boundary and migration scale

`5dd60538a` rejects external conversation tasks and their descendants at the
shared Autopilot write gate, even while the conversation grant is still valid.
It covers creation, updates, deletion, manual runs, triggers, webhook token and
signing-secret changes, collaborators and Autopilot delivery management. The
response is `403 autopilot_external_conversation_forbidden`. Autopilot detail
and list reads advertise no write/access-management permission for these tasks;
detail reads omit webhook tokens, paths and URLs. Exposing an existing webhook
credential would otherwise bypass the write gate. Ordinary members and their
first-party tasks keep the existing originator-based rights. Notification-source
identity resolution remains separate from this Autopilot-specific policy.

This chooses refusal over adding a second persisted conversation-consent model
to Autopilot. The existing consent-aware issue wakeups remain available. In
tests using the real authentication middleware, direct, delegated, retried,
wakeup-created and history-pruned external task lineages all receive refusals.
Read-secret suppression and a first-party authenticated creation control pass.
A negative control against `a93435936` returns HTTP 201 for the same external
creation request where the corrected code returns 403. The new authority tests,
manual wakeup management test and wakeup claim-root invariant pass three
consecutive race runs.

The preceding change prevents new unauthorized automation operations; it cannot
reconstruct the provenance of already-existing Autopilots, which stored only
their human creator. Before production acceptance, an operator must review
existing automations with that creator, disable unconfirmed rules/triggers, and
rotate webhook credentials that may already have been shared externally. Do not
automatically delete or reattribute rules based on timestamp coincidence. No
production records or credentials were inspected or changed in this work.

`88973046f` revises the **unreleased** 564 backfill to materialize only unresolved
parent links. The recursion walks that subset and joins ancestors by task ID,
instead of rescanning all task history at every depth. Ordinary ancestry stays
ordinary; missing ancestors and cycles fail closed; previously stored roots and
lost-ledger replay behavior remain. Neither the two-second lock bound nor the
ten-second statement bound was increased. The migration total remains 632.

The opt-in `TestWakeupConversationMigrationLargeHistory` copies the current task
columns and CHECK constraints into a private schema, adds a primary-key index,
and creates 2,000,000 ordinary rows plus a 32-level external descendant chain.
The tested table and primary-key index occupy 1,568,890,880 bytes. With PostgreSQL
15.19, `fsync=on` and `synchronous_commit=on`, the original 564 at `a93435936`
fails with statement timeout (`57014`) on this fixture; the revised migration
completes in **1.802 seconds**, preserving all 2,000,000 ordinary roots and
marking the external chain and wakeup correctly. Fixture setup is outside the
timing. The table is freshly populated and cache-warm; it does not copy all
production indexes, model every ancestry distribution, or predict production
latency. Validate the actual database shape and resources before rollout.

Reproduce in the managed disposable database:

```bash
set -a
source .env.worktree
set +a
LABRASTRO_TEST_WAKEUP_HISTORY_ROWS=2000000 \
  go -C server test -race ./cmd/migrate \
  -run '^TestWakeupConversationMigrationLargeHistory$' -count=1 -v
```

`722b3ff3b` gives `TestIssueWakeupManagementEndpoints` its own runtime. Its
immediate dispatch no longer competes with unrelated tests for the suite's
shared runtime lock. Production dispatch budgets and assertions remain intact.

Verification also exposed an existing object-intent cleanup bug. PostgreSQL can
place the `UPDATE ... FROM (SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED)` subquery
inside a nested loop, reevaluate it for each target row, and lease several
intents while the caller consumes only one returned row. The existing
`TestCleanupSourceContextObjectIntentsBoundsAttemptsNotSuccesses` failed five
consecutive isolated runs: a batch of two attempted only one object. Commit
`4639d1647` materializes that single-row claim and regenerates sqlc. The unchanged
regression then passed five consecutive race runs. No cleanup budget or test
assertion was relaxed.

Final validation at `4639d1647`: the regular race command completed successfully
for all **71** tested packages (nine executed again, including handler and
service; 62 unchanged results reused Go's test cache). The preceding run had
passed 70 packages and exposed a built-in skill-reference wording violation;
`6395aa357` fixes that wording without changing the contract test. The subsequent
service run exposed the SQL claim bug above. `go vet` passed for handler,
service, migrate and generated queries; `make build` built all three binaries.
The final sqlc regeneration and whitespace check were clean. Frontend and agent
implementation did not change in this round, so their prior verification and
host limitations below still apply.

The completed backend CI job at `e11fce081` failed in
`TestIssueWakeupManagementEndpoints` while its
[agent job passed](https://github.com/AstralSolipsism/multica/actions/runs/36966777551/job/110712188347).
The runtime-isolation change addresses that shared fixture dependency; the
current local regular suite passes. This is not a claim that a new remote CI run
has passed. The new push starts fresh checks, whose result remains on the PR.

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
- `564_wakeup_conversation_root` drops the durable consent reference on wakeup
  rules. Existing task roots remain, but a later re-upgrade cannot reconstruct a
  rule's original consent if its source task has already been deleted. It then
  denies the rule rather than treating it as first-party. Recover with a matching
  database snapshot and binary instead of relying on this down/up sequence.

## Verification commands and limits

Toolchain: Go `1.26.6`, Node `24.21.0`, pnpm `10.28.2`, PostgreSQL `15.19`,
Linux `5.15.0-157-generic`. Go commands used `GOMAXPROCS=4` and `GOFLAGS=-p=4`.
DB-backed tests sourced the managed `.env.worktree`; the tests did not use
real agent accounts or installed agent CLIs.

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

That same prior CI run's backend job failed at
`TestRereviewStaleIssueScanCrossesPassBudget`: it visited 28,400 of the 40,000
nonterminal candidates before its two time-bounded passes ended. The complete
regular suite at `a93435936`, including this test, passed locally. This correction
does not change the scanner or that timing-sensitive test. The latest PR checks
remain authoritative; no external CI run was awaited.

Not run: browser E2E, live Feishu delivery, real agent smoke, native device or
desktop package execution, migrations against production-shaped data or
production search load, production deployment, or release publication.
Unit/component coverage does not substitute
for batch B acceptance. External CI is triggered by the PR and is not awaited.
