#!/usr/bin/env node
// Web standalone candidate build: compiles the Labrastro Web app with the
// reviewed candidate version baked in, assembles the runnable Node
// standalone tree, and stages it into the candidate handoff root
// (`dist/candidate/<tag>/`) for the aggregation pipeline.
//
// Contract (.github/RELEASING.md):
//   - Inputs come from the shared preflight: LABRASTRO_RELEASE_REPOSITORY /
//     _TAG / _SHA (or the --repository/--tag/--sha equivalents), validated by
//     scripts/check-release.mjs --require-tag. There is no "build whatever is
//     checked out" mode here; development builds keep using `pnpm dev` /
//     plain `pnpm --filter @multica/web build`.
//   - The build runs as
//       STANDALONE=true NEXT_PUBLIC_APP_VERSION="$VERSION" pnpm --filter @multica/web build
//     so the user-visible version matches the candidate tag — never a dev or
//     0.0.0 placeholder.
//   - The archive labrastro-web-<version>-linux-amd64-node-standalone.tar.gz
//     contains the standalone output with .next/static and public assets
//     merged into their runtime locations, LICENSE/NOTICE, and a build
//     evidence file (source identity + tool versions + actual build times).
//   - A build whose output cannot be proven to belong to THIS version fails
//     closed: a stale or reused .next directory is not a candidate.
//
// Output:
//   C/assets/labrastro-web-<version>-linux-amd64-node-standalone.tar.gz
//   C/assets/web-build.json                      (flat evidence copy)
//   C/assets/web-inventory.json                  (fragment for OL-83)
//   C/downloads/releases/<tag>/<tarball>         (inactive version directory)
//
// Dockerfile.web / docker-compose version parameters are owned by the
// parallel local-build task; this script's contract toward them is exactly
// the preflight env: VERSION / COMMIT / DATE / NEXT_PUBLIC_APP_VERSION /
// SOURCE_DATE_EPOCH (see scripts/check-release.mjs --format env).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkRelease } from "./check-release.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

export const WEB_COMPONENT = "web";
export const WEB_ARCHIVE_PLATFORM = { os: "linux", arch: "amd64" };
// Host the archive must be built on: Next standalone bundles the host's
// native runtime dependencies, so linux/amd64 output requires a linux/x64
// build host.
export const WEB_ARCHIVE_HOST = { platform: "linux", arch: "x64" };

function requireThat(condition, message) {
  if (!condition) throw new Error(`[build-candidate-web] ${message}`);
}

export function webArchiveName(version) {
  return `labrastro-web-${version}-linux-amd64-node-standalone.tar.gz`;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(path);
    }
  }
  return out.sort();
}

/**
 * Run the actual Next.js standalone build with the candidate version baked
 * in. Returns the epoch milliseconds the build started at, used by
 * verifyStandaloneBuild to reject pre-existing output.
 *
 * The archive is declared `linux/amd64`, and Next standalone copies the
 * host's runtime dependencies into it (e.g. sharp's prebuilt binary is
 * selected by the installing platform), so the build is gated to a Linux
 * x64 host. Building on anything else would produce an archive that
 * silently carries the wrong platform's native dependencies.
 */
export function buildWebStandalone(metadata, { spawnImpl = spawnSync, webRoot = join(repoRoot, "apps", "web") } = {}) {
  requireThat(
    process.platform === WEB_ARCHIVE_HOST.platform && process.arch === WEB_ARCHIVE_HOST.arch,
    `web candidate archives are linux/amd64; build on a ${WEB_ARCHIVE_HOST.platform}/${WEB_ARCHIVE_HOST.arch} host ` +
      `(got ${process.platform}/${process.arch}) or in an explicit Linux amd64 build environment`,
  );
  const startedAt = Date.now();
  const result = spawnImpl("pnpm", ["--filter", "@multica/web", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      STANDALONE: "true",
      NEXT_PUBLIC_APP_VERSION: metadata.version,
    },
  });
  if (result.error) throw result.error;
  requireThat(result.status === 0, `web build failed with exit code ${result.status}`);
  return { startedAt, webRoot };
}

/**
 * Prove the standalone output on disk belongs to this build: BUILD_ID must
 * have been (re)written after the build started, the runtime pieces must
 * exist, and the candidate version must be baked into the CLIENT bundle as
 * an exact string literal. The client bundle is what the user's browser
 * runs; a server-side hit alone cannot prove the user-visible version, and
 * a substring check would accept 0.4.43-labrastro.20 for .2.
 */
export function verifyStandaloneBuild(webRoot, { version, builtAfter }) {
  const nextDir = join(webRoot, ".next");
  const standaloneDir = join(nextDir, "standalone");
  const staticDir = join(nextDir, "static");
  const buildIdPath = join(nextDir, "BUILD_ID");
  requireThat(existsSync(buildIdPath), "missing .next/BUILD_ID — did the build run?");
  const buildId = readFileSync(buildIdPath, "utf8").trim();
  requireThat(buildId.length > 0, "empty .next/BUILD_ID");
  if (builtAfter !== undefined) {
    requireThat(
      statSync(buildIdPath).mtimeMs >= builtAfter,
      ".next/BUILD_ID predates this build run — refusing to package a possibly cached output",
    );
  }
  const serverEntry = join(standaloneDir, "apps", "web", "server.js");
  requireThat(
    existsSync(serverEntry),
    "missing standalone server entry apps/web/server.js",
  );
  requireThat(existsSync(staticDir), "missing .next/static directory");

  // The user-visible version is inlined into client chunks as a JS string
  // literal. Require the EXACT literal (any quote style) so a different
  // version carrying this one as a prefix (labrastro.20 vs .2) or a dev
  // suffix fails here.
  const literals = [`"${version}"`, `'${version}'`, `\`${version}\``];
  const found = walkFiles(staticDir).some(
    (file) =>
      statSync(file).size < 32 * 1024 * 1024 &&
      (() => {
        const content = readFileSync(file);
        return literals.some((literal) => content.includes(literal));
      })(),
  );
  requireThat(
    found,
    `candidate version ${version} not found as an exact literal in the client bundle — ` +
      "output was not produced by this version's build",
  );
  return { buildId, standaloneDir, staticDir, serverEntry };
}

/**
 * Assemble the runnable standalone tree, pack the archive and stage
 * everything into the artifact root. `evidence` carries the measured build
 * facts (build id, tool versions, start/end times).
 */
export function assembleWebCandidate({
  metadata,
  artifactDir,
  webRoot = join(repoRoot, "apps", "web"),
  evidence,
  repoRoot: sourceRoot = repoRoot,
}) {
  const { tag, version } = metadata;
  requireThat(
    version === tag.slice(1),
    `metadata version ${version} does not match tag ${tag}`,
  );
  const { standaloneDir, staticDir, buildId } = verifyStandaloneBuild(webRoot, {
    version,
    builtAfter: evidence?.build_started_at_ms,
  });

  const assetsDir = join(artifactDir, "assets");
  const releaseDir = join(artifactDir, "downloads", "releases", tag);
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });

  // Runnable tree: standalone output with static/public merged into the
  // monorepo runtime locations, plus license/notice and build evidence.
  const treeName = `labrastro-web-${version}-linux-amd64-node-standalone`;
  const treeRoot = join(artifactDir, "scratch", treeName);
  rmSync(treeRoot, { recursive: true, force: true });
  mkdirSync(treeRoot, { recursive: true });
  cpSync(standaloneDir, treeRoot, { recursive: true, verbatimSymlinks: true });
  const webSubdir = join(treeRoot, "apps", "web");
  mkdirSync(join(webSubdir, ".next"), { recursive: true });
  cpSync(staticDir, join(webSubdir, ".next", "static"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const publicDir = join(webRoot, "public");
  if (existsSync(publicDir)) {
    cpSync(publicDir, join(webSubdir, "public"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  for (const name of ["LICENSE", "NOTICE"]) {
    cpSync(join(sourceRoot, name), join(treeRoot, name));
  }
  const evidenceBody = {
    component: WEB_COMPONENT,
    repository: metadata.repository,
    tag,
    version,
    commit: metadata.commit,
    build_id: buildId,
    build_platform: `${process.platform}/${process.arch}`,
    ...evidence,
  };
  writeFileSync(
    join(treeRoot, "web-build.json"),
    `${JSON.stringify(evidenceBody, null, 2)}\n`,
  );

  const archiveName = webArchiveName(version);
  const archivePath = join(assetsDir, archiveName);
  rmSync(archivePath, { force: true });
  execFileSync("tar", [
    "-czf",
    archivePath,
    "-C",
    join(artifactDir, "scratch"),
    treeName,
  ]);
  rmSync(join(artifactDir, "scratch"), { recursive: true, force: true });

  // Flat evidence copy, then the version-directory copies of the archive
  // and the evidence (their download_path entries point at releases/<tag>/).
  const evidencePath = join(assetsDir, "web-build.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidenceBody, null, 2)}\n`);
  cpSync(archivePath, join(releaseDir, archiveName));
  cpSync(evidencePath, join(releaseDir, "web-build.json"));

  const entry = (name, filePath, extra = {}) => {
    const bytes = statSync(filePath).size;
    requireThat(bytes > 0, `${name} is empty`);
    return {
      name,
      path: `assets/${name}`,
      download_path: `releases/${tag}/${name}`,
      bytes,
      sha256: sha256File(filePath),
      component: WEB_COMPONENT,
      ...extra,
    };
  };
  const artifacts = [
    entry(archiveName, archivePath, { ...WEB_ARCHIVE_PLATFORM }),
    entry("web-build.json", evidencePath),
  ];
  const inventoryPath = join(assetsDir, "web-inventory.json");
  writeFileSync(
    inventoryPath,
    `${JSON.stringify({ component: WEB_COMPONENT, tag, version, commit: metadata.commit, artifacts }, null, 2)}\n`,
  );
  return { artifacts, evidence: evidenceBody, archivePath };
}

function main() {
  const { values } = parseArgs({
    options: {
      repository: { type: "string", default: process.env.LABRASTRO_RELEASE_REPOSITORY },
      tag: { type: "string", default: process.env.LABRASTRO_RELEASE_TAG },
      sha: { type: "string", default: process.env.LABRASTRO_RELEASE_SHA },
      mode: { type: "string", default: process.env.LABRASTRO_RELEASE_MODE ?? "candidate" },
    },
  });
  const metadata = checkRelease(
    {
      repository: values.repository,
      tag: values.tag,
      sha: values.sha,
      mode: values.mode,
      requireTag: true,
    },
    repoRoot,
  );
  const artifactDir = resolve(repoRoot, metadata.artifact_dir);
  const buildStartedAt = new Date();
  const { startedAt } = buildWebStandalone(metadata);
  const buildFinishedAt = new Date();
  const nodeVersion = process.version;
  let pnpmVersion = null;
  try {
    pnpmVersion = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    // Recorded as null; the build above already proved pnpm works here.
  }
  const { artifacts } = assembleWebCandidate({
    metadata,
    artifactDir,
    evidence: {
      build_started_at: buildStartedAt.toISOString(),
      build_started_at_ms: startedAt,
      build_finished_at: buildFinishedAt.toISOString(),
      node: nodeVersion,
      pnpm: pnpmVersion,
      source_date_epoch: metadata.source_date_epoch,
      // The archive embeds this same object; the flat copy is evidence for
      // the aggregation pipeline, not a deployment instruction.
    },
  });
  console.log(
    JSON.stringify(
      {
        tag: metadata.tag,
        version: metadata.version,
        artifact_dir: metadata.artifact_dir,
        artifacts: artifacts.map((a) => a.name),
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
