#!/usr/bin/env node
// Wrapper around `electron-builder` that keeps the Desktop version in
// lockstep with the CLI.
//
// Candidate release mode (LABRASTRO_RELEASE_REPOSITORY/TAG/SHA set): the
// shared preflight in scripts/check-release.mjs validates the reviewed
// (repository, tag, full SHA) identity BEFORE any cleanup or build, its
// normalized version (tag without `v`) is written to extraMetadata.version,
// and the same version/full SHA/source-commit date are handed to
// bundle-cli.mjs as VERSION/COMMIT/DATE. Packaging is always local
// (`--publish never` is pinned); staging and feed preparation live in
// scripts/stage-candidate.mjs, and the fork draft upload is a separate
// authorized step.
//
// Development mode (no release env): both versions are derived from
// `git describe --tags --match 'v[0-9]*' --always --dirty` — the same
// source GoReleaser reads for the CLI binary via the `main.version` ldflag.
//
// Builds the Electron bundles once, then for each requested target
// (platform + arch) compiles the matching Go CLI into resources/bin/ and
// invokes electron-builder with `-c.extraMetadata.version=<derived>` so
// the override applies at build time without mutating the tracked
// package.json.
//
// The electron-vite step is important: electron-builder only packages
// whatever is already in out/, so skipping it (or relying on stale
// artifacts from a prior partial build) ships an app with missing
// renderer code and white-screens on launch.
//
// Extra CLI args after `pnpm package --` are forwarded to electron-builder
// unchanged (e.g. `--mac --arm64`). For an unsigned local smoke-test
// build, set `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder falls
// back to an ad-hoc signature instead of requiring a Developer ID cert.
//
// The `normalizeGitVersion`, `deriveVersion`, and `DESCRIBE_ARGS` exports let
// tests cover version derivation both as a pure string transform and as the
// real `git describe` invocation against a throwaway repo.

import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Circular by design: check-release.mjs imports normalizeGitVersion from this
// file. Neither side touches the other's bindings at module-evaluation time,
// so the ESM cycle resolves cleanly.
import { checkRelease } from "../../../scripts/check-release.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const bundleCliScript = resolve(here, "bundle-cli.mjs");

const PLATFORM_CONFIG = {
  mac: {
    aliases: new Set(["--mac", "--macos", "-m"]),
    builderFlag: "--mac",
    runtimePlatform: "darwin",
    label: "macOS",
  },
  win: {
    aliases: new Set(["--win", "--windows", "-w"]),
    builderFlag: "--win",
    runtimePlatform: "win32",
    label: "Windows",
  },
  linux: {
    aliases: new Set(["--linux", "-l"]),
    builderFlag: "--linux",
    runtimePlatform: "linux",
    label: "Linux",
  },
};

const ARCH_FLAGS = new Map([
  ["--x64", "x64"],
  ["--arm64", "arm64"],
  ["--ia32", "ia32"],
  ["--armv7l", "armv7l"],
  ["--universal", "universal"],
]);

const SUPPORTED_CLI_ARCHS = new Set(["x64", "arm64"]);
const MAC_ALL_PLATFORM_TARGETS = [
  { platform: "mac", arch: "arm64" },
  { platform: "mac", arch: "x64" },
  { platform: "win", arch: "x64" },
  { platform: "win", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
];

// Run a git subcommand with its arguments handed straight to the binary,
// never through a shell. A match pattern like `v[0-9]*` must reach git as a
// single literal argument on every platform. Passing the whole command as a
// shell string (execSync) is unsafe on Windows: cmd.exe does not strip the
// POSIX single quotes around 'v[0-9]*', so git receives the quotes verbatim,
// matches no tag, and the version silently degrades to the 0.0.0-g<hash>
// fallback — which is exactly how a `0.0.0-…` Windows Desktop build once
// escaped to a GitHub Release.
function git(args, cwd) {
  try {
    return execFileSync("git", args, { encoding: "utf-8", cwd }).trim();
  } catch {
    return "";
  }
}

/**
 * Strip the leading `--` that npm/pnpm insert to separate their own
 * flags from the ones meant for the underlying script.  Without this,
 * `pnpm package -- --mac --arm64 --publish always` forwards the bare
 * `--` into electron-builder's argv, which terminates option parsing
 * and turns `--publish always` into ignored positional arguments.
 */
export function stripLeadingSeparator(argv) {
  if (argv.length > 0 && argv[0] === "--") return argv.slice(1);
  return argv;
}

/**
 * Pure transformation from the `git describe --tags --always --dirty`
 * output to the value we feed into electron-builder's extraMetadata.version.
 *
 *   - empty input              → null   (caller should fall back)
 *   - "v0.1.36"                → "0.1.36"
 *   - "v0.1.35-14-gf1415e96"   → "0.1.35-14-gf1415e96"  (semver prerelease)
 *   - "v0.1.35-…-dirty"        → same, dirty suffix preserved
 *   - "f1415e96" (no tag)      → "0.0.0-gf1415e96"       (fallback)
 *   - "2f24057b" (no tag, hash begins with a digit) → "0.0.0-g2f24057b"
 *   - "0123456"  (no tag, all-digit hash w/ leading zero) → "0.0.0-g0123456"
 *
 * Leading `v` is stripped so the result is valid semver for package.json.
 * The fallback matters because a bare commit hash is never valid semver —
 * even one that happens to start with a digit (e.g. "2f24057b") — and
 * electron-updater throws on launch if package.json carries such a version.
 * The hash is prefixed with `g` so the pre-release identifier is always
 * alphanumeric; a bare all-digit hash with a leading zero (e.g. "0123456")
 * would otherwise form `0.0.0-0123456`, which is invalid semver.
 */
export function normalizeGitVersion(raw) {
  if (!raw) return null;
  const stripped = raw.replace(/^v/, "");
  // A real version begins with major.minor.patch. The bare commit hash
  // that `git describe --always` falls back to (no reachable tag) does not,
  // so coerce it to a 0.0.0 prerelease rather than passing it through.
  // Prefix the hash with `g` (mirroring `git describe`'s own `g<hash>`
  // shorthand) so a hash like "0123456" yields "0.0.0-g0123456" — a single
  // alphanumeric identifier — instead of the invalid "0.0.0-0123456".
  if (!/^\d+\.\d+\.\d+/.test(stripped)) {
    return `0.0.0-g${stripped}`;
  }
  return stripped;
}

// The exact argv handed to `git describe` for version derivation. Kept as a
// standalone array — never a shell command string — so the `v[0-9]*` match
// pattern reaches git as one literal argument regardless of platform (see the
// git() note above for why a shell string breaks on Windows).
export const DESCRIBE_ARGS = [
  "describe",
  "--tags",
  "--match",
  "v[0-9]*",
  "--always",
  "--dirty",
];

// Exported (with an optional cwd) so tests can exercise the real describe
// invocation against a throwaway repo, not just normalizeGitVersion in
// isolation — the gap that let the Windows quoting regression through CI.
export function deriveVersion(cwd) {
  return normalizeGitVersion(git(DESCRIBE_ARGS, cwd));
}

/**
 * Candidate release inputs from the environment. Returns null when no
 * LABRASTRO_RELEASE_* variable is set — the everyday development path. When
 * any of them is set, all three must be present: candidate packaging runs on
 * the reviewed identity from scripts/check-release.mjs, never on a partial
 * override. mode comes from LABRASTRO_RELEASE_MODE (candidate | rebuild).
 */
export function candidateReleaseInputs(env = process.env) {
  const repository = env.LABRASTRO_RELEASE_REPOSITORY;
  const tag = env.LABRASTRO_RELEASE_TAG;
  const sha = env.LABRASTRO_RELEASE_SHA;
  if (!repository && !tag && !sha) return null;
  if (!repository || !tag || !sha) {
    throw new Error(
      "[package] candidate mode needs LABRASTRO_RELEASE_REPOSITORY, " +
        "LABRASTRO_RELEASE_TAG and LABRASTRO_RELEASE_SHA together",
    );
  }
  return {
    repository,
    tag,
    sha,
    mode: env.LABRASTRO_RELEASE_MODE ?? "candidate",
  };
}

/**
 * Candidate packaging is strictly local: installers and update metadata are
 * generated, then collected into the artifact directory by
 * scripts/stage-candidate.mjs. electron-builder must not publish anything —
 * the old workflow's `--publish always` targeted GitHub Releases, which is
 * not the Labrastro feed.
 *
 * electron-builder parses `--publish` and its aliases with yargs: the `-p`
 * short flag, the `--p` long-form alias, short-flag CLUSTERS containing `p`
 * (`-lp always` parses as `-l -p always`), and repeated flags, which become
 * an ARRAY (`publish: ['never','never']`) that its PublishManager still
 * treats as "publish enabled". This guard therefore removes every publish
 * form from the caller's args — rejecting any real publish request — and
 * appends exactly one scalar `--publish never`. Anything that could slip
 * past this textual guard is caught by assertCandidatePublishIsolated,
 * which runs the same parser electron-builder itself uses.
 */
export function enforceCandidatePublishPolicy(sharedArgs) {
  const args = [];
  const reject = (value) => {
    throw new Error(
      `[package] candidate builds cannot publish (got publish mode "${value}"); ` +
        "local packaging uses --publish never, feed upload is a separate authorized step",
    );
  };
  for (let i = 0; i < sharedArgs.length; i += 1) {
    const token = sharedArgs[i];
    if (token === "--publish" || token === "-p" || token === "--p") {
      const value = sharedArgs[i + 1];
      if (value !== "never") reject(value ?? "<missing>");
      i += 1; // consumed; exactly one is re-added below
      continue;
    }
    if (
      token.startsWith("--publish=") ||
      token.startsWith("-p=") ||
      token.startsWith("--p=")
    ) {
      const value = token.slice(token.indexOf("=") + 1);
      if (value !== "never") reject(value);
      continue;
    }
    // yargs splits short-flag clusters: any remaining cluster containing
    // "p" smuggles a publish flag past this guard (e.g. `-lp always` →
    // `-l -p always`). Legitimate platform shorthands (-mwl) are consumed
    // by parsePackageArgs before sharedArgs is built, so a "p" here can
    // only mean publish.
    if (/^-[A-Za-z]+$/.test(token) && token.includes("p")) {
      reject(`cluster ${token}`);
      continue;
    }
    args.push(token);
  }
  args.push("--publish", "never");
  return args;
}

// The parser harness electron-builder's own CLI uses. electron-builder and
// yargs are declared dependencies of this package — no transitive traversal.
let builderParser = null;
function loadBuilderParser() {
  if (builderParser) return builderParser;
  const rootRequire = createRequire(join(desktopRoot, "package.json"));
  const builderRequire = createRequire(
    rootRequire.resolve("electron-builder/package.json"),
  );
  const { configureBuildCommand, normalizeOptions } = builderRequire(
    "./out/builder.js",
  );
  const yargs = rootRequire("yargs/yargs");
  builderParser = { configureBuildCommand, normalizeOptions, yargs };
  return builderParser;
}

/**
 * Resolve a workspace package's bin entry to a direct `node <file>` command.
 * Running the tool through its bin FILE (never through a shell) keeps the
 * validated argv byte-identical at the process boundary: with `shell: true`
 * a single argument containing spaces — e.g. an
 * `-c.extraMetadata.description=a b` override — is re-split by the shell
 * into NEW arguments electron-builder never saw during validation, which
 * could smuggle `--p always` into the real invocation. It also sidesteps
 * the Windows `.cmd` shim issue (Node does not honour PATHEXT when spawning
 * a bare command without a shell, but node.exe itself is a real binary).
 */
export function resolveBinCommand(packageName, binName, root = desktopRoot) {
  const rootRequire = createRequire(join(root, "package.json"));
  const packageJsonPath = rootRequire.resolve(`${packageName}/package.json`);
  const pkg = rootRequire(packageJsonPath);
  const bin = pkg.bin?.[binName];
  if (typeof bin !== "string") {
    throw new Error(`[package] ${packageName} has no bin entry "${binName}"`);
  }
  return [process.execPath, resolve(dirname(packageJsonPath), bin)];
}

/**
 * Spawn a build tool with the exact argv, never through a shell. Extracted
 * so tests can capture the spawned argv and prove nothing is re-tokenized.
 */
export function spawnBuildTool(command, args, { cwd, env, spawnImpl = spawnSync } = {}) {
  const result = spawnImpl(command[0], [...command.slice(1), ...args], {
    stdio: "inherit",
    cwd,
    env,
    shell: false,
  });
  if (result.error) {
    console.error(`[package] failed to spawn ${command[0]}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

/**
 * Closure check on the FINAL builder argument list: run it through
 * electron-builder's own yargs command definition and option normalization
 * and require publish to resolve to the scalar "never" (which is exactly
 * what PublishManager treats as isPublish=false). This catches every alias,
 * cluster or repeat form the textual guard could miss.
 */
export function assertCandidatePublishIsolated(args) {
  const { configureBuildCommand, normalizeOptions, yargs } = loadBuilderParser();
  const parsed = configureBuildCommand(yargs(args))
    .exitProcess(false)
    .showHelpOnFail(false)
    .fail((message, error) => {
      throw error ?? new Error(message);
    })
    .parse();
  const options = normalizeOptions(parsed);
  if (options.publish !== "never") {
    throw new Error(
      `[package] candidate args resolve to publish mode ${JSON.stringify(options.publish)}; ` +
        "candidate packaging must resolve to a scalar --publish never",
    );
  }
}

function uniqueOrdered(values) {
  return [...new Set(values)];
}

export function envWithLocalBins(env = process.env, root = desktopRoot) {
  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const existingPath = env[pathKey] ?? "";
  const localBins = uniqueOrdered([
    resolve(root, "node_modules", ".bin"),
    resolve(root, "..", "..", "node_modules", ".bin"),
  ]);
  const mergedPath = uniqueOrdered([
    ...localBins,
    ...String(existingPath)
      .split(delimiter)
      .filter(Boolean),
  ]).join(delimiter);
  return { ...env, [pathKey]: mergedPath };
}

function hostPlatformKey(platform = process.platform) {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  if (platform === "linux") return "linux";
  throw new Error(`[package] unsupported host platform: ${platform}`);
}

function hostArchKey(arch = process.arch) {
  if (SUPPORTED_CLI_ARCHS.has(arch)) return arch;
  throw new Error(
    `[package] unsupported host architecture for Desktop CLI bundling: ${arch}`,
  );
}

function expandPlatformShorthand(token) {
  if (!/^-[mwl]{2,}$/.test(token)) return null;
  const expanded = [];
  for (const char of token.slice(1)) {
    if (char === "m") expanded.push("mac");
    if (char === "w") expanded.push("win");
    if (char === "l") expanded.push("linux");
  }
  return uniqueOrdered(expanded);
}

function platformKeyForToken(token) {
  for (const [platform, config] of Object.entries(PLATFORM_CONFIG)) {
    if (config.aliases.has(token)) return platform;
  }
  return null;
}

function platformTargetsTemplate() {
  return { mac: [], win: [], linux: [] };
}

export function parsePackageArgs(argv) {
  const sharedArgs = [];
  const platformTargets = platformTargetsTemplate();
  const requestedPlatforms = [];
  const requestedArchs = [];
  let allPlatforms = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--all-platforms") {
      allPlatforms = true;
      continue;
    }

    const expandedPlatforms = expandPlatformShorthand(token);
    if (expandedPlatforms) {
      requestedPlatforms.push(...expandedPlatforms);
      continue;
    }

    const platform = platformKeyForToken(token);
    if (platform) {
      requestedPlatforms.push(platform);
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        platformTargets[platform].push(argv[i + 1]);
        i += 1;
      }
      continue;
    }

    const arch = ARCH_FLAGS.get(token);
    if (arch) {
      requestedArchs.push(arch);
      continue;
    }

    sharedArgs.push(token);
  }

  return {
    allPlatforms,
    sharedArgs,
    platformTargets,
    requestedPlatforms: uniqueOrdered(requestedPlatforms),
    requestedArchs: uniqueOrdered(requestedArchs),
  };
}

export function resolveBuildMatrix(parsed, platform = process.platform, arch = process.arch) {
  if (parsed.allPlatforms) {
    if (parsed.requestedPlatforms.length > 0 || parsed.requestedArchs.length > 0) {
      throw new Error(
        "[package] --all-platforms cannot be combined with explicit platform or arch flags",
      );
    }
    if (platform !== "darwin") {
      throw new Error(
        `[package] --all-platforms is only supported on macOS hosts (current: ${platform})`,
      );
    }
    return MAC_ALL_PLATFORM_TARGETS.map((target) => ({ ...target }));
  }

  const platforms =
    parsed.requestedPlatforms.length > 0
      ? parsed.requestedPlatforms
      : [hostPlatformKey(platform)];
  const archs =
    parsed.requestedArchs.length > 0
      ? parsed.requestedArchs
      : [hostArchKey(arch)];

  const unsupported = archs.filter((value) => !SUPPORTED_CLI_ARCHS.has(value));
  if (unsupported.length > 0) {
    throw new Error(
      `[package] unsupported Desktop CLI architecture(s): ${unsupported.join(", ")}. ` +
        "Use --x64 or --arm64.",
    );
  }

  return platforms.flatMap((targetPlatform) =>
    archs.map((targetArch) => ({
      platform: targetPlatform,
      arch: targetArch,
    })),
  );
}

function formatTarget(target) {
  return `${PLATFORM_CONFIG[target.platform].label} ${target.arch}`;
}

export function builderArgsForTarget(
  target,
  parsed,
  version,
  {
    disableMacNotarize = false,
    hostPlatform = process.platform,
    useScopedOutputDir = false,
  } = {},
) {
  const builderArgs = [];
  if (version) builderArgs.push(`-c.extraMetadata.version=${version}`);
  if (disableMacNotarize) builderArgs.push("-c.mac.notarize=false");
  builderArgs.push(PLATFORM_CONFIG[target.platform].builderFlag);
  const requestedTargets = parsed.platformTargets[target.platform];
  if (
    target.platform === "linux" &&
    hostPlatform !== "linux" &&
    requestedTargets.length === 0
  ) {
    // electron-builder only guarantees AppImage/Snap when cross-building
    // Linux from macOS/Windows. Keep `package:all` portable by defaulting
    // to AppImage unless the caller explicitly requests Linux targets.
    builderArgs.push("AppImage");
  } else {
    builderArgs.push(...requestedTargets);
  }
  builderArgs.push(`--${target.arch}`);
  builderArgs.push(...parsed.sharedArgs);
  if (useScopedOutputDir) {
    builderArgs.push(
      `-c.directories.output=dist/${target.platform}-${target.arch}`,
    );
  }
  // electron-builder only adds an architecture suffix to Linux update
  // metadata. Windows x64/arm64 would both publish `latest.yml`, while macOS
  // arm64/x64 would both publish `latest-mac.yml`. Keep the established x64
  // Windows and arm64 macOS feeds unchanged for installed clients, and route
  // the additional architectures to explicit channels. updater.ts pins the
  // matching channel at runtime.
  if (target.platform === "win" && target.arch === "arm64") {
    builderArgs.push("-c.publish.channel=latest-arm64");
  }
  if (target.platform === "mac" && target.arch === "x64") {
    // Scope the Electron 39 platform floor to the new Intel package so this
    // change does not rewrite established Apple Silicon bundle metadata.
    builderArgs.push("-c.mac.minimumSystemVersion=12.0.0");
    builderArgs.push("-c.publish.channel=latest-x64");
  }
  return builderArgs;
}

function main() {
  const passthrough = stripLeadingSeparator(process.argv.slice(2));
  const parsed = parsePackageArgs(passthrough);
  const candidate = candidateReleaseInputs();
  let candidateEnv = null;
  if (candidate) {
    // Candidate preflight runs before ANY cleanup or build: a rejected
    // identity must leave dist/ and the worktree untouched. It validates the
    // repository, exact HEAD, clean source, fork-main ancestry, the immutable
    // tag and the global revision order, and returns the canonical version.
    const metadata = checkRelease({ ...candidate, requireTag: true }, repoRoot);
    parsed.sharedArgs = enforceCandidatePublishPolicy(parsed.sharedArgs);
    console.log(
      `[package] candidate ${metadata.tag} → version ${metadata.version} ` +
        `(commit ${metadata.commit}, mode ${metadata.mode})`,
    );
    candidateEnv = {
      VERSION: metadata.version,
      COMMIT: metadata.commit,
      DATE: metadata.date,
    };
  }
  const buildMatrix = resolveBuildMatrix(parsed);
  console.log(
    `[package] build matrix → ${buildMatrix.map(formatTarget).join(", ")}`,
  );

  // Step 0: start every release from an empty output directory. Stale
  // artifacts from a prior run would otherwise be repacked into this run's
  // app.asar (see the `!dist/**` note in electron-builder.yml). This clean
  // is belt-and-braces only — it does NOT by itself prevent the same-run
  // cross-arch contamination that broke the Intel DMG, because the first
  // arch writes into dist/ mid-run before the next arch is packaged; the
  // `!dist/**` files exclusion is what actually guarantees isolation.
  const distDir = resolve(desktopRoot, "dist");
  rmSync(distDir, { recursive: true, force: true });
  console.log(`[package] cleaned output dir → ${distDir}`);

  // Step 1: build the Electron main/preload/renderer bundles. Without
  // this step electron-builder silently packages whatever is already in
  // out/, which on a fresh checkout (or after a partial build) ships an
  // app that white-screens because the renderer bundle is missing.
  //
  // Tools run through their bin FILE under node directly — never through a
  // shell — so the validated argv reaches the child process byte-identical
  // (see resolveBinCommand for the injection and Windows .cmd rationale).
  spawnBuildTool(resolveBinCommand("electron-vite", "electron-vite"), ["build"], {
    cwd: desktopRoot,
    env: envWithLocalBins(),
  });

  // Step 2: derive the version that should be written into the app.
  // Candidate builds take the preflight-validated version; development
  // builds keep the git-describe fallback.
  const version = candidateEnv?.VERSION ?? deriveVersion();
  if (version) {
    console.log(
      `[package] Desktop version → ${version} (${candidateEnv ? "release preflight" : "from git describe"})`,
    );
  } else {
    console.warn(
      "[package] could not derive version from git; falling back to package.json",
    );
  }

  const disableMacNotarize = !process.env.APPLE_TEAM_ID;
  if (disableMacNotarize) {
    console.warn(
      "[package] APPLE_TEAM_ID not set — skipping notarization (local dev build). " +
        "Set APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID for a release build.",
    );
  }

  // Candidate builds always use per-target output directories so
  // scripts/stage-candidate.mjs can verify and collect each target in
  // isolation, even when only one target is requested.
  const useScopedOutputDir = buildMatrix.length > 1 || candidateEnv !== null;

  // Step 3: for each requested target, build the matching CLI into
  // resources/bin/ and package that target in isolation.
  for (const target of buildMatrix) {
    console.log(`[package] bundling CLI → ${formatTarget(target)}`);
    execFileSync(
      "node",
      [
        bundleCliScript,
        "--target-platform",
        PLATFORM_CONFIG[target.platform].runtimePlatform,
        "--target-arch",
        target.arch,
      ],
      {
        stdio: "inherit",
        cwd: desktopRoot,
        // Candidate mode hands the preflight stamp to bundle-cli, which
        // cross-checks it against the LABRASTRO_RELEASE_* inputs.
        env: candidateEnv ? { ...process.env, ...candidateEnv } : process.env,
      },
    );

    const builderArgs = builderArgsForTarget(target, parsed, version, {
      disableMacNotarize,
      hostPlatform: process.platform,
      useScopedOutputDir,
    });

    // Closure check: run the FINAL argument list for this target through
    // electron-builder's own parser and require publish to resolve to the
    // scalar "never". Any alias, cluster or repeat form that slipped the
    // textual guard is caught here, before a single byte is packaged.
    if (candidateEnv) {
      assertCandidatePublishIsolated(builderArgs);
    }

    // Step 4: invoke electron-builder for the current target only, through
    // its bin file under node — the exact validated argv, no shell between.
    spawnBuildTool(
      resolveBinCommand("electron-builder", "electron-builder"),
      builderArgs,
      { cwd: desktopRoot, env: envWithLocalBins() },
    );
  }
}

// Only run when invoked as a CLI, not when imported by a test file.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
