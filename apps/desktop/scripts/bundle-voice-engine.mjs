#!/usr/bin/env node
// Copies the on-device speech engine (sherpa-onnx's native addon and the
// ONNX Runtime libraries next to it) for one platform/arch into
// apps/desktop/resources/voice-engine/, where the voice worker loads it from
// (`asarUnpack: resources/**` keeps it on disk in packaged builds).
//
// The files come from sherpa-onnx's per-platform npm package. pnpm only
// installs the host's, so a cross-arch package build (`--x64 --arm64` on one
// runner) fetches the other one with `npm pack` at the version pinned by the
// `sherpa-onnx-node` devDependency.
//
// Graceful in dev: if the engine can't be staged, voice input reports itself
// unavailable and everything else works. `--required` (package builds) makes
// a failure fatal so a release never ships without it.

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const destDir = join(desktopRoot, "resources", "voice-engine");
const NATIVE_FILE = /\.(node|dylib|dll|so(\.\d+)*)$/;
const SUPPORTED = new Set(["darwin-x64", "darwin-arm64", "win-x64", "win-arm64", "linux-x64", "linux-arm64"]);

// The npm packages carry no license files, so the binaries ship with this.
const NOTICES = `Third-party software in this directory

sherpa-onnx (sherpa-onnx.node, libsherpa-onnx-*)
https://github.com/k2-fsa/sherpa-onnx
Copyright (c) 2022-2025 Xiaomi Corporation
Licensed under the Apache License, Version 2.0:
https://www.apache.org/licenses/LICENSE-2.0

ONNX Runtime (libonnxruntime*, onnxruntime*)
https://github.com/microsoft/onnxruntime
Copyright (c) Microsoft Corporation

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const platform = argValue("--target-platform", process.platform);
const arch = argValue("--target-arch", process.arch);
const required = process.argv.includes("--required");
const target = `${platform === "win32" ? "win" : platform}-${arch}`;
const pkg = `sherpa-onnx-${target}`;

async function installedPackageDir(version) {
  const require = createRequire(join(desktopRoot, "package.json"));
  const searchFrom = [desktopRoot, dirname(require.resolve("sherpa-onnx-node/package.json"))];
  for (const base of searchFrom) {
    try {
      const manifest = createRequire(join(base, "package.json")).resolve(`${pkg}/package.json`);
      const { version: found } = JSON.parse(await readFile(manifest, "utf8"));
      if (found === version) return dirname(manifest);
    } catch {
      // Not installed for this platform; fetch it below.
    }
  }
  return null;
}

// npm pack's stdout ends with the packed tarball's path. Keep only the file
// name: an absolute Windows path ("C:\Users\...") handed to GNU tar (Git for
// Windows, first on PATH under `defaults.run.shell: bash`) parses the drive
// letter as a remote HOST:FILE archive ("Cannot connect to C: resolve
// failed"), and bsdtar has no --force-local, so a bare name plus cwd is the
// only spelling every tar on every runner accepts.
export function packOutputArchiveName(output) {
  const lastLine = output.trim().split("\n").pop();
  const name = basename(lastLine.trim().replace(/\\/g, "/"));
  if (!name || /[/\\:]/.test(name)) {
    throw new Error(`npm pack printed no archive name: ${lastLine.trim()}`);
  }
  return name;
}

// Fetches the cross-arch package pnpm didn't install into a scratch dir and
// returns { dir, scratch }. The scratch dir outlives this call — main() owns
// it and removes it with removeScratchDir once the native files are copied —
// and is cleaned up here when the fetch itself fails.
export async function fetchedPackageDir(version, { execFile = execFileSync } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "voice-engine-"));
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = execFile(npm, ["pack", `${pkg}@${version}`, "--silent", "--pack-destination", scratch], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    execFile("tar", ["-xzf", packOutputArchiveName(packed)], { cwd: scratch });
    return { dir: join(scratch, "package"), scratch };
  } catch (err) {
    await removeScratchDir(scratch);
    throw err;
  }
}

// Removes a cross-arch fetch's scratch dir. `scratch` is null/undefined for
// the installed-package path, whose node_modules dir must never be touched.
export async function removeScratchDir(scratch) {
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

async function main() {
  if (!SUPPORTED.has(target)) throw new Error(`no speech engine for ${target}`);
  const require = createRequire(join(desktopRoot, "package.json"));
  const { version } = JSON.parse(await readFile(require.resolve("sherpa-onnx-node/package.json"), "utf8"));
  // Only the cross-arch fetch has a scratch dir to clean up; when pnpm
  // already installed the package, sourceDir sits in node_modules and must
  // stay untouched.
  const installed = await installedPackageDir(version);
  const fetched = installed ? null : await fetchedPackageDir(version);
  try {
    const sourceDir = installed ?? fetched.dir;
    const files = (await readdir(sourceDir)).filter((name) => NATIVE_FILE.test(name));
    if (!files.includes("sherpa-onnx.node")) throw new Error(`${pkg}@${version} has no sherpa-onnx.node`);
    await rm(destDir, { recursive: true, force: true });
    await mkdir(destDir, { recursive: true });
    for (const name of files) await copyFile(join(sourceDir, name), join(destDir, name));
    await writeFile(join(destDir, "THIRD_PARTY_NOTICES.txt"), NOTICES);
    console.log(`[bundle-voice-engine] ${pkg}@${version} → resources/voice-engine (${files.length} files)`);
  } finally {
    await removeScratchDir(fetched?.scratch);
  }
}

// Only run when invoked as a CLI, not when imported by a test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    await rm(destDir, { recursive: true, force: true });
    const message = `[bundle-voice-engine] ${err instanceof Error ? err.message : String(err)}`;
    if (required) {
      console.error(message);
      process.exit(1);
    }
    console.warn(`${message} — voice input will be unavailable in this build.`);
  });
}
