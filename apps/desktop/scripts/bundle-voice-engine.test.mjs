// @vitest-environment node
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchedPackageDir, packOutputArchiveName, removeScratchDir } from "./bundle-voice-engine.mjs";

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
      await removeScratchDir(scratch);
    }
    expect(existsSync(scratch)).toBe(false);
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

describe("removeScratchDir", () => {
  it("is a no-op without a scratch dir (installed-package path)", async () => {
    await expect(removeScratchDir(undefined)).resolves.toBeUndefined();
  });
});
