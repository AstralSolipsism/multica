// @vitest-environment node
import { expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { agentFolderKeys, agentFolderTreeOptions, invalidateAgentFolderQueries } from "./folder-queries";

const getAgentFolderTree = vi.hoisted(() => vi.fn(async () => ({ folders: [], squads: [], placements: [] })));
vi.mock("../api", () => ({ api: { getAgentFolderTree } }));

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
