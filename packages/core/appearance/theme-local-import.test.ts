// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { configStore } from "../config";
import { BUILT_IN_THEMES } from "./built-in-themes";
import { findTheme, useInstalledThemesStore } from "./installed-themes";
import { readZip, writeZip } from "./theme-archive";
import { themeFromFiles } from "./theme-package";

afterEach(() => {
  vi.unstubAllGlobals();
  useInstalledThemesStore.setState({ themes: [], folders: {}, fromStore: {} });
  localStorage.clear();
});

it("keeps built-in themes and local zip/folder imports available with the store off", async () => {
  configStore.getState().setThemeStoreEnabled(false);
  const fetch = vi.fn(() => { throw new Error("local themes must not fetch a registry"); });
  vi.stubGlobal("fetch", fetch);
  const encode = (value: string) => new TextEncoder().encode(value);
  const files = [
    { path: "local/manifest.json", data: encode(JSON.stringify({ apiVersion: 1, id: "local", name: "Local" })) },
    { path: "local/theme.css", data: encode(".theme-light { --page-canvas: #ffffff; }") },
  ];
  const archive = await readZip(writeZip(files), 1024 * 1024);
  if (!archive.ok) throw new Error(archive.error);
  const imported = themeFromFiles(archive.files);
  if (!imported.ok) throw new Error(imported.errors.join("\n"));
  useInstalledThemesStore.getState().install(imported.theme);
  expect(findTheme("local")?.name).toBe("Local");

  useInstalledThemesStore.getState().uninstall("local");
  useInstalledThemesStore.getState().syncFolder([{ folder: "local", result: themeFromFiles(files) }]);
  expect(findTheme("local")?.name).toBe("Local");
  expect(BUILT_IN_THEMES.map(({ id }) => id)).toEqual(["default", "pop", "github", "blueprint", "notion"]);
  for (const { id } of BUILT_IN_THEMES) expect(findTheme(id)).toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
});
