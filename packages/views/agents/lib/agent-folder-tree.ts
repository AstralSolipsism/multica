// Labrastro fork (OL-1030): pure model for the agents-page folder tree.
// The server ships flat adjacency: custom folders, agent placements, and
// unarchived squads with their visible agent members. Squad folders are
// derived here (squad id = folder id, managed) — they are never folder rows.

import type {
  AgentFolderTree,
  AgentSquadFolder,
} from "@multica/core/api/schemas";
import type { Agent } from "@multica/core/types";
import {
  folderEntryIds,
  folderPathLabel,
  type FolderExplorerEntry,
  type FolderExplorerFolder,
} from "../../common/folder-explorer";

/** Use only the page's scoped agents; squad order is independent of table sorting. */
export function folderAgents(
  folders: readonly FolderExplorerFolder[],
  entries: readonly FolderExplorerEntry[],
  agents: readonly Agent[],
  squads: ReadonlyMap<string, AgentSquadFolder>,
): ReadonlyMap<string, Agent[]> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return new Map([...folderEntryIds(folders, entries)].map(([folderId, ids]) => {
    const squad = squads.get(folderId);
    const orderedIds = squad
      ? new Set([...(squad.leaderId ? [squad.leaderId] : []), ...squad.agentIds])
      : ids;
    const members: Agent[] = [];
    for (const id of orderedIds) {
      const agent = byId.get(id);
      if (ids.has(id) && agent) members.push(agent);
    }
    return [folderId, members];
  }));
}

/** Custom folders plus one managed folder per unarchived squad. */
export function explorerFolders(
  tree: AgentFolderTree,
): FolderExplorerFolder[] {
  return [
    ...tree.folders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      name: folder.name,
      managed: false,
    })),
    ...tree.squads.map((squad) => ({
      id: squad.squadId,
      parentId: squad.parentId,
      name: squad.name,
      managed: true,
    })),
  ];
}

export function squadById(
  tree: AgentFolderTree,
): Map<string, AgentSquadFolder> {
  return new Map(tree.squads.map((squad) => [squad.squadId, squad]));
}

/** Agent id → custom folder id, when placed. */
export function placementFolderByAgentId(
  tree: AgentFolderTree,
): Map<string, string> {
  return new Map(
    tree.placements.map((placement) => [placement.agentId, placement.folderId]),
  );
}

/** Agent id → ids of the unarchived squads it visibly belongs to. */
export function squadIdsByAgentId(
  tree: AgentFolderTree,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const squad of tree.squads) {
    for (const agentId of squad.agentIds) {
      const list = map.get(agentId) ?? [];
      list.push(squad.squadId);
      map.set(agentId, list);
    }
  }
  return map;
}

/** Every folder an agent appears in: its custom placement plus its squads. */
export function agentEntryFolderIds(
  agentId: string,
  placements: ReadonlyMap<string, string>,
  squads: ReadonlyMap<string, readonly string[]>,
): string[] {
  const folderIds: string[] = [];
  const placement = placements.get(agentId);
  if (placement) folderIds.push(placement);
  for (const squadId of squads.get(agentId) ?? []) folderIds.push(squadId);
  return folderIds;
}

/** Ids of `rootId` and every descendant custom folder. Empty when unknown. */
export function collectSubtreeFolderIds(
  folders: readonly FolderExplorerFolder[],
  rootId: string,
): Set<string> {
  const byParent = new Map<string | null, FolderExplorerFolder[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentId) ?? [];
    siblings.push(folder);
    byParent.set(folder.parentId, siblings);
  }
  const ids = new Set<string>();
  const walk = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const child of byParent.get(id) ?? []) walk(child.id);
  };
  if (folders.some((folder) => folder.id === rootId)) walk(rootId);
  return ids;
}

function sortByPath(
  folders: readonly FolderExplorerFolder[],
  candidates: FolderExplorerFolder[],
): FolderExplorerFolder[] {
  return candidates
    .slice()
    .sort((a, b) =>
      folderPathLabel(folders, a.id).localeCompare(
        folderPathLabel(folders, b.id),
      ),
    );
}

/** Agent move destinations: custom folders only — squad membership is never
 *  a placement target. Sorted by full path so nested folders stay
 *  unambiguous when sibling names repeat across parents. */
export function agentMoveDestinations(
  folders: readonly FolderExplorerFolder[],
): FolderExplorerFolder[] {
  return sortByPath(folders, folders.filter((folder) => !folder.managed));
}

/** Destinations a custom folder itself may move into: custom folders,
 *  excluding the moving folder and its descendants so the client cannot ask
 *  for a cycle. */
export function folderMoveDestinations(
  folders: readonly FolderExplorerFolder[],
  movingId: string,
): FolderExplorerFolder[] {
  const excluded = collectSubtreeFolderIds(folders, movingId);
  return sortByPath(
    folders,
    folders.filter((folder) => !folder.managed && !excluded.has(folder.id)),
  );
}

/** Destinations a squad folder may move into: every custom folder. Squad
 *  folders hold no subfolders, so there is no cycle to exclude. */
export function squadMoveDestinations(
  folders: readonly FolderExplorerFolder[],
): FolderExplorerFolder[] {
  return sortByPath(folders, folders.filter((folder) => !folder.managed));
}
