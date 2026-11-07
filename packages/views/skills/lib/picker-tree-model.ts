import type { SkillSummary } from "@multica/core/types";
import type { SkillFolderTree } from "@multica/core/api/schemas";
import {
  buildFolderNodes,
  folderDisplayPath,
  placementBySkillId,
  type FolderTreeNode,
} from "./skill-folder-tree";

// Tree model for the skill picker (OL-104): the folder tree pruned to the
// caller-provided selectable skills. Package candidates that were never
// imported are not listed here: they cannot be bound, and the skills page
// already surfaces them (OL-1267). Folders without visible skills are not
// rendered at all, so every rendered folder starts expanded.

export const PICKER_UNCATEGORIZED_ID = "__uncategorized__";

export type PickerRow =
  | { kind: "folder"; folderId: string; name: string; depth: number }
  | { kind: "skill"; skill: SkillSummary; depth: number };

export interface PickerModel {
  rows: PickerRow[];
  /** Visible selectable skills per folder row id (tri-state source). */
  subtreeSkills: Map<string, SkillSummary[]>;
}

interface FolderContent {
  skills: SkillSummary[];
  children: { node: FolderTreeNode; content: FolderContent }[];
  /** Visible skills in this folder's whole subtree (tri-state source). */
  subtree: SkillSummary[];
}

function buildContent(
  node: FolderTreeNode,
  skillsByFolder: Map<string, SkillSummary[]>,
): FolderContent {
  const skills = (skillsByFolder.get(node.folder.id) ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const children = node.children
    .map((child) => ({ node: child, content: buildContent(child, skillsByFolder) }))
    .filter((child) => child.content.subtree.length > 0);
  return {
    skills,
    children,
    subtree: [...skills, ...children.flatMap((child) => child.content.subtree)],
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
  const roots = buildFolderNodes(tree.folders)
    .map((node) => ({ node, content: buildContent(node, skillsByFolder) }))
    .filter((entry) => entry.content.subtree.length > 0);
  return {
    roots,
    uncategorized: uncategorized.sort((a, b) => a.name.localeCompare(b.name)),
  };
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
      rows.push({ kind: "folder", folderId, name: node.folder.name, depth });
      if (!collapsed.has(folderId)) {
        emit(content.children, depth + 1);
        for (const skill of content.skills) rows.push({ kind: "skill", skill, depth: depth + 1 });
      }
    }
  };
  emit(roots, 0);

  if (uncategorized.length > 0) {
    subtreeSkills.set(PICKER_UNCATEGORIZED_ID, uncategorized);
    rows.push({ kind: "folder", folderId: PICKER_UNCATEGORIZED_ID, name: "", depth: 0 });
    if (!collapsed.has(PICKER_UNCATEGORIZED_ID)) {
      for (const skill of uncategorized) rows.push({ kind: "skill", skill, depth: 1 });
    }
  }

  return { rows, subtreeSkills };
}

export interface PickerSearchMatch {
  skill: SkillSummary;
  path: string;
}

/** Search flattens the tree: matching skills carry their folder path so the
 *  tree context stays visible. */
export function searchPickerModel(
  tree: SkillFolderTree,
  skills: readonly SkillSummary[],
  query: string,
  uncategorizedLabel: string,
): PickerSearchMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const placements = placementBySkillId(tree.placements);
  const pathFor = (skill: SkillSummary): string => {
    const folderId = placements.get(skill.id)?.folder_id;
    return folderId ? folderDisplayPath(tree.folders, folderId) : uncategorizedLabel;
  };
  return skills
    .filter((s) => {
      const name = s.name.toLowerCase();
      const description = s.description?.toLowerCase() ?? "";
      return name.includes(q) || description.includes(q);
    })
    .map((skill) => ({ skill, path: pathFor(skill) }));
}
