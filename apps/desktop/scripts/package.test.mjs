import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  assertCandidatePublishIsolated,
  builderArgsForTarget,
  candidateReleaseInputs,
  deriveVersion,
  DESCRIBE_ARGS,
  enforceCandidatePublishPolicy,
  envWithLocalBins,
  normalizeGitVersion,
  parsePackageArgs,
  resolveBinCommand,
  resolveBuildMatrix,
  spawnBuildTool,
  stripLeadingSeparator,
} from "./package.mjs";
import { resolveCliStamp } from "./bundle-cli.mjs";

describe("normalizeGitVersion", () => {
  it("returns null for empty / nullish input", () => {
    expect(normalizeGitVersion("")).toBe(null);
    expect(normalizeGitVersion(null)).toBe(null);
    expect(normalizeGitVersion(undefined)).toBe(null);
  });

  it("strips the leading v on a clean tag", () => {
    expect(normalizeGitVersion("v0.1.36")).toBe("0.1.36");
    expect(normalizeGitVersion("v1.0.0")).toBe("1.0.0");
  });

  it("preserves the prerelease suffix between tags", () => {
    expect(normalizeGitVersion("v0.1.35-14-gf1415e96")).toBe(
      "0.1.35-14-gf1415e96",
    );
  });

  it("preserves the dirty suffix on a modified worktree", () => {
    expect(normalizeGitVersion("v0.1.35-14-gf1415e96-dirty")).toBe(
      "0.1.35-14-gf1415e96-dirty",
    );
  });

  it("handles v-prefixed prerelease tags", () => {
    expect(normalizeGitVersion("v1.0.0-alpha")).toBe("1.0.0-alpha");
    expect(normalizeGitVersion("v1.0.0-rc.2")).toBe("1.0.0-rc.2");
  });

  it("falls back to 0.0.0-g<hash> when no tags are reachable", () => {
    // `git describe --tags --always` returns just the short commit hash
    // when there are no tags in the history at all. A hash that begins with
    // a digit (e.g. "2f24057b") is still not valid semver and must fall
    // through — otherwise electron-updater rejects it on launch. The `g`
    // prefix mirrors git describe's own `g<hash>` shorthand and keeps the
    // pre-release identifier a single alphanumeric token.
    expect(normalizeGitVersion("f1415e96")).toBe("0.0.0-gf1415e96");
    expect(normalizeGitVersion("abc1234")).toBe("0.0.0-gabc1234");
    expect(normalizeGitVersion("2f24057b")).toBe("0.0.0-g2f24057b");
  });

  it("degrades a non-semver tag prefix that slips past the --match filter", () => {
    // `git describe` is invoked with `--match 'v[0-9]*'` so a release-train
    // tag like `release_iteration/…` is never the nearest match; the version
    // resolves to the `vX.Y.Z-N-g<hash>` shape instead. If that filter ever
    // regresses, the describe output carries the non-semver tag verbatim and
    // must NOT be passed through as a version — it has no `major.minor.patch`
    // prefix, so it degrades to the `0.0.0-g<hash>` fallback rather than
    // producing something electron-updater would choke on.
    expect(
      normalizeGitVersion("release_iteration/Sprint_0705-3-g9adfcd4d8"),
    ).toBe("0.0.0-grelease_iteration/Sprint_0705-3-g9adfcd4d8");
    // With the filter in place the real input is well-formed and passes through.
    expect(normalizeGitVersion("v0.3.35-38-g9adfcd4d8")).toBe(
      "0.3.35-38-g9adfcd4d8",
    );
  });

  it("prefixes an all-digit hash so the pre-release is valid semver", () => {
    // A short hash that is all decimal digits with a leading zero would
    // produce `0.0.0-0123456` — a numeric pre-release identifier must not
    // have a leading zero, so that value is invalid semver and
    // electron-updater would throw on the no-tag builds this fallback
    // exists to protect. The `g` prefix makes it a single alphanumeric
    // identifier, which is always valid.
    expect(normalizeGitVersion("0123456")).toBe("0.0.0-g0123456");
    expect(normalizeGitVersion("04567")).toBe("0.0.0-g04567");
  });
});

describe("DESCRIBE_ARGS", () => {
  it("passes the match pattern as one bare argv token, never a shell-quoted string", () => {
    // Windows cmd.exe does not strip POSIX single quotes. Keeping the pattern
    // as a bare argv element prevents tagged builds from falling back to a
    // synthetic 0.0.0-g<hash> version.
    expect(DESCRIBE_ARGS).toContain("v[0-9]*");
    for (const arg of DESCRIBE_ARGS) {
      expect(arg).not.toContain("'");
      expect(arg).not.toContain('"');
    }
  });
});

describe("deriveVersion (real git describe)", () => {
  // These exercise the actual `git describe` invocation — not just the
  // normalizeGitVersion string transform — because the bug that shipped a
  // `0.0.0-…` Windows Desktop build lived in HOW git was called, not in the
  // string handling. package.mjs now runs git with an argv array (no shell),
  // so the `v[0-9]*` match pattern reaches git as a literal argument
  // identically on every platform.
  const repos = [];

  function initRepo() {
    const dir = mkdtempSync(join(tmpdir(), "multica-desktop-ver-"));
    repos.push(dir);
    const run = (...args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
    run("init", "-q");
    run("config", "user.email", "test@multica.ai");
    run("config", "user.name", "test");
    run("config", "commit.gpgsign", "false");
    run("commit", "-q", "--allow-empty", "-m", "root");
    return { dir, run };
  }

  afterEach(() => {
    while (repos.length) rmSync(repos.pop(), { recursive: true, force: true });
  });

  it("resolves a clean semver tag to its bare version", () => {
    const { dir, run } = initRepo();
    run("tag", "v1.4.2");
    expect(deriveVersion(dir)).toBe("1.4.2");
  });

  it("selects the semver tag even when a nearer non-semver tag exists", () => {
    // A release-train tag like `release_iteration/…` sitting closer to HEAD
    // must not become the version. With the match pattern correctly reaching
    // git, describe skips it and reports the real vX.Y.Z tag. If the pattern
    // were mangled (e.g. quotes leaking through a shell) git would match
    // nothing and the version would collapse to `0.0.0-…`.
    const { dir, run } = initRepo();
    run("tag", "v1.4.2");
    run("commit", "-q", "--allow-empty", "-m", "sprint");
    run("tag", "release_iteration/Sprint_0705");
    const version = deriveVersion(dir);
    expect(version).toMatch(/^1\.4\.2-1-g[0-9a-f]+$/);
    expect(version).not.toMatch(/^0\.0\.0/);
  });

  it("falls back to 0.0.0-g<hash> when no semver tag is reachable", () => {
    const { dir } = initRepo();
    expect(deriveVersion(dir)).toMatch(/^0\.0\.0-g[0-9a-f]+$/);
  });
});

describe("stripLeadingSeparator", () => {
  it("removes the leading -- inserted by npm/pnpm", () => {
    expect(stripLeadingSeparator(["--", "--mac", "--arm64", "--publish", "always"])).toEqual([
      "--mac", "--arm64", "--publish", "always",
    ]);
  });

  it("leaves args untouched when there is no leading --", () => {
    expect(stripLeadingSeparator(["--mac", "--arm64"])).toEqual(["--mac", "--arm64"]);
  });

  it("does not strip a -- that appears mid-argv", () => {
    expect(stripLeadingSeparator(["--mac", "--", "--arm64"])).toEqual([
      "--mac", "--", "--arm64",
    ]);
  });

  it("handles an empty array", () => {
    expect(stripLeadingSeparator([])).toEqual([]);
  });
});

describe("parsePackageArgs", () => {
  it("collects per-platform targets and shared args", () => {
    expect(
      parsePackageArgs([
        "--win", "nsis",
        "--mac", "dmg", "zip",
        "--arm64",
        "--publish", "never",
      ]),
    ).toEqual({
      allPlatforms: false,
      sharedArgs: ["--publish", "never"],
      platformTargets: {
        mac: ["dmg", "zip"],
        win: ["nsis"],
        linux: [],
      },
      requestedPlatforms: ["win", "mac"],
      requestedArchs: ["arm64"],
    });
  });

  it("expands combined short flags", () => {
    expect(parsePackageArgs(["-mw", "--x64"]).requestedPlatforms).toEqual([
      "mac",
      "win",
    ]);
  });

  it("tracks the all-platforms shortcut", () => {
    expect(parsePackageArgs(["--all-platforms", "--publish", "never"]).allPlatforms).toBe(true);
  });
});

describe("resolveBuildMatrix", () => {
  it("defaults to the current host platform and arch", () => {
    expect(
      resolveBuildMatrix(
        {
          allPlatforms: false,
          sharedArgs: [],
          platformTargets: { mac: [], win: [], linux: [] },
          requestedPlatforms: [],
          requestedArchs: [],
        },
        "darwin",
        "arm64",
      ),
    ).toEqual([{ platform: "mac", arch: "arm64" }]);
  });

  it("expands all-platforms on macOS", () => {
    expect(
      resolveBuildMatrix(
        {
          allPlatforms: true,
          sharedArgs: [],
          platformTargets: { mac: [], win: [], linux: [] },
          requestedPlatforms: [],
          requestedArchs: [],
        },
        "darwin",
        "arm64",
      ),
    ).toEqual([
      { platform: "mac", arch: "arm64" },
      { platform: "mac", arch: "x64" },
      { platform: "win", arch: "x64" },
      { platform: "win", arch: "arm64" },
      { platform: "linux", arch: "x64" },
      { platform: "linux", arch: "arm64" },
    ]);
  });

  it("rejects unsupported architectures", () => {
    expect(() =>
      resolveBuildMatrix(
        {
          allPlatforms: false,
          sharedArgs: [],
          platformTargets: { mac: [], win: [], linux: [] },
          requestedPlatforms: ["win"],
          requestedArchs: ["universal"],
        },
        "darwin",
        "arm64",
      ),
    ).toThrow(/unsupported Desktop CLI architecture/);
  });
});

describe("builderArgsForTarget", () => {
  it("adds scoped output directories for multi-target builds", () => {
    expect(
      builderArgsForTarget(
        { platform: "win", arch: "arm64" },
        {
          allPlatforms: false,
          sharedArgs: ["--publish", "never"],
          platformTargets: { mac: [], win: ["nsis"], linux: [] },
          requestedPlatforms: ["win"],
          requestedArchs: ["arm64"],
        },
        "1.2.3",
        {
          disableMacNotarize: true,
          hostPlatform: "darwin",
          useScopedOutputDir: true,
        },
      ),
    ).toEqual([
      "-c.extraMetadata.version=1.2.3",
      "-c.mac.notarize=false",
      "--win",
      "nsis",
      "--arm64",
      "--publish",
      "never",
      "-c.directories.output=dist/win-arm64",
      "-c.publish.channel=latest-arm64",
    ]);
  });

  it("does not override the publish channel for Windows x64 (default latest.yml)", () => {
    expect(
      builderArgsForTarget(
        { platform: "win", arch: "x64" },
        {
          allPlatforms: false,
          sharedArgs: ["--publish", "always"],
          platformTargets: { mac: [], win: ["nsis"], linux: [] },
          requestedPlatforms: ["win"],
          requestedArchs: ["x64"],
        },
        "1.2.3",
        { hostPlatform: "win32", useScopedOutputDir: true },
      ),
    ).toEqual([
      "-c.extraMetadata.version=1.2.3",
      "--win",
      "nsis",
      "--x64",
      "--publish",
      "always",
      "-c.directories.output=dist/win-x64",
    ]);
  });

  it("isolates the macOS x64 feed and platform floor", () => {
    expect(
      builderArgsForTarget(
        { platform: "mac", arch: "x64" },
        {
          allPlatforms: false,
          sharedArgs: ["--publish", "always"],
          platformTargets: { mac: ["dmg", "zip"], win: [], linux: [] },
          requestedPlatforms: ["mac"],
          requestedArchs: ["x64"],
        },
        "1.2.3",
        { hostPlatform: "darwin", useScopedOutputDir: true },
      ),
    ).toEqual([
      "-c.extraMetadata.version=1.2.3",
      "--mac",
      "dmg",
      "zip",
      "--x64",
      "--publish",
      "always",
      "-c.directories.output=dist/mac-x64",
      "-c.mac.minimumSystemVersion=12.0.0",
      "-c.publish.channel=latest-x64",
    ]);
  });

  it("keeps macOS arm64 on the existing latest-mac update channel", () => {
    expect(
      builderArgsForTarget(
        { platform: "mac", arch: "arm64" },
        {
          allPlatforms: false,
          sharedArgs: ["--publish", "always"],
          platformTargets: { mac: [], win: [], linux: [] },
          requestedPlatforms: ["mac"],
          requestedArchs: ["arm64"],
        },
        "1.2.3",
        { hostPlatform: "darwin", useScopedOutputDir: true },
      ),
    ).toEqual([
      "-c.extraMetadata.version=1.2.3",
      "--mac",
      "--arm64",
      "--publish",
      "always",
      "-c.directories.output=dist/mac-arm64",
    ]);
  });

  it("defaults linux cross-builds to AppImage on non-Linux hosts", () => {
    expect(
      builderArgsForTarget(
        { platform: "linux", arch: "x64" },
        {
          allPlatforms: false,
          sharedArgs: ["--publish", "never"],
          platformTargets: { mac: [], win: [], linux: [] },
          requestedPlatforms: ["linux"],
          requestedArchs: ["x64"],
        },
        "1.2.3",
        { hostPlatform: "darwin" },
      ),
    ).toEqual([
      "-c.extraMetadata.version=1.2.3",
      "--linux",
      "AppImage",
      "--x64",
      "--publish",
      "never",
    ]);
  });
});

describe("envWithLocalBins", () => {
  it("prepends desktop-local binary directories to PATH", () => {
    const desktopRoot = "/repo/apps/desktop";
    const result = envWithLocalBins(
      { PATH: ["/usr/local/bin", "/usr/bin"].join(delimiter) },
      desktopRoot,
    );
    expect(result.PATH.split(delimiter)).toEqual([
      resolve(desktopRoot, "node_modules", ".bin"),
      resolve(desktopRoot, "..", "..", "node_modules", ".bin"),
      "/usr/local/bin",
      "/usr/bin",
    ]);
  });

  it("preserves an existing Path key and avoids duplicate entries", () => {
    const desktopRoot = "/repo/apps/desktop";
    const desktopBin = resolve(desktopRoot, "node_modules", ".bin");
    const workspaceBin = resolve(desktopRoot, "..", "..", "node_modules", ".bin");
    const result = envWithLocalBins(
      { Path: [desktopBin, "runner-bin", workspaceBin].join(delimiter) },
      desktopRoot,
    );
    expect(result).not.toHaveProperty("PATH");
    expect(result.Path.split(delimiter)).toEqual([
      desktopBin,
      workspaceBin,
      "runner-bin",
    ]);
  });
});

describe("candidateReleaseInputs", () => {
  const full = {
    LABRASTRO_RELEASE_REPOSITORY: "AstralSolipsism/multica",
    LABRASTRO_RELEASE_TAG: "v0.4.43-labrastro.2",
    LABRASTRO_RELEASE_SHA: "a".repeat(40),
  };

  it("returns null when no release env is set (development path)", () => {
    expect(candidateReleaseInputs({})).toBe(null);
    expect(candidateReleaseInputs({ PATH: "/usr/bin" })).toBe(null);
  });

  it("returns the three inputs with the default candidate mode", () => {
    expect(candidateReleaseInputs(full)).toEqual({
      repository: "AstralSolipsism/multica",
      tag: "v0.4.43-labrastro.2",
      sha: "a".repeat(40),
      mode: "candidate",
    });
  });

  it("honours an explicit rebuild mode", () => {
    expect(
      candidateReleaseInputs({ ...full, LABRASTRO_RELEASE_MODE: "rebuild" })?.mode,
    ).toBe("rebuild");
  });

  it("rejects partial release env instead of guessing", () => {
    expect(() =>
      candidateReleaseInputs({ LABRASTRO_RELEASE_TAG: full.LABRASTRO_RELEASE_TAG }),
    ).toThrow(/together/);
    expect(() =>
      candidateReleaseInputs({
        LABRASTRO_RELEASE_REPOSITORY: full.LABRASTRO_RELEASE_REPOSITORY,
        LABRASTRO_RELEASE_SHA: full.LABRASTRO_RELEASE_SHA,
      }),
    ).toThrow(/together/);
  });
});

describe("enforceCandidatePublishPolicy", () => {
  it("pins exactly one scalar --publish never when the caller left it out", () => {
    expect(enforceCandidatePublishPolicy(["--x64"])).toEqual([
      "--x64",
      "--publish",
      "never",
    ]);
  });

  it("collapses every accepted publish form into one scalar --publish never", () => {
    // yargs turns repeated flags into an array, which electron-builder's
    // PublishManager still treats as publish-enabled — the guard must emit
    // a single scalar regardless of how the caller phrased it.
    for (const input of [
      ["--publish", "never"],
      ["-p", "never"],
      ["--publish=never"],
      ["-p=never"],
      ["--publish", "never", "--publish", "never"],
      ["-p", "never", "--publish=never"],
    ]) {
      expect(enforceCandidatePublishPolicy(input)).toEqual(["--publish", "never"]);
    }
    expect(enforceCandidatePublishPolicy(["--x64", "--publish", "never"])).toEqual([
      "--x64",
      "--publish",
      "never",
    ]);
  });

  it("rejects any real publish mode, in every yargs spelling — feed upload is a separate authorized step", () => {
    // The old workflow's `--publish always` pushed update metadata to GitHub
    // Releases. Candidate packaging must stay local; the internal generic
    // feed is populated by staging + an authorized upload, never by
    // electron-builder itself.
    for (const args of [
      ["--publish", "always"],
      ["--publish", "onTag"],
      ["--publish", "onTagOrDraft"],
      ["--publish=always"],
      ["-p", "always"],
      ["-p=always"],
      ["-p", "onTag"],
      // yargs also resolves the long-form alias and short clusters.
      ["--p", "always"],
      ["--p=always"],
      ["-lp", "always"],
      ["-pl", "always"],
    ]) {
      expect(() => enforceCandidatePublishPolicy(args)).toThrow(/cannot publish/);
    }
  });

  it("rejects a bare trailing publish flag in any spelling", () => {
    expect(() => enforceCandidatePublishPolicy(["--publish"])).toThrow(
      /cannot publish/,
    );
    expect(() => enforceCandidatePublishPolicy(["-p"])).toThrow(/cannot publish/);
    expect(() => enforceCandidatePublishPolicy(["--p"])).toThrow(/cannot publish/);
  });
});

describe("assertCandidatePublishIsolated (real electron-builder parser)", () => {
  it("accepts guarded args through the full wrapper chain, resolving to scalar never", () => {
    // The same wrapper path main() takes: parsePackageArgs →
    // enforceCandidatePublishPolicy → builderArgsForTarget → the real
    // electron-builder yargs/normalizeOptions pipeline.
    for (const input of [[], ["--publish", "never", "--publish", "never"], ["-p=never"]]) {
      const parsed = parsePackageArgs(["--linux", "AppImage", "--x64", ...input]);
      parsed.sharedArgs = enforceCandidatePublishPolicy(parsed.sharedArgs);
      const args = builderArgsForTarget(
        { platform: "linux", arch: "x64" },
        parsed,
        "0.4.43-labrastro.2",
        { useScopedOutputDir: true },
      );
      expect(() => assertCandidatePublishIsolated(args)).not.toThrow();
    }
  });

  it("rejects every publish-spelling bypass, and even an unguarded arg list", () => {
    // Any form that slipped the textual guard is still caught by the real
    // parser — the isolation closure.
    for (const input of [["--p", "always"], ["--p=always"], ["-lp", "always"]]) {
      const parsed = parsePackageArgs(["--linux", "AppImage", "--x64", ...input]);
      expect(() => {
        parsed.sharedArgs = enforceCandidatePublishPolicy(parsed.sharedArgs);
      }).toThrow(/cannot publish/);
    }
    const parsed = parsePackageArgs(["--linux", "AppImage", "--x64", "--publish", "always"]);
    const args = builderArgsForTarget(
      { platform: "linux", arch: "x64" },
      parsed,
      "0.4.43-labrastro.2",
      { useScopedOutputDir: true },
    );
    expect(() => assertCandidatePublishIsolated(args)).toThrow(/publish mode/);
  });

  it("validated argv reaches the spawn boundary byte-identical — no shell re-split", () => {
    // The P1 the r3 review proved: a single -c override containing spaces
    // ("-c.extraMetadata.description=demo --p always") is legitimate and
    // passes validation, but `shell: true` would re-tokenize it into a REAL
    // `--p always` publish flag inside the child. The spawn must carry the
    // exact array through node directly.
    const parsed = parsePackageArgs([
      "--linux",
      "AppImage",
      "--x64",
      "-c.extraMetadata.description=demo --p always",
    ]);
    parsed.sharedArgs = enforceCandidatePublishPolicy(parsed.sharedArgs);
    const args = builderArgsForTarget(
      { platform: "linux", arch: "x64" },
      parsed,
      "0.4.43-labrastro.2",
      { useScopedOutputDir: true },
    );
    expect(() => assertCandidatePublishIsolated(args)).not.toThrow();

    const command = resolveBinCommand("electron-builder", "electron-builder");
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toMatch(/electron-builder/);

    const calls = [];
    spawnBuildTool(command, args, {
      cwd: "/tmp",
      env: {},
      spawnImpl: (file, argv, options) => {
        calls.push({ file, argv, options });
        return { status: 0 };
      },
    });
    expect(calls).toHaveLength(1);
    const [{ file, argv, options }] = calls;
    expect(options.shell).toBe(false);
    expect(file).toBe(process.execPath);
    // Every validated argument is one argv element — the description with
    // spaces included; nothing is re-tokenized at the process boundary.
    expect(argv).toEqual([command[1], ...args]);
    expect(argv).toContain("-c.extraMetadata.description=demo --p always");
    // And the argv the child would actually receive still parses to never.
    expect(() =>
      assertCandidatePublishIsolated(argv.slice(1)),
    ).not.toThrow();
  });
});

describe("resolveCliStamp (bundle-cli candidate stamp)", () => {
  const env = {
    LABRASTRO_RELEASE_REPOSITORY: "AstralSolipsism/multica",
    LABRASTRO_RELEASE_TAG: "v0.4.43-labrastro.2",
    LABRASTRO_RELEASE_SHA: "b".repeat(40),
    VERSION: "0.4.43-labrastro.2",
    COMMIT: "b".repeat(40),
    DATE: "2026-09-15T01:02:03Z",
  };

  it("uses the preflight stamp in candidate mode", () => {
    expect(resolveCliStamp(env)).toEqual({
      version: "0.4.43-labrastro.2",
      commit: "b".repeat(40),
      date: "2026-09-15T01:02:03Z",
      source: "candidate",
    });
  });

  it("keeps the git-describe development fallback when no release env is set", () => {
    expect(
      resolveCliStamp(
        {},
        { describe: "v0.4.43-12-gdeadbeef", head: "deadbeef", now: "2026-09-15T01:02:03Z" },
      ),
    ).toEqual({
      version: "v0.4.43-12-gdeadbeef",
      commit: "deadbeef",
      date: "2026-09-15T01:02:03Z",
      source: "git-describe",
    });
    expect(resolveCliStamp({}, { now: "2026-09-15T01:02:03Z" })).toEqual({
      version: "dev",
      commit: "unknown",
      date: "2026-09-15T01:02:03Z",
      source: "git-describe",
    });
  });

  it("fails closed on partial release env", () => {
    expect(() =>
      resolveCliStamp({ LABRASTRO_RELEASE_TAG: env.LABRASTRO_RELEASE_TAG }),
    ).toThrow(/together/);
  });

  it("fails closed when preflight outputs are missing", () => {
    const { VERSION, ...withoutVersion } = env;
    expect(() => resolveCliStamp(withoutVersion)).toThrow(/VERSION, COMMIT and DATE/);
  });

  it("rejects a VERSION that does not match the release tag", () => {
    expect(() =>
      resolveCliStamp({ ...env, VERSION: "0.4.43-labrastro.3" }),
    ).toThrow(/does not match release tag/);
    expect(() => resolveCliStamp({ ...env, VERSION: "dev" })).toThrow(
      /does not match release tag/,
    );
  });

  it("rejects a COMMIT that does not match the release SHA", () => {
    expect(() => resolveCliStamp({ ...env, COMMIT: "c".repeat(40) })).toThrow(
      /COMMIT does not match/,
    );
  });
});

describe("electron-builder.yml packaging config", () => {
  // Regression guard for github.com/multica-ai/multica/issues/5595. The
  // multi-arch release build writes each target's output to
  // dist/<platform>-<arch> in the same apps/desktop dir; electron-builder
  // only auto-excludes the *current* target's output dir, so without an
  // explicit `!dist/**` the earlier arch's dist/ was repacked into the next
  // arch's app.asar. That inflated the Intel (x64) DMG until its Electron
  // Framework binary was dropped and Intel Macs crashed on launch. Keep the
  // exclusion pinned so a future edit to the files list cannot drop it
  // unnoticed.
  // Resolve electron-builder.yml relative to cwd, tolerating vitest running
  // from either the desktop package dir or the repo root — import.meta.url is
  // not a file:// URL under the test transform, so avoid fileURLToPath here.
  const configPath = [
    resolve(process.cwd(), "electron-builder.yml"),
    resolve(process.cwd(), "apps/desktop/electron-builder.yml"),
  ].find((candidate) => existsSync(candidate));

  // Extract the entries of the top-level `files:` block sequence without a
  // YAML dependency: collect the `  - "…"` items that follow `files:` up to
  // the next top-level key. Commented (`#`) lines are ignored, so a
  // commented-out exclusion would (correctly) not count.
  function readFilesBlock(raw) {
    const lines = raw.split("\n");
    const start = lines.findIndex((l) => /^files:\s*$/.test(l));
    if (start === -1) return [];
    const entries = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\S/.test(line)) break; // next top-level key ends the block
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^-\s*"?(.*?)"?\s*$/);
      if (m) entries.push(m[1]);
    }
    return entries;
  }

  it("excludes prior architecture output from packaged files", () => {
    expect(configPath, "electron-builder.yml not found").toBeTruthy();
    const entries = readFilesBlock(readFileSync(configPath, "utf-8"));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toContain("!dist/**");
  });

  it("keeps the update provider on the internal generic feed, never upstream GitHub", () => {
    // Installed clients resolve updates against this block. Pointing it back
    // at a GitHub provider would let an upstream release overwrite the
    // customized build; candidate packaging stages feed files locally and an
    // authorized step uploads them — electron-builder never publishes.
    expect(configPath, "electron-builder.yml not found").toBeTruthy();
    const raw = readFileSync(configPath, "utf-8");
    const publishMatch = raw.match(/^publish:\n((?: {2,}.*\n?)*)/m);
    expect(publishMatch, "publish block not found").toBeTruthy();
    const publish = publishMatch[1];
    expect(publish).toContain("provider: generic");
    expect(publish).toContain(
      "url: https://multica.outlune.com/downloads/desktop",
    );
    expect(publish).not.toMatch(/provider:\s*github/);
    expect(publish).not.toMatch(/multica-ai/);
  });
});
