/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import {
  useArchiveWikiPage,
  useCreateWikiPage,
  useRenameWikiPage,
  useRollbackWikiPage,
  useUpdateProjectEngineering,
  useWriteWikiPage,
} from "./mutations";
import { projectKeys } from "./queries";

vi.mock("../hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("project engineering mutations", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: 2 } },
    });
  });

  afterEach(() => {
    cleanup();
    qc.clear();
    vi.restoreAllMocks();
  });

  it("patches engineering config and settles by refreshing overview and decider issues", async () => {
    const updateProjectEngineering = vi.fn().mockResolvedValue(null);
    setApiInstance({ updateProjectEngineering } as unknown as ApiClient);
    const overviewKey = projectKeys.engineering("ws-1", "project-1");
    const decisionsKey = projectKeys.engineeringDecisionIssues("ws-1", "project-1", "member-1");
    qc.setQueryData(overviewKey, null);
    qc.setQueryData(decisionsKey, []);

    const { result } = renderHook(() => useUpdateProjectEngineering(), { wrapper: createWrapper(qc) });
    await act(() => result.current.mutateAsync({ projectId: "project-1", enabled: true }));

    expect(updateProjectEngineering).toHaveBeenCalledWith("ws-1", "project-1", { enabled: true });
    expect(qc.getQueryState(overviewKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(decisionsKey)?.isInvalidated).toBe(true);
  });

  it("creates a page and invalidates the whole wiki subtree", async () => {
    const createProjectWikiPage = vi.fn().mockResolvedValue(null);
    setApiInstance({ createProjectWikiPage } as unknown as ApiClient);
    const treeKey = projectKeys.wikiTree("ws-1", "project-1", false);
    const pageKey = projectKeys.wikiPageAll("ws-1", "project-1", "overview");
    qc.setQueryData(treeKey, null);
    qc.setQueryData(pageKey, null);

    const { result } = renderHook(() => useCreateWikiPage(), { wrapper: createWrapper(qc) });
    await act(() => result.current.mutateAsync({ projectId: "project-1", title: "概览", slug: "overview" }));

    expect(createProjectWikiPage).toHaveBeenCalledWith("ws-1", "project-1", { title: "概览", slug: "overview" });
    expect(qc.getQueryState(treeKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(pageKey)?.isInvalidated).toBe(true);
  });

  it("writes with the page slug and base revision, without retry", async () => {
    const writeProjectWikiPage = vi.fn().mockRejectedValue(new Error("conflict"));
    setApiInstance({ writeProjectWikiPage } as unknown as ApiClient);

    qc.setQueryData(projectKeys.wikiRoot("ws-1", "project-1"), null);
    const { result } = renderHook(() => useWriteWikiPage(), { wrapper: createWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: "project-1", page: "architecture", baseRevisionNumber: 5, contentMarkdown: "# 新",
      }).catch(() => undefined);
    });

    expect(writeProjectWikiPage).toHaveBeenCalledTimes(1);
    expect(writeProjectWikiPage).toHaveBeenCalledWith("ws-1", "project-1", "architecture", {
      baseRevisionNumber: 5, contentMarkdown: "# 新",
    });
    await waitFor(() => expect(qc.getQueryState(projectKeys.wikiRoot("ws-1", "project-1"))?.isInvalidated).toBe(true));
  });

  it("renames and archives through the shared wiki invalidation", async () => {
    const renameProjectWikiPage = vi.fn().mockResolvedValue(null);
    const archiveProjectWikiPage = vi.fn().mockResolvedValue(null);
    setApiInstance({ renameProjectWikiPage, archiveProjectWikiPage } as unknown as ApiClient);

    qc.setQueryData(projectKeys.wikiRoot("ws-1", "project-1"), null);
    const rename = renderHook(() => useRenameWikiPage(), { wrapper: createWrapper(qc) });
    await act(async () => {
      await rename.result.current.mutateAsync({ projectId: "project-1", page: "a", baseRevisionNumber: 3, title: "B" });
    });
    expect(renameProjectWikiPage).toHaveBeenCalledWith("ws-1", "project-1", "a", { baseRevisionNumber: 3, title: "B" });

    const archive = renderHook(() => useArchiveWikiPage(), { wrapper: createWrapper(qc) });
    await act(async () => {
      await archive.result.current.mutateAsync({ projectId: "project-1", page: "a", baseRevisionNumber: 4, recursive: true });
    });
    expect(archiveProjectWikiPage).toHaveBeenCalledWith("ws-1", "project-1", "a", { baseRevisionNumber: 4, recursive: true });
    expect(qc.getQueryState(projectKeys.wikiRoot("ws-1", "project-1"))?.isInvalidated).toBe(true);
  });

  it("rolls back with the strict base and invalidates", async () => {
    const rollbackProjectWikiPage = vi.fn().mockResolvedValue(null);
    setApiInstance({ rollbackProjectWikiPage } as unknown as ApiClient);

    qc.setQueryData(projectKeys.wikiRoot("ws-1", "project-1"), null);
    const { result } = renderHook(() => useRollbackWikiPage(), { wrapper: createWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({
        projectId: "project-1", page: "a", revisionNumber: 2, baseRevisionNumber: 6, contentOnly: true,
      });
    });
    expect(rollbackProjectWikiPage).toHaveBeenCalledWith("ws-1", "project-1", "a", {
      revisionNumber: 2, baseRevisionNumber: 6, contentOnly: true,
    });
    expect(qc.getQueryState(projectKeys.wikiRoot("ws-1", "project-1"))?.isInvalidated).toBe(true);
  });
});
