// @vitest-environment node
import { resolve } from "path";
import { describe, expect, it } from "vitest";

import {
  defaultWorkspacesRoot,
  resolveWorkspacesRootInfo,
} from "./daemon-workspaces-root";

const HOME = "/home/tester";
const PROFILE = "desktop-api-example-com";

describe("defaultWorkspacesRoot", () => {
  it("derives the per-profile default under the home directory", () => {
    expect(defaultWorkspacesRoot(PROFILE, HOME)).toBe(
      "/home/tester/multica_workspaces_desktop-api-example-com",
    );
  });

  it("refuses an unresolved profile rather than falling back to the CLI default", () => {
    expect(() => defaultWorkspacesRoot("", HOME)).toThrow(/unresolved/);
  });
});

describe("resolveWorkspacesRootInfo", () => {
  it("uses the built-in default when neither config nor env is set", () => {
    const info = resolveWorkspacesRootInfo(PROFILE, {}, undefined, HOME);
    expect(info).toEqual({
      effectivePath: "/home/tester/multica_workspaces_desktop-api-example-com",
      customPath: null,
      envOverride: null,
      defaultPath: "/home/tester/multica_workspaces_desktop-api-example-com",
    });
  });

  it("prefers the persisted config value over the default", () => {
    const info = resolveWorkspacesRootInfo(
      PROFILE,
      { workspaces_root: "/data/multica" },
      undefined,
      HOME,
    );
    expect(info.effectivePath).toBe("/data/multica");
    expect(info.customPath).toBe("/data/multica");
    expect(info.envOverride).toBeNull();
  });

  it("lets MULTICA_WORKSPACES_ROOT win over the persisted config value", () => {
    const info = resolveWorkspacesRootInfo(
      PROFILE,
      { workspaces_root: "/data/multica" },
      "/env/multica",
      HOME,
    );
    expect(info.effectivePath).toBe("/env/multica");
    // The persisted value is still reported so the UI can explain that the
    // env override is what currently wins.
    expect(info.customPath).toBe("/data/multica");
    expect(info.envOverride).toBe("/env/multica");
  });

  it("treats blank config and blank env as unset, in either order", () => {
    expect(
      resolveWorkspacesRootInfo(PROFILE, { workspaces_root: "  " }, "", HOME)
        .effectivePath,
    ).toBe("/home/tester/multica_workspaces_desktop-api-example-com");
    expect(
      resolveWorkspacesRootInfo(
        PROFILE,
        { workspaces_root: "/data/multica" },
        "   ",
        HOME,
      ).envOverride,
    ).toBeNull();
  });

  it("ignores a non-string config value", () => {
    const info = resolveWorkspacesRootInfo(
      PROFILE,
      { workspaces_root: 42 },
      undefined,
      HOME,
    );
    expect(info.customPath).toBeNull();
    expect(info.effectivePath).toBe(info.defaultPath);
  });

  it("resolves a relative env value to an absolute path, like the Go filepath.Abs", () => {
    const info = resolveWorkspacesRootInfo(
      PROFILE,
      {},
      "relative/ws",
      HOME,
    );
    expect(info.envOverride).toBe("relative/ws");
    expect(info.effectivePath).toBe(resolve("relative/ws"));
  });
});
