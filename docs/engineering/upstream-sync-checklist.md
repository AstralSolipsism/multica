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
