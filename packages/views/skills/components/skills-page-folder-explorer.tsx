"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Folder,
  FolderPlus,
  Inbox,
  Layers,
  Package,
  Package as PackagePlus,
  Pencil,
  Trash2,
} from "@multica/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SkillFolder, SkillPackage } from "@multica/core/api/schemas";
import type { Agent } from "@multica/core/types";
import type { SkillListFilters } from "@multica/core/skills/stores";
import { api } from "@multica/core/api";
import {
  invalidateSkillPackageQueries,
  skillFolderTreeOptions,
} from "@multica/core/skills/package-queries";
import { Button } from "@multica/ui/components/ui/button";
import { IconButton } from "@multica/ui/components/common/icon-button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@multica/ui/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import {
  FolderExplorerDepth,
  FolderExplorerHeaderActions,
  FolderExplorerNameCell,
  flattenFolderExplorerRows,
  folderEntryCounts,
  folderPathLabel,
  useFolderExplorerExpansion,
  type FolderExplorerEntry,
  type FolderExplorerFolder,
} from "../../common/folder-explorer";
import { useT } from "../../i18n";
import {
  CollectionNameCell,
  CollectionRowMenu,
  CollectionTag,
  type CollectionColumn,
  type CollectionSelection,
} from "../../layout/collection-list";
import {
  grayCandidates,
  isCustomFolder,
  isPackageRootFolder,
  packageForRootFolder,
  placementBySkillId,
  type GrayCandidate,
} from "../lib/skill-folder-tree";
import { MoveSkillsDialog } from "./move-skills-dialog";
import { ImportPackageDialog } from "./package-import-dialog";
import { PackageRemoveDialog } from "./package-remove-dialog";
import { RescanPackageDialog } from "./package-rescan-dialog";
import {
  SkillFolderDeleteDialog,
  SkillFolderFormDialog,
  SkillFolderMoveDialog,
  type SkillFolderFormState,
} from "./skill-folder-dialogs";
import {
  SkillRowActions,
  type SkillActionsContext,
} from "./skill-list-actions";
import type { SkillRow } from "./skill-list-filter";
import type { SkillTreeActions } from "./skill-tree-actions";

interface SkillExplorerRowBase {
  key: string;
  parentFolderId: string | null;
  depth: number;
}

export type SkillExplorerSkillRow = SkillExplorerRowBase & {
  kind: "skill";
  row: SkillRow;
  pathHint?: string;
};

export type SkillExplorerFolderRow = SkillExplorerRowBase & {
  kind: "folder";
  folder: SkillFolder;
  entryCount: number;
};

export type SkillExplorerCandidateRow = SkillExplorerRowBase & {
  kind: "candidate";
  candidate: GrayCandidate;
};

export type SkillExplorerListRow =
  | SkillExplorerSkillRow
  | SkillExplorerFolderRow
  | SkillExplorerCandidateRow;

export interface SkillsPageListModel {
  rows: SkillExplorerListRow[];
  skillRows: SkillRow[];
  emptyMessage: string | null;
}

export interface SkillsPageFolderExplorer {
  treeActions: SkillTreeActions | undefined;
  actionsCtx: SkillActionsContext;
  openImport: () => void;
  headerActions: ReactNode;
  notice: ReactNode;
  dialogs: ReactNode;
  organizeRows: (rows: SkillRow[]) => SkillsPageListModel;
  explorerColumns: (
    columns: readonly CollectionColumn<SkillRow>[],
  ) => CollectionColumn<SkillExplorerListRow>[];
  rowMenu: (row: SkillExplorerListRow) => ReactNode;
  selection: (
    selectedIds: ReadonlySet<string>,
    onChange: (next: ReadonlySet<string>) => void,
  ) => CollectionSelection<SkillExplorerListRow>;
  onRowOpen: (row: SkillExplorerListRow) => void;
  treeLoading: boolean;
  treeReady: boolean;
  hasFolders: boolean;
}

function SkillFolderMenuItems({
  folder,
  pkg,
  canManagePackage,
  onCreateSubfolder,
  onRename,
  onMove,
  onDelete,
  onRescan,
  onRemove,
}: {
  folder: SkillFolder;
  pkg: SkillPackage | null;
  canManagePackage: boolean;
  onCreateSubfolder: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onRescan: () => void;
  onRemove: (mode: "dissolve" | "delete") => void;
}) {
  const { t } = useT("skill-packages");
  const custom = isCustomFolder(folder);
  if (!custom && pkg === null) return null;
  return (
    <>
      {custom && (
        <>
          <DropdownMenuItem onClick={onCreateSubfolder}>
            <FolderPlus />
            {t(($) => $.tree.new_subfolder)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRename}>
            <Pencil />
            {t(($) => $.tree.rename_folder)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onMove}>
            <Folder />
            {t(($) => $.tree.move_folder)}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
            {t(($) => $.tree.delete_folder)}
          </DropdownMenuItem>
        </>
      )}
      {pkg && !canManagePackage && (
        <DropdownMenuItem disabled>
          {t(($) => $.tree.package_forbidden)}
        </DropdownMenuItem>
      )}
      {pkg && (
        <>
          <DropdownMenuItem disabled={!canManagePackage} onClick={onRescan}>
            <Package />
            {t(($) => $.tree.rescan_package)}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canManagePackage} onClick={onRename}>
            <Pencil />
            {t(($) => $.tree.rename_folder)}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canManagePackage} onClick={onMove}>
            <Folder />
            {t(($) => $.tree.move_folder)}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canManagePackage} onClick={() => onRemove("dissolve")}>
            <Inbox />
            {t(($) => $.tree.dissolve_package)}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={!canManagePackage}
            onClick={() => onRemove("delete")}
          >
            <Trash2 />
            {t(($) => $.tree.delete_package)}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

export function useSkillsPageFolderExplorer({
  wsId,
  currentUserId,
  isAdmin,
  agents,
  search,
  filters,
  renderSkillName,
  onMoved,
}: {
  wsId: string;
  currentUserId: string | null;
  isAdmin: boolean;
  agents: Agent[];
  search: string;
  filters: SkillListFilters;
  renderSkillName: (row: SkillExplorerSkillRow) => ReactNode;
  onMoved: () => void;
}): SkillsPageFolderExplorer {
  const { t: tPkg } = useT("skill-packages");
  const qc = useQueryClient();
  const {
    data: folderTree,
    error: folderTreeError,
    failureCount: folderTreeFailures,
    refetch: refetchFolderTree,
  } = useQuery(skillFolderTreeOptions(wsId));
  const [importOpen, setImportOpen] = useState(false);
  const [moveRows, setMoveRows] = useState<SkillRow[] | null>(null);
  const [folderForm, setFolderForm] = useState<SkillFolderFormState | null>(null);
  const [folderMove, setFolderMove] = useState<SkillFolder | null>(null);
  const [folderDelete, setFolderDelete] = useState<SkillFolder | null>(null);
  const [rescanPkg, setRescanPkg] = useState<SkillPackage | null>(null);
  const [remove, setRemove] = useState<{
    pkg: SkillPackage;
    mode: "dissolve" | "delete";
  } | null>(null);
  const {
    expandedFolderIds,
    toggleFolder,
    expandFolder,
    expandAll,
    collapseAll,
  } = useFolderExplorerExpansion("skills", wsId);

  // Never hide entries behind an unreachable tree: after the first failed
  // attempt with no data yet (even with the retry still pending) or 5s
  // without any data, fall back to the flat list with a notice. Late data
  // restores the hierarchy. A failed background refetch that still has the
  // cached tree keeps the hierarchy — the retry usually succeeds.
  const [treeWaitExpired, setTreeWaitExpired] = useState(false);
  useEffect(() => {
    if (folderTree || folderTreeError) {
      setTreeWaitExpired(false);
      return;
    }
    const timer = setTimeout(() => setTreeWaitExpired(true), 5000);
    return () => clearTimeout(timer);
  }, [folderTree, folderTreeError]);

  const treeReady = !!folderTree && !folderTreeError;
  const treeUnavailable =
    folderTree === null ||
    !!folderTreeError ||
    (folderTree === undefined && folderTreeFailures > 0) ||
    treeWaitExpired;
  const treeLoading = !treeReady && !treeUnavailable;
  const flatRequested =
    search.trim().length > 0 || Object.values(filters).some((values) => values.length > 0);
  const isFlatView = treeUnavailable || flatRequested;
  const explorerFolders = useMemo<FolderExplorerFolder[]>(
    () =>
      (folderTree?.folders ?? []).map((folder) => ({
        id: folder.id,
        parentId: folder.parent_id,
        name: folder.name,
        managed: folder.package_id !== null,
      })),
    [folderTree],
  );
  const pathLabels = useMemo(
    () =>
      new Map(
        explorerFolders.map((folder) => [
          folder.id,
          folderPathLabel(explorerFolders, folder.id),
        ]),
      ),
    [explorerFolders],
  );
  const placementsBySkill = useMemo(
    () => (treeReady && folderTree ? placementBySkillId(folderTree.placements) : null),
    [treeReady, folderTree],
  );
  const skillFolderById = useMemo(
    () => new Map((folderTree?.folders ?? []).map((folder) => [folder.id, folder])),
    [folderTree],
  );
  const entryCounts = useMemo(() => {
    const entries: FolderExplorerEntry[] = (folderTree?.placements ?? []).map((placement) => ({
      id: placement.skill_id,
      folderIds: [placement.folder_id],
    }));
    return folderEntryCounts(explorerFolders, entries);
  }, [folderTree, explorerFolders]);
  const grayByFolder = useMemo(() => {
    const map = new Map<string, GrayCandidate[]>();
    if (!treeReady || !folderTree) return map;
    for (const candidate of grayCandidates(folderTree)) {
      const list = map.get(candidate.folderId) ?? [];
      list.push(candidate);
      map.set(candidate.folderId, list);
    }
    return map;
  }, [treeReady, folderTree]);

  const handleDetach = useCallback(
    async (row: SkillRow) => {
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
          err instanceof Error && err.message ? err.message : tPkg(($) => $.detach.failed),
        );
      }
    },
    [wsId, qc, tPkg],
  );

  const treeActions = useMemo<SkillTreeActions | undefined>(
    () =>
      placementsBySkill
        ? {
            placementFor: (skillId) => placementsBySkill.get(skillId) ?? null,
            onMove: (rows) => setMoveRows(rows),
            onDetach: (row) => void handleDetach(row),
          }
        : undefined,
    [placementsBySkill, handleDetach],
  );
  const actionsCtx = useMemo<SkillActionsContext>(
    () => ({
      wsId,
      agents,
      currentUserId,
      isAdmin,
      treeActions,
    }),
    [wsId, agents, currentUserId, isAdmin, treeActions],
  );

  const organizeRows = useCallback(
    (rows: SkillRow[]): SkillsPageListModel => {
      if (treeLoading) return { rows: [], skillRows: [], emptyMessage: null };
      if (isFlatView) {
        return {
          rows: rows.map((row) => {
            const placement = placementsBySkill?.get(row.skill.id);
            const pathHint = placement ? pathLabels.get(placement.folder_id) : undefined;
            return {
              kind: "skill" as const,
              key: `skill-root-${row.skill.id}`,
              parentFolderId: null,
              depth: 0,
              row,
              pathHint,
            };
          }),
          skillRows: [...new Map(rows.map((row) => [row.skill.id, row])).values()],
          emptyMessage: null,
        };
      }

      const skillEntries = rows.map((row) => {
        const folderId = placementsBySkill?.get(row.skill.id)?.folder_id;
        return {
          id: row.skill.id,
          folderIds: folderId ? [folderId] : [],
          kind: "skill" as const,
          row,
        };
      });
      const candidateEntries = [...grayByFolder.values()].flat().map((candidate) => ({
        id: `${candidate.packageId}-${candidate.path}`,
        folderIds: [candidate.folderId],
        kind: "candidate" as const,
        candidate,
      }));
      const flattened = flattenFolderExplorerRows({
        folders: explorerFolders,
        entries: [...skillEntries, ...candidateEntries],
        expandedFolderIds,
        entryKey: (entry) =>
          entry.kind === "skill"
            ? `skill-${entry.id}`
            : `candidate-${entry.candidate.packageId}-${entry.candidate.path}`,
      });
      const organized: SkillExplorerListRow[] = [];
      const visibleSkillRows = new Map<string, SkillRow>();
      for (const flatRow of flattened) {
        if (flatRow.kind === "folder") {
          const folder = skillFolderById.get(flatRow.folder.id);
          if (!folder) continue;
          organized.push({
            kind: "folder",
            key: flatRow.key,
            parentFolderId: flatRow.parentFolderId,
            depth: flatRow.depth,
            folder,
            entryCount: entryCounts.get(folder.id) ?? 0,
          });
          continue;
        }
        if (flatRow.entry.kind === "candidate") {
          organized.push({
            kind: "candidate",
            key: flatRow.key,
            parentFolderId: flatRow.parentFolderId,
            depth: flatRow.depth,
            candidate: flatRow.entry.candidate,
          });
          continue;
        }
        visibleSkillRows.set(flatRow.entry.row.skill.id, flatRow.entry.row);
        organized.push({
          kind: "skill",
          key: flatRow.key,
          parentFolderId: flatRow.parentFolderId,
          depth: flatRow.depth,
          row: flatRow.entry.row,
        });
      }
      return {
        rows: organized,
        skillRows: [...visibleSkillRows.values()],
        emptyMessage: null,
      };
    },
    [
      treeLoading,
      isFlatView,
      placementsBySkill,
      pathLabels,
      explorerFolders,
      expandedFolderIds,
      skillFolderById,
      entryCounts,
      grayByFolder,
    ],
  );

  const renderFolderName = useCallback(
    (row: SkillExplorerFolderRow): ReactNode => {
      const { folder } = row;
      const expanded = expandedFolderIds.has(folder.id);
      return (
        <FolderExplorerNameCell
          name={folder.name}
          typeLabel={folder.package_id !== null ? tPkg(($) => $.tree.package_label) : undefined}
          countLabel={tPkg(($) => $.tree.folder_skill_count, { count: row.entryCount })}
          openLabel={tPkg(
            expanded ? ($) => $.tree.collapse_folder : ($) => $.tree.expand_folder,
            { name: folder.name },
          )}
          onOpen={() => toggleFolder(folder.id)}
          expanded={expanded}
          depth={row.depth}
        />
      );
    },
    [tPkg, expandedFolderIds, toggleFolder],
  );

  const renderCandidateName = useCallback(
    (row: SkillExplorerCandidateRow): ReactNode => (
      <Tooltip>
        <TooltipTrigger
          render={
            <span aria-disabled="true" className="flex min-w-0 flex-1 items-center">
              <FolderExplorerDepth depth={row.depth} />
              <CollectionNameCell
                icon={<Package aria-hidden="true" className="size-4 shrink-0" />}
                title={row.candidate.name}
                badges={
                  <CollectionTag>{tPkg(($) => $.tree.not_imported)}</CollectionTag>
                }
              />
            </span>
          }
        />
        <TooltipContent side="top">{tPkg(($) => $.tree.gray_hint)}</TooltipContent>
      </Tooltip>
    ),
    [tPkg],
  );

  const explorerColumns = useCallback(
    (
      columns: readonly CollectionColumn<SkillRow>[],
    ): CollectionColumn<SkillExplorerListRow>[] =>
      columns.map((column, index) => ({
        ...column,
        cell: (listRow) => {
          if (listRow.kind === "skill") {
            return index === 0
              ? renderSkillName(listRow)
              : column.cell(listRow.row);
          }
          if (index !== 0) return null;
          return listRow.kind === "folder"
            ? renderFolderName(listRow)
            : renderCandidateName(listRow);
        },
      })),
    [renderSkillName, renderFolderName, renderCandidateName],
  );

  const rowMenu = useCallback(
    (listRow: SkillExplorerListRow): ReactNode => {
      if (listRow.kind === "skill") {
        return <SkillRowActions row={listRow.row} ctx={actionsCtx} />;
      }
      if (listRow.kind === "candidate") return null;

      const { folder } = listRow;
      const pkg =
        treeReady && folderTree && isPackageRootFolder(folder)
          ? packageForRootFolder(folderTree, folder.id)
          : null;
      const custom = isCustomFolder(folder);
      if (!custom && pkg === null) return null;
      const canManagePackage =
        pkg !== null &&
        (isAdmin || (currentUserId !== null && pkg.created_by === currentUserId));
      return (
        <CollectionRowMenu
          label={tPkg(($) => $.tree.folder_actions, { name: folder.name })}
          contentClassName="w-44"
        >
          <SkillFolderMenuItems
            folder={folder}
            pkg={pkg}
            canManagePackage={canManagePackage}
            onCreateSubfolder={() => setFolderForm({ mode: "create", parentId: folder.id })}
            onRename={() => setFolderForm({ mode: "rename", folder })}
            onMove={() => setFolderMove(folder)}
            onDelete={() => setFolderDelete(folder)}
            onRescan={() => { if (pkg) setRescanPkg(pkg); }}
            onRemove={(mode) => { if (pkg) setRemove({ pkg, mode }); }}
          />
        </CollectionRowMenu>
      );
    },
    [actionsCtx, treeReady, folderTree, isAdmin, currentUserId, tPkg],
  );

  const selection = useCallback(
    (
      selectedIds: ReadonlySet<string>,
      onChange: (next: ReadonlySet<string>) => void,
    ): CollectionSelection<SkillExplorerListRow> => ({
      selectedIds,
      onChange,
      isSelectable: (row) => row.kind === "skill",
    }),
    [],
  );

  const onRowOpen = useCallback(
    (row: SkillExplorerListRow) => {
      if (row.kind === "folder") toggleFolder(row.folder.id);
    },
    [toggleFolder],
  );

  const headerActions = flatRequested && !treeUnavailable ? (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-caption text-muted-foreground">
      <Layers aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{tPkg(($) => $.tree.flat_results)}</span>
    </span>
  ) : treeReady && !isFlatView ? (
    <FolderExplorerHeaderActions
      hasFolders={explorerFolders.length > 0}
      expandAllLabel={tPkg(($) => $.tree.expand_all)}
      collapseAllLabel={tPkg(($) => $.tree.collapse_all)}
      newFolderLabel={tPkg(($) => $.tree.new_folder)}
      onExpandAll={() => expandAll(explorerFolders.map((folder) => folder.id))}
      onCollapseAll={collapseAll}
      onNewFolder={() => setFolderForm({ mode: "create", parentId: null })}
    />
  ) : null;

  const notice = treeUnavailable ? (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-warning/10 px-6 py-2 text-caption text-muted-foreground"
    >
      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">{tPkg(($) => $.tree.unavailable)}</span>
      <Button type="button" variant="outline" size="sm" onClick={() => refetchFolderTree()}>
        {tPkg(($) => $.tree.retry)}
      </Button>
    </div>
  ) : null;

  const dialogs = (
    <>
      {importOpen && (
        <ImportPackageDialog
          wsId={wsId}
          open
          onOpenChange={(open) => { if (!open) setImportOpen(false); }}
        />
      )}
      {moveRows && folderTree && treeReady && (
        <MoveSkillsDialog
          wsId={wsId}
          tree={folderTree}
          rows={moveRows}
          open
          onOpenChange={(open) => { if (!open) setMoveRows(null); }}
          onMoved={onMoved}
        />
      )}
      {folderForm && (
        <SkillFolderFormDialog
          wsId={wsId}
          state={folderForm}
          onCreated={(parentId) => {
            if (parentId) expandFolder(parentId);
          }}
          onClose={() => setFolderForm(null)}
        />
      )}
      {folderMove && folderTree && treeReady && (
        <SkillFolderMoveDialog
          wsId={wsId}
          tree={folderTree}
          folder={folderMove}
          onClose={() => setFolderMove(null)}
        />
      )}
      {folderDelete && (
        <SkillFolderDeleteDialog
          wsId={wsId}
          folder={folderDelete}
          onDeleted={() => {}}
          onClose={() => setFolderDelete(null)}
        />
      )}
      {rescanPkg && (
        <RescanPackageDialog
          wsId={wsId}
          pkg={rescanPkg}
          open
          onOpenChange={(open) => { if (!open) setRescanPkg(null); }}
        />
      )}
      {remove && (
        <PackageRemoveDialog
          wsId={wsId}
          pkg={remove.pkg}
          mode={remove.mode}
          open
          onOpenChange={(open) => { if (!open) setRemove(null); }}
        />
      )}
    </>
  );

  return {
    treeActions,
    actionsCtx,
    openImport: () => setImportOpen(true),
    headerActions,
    notice,
    dialogs,
    organizeRows,
    explorerColumns,
    rowMenu,
    selection,
    onRowOpen,
    treeLoading,
    treeReady,
    hasFolders: (folderTree?.folders.length ?? 0) > 0,
  };
}

export function SkillPackageImportAction({ onClick }: { onClick: () => void }) {
  const { t: tPkg } = useT("skill-packages");
  return (
    <IconButton
      label={tPkg(($) => $.import.action)}
      tooltipSide="bottom"
      className="text-muted-foreground"
      onClick={onClick}
    >
      <PackagePlus />
    </IconButton>
  );
}
