# Release runbook

## Labrastro deployment

Build Labrastro application images locally from the reviewed, tagged source
commit. Do not publish them to GHCR or pull application images from an external
registry. A container registry is not a deployment prerequisite; provisioning one
requires a separate decision.

The operations specialist agent owns operational access, the current component
and database inventory, and the existing local build procedure. Prepare and
verify the candidate without replacing running containers. Master schedules the
actual deployment, database migration and active update-feed switch separately.

Fork image-build jobs are gated to the canonical upstream owner. Their dependent
manifest jobs are consequently skipped on forks. CLI, Desktop and chart
publishing are also gated to upstream. Do not remove these guards to make a
Labrastro tag behave like an upstream release.

## Canonical upstream release

For `multica-ai/multica`, release from a reviewed commit on `main` by creating and pushing a new semantic
version tag such as `v0.18.4`. The Release workflow intentionally has no manual
trigger: a tag push is the only event that can publish binaries, Homebrew
formulae, and container images.

The verification job runs the Go tests and `govulncheck` before any publishing
job starts. The vulnerability scan is fail-closed by default.

## Emergency vulnerability-scan bypass

Use the bypass only when `govulncheck` itself or its live vulnerability database
is unavailable, or when maintainers have documented a confirmed false positive
that blocks an urgent release. Never use it to publish a release with an
unresolved reachable vulnerability.

1. Record the reason and maintainer approval in the release issue or pull
   request, and confirm no other release is in progress.
2. In **Settings → Secrets and variables → Actions → Variables**, set the
   repository variable `ALLOW_VULN_BYPASS_FOR_TAG` to the exact release tag,
   for example `v0.18.4`.
3. Re-run the failed Release workflow for that tag. A different tag, an empty
   value, or any typo keeps the scan enabled.
4. Confirm the verification log contains the explicit bypass warning and retain
   the workflow URL in the incident record.
5. Delete `ALLOW_VULN_BYPASS_FOR_TAG` immediately after the release run
   completes. The tag-scoped value prevents a concurrent release with another
   tag from inheriting the bypass.

Every Go binary retains its compiler version in the standard Go build metadata;
use `go version -m <binary>` when auditing a downloaded release artifact.
