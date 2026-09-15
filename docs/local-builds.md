# Local backend archives and application images

Labrastro application images are built on the operator's Docker host from one
reviewed fork SHA. The repository does not publish or select application images
from a registry. PostgreSQL and build/runtime base images remain external
dependencies. The [release contract](../.github/RELEASING.md) owns the candidate
version, source approval, artifact matrix and inactive download layout.

## Development and candidate entries

| Entry | Result | Starts services? |
| --- | --- | --- |
| `make build` | Local Go binaries in `server/bin/`, with a `dev-<sha>[-dirty]` version by default | No |
| `make selfhost` / `make selfhost-build` | Build local backend/Web development images and start the repository example stack | Yes; backend startup runs migrations |
| `make candidate-backend` | Verified Linux amd64 **and** arm64 archives | No |
| `make candidate-images` | Build and verify local backend/Web images for the host architecture | Only disposable version checks, with no network or data mounts |

Candidate tools need Node 22+, Git, Python 3, Go 1.26.6+ (the Go JSON build-info
reader), and tar. Image building needs Docker Engine and its build support;
Compose examples require the Compose CLI plugin. Dockerfile uses Go 1.26.8 and
Node 22; evidence records the actual patch/toolchain. Reproduction also depends
on base images and tool versions, not just source; the scripts do not claim
bit-for-bit reproducibility across toolchains.

Backend archive building/verification runs on Linux and executes the version
entrypoint of every binary on both targets. Install QEMU user emulation for the
other architecture (`qemu-aarch64` / `qemu-aarch64-static` on amd64,
`qemu-x86_64` / `qemu-x86_64-static` on arm64, available in `qemu-user-static`
on Debian/Ubuntu). It is invoked directly from PATH; privileged binfmt
registration is unnecessary. A missing runner fails verification and prevents
the builder from delivering a partially verified archive set.

`make selfhost` creates `.env` only when absent. It uses a development version
for **both** applications, full `COMMIT`, and commit `DATE`; it rejects a pinned
candidate tag or candidate inputs. Clear an old `MULTICA_IMAGE_TAG` for a new
development build. For later direct Compose commands, export the tag printed
at startup (or record it in `.env`). The base Compose fails if the tag is unset,
and missing application images fail without pulling them.

## Prepare a reviewed candidate

Start in an isolated, clean checkout of `AstralSolipsism/multica`. Fetch only
the fork's main/tags and check review/merge approval using the release contract.
Set these values from the approved handoff, never from “latest”:

```bash
export LABRASTRO_RELEASE_REPOSITORY=AstralSolipsism/multica
export LABRASTRO_RELEASE_TAG='<approved vX.Y.Z-labrastro.N>'
export LABRASTRO_RELEASE_SHA='<approved full 40-character SHA>'
export LABRASTRO_RELEASE_MODE=candidate
node scripts/check-release.mjs --require-tag
make candidate-backend
make candidate-images
```

The tag must already exist at that exact SHA and pass the shared sequence guard.
These entries never create tags or acceptance history. Historical rebuilds need
the separately reviewed acceptance record specified by the release contract;
do not infer approval from a historical tag. OL-84 owns the new project tag.

The backend builder reuses OL-31 r2's command set and tar layout. It builds in a
fresh detached worktree of the actual commit so ignored Go files, local config
and old binaries cannot enter the build. The image builder uses `git archive`
of the same SHA, excluding ignored `.env`, `node_modules` and `.next` output.
Both derive version/SHA/date from the common preflight; arbitrary Make or shell
version overrides do not become candidate build arguments.

## Backend outputs and independent verification

Under `dist/candidate/<tag>/assets/`:

```text
labrastro-backend-<version>-linux-amd64.tar.gz
labrastro-backend-<version>-linux-arm64.tar.gz
backend-build.json
```

Every archive contains `server`, `multica`, `migrate`,
`backfill_task_usage_hourly`, `backfill_codex_usage_cache`, the complete tracked
`migrations/` directory, LICENSE, NOTICE, `build-info.json`, `checksums.txt` and
`expected-migrations.txt` (all complete up filenames, sorted; duplicate numeric
prefixes are valid). The metadata includes version, full source SHA, source
date, target, actual Go toolchain and build time. `checksums.txt` covers every
other file inside the archive.

```bash
python3 scripts/build-backend.py --verify
```

This separate invocation reads the archives again, checks the exact required
file set and SHA-256 values, compares migrations/notices with tracked source,
and reads each executable with `go version -m -json`. Wrong binary, architecture,
CGO setting, VCS SHA, dirty provenance or toolchain fails. CLI, server, migrator
and both backfills must also report the expected version and full SHA, on both
architectures, without a database. Cross-target version checks run under QEMU;
`binary_versions: passed` and `version_execution` record this separately from
`native_version: not_run_cross_target`. Emulated version checks do not claim
native installation or service smoke success. Correct VCS metadata and rehashed
checksums cannot conceal an executable built with a different embedded identity.

For an already extracted and trusted archive, operators can also run:

```bash
sha256sum -c checksums.txt
./multica version --output json
./server --version
./migrate --version
./backfill_task_usage_hourly --version
./backfill_codex_usage_cache --version
go version -m ./server ./multica ./migrate ./backfill_task_usage_hourly ./backfill_codex_usage_cache
```

`backend-build.json` is a **component inventory**, containing archive names,
download paths, sizes, hashes, timings and checks. OL-83 collects it into the
global `assets/manifest.json`, `checksums.txt` and `release-validation.json`,
including `backend-build.json` itself as evidence. This component build does
not claim the full CLI/Desktop/Web candidate matrix is complete. An incomplete
target/file fails before archives are copied to assets. Existing outputs are
not overwritten: use `--verify` or a separate clean checkout.

## Image checks and evidence

```bash
# Explicit target; the Docker host must be able to run it for verification.
make candidate-images ARGS='--arch amd64'
# Separate verification, with no rebuild or application startup:
node scripts/local-images.mjs --arch amd64 --verify
```

Images are `labrastro-backend:<tag>` and `labrastro-web:<tag>`. The tool checks
full Image ID, architecture and OCI version/revision/source/date labels. It
runs checks by immutable ID using `--pull=never --network=none --read-only` and
an explicit entrypoint, so the backend's migration entrypoint never executes.
It verifies the actual version and full SHA of all five backend programs,
including both backfills built from the Git-free source snapshot, file checksums and
source migration/notices, plus Web build metadata and the version embedded in
compiled client JavaScript. A new label wrapped around any stale binary fails.

`dist/candidate/<tag>/local-images/linux-<arch>/images.json` records these results,
full local IDs, versions, toolchains and build/verification times. `images.env`
contains public build identity and `MULTICA_IMAGE_TAG` only. Empty RepoDigests
are expected for local builds; a registry digest is not required. Archive this
evidence with the operations handoff. No successful evidence is written on a
failed check; the command exits nonzero. Existing candidate image tags are not
overwritten. For a deliberate rebuild, use a separate local Docker context;
`--no-cache` is available there. Verify each architecture in its own host/context
and collect both evidence files rather than replacing one local tag repeatedly.

## Use the existing custom Compose

The repository stack is a development example. Keep the actual networks,
volumes, config files, reverse proxy, API/inbound, scheduler, recovery/delivery
and daemon responsibilities in the operator-owned Compose. Adapt only service
keys in [the image override](../deploy/compose.local-images.yml) as necessary.

```bash
set -a
. ./dist/candidate/<tag>/local-images/linux-amd64/images.env
set +a
docker compose --env-file /operator/config.env \
  -f /operator/compose.yml -f ./deploy/compose.local-images.yml config
```

Compare the rendered config with the current one: only backend/frontend image
selection and pull policy should change. This is a render operation; do not put
its secret-bearing output into public logs. During Master's separate deployment
window, use that same Compose pair with `up -d --no-build --pull never` and the
actual selected services, following the operator's stop-write/backup/migration
plan. Do not use `make selfhost` to deploy a candidate to an existing stack.

## CLI seeds and the OL-31 heavy-cache regression

OL-31's heavy image once built successfully while retaining an old CLI. Before
any later agent/heavy rebuild, the operator must:

1. Extract the matching architecture's `multica` into a **new staging directory**.
   Verify archive checksums, `go version -m`, CLI version/full SHA and binary
   SHA-256. Do not replace the active seed as part of candidate preparation.
2. Inspect each actual Dockerfile's `COPY` source and build context. Record the
   SHA-256 of the exact seed path that Docker will copy, including heavy and any
   alternate agent contexts. The staging and selected seed hashes must match.
3. In the authorized window, back up and replace the seed, rebuild every consumer;
   always use `--no-cache` for heavy. Record each resulting full local Image ID.
4. Run `multica version --output json` and SHA-256 **inside each resulting image**
   with its real binary path and an overridden entrypoint. Require the staged
   version, full SHA and binary hash. Neither build exit status nor an OCI label
   alone passes this check. After deployment, repeat in every running container
   and compare the container's immutable `.Image` ID with the recorded image ID.

The [Docker cache rules](https://docs.docker.com/build/cache/invalidation/)
explain why cache reuse is not a version check. The
[Compose pull policy](https://docs.docker.com/reference/compose-file/services/#pull_policy)
keeps application image selection local. Helm publishing remains disabled;
source templates have unconfigured local names and `Never` pull policy, and are
not an operational Kubernetes rollout path for this project.
