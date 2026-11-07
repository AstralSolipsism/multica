import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { workspaceKeys } from "../workspace/queries";

// Skill folder-tree query (Labrastro fork). Folder and placement mutations
// have no WebSocket events, so freshness comes from local invalidation after
// writes, skill:* events (package writes also move skills) and window-focus
// refetches. The global `staleTime: Infinity` means data never goes stale on
// its own, so the focus refetch must be unconditional ("always") to fire.
// The tree response already embeds every package, so there is no separate
// package list/detail query.
export const skillPackageKeys = {
  tree: (wsId: string) => ["workspaces", wsId, "skill-folders"] as const,
};

export function skillFolderTreeOptions(wsId: string) {
  return queryOptions({
    queryKey: skillPackageKeys.tree(wsId),
    queryFn: () => api.getSkillFolderTree(wsId),
    refetchOnWindowFocus: "always",
  });
}

/**
 * Invalidation after a folder/package/placement write. The tree always
 * refreshes; `includeSkills` adds the skill and agent lists,
 * which package apply/dissolve/delete and skill detach/move can change
 * (agents embed their skill bindings).
 */
export async function invalidateSkillPackageQueries(
  qc: QueryClient,
  wsId: string,
  opts?: { includeSkills?: boolean },
): Promise<void> {
  const invalidations = [qc.invalidateQueries({ queryKey: skillPackageKeys.tree(wsId) })];
  if (opts?.includeSkills) {
    invalidations.push(
      qc.invalidateQueries({ queryKey: workspaceKeys.skills(wsId) }),
      qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) }),
    );
  }
  await Promise.all(invalidations);
}
