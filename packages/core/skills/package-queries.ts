import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { workspaceKeys } from "../workspace/queries";

// Skill package & folder-tree queries (Labrastro fork). Folder mutations
// have no WebSocket events, so freshness comes from local invalidation after
// writes plus window-focus refetches on these keys.
export const skillPackageKeys = {
  tree: (wsId: string) => ["workspaces", wsId, "skill-folders"] as const,
  packages: (wsId: string) => ["workspaces", wsId, "skill-packages"] as const,
  package: (wsId: string, packageId: string) =>
    [...skillPackageKeys.packages(wsId), packageId] as const,
};

export function skillFolderTreeOptions(wsId: string) {
  return queryOptions({
    queryKey: skillPackageKeys.tree(wsId),
    queryFn: () => api.getSkillFolderTree(wsId),
    refetchOnWindowFocus: true,
  });
}

export function skillPackageListOptions(wsId: string) {
  return queryOptions({
    queryKey: skillPackageKeys.packages(wsId),
    queryFn: () => api.listSkillPackages(wsId),
    refetchOnWindowFocus: true,
  });
}

export function skillPackageDetailOptions(wsId: string, packageId: string) {
  return queryOptions({
    queryKey: skillPackageKeys.package(wsId, packageId),
    queryFn: () => api.getSkillPackage(wsId, packageId),
    enabled: !!packageId,
  });
}

/**
 * Invalidation after a folder/package/placement write. Tree and package
 * queries always refresh; `includeSkills` adds the skill and agent lists,
 * which package apply/dissolve/delete and skill detach/move can change
 * (agents embed their skill bindings).
 */
export async function invalidateSkillPackageQueries(
  qc: QueryClient,
  wsId: string,
  opts?: { includeSkills?: boolean },
): Promise<void> {
  const invalidations = [
    qc.invalidateQueries({ queryKey: skillPackageKeys.tree(wsId) }),
    qc.invalidateQueries({ queryKey: skillPackageKeys.packages(wsId) }),
  ];
  if (opts?.includeSkills) {
    invalidations.push(
      qc.invalidateQueries({ queryKey: workspaceKeys.skills(wsId) }),
      qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) }),
    );
  }
  await Promise.all(invalidations);
}
