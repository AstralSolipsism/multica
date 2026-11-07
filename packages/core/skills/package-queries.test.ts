// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { createQueryClient } from "../query-client";

const apiMock = vi.hoisted(() => ({
  getSkillFolderTree: vi.fn(async () => null),
}));

vi.mock("../api", () => ({ api: apiMock }));

beforeEach(() => {
  apiMock.getSkillFolderTree.mockReset().mockResolvedValue(null);
});

import {
  invalidateSkillPackageQueries,
  skillFolderTreeOptions,
  skillPackageKeys,
} from "./package-queries";

describe("skillPackageKeys", () => {
  it("scopes the tree key by workspace id", () => {
    expect(skillPackageKeys.tree("ws-1")).toEqual(["workspaces", "ws-1", "skill-folders"]);
    expect(skillPackageKeys.tree("ws-1")).not.toEqual(skillPackageKeys.tree("ws-2"));
  });
});

describe("skill folder tree query options", () => {
  it("calls the workspace-pinned api method", async () => {
    const call = (options: { queryFn?: unknown }) =>
      (options.queryFn as (ctx: unknown) => Promise<unknown>)({});
    await call(skillFolderTreeOptions("ws-1"));
    expect(apiMock.getSkillFolderTree).toHaveBeenCalledWith("ws-1");
  });

  it("refreshes the tree on window focus (no folder WebSocket events)", () => {
    // "always" is required: the global staleTime is Infinity, so plain
    // `true` would never fire a focus refetch.
    expect(skillFolderTreeOptions("ws-1").refetchOnWindowFocus).toBe("always");
  });
});

describe("invalidateSkillPackageQueries", () => {
  it("invalidates the tree, and skill/agent lists only when asked", async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");

    await invalidateSkillPackageQueries(qc, "ws-1");
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
    expect(keys).toEqual([skillPackageKeys.tree("ws-1")]);

    spy.mockClear();
    await invalidateSkillPackageQueries(qc, "ws-1", { includeSkills: true });
    const allKeys = spy.mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
    expect(allKeys).toContainEqual(["workspaces", "ws-1", "skills"]);
    expect(allKeys).toContainEqual(["workspaces", "ws-1", "agents"]);
    expect(allKeys).toContainEqual(skillPackageKeys.tree("ws-1"));
    expect(allKeys).toHaveLength(3);
  });
});

describe("window-focus refetch under production client defaults", () => {
  it("actually refetches the tree when the window regains focus", async () => {
    apiMock.getSkillFolderTree.mockClear();
    const qc = createQueryClient();
    // useQuery mounts the client in production; the focus subscription
    // lives there, so the raw observer test must mount explicitly.
    qc.mount();
    const observer = new QueryObserver(qc, skillFolderTreeOptions("ws-1"));
    const unsubscribe = observer.subscribe(() => {});
    try {
      // subscribe drives the initial fetch even with staleTime: Infinity.
      await vi.waitFor(() =>
        expect(apiMock.getSkillFolderTree).toHaveBeenCalledTimes(1),
      );
      focusManager.setFocused(true);
      await vi.waitFor(() =>
        expect(apiMock.getSkillFolderTree).toHaveBeenCalledTimes(2),
      );
    } finally {
      unsubscribe();
      // Restore the "no explicit focus state" default, not a forced blur:
      // setFocused(false) would leak a paused-fetch state into later tests.
      focusManager.setFocused(undefined);
      qc.unmount();
      qc.clear();
    }
  });
});

describe("workspace isolation", () => {
  it("caches per workspace and invalidates only the targeted one", async () => {
    apiMock.getSkillFolderTree.mockClear();
    apiMock.getSkillFolderTree.mockImplementation(
      ((wsId: string) => Promise.resolve({ wsId })) as never,
    );
    const qc = createQueryClient();
    await qc.fetchQuery(skillFolderTreeOptions("ws-1"));
    await qc.fetchQuery(skillFolderTreeOptions("ws-2"));
    expect(apiMock.getSkillFolderTree).toHaveBeenCalledTimes(2);
    const data1 = qc.getQueryData(skillPackageKeys.tree("ws-1"));
    const data2 = qc.getQueryData(skillPackageKeys.tree("ws-2"));
    expect(data1).not.toBe(data2);

    await invalidateSkillPackageQueries(qc, "ws-1");
    expect(qc.getQueryState(skillPackageKeys.tree("ws-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(skillPackageKeys.tree("ws-2"))?.isInvalidated).toBe(false);
    qc.clear();
  });
});
