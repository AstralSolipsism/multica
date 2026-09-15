# Labrastro release contract

## Scope and current gate

All project repository reads, fetches, pushes, PRs, tags and Release operations
must explicitly target `AstralSolipsism/multica`. Never let a tool infer the fork's
upstream as its target. Historical module paths and copyright attribution are
not publishing destinations; retain LICENSE and NOTICE.

`release.yml` now contains verification only, with `contents: read`, an exact
repository guard and explicit checkout repository. It has no publishing jobs,
registry credentials, image export, Helm push or Desktop `--publish always`.
`.goreleaser.yml` retains local CLI packaging, pins its GitHub destination to the
fork, removes Homebrew entirely and sets `release.disable: true`. Merely changing
an owner condition or re-enabling the workflow cannot restore the old graph.
[GoReleaser's release configuration](https://goreleaser.com/customization/publish/scm/)
distinguishes disabling the Release pipe from merely keeping a release draft.

The GitHub workflow setting was verified as `disabled_manually` on 2026-09-14;
this change does not enable it. OL-83 owns complete candidate assembly and its
review; OL-84 owns the later authorized tag/build/draft handoff. Go tests and
vulnerability scanning remain in normal CI, alongside the new `release-contract`
guard tests (which run even while Release is disabled). The full candidate workflow must
restore those gates before any draft upload; the foundation check alone is
never evidence that a candidate passed product tests. Do not use the old
`ALLOW_VULN_BYPASS_FOR_TAG` variable: no bypass is wired into this foundation.

PR [#42](https://github.com/AstralSolipsism/multica/pull/42), inspected at
`cb4bf5cbfe11960bd8ab36edda22bc2c542f9214`, remains an unmerged historical patch.
This change preserves its local-source image policy, operations ownership and
separate deployment window. It **replaces** its upstream-owner job guards and
upstream release instructions by removing the old publishing jobs altogether.
The withdrawn GHCR lowercase-owner repair is not retained. Do not merge #42's
workflow over this replacement or restart OL-31 to implement it.

## Source, tag and application version

The candidate identity is `(repository, full commit SHA, tag, version)`:

- Source is one reviewed commit contained in the freshly fetched fork `main`.
  Supply its full 40-character lowercase SHA explicitly; never substitute a
  moving branch or automatically decide that the current checkout is reviewed.
- Tag is exactly `vX.Y.Z-labrastro.N`. `X.Y.Z` matches
  `apps/web/package.json`; `N` is positive. No leading zeros, build suffix,
  `dirty`, `git describe` suffix, plain upstream tag or `0.0.0` base is allowed.
- Application version is the tag without `v`, e.g.
  `v0.4.43-labrastro.2` becomes `0.4.43-labrastro.2`. Use it in CLI/server
  ldflags, Web `NEXT_PUBLIC_APP_VERSION`, Desktop extraMetadata and filenames.
  Tags and download version directories retain `v`. Readers may still encounter
  old binaries reporting a leading `v`; that is input compatibility, not a new
  version sequence.
- For a new candidate on the same base, increment the greatest existing `N` by
  one. On a greater base, start at `1`. Compare components numerically (`.10`
  follows `.9`); never decrement the base. The default `candidate` mode applies
  these global constraints both before and after tagging, excluding only the
  candidate's own tag from comparison. A Labrastro suffix denotes our
  internal sequence even though SemVer calls it a prerelease. Update comparison
  support belongs to OL-80; do not strip arbitrary suffixes to treat dev as a
  release.
- An existing tag must still resolve to exactly that SHA, including annotated
  tags. One source SHA has one Labrastro tag. Never move a tag or reuse an old
  version for changed source. Rebuilding the same identity for verification is
  allowed; overwriting already delivered artifacts is not implicitly allowed.
  Historical verification requires explicit `rebuild` mode and an independently
  reviewed acceptance record on fetched fork `main`, as described below. Source
  ancestry, tag existence and tagger/commit dates cannot establish acceptance:
  a tag newly created on old source must not receive an automatic exemption.
- A proposal may be checked before tagging. It is not a reservation or a release:
  re-fetch the fork's tags and rerun the check before the separately authorized
  tag creation. Candidate packaging and draft delivery require `--require-tag`.

`v0.4.43-labrastro.1` / `9176fda8cd10b79a805702bdb3356e3ab259a94b` is historical.
Master confirmed its production deployment and feed activation in OL-31 on
2026-09-13. Its draft Release status does not mean production is still waiting.
The next candidate must include OL-72 through OL-78 (already in planning baseline
`530ae0385e1aa54d17c13207a275ba416997c104`) and all subsequently reviewed release
changes. The final SHA/tag is chosen by OL-84, not by this foundation PR.

## Executable preflight and build inputs

`node scripts/check-release.mjs` uses Node 22+ and Git only. It reuses the Desktop
version normalizer; existing `make build`, `deriveVersion`, `bundle-cli.mjs` and
development fallback behavior remain available. The script reads local Git data
only. It validates the explicit repository and GitHub context, origin fetch and
push URLs, complete history, clean tracked/staged/untracked source, exact HEAD,
main ancestry, tag/base/version agreement, tag immutability and revision order.
Ignored build output is allowed. Use an isolated checkout with no local source
or environment overrides; clean Git state cannot prove ignored inputs or human
review. Fetch freshness and review approval are the caller's responsibility.

From the repository root, first fetch **only the fork**, without forced tag
replacement (a tag conflict is a stop condition):

```bash
git fetch --no-recurse-submodules https://github.com/AstralSolipsism/multica \
  '+refs/heads/main:refs/remotes/origin/main' 'refs/tags/*:refs/tags/*'
```

For **proposal validation**, supply `reviewed_sha` and `reviewed_tag` from the
reviewed candidate record. The full SHA must already be contained in the fetched
fork `main` and include `scripts/check-release.mjs` and its Desktop import; this
requires the release changes to be reviewed and merged first. The planning
baseline `530ae038…` predates the validator and cannot run this entry.
Use an isolated, clean checkout whose origin points only to the fork. The
proposed tag must be unused and the next revision among all fetched candidate
tags (or `.1` for a greater source base). Then run from the repository root:

```bash
set -eu
: "${reviewed_sha:?Set the reviewed full SHA containing the validator on fork main}"
: "${reviewed_tag:?Set the reviewed unused vX.Y.Z-labrastro.N proposal}"
git checkout --detach "$reviewed_sha"
node scripts/check-release.mjs --repository AstralSolipsism/multica \
  --sha "$reviewed_sha" --tag "$reviewed_tag"
```

This creates no tag and never chooses a SHA for you. For example, if that
reviewed commit has package version `0.4.43`, `.1` is the greatest fetched
revision and the proposed tag is `v0.4.43-labrastro.2`, JSON reports
`version: "0.4.43-labrastro.2"`, `commit` equal to `reviewed_sha`,
`tag_exists: false` and `artifact_dir: "dist/candidate/v0.4.43-labrastro.2"`.
A dirty checkout, different HEAD, non-target origin or missing required tag
exits nonzero and emits no metadata on stdout. After a tag is created,
`--require-tag` still rejects skipped revisions and base rollback.

The three required values also have environment equivalents. After the final
tag exists, component build scripts use this common entry before compiling:

```bash
set -eu
# Set these three from the reviewed candidate record, not from git describe.
export LABRASTRO_RELEASE_REPOSITORY=AstralSolipsism/multica
export LABRASTRO_RELEASE_TAG="$reviewed_tag"
export LABRASTRO_RELEASE_SHA="$reviewed_sha"
export LABRASTRO_RELEASE_MODE=candidate
mkdir -p dist
node scripts/check-release.mjs --require-tag > dist/candidate.json
node scripts/check-release.mjs --require-tag --format env > dist/candidate.env
# Import only after the command succeeded; these values are validated tokens.
set -a
. dist/candidate.env
set +a
```

Shell scripts must use `set -e` (or explicitly check exit status), and callers in
other languages must fail on a nonzero subprocess result. JSON exports
`repository`, `tag`, `version`, `commit`, `date`, `source_date_epoch`,
`tag_exists`, `tag_object`, `mode`, `artifact_dir`. `tag_object` is the exact Git
tag ref object ID (the annotated tag object, or commit for a lightweight tag),
and is `null` for an untagged proposal. Env output exports the three inputs plus
`LABRASTRO_RELEASE_MODE`, `VERSION`,
`COMMIT`, `DATE`, `NEXT_PUBLIC_APP_VERSION`, `SOURCE_DATE_EPOCH`, and
`LABRASTRO_ARTIFACT_DIR`. `DATE`/epoch use source commit time; record actual build
time and tool versions separately. Flags that disagree with candidate env fail.
Optional `--version` checks the actual version selected by a builder.
`--mode` / `LABRASTRO_RELEASE_MODE` accepts only `candidate` (default) or
`rebuild`; conflicting flag and environment values fail.

### Historical verification with an acceptance record

While a tagged candidate still satisfies the global sequence, preserve the
successful `candidate.json` from `--require-tag --mode candidate` as
`.github/release-history/<tag>.json` in a separate reviewed commit on fork
`main`, before advancing the candidate sequence. The acceptance record reuses
the preflight JSON. It must contain the exact `repository`,
`tag`, `version`, `commit`, `tag_object`, `tag_exists: true` and
`mode: "candidate"`. Keep the archived successful check with the review evidence;
reviewers must verify acceptance before approving this record. A proposal's
output or another rebuild's output cannot authorize historical verification.
Do not infer or backfill acceptance just from an existing tag or its dates.

The checker reads this fixed path from `refs/remotes/origin/main`, not HEAD,
a local file or an arbitrary caller-supplied record. Authentic, freshly fetched
fork refs and review of main-branch changes are the trust boundary, as for source
approval. Missing/malformed records, changed identity or a replaced annotated
tag object fail closed. The preflight reads acceptance records without writing
them. OL-83/84 own preserving and submitting successful candidate evidence during
handoff. An acceptance record establishes previously accepted identity; the
product build, artifact delivery and operations gates below still apply.

On the clean historical source checkout, set the same explicit repository,
reviewed tag and SHA inputs, fetch fork main/tags as above, then run:

```bash
set -eu
export LABRASTRO_RELEASE_MODE=rebuild
mkdir -p dist
node scripts/check-release.mjs --require-tag > dist/rebuild.json
node scripts/check-release.mjs --require-tag --format env > dist/rebuild.env
```

This example requires the historical source to contain this guarded entry.
For older source, invoke the reviewed current checker by absolute path from a
separate tool checkout, keeping the working directory at the historical SHA.
Build consumers must use the reviewed guard, not an older packaging entry that
lacks it. The same `rebuild` environment is read by GoReleaser's before-hook;
tag-push workflow validation is explicitly pinned to `candidate` mode. A later
version may coexist with an approved historical rebuild, while an unrecorded
retroactive tag remains rejected in both modes. All other source, repository,
version, clean-tree and tag-identity checks still apply to rebuilds.

| Existing entry | Required candidate inputs / output | Integration owner |
| --- | --- | --- |
| GoReleaser, repo root | Export the three inputs; `goreleaser release --clean --skip=publish`. The before-hook requires the tag and checks GoReleaser's selected tag/version against them. CLI archives land in `dist/goreleaser/`. No Homebrew or Release write. Snapshot versions fail this candidate entry; use normal source builds for dev. | OL-79 guard; OL-83 collection |
| `make build` / direct Go build | Run preflight first, then `make build VERSION="$VERSION" COMMIT="$COMMIT" DATE="$DATE"`. `GOOS` and `GOARCH` select the binary target; `CGO_ENABLED=0` for distributed CLI. All distributed Go binaries retain full source SHA and Go build metadata. | OL-82 |
| Web standalone | Preflight, then `STANDALONE=true NEXT_PUBLIC_APP_VERSION="$VERSION" pnpm --filter @multica/web build`. Include standalone output, `.next/static`, public assets, LICENSE/NOTICE and source/build evidence. Do not reuse a cached build from another version. | OL-81 |
| Desktop `apps/desktop/scripts/package.mjs` | Preflight before cleanup/build, pass normalized version to `extraMetadata.version`; pass the same full SHA/version/date to `bundle-cli.mjs`. Invoke through `pnpm -C apps/desktop package -- --linux AppImage --win --x64 --arm64 --publish never`. Generic internal feed stays configured. | OL-81 |
| Local `Dockerfile` / `Dockerfile.web` | Preflight on host source, backend args `VERSION`, `COMMIT`, `DATE`; Web arg `NEXT_PUBLIC_APP_VERSION`. Local image names `labrastro-backend:$LABRASTRO_RELEASE_TAG` and `labrastro-web:$LABRASTRO_RELEASE_TAG`; record full revision/version OCI labels and local Image IDs. Use local build/load, never push. | OL-82 |

The table is the interface for successor work. Backend archives now use
`make candidate-backend`; local application images use `make candidate-images`.
Both invoke the common tagged preflight and verify produced bytes; see
[local build instructions](../docs/local-builds.md). Plain development commands
are not verified candidates. Web/Desktop integration and full artifact
aggregation remain with their respective successor tasks.
Do not turn a missing bundled CLI, missing toolchain or skipped build into success.

## Artifact directory and inventory

Use `dist/candidate/<tag>/` as the isolated handoff root (`C` below). Build tools
keep their current scratch directories. Collect and verify their finished files
before another Desktop package invocation cleans `apps/desktop/dist`.

```text
C/assets/manifest.json               # flat draft assets and their inventory
C/assets/checksums.txt               # SHA-256 of every other flat asset
C/assets/cli-checksums.txt           # CLI archives only, mapped below
C/assets/release-validation.json     # actual build/test results and omissions
C/assets/<archive, installer, blockmap, channel YAML, evidence files>
C/downloads/cli/<tag>/...             # inactive version directories
C/downloads/desktop/<tag>/...
C/downloads/releases/<tag>/...
C/activation/latest.json             # proposed pointer, never a live write
C/activation/desktop/*.yml            # proposed root feeds with <tag>/ URLs
```

Preserve the OL-31 r2 `manifest.json` / `assemble-downloads.py` semantics:
`artifacts[].name` locates a flat draft asset, `download_path` locates it beneath
`C/downloads`. The r2 assembler needs no new framework; adapt only its input/output
parameters and verification where needed. Do not reuse its fixed old SHA/tag or
claims of validation. r3 operations scripts remain operational handoff material,
not proof of a newly built candidate.

| Kind | Required platforms / architecture | Flat filename | Download path |
| --- | --- | --- | --- |
| CLI | `darwin`, `linux`, `windows` × `amd64`, `arm64` | `multica-cli-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows); keep legacy `multica_<os>_<arch>.<ext>` alongside | `cli/<tag>/<name>` |
| Backend | `linux` × `amd64`, `arm64` | `labrastro-backend-<version>-linux-<arch>.tar.gz` | `releases/<tag>/<name>` |
| Web | `linux/amd64` | `labrastro-web-<version>-linux-amd64-node-standalone.tar.gz` | `releases/<tag>/<name>` |
| Desktop | `linux`, `windows` × `x64`, `arm64` in electron-builder | `labrastro-desktop-<version>-linux-{x86_64,arm64}.AppImage`; `labrastro-desktop-<version>-windows-{x64,arm64}.exe`; generated blockmaps and YAML | `desktop/<tag>/<name>` |
| Feed handoff | all built Desktop targets + CLI pointer | `labrastro-feed-metadata-<version>.tar.gz`, containing `activation/` | `releases/<tag>/<name>` |

Manifest platform/arch use Go spelling (`darwin/linux/windows`, `amd64/arm64`).
`x64` and Linux AppImage `x86_64` both map to `amd64`; builder platform `mac`
maps to `darwin`, `win` to `windows`. Preserve electron-builder's emitted names
and verify them against its metadata; do not rename archives independently of
feed references. The existing Mac path is optional in this first matrix:
`labrastro-desktop-<version>-mac-{x64,arm64}.{dmg,zip}`, plus generated blockmaps
and Mac feeds. Signing/notarization and native installation status must be
recorded separately; Linux/Windows packaging is not Mac validation.

CLI archives retain the executable name `multica` / `multica.exe` at archive
root, LICENSE and NOTICE; GoReleaser also includes README. Both CLI naming schemes
must describe the same target/version. Backend archives contain `server`,
`multica`, `migrate`, existing required backfill tools, complete `migrations/`,
LICENSE and NOTICE. Web/Desktop must preserve Labrastro branding and notices.

Keep existing manifest identity fields `tag`, `version`, `commit`, `prepared_at`,
`release_state: "draft"`, `release_url` (fork only), `internal_upload_complete`,
`production_inventory_complete`, `deployment_performed`, `images` and `artifacts`.
Do not set operational completion flags from a successful build. Retain image
`build_method: "local_from_source"`, `registry_required: false`, explicit status
and actual local Image IDs when available; do not require a registry digest.
Add `repository: "AstralSolipsism/multica"` and identify each artifact's
`component`, `os`, `arch` (omit os/arch for shared metadata). Each artifact has:

```text
name          = multica-cli-<version>-linux-amd64.tar.gz
path          = assets/<name>                 (relative to C)
download_path = cli/<tag>/<name>              (relative to C/downloads)
bytes         = actual positive file length
sha256        = actual 64 lowercase hex digits
component     = cli
os            = linux
arch          = amd64
```

Paths must be relative, normalized and unique, with no traversal, symlinks or
absolute URLs; flat names must be unique. Record actual file sizes and hashes,
never placeholders. Inventory lists every deliverable except `manifest.json`
and the global `checksums.txt` to avoid self-hash cycles. Global checksums include
`manifest.json`, CLI checksums and all other flat files, using standard
`<sha256>  <basename>` lines; verify with `sha256sum -c checksums.txt`.
`cli-checksums.txt` lists both CLI archive naming schemes by basename and maps to
`cli/<tag>/checksums.txt`. Manifest and global checksums themselves map to
`releases/<tag>/`. Do not overwrite the CLI checksum list with global checksums.

`release-validation.json` records this identity, tool versions, actual start/end
times, required target matrix, per-target build and validation results, and
explicit failed/skipped/missing items. Keep native smoke, signature/notarization
and feed checks distinct. A complete candidate requires every mandatory target
and required file, no version/SHA/architecture mismatch and verified hashes/feed
references. No skipped or absent required job may be counted as success. OL-83
owns executable aggregation and missing-file/failure checks.

## Inactive feed contract and deployment boundary

Installed clients retain `https://multica.outlune.com/downloads` and its existing
redirect to `https://dl.outlune.com/downloads` (the `/downloads/` prefix matters).
Desktop's generic provider remains `/downloads/desktop`. No upstream release API
or GitHub latest endpoint selects an internal version.

`activation/latest.json` is `{"version":"vX.Y.Z-labrastro.N"}`. Versioned Desktop
YAML has normalized `version`, actual `files[].size`, base64 SHA-512 and matching
`path`/`files[].url`. The inactive version directory uses bare installer names;
proposed root feeds in `activation/desktop/` prefix both paths with `<tag>/`.
Verify every reference against bytes in the version directory, including
blockmaps, before upload and again over HTTP before activation.

| Desktop target | Labrastro/generated channel to preserve | Compatibility root feed |
| --- | --- | --- |
| Windows x64 | `labrastro.yml` | `latest.yml` |
| Windows arm64 | `latest-arm64.yml` (explicit runtime channel) | same |
| Linux x64 | `labrastro-linux.yml` | `latest-linux.yml` |
| Linux arm64 | `labrastro-linux-arm64.yml` | `latest-linux-arm64.yml` |
| macOS arm64, optional | `labrastro-mac.yml` | `latest-mac.yml` |
| macOS x64, optional | `latest-x64-mac.yml` (explicit runtime channel) | same |

Preserve any additional generated channel files and verify with the actual
installed electron-updater provider, as OL-31's `stage-desktop.cjs` does. Never
share a feed filename across incompatible architectures. Missing optional Mac
output must not replace the currently working Mac feed with an empty file.

Local validation/build, fork Draft Release handoff, immutable internal version
upload, production deployment, and live feed activation are separate actions.
A future draft writer must explicitly use `--repo AstralSolipsism/multica`, the
reviewed full target SHA and `--draft`; it must not publish the draft or select
it as latest. Validate the complete asset set before advertising readiness.
Writing `C/activation/` or attaching its archive authorizes no live pointer change.

Application images are built locally from that same reviewed source; do not
publish to GHCR or pull upstream application images. The operations specialist
owns real access, inventory, local Image ID and version checks, the existing
custom Compose and CLI seed verification (including the OL-31 heavy-image stale
CLI cache failure). Master schedules service changes, migrations, client
upgrades and atomic active-feed switches separately. A repository Compose
example must not replace the production configuration. Keep previous versions
and deployment evidence; failure recovery must not silently combine artifacts
from different builds or reconnect old application code to a new schema.
