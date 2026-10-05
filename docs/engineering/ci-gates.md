# CI gates

The `CI` workflow keeps `frontend` and `backend` as its scope aggregates.
`scripts/ci-scope.mjs` validates the path decision and every dependency result:
selected jobs must succeed and only unselected jobs may be skipped. Daily and
manual runs select all scopes. Branch protection must require **`CI required`**:
it always runs and requires both aggregates to succeed, rejecting failed,
cancelled, skipped or missing results. The release workflow also has a `backend`
job, so its skipped packaging result must not be mistaken for the CI gate.

## Go formatting

`backend-format` runs on the backend scope and feeds `backend`. It executes
`bash scripts/check-gofmt.sh`, which fails on any output from `gofmt -l server/`
or any formatter error. `bash scripts/check-gofmt.test.sh` proves that an
unformatted file fails, formatting it passes, and invalid Go fails. Run the same
commands locally with the CI Go 1.26 toolchain.

## Retained product E2E

`retained-e2e-tests` feeds `frontend`, including when only backend/migrations or
E2E files changed. The scope covers Web/Desktop/shared code, backend, fixtures,
the dedicated configuration/runner and dependency inputs. Documentation-only
changes do not allocate the browser runner.

The job installs locked dependencies and Chromium, then runs:

```bash
bash scripts/test-retained-e2e.sh
```

The script builds the actual Go server and production Web app, applies all
migrations to the job's disposable PostgreSQL 17 service, and runs exactly
`onboarding-smoke.spec.ts` and `dag-task-lines.spec.ts`. It uses local test
credentials, API `127.0.0.1:18080`, Web `127.0.0.1:13000` and database
`labrastro_e2e` on `127.0.0.1:15432`. It overwrites inherited application/database
URLs and disables email delivery and telemetry; no production secret is needed.
No daemon/agent process, production account or production database participates.

Use a disposable checkout without root `.env`/`.env.worktree` or Web dotenv
overrides. The runner rejects those files before building or migrating.
Playwright owns both service processes, refuses to reuse an existing server,
waits for readiness and stops the processes on completion. Tests run with one
worker, no retries and `forbidOnly`; existing product assertions remain intact.
The artifact `retained-e2e-<run_id>-<run_attempt>` retains setup/build logs, the
HTML report, screenshots and failure traces for seven days. Server output also
appears in the job log.

For local reproduction, first provision a **new disposable** PostgreSQL service
with the same database, user/password `labrastro_e2e` and loopback port 15432.
For example, on a host with Docker, from that disposable checkout:

```bash
docker run --rm --detach --name labrastro-retained-e2e-db \
  -e POSTGRES_DB=labrastro_e2e -e POSTGRES_USER=labrastro_e2e \
  -e POSTGRES_PASSWORD=labrastro_e2e -p 127.0.0.1:15432:5432 \
  pgvector/pgvector:pg17
trap 'docker stop labrastro-retained-e2e-db' EXIT
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
bash scripts/test-retained-e2e.sh
```

Do not point this recipe at a shared database or tunnel production to the test
port. Existing developer checkouts should continue using their managed
`make up`/`make down` environment and ordinary `playwright.config.ts`.

If the hosted job cannot run, record its actual failed step and logs. The
temporary release gate is this same full command on a disposable supported
Linux host against the exact reviewed candidate SHA, with all eight current
tests passing and the report attached to the release handoff. Missing browser,
database, build or test evidence blocks release; a skip, unit-only result or
an existing-account smoke test does not satisfy this gate.

## Main branch protection

A repository administrator must configure `main` to require a pull request and
the successful **`CI required`** check from GitHub Actions, with branches
up to date before merge. Enforce the rule for administrators and bypass-capable
roles as well; leave no direct-push/bypass allowance, force pushes or deletions.
Preserve any stronger existing requirements. Dismiss stale review approvals
when new commits arrive and require conversation resolution. The workspace's
two sequential expert reviews for high-risk changes are still required; they
must both name the final head SHA in the issue even if the agents share one
GitHub identity. GitHub approval count alone cannot express that workflow.

After saving the rule, verify in GitHub that an ordinary direct update to main
is disallowed and a PR with a failed/missing required aggregate cannot merge;
use the rule UI/API, not a destructive test push. Token access to repository
content does not establish access to branch administration. When the current
token is denied, put these exact settings in the PR and ask Master to configure
them without changing identities.

See [GitHub's branch protection reference](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
and [Playwright's service lifecycle](https://playwright.dev/docs/test-webserver).
