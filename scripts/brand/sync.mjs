#!/usr/bin/env node
// Fork assets are independently authored. Verify their reviewed identities;
// never regenerate them from upstream star/wordmark geometry.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function sync(root, { check = false } = {}) {
  const { assets, cliBrand } = JSON.parse(readFileSync(join(root, "scripts/brand/labrastro-assets.json"), "utf8"));
  const drifted = Object.entries(assets).flatMap(([path, digest]) => {
    try {
      return createHash("sha256").update(readFileSync(join(root, path))).digest("hex") === digest ? [] : [path];
    } catch { return [path]; }
  });
  const cli = "server/cmd/multica/cmd_auth.go";
  if (!readFileSync(join(root, cli), "utf8").includes(cliBrand)) drifted.push(cli);
  // Upstream syncs keep these assets through the labrastro-brand merge driver;
  // an asset missing from (or stale in) .gitattributes would conflict again.
  const merged = mergeProtectedPaths(root);
  const expected = Object.keys(assets);
  if (merged.length !== expected.length || expected.some((path) => !merged.includes(path))) {
    drifted.push(".gitattributes");
  }
  if (drifted.length && !check) {
    throw new Error(`Restore the reviewed Labrastro assets; upstream generation is disabled:\n${drifted.join("\n")}`);
  }
  return drifted;
}

/** Paths .gitattributes assigns to the labrastro-brand merge driver. */
export function mergeProtectedPaths(root) {
  let attributes;
  try {
    attributes = readFileSync(join(root, ".gitattributes"), "utf8");
  } catch { return []; }
  return attributes.split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+)\s+merge=labrastro-brand\s*$/.exec(line);
    return match ? [match[1]] : [];
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf("--root");
  const root = rootAt >= 0 ? resolve(args[rootAt + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const drifted = await sync(root, { check: args.includes("--check") });
  if (drifted.length) {
    console.error(`Labrastro brand asset drift:\n${drifted.join("\n")}`);
    process.exitCode = 1;
  } else console.log("Labrastro brand assets verified");
}
