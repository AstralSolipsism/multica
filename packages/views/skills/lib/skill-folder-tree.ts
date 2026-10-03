import type {
  SkillFolder,
  SkillFolderTree,
  SkillPackage,
  SkillPlacement,
} from "@multica/core/api/schemas";

// Pure folder-tree model for the skills page sidebar and the tree picker.
// The server ships flat adjacency (nullable parent_id); all nesting, sorting
// and gray-candidate derivation happens here. Contract: folders sort before
// skills, each by name.

export interface FolderTreeNode {
  folder: SkillFolder;
  children: FolderTreeNode[];
}

/** A package candidate that has never been imported (no matching placement). */
export interface GrayCandidate {
  packageId: string;
  /** Candidate path inside the source repository ("" = repository root). */
  path: string;
  name: string;
  description: string;
  /** Folder row the candidate is listed under. */
  folderId: string;
}

/** The skills-page tree selection: everything, the placement-less set, or
 *  one folder's subtree. */
export type FolderSelection =
  | { kind: "all" }
  | { kind: "uncategorized" }
  | { kind: "folder"; folderId: string };

export function folderById(folders: readonly SkillFolder[]): Map<string, SkillFolder> {
  return new Map(folders.map((f) => [f.id, f]));
}

export function placementBySkillId(
  placements: readonly SkillPlacement[],
): Map<string, SkillPlacement> {
  return new Map(placements.map((p) => [p.skill_id, p]));
}

/** Package roots have a package_id and the root (empty) package path. */
export function isPackageRootFolder(folder: SkillFolder): boolean {
  return folder.package_id !== null && folder.package_path === "";
}

/** Internal managed folders mirror the source tree; they cannot be
 *  rearranged and cannot receive custom content. */
export function isManagedInternalFolder(folder: SkillFolder): boolean {
  return folder.package_id !== null && folder.package_path !== "";
}

export function isCustomFolder(folder: SkillFolder): boolean {
  return folder.package_id === null;
}

/** Nested folder hierarchy, sorted by name at every level. */
export function buildFolderNodes(folders: readonly SkillFolder[]): FolderTreeNode[] {
  const byParent = new Map<string | null, SkillFolder[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parent_id) ?? [];
    siblings.push(folder);
    byParent.set(folder.parent_id, siblings);
  }
  const build = (parentId: string | null): FolderTreeNode[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({ folder, children: build(folder.id) }));
  // A folder whose parent is missing (deleted mid-flight) surfaces at root
  // rather than vanishing.
  const known = new Set(folders.map((f) => f.id));
  const roots = (byParent.get(null) ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((folder) => ({ folder, children: build(folder.id) }));
  for (const [parentId, children] of byParent) {
    if (parentId !== null && !known.has(parentId)) {
      roots.push(
        ...children
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((folder) => ({ folder, children: build(folder.id) })),
      );
    }
  }
  return roots;
}

/** Ids of `rootId` and every descendant folder. Empty set when unknown. */
export function collectSubtreeFolderIds(
  folders: readonly SkillFolder[],
  rootId: string,
): Set<string> {
  const byParent = new Map<string | null, SkillFolder[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parent_id) ?? [];
    siblings.push(folder);
    byParent.set(folder.parent_id, siblings);
  }
  const ids = new Set<string>();
  const walk = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const child of byParent.get(id) ?? []) walk(child.id);
  };
  if (folders.some((f) => f.id === rootId)) walk(rootId);
  return ids;
}

/** "Root / Sub" display path for a folder (used by flattened search rows). */
export function folderDisplayPath(
  folders: readonly SkillFolder[],
  folderId: string,
): string {
  const byId = folderById(folders);
  const parts: string[] = [];
  let current = byId.get(folderId);
  let guard = 0;
  while (current && guard <= folders.length) {
    parts.unshift(current.name);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
    guard += 1;
  }
  return parts.join(" / ");
}

/** Package whose root is the given folder. */
export function packageForRootFolder(
  tree: Pick<SkillFolderTree, "packages">,
  folderId: string,
): SkillPackage | null {
  return tree.packages.find((p) => p.root_folder_id === folderId) ?? null;
}

/** Destinations a skill may be moved into: custom folders only. The server
 *  rejects any destination chain touching a package folder (409
 *  `managed_folder`), so package roots and managed internals are excluded. */
export function skillMoveDestinations(folders: readonly SkillFolder[]): SkillFolder[] {
  return folders
    .filter((f) => isCustomFolder(f))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Destinations a folder itself may move into: custom folders only (package
 *  roots move into custom folders; managed folders never move), excluding
 *  the moving folder and its descendants so the client cannot ask for a
 *  cycle. */
export function folderMoveDestinations(
  folders: readonly SkillFolder[],
  movingId: string,
): SkillFolder[] {
  const excluded = collectSubtreeFolderIds(folders, movingId);
  return folders
    .filter((f) => isCustomFolder(f) && !excluded.has(f.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Longest common parent-directory prefix of candidate paths, in segments.
 *  Managed folder paths strip this prefix (server contract). */
export function commonCandidatePrefix(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const dirs = paths.map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""));
  const segments = dirs.map((d) => (d === "" ? [] : d.split("/")));
  const first = segments[0]!;
  const prefix: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]!;
    if (segments.every((s) => s[i] === seg)) prefix.push(seg);
    else break;
  }
  return prefix.join("/");
}

/**
 * Candidates the package metadata knows but no placement covers — the gray,
 * not-yet-imported rows. Placement membership (package_id + source_path) is
 * authoritative; the folder mapping mirrors the server's prefix stripping
 * and falls back to the package root when it cannot be reproduced.
 */
export function grayCandidates(tree: SkillFolderTree): GrayCandidate[] {
  const placedByPackage = new Map<string, Set<string>>();
  for (const p of tree.placements) {
    if (p.package_id === null || p.source_path === null) continue;
    const paths = placedByPackage.get(p.package_id) ?? new Set<string>();
    paths.add(p.source_path);
    placedByPackage.set(p.package_id, paths);
  }
  const result: GrayCandidate[] = [];
  for (const pkg of tree.packages) {
    const prefix = commonCandidatePrefix(pkg.candidates.map((c) => c.path));
    const managedByPath = new Map(
      tree.folders
        .filter((f) => f.package_id === pkg.id && f.package_path !== null)
        .map((f) => [f.package_path as string, f.id]),
    );
    for (const candidate of pkg.candidates) {
      if (placedByPackage.get(pkg.id)?.has(candidate.path)) continue;
      const dir = candidate.path.includes("/")
        ? candidate.path.slice(0, candidate.path.lastIndexOf("/"))
        : "";
      const relative =
        prefix !== "" && dir.startsWith(prefix)
          ? dir.slice(prefix.length).replace(/^\//, "")
          : dir;
      const folderId =
        (relative === "" ? undefined : managedByPath.get(relative)) ??
        pkg.root_folder_id;
      result.push({
        packageId: pkg.id,
        path: candidate.path,
        name: candidate.name,
        description: candidate.description,
        folderId,
      });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a skill belongs in the list for the current tree selection:
 *  a folder shows its whole subtree, "uncategorized" shows skills with no
 *  placement, and "all" shows everything. */
export function skillMatchesFolderSelection(
  tree: SkillFolderTree,
  selection:
    | { kind: "all" }
    | { kind: "uncategorized" }
    | { kind: "folder"; folderId: string },
  skillId: string,
): boolean {
  if (selection.kind === "all") return true;
  const placement = tree.placements.find((p) => p.skill_id === skillId);
  if (selection.kind === "uncategorized") return placement === undefined;
  if (!placement) return false;
  return collectSubtreeFolderIds(tree.folders, selection.folderId).has(
    placement.folder_id,
  );
}

/** Precomputed skill sets for the folder filter: one pass over the tree
 *  instead of rebuilding a subtree set per row per render. */
export interface FolderSkillIndex {
  /** Skills with any placement (the complement of "uncategorized"). */
  placed: ReadonlySet<string>;
  /** Folder id -> ids of skills placed anywhere in its subtree. */
  byFolder: ReadonlyMap<string, ReadonlySet<string>>;
}

export function buildFolderSkillIndex(tree: SkillFolderTree): FolderSkillIndex {
  const placed = new Set(tree.placements.map((p) => p.skill_id));
  const childrenOf = new Map<string | null, SkillFolder[]>();
  for (const folder of tree.folders) {
    const siblings = childrenOf.get(folder.parent_id) ?? [];
    siblings.push(folder);
    childrenOf.set(folder.parent_id, siblings);
  }
  const byFolder = new Map<string, Set<string>>();
  const compute = (folderId: string): Set<string> => {
    const cached = byFolder.get(folderId);
    if (cached) return cached;
    const set = new Set<string>();
    // Guard first so a malformed parent cycle cannot recurse forever.
    byFolder.set(folderId, set);
    for (const p of tree.placements) {
      if (p.folder_id === folderId) set.add(p.skill_id);
    }
    for (const child of childrenOf.get(folderId) ?? []) {
      for (const id of compute(child.id)) set.add(id);
    }
    return set;
  };
  for (const folder of tree.folders) compute(folder.id);
  return { placed, byFolder };
}
