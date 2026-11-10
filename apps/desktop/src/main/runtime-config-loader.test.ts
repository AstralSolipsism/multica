// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({ homePath: "" }));

// runtime-config-loader pulls `app` from electron at module load. Without this
// mock Vitest loads the real electron package, whose index.js downloads the
// platform binary on first run — a network round trip (and a CI 504) that has
// no place in a unit test. Same shape as updater.test.ts.
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => ctx.homePath),
  },
}));

import { app } from "electron";
import { loadRuntimeConfig } from "./runtime-config-loader";

describe("loadRuntimeConfig", () => {
  it("uses dev env and ignores desktop.json during electron-vite dev", async () => {
    const dir = await mkdtemp(join(tmpdir(), "multica-desktop-config-"));
    const configPath = join(dir, "desktop.json");
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, apiUrl: "https://prod.example.com" }),
    );

    await expect(
      loadRuntimeConfig({
        isDev: true,
        configPath,
        env: {
          apiUrl: "http://localhost:8080",
          wsUrl: "ws://localhost:8080/ws",
          appUrl: "http://localhost:3000",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        apiUrl: "http://localhost:8080",
        wsUrl: "ws://localhost:8080/ws",
        appUrl: "http://localhost:3000",
      },
    });
  });

  it("uses cloud defaults when packaged config is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "multica-desktop-config-"));
    await expect(
      loadRuntimeConfig({
        isDev: false,
        configPath: join(dir, "missing.json"),
        env: {},
      }),
    ).resolves.toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        apiUrl: "https://multica.outlune.com",
        wsUrl: "wss://multica.outlune.com/ws",
        appUrl: "https://multica.outlune.com",
      },
    });
  });

  it("parses a valid packaged desktop.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "multica-desktop-config-"));
    const configPath = join(dir, "desktop.json");
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, apiUrl: "https://api.example.com" }),
    );

    await expect(
      loadRuntimeConfig({ isDev: false, configPath, env: {} }),
    ).resolves.toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        apiUrl: "https://api.example.com",
        wsUrl: "wss://api.example.com/ws",
        appUrl: "https://example.com",
      },
    });
  });

  it("fails closed when packaged desktop.json is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "multica-desktop-config-"));
    const configPath = join(dir, "desktop.json");
    await writeFile(configPath, "{");

    const result = await loadRuntimeConfig({ isDev: false, configPath, env: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(configPath);
      expect(result.error.message).toContain("Invalid desktop runtime config JSON");
    }
  });

  it("reads desktopConfigPath() under the electron home dir when configPath is omitted", async () => {
    const home = await mkdtemp(join(tmpdir(), "multica-desktop-home-"));
    ctx.homePath = home;
    const configDir = join(home, ".multica");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "desktop.json"),
      JSON.stringify({
        schemaVersion: 1,
        apiUrl: "https://defaults.example.com",
        wsUrl: "wss://defaults.example.com/ws",
        appUrl: "https://web.example.com",
      }),
    );

    await expect(
      loadRuntimeConfig({ isDev: false, env: {} }),
    ).resolves.toEqual({
      ok: true,
      config: {
        schemaVersion: 1,
        apiUrl: "https://defaults.example.com",
        wsUrl: "wss://defaults.example.com/ws",
        appUrl: "https://web.example.com",
      },
    });
    expect(app.getPath).toHaveBeenCalledWith("home");
  });
});
