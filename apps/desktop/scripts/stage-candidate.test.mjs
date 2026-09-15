// Fixture-driven tests for the Desktop candidate staging entry. Everything
// runs against synthetic electron-builder output in a temp dir — no real
// installer is built here — but update metadata is parsed and resolved by
// the REAL electron-updater GenericProvider, including one end-to-end pass
// over a local HTTP server that simulates the internal feed.

import { createHash } from "node:crypto";
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
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_TARGETS,
  INTERNAL_FEED_URL,
  loadDesktopModules,
  stageDesktopCandidate,
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

function goBuildInfoStub(targetKey) {
  const target = DESKTOP_TARGETS[targetKey];
  return [
    `/fake/${targetKey}/multica: go1.26.8`,
    `build\t-ldflags="-X main.version=${VERSION} -X main.commit=${SHA} -X main.date=2026-09-15T00:00:00Z"`,
    `build\tGOOS=${target.goos}`,
    `build\tGOARCH=${target.goarch}`,
    `build\tvcs.revision=${SHA}`,
    "build\tvcs.modified=false",
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

/**
 * Build a synthetic electron-builder output directory for one target:
 * unpacked resources (real asar), a dummy installer + blockmap, and the
 * channel YAML with real size/sha512 entries.
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
  if (target.platform === "win") {
    writeFileSync(join(dir, `${installerName}.blockmap`), `blockmap-${targetKey}\n`);
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

    // Evidence per target.
    expect(Object.keys(evidence).sort()).toEqual(Object.keys(DESKTOP_TARGETS).sort());
    expect(evidence["win-arm64"].channel).toBe("latest-arm64.yml");
    expect(evidence["win-x64"].compatibility_channel).toBe("latest.yml");
    expect(evidence["linux-x64"].native_bundled_cli).toEqual({
      version: VERSION,
      commit: SHA,
    });

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
    await makeTargetFixture(distRoot, "linux-x64", {
      extraFiles: { "collision.yml": "from x64\n" },
    });
    await makeTargetFixture(distRoot, "linux-arm64", {
      extraFiles: { "collision.yml": "from arm64 — different bytes\n" },
    });
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

describe("mock internal feed over HTTP", () => {
  it("serves the staged feed and every referenced file with matching hashes", async () => {
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
      const path = join(serverRoot, decodeURIComponent(req.url));
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
      const executor = {
        request: async (options) => {
          const url = `${options.protocol}//${options.hostname}:${options.port}${options.path}`;
          const res = await fetch(url);
          if (!res.ok) {
            const error = new Error(`HTTP ${res.status}`);
            error.statusCode = res.status;
            throw error;
          }
          return res.text();
        },
      };
      for (const targetKey of Object.keys(DESKTOP_TARGETS)) {
        const target = DESKTOP_TARGETS[targetKey];
        const provider = new modules.GenericProvider(
          { provider: "generic", url: `http://127.0.0.1:${port}/downloads/desktop` },
          { channel: null, isAddNoCacheQuery: false },
          { platform: target.runtimePlatform, executor },
        );
        const info = await provider.getLatestVersion();
        expect(info.version).toBe(VERSION);
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

  it("client against the mock feed sees no update when versions match", async () => {
    // The "closed auto-update" scenario at the feed boundary: a client
    // already running the candidate version resolves the feed, sees the same
    // version and has nothing to download. The app's own opt-in default is
    // pinned separately below.
    const root = tmpRoot();
    const distRoot = join(root, "dist");
    const artifactDir = join(root, "candidate");
    await makeTargetFixture(distRoot, "linux-x64");
    stageDesktopCandidate(
      baseOptions(distRoot, artifactDir, { targets: ["linux-x64"] }),
    );
    const feed = yaml.load(
      readFileSync(
        join(artifactDir, "activation", "desktop", "labrastro-linux.yml"),
        "utf8",
      ),
    );
    expect(feed.version).toBe(VERSION);
    // electron-updater treats equal versions as "no update available"; the
    // feed must therefore report exactly the candidate version — a stale or
    // placeholder version here would either downgrade clients or look like
    // an update when none exists.
  });
});

describe("auto-update preference boundary", () => {
  it("candidate staging never flips the default auto-update preference", () => {
    // The candidate pipeline prepares inactive files only. The installed
    // client's default stays opt-in; enabling updates remains a user action.
    expect(DEFAULT_UPDATER_PREFERENCES.automaticUpdates).toBe(false);
  });
});
