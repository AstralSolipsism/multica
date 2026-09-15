// Test-only synthetic Web/Desktop output. Real asar, blockmap and feed readers;
// the tiny installers are not runnable applications or release evidence.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkRelease } from "./check-release.mjs";
import { assembleWebCandidate } from "./build-candidate-web.mjs";
import { DESKTOP_TARGETS, INTERNAL_FEED_URL, loadDesktopModules, resolveAppBuilderBin,
  stageDesktopCandidate,
} from "../apps/desktop/scripts/stage-candidate.mjs";

const root = process.cwd();
const metadata = checkRelease({ repository: process.env.LABRASTRO_RELEASE_REPOSITORY,
  tag: process.env.LABRASTRO_RELEASE_TAG, sha: process.env.LABRASTRO_RELEASE_SHA, requireTag: true });
const artifactDir = join(root, metadata.artifact_dir);
const webRoot = join(root, "apps/web");
const write = (path, body) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, body); };
write(join(webRoot, ".next/BUILD_ID"), "fixture-build");
write(join(webRoot, ".next/standalone/apps/web/server.js"), "// synthetic standalone entry");
write(join(webRoot, ".next/static/version.js"), `const version=${JSON.stringify(metadata.version)};`);
assembleWebCandidate({ metadata, artifactDir, webRoot, repoRoot: root,
  evidence: { build_started_at: "2026-01-01T00:00:00Z", build_finished_at: "2026-01-01T00:00:01Z", node: process.version } });

const modules = loadDesktopModules();
const distRoot = join(root, "apps/desktop/dist");
for (const [key, target] of Object.entries(DESKTOP_TARGETS)) {
  const directory = join(distRoot, key);
  const resources = join(directory, target.unpackedDir, "resources");
  const asarSource = join(root, "dist/asar", key);
  write(join(asarSource, "package.json"), JSON.stringify({ name: "fixture", productName: "Labrastro", version: metadata.version }));
  mkdirSync(resources, { recursive: true });
  await modules.asar.createPackage(asarSource, join(resources, "app.asar"));
  for (const name of ["LICENSE", "NOTICE"]) cpSync(join(root, name), join(resources, name));
  const bin = join(resources, "app.asar.unpacked/resources/bin");
  mkdirSync(bin, { recursive: true });
  cpSync(join(root, "dist/binaries", `${target.goos}-${target.goarch}`), join(bin, target.platform === "win" ? "multica.exe" : "multica"));
  const channel = key === "win-arm64" ? "latest-arm64" : "labrastro";
  write(join(resources, "app-update.yml"), modules.yaml.dump({ provider: "generic", url: INTERNAL_FEED_URL, channel }));
  const name = target.platform === "win" ? `labrastro-desktop-${metadata.version}-windows-${target.arch}.exe`
    : `labrastro-desktop-${metadata.version}-linux-${target.arch === "x64" ? "x86_64" : target.arch}.AppImage`;
  const bytes = Buffer.from(`synthetic installer ${key} ${metadata.version}`);
  write(join(directory, name), bytes);
  if (target.blockmapRequired) execFileSync(resolveAppBuilderBin(), ["blockmap", "--input", join(directory, name), "--output", join(directory, `${name}.blockmap`)]);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const feed = target.platform === "linux" ? `labrastro-linux${target.arch === "arm64" ? "-arm64" : ""}.yml` : `${channel}.yml`;
  write(join(directory, feed), modules.yaml.dump({ version: metadata.version, path: name, sha512, files: [{ url: name, size: bytes.length, sha512 }] }));
}
for (const platform of ["linux", "win"]) {
  const separate = join(root, "dist/host", platform);
  stageDesktopCandidate({ metadata, artifactDir: separate, distRoot, modules,
    targets: Object.keys(DESKTOP_TARGETS).filter(k => k.startsWith(platform + "-")) });
  // Preserve each producer's actual staging output for the Python receipt test.
  write(join(root, "dist", `host-${platform}.json`), readFileSync(join(separate, "assets/desktop-verification.json")));
}
