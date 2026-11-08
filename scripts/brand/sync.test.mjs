import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mergeProtectedPaths, sync } from "./sync.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("committed Labrastro assets retain their reviewed identities", async () => {
  assert.deepEqual(await sync(repo, { check: true }), []);
  const icon = readFileSync(join(repo, "apps/mobile/assets/icon.png"));
  assert.equal(icon.readUInt32BE(16), 1024);
  assert.equal(icon.readUInt32BE(20), 1024);
  assert.equal(icon[25], 2, "mobile icon must be RGB without alpha");
});

test("drift fails CI and cannot be silently regenerated from upstream geometry", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "labrastro-brand-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = "scripts/brand/labrastro-assets.json";
  const cli = "server/cmd/multica/cmd_auth.go";
  const { assets } = JSON.parse(readFileSync(join(repo, manifest), "utf8"));
  for (const path of [...Object.keys(assets), manifest, cli, ".gitattributes"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path));
  }
  const icon = "apps/mobile/assets/icon.png";
  writeFileSync(join(root, icon), "upstream icon");
  writeFileSync(join(root, cli), '<div class="brand">Multica</div>');
  assert.deepEqual(await sync(root, { check: true }), [icon, cli]);
  await assert.rejects(sync(root), /upstream generation is disabled/);
  assert.equal(readFileSync(join(root, icon), "utf8"), "upstream icon");
  const result = spawnSync(process.execPath, [join(repo, "scripts/brand/sync.mjs"), "--check", "--root", root]);
  assert.equal(result.status, 1);
});

test("every reviewed asset keeps the fork copy when an upstream merge conflicts", async (t) => {
  const manifest = "scripts/brand/labrastro-assets.json";
  const { assets } = JSON.parse(readFileSync(join(repo, manifest), "utf8"));
  assert.deepEqual(mergeProtectedPaths(repo).sort(), Object.keys(assets).sort());
  // Git applies the attribute only to paths it names; a path the manifest
  // lacks, or a manifest asset left unprotected, must fail the check.
  const attributes = readFileSync(join(repo, ".gitattributes"), "utf8");
  const missing = Object.keys(assets)[0];
  const root = mkdtempSync(join(tmpdir(), "labrastro-brand-attrs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [...Object.keys(assets), manifest, "server/cmd/multica/cmd_auth.go"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path));
  }
  writeFileSync(join(root, ".gitattributes"), attributes.replace(`${missing} merge=labrastro-brand\n`, ""));
  assert.deepEqual(await sync(root, { check: true }), [".gitattributes"]);
  writeFileSync(join(root, ".gitattributes"), `${attributes}apps/web/public/extra.svg merge=labrastro-brand\n`);
  assert.deepEqual(await sync(root, { check: true }), [".gitattributes"]);
  writeFileSync(join(root, ".gitattributes"), attributes);
  assert.deepEqual(await sync(root, { check: true }), []);
});
