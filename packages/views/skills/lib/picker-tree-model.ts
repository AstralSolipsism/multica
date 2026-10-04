import type { SkillSummary } from "@multica/core/types";
import type { SkillFolderTree } from "@multica/core/api/schemas";
import {
  buildFolderNodes,
  folderDisplayPath,
  grayCandidates,
  placementBySkillId,
  type FolderTreeNode,
  type GrayCandidate,
} from "./skill-folder-tree";

// Tree model for the skill picker (OL-104): the folder tree pruned to the
// caller-provided selectable skills plus the packages' not-yet-imported
// (gray) candidates. Folders with neither visible skills nor gray rows are
// not rendered at all — the picker only expands the caller's selectable set.

export const PICKER_UNCATEGORIZED_ID = "__uncategorized__";

export type PickerRow =
  | { kind: "folder"; folderId: string; name: string; depth: number; expandable: boolean }
  | { kind: "skill"; skill: SkillSummary; depth: number }
  | { kind: "gray"; candidate: GrayCandidate; depth: number };

export interface PickerModel {
  rows: PickerRow[];
  /** Visible selectable skills per folder row id (tri-state source). */
  subtreeSkills: Map<string, SkillSummary[]>;
}

interface FolderContent {
  skills: SkillSummary[];
  children: { node: FolderTreeNode; content: FolderContent }[];
  gray: GrayCandidate[];
  /** Visible skills in this folder's whole subtree (tri-state source). */
  subtree: SkillSummary[];
  /** This folder or a descendant lists gray candidates. */
  hasGray: boolean;
}

function buildContent(
  node: FolderTreeNode,
  skillsByFolder: Map<string, SkillSummary[]>,
  grayByFolder: Map<string, GrayCandidate[]>,
): FolderContent {
  const skills = (skillsByFolder.get(node.folder.id) ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const gray = grayByFolder.get(node.folder.id) ?? [];
  const allChildren = node.children.map((child) => ({
    node: child,
    content: buildContent(child, skillsByFolder, grayByFolder),
  }));
  const hasGray = gray.length > 0 || allChildren.some((child) => child.content.hasGray);
  const children = allChildren.filter(
    (child) => child.content.subtree.length > 0 || child.content.hasGray,
  );
  return {
    skills,
    children,
    gray,
    subtree: [...skills, ...children.flatMap((child) => child.content.subtree)],
    hasGray,
  };
}

function prepare(tree: SkillFolderTree, skills: readonly SkillSummary[]) {
  const placements = placementBySkillId(tree.placements);
  const skillsByFolder = new Map<string, SkillSummary[]>();
  const uncategorized: SkillSummary[] = [];
  for (const skill of skills) {
    const folderId = placements.get(skill.id)?.folder_id ?? null;
    if (folderId === null) uncategorized.push(skill);
    else {
      const list = skillsByFolder.get(folderId) ?? [];
      list.push(skill);
      skillsByFolder.set(folderId, list);
    }
  }
  const grayByFolder = new Map<string, GrayCandidate[]>();
  for (const candidate of grayCandidates(tree)) {
    const list = grayByFolder.get(candidate.folderId) ?? [];
    list.push(candidate);
    grayByFolder.set(candidate.folderId, list);
  }
  const roots = buildFolderNodes(tree.folders)
    .map((node) => ({ node, content: buildContent(node, skillsByFolder, grayByFolder) }))
    .filter((entry) => entry.content.subtree.length > 0 || entry.content.hasGray);
  return {
    roots,
    uncategorized: uncategorized.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Folders whose subtree holds no selectable skill start collapsed (they may
 *  still show gray candidates); every folder with selectable skills starts
 *  expanded so the caller's set is visible. */
export function defaultCollapsedFolderIds(
  tree: SkillFolderTree,
  skills: readonly SkillSummary[],
): Set<string> {
  const { roots } = prepare(tree, skills);
  const collapsed = new Set<string>();
  const walk = (entries: { node: FolderTreeNode; content: FolderContent }[]) => {
    for (const { node, content } of entries) {
      if (content.subtree.length === 0) collapsed.add(node.folder.id);
      walk(content.children);
    }
  };
  walk(roots);
  return collapsed;
}

export function buildPickerModel(
  tree: SkillFolderTree,
  skills: readonly SkillSummary[],
  collapsed: ReadonlySet<string>,
): PickerModel {
  const { roots, uncategorized } = prepare(tree, skills);
  const rows: PickerRow[] = [];
  const subtreeSkills = new Map<string, SkillSummary[]>();

  const emit = (entries: { node: FolderTreeNode; content: FolderContent }[], depth: number) => {
    for (const { node, content } of entries) {
      const folderId = node.folder.id;
      subtreeSkills.set(folderId, content.subtree);
      const expandable =
        content.children.length > 0 || content.skills.length > 0 || content.gray.length > 0;
      rows.push({ kind: "folder", folderId, name: node.folder.name, depth, expandable });
      if (expandable && !collapsed.has(folderId)) {
        emit(content.children, depth + 1);
        for (const skill of content.skills) rows.push({ kind: "skill", skill, depth: depth + 1 });
        for (const candidate of content.gray) rows.push({ kind: "gray", candidate, depth: depth + 1 });
      }
    }
  };
  emit(roots, 0);

  if (uncategorized.length > 0) {
    subtreeSkills.set(PICKER_UNCATEGORIZED_ID, uncategorized);
    rows.push({
      kind: "folder",
      folderId: PICKER_UNCATEGORIZED_ID,
      name: "",
      depth: 0,
      expandable: true,
    });
    if (!collapsed.has(PICKER_UNCATEGORIZED_ID)) {
      for (const skill of uncategorized) rows.push({ kind: "skill", skill, depth: 1 });
    }
  }

  return { rows, subtreeSkills };
}

export interface PickerSearchResult {
  skills: { skill: SkillSummary; path: string }[];
  gray: { candidate: GrayCandidate; path: string }[];
}

/** Search flattens the tree: matching skills and gray candidates carry their
 *  folder path so the tree context stays visible. */
export function searchPickerModel(
  tree: SkillFolderTree,
  skills: readonly SkillSummary[],
  query: string,
  uncategorizedLabel: string,
): PickerSearchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { skills: [], gray: [] };
  const placements = placementBySkillId(tree.placements);
  const pathFor = (skill: SkillSummary): string => {
    const folderId = placements.get(skill.id)?.folder_id;
    return folderId ? folderDisplayPath(tree.folders, folderId) : uncategorizedLabel;
  };
  const matchedSkills = skills
    .filter((s) => {
      const name = s.name.toLowerCase();
      const description = s.description?.toLowerCase() ?? "";
      return name.includes(q) || description.includes(q);
    })
    .map((skill) => ({ skill, path: pathFor(skill) }));
  const matchedGray = grayCandidates(tree)
    .filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    .map((candidate) => ({
      candidate,
      path: folderDisplayPath(tree.folders, candidate.folderId),
    }));
  return { skills: matchedSkills, gray: matchedGray };
}
