// Fixture-driven tests for the Desktop candidate staging entry. Everything
// runs against synthetic electron-builder output in a temp dir — no real
// installer is built here — but update metadata is parsed and resolved by
// the REAL electron-updater GenericProvider, including an end-to-end pass
// over a local HTTP server that simulates the internal feed for every
// channel an installed client can request.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_TARGETS,
  goBuildSetting,
  INTERNAL_FEED_URL,
  loadDesktopModules,
  resolveAppBuilderBin,
  stageDesktopCandidate,
  verifyBlockmap,
  verifyTarget,
} from "./stage-candidate.mjs";
import { DEFAULT_UPDATER_PREFERENCES } from "../src/main/updater-preferences";

const modules = loadDesktopModules();
const { yaml } = modules;

const TAG = "v0.4.43-labrastro.2";
const VERSION = "0.4.43-labrastro.2";
const SHA = "a".repeat(40);
const metadata = {
  repository: "AstralSolipsism/multica",
  tag: TAG,
  version: VERSION,
  commit: SHA,
  mode: "candidate",
  tag_exists: true,
  artifact_dir: `dist/candidate/${TAG}`,
};

const tmpRoots = [];
afterEach(() => {
  while (tmpRoots.length) rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), "stage-candidate-"));
  tmpRoots.push(dir);
  return dir;
}

function goBuildInfoStub(targetKey, { version = VERSION, commit = SHA } = {}) {
  const target = DESKTOP_TARGETS[targetKey];
  return [
    `/fake/${targetKey}/multica: go1.26.8`,
    `\tbuild\t-ldflags="-X main.version=${version} -X main.commit=${commit} -X main.date=2026-09-15T00:00:00Z"`,
    `\tbuild\tGOOS=${target.goos}`,
    `\tbuild\tGOARCH=${target.goarch}`,
    `\tbuild\tvcs.revision=${commit}`,
    "\tbuild\tvcs.modified=false",
  ].join("\n");
}

// The fake CLI path contains the target key (dist/<target>/...), so the stub
// can answer with the right platform/arch per invocation.
function goBuildInfoForPath(binaryPath) {
  const segment = binaryPath.split(sep).find((part) => DESKTOP_TARGETS[part]);
  if (!segment) throw new Error(`no target in ${binaryPath}`);
  return goBuildInfoStub(segment);
}

const nativeHost = { goos: "linux", goarch: "amd64" };
const nativeCliVersionStub = () => ({ version: VERSION, commit: SHA });

// Build a REAL blockmap for the file at installerPath using the same
// app-builder binary electron-builder invokes — fixtures then exercise the
// actual format and checksum algorithm.
function writeRealBlockmap(installerPath, blockmapPath = `${installerPath}.blockmap`) {
  execFileSync(resolveAppBuilderBin(), [
    "blockmap",
    "--input",
    installerPath,
    "--output",
    blockmapPath,
  ]);
  return blockmapPath;
}

/**
 * Build a synthetic electron-builder output directory for one target:
 * unpacked resources (real asar), a dummy installer (+ blockmap on Windows),
 * and the channel YAML with real size/sha512 entries.
 */
async function makeTargetFixture(distRoot, targetKey, overrides = {}) {
  const target = DESKTOP_TARGETS[targetKey];
  const dir = join(distRoot, targetKey);
  const resources = join(dir, target.unpackedDir, "resources");
  mkdirSync(resources, { recursive: true });

  const asarSrc = join(dir, "asar-src");
  mkdirSync(asarSrc, { recursive: true });
  writeFileSync(
    join(asarSrc, "package.json"),
    JSON.stringify({
      name: "@multica/desktop",
      productName: overrides.productName ?? "Labrastro",
      version: overrides.appVersion ?? VERSION,
    }),
  );
  await modules.asar.createPackage(asarSrc, join(resources, "app.asar"));
  writeFileSync(join(resources, "LICENSE"), "license text\n");
  writeFileSync(join(resources, "NOTICE"), "notice text\n");

  const feedConfig = {
    provider: overrides.provider ?? "generic",
    url: overrides.feedUrl ?? INTERNAL_FEED_URL,
    channel: overrides.appUpdateChannel ?? "labrastro",
  };
  writeFileSync(join(resources, "app-update.yml"), yaml.dump(feedConfig));

  const cliDir = join(resources, "app.asar.unpacked", "resources", "bin");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    join(cliDir, target.platform === "win" ? "multica.exe" : "multica"),
    "fake cli binary\n",
  );

  const installerName =
    target.platform === "win"
      ? `labrastro-desktop-${VERSION}-windows-${target.arch}.exe`
      : `labrastro-desktop-${VERSION}-linux-${target.arch === "x64" ? "x86_64" : "arm64"}.AppImage`;
  const installerBytes = Buffer.from(
    overrides.installerBytes ?? `installer-bytes-${targetKey}-${VERSION}`,
  );
  writeFileSync(join(dir, installerName), installerBytes);
  if (target.platform === "win" && !overrides.omitBlockmap) {
    writeRealBlockmap(join(dir, installerName));
  }

  const channelFile =
    overrides.channelFile ??
    (targetKey === "win-arm64"
      ? "latest-arm64.yml"
      : target.platform === "linux"
        ? `labrastro-linux${target.arch === "x64" ? "" : "-arm64"}.yml`
        : "labrastro.yml");
  const sha512 = createHash("sha512").update(installerBytes).digest("base64");
  const updateInfo = {
    version: overrides.feedVersion ?? VERSION,
    files: [{ url: installerName, sha512, size: installerBytes.length }],
    path: installerName,
    sha512,
    releaseDate: "2026-09-15T00:00:00.000Z",
  };
  writeFileSync(join(dir, channelFile), yaml.dump(updateInfo));
  for (const [name, content] of Object.entries(overrides.extraFiles ?? {})) {
    writeFileSync(join(dir, name), content);
  }
  return { dir, installerName, installerBytes, channelFile };
}

function baseOptions(distRoot, artifactDir, extra = {}) {
  return {
    metadata,
    artifactDir,
    distRoot,
    modules,
    goBuildInfo: goBuildInfoForPath,
    nativeCliVersion: nativeCliVersionStub,
    host: nativeHost,
    ...extra,
  };
}

async function makeFullMatrix(distRoot) {
  for (const targetKey of Object.keys(DESKTOP_TARGETS)) {
    await makeTargetFixture(distRoot, targetKey);
  }
}

describe("goBuildSetting", () => {
  it("parses ldflags values and plain build settings exactly", () => {
    const info = goBuildInfoStub("linux-x64");
    expect(goBuildSetting(info, "main.version")).toBe(VERSION);
    expect(goBuildSetting(info, "main.commit")).toBe(SHA);
    expect(goBuildSetting(info, "GOOS")).toBe("linux");
    expect(goBuildSetting(info, "vcs.modified")).toBe("false");
    expect(goBuildSetting(info, "main.missing")).toBe(null);
  });

  it("does not confuse a longer value with its prefix (.20 is not .2)", () => {
    const info = goBuildInfoStub("linux-x64", { version: `${VERSION}0` });
    expect(goBuildSetting(info, "main.version")).toBe(`${VERSION}0`);
    expect(goBuildSetting(info, "main.version")).not.toBe(VERSION);
  });
});

describe("verifyBlockmap", () => {
  it("accepts a real app-builder blockmap for the installer", () => {
    const root = tmpRoot();
    const installer = join(root, "a.exe");
    writeFileSync(installer, Buffer.alloc(65536, 0x61));
    writeRealBlockmap(installer);
    expect(() => verifyBlockmap(`${installer}.blockmap`, installer)).not.toThrow();
  });

  it("rejects a blockmap for different content of the SAME length", () => {
    const root = tmpRoot();
    const installer = join(root, "a.exe");
    writeFileSync(installer, Buffer.alloc(65536, 0x61));
    writeRealBlockmap(installer);
    // Every byte changed, length unchanged — a stale blockmap must fail.
    writeFileSync(installer, Buffer.alloc(65536, 0x62));
    expect(() => verifyBlockmap(`${installer}.blockmap`, installer)).toThrow(
      /block checksums/,
    );
  });

  it("rejects a blockmap describing a different length", () => {
    const root = tmpRoot();
    const installer = join(root, "a.exe");
    writeFileSync(installer, Buffer.from("0123456789".repeat(100)));
    writeRealBlockmap(installer);
    writeFileSync(installer, Buffer.from("shorter"));
    expect(() => verifyBlockmap(`${installer}.blockmap`, installer)).toThrow(
      /block sizes sum|block checksums/,
    );
  });

  it("rejects a blockmap that is not gzip JSON", () => {
    const root = tmpRoot();
    const installer = join(root, "a.exe");
    writeFileSync(installer, "content");
    const blockmap = join(root, "a.exe.blockmap");
    writeFileSync(blockmap, "not a blockmap");
    expect(() => verifyBlockmap(blockmap, installer)).toThrow(/gzip/);
  });
});

describe("verifyTarget", () => {
  it("verifies a well-formed target and reports evidence", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "win-x64");
    const result = verifyTarget("win-x64", {
      metadata,
      distRoot,
      modules,
      goBuildInfo: goBuildInfoForPath,
      host: nativeHost,
    });
    expect(result.channelFile).toBe("labrastro.yml");
    expect(result.evidence.bundled_cli_verified).toBe(true);
    expect(result.evidence.installer_hashes_verified).toBe(true);
    expect(result.evidence.metadata_paths_verified).toBe(true);
    expect(result.evidence.native_bundled_cli).toBe(
      "skipped (host platform/arch differs)",
    );
  });

  it("runs the native CLI smoke when the host matches the target", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "linux-x64");
    const result = verifyTarget("linux-x64", {
      metadata,
      distRoot,
      modules,
      goBuildInfo: goBuildInfoForPath,
      nativeCliVersion: nativeCliVersionStub,
      host: nativeHost,
    });
    expect(result.channelFile).toBe("labrastro-linux.yml");
    expect(result.evidence.native_bundled_cli).toEqual({
      version: VERSION,
      commit: SHA,
    });
  });

  it("rejects an app version that is not the candidate version", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "linux-x64", { appVersion: "0.0.0-gdeadbeef" });
    expect(() =>
      verifyTarget("linux-x64", {
        metadata,
        distRoot,
        modules,
        goBuildInfo: goBuildInfoForPath,
        host: nativeHost,
      }),
    ).toThrow(/app\.asar version/);
  });

  it("rejects update metadata for the wrong version", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "win-x64", { feedVersion: "0.4.43-labrastro.1" });
    expect(() =>
      verifyTarget("win-x64", {
        metadata,
        distRoot,
        modules,
        goBuildInfo: goBuildInfoForPath,
        host: nativeHost,
      }),
    ).toThrow(/does not match candidate/);
  });

  it("rejects a bundled CLI built for the wrong architecture", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "linux-arm64");
    expect(() =>
      verifyTarget("linux-arm64", {
        metadata,
        distRoot,
        modules,
        // arm64 target, amd64 binary — must fail instead of shipping
        goBuildInfo: () => goBuildInfoStub("linux-x64"),
        host: nativeHost,
      }),
    ).toThrow(/GOARCH/);
  });

  it("rejects a bundled CLI whose version merely starts with the candidate version", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "linux-arm64");
    expect(() =>
      verifyTarget("linux-arm64", {
        metadata,
        distRoot,
        modules,
        goBuildInfo: () => goBuildInfoStub("linux-arm64", { version: `${VERSION}0` }),
        host: nativeHost,
      }),
    ).toThrow(/does not exactly match/);
  });

  it("rejects a bundled CLI built from a different commit", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "linux-arm64");
    expect(() =>
      verifyTarget("linux-arm64", {
        metadata,
        distRoot,
        modules,
        goBuildInfo: () => goBuildInfoStub("linux-arm64", { commit: "b".repeat(40) }),
        host: nativeHost,
      }),
    ).toThrow(/does not exactly match/);
  });

  it("rejects a tampered installer whose sha512 no longer matches", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const fixture = await makeTargetFixture(distRoot, "win-x64");
    // Same length so the size check passes and the hash check is what fires.
    const tampered = Buffer.alloc(fixture.installerBytes.length, 0x41);
    writeFileSync(join(fixture.dir, fixture.installerName), tampered);
    expect(() =>
      verifyTarget("win-x64", {
        metadata,
        distRoot,
        modules,
        goBuildInfo: goBuildInfoForPath,
        nativeCliVersion: nativeCliVersionStub,
        host: nativeHost,
      }),
    ).toThrow(/sha512 mismatch/);
  });

  it("rejects a Windows target whose differential blockmap is missing", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "win-x64", { omitBlockmap: true });
    expect(() =>
      verifyTarget("win-x64", {
        metadata,
        distRoot,
        modules,
        goBuildInfo: goBuildInfoForPath,
        host: nativeHost,
      }),
    ).toThrow(/missing differential blockmap/);
  });

  it("rejects a Windows target whose blockmap describes other bytes of the same length", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const fixture = await makeTargetFixture(distRoot, "win-arm64");
    // Rebuild the blockmap for same-length but different content.
    const fixturePath = join(fixture.dir, fixture.installerName);
    const other = join(fixture.dir, "other.tmp");
    writeFileSync(other, Buffer.alloc(fixture.installerBytes.length, 0x41));
    writeRealBlockmap(other);
    writeFileSync(`${fixturePath}.blockmap`, readFileSync(`${other}.blockmap`));
    rmSync(other);
    rmSync(`${other}.blockmap`);
    expect(() =>
      verifyTarget("win-arm64", {
        metadata,
        distRoot,
        modules,
        goBuildInfo: goBuildInfoForPath,
        host: nativeHost,
      }),
    ).toThrow(/block checksums/);
  });

  it("rejects an unverified extra channel YAML riding along", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "win-x64", {
      extraFiles: {
        "old-channel.yml": [
          "version: 0.0.1",
          "files:",
          "- url: missing-old.exe",
          "  sha512: invalid",
          "  size: 100",
          "path: missing-old.exe",
          "",
        ].join("\n"),
      },
    });
    expect(() =>
      verifyTarget("win-x64", {
        metadata,
        distRoot,
        modules,
        goBuildInfo: goBuildInfoForPath,
        host: nativeHost,
      }),
    ).toThrow(/does not match candidate|references missing file/);
  });

  it("rejects a feed provider that is not the internal generic source", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    await makeTargetFixture(distRoot, "linux-x64", {
      provider: "github",
      feedUrl: "https://github.com/multica-ai/multica/releases",
    });
    expect(() =>
      verifyTarget("linux-x64", {
        metadata,
        distRoot,
        modules,
        goBuildInfo: goBuildInfoForPath,
        nativeCliVersion: nativeCliVersionStub,
        host: nativeHost,
      }),
    ).toThrow(/provider must stay generic/);
  });
});

describe("stageDesktopCandidate", () => {
  it("stages the full matrix, activation feeds, evidence and inventory", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeFullMatrix(distRoot);
    const { evidence, artifacts } = stageDesktopCandidate(
      baseOptions(distRoot, artifactDir),
    );

    // Inactive version directory: bare installer/blockmap/channel names.
    const versionDir = join(artifactDir, "downloads", "desktop", TAG);
    for (const name of [
      `labrastro-desktop-${VERSION}-windows-x64.exe`,
      `labrastro-desktop-${VERSION}-windows-x64.exe.blockmap`,
      `labrastro-desktop-${VERSION}-windows-arm64.exe`,
      `labrastro-desktop-${VERSION}-windows-arm64.exe.blockmap`,
      `labrastro-desktop-${VERSION}-linux-x86_64.AppImage`,
      `labrastro-desktop-${VERSION}-linux-arm64.AppImage`,
      "labrastro.yml",
      "latest-arm64.yml",
      "labrastro-linux.yml",
      "labrastro-linux-arm64.yml",
    ]) {
      expect(existsSync(join(versionDir, name)), name).toBe(true);
    }

    // Proposed root feeds: every reference prefixed with the version dir.
    const activationDesktop = join(artifactDir, "activation", "desktop");
    for (const name of [
      "labrastro.yml",
      "latest-arm64.yml",
      "labrastro-linux.yml",
      "labrastro-linux-arm64.yml",
      "latest.yml",
      "latest-linux.yml",
      "latest-linux-arm64.yml",
    ]) {
      const feed = yaml.load(readFileSync(join(activationDesktop, name), "utf8"));
      expect(feed.version, name).toBe(VERSION);
      expect(feed.path.startsWith(`${TAG}/`), name).toBe(true);
      for (const file of feed.files) {
        expect(file.url.startsWith(`${TAG}/`)).toBe(true);
      }
    }
    expect(
      readFileSync(join(artifactDir, "activation", "latest.json"), "utf8"),
    ).toBe(`{"version":"${TAG}"}`);

    // The version directory keeps bare references; only the proposed root
    // feeds carry the <tag>/ prefix.
    const stagedChannel = yaml.load(
      readFileSync(join(versionDir, "labrastro.yml"), "utf8"),
    );
    expect(stagedChannel.path).not.toContain(`${TAG}/`);

    // Feed metadata archive contains exactly the verified activation tree.
    const feedArchive = join(
      artifactDir,
      "assets",
      `labrastro-feed-metadata-${VERSION}.tar.gz`,
    );
    expect(existsSync(feedArchive)).toBe(true);
    const members = execFileSync("tar", ["-tzf", feedArchive], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(members).toContain("activation/latest.json");
    expect(members).toContain("activation/desktop/labrastro.yml");
    expect(members).toContain("activation/desktop/latest-linux-arm64.yml");
    expect(
      existsSync(
        join(
          artifactDir,
          "downloads",
          "releases",
          TAG,
          `labrastro-feed-metadata-${VERSION}.tar.gz`,
        ),
      ),
    ).toBe(true);

    // Evidence per target, plus its download copy.
    expect(Object.keys(evidence).sort()).toEqual(Object.keys(DESKTOP_TARGETS).sort());
    expect(evidence["win-arm64"].channel).toBe("latest-arm64.yml");
    expect(evidence["win-x64"].compatibility_channel).toBe("latest.yml");
    expect(evidence["linux-x64"].native_bundled_cli).toEqual({
      version: VERSION,
      commit: SHA,
    });
    expect(
      existsSync(
        join(artifactDir, "downloads", "releases", TAG, "desktop-verification.json"),
      ),
    ).toBe(true);

    // Inventory fragment follows the RELEASING.md artifact contract.
    const byName = Object.fromEntries(artifacts.map((a) => [a.name, a]));
    const winInstaller = byName[`labrastro-desktop-${VERSION}-windows-x64.exe`];
    expect(winInstaller).toMatchObject({
      path: `assets/labrastro-desktop-${VERSION}-windows-x64.exe`,
      download_path: `desktop/${TAG}/labrastro-desktop-${VERSION}-windows-x64.exe`,
      component: "desktop",
      os: "windows",
      arch: "amd64",
    });
    expect(winInstaller.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(winInstaller.bytes).toBeGreaterThan(0);
    const linuxArm = byName[`labrastro-desktop-${VERSION}-linux-arm64.AppImage`];
    expect(linuxArm).toMatchObject({ os: "linux", arch: "arm64" });
    const feed = byName[`labrastro-feed-metadata-${VERSION}.tar.gz`];
    expect(feed).toMatchObject({
      component: "feed",
      download_path: `releases/${TAG}/labrastro-feed-metadata-${VERSION}.tar.gz`,
    });
    expect(feed.os).toBeUndefined();
    expect(feed.arch).toBeUndefined();
    expect(byName["desktop-verification.json"]).toMatchObject({
      component: "desktop",
      download_path: `releases/${TAG}/desktop-verification.json`,
    });

    // Inventory file itself is written for the aggregation pipeline.
    const inventory = JSON.parse(
      readFileSync(join(artifactDir, "assets", "desktop-inventory.json"), "utf8"),
    );
    expect(inventory.tag).toBe(TAG);
    expect(inventory.artifacts.length).toBe(artifacts.length);
  });

  it("fails closed when a lost channel override breaks the runtime pact", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    // Simulate package.mjs losing its -c.publish.channel=latest-arm64
    // override: electron-builder then emits labrastro.yml for win-arm64, but
    // installed arm64 clients request latest-arm64.yml (updater.ts). Staging
    // must fail instead of publishing a feed those clients cannot see.
    await makeTargetFixture(distRoot, "win-arm64", {
      channelFile: "labrastro.yml",
      appUpdateChannel: "labrastro",
    });
    expect(() =>
      stageDesktopCandidate(
        baseOptions(distRoot, artifactDir, { targets: ["win-arm64"] }),
      ),
    ).toThrow(/did not generate the resolved channel file/);
  });

  it("fails closed on a cross-architecture filename collision", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    // Both targets emit a same-named, individually VALID channel YAML whose
    // bytes differ per architecture. Staging must not let one arch's file
    // overwrite the other's.
    const x64 = await makeTargetFixture(distRoot, "linux-x64");
    const arm64 = await makeTargetFixture(distRoot, "linux-arm64");
    for (const fixture of [x64, arm64]) {
      const sha512 = createHash("sha512")
        .update(fixture.installerBytes)
        .digest("base64");
      writeFileSync(
        join(fixture.dir, "labrastro-extra.yml"),
        yaml.dump({
          version: VERSION,
          files: [
            { url: fixture.installerName, sha512, size: fixture.installerBytes.length },
          ],
          path: fixture.installerName,
          sha512,
        }),
      );
    }
    expect(() =>
      stageDesktopCandidate(
        baseOptions(distRoot, artifactDir, { targets: ["linux-x64", "linux-arm64"] }),
      ),
    ).toThrow(/different content/);
  });

  it("rejects metadata whose version disagrees with the tag", async () => {
    const root = tmpRoot();
    await makeTargetFixture(join(root, "dist"), "linux-x64");
    expect(() =>
      stageDesktopCandidate(
        baseOptions(join(root, "dist"), join(root, "candidate"), {
          metadata: { ...metadata, version: "0.4.43-labrastro.9" },
          targets: ["linux-x64"],
        }),
      ),
    ).toThrow(/does not match tag/);
  });
});

describe("incremental staging", () => {
  it("merges targets staged in separate invocations and keeps feeds consistent", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeTargetFixture(distRoot, "linux-x64");
    await makeTargetFixture(distRoot, "win-x64");

    const first = stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
    );
    expect(Object.keys(first.evidence)).toEqual(["linux-x64"]);
    expect(first.artifacts.some((a) => a.name.includes("windows"))).toBe(false);

    const second = stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["win-x64"] }),
    );
    expect(Object.keys(second.evidence).sort()).toEqual(["linux-x64", "win-x64"]);
    const names = second.artifacts.map((a) => a.name);
    expect(names).toContain(`labrastro-desktop-${VERSION}-linux-x86_64.AppImage`);
    expect(names).toContain(`labrastro-desktop-${VERSION}-windows-x64.exe`);
    expect(names).toContain(`labrastro-desktop-${VERSION}-windows-x64.exe.blockmap`);

    // The archive carries the MERGED activation tree (linux + windows feeds).
    const feedArchive = join(
      artifactDir,
      "assets",
      `labrastro-feed-metadata-${VERSION}.tar.gz`,
    );
    const members = execFileSync("tar", ["-tzf", feedArchive], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    for (const feed of [
      "labrastro-linux.yml",
      "latest-linux.yml",
      "labrastro.yml",
      "latest.yml",
    ]) {
      expect(members).toContain(`activation/desktop/${feed}`);
    }

    // Evidence in the version directory is the merged one.
    const staged = JSON.parse(
      readFileSync(
        join(artifactDir, "downloads", "releases", TAG, "desktop-verification.json"),
        "utf8",
      ),
    );
    expect(Object.keys(staged).sort()).toEqual(["linux-x64", "win-x64"]);
  });

  it("is idempotent when the same target is staged twice", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeTargetFixture(distRoot, "linux-x64");
    const first = stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
    );
    const second = stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
    );
    expect(second.artifacts).toEqual(first.artifacts);
    expect(second.evidence).toEqual(first.evidence);
  });

  it("is byte-identical on a retry across a second boundary", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeTargetFixture(distRoot, "linux-x64");
    const first = stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 1100));
    const second = stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
    );
    expect(second.artifacts).toEqual(first.artifacts);
    const feedOf = (r) => r.artifacts.find((a) => a.component === "feed");
    expect(feedOf(second).sha256).toBe(feedOf(first).sha256);
    expect(second.evidence).toEqual(first.evidence);
  });

  it("requires activation feeds of all merged targets, not only this run's", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeTargetFixture(distRoot, "linux-x64");
    await makeTargetFixture(distRoot, "linux-arm64");
    stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-arm64"] }),
    );
    // The arm64 feeds vanish before the next invocation stages x64 only.
    rmSync(join(artifactDir, "activation", "desktop", "labrastro-linux-arm64.yml"));
    rmSync(join(artifactDir, "activation", "desktop", "latest-linux-arm64.yml"));
    expect(() =>
      stageDesktopCandidate(
        baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
      ),
    ).toThrow(/requires activation feed labrastro-linux-arm64\.yml/);
  });

  it("rejects a prior feed switched to another architecture's installer", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeTargetFixture(distRoot, "linux-x64");
    await makeTargetFixture(distRoot, "linux-arm64");
    stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-arm64", "linux-x64"] }),
    );
    // Point the arm64 feeds at the x64 installer — must be caught even when
    // the current run only re-stages x64.
    const x64Feed = readFileSync(
      join(artifactDir, "activation", "desktop", "labrastro-linux.yml"),
    );
    for (const name of ["labrastro-linux-arm64.yml", "latest-linux-arm64.yml"]) {
      writeFileSync(join(artifactDir, "activation", "desktop", name), x64Feed);
    }
    expect(() =>
      stageDesktopCandidate(
        baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
      ),
    ).toThrow(/references .* but target linux-arm64 owns/);
  });

  it("preserves the prior delivery when a later invocation fails", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeTargetFixture(distRoot, "linux-x64");
    await makeTargetFixture(distRoot, "win-x64", { feedVersion: "0.0.0-broken" });

    stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
    );
    const evidenceBefore = readFileSync(
      join(artifactDir, "assets", "desktop-verification.json"),
      "utf8",
    );
    const inventoryBefore = readFileSync(
      join(artifactDir, "assets", "desktop-inventory.json"),
      "utf8",
    );
    const archiveBefore = readFileSync(
      join(artifactDir, "assets", `labrastro-feed-metadata-${VERSION}.tar.gz`),
    );

    expect(() =>
      stageDesktopCandidate(
        baseOptions(distRoot, artifactDir, { targets: ["win-x64"] }),
      ),
    ).toThrow(/does not match candidate/);

    // The earlier staged delivery is untouched by the failed run.
    expect(
      readFileSync(join(artifactDir, "assets", "desktop-verification.json"), "utf8"),
    ).toBe(evidenceBefore);
    expect(
      readFileSync(join(artifactDir, "assets", "desktop-inventory.json"), "utf8"),
    ).toBe(inventoryBefore);
    expect(
      readFileSync(
        join(artifactDir, "assets", `labrastro-feed-metadata-${VERSION}.tar.gz`),
      ),
    ).toEqual(archiveBefore);
  });

  it("refuses to merge state from a different candidate identity", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeTargetFixture(distRoot, "linux-x64");
    stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
    );
    expect(() =>
      stageDesktopCandidate(
        baseOptions(distRoot, artifactDir, {
          metadata: { ...metadata, commit: "c".repeat(40) },
          targets: ["linux-x64"],
        }),
      ),
    ).toThrow(/different candidate/);
  });
});

describe("mock internal feed over HTTP", () => {
  it("serves every channel its clients resolve, with matching hashes", async () => {
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeFullMatrix(distRoot);
    stageDesktopCandidate(baseOptions(distRoot, artifactDir));

    // Simulate the internal source layout: proposed root feeds at
    // /downloads/desktop/<channel>.yml, version directory at
    // /downloads/desktop/<tag>/<name>.
    const serverRoot = join(root, "srv");
    cpSync(
      join(artifactDir, "activation", "desktop"),
      join(serverRoot, "downloads", "desktop"),
      { recursive: true },
    );
    cpSync(
      join(artifactDir, "downloads", "desktop", TAG),
      join(serverRoot, "downloads", "desktop", TAG),
      { recursive: true },
    );
    const server = createServer((req, res) => {
      const path = join(serverRoot, decodeURIComponent(req.url.split("?")[0]));
      let stat = null;
      try {
        stat = statSync(path);
      } catch {
        // falls through to 404
      }
      if (!stat || stat.isDirectory()) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end(readFileSync(path));
    });
    await new Promise((resolveServer) =>
      server.listen(0, "127.0.0.1", resolveServer),
    );
    try {
      const { port } = server.address();
      // Each target's client must resolve its exact channel file — the same
      // resolution the installed app performs (runtime override, app-update
      // channel, arch suffix).
      const expectedChannels = {
        "linux-x64": "labrastro-linux.yml",
        "linux-arm64": "labrastro-linux-arm64.yml",
        "win-x64": "labrastro.yml",
        "win-arm64": "latest-arm64.yml",
      };
      for (const [targetKey, channelFile] of Object.entries(expectedChannels)) {
        const target = DESKTOP_TARGETS[targetKey];
        const requested = [];
        const executor = {
          request: async (options) => {
            const url = `${options.protocol}//${options.hostname}:${options.port}${options.path}`;
            requested.push(options.path);
            const res = await fetch(url);
            if (!res.ok) {
              const error = new Error(`HTTP ${res.status}`);
              error.statusCode = res.status;
              throw error;
            }
            return res.text();
          },
        };
        const savedTestArch = process.env.TEST_UPDATER_ARCH;
        process.env.TEST_UPDATER_ARCH = target.arch;
        let info;
        let provider;
        try {
          provider = new modules.GenericProvider(
            {
              provider: "generic",
              url: `http://127.0.0.1:${port}/downloads/desktop`,
              channel: "labrastro",
            },
            {
              channel: targetKey === "win-arm64" ? "latest-arm64" : null,
              isAddNoCacheQuery: false,
            },
            { platform: target.runtimePlatform, executor },
          );
          // Channel resolution reads TEST_UPDATER_ARCH at request time, so
          // the env stays set for the whole resolution + request.
          info = await provider.getLatestVersion();
        } finally {
          if (savedTestArch === undefined) delete process.env.TEST_UPDATER_ARCH;
          else process.env.TEST_UPDATER_ARCH = savedTestArch;
        }
        expect(info.version, targetKey).toBe(VERSION);
        expect(requested, targetKey).toEqual([`/downloads/desktop/${channelFile}`]);
        // The feed's installer matches this target's platform/architecture.
        expect(info.path, targetKey).toContain(TAG);
        expect(info.path, targetKey).toContain(
          target.platform === "win" ? `windows-${target.arch}` : "linux",
        );
        for (const resolved of provider.resolveFiles(info)) {
          expect(
            resolved.url.pathname.startsWith(`/downloads/desktop/${TAG}/`),
          ).toBe(true);
          const res = await fetch(resolved.url);
          expect(res.status).toBe(200);
          const bytes = Buffer.from(await res.arrayBuffer());
          const entry = info.files.find(
            (f) => resolved.url.pathname === `/downloads/desktop/${f.url}`,
          );
          expect(entry).toBeTruthy();
          expect(bytes.length).toBe(entry.size);
          expect(createHash("sha512").update(bytes).digest("base64")).toBe(
            entry.sha512,
          );
        }
      }
    } finally {
      await new Promise((resolveServer) => server.close(resolveServer));
    }
  });
});

describe("auto-update preference boundary", () => {
  it("candidate staging never flips the default auto-update preference", () => {
    // The candidate pipeline prepares inactive files only. The installed
    // client's default stays opt-in; enabling updates remains a user action.
    expect(DEFAULT_UPDATER_PREFERENCES.automaticUpdates).toBe(false);
  });
});
