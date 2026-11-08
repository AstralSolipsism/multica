// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { AgentFolderTree } from "../api/schemas";
import { agentFolderKeys, agentFolderTreeOptions, invalidateAgentFolderQueries } from "./folder-queries";

const emptyTree: AgentFolderTree = { folders: [], squads: [], placements: [] };
const getAgentFolderTree = vi.hoisted(() => vi.fn(async () => emptyTree));
vi.mock("../api", () => ({ api: { getAgentFolderTree } }));

beforeEach(() => {
  getAgentFolderTree.mockReset().mockResolvedValue(emptyTree);
});

it("pins requests and invalidation to the requested workspace", async () => {
  const qc = new QueryClient();
  await qc.fetchQuery(agentFolderTreeOptions("ws-1"));
  await qc.fetchQuery(agentFolderTreeOptions("ws-2"));
  expect(getAgentFolderTree).toHaveBeenCalledWith("ws-1");
  expect(getAgentFolderTree).toHaveBeenCalledWith("ws-2");
  await invalidateAgentFolderQueries(qc, "ws-1");
  expect(qc.getQueryState(agentFolderKeys.tree("ws-1"))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(agentFolderKeys.tree("ws-2"))?.isInvalidated).toBe(false);
  expect(agentFolderTreeOptions("ws-1")).toMatchObject({ staleTime: 0, refetchOnWindowFocus: "always" });
  qc.clear();
});

it("replaces an obsolete first load when invalidation arrives in flight", async () => {
  let releaseFirst: (value: typeof emptyTree) => void = () => {};
  const refreshedTree = { folders: [], squads: [], placements: [{ agentId: "a-1", folderId: "f-1" }] };
  getAgentFolderTree
    .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
    .mockResolvedValueOnce(refreshedTree);
  const qc = new QueryClient();
  const observer = new QueryObserver(qc, agentFolderTreeOptions("ws-1"));
  const unsubscribe = observer.subscribe(() => {});
  void observer.refetch();
  try {
    await vi.waitFor(() => expect(getAgentFolderTree).toHaveBeenCalledTimes(1));
    await invalidateAgentFolderQueries(qc, "ws-1");
    expect(getAgentFolderTree).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(qc.getQueryData(agentFolderKeys.tree("ws-1"))).toEqual(refreshedTree);
    });
  } finally {
    releaseFirst(emptyTree);
    unsubscribe();
    qc.clear();
  }
});
