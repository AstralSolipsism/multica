import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";

export const agentFolderKeys = {
  tree: (wsId: string) => ["workspaces", wsId, "agent-folders"] as const,
};

export function agentFolderTreeOptions(wsId: string) {
  return queryOptions({
    queryKey: agentFolderKeys.tree(wsId),
    queryFn: () => api.getAgentFolderTree(wsId),
    // Folder writes have no broadcast. Override the global Infinity stale time
    // so other members' changes also appear on a later mount or window focus.
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
}

export function invalidateAgentFolderQueries(qc: QueryClient, wsId: string): Promise<void> {
  return qc.invalidateQueries({ queryKey: agentFolderKeys.tree(wsId) });
}
