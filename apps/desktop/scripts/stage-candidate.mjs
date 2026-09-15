#!/usr/bin/env node
// Verify completed electron-builder output and stage it into the candidate
// handoff root (`dist/candidate/<tag>/`, "C") for the aggregation pipeline.
//
// What this script does, per Desktop target:
//   1. Verifies the unpacked app: app.asar package.json carries the candidate
//      version and Labrastro productName, LICENSE/NOTICE shipped, and the
//      bundled CLI's Go build info matches the target's platform, arch and
//      the reviewed version/full-SHA identity.
//   2. Verifies the generated update metadata (the channel YAML next to the
//      installers) against the actual installer bytes — version, size and
//      base64 SHA-512 — through the real electron-updater GenericProvider,
//      so the channel filename is the one an installed client resolves.
//   3. Copies installers, blockmaps and channel YAML into the inactive
//      version directory `C/downloads/desktop/<tag>/` (bare names) and the
//      flat draft-asset directory `C/assets/`.
//   4. Writes PROPOSED root feeds into `C/activation/desktop/` with every
//      path prefixed `<tag>/`, plus the compatibility feeds installed clients
//      may still request (latest.yml, latest-linux*.yml), and the CLI pointer
//      `C/activation/latest.json`. Nothing here writes a live download
//      pointer, switches a feed, or touches the user's auto-update
//      preference — activation is a separate authorized operations step.
//   5. Packs `labrastro-feed-metadata-<version>.tar.gz` (containing
//      `activation/`), records per-target evidence in
//      `C/assets/desktop-verification.json`, and emits the inventory fragment
//      `C/assets/desktop-inventory.json` for OL-83's manifest aggregation.
//
// Candidate identity comes from the same preflight as every other
// component: LABRASTRO_RELEASE_REPOSITORY / _TAG / _SHA (or the equivalent
// --repository/--tag/--sha flags) validated by scripts/check-release.mjs
// with --require-tag. Development builds of package.mjs are not staged —
// without the release env this script refuses to run.
//
// Cross-architecture safety: every staged/activation filename is tracked;
// two targets emitting the same name with different bytes fails closed
// instead of silently overwriting one architecture with another.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
// Circular by design (see package.mjs); bindings are only used at call time.
import { checkRelease } from "../../../scripts/check-release.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

export const INTERNAL_FEED_URL = "https://multica.outlune.com/downloads/desktop";

// The first candidate matrix covers Windows/Linux, both architectures.
// macOS keeps its existing packaging contract in package.mjs and is staged
// separately once signing/notarization automation exists; absent Mac output
// must never replace the working Mac feed with an empty file.
export const DESKTOP_TARGETS = {
  "linux-x64": {
    platform: "linux",
    arch: "x64",
    goos: "linux",
    goarch: "amd64",
    unpackedDir: "linux-unpacked",
    runtimePlatform: "linux",
    installerExt: ".AppImage",
    compatibilityChannelFile: "latest-linux.yml",
  },
  "linux-arm64": {
    platform: "linux",
    arch: "arm64",
    goos: "linux",
    goarch: "arm64",
    unpackedDir: "linux-arm64-unpacked",
    runtimePlatform: "linux",
    installerExt: ".AppImage",
    compatibilityChannelFile: "latest-linux-arm64.yml",
  },
  "win-x64": {
    platform: "win",
    arch: "x64",
    goos: "windows",
    goarch: "amd64",
    unpackedDir: "win-unpacked",
    runtimePlatform: "win32",
    installerExt: ".exe",
    compatibilityChannelFile: "latest.yml",
  },
  "win-arm64": {
    platform: "win",
    arch: "arm64",
    goos: "windows",
    goarch: "arm64",
    unpackedDir: "win-arm64-unpacked",
    runtimePlatform: "win32",
    installerExt: ".exe",
    compatibilityChannelFile: "latest-arm64.yml",
  },
};

// Runtime channel pins from src/main/updater.ts. Windows arm64 and macOS x64
// clients request an explicit architecture channel; everything else follows
// the channel electron-builder resolved into app-update.yml.
const RUNTIME_CHANNEL_OVERRIDES = {
  "win-arm64": "latest-arm64",
};

function requireThat(condition, message) {
  if (!condition) throw new Error(`[stage-candidate] ${message}`);
}

// js-yaml, @electron/asar and electron-updater ship in the Desktop dependency
// tree (electron-builder/electron-updater) rather than as direct workspace
// dependencies, so resolve them through their owning packages.
export function loadDesktopModules(root = desktopRoot) {
  const rootRequire = createRequire(join(root, "package.json"));
  const updaterRequire = createRequire(
    rootRequire.resolve("electron-updater/package.json"),
  );
  const { GenericProvider } = updaterRequire(
    "./out/providers/GenericProvider.js",
  );
  const yaml = updaterRequire("js-yaml");
  const builderRequire = createRequire(
    rootRequire.resolve("electron-builder/package.json"),
  );
  const appBuilderRequire = createRequire(
    builderRequire.resolve("app-builder-lib/package.json"),
  );
  const asar = appBuilderRequire("@electron/asar");
  return { yaml, GenericProvider, asar };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function defaultGoBuildInfo(binaryPath) {
  return execFileSync("go", ["version", "-m", binaryPath], {
    encoding: "utf8",
  });
}

function defaultNativeCliVersion(binaryPath) {
  return JSON.parse(
    execFileSync(binaryPath, ["version", "--output", "json"], {
      encoding: "utf8",
    }),
  );
}

function assertSafeName(name, what = "file") {
  requireThat(
    typeof name === "string" && name === basename(name) && name !== "." && name !== "..",
    `unsafe ${what} name: ${name}`,
  );
}

// Resolve the update channel exactly the way the installed client does:
// the runtime override (updater.ts) wins, then the channel electron-builder
// resolved into app-update.yml, then the provider default for the platform.
export function resolveChannelFile(feedConfig, targetKey, modules) {
  const target = DESKTOP_TARGETS[targetKey];
  const savedTestArch = process.env.TEST_UPDATER_ARCH;
  process.env.TEST_UPDATER_ARCH = target.arch;
  try {
    const provider = new modules.GenericProvider(
      feedConfig,
      { channel: RUNTIME_CHANNEL_OVERRIDES[targetKey] ?? null },
      { platform: target.runtimePlatform, executor: {} },
    );
    return `${provider.channel}.yml`;
  } finally {
    if (savedTestArch === undefined) delete process.env.TEST_UPDATER_ARCH;
    else process.env.TEST_UPDATER_ARCH = savedTestArch;
  }
}

/**
 * Verify one packaged target directory and return everything staging needs:
 * the generated channel YAML (parsed), its filename, the list of deliverable
 * files and the per-target evidence record.
 */
export function verifyTarget(targetKey, options) {
  const target = DESKTOP_TARGETS[targetKey];
  requireThat(target, `unknown target "${targetKey}"`);
  const {
    metadata,
    distRoot,
    modules,
    goBuildInfo = defaultGoBuildInfo,
    nativeCliVersion = defaultNativeCliVersion,
    host = { goos: { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform], goarch: { x64: "amd64", arm64: "arm64" }[process.arch] },
  } = options;
  const version = metadata.version;
  const dir = join(distRoot, targetKey);
  requireThat(existsSync(dir), `missing package output directory ${dir}`);

  // --- Unpacked application ------------------------------------------------
  const resources = join(dir, target.unpackedDir, "resources");
  const asarPath = join(resources, "app.asar");
  requireThat(existsSync(asarPath), `missing ${asarPath}`);
  const pkg = JSON.parse(modules.asar.extractFile(asarPath, "package.json"));
  requireThat(
    pkg.version === version,
    `app.asar version ${pkg.version} does not match candidate ${version}`,
  );
  requireThat(
    pkg.productName === "Labrastro",
    `app.asar productName "${pkg.productName}" is not Labrastro`,
  );
  for (const name of ["LICENSE", "NOTICE"]) {
    const notice = join(resources, name);
    requireThat(
      existsSync(notice) && statSync(notice).size > 0,
      `packaged app is missing ${name}`,
    );
  }

  // --- Bundled CLI ---------------------------------------------------------
  const cliName = target.platform === "win" ? "multica.exe" : "multica";
  const cliPath = join(
    resources,
    "app.asar.unpacked",
    "resources",
    "bin",
    cliName,
  );
  requireThat(existsSync(cliPath), `bundled CLI missing at ${cliPath}`);
  const info = goBuildInfo(cliPath);
  const toolchain = /:\s*(go[0-9.]+)/m.exec(info)?.[1] ?? null;
  const expectations = [
    [`main.version=${version}`, "bundled CLI version"],
    [`main.commit=${metadata.commit}`, "bundled CLI commit"],
    [`GOOS=${target.goos}`, "bundled CLI GOOS"],
    [`GOARCH=${target.goarch}`, "bundled CLI GOARCH"],
    [`vcs.revision=${metadata.commit}`, "bundled CLI vcs revision"],
    ["vcs.modified=false", "bundled CLI built from a clean tree"],
  ];
  for (const [needle, what] of expectations) {
    requireThat(info.includes(needle), `${what} mismatch: expected "${needle}" in go build info`);
  }

  const evidence = {
    version,
    commit: metadata.commit,
    toolchain,
    bundled_cli_verified: true,
    installer_hashes_verified: false,
    metadata_paths_verified: false,
    // Signing/notarization are outside the OL-81 matrix; the smoke and
    // signature fields record facts, never assumptions.
    signed: null,
    native_app_smoke: false,
  };
  if (host.goos === target.goos && host.goarch === target.goarch) {
    const native = nativeCliVersion(cliPath);
    requireThat(
      native.version === version,
      `native bundled CLI reports version ${native.version}, expected ${version}`,
    );
    requireThat(
      native.commit === metadata.commit,
      `native bundled CLI reports commit ${native.commit}, expected ${metadata.commit}`,
    );
    evidence.native_bundled_cli = native;
  } else {
    evidence.native_bundled_cli = "skipped (host platform/arch differs)";
  }

  // --- Update metadata -----------------------------------------------------
  const appUpdatePath = join(resources, "app-update.yml");
  requireThat(existsSync(appUpdatePath), `missing ${appUpdatePath}`);
  const feedConfig = modules.yaml.load(readFileSync(appUpdatePath, "utf8"));
  requireThat(
    feedConfig.provider === "generic",
    `app-update.yml provider must stay generic, got ${feedConfig.provider}`,
  );
  requireThat(
    feedConfig.url === INTERNAL_FEED_URL,
    `app-update.yml url must stay ${INTERNAL_FEED_URL}, got ${feedConfig.url}`,
  );
  const channelFile = resolveChannelFile(feedConfig, targetKey, modules);
  const channelPath = join(dir, channelFile);
  requireThat(
    existsSync(channelPath),
    `electron-builder did not generate the resolved channel file ${channelFile}`,
  );
  const generated = modules.yaml.load(readFileSync(channelPath, "utf8"));
  requireThat(
    generated.version === version,
    `${channelFile} version ${generated.version} does not match candidate ${version}`,
  );
  requireThat(
    Array.isArray(generated.files) && generated.files.length > 0,
    `${channelFile} lists no files`,
  );
  const referencedUrls = new Set();
  for (const file of generated.files) {
    assertSafeName(file.url, "update metadata");
    referencedUrls.add(file.url);
    const installer = join(dir, file.url);
    requireThat(existsSync(installer), `${channelFile} references missing file ${file.url}`);
    const bytes = readFileSync(installer);
    requireThat(
      file.size === bytes.length,
      `${channelFile} size mismatch for ${file.url}: metadata ${file.size}, actual ${bytes.length}`,
    );
    requireThat(
      file.sha512 === createHash("sha512").update(bytes).digest("base64"),
      `${channelFile} sha512 mismatch for ${file.url}`,
    );
  }
  assertSafeName(generated.path, "update metadata path");
  requireThat(
    referencedUrls.has(generated.path),
    `${channelFile} path ${generated.path} is not one of its files`,
  );

  // --- Collect deliverable files -------------------------------------------
  const files = readdirSync(dir)
    .filter(
      (name) =>
        /\.(AppImage|exe|blockmap|yml)$/.test(name) && !name.startsWith("builder-"),
    )
    .sort();
  requireThat(
    files.some((name) => name.endsWith(target.installerExt)),
    `no ${target.installerExt} installer in ${dir}`,
  );
  requireThat(
    files.includes(channelFile),
    `channel file ${channelFile} missing from collected files in ${dir}`,
  );
  // Installer and blockmap names carry the candidate version; a stale or
  // foreign file in the output directory fails here instead of shipping.
  for (const name of files) {
    assertSafeName(name);
    if (/\.(AppImage|exe|blockmap)$/.test(name)) {
      requireThat(
        name.includes(version),
        `${name} does not carry candidate version ${version}`,
      );
    }
  }
  for (const name of files) {
    if (name.endsWith(target.installerExt) && existsSync(join(dir, `${name}.blockmap`))) {
      requireThat(
        files.includes(`${name}.blockmap`),
        `blockmap for ${name} was not collected`,
      );
    }
  }

  evidence.channel = channelFile;
  evidence.compatibility_channel = DESKTOP_TARGETS[targetKey].compatibilityChannelFile;
  evidence.installer_hashes_verified = true;
  evidence.metadata_paths_verified = true;
  evidence.files = files;
  return { dir, feedConfig, channelFile, generated, files, evidence };
}

function copyUnlessConflict(source, target) {
  if (existsSync(target)) {
    const a = readFileSync(source);
    const b = readFileSync(target);
    requireThat(
      a.equals(b),
      `refusing to overwrite ${target} with different content (cross-architecture collision?)`,
    );
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function buildArtifactEntry({ name, filePath, downloadPath, component, os, arch }) {
  assertSafeName(name, "artifact");
  const normalized = downloadPath.replaceAll("\\", "/");
  requireThat(
    !normalized.startsWith("/") && !normalized.split("/").includes(".."),
    `unsafe download path ${downloadPath}`,
  );
  const bytes = statSync(filePath).size;
  requireThat(bytes > 0, `${name} is empty`);
  return {
    name,
    path: `assets/${name}`,
    download_path: normalized,
    bytes,
    sha256: sha256File(filePath),
    component,
    ...(os ? { os } : {}),
    ...(arch ? { arch } : {}),
  };
}

/**
 * Stage every requested target into the artifact root and produce the
 * activation bundle, evidence and inventory fragment. Returns
 * { evidence, artifacts } for inspection/tests.
 */
export function stageDesktopCandidate(options) {
  const {
    metadata,
    artifactDir,
    distRoot = join(desktopRoot, "dist"),
    targets = Object.keys(DESKTOP_TARGETS),
    modules = loadDesktopModules(),
    goBuildInfo,
    nativeCliVersion,
    host,
  } = options;
  const { tag, version } = metadata;
  requireThat(
    typeof tag === "string" && /^v\d+\.\d+\.\d+-labrastro\.\d+$/.test(tag),
    `metadata tag ${tag} is not a Labrastro candidate tag`,
  );
  requireThat(
    version === tag.slice(1),
    `metadata version ${version} does not match tag ${tag}`,
  );
  const unknown = targets.filter((key) => !DESKTOP_TARGETS[key]);
  requireThat(unknown.length === 0, `unknown target(s): ${unknown.join(", ")}`);

  const assetsDir = join(artifactDir, "assets");
  const versionDir = join(artifactDir, "downloads", "desktop", tag);
  const activationDir = join(artifactDir, "activation");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(versionDir, { recursive: true });
  mkdirSync(join(activationDir, "desktop"), { recursive: true });

  const evidence = {};
  const artifacts = [];
  const stagedHashes = new Map(); // flat asset name → sha256, collision guard
  const activationHashes = new Map(); // activation/desktop name → sha256

  const stageFile = (name, filePath, { component, os, arch, downloadPath }) => {
    const target = join(versionDir, name);
    copyUnlessConflict(filePath, target);
    const flat = join(assetsDir, name);
    copyUnlessConflict(filePath, flat);
    const entry = buildArtifactEntry({
      name,
      filePath: flat,
      downloadPath: downloadPath ?? `desktop/${tag}/${name}`,
      component,
      os,
      arch,
    });
    const previous = stagedHashes.get(name);
    if (previous && previous !== entry.sha256) {
      throw new Error(
        `[stage-candidate] ${name} staged twice with different content`,
      );
    }
    if (!previous) {
      stagedHashes.set(name, entry.sha256);
      artifacts.push(entry);
    }
  };

  for (const targetKey of targets) {
    const target = DESKTOP_TARGETS[targetKey];
    const result = verifyTarget(targetKey, {
      metadata,
      distRoot,
      modules,
      goBuildInfo,
      nativeCliVersion,
      host,
    });
    evidence[targetKey] = result.evidence;

    for (const name of result.files) {
      stageFile(name, join(result.dir, name), {
        component: "desktop",
        os: target.goos,
        arch: target.goarch,
      });
    }

    // Proposed root feed: same metadata with every reference prefixed by the
    // version directory. Verified through the real updater resolution below.
    const staged = structuredClone(result.generated);
    staged.path = `${tag}/${staged.path}`;
    for (const file of staged.files) file.url = `${tag}/${file.url}`;
    const serialized = modules.yaml.dump(staged);
    const feedNames = new Set([
      result.channelFile,
      target.compatibilityChannelFile,
    ]);
    for (const feedName of feedNames) {
      const feedPath = join(activationDir, "desktop", feedName);
      const digest = createHash("sha256").update(serialized).digest("hex");
      const previous = activationHashes.get(feedName);
      requireThat(
        !previous || previous === digest,
        `activation feed ${feedName} would be written twice with different content`,
      );
      if (previous) continue;
      activationHashes.set(feedName, digest);
      writeFileSync(feedPath, serialized);
    }

    // Resolve the proposed feed through the real GenericProvider and check
    // every reference points inside the staged version directory.
    const provider = new modules.GenericProvider(
      result.feedConfig,
      { channel: RUNTIME_CHANNEL_OVERRIDES[targetKey] ?? null },
      { platform: target.runtimePlatform, executor: {} },
    );
    for (const resolved of provider.resolveFiles(staged)) {
      const pathname = resolved.url.pathname;
      requireThat(
        pathname.startsWith(`/downloads/desktop/${tag}/`),
        `feed reference ${pathname} escapes the version directory`,
      );
      const local = join(versionDir, basename(pathname));
      requireThat(
        existsSync(local),
        `feed reference ${pathname} has no staged file`,
      );
    }
  }

  // Proposed CLI pointer. Same shape the internal source serves today; the
  // CLI version directory itself is OL-80's deliverable.
  writeFileSync(
    join(activationDir, "latest.json"),
    `${JSON.stringify({ version: tag })}`,
  );

  // Per-target evidence, then the feed metadata archive, then the inventory —
  // in that order, so the archive and the evidence are ordinary artifacts.
  const evidencePath = join(assetsDir, "desktop-verification.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  artifacts.push(
    buildArtifactEntry({
      name: "desktop-verification.json",
      filePath: evidencePath,
      downloadPath: `releases/${tag}/desktop-verification.json`,
      component: "desktop",
    }),
  );

  const feedName = `labrastro-feed-metadata-${version}.tar.gz`;
  const feedPath = join(assetsDir, feedName);
  rmSync(feedPath, { force: true });
  execFileSync("tar", ["-czf", feedPath, "-C", artifactDir, "activation"]);
  // The archive must unpack to exactly the activation tree we verified.
  const listing = execFileSync("tar", ["-tzf", feedPath], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
  const expectedMembers = [
    "activation/",
    "activation/desktop/",
    ...[...activationHashes.keys()].sort().map((name) => `activation/desktop/${name}`),
    "activation/latest.json",
  ].sort();
  requireThat(
    JSON.stringify(listing) === JSON.stringify(expectedMembers),
    `feed metadata archive members differ: ${listing.join(", ")}`,
  );
  copyUnlessConflict(
    feedPath,
    join(artifactDir, "downloads", "releases", tag, feedName),
  );
  artifacts.push(
    buildArtifactEntry({
      name: feedName,
      filePath: feedPath,
      downloadPath: `releases/${tag}/${feedName}`,
      component: "feed",
    }),
  );

  const inventoryPath = join(assetsDir, "desktop-inventory.json");
  writeFileSync(
    inventoryPath,
    `${JSON.stringify({ component: "desktop", tag, version, commit: metadata.commit, artifacts }, null, 2)}\n`,
  );

  return { evidence, artifacts };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repository: { type: "string", default: process.env.LABRASTRO_RELEASE_REPOSITORY },
      tag: { type: "string", default: process.env.LABRASTRO_RELEASE_TAG },
      sha: { type: "string", default: process.env.LABRASTRO_RELEASE_SHA },
      mode: { type: "string", default: process.env.LABRASTRO_RELEASE_MODE ?? "candidate" },
    },
  });
  const targets =
    positionals.length > 0 ? positionals : Object.keys(DESKTOP_TARGETS);
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
  const { evidence, artifacts } = stageDesktopCandidate({
    metadata,
    artifactDir,
    targets,
  });
  console.log(
    JSON.stringify(
      {
        tag: metadata.tag,
        version: metadata.version,
        artifact_dir: metadata.artifact_dir,
        targets: Object.keys(evidence),
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
