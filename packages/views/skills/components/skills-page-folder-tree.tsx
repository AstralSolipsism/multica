"use client";

// Labrastro fork (OL-104): folder tree, package import and move/detach wiring
// for the skills page. Upstream `skills-page.tsx` keeps one hook call and a
// few one-line slots; the query, selection state, row filter, panel, filter
// strip and dialogs live here so upstream changes to the page merge without
// touching them.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Folder, PackagePlus, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import {
  invalidateSkillPackageQueries,
  skillFolderTreeOptions,
} from "@multica/core/skills/package-queries";
import { useT } from "../../i18n";
import { CollectionPageHeaderAction } from "../../layout/collection-page";
import {
  buildFolderSkillIndex,
  placementBySkillId,
  type FolderSelection,
} from "../lib/skill-folder-tree";
import { MoveSkillsDialog } from "./move-skills-dialog";
import { ImportPackageDialog } from "./package-import-dialog";
import { SkillFolderTreePanel } from "./skill-folder-tree-panel";
import type { SkillRow } from "./skill-list-filter";
import type { SkillTreeActions } from "./skill-tree-actions";

export interface SkillsPageFolderTree {
  /** `SkillActionsContext.treeActions`: only a readable tree unlocks them. */
  treeActions: SkillTreeActions | undefined;
  /** Folder-selection predicate for `pruneToFolder`; null keeps every row. */
  rowFilter: ((row: SkillRow) => boolean) | null;
  /** Header "Import package" handler. */
  openImport: () => void;
  /** Folder panel for `SkillFolderTreeLayout`. */
  panel: ReactNode;
  /** Clearable folder-filter strip shown while the panel is hidden. */
  filterChip: ReactNode;
  /** Package import and move-to-folder dialogs. */
  dialogs: ReactNode;
}

export function useSkillsPageFolderTree({
  wsId,
  currentUserId,
  isAdmin,
  onMoved,
}: {
  wsId: string;
  currentUserId: string | null;
  isAdmin: boolean;
  /** Fired after a successful move; the page clears its selection. */
  onMoved: () => void;
}): SkillsPageFolderTree {
  const { t: tPkg } = useT("skill-packages");
  const qc = useQueryClient();
  // Folder tree (OL-104): undefined while loading, null when the response
  // was unreadable — the list then renders unfiltered, exactly as before.
  const {
    data: folderTree,
    error: folderTreeError,
    refetch: refetchFolderTree,
  } = useQuery(skillFolderTreeOptions(wsId));

  const [importOpen, setImportOpen] = useState(false);
  const [folderSelection, setFolderSelection] = useState<FolderSelection>({
    kind: "all",
  });
  const [moveRows, setMoveRows] = useState<SkillRow[] | null>(null);

  const placementsBySkill = useMemo(
    () => (folderTree ? placementBySkillId(folderTree.placements) : null),
    [folderTree],
  );

  const handleDetach = async (row: SkillRow) => {
    try {
      const result = await api.detachSkillPlacement(wsId, row.skill.id);
      if (result === null) {
        toast.error(tPkg(($) => $.detach.failed));
        return;
      }
      await invalidateSkillPackageQueries(qc, wsId);
      toast.success(tPkg(($) => $.detach.done));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : tPkg(($) => $.detach.failed),
      );
    }
  };

  // Only a readable tree unlocks the move/detach row actions; without it
  // the rows keep their pre-tree flat behavior.
  const treeActions: SkillTreeActions | undefined = placementsBySkill
    ? {
        placementFor: (skillId) => placementsBySkill.get(skillId) ?? null,
        onMove: (rows) => setMoveRows(rows),
        onDetach: (row) => void handleDetach(row),
      }
    : undefined;

  // Visible rows: the page's name search + filters, then this folder
  // selection. The folder index is built once per tree instead of per row
  // per render.
  const folderSkillIndex = useMemo(
    () => (folderTree ? buildFolderSkillIndex(folderTree) : null),
    [folderTree],
  );

  // A selected folder that disappears (deleted here or by another member)
  // drops the filter back to All instead of silently emptying the list.
  useEffect(() => {
    if (folderSelection.kind !== "folder" || !folderTree) return;
    if (!folderTree.folders.some((f) => f.id === folderSelection.folderId)) {
      setFolderSelection({ kind: "all" });
    }
  }, [folderTree, folderSelection]);

  const rowFilter = useMemo(() => {
    if (!folderSkillIndex || folderSelection.kind === "all") return null;
    if (folderSelection.kind === "uncategorized") {
      return (row: SkillRow) => !folderSkillIndex.placed.has(row.skill.id);
    }
    const { folderId } = folderSelection;
    return (row: SkillRow) =>
      folderSkillIndex.byFolder.get(folderId)?.has(row.skill.id) ?? false;
  }, [folderSkillIndex, folderSelection]);

  const panel = (
    <SkillFolderTreePanel
      wsId={wsId}
      tree={folderTree}
      treeError={!!folderTreeError}
      onRetryTree={() => refetchFolderTree()}
      selection={folderSelection}
      onSelect={setFolderSelection}
      currentUserId={currentUserId}
      isAdmin={isAdmin}
      className="hidden @2xl:flex"
    />
  );

  // The folder panel hides below @2xl; an active folder filter must stay
  // visible (and clearable) there.
  const filterChip =
    folderSelection.kind !== "all" ? (
      <div className="flex shrink-0 items-center gap-1.5 border-b px-6 py-1.5 text-caption text-muted-foreground @2xl:hidden">
        <Folder className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {folderSelection.kind === "uncategorized"
            ? tPkg(($) => $.tree.uncategorized)
            : (folderTree?.folders.find((f) => f.id === folderSelection.folderId)?.name ?? "")}
        </span>
        <button
          type="button"
          aria-label={tPkg(($) => $.tree.clear_filter)}
          onClick={() => setFolderSelection({ kind: "all" })}
          className="shrink-0 rounded-xs p-0.5 transition-colors hover:bg-accent"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    ) : null;

  const dialogs = (
    <>
      {importOpen && (
        <ImportPackageDialog
          wsId={wsId}
          open
          onOpenChange={(v) => { if (!v) setImportOpen(false); }}
        />
      )}
      {moveRows && folderTree && (
        <MoveSkillsDialog
          wsId={wsId}
          tree={folderTree}
          rows={moveRows}
          open
          onOpenChange={(v) => { if (!v) setMoveRows(null); }}
          onMoved={onMoved}
        />
      )}
    </>
  );

  return {
    treeActions,
    rowFilter,
    openImport: () => setImportOpen(true),
    panel,
    filterChip,
    dialogs,
  };
}

/**
 * Drops rows outside the selected folder, in place and order-preserving, so
 * the page's freshly filtered array keeps its identity for the sort below.
 */
export function pruneToFolder(
  rows: SkillRow[],
  rowFilter: ((row: SkillRow) => boolean) | null,
): void {
  if (!rowFilter) return;
  let kept = 0;
  for (const row of rows) {
    if (rowFilter(row)) rows[kept++] = row;
  }
  rows.length = kept;
}

/**
 * The folder panel joins the list above the grid's own @container, so the
 * existing two-zone column behavior is untouched. Below @2xl the panel
 * hides, matching the column-collapse tradeoff.
 */
export function SkillFolderTreeLayout({
  panel,
  children,
}: {
  panel: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 @container">
      {panel}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** Page-header "Import package" action, placed before "New skill". */
export function SkillPackageImportAction({ onClick }: { onClick: () => void }) {
  const { t: tPkg } = useT("skill-packages");
  return (
    <CollectionPageHeaderAction
      icon={PackagePlus}
      label={tPkg(($) => $.import.action)}
      onClick={onClick}
    />
  );
}
