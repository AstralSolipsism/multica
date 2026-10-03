// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({
  getSkillFolderTree: vi.fn(async () => null),
  listSkillPackages: vi.fn(async () => null),
  getSkillPackage: vi.fn(async () => null),
}));

vi.mock("../api", () => ({ api: apiMock }));

import {
  invalidateSkillPackageQueries,
  skillFolderTreeOptions,
  skillPackageDetailOptions,
  skillPackageKeys,
  skillPackageListOptions,
} from "./package-queries";

describe("skillPackageKeys", () => {
  it("scopes every key by workspace id", () => {
    expect(skillPackageKeys.tree("ws-1")).toEqual(["workspaces", "ws-1", "skill-folders"]);
    expect(skillPackageKeys.packages("ws-1")).toEqual(["workspaces", "ws-1", "skill-packages"]);
    expect(skillPackageKeys.package("ws-1", "p1")).toEqual(["workspaces", "ws-1", "skill-packages", "p1"]);
    expect(skillPackageKeys.tree("ws-1")).not.toEqual(skillPackageKeys.tree("ws-2"));
  });
});

describe("skill package query options", () => {
  it("calls the workspace-pinned api methods", async () => {
    const call = (options: { queryFn?: unknown }) =>
      (options.queryFn as (ctx: unknown) => Promise<unknown>)({});
    await call(skillFolderTreeOptions("ws-1"));
    expect(apiMock.getSkillFolderTree).toHaveBeenCalledWith("ws-1");
    await call(skillPackageListOptions("ws-1"));
    expect(apiMock.listSkillPackages).toHaveBeenCalledWith("ws-1");
    await call(skillPackageDetailOptions("ws-1", "pkg-1"));
    expect(apiMock.getSkillPackage).toHaveBeenCalledWith("ws-1", "pkg-1");
  });

  it("refreshes tree and packages on window focus (no folder WebSocket events)", () => {
    expect(skillFolderTreeOptions("ws-1").refetchOnWindowFocus).toBe(true);
    expect(skillPackageListOptions("ws-1").refetchOnWindowFocus).toBe(true);
  });

  it("only enables the detail query with a package id", () => {
    expect(skillPackageDetailOptions("ws-1", "").enabled).toBe(false);
    expect(skillPackageDetailOptions("ws-1", "pkg-1").enabled).toBe(true);
  });
});

describe("invalidateSkillPackageQueries", () => {
  it("invalidates tree and package keys, and skill/agent lists only when asked", async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");

    await invalidateSkillPackageQueries(qc, "ws-1");
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
    expect(keys).toContainEqual(skillPackageKeys.tree("ws-1"));
    expect(keys).toContainEqual(skillPackageKeys.packages("ws-1"));
    expect(keys).toHaveLength(2);

    spy.mockClear();
    await invalidateSkillPackageQueries(qc, "ws-1", { includeSkills: true });
    const allKeys = spy.mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
    expect(allKeys).toContainEqual(["workspaces", "ws-1", "skills"]);
    expect(allKeys).toContainEqual(["workspaces", "ws-1", "agents"]);
    expect(allKeys).toHaveLength(4);
  });
});
