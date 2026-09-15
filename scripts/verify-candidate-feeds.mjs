#!/usr/bin/env node
// Recheck the transferred handoff without needing unpacked Desktop applications.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDeterministicTarGz, DESKTOP_TARGETS, loadDesktopModules,
  verifyActivationTree, verifyUpdateMetadataFile, verifyBlockmap,
} from "../apps/desktop/scripts/stage-candidate.mjs";

const root = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(root, "assets/manifest.json")));
const { tag, version } = manifest;
const evidence = JSON.parse(readFileSync(join(root, "assets/desktop-verification.json")));
assert.deepEqual(Object.keys(evidence).sort(), Object.keys(DESKTOP_TARGETS).sort());
const directory = join(root, "downloads/desktop", tag);
const modules = loadDesktopModules();
const feeds = new Set(Object.values(evidence).flatMap(e => [e.channel, e.compatibility_channel]));
assert.deepEqual(readdirSync(join(root, "activation")).sort(), ["desktop", "latest.json"]);
assert.deepEqual(readdirSync(join(root, "activation/desktop")).sort(), [...feeds].sort());
verifyActivationTree(join(root, "activation"), directory, tag, version, modules, evidence);
for (const name of readdirSync(directory)) {
  if (name.endsWith(".yml")) verifyUpdateMetadataFile(join(directory, name), directory, version, modules);
  if (name.endsWith(".exe") || name.endsWith(".blockmap")) {
    const installer = name.endsWith(".blockmap") ? name.slice(0, -9) : name;
    verifyBlockmap(join(directory, `${installer}.blockmap`), join(directory, installer));
  }
}
assert.deepEqual(readFileSync(join(root, "assets", `labrastro-feed-metadata-${version}.tar.gz`)),
  createDeterministicTarGz(join(root, "activation"), "activation"));
