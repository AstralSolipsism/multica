export interface FolderExplorerFolder {
  id: string;
  parentId: string | null;
  name: string;
  managed: boolean;
}

export interface FolderExplorerEntry {
  id: string;
  folderIds: readonly string[];
}

export function folderExplorerMap<F extends FolderExplorerFolder>(
  folders: readonly F[],
): ReadonlyMap<string, F> {
  return new Map(folders.map((folder) => [folder.id, folder]));
}

export function directChildFolders<F extends FolderExplorerFolder>(
  folders: readonly F[],
  currentFolderId: string | null,
): F[] {
  const byId = folderExplorerMap(folders);
  return folders
    .filter((folder) => {
      if (folder.parentId === currentFolderId) return true;
      return currentFolderId === null && folder.parentId !== null && !byId.has(folder.parentId);
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function directEntries<E extends FolderExplorerEntry>(
  entries: readonly E[],
  currentFolderId: string | null,
): E[] {
  return entries.filter((entry) =>
    currentFolderId === null
      ? entry.folderIds.length === 0
      : entry.folderIds.includes(currentFolderId),
  );
}

export function folderPath<F extends FolderExplorerFolder>(
  folders: readonly F[],
  folderId: string,
): F[] {
  const byId = folderExplorerMap(folders);
  const path: F[] = [];
  const visited = new Set<string>();
  let current = byId.get(folderId);
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export function folderPathLabel<F extends FolderExplorerFolder>(
  folders: readonly F[],
  folderId: string,
): string {
  return folderPath(folders, folderId)
    .map((folder) => folder.name)
    .join(" / ");
}

export function entryPathHints(
  folders: readonly FolderExplorerFolder[],
  entry: FolderExplorerEntry,
): string[] {
  return [...new Set(
    entry.folderIds
      .map((folderId) => folderPathLabel(folders, folderId))
      .filter((path) => path.length > 0),
  )].sort((a, b) => a.localeCompare(b));
}

export function isManagedLocation(
  folders: readonly FolderExplorerFolder[],
  folderId: string | null,
): boolean {
  if (folderId === null) return false;
  const byId = folderExplorerMap(folders);
  const visited = new Set<string>();
  let current = byId.get(folderId);
  while (current && !visited.has(current.id)) {
    if (current.managed) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

export function folderEntryCounts(
  folders: readonly FolderExplorerFolder[],
  entries: readonly FolderExplorerEntry[],
): ReadonlyMap<string, number> {
  const byId = folderExplorerMap(folders);
  const subtreeEntries = new Map<string, Set<string>>(
    folders.map((folder) => [folder.id, new Set<string>()]),
  );
  for (const entry of entries) {
    for (const folderId of new Set(entry.folderIds)) {
      const visited = new Set<string>();
      let current = byId.get(folderId);
      while (current && !visited.has(current.id)) {
        subtreeEntries.get(current.id)?.add(entry.id);
        visited.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
    }
  }
  return new Map([...subtreeEntries].map(([folderId, ids]) => [folderId, ids.size]));
}

export function resolveFolderLocation(
  requestedFolderId: string | null,
  folders: readonly FolderExplorerFolder[],
  previousFolders: readonly FolderExplorerFolder[] = [],
): string | null {
  if (requestedFolderId === null) return null;
  const currentById = folderExplorerMap(folders);
  if (currentById.has(requestedFolderId)) return requestedFolderId;

  const previousById = folderExplorerMap(previousFolders);
  const visited = new Set<string>([requestedFolderId]);
  let current = previousById.get(requestedFolderId);
  while (current?.parentId && !visited.has(current.parentId)) {
    if (currentById.has(current.parentId)) return current.parentId;
    visited.add(current.parentId);
    current = previousById.get(current.parentId);
  }
  return null;
}

export function folderLocationPath(
  pathname: string,
  searchParams: URLSearchParams,
  folderId: string | null,
  hash = "",
): string {
  const params = new URLSearchParams(searchParams);
  if (folderId === null) params.delete("folder");
  else params.set("folder", folderId);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}
