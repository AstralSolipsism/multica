// Tests for the Web candidate build entry. The Next.js build itself is not
// run here; assembly, freshness and version-proof checks run against fixture
// standalone trees in a temp dir.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assembleWebCandidate,
  buildWebStandalone,
  verifyStandaloneBuild,
  webArchiveName,
} from "./build-candidate-web.mjs";

const TAG = "v0.4.43-labrastro.2";
const VERSION = "0.4.43-labrastro.2";
const SHA = "b".repeat(40);

function metadata() {
  return {
    repository: "AstralSolipsism/multica",
    tag: TAG,
    version: VERSION,
    commit: SHA,
    mode: "candidate",
    tag_exists: true,
    artifact_dir: `dist/candidate/${TAG}`,
  };
}

function fixture(t, { version = VERSION, buildId = "probe-build-id", clientVersion = version } = {}) {
  const root = mkdtempSync(join(tmpdir(), "web-candidate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const webRoot = join(root, "apps", "web");
  const nextDir = join(webRoot, ".next");
  const standalone = join(nextDir, "standalone", "apps", "web");
  mkdirSync(standalone, { recursive: true });
  writeFileSync(join(standalone, "server.js"), `// ${version}\n`);
  mkdirSync(join(nextDir, "standalone", "apps", "web", ".next", "server"), {
    recursive: true,
  });
  writeFileSync(
    join(nextDir, "standalone", "apps", "web", ".next", "server", "chunk.js"),
    `exports.appVersion="${version}";\n`,
  );
  mkdirSync(join(nextDir, "static", "chunks"), { recursive: true });
  writeFileSync(
    join(nextDir, "static", "chunks", "layout.js"),
    `globalThis.appVersion="${clientVersion}";\n`,
  );
  writeFileSync(join(nextDir, "BUILD_ID"), `${buildId}\n`);
  mkdirSync(join(webRoot, "public"), { recursive: true });
  writeFileSync(join(webRoot, "public", "favicon.ico"), "icon");
  return { root, webRoot, artifactDir: join(root, "candidate") };
}

test("archive name follows the contract", () => {
  assert.equal(
    webArchiveName(VERSION),
    "labrastro-web-0.4.43-labrastro.2-linux-amd64-node-standalone.tar.gz",
  );
});

test("verifyStandaloneBuild accepts output carrying the candidate version", t => {
  const { webRoot } = fixture(t);
  const result = verifyStandaloneBuild(webRoot, { version: VERSION });
  assert.equal(result.buildId, "probe-build-id");
});

test("verifyStandaloneBuild rejects output built for another version", t => {
  const { webRoot } = fixture(t, { version: "0.0.0-gdeadbeef" });
  assert.throws(
    () => verifyStandaloneBuild(webRoot, { version: VERSION }),
    /not found as an exact literal in the client bundle/,
  );
});

test("verifyStandaloneBuild rejects a client bundle whose version merely starts with the candidate version", t => {
  // .20 must never satisfy a check for .2.
  const { webRoot } = fixture(t, { clientVersion: `${VERSION}0` });
  assert.throws(
    () => verifyStandaloneBuild(webRoot, { version: VERSION }),
    /exact literal/,
  );
});

test("verifyStandaloneBuild does not accept a server-only version hit", t => {
  // The server chunk may carry the right version while the user-visible
  // client bundle was built with another; only the client bundle proves it.
  const { webRoot } = fixture(t, { clientVersion: "0.0.0-gdeadbeef" });
  assert.throws(
    () => verifyStandaloneBuild(webRoot, { version: VERSION }),
    /exact literal/,
  );
});

test("buildWebStandalone refuses a non-linux/amd64 host", t => {
  const { webRoot } = fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const arch = Object.getOwnPropertyDescriptor(process, "arch");
  const calls = [];
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "arm64" });
    assert.throws(
      () =>
        buildWebStandalone(
          { version: VERSION },
          { spawnImpl: (...args) => (calls.push(args), { status: 0 }), webRoot },
        ),
      /linux\/amd64/,
    );
    assert.equal(calls.length, 0, "the build must not start on the wrong host");
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
});

test("verifyStandaloneBuild rejects output predating the build run", t => {
  const { webRoot } = fixture(t);
  const buildIdPath = join(webRoot, ".next", "BUILD_ID");
  const old = new Date(Date.now() - 60_000);
  utimesSync(buildIdPath, old, old);
  assert.throws(
    () =>
      verifyStandaloneBuild(webRoot, {
        version: VERSION,
        builtAfter: Date.now(),
      }),
    /predates this build run/,
  );
});

test("verifyStandaloneBuild requires the standalone entry and static assets", t => {
  const { webRoot } = fixture(t);
  rmSync(join(webRoot, ".next", "static"), { recursive: true });
  assert.throws(
    () => verifyStandaloneBuild(webRoot, { version: VERSION }),
    /missing \.next\/static/,
  );
});

test("assembleWebCandidate packs the runnable tree, evidence and inventory", t => {
  const { root, webRoot, artifactDir } = fixture(t);
  // The assembler reads LICENSE/NOTICE from the repository root; point it at
  // the fixture root by providing them there.
  writeFileSync(join(root, "LICENSE"), "license\n");
  writeFileSync(join(root, "NOTICE"), "notice\n");
  const { artifacts, evidence } = assembleWebCandidate({
    metadata: metadata(),
    artifactDir,
    webRoot,
    repoRoot: root,
    evidence: {
      build_started_at: "2026-09-15T01:00:00Z",
      build_finished_at: "2026-09-15T01:05:00Z",
      node: "v24.0.0",
      pnpm: "10.28.2",
    },
  });

  const archive = join(artifactDir, "assets", webArchiveName(VERSION));
  assert.ok(existsSync(archive));
  const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const treeName = webArchiveName(VERSION).replace(/\.tar\.gz$/, "");
  for (const expected of [
    `${treeName}/apps/web/server.js`,
    `${treeName}/apps/web/.next/static/chunks/layout.js`,
    `${treeName}/apps/web/public/favicon.ico`,
    `${treeName}/LICENSE`,
    `${treeName}/NOTICE`,
    `${treeName}/web-build.json`,
  ]) {
    assert.ok(members.includes(expected), `missing ${expected}`);
  }
  // The static assets must land at the runtime location inside the tree.
  assert.ok(
    members.every((m) => m.startsWith(`${treeName}/`)),
    "archive members stay inside the versioned root directory",
  );

  // Inactive version directory copy, including the evidence file whose
  // download_path points at releases/<tag>/.
  assert.ok(
    existsSync(join(artifactDir, "downloads", "releases", TAG, webArchiveName(VERSION))),
  );
  assert.ok(
    existsSync(join(artifactDir, "downloads", "releases", TAG, "web-build.json")),
  );

  // Evidence, flat and inside the archive.
  assert.equal(evidence.version, VERSION);
  assert.equal(evidence.commit, SHA);
  assert.equal(evidence.build_id, "probe-build-id");
  assert.equal(evidence.build_platform, `${process.platform}/${process.arch}`);
  const embedded = JSON.parse(
    execFileSync("tar", ["-xOzf", archive, `${treeName}/web-build.json`], {
      encoding: "utf8",
    }),
  );
  assert.equal(embedded.version, VERSION);
  assert.equal(embedded.pnpm, "10.28.2");

  // Inventory fragment contract.
  const archiveEntry = artifacts.find((a) => a.name === webArchiveName(VERSION));
  assert.equal(archiveEntry.path, `assets/${webArchiveName(VERSION)}`);
  assert.equal(
    archiveEntry.download_path,
    `releases/${TAG}/${webArchiveName(VERSION)}`,
  );
  assert.equal(archiveEntry.component, "web");
  assert.equal(archiveEntry.os, "linux");
  assert.equal(archiveEntry.arch, "amd64");
  assert.match(archiveEntry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(archiveEntry.bytes > 0);
  const evidenceEntry = artifacts.find((a) => a.name === "web-build.json");
  assert.equal(evidenceEntry.component, "web");
  assert.equal(evidenceEntry.os, undefined);

  const inventory = JSON.parse(
    readFileSync(join(artifactDir, "assets", "web-inventory.json"), "utf8"),
  );
  assert.equal(inventory.tag, TAG);
  assert.equal(inventory.artifacts.length, artifacts.length);
});

test("assembleWebCandidate refuses metadata whose version disagrees with the tag", t => {
  const { root, webRoot, artifactDir } = fixture(t);
  writeFileSync(join(root, "LICENSE"), "license\n");
  writeFileSync(join(root, "NOTICE"), "notice\n");
  assert.throws(
    () =>
      assembleWebCandidate({
        metadata: { ...metadata(), version: "0.4.43-labrastro.8" },
        artifactDir,
        webRoot,
        repoRoot: root,
        evidence: {},
      }),
    /does not match tag/,
  );
});
