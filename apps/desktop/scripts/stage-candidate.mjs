#!/usr/bin/env node
// Verify completed electron-builder output and stage it into the candidate
// handoff root (`dist/candidate/<tag>/`, "C") for the aggregation pipeline.
//
// What this script does, per Desktop target:
//   1. Verifies the unpacked app: app.asar package.json carries the candidate
//      version and Labrastro productName, LICENSE/NOTICE shipped, and the
//      bundled CLI's Go build info matches the target's platform, arch and
//      the reviewed version/full-SHA identity (exact parsed values, never
//      substring prefixes).
//   2. Verifies EVERY generated update-metadata YAML next to the installers
//      — version, referenced file presence, size and base64 SHA-512 — and
//      the resolved channel through the real electron-updater
//      GenericProvider, so the channel filename is the one an installed
//      client resolves. Windows installers must carry their differential
//      blockmap, checked against the installer's actual size.
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
// Incremental staging: targets may be staged in several invocations into the
// same artifact root (e.g. Linux first, Windows after a separate package
// run), because each `package.mjs` invocation cleans apps/desktop/dist.
// Previously staged targets are re-verified from disk (hashes, feed
// references) and merged; evidence, inventory and the feed archive are only
// rewritten after every check passed, so a failed run never corrupts the
// earlier staged delivery.
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
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
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
    blockmapRequired: false,
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
    blockmapRequired: false,
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
    blockmapRequired: true,
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
    blockmapRequired: true,
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

// js-yaml and @electron/asar are declared dev dependencies of this package;
// electron-updater (a runtime dependency) has no exports map, so its provider
// module resolves directly.
export function loadDesktopModules(root = desktopRoot) {
  const rootRequire = createRequire(join(root, "package.json"));
  const yaml = rootRequire("js-yaml");
  const asar = rootRequire("@electron/asar");
  const { GenericProvider } = rootRequire(
    "electron-updater/out/providers/GenericProvider.js",
  );
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

/**
 * Parse one `go version -m` build setting. Lines are "\tbuild\tKEY=VALUE";
 * the ldflags line carries every -X flag in a single quoted string. Values
 * are compared EXACTLY — 0.4.43-labrastro.2 must not match
 * 0.4.43-labrastro.20 by prefix.
 */
export function goBuildSetting(info, key) {
  for (const line of info.split("\n")) {
    if (!line.startsWith("\tbuild\t")) continue;
    const body = line.slice("\tbuild\t".length);
    if (body.startsWith("-ldflags=")) {
      const match = body.match(
        new RegExp(`(?:^|[\\s"])-X\\s?${key.replace(".", "\\.")}=([^\\s"]+)`),
      );
      if (match) return match[1];
      continue;
    }
    if (body.startsWith(`${key}=`)) return body.slice(key.length + 1);
  }
  return null;
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
 * Validate one update-metadata YAML against the files sitting next to it:
 * candidate version, safe references, presence, size and base64 SHA-512.
 * `fileBaseDir` is where referenced urls must live. When `urlPrefix` is set
 * (proposed root feeds), every reference must carry that prefix; it is
 * stripped before resolving against `fileBaseDir`. Returns the parsed
 * document for further use.
 */
export function verifyUpdateMetadataFile(ymlPath, fileBaseDir, version, modules, { urlPrefix = "" } = {}) {
  const name = basename(ymlPath);
  let generated;
  try {
    generated = modules.yaml.load(readFileSync(ymlPath, "utf8"));
  } catch (error) {
    throw new Error(`[stage-candidate] ${name} is not valid YAML: ${error.message}`);
  }
  requireThat(
    generated && typeof generated === "object",
    `${name} does not contain an update metadata object`,
  );
  requireThat(
    generated.version === version,
    `${name} version ${generated.version} does not match candidate ${version}`,
  );
  requireThat(
    Array.isArray(generated.files) && generated.files.length > 0,
    `${name} lists no files`,
  );
  const resolveReference = (url) => {
    requireThat(
      typeof url === "string" && url.startsWith(urlPrefix) && !url.includes(".."),
      `${name} reference ${url} does not carry the required prefix "${urlPrefix}" or is unsafe`,
    );
    return url.slice(urlPrefix.length);
  };
  const referencedUrls = new Set();
  for (const file of generated.files) {
    const url = resolveReference(file.url);
    assertSafeName(url, "update metadata");
    referencedUrls.add(url);
    const installer = join(fileBaseDir, url);
    requireThat(existsSync(installer), `${name} references missing file ${file.url}`);
    const bytes = readFileSync(installer);
    requireThat(
      file.size === bytes.length,
      `${name} size mismatch for ${file.url}: metadata ${file.size}, actual ${bytes.length}`,
    );
    requireThat(
      file.sha512 === createHash("sha512").update(bytes).digest("base64"),
      `${name} sha512 mismatch for ${file.url}`,
    );
  }
  const mainReference = resolveReference(generated.path);
  assertSafeName(mainReference, "update metadata path");
  requireThat(
    referencedUrls.has(mainReference),
    `${name} path ${generated.path} is not one of its files`,
  );
  return generated;
}

// The app-builder binary electron-builder itself uses to build blockmaps,
// resolved through the declared app-builder-bin dependency.
let appBuilderBinPath = null;
export function resolveAppBuilderBin(root = desktopRoot) {
  if (appBuilderBinPath) return appBuilderBinPath;
  const rootRequire = createRequire(join(root, "package.json"));
  appBuilderBinPath = rootRequire("app-builder-bin").appBuilderPath;
  return appBuilderBinPath;
}

function gunzipJson(path) {
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
}

// Recompute the installer's blockmap with the real app-builder binary and
// return the decompressed block map.
export function recomputeBlockmap(installerPath, { binary, tmpDir } = {}) {
  const bin = binary ?? resolveAppBuilderBin();
  const tmp = join(
    tmpDir ?? mkdtempSync(join(tmpdir(), "blockmap-check-")),
    "recomputed.blockmap",
  );
  execFileSync(bin, ["blockmap", "--input", installerPath, "--output", tmp], {
    encoding: "utf8",
  });
  return gunzipJson(tmp);
}

/**
 * A differential-update blockmap must exist for Windows NSIS installers and
 * describe the installer's actual content: gzip-compressed JSON whose block
 * size list sums to the installer size, one checksum per block — and whose
 * complete structure (container version, per-file name, offset and block
 * list) matches a fresh app-builder recomputation, so a blockmap from
 * another build of the same length, or one with a corrupted offset that
 * would send a download plan out of range, cannot pass. (AppImage does not
 * emit blockmaps; when one is present it is validated the same way.)
 */
export function verifyBlockmap(blockmapPath, installerPath, { recompute = recomputeBlockmap } = {}) {
  const name = basename(blockmapPath);
  let parsed;
  try {
    parsed = gunzipJson(blockmapPath);
  } catch {
    throw new Error(`[stage-candidate] ${name} is not a valid gzip-compressed blockmap`);
  }
  requireThat(
    parsed && Array.isArray(parsed.files) && parsed.files.length > 0,
    `${name} contains no file entries`,
  );
  const installerSize = statSync(installerPath).size;
  let total = 0;
  for (const entry of parsed.files) {
    requireThat(
      Array.isArray(entry.sizes) && Array.isArray(entry.checksums) &&
        entry.sizes.length > 0 && entry.sizes.length === entry.checksums.length,
      `${name} has a malformed block list`,
    );
    requireThat(
      Number.isSafeInteger(entry.offset) && entry.offset >= 0,
      `${name} has a malformed offset`,
    );
    total += entry.sizes.reduce((sum, size) => sum + size, 0);
    requireThat(
      entry.offset + entry.sizes.reduce((sum, size) => sum + size, 0) <= installerSize,
      `${name} block range exceeds the installer size`,
    );
  }
  requireThat(
    total === installerSize,
    `${name} block sizes sum to ${total}, installer is ${installerSize} bytes`,
  );
  const recomputed = recompute(installerPath);
  const summarize = (blockmap) =>
    JSON.stringify({
      version: blockmap.version ?? null,
      files: (blockmap.files ?? []).map((entry) => ({
        name: entry.name,
        offset: entry.offset,
        sizes: entry.sizes,
        checksums: entry.checksums,
      })),
    });
  requireThat(
    summarize(parsed) === summarize(recomputed),
    `${name} block map does not match the installer content`,
  );
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
  const cliVersion = goBuildSetting(info, "main.version");
  requireThat(
    cliVersion === version,
    `bundled CLI version "${cliVersion}" does not exactly match candidate ${version}`,
  );
  const cliCommit = goBuildSetting(info, "main.commit");
  requireThat(
    cliCommit === metadata.commit,
    `bundled CLI commit "${cliCommit}" does not exactly match candidate ${metadata.commit}`,
  );
  const expectations = [
    ["GOOS", target.goos, "bundled CLI GOOS"],
    ["GOARCH", target.goarch, "bundled CLI GOARCH"],
    ["vcs.revision", metadata.commit, "bundled CLI vcs revision"],
    ["vcs.modified", "false", "bundled CLI built from a clean tree"],
  ];
  for (const [key, expected, what] of expectations) {
    requireThat(
      goBuildSetting(info, key) === expected,
      `${what} mismatch: expected build setting ${key}=${expected}`,
    );
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
  const generated = verifyUpdateMetadataFile(channelPath, dir, version, modules);

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
  // Every additional channel YAML is validated exactly like the resolved
  // channel — an unverified metadata file must never ride along (RELEASING.md
  // requires preserving AND verifying all generated channel files).
  for (const name of files) {
    if (name.endsWith(".yml") && name !== channelFile) {
      verifyUpdateMetadataFile(join(dir, name), dir, version, modules);
    }
  }
  // Differential blockmaps: required for Windows NSIS, validated whenever
  // present elsewhere.
  for (const name of files) {
    if (!name.endsWith(target.installerExt)) continue;
    const blockmapName = `${name}.blockmap`;
    if (target.blockmapRequired) {
      requireThat(
        files.includes(blockmapName),
        `missing differential blockmap ${blockmapName} (NSIS differential updates need it)`,
      );
    }
    if (files.includes(blockmapName)) {
      verifyBlockmap(join(dir, blockmapName), join(dir, name));
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

function writeFileAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// Members GNU tar lists for a directory tree: dirs with trailing slash,
// files plain, both in traversal order (sorted here for comparison).
function activationMembers(activationDir) {
  const members = ["activation/"];
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        members.push(`${rel}/`);
        walk(join(dir, entry.name), `${rel}/`);
      } else {
        members.push(rel);
      }
    }
  };
  walk(activationDir, "activation/");
  return members.sort();
}

// --- Minimal deterministic ustar writer -----------------------------------
// Writes a standard ustar/gzip archive with sorted members, uid/gid 0 and
// zero mtimes (Node's gzip emits a zero header mtime), so identical content
// yields byte-identical archives on ANY host — no dependence on GNU tar
// flags that bsdtar (the tar Windows ships) rejects.

function tarOctal(value, length) {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function tarHeader({ name, mode, size, type }) {
  const nameBytes = Buffer.from(name, "utf8");
  requireThat(nameBytes.length <= 100, `tar member name too long: ${name}`);
  const header = Buffer.alloc(512, 0);
  nameBytes.copy(header, 0);
  header.write(tarOctal(mode, 8), 100, "ascii");
  header.write(tarOctal(0, 8), 108, "ascii"); // uid
  header.write(tarOctal(0, 8), 116, "ascii"); // gid
  header.write(tarOctal(size, 12), 124, "ascii");
  header.write(tarOctal(0, 12), 136, "ascii"); // mtime 0
  header.fill(" ", 148, 156); // checksum computed over spaces
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}

export function createDeterministicTarGz(rootDir, rootName) {
  const members = activationMembers(rootDir).map((rel) => ({
    rel,
    abs: join(rootDir, rel.slice(rootName.length + 1)),
  }));
  const chunks = [];
  for (const member of members) {
    const isDir = member.rel.endsWith("/");
    const content = isDir ? null : readFileSync(member.abs);
    chunks.push(
      tarHeader({
        name: member.rel,
        mode: isDir ? 0o755 : 0o644,
        size: isDir ? 0 : content.length,
        type: isDir ? "5" : "0",
      }),
    );
    if (!isDir) {
      chunks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

// In-process read-back used to verify the produced archive: lists member
// names in the same shape as activationMembers (dirs keep their slash).
export function listTarGzMembers(buffer) {
  const data = gunzipSync(buffer);
  const names = [];
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/, "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names.sort();
}

/**
 * Re-validate the complete activation tree against the staged version
 * directory and the MERGED target set: every proposed feed parses, names
 * the candidate version, and every reference resolves to a staged file with
 * matching size and SHA-512. Beyond that, the channels required by ALL
 * merged targets must exist, and each channel's references must name
 * exactly the installer set its owning target produced — a deleted prior
 * channel, or one switched to another architecture's installer, fails here.
 */
export function verifyActivationTree(activationDir, versionDir, tag, version, modules, mergedEvidence) {
  const desktopDir = join(activationDir, "desktop");
  const feeds = existsSync(desktopDir)
    ? readdirSync(desktopDir).filter((name) => name.endsWith(".yml")).sort()
    : [];
  requireThat(feeds.length > 0, "no proposed desktop feeds were written");
  for (const name of feeds) {
    // Proposed root feeds must point INSIDE the version directory; the
    // prefix is required and then stripped for the byte-level checks.
    verifyUpdateMetadataFile(join(desktopDir, name), versionDir, version, modules, {
      urlPrefix: `${tag}/`,
    });
  }
  const requiredFeeds = new Map(); // feed file → owning target key
  for (const [targetKey, record] of Object.entries(mergedEvidence)) {
    for (const name of [record.channel, record.compatibility_channel]) {
      requireThat(typeof name === "string" && name.length > 0, `target ${targetKey} has no channel record`);
      requireThat(
        !requiredFeeds.has(name) || requiredFeeds.get(name) === targetKey,
        `channel ${name} is claimed by two targets`,
      );
      requiredFeeds.set(name, targetKey);
    }
  }
  for (const [name, targetKey] of requiredFeeds) {
    const feedPath = join(desktopDir, name);
    requireThat(
      existsSync(feedPath),
      `merged target ${targetKey} requires activation feed ${name}, but it is missing`,
    );
    const feed = verifyUpdateMetadataFile(feedPath, versionDir, version, modules, {
      urlPrefix: `${tag}/`,
    });
    // The feed must serve its OWN target's installers — the same file set
    // that target's generated channel YAML staged into the version dir.
    const ownChannel = verifyUpdateMetadataFile(
      join(versionDir, mergedEvidence[targetKey].channel),
      versionDir,
      version,
      modules,
    );
    const ownFiles = new Set(ownChannel.files.map((file) => file.url));
    const feedFiles = new Set(feed.files.map((file) => file.url.slice(`${tag}/`.length)));
    requireThat(
      ownFiles.size === feedFiles.size && [...ownFiles].every((file) => feedFiles.has(file)),
      `activation feed ${name} references ${[...feedFiles].join(", ")} ` +
        `but target ${targetKey} owns ${[...ownFiles].join(", ")}`,
    );
  }
  const latest = JSON.parse(readFileSync(join(activationDir, "latest.json"), "utf8"));
  requireThat(
    latest.version === tag,
    `activation/latest.json version ${latest.version} does not match tag ${tag}`,
  );
  return feeds;
}

/**
 * Stage every requested target into the artifact root and produce the
 * activation bundle, evidence and inventory fragment. Safe to invoke
 * repeatedly for different target subsets against the same artifact root:
 * prior targets are re-verified and merged, and the merged evidence,
 * inventory and feed archive are written only after all checks pass.
 * Returns { evidence, artifacts } for inspection/tests.
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
  requireThat(targets.length > 0, "no targets requested");

  const assetsDir = join(artifactDir, "assets");
  const versionDir = join(artifactDir, "downloads", "desktop", tag);
  const activationDir = join(artifactDir, "activation");
  const evidencePath = join(assetsDir, "desktop-verification.json");
  const inventoryPath = join(assetsDir, "desktop-inventory.json");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(versionDir, { recursive: true });
  mkdirSync(join(activationDir, "desktop"), { recursive: true });

  // --- Load and re-verify prior staged state (incremental runs) -----------
  let priorEvidence = {};
  let priorArtifacts = [];
  const hasPriorEvidence = existsSync(evidencePath);
  const hasPriorInventory = existsSync(inventoryPath);
  requireThat(
    hasPriorEvidence === hasPriorInventory,
    "partial prior state (evidence without inventory or vice versa); clean the artifact dir",
  );
  if (hasPriorInventory) {
    priorEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const priorInventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    requireThat(
      priorInventory.tag === tag &&
        priorInventory.version === version &&
        priorInventory.commit === metadata.commit,
      "existing inventory belongs to a different candidate; use a fresh artifact dir",
    );
    priorArtifacts = priorInventory.artifacts ?? [];
    for (const artifact of priorArtifacts) {
      // Evidence and the feed archive are regenerated below; skip them here.
      if (artifact.name === "desktop-verification.json" || artifact.name.endsWith(".tar.gz")) continue;
      const flat = join(assetsDir, artifact.name);
      requireThat(
        existsSync(flat) &&
          statSync(flat).size === artifact.bytes &&
          sha256File(flat) === artifact.sha256,
        `previously staged asset ${artifact.name} is missing or changed`,
      );
      if (artifact.download_path.startsWith(`desktop/${tag}/`)) {
        const stagedCopy = join(versionDir, artifact.name);
        requireThat(
          existsSync(stagedCopy) && sha256File(stagedCopy) === artifact.sha256,
          `previously staged download ${artifact.name} is missing or changed`,
        );
      }
    }
  }

  // --- Verify every requested target BEFORE writing anything --------------
  const verified = targets.map((targetKey) => [
    targetKey,
    verifyTarget(targetKey, {
      metadata,
      distRoot,
      modules,
      goBuildInfo,
      nativeCliVersion,
      host,
    }),
  ]);

  // --- Copy deliverables (content-guarded against cross-arch overwrites) --
  const newArtifacts = [];
  for (const [targetKey, result] of verified) {
    const target = DESKTOP_TARGETS[targetKey];
    for (const name of result.files) {
      const source = join(result.dir, name);
      copyUnlessConflict(source, join(versionDir, name));
      copyUnlessConflict(source, join(assetsDir, name));
      const entry = buildArtifactEntry({
        name,
        filePath: join(assetsDir, name),
        downloadPath: `desktop/${tag}/${name}`,
        component: "desktop",
        os: target.goos,
        arch: target.goarch,
      });
      const prior = priorArtifacts.find((a) => a.name === name);
      requireThat(
        !prior || prior.sha256 === entry.sha256,
        `${name} was staged before with different content`,
      );
      if (!newArtifacts.some((a) => a.name === name)) newArtifacts.push(entry);
    }
  }

  // --- Write this run's proposed feeds ------------------------------------
  for (const [targetKey, result] of verified) {
    const target = DESKTOP_TARGETS[targetKey];
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
      if (existsSync(feedPath)) {
        requireThat(
          readFileSync(feedPath, "utf8") === serialized,
          `activation feed ${feedName} would be rewritten with different content`,
        );
        continue;
      }
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
      requireThat(
        existsSync(join(versionDir, basename(pathname))),
        `feed reference ${pathname} has no staged file`,
      );
    }
  }

  // Proposed CLI pointer. Same shape the internal source serves today; the
  // CLI version directory itself is OL-80's deliverable. Unchanged content
  // is never rewritten, keeping retries byte-identical.
  const latestPath = join(activationDir, "latest.json");
  const latestContent = `${JSON.stringify({ version: tag })}`;
  if (!existsSync(latestPath) || readFileSync(latestPath, "utf8") !== latestContent) {
    writeFileAtomic(latestPath, latestContent);
  }

  // --- Re-validate the MERGED activation tree ------------------------------
  const mergedEvidence = {
    ...priorEvidence,
    ...Object.fromEntries(verified.map(([targetKey, result]) => [targetKey, result.evidence])),
  };
  verifyActivationTree(activationDir, versionDir, tag, version, modules, mergedEvidence);

  // --- Feed metadata archive over the complete activation tree -------------
  // Deterministic AND portable: the archive is written by a small in-repo
  // ustar implementation (sorted members, uid/gid 0, mtime 0, gzip with a
  // zero header mtime). No system tar/gzip is required — GNU tar, bsdtar
  // (the Windows built-in) or none at all — and a retry of the same staged
  // content yields the byte-identical archive.
  const feedName = `labrastro-feed-metadata-${version}.tar.gz`;
  const feedPath = join(assetsDir, feedName);
  const tmpFeed = `${feedPath}.tmp-${process.pid}`;
  rmSync(tmpFeed, { force: true });
  const archive = createDeterministicTarGz(activationDir, "activation");
  const expected = activationMembers(activationDir);
  const listing = listTarGzMembers(archive);
  requireThat(
    JSON.stringify(listing) === JSON.stringify(expected),
    `feed metadata archive members differ: ${listing.join(", ")}`,
  );
  writeFileSync(tmpFeed, archive);
  renameSync(tmpFeed, feedPath);
  // The archive and evidence are regenerated from the merged tree on every
  // run — their version-directory copies are replaced, not conflict-checked.
  const releaseDir = join(artifactDir, "downloads", "releases", tag);
  mkdirSync(releaseDir, { recursive: true });
  copyFileSync(feedPath, join(releaseDir, feedName));

  // --- Merged evidence + inventory, written last ----------------------------
  const evidence = mergedEvidence;
  writeFileAtomic(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  copyFileSync(evidencePath, join(releaseDir, "desktop-verification.json"));

  const mergedArtifacts = [
    ...priorArtifacts.filter(
      (a) => a.name !== "desktop-verification.json" && !a.name.endsWith(".tar.gz"),
    ),
  ];
  for (const entry of newArtifacts) {
    if (!mergedArtifacts.some((a) => a.name === entry.name)) {
      mergedArtifacts.push(entry);
    }
  }
  mergedArtifacts.push(
    buildArtifactEntry({
      name: "desktop-verification.json",
      filePath: evidencePath,
      downloadPath: `releases/${tag}/desktop-verification.json`,
      component: "desktop",
    }),
    buildArtifactEntry({
      name: feedName,
      filePath: feedPath,
      downloadPath: `releases/${tag}/${feedName}`,
      component: "feed",
    }),
  );
  mergedArtifacts.sort((a, b) => a.name.localeCompare(b.name));
  writeFileAtomic(
    inventoryPath,
    `${JSON.stringify({ component: "desktop", tag, version, commit: metadata.commit, artifacts: mergedArtifacts }, null, 2)}\n`,
  );

  return { evidence, artifacts: mergedArtifacts };
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
