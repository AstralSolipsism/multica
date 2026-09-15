#!/usr/bin/env node
// Builds the `multica` CLI from server/cmd/multica and copies the binary
// into apps/desktop/resources/bin/ so electron-vite (dev) and electron-
// builder (prod) pick it up. Running this on every dev/build/package
// invocation guarantees the bundled CLI always matches the current Go
// source — no more stale binary surprises. Go's build cache makes the
// no-op case (nothing changed) effectively free.
//
// ldflags mirror `make build` so `multica --version` reports a meaningful
// version / commit / date.
//
// Version stamp sources, in priority order:
//
//   1. Candidate release stamp — when the Labrastro release inputs
//      (LABRASTRO_RELEASE_REPOSITORY/TAG/SHA) are present, the bundled CLI
//      must carry exactly the reviewed candidate identity: VERSION (tag
//      without `v`), COMMIT (full 40-char SHA) and DATE (source commit time)
//      from scripts/check-release.mjs. The values are cross-checked against
//      the release inputs so a hand-edited env cannot silently stamp a
//      dev/describe version into a candidate. package.mjs runs the full
//      preflight before invoking this script; the checks here keep a direct
//      call honest too.
//   2. Development fallback — `git describe --tags --match 'v[0-9]*'
//      --always --dirty`, short HEAD and the current time, exactly as
//      before. This path is untouched so daily development builds keep
//      working with no release setup.
//
// Graceful: if `go` is not installed (e.g. frontend-only contributor), we
// skip the build and fall through to auto-install at runtime. A genuine
// Go compile error is fatal — you want that to block dev, not hide.

import { access, chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeGitVersion } from "./package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const serverDir = join(repoRoot, "server");

const PLATFORM_TO_GOOS = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const SUPPORTED_ARCHS = new Set(["x64", "arm64"]);

function runtimePlatformFromArgs(argv) {
  const flagIndex = argv.indexOf("--target-platform");
  if (flagIndex === -1) return process.platform;
  return argv[flagIndex + 1] ?? "";
}

function runtimeArchFromArgs(argv) {
  const flagIndex = argv.indexOf("--target-arch");
  if (flagIndex === -1) return process.arch;
  return argv[flagIndex + 1] ?? "";
}

function normalizeRuntimePlatform(platform) {
  if (platform in PLATFORM_TO_GOOS) return platform;
  throw new Error(
    `[bundle-cli] unsupported target platform: ${platform}. ` +
      "Use darwin, linux, or win32.",
  );
}

function normalizeRuntimeArch(arch) {
  if (SUPPORTED_ARCHS.has(arch)) return arch;
  throw new Error(
    `[bundle-cli] unsupported target architecture: ${arch}. ` +
      "Use x64 or arm64.",
  );
}

function binaryNameForPlatform(platform) {
  return platform === "win32" ? "multica.exe" : "multica";
}

/**
 * Resolve the version stamp baked into the bundled CLI.
 *
 * Candidate mode (any LABRASTRO_RELEASE_* input present) requires the
 * preflight outputs VERSION / COMMIT / DATE and validates them against the
 * release inputs: VERSION must be the normalized tag (no `v` prefix) and
 * COMMIT the full reviewed SHA. A partial or disagreeing environment fails
 * closed instead of stamping a snapshot version into a candidate installer.
 *
 * Development mode keeps the historical fallbacks: git describe output,
 * short HEAD, current wall-clock time, "dev"/"unknown" when git is absent.
 */
export function resolveCliStamp(env, { describe = "", head = "", now } = {}) {
  const releaseTag = env.LABRASTRO_RELEASE_TAG;
  const releaseSha = env.LABRASTRO_RELEASE_SHA;
  const candidate = Boolean(
    releaseTag || releaseSha || env.LABRASTRO_RELEASE_REPOSITORY,
  );
  if (!candidate) {
    return {
      version: describe || "dev",
      commit: head || "unknown",
      date: now ?? new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      source: "git-describe",
    };
  }
  if (!releaseTag || !releaseSha || !env.LABRASTRO_RELEASE_REPOSITORY) {
    throw new Error(
      "[bundle-cli] candidate mode needs LABRASTRO_RELEASE_REPOSITORY, " +
        "LABRASTRO_RELEASE_TAG and LABRASTRO_RELEASE_SHA together",
    );
  }
  const { VERSION, COMMIT, DATE } = env;
  if (!VERSION || !COMMIT || !DATE) {
    throw new Error(
      "[bundle-cli] candidate mode needs VERSION, COMMIT and DATE from the " +
        "release preflight (scripts/check-release.mjs --format env)",
    );
  }
  const expectedVersion = normalizeGitVersion(releaseTag);
  if (VERSION !== expectedVersion) {
    throw new Error(
      `[bundle-cli] VERSION=${VERSION} does not match release tag ${releaseTag} ` +
        `(expected ${expectedVersion}); run the preflight instead of hand-setting env`,
    );
  }
  if (COMMIT !== releaseSha) {
    throw new Error(
      "[bundle-cli] COMMIT does not match LABRASTRO_RELEASE_SHA; " +
        "run the preflight instead of hand-setting env",
    );
  }
  return { version: VERSION, commit: COMMIT, date: DATE, source: "candidate" };
}

// Hand git arguments straight to the binary (no shell). A match pattern like
// `v[0-9]*` must reach git as one literal argument; routing it through a shell
// string breaks on Windows, where cmd.exe keeps the POSIX single quotes and
// git matches no tag — degrading the bundled CLI's version to the
// 0.0.0-g<hash> fallback.
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function hasGo() {
  try {
    execSync("go version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const targetPlatform = normalizeRuntimePlatform(
    runtimePlatformFromArgs(process.argv.slice(2)),
  );
  const targetArch = normalizeRuntimeArch(runtimeArchFromArgs(process.argv.slice(2)));
  const goos = PLATFORM_TO_GOOS[targetPlatform];
  const goarch = targetArch === "x64" ? "amd64" : targetArch;
  const binName = binaryNameForPlatform(targetPlatform);
  const srcBinary = join(serverDir, "bin", `${goos}-${goarch}`, binName);
  const destDir = join(repoRoot, "apps", "desktop", "resources", "bin");
  const destBinary = join(destDir, binName);

  const stamp = resolveCliStamp(process.env, {
    describe: git("describe", "--tags", "--match", "v[0-9]*", "--always", "--dirty"),
    head: git("rev-parse", "--short", "HEAD"),
  });

  if (hasGo()) {
    const ldflags = `-X main.version=${stamp.version} -X main.commit=${stamp.commit} -X main.date=${stamp.date}`;

    console.log(
      `[bundle-cli] go build → ${srcBinary} (${goos}/${goarch}, version=${stamp.version} commit=${stamp.commit} source=${stamp.source})`,
    );
    await mkdir(join(serverDir, "bin", `${goos}-${goarch}`), { recursive: true });
    execFileSync(
      "go",
      [
        "build",
        "-ldflags",
        ldflags,
        "-o",
        srcBinary,
        "./cmd/multica",
      ],
      {
        cwd: serverDir,
        stdio: "inherit",
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOOS: goos,
          GOARCH: goarch,
        },
      },
    );
  } else {
    console.warn(
      "[bundle-cli] `go` not found in PATH — skipping CLI build. " +
        "Desktop will use whatever is already in resources/bin/, or fall back " +
        "to auto-installing the latest release at runtime.",
    );
  }

  if (!(await exists(srcBinary))) {
    console.warn(
      `[bundle-cli] ${srcBinary} not present — Desktop will fall back to ` +
        `auto-installing the latest release at runtime.`,
    );
    await rm(destDir, { recursive: true, force: true });
    return;
  }

  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  await copyFile(srcBinary, destBinary);
  await chmod(destBinary, 0o755);

  // macOS: ad-hoc sign so Gatekeeper doesn't complain when the parent app
  // (which itself may be unsigned in dev) spawns the child.
  if (process.platform === "darwin") {
    try {
      execSync(`codesign -s - --force ${JSON.stringify(destBinary)}`, {
        stdio: "pipe",
      });
    } catch {
      // Non-fatal. Unsigned binaries still run when the parent app is trusted.
    }
  }

  console.log(`[bundle-cli] bundled ${srcBinary} → ${destBinary}`);
}

// Only run when invoked as a CLI, not when imported by a test file.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
