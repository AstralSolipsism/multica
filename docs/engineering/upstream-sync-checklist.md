# Upstream sync checklist

Complete this checklist in the sync PR against explicit fork-base, upstream
and resulting head SHAs. The [retained product decisions](upstream-sync-20260926.md)
and [conversation authorization boundary](upstream-sync-20261002.md) remain
acceptance criteria. A clean merge or a passing route inventory is insufficient.

## Handler semantics

- [ ] Enumerate every write route in
  `server/internal/middleware/labrastro_conversation_policy.go`. Follow each
  method/pattern through `server/cmd/server/router.go` to its handler, service,
  queries and asynchronous dispatch paths. Include unchanged routes explicitly;
  `POST /api/issues/query` is a read operation but still needs a semantics check.
- [ ] For **each** route, record the old/new request fields, defaults, validation,
  accepted actor/workspace identifiers and resulting side effects. Check issue
  assignment/promotion, comment mentions and edits, child creation, dependency
  updates, file writes and any new scheduling/configuration behavior. Existing
  URLs with new fields can expand authority without changing the inventory.
- [ ] Verify execution still uses the frozen grantor and persisted conversation
  ancestry, including descendants, retries, wakeups and delayed dispatch. Live
  grant revocation, workspace/ownership/invocation checks and denial on missing
  evidence must still hold. The runtime owner is not a replacement principal.
- [ ] Review new routes/methods as denied by default; add targeted authorization
  regressions for changed semantics before accepting any allowlist change.
  Run the real-router inventory and affected handler/dispatch regressions.

Use one row per existing write route in the PR, not a single blanket approval:

| Method / route | Handler and changed dependencies | Request/default changes | Side effects / authority | Regression evidence and review |
| --- | --- | --- | --- | --- |
| Every allowlisted write, including unchanged ones | Before/after locations | Fields or explicit no change | Writes, dispatch and principal | Test command/result and reviewer |

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
  `9009_labrastro_wakeup_conversation_provenance.up.sql` and
  `capture_issue_wakeup`. Run from `server/`:
  `go test ./internal/migrations -run '^TestLabrastroWakeupCaptureMigrationInventory$' -count=1`.
- [ ] If that inventory fails after an upstream replacement, add a **new fork
  migration** that reapplies conversation provenance to the updated function.
  Do not merely update the expected filenames. Verify both a fresh install
  (new upstream migration before the fork migrations) and an upgrade from a DB
  that already ran 9009 (new upstream replacement after 9009, then the new fork
  migration). Both orders must preserve source-task/grantor ancestry. Record
  the tested starting schemas, migration order and final behavior before
  updating the inventory expectation.

## Product and delivery gates

- [ ] Preserve the [branding overlay and guard contract](branding.md). Do not
  relax source/resource guards or expand exceptions to accept restored upstream
  product branding. Run `pnpm test:brand` and, from `server/`,
  `go test ./internal/branding` alongside the affected platform checks.
- [ ] Keep absence assertions for marketing/onboarding surfaces. Keep DAG
  stage order, real edges, independent expansion and detail-return viewport
  restoration. Shared Web/Desktop wiring still needs review; Chromium Web
  evidence alone does not establish Desktop packaging or installation behavior.
- [ ] Run `bash scripts/check-gofmt.sh` and the
  [isolated retained E2E gate](ci-gates.md), including both
  `e2e/onboarding-smoke.spec.ts` and `e2e/dag-task-lines.spec.ts`. Record the exact
  head SHA, run URL, test outcomes and report artifact. A skipped, failed or
  missing selected job is not a pass; never substitute a production smoke run.
- [ ] Require `CI required` (both validated aggregates) on the final PR head, with the branch
  protection settings in [CI gates](ci-gates.md#main-branch-protection).
  Follow the workspace review rule, including two sequential expert approvals
  for CI/release changes. Leave merge to the reviewer; migration/deployment,
  release publication and live feed activation remain separately authorized.
