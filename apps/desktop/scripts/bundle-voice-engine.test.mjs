// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fetchedPackageDir,
  packOutputArchiveName,
  removeScratchDir,
  stageVoiceEngineFiles,
} from "./bundle-voice-engine.mjs";

// Regression guard for the Fork candidate windows-latest failure: Git for
// Windows' GNU tar parses "C:\Users\..." as a remote HOST:FILE archive
// ("Cannot connect to C: resolve failed"), so npm pack's output must collapse
// to a bare archive name extracted with cwd = scratch.
const WIN_ARCHIVE = "sherpa-onnx-win-arm64-1.12.17.tgz";
const WIN_PACK_OUTPUT = `C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\voice-engine-x\\${WIN_ARCHIVE}\r\n`;

describe("packOutputArchiveName", () => {
  it("normalizes a POSIX npm pack path to the bare archive name", () => {
    expect(packOutputArchiveName(`${join(tmpdir(), "voice-engine-x", WIN_ARCHIVE)}\n`)).toBe(WIN_ARCHIVE);
  });

  it("normalizes a Windows drive-letter path (RUNNER~1 form) to the bare archive name", () => {
    expect(packOutputArchiveName(WIN_PACK_OUTPUT)).toBe(WIN_ARCHIVE);
  });

  it("keeps the last line when npm prints extra output", () => {
    expect(packOutputArchiveName(`npm notice something\n${join(tmpdir(), WIN_ARCHIVE)}`)).toBe(WIN_ARCHIVE);
  });

  it("rejects output without a usable archive name", () => {
    expect(() => packOutputArchiveName("")).toThrow();
    expect(() => packOutputArchiveName("C:\\")).toThrow();
  });
});

describe("fetchedPackageDir", () => {
  function fakeExec({ failTar = false } = {}) {
    const calls = [];
    const execFile = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === "tar") {
        if (failTar) throw new Error("tar (child): Cannot connect to C: resolve failed");
        return "";
      }
      return WIN_PACK_OUTPUT;
    };
    return { calls, execFile };
  }

  it("extracts with a colon-free bare archive name and cwd = scratch", async () => {
    const { calls, execFile } = fakeExec();
    const { dir, scratch } = await fetchedPackageDir("1.12.17", { execFile });
    try {
      expect(existsSync(scratch)).toBe(true);
      const tar = calls.find((call) => call.cmd === "tar");
      expect(tar.args).toEqual(["-xzf", WIN_ARCHIVE]);
      expect(tar.opts.cwd).toBe(scratch);
      expect(dir).toBe(join(scratch, "package"));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("removes the scratch dir when the fetch itself fails", async () => {
    let scratch;
    const execFile = (cmd, _args, opts) => {
      if (cmd === "tar") {
        scratch = opts.cwd;
        throw new Error("tar (child): Cannot connect to C: resolve failed");
      }
      return WIN_PACK_OUTPUT;
    };
    await expect(fetchedPackageDir("1.12.17", { execFile })).rejects.toThrow("Cannot connect to C:");
    expect(existsSync(scratch)).toBe(false);
  });
});

// Drives the production staging path that main() delegates to (same function,
// with dest pointed at a temp dir), so the scratch lifecycle — cleanup after a
// successful copy, cleanup on later failure, and the installed package's
// node_modules staying untouched — is asserted against the real code.
describe("stageVoiceEngineFiles", () => {
  const FETCHED_LABEL = "sherpa-onnx-win-arm64@1.12.17";

  async function stagingFixture({ withAddon = true } = {}) {
    const scratch = await mkdtemp(join(tmpdir(), "voice-engine-"));
    const sourceDir = join(scratch, "package");
    await mkdir(sourceDir);
    const files = ["sherpa-onnx.node", "libonnxruntime.so.1", "README.md"];
    for (const name of files) {
      if (withAddon || name !== "sherpa-onnx.node") await writeFile(join(sourceDir, name), `content of ${name}\n`);
    }
    const dest = await mkdtemp(join(tmpdir(), "voice-dest-"));
    return { scratch, sourceDir, dest };
  }

  it("stages native files + notices and removes the fetched scratch dir", async () => {
    const { scratch, sourceDir, dest } = await stagingFixture();
    try {
      await stageVoiceEngineFiles(sourceDir, { dir: sourceDir, scratch }, FETCHED_LABEL, { dest });
      expect((await readdir(dest)).sort()).toEqual(["THIRD_PARTY_NOTICES.txt", "libonnxruntime.so.1", "sherpa-onnx.node"]);
      expect(existsSync(scratch)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it("still removes the fetched scratch dir when staging fails after the fetch", async () => {
    const { scratch, sourceDir, dest } = await stagingFixture({ withAddon: false });
    try {
      await expect(stageVoiceEngineFiles(sourceDir, { dir: sourceDir, scratch }, FETCHED_LABEL, { dest })).rejects.toThrow(
        "has no sherpa-onnx.node",
      );
      expect(existsSync(scratch)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it("keeps the installed package's source dir when there is no scratch dir", async () => {
    const { scratch, sourceDir, dest } = await stagingFixture();
    try {
      await stageVoiceEngineFiles(sourceDir, null, "sherpa-onnx-linux-x64@2.0.1", { dest });
      expect((await readdir(dest)).sort()).toEqual(["THIRD_PARTY_NOTICES.txt", "libonnxruntime.so.1", "sherpa-onnx.node"]);
      expect(existsSync(sourceDir)).toBe(true);
      expect(existsSync(scratch)).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });
});

describe("removeScratchDir", () => {
  it("is a no-op without a scratch dir (installed-package path)", async () => {
    await expect(removeScratchDir(undefined)).resolves.toBeUndefined();
  });
});
