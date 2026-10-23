"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Folder,
  Inbox,
  Layers,
  MoreHorizontal,
  Package,
  PackagePlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SkillFolder, SkillPackage } from "@multica/core/api/schemas";
import type { SkillListFilters } from "@multica/core/skills/stores";
import { api } from "@multica/core/api";
import {
  invalidateSkillPackageQueries,
  skillFolderTreeOptions,
} from "@multica/core/skills/package-queries";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { ListGridCell, ListGridRow } from "@multica/ui/components/ui/list-grid";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import {
  FolderExplorerBreadcrumbs,
  FolderExplorerRow,
  NewFolderButton,
  directChildFolders,
  directEntries,
  folderEntryCounts,
  folderLocationPath,
  folderPath,
  folderPathLabel,
  isManagedLocation,
  resolveFolderLocation,
  type FolderExplorerEntry,
  type FolderExplorerFolder,
} from "../../common/folder-explorer";
import { useT } from "../../i18n";
import { CollectionPageHeaderAction } from "../../layout/collection-page";
import { useNavigation } from "../../navigation";
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
import type { SkillRow } from "./skill-list-filter";
import type { SkillTreeActions } from "./skill-tree-actions";

export type SkillExplorerListRow =
  | { kind: "skill"; row: SkillRow; pathHint?: string }
  | { kind: "folder"; folder: SkillFolder; entryCount: number }
  | { kind: "candidate"; candidate: GrayCandidate };

export type SkillExplorerAuxRow = Exclude<
  SkillExplorerListRow,
  { kind: "skill" }
>;

export interface SkillsPageListModel {
  rows: SkillExplorerListRow[];
  skillRows: SkillRow[];
  emptyMessage: string | null;
}

export interface SkillsPageFolderExplorer {
  treeActions: SkillTreeActions | undefined;
  openImport: () => void;
  navigationBar: ReactNode;
  notice: ReactNode;
  dialogs: ReactNode;
  organizeRows: (rows: SkillRow[]) => SkillsPageListModel;
  renderRow: (row: SkillExplorerAuxRow) => ReactNode;
  countLabel: (visible: number, total: number) => string | undefined;
  countTitle: () => string | undefined;
  withCurrentFolder: (path: string) => string;
  treeLoading: boolean;
  treeReady: boolean;
  hasFolders: boolean;
}

function SkillGridTrailingCells() {
  return (
    <>
      <ListGridCell className="px-0" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
    </>
  );
}

function SkillFolderRowMenu({
  folder,
  pkg,
  canManagePackage,
  onRename,
  onMove,
  onDelete,
  onRescan,
  onRemove,
}: {
  folder: SkillFolder;
  pkg: SkillPackage | null;
  canManagePackage: boolean;
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t(($) => $.tree.folder_actions, { name: folder.name })}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-44">
        {custom && (
          <>
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UnimportedSkillRow({ candidate }: { candidate: GrayCandidate }) {
  const { t } = useT("skill-packages");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ListGridRow
            tabIndex={0}
            aria-disabled="true"
            className="cursor-default text-faint-foreground hover:bg-transparent"
          >
            <ListGridCell className="px-0" />
            <ListGridCell className="gap-1.5">
              <Package aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 truncate text-body">{candidate.name}</span>
              <span className="shrink-0 rounded-xs bg-muted px-1 py-0.5 text-caption">
                {t(($) => $.tree.not_imported)}
              </span>
            </ListGridCell>
            <SkillGridTrailingCells />
            <ListGridCell className="px-0" />
          </ListGridRow>
        }
      />
      <TooltipContent side="top">{t(($) => $.tree.gray_hint)}</TooltipContent>
    </Tooltip>
  );
}

export function useSkillsPageFolderExplorer({
  wsId,
  currentUserId,
  isAdmin,
  search,
  filters,
  onMoved,
}: {
  wsId: string;
  currentUserId: string | null;
  isAdmin: boolean;
  search: string;
  filters: SkillListFilters;
  onMoved: () => void;
}): SkillsPageFolderExplorer {
  const { t } = useT("skills");
  const { t: tPkg } = useT("skill-packages");
  const navigation = useNavigation();
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
  const previousFoldersRef = useRef<readonly FolderExplorerFolder[]>([]);

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
  const rawFolderId = navigation.searchParams.get("folder");
  const requestedFolderId = rawFolderId ? rawFolderId : null;
  const resolvedFolderId = useMemo(
    () =>
      treeReady
        ? resolveFolderLocation(requestedFolderId, explorerFolders, previousFoldersRef.current)
        : requestedFolderId,
    [treeReady, requestedFolderId, explorerFolders],
  );

  useEffect(() => {
    if (!treeReady || rawFolderId === resolvedFolderId) return;
    navigation.replace(
      folderLocationPath(
        navigation.pathname,
        navigation.searchParams,
        resolvedFolderId,
        navigation.hash,
      ),
    );
  }, [treeReady, rawFolderId, resolvedFolderId, navigation]);

  useEffect(() => {
    if (treeReady) previousFoldersRef.current = explorerFolders;
  }, [treeReady, explorerFolders]);

  const navigateFolder = useCallback(
    (folderId: string | null, mode: "push" | "replace" = "push") => {
      const path = folderLocationPath(
        navigation.pathname,
        navigation.searchParams,
        folderId,
        navigation.hash,
      );
      if (mode === "replace") navigation.replace(path);
      else navigation.push(path);
    },
    [navigation],
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
        err instanceof Error && err.message ? err.message : tPkg(($) => $.detach.failed),
      );
    }
  };

  const treeActions: SkillTreeActions | undefined = placementsBySkill
    ? {
        placementFor: (skillId) => placementsBySkill.get(skillId) ?? null,
        onMove: (rows) => setMoveRows(rows),
        onDetach: (row) => void handleDetach(row),
      }
    : undefined;

  const organizeRows = useCallback(
    (rows: SkillRow[]): SkillsPageListModel => {
      if (treeLoading) return { rows: [], skillRows: [], emptyMessage: null };
      if (isFlatView) {
        return {
          rows: rows.map((row) => {
            const placement = placementsBySkill?.get(row.skill.id);
            const pathHint = placement ? pathLabels.get(placement.folder_id) : undefined;
            return { kind: "skill", row, pathHint };
          }),
          skillRows: rows,
          emptyMessage: null,
        };
      }

      const entries: FolderExplorerEntry[] = rows.map((row) => {
        const folderId = placementsBySkill?.get(row.skill.id)?.folder_id;
        return { id: row.skill.id, folderIds: folderId ? [folderId] : [] };
      });
      const directIds = new Set(
        directEntries(entries, resolvedFolderId, explorerFolders).map((entry) => entry.id),
      );
      const skillRows = rows.filter((row) => directIds.has(row.skill.id));
      const folderRows: SkillExplorerListRow[] = directChildFolders(
        explorerFolders,
        resolvedFolderId,
      ).flatMap((folder) => {
        const skillFolder = skillFolderById.get(folder.id);
        return skillFolder
          ? [{ kind: "folder", folder: skillFolder, entryCount: entryCounts.get(folder.id) ?? 0 }]
          : [];
      });
      const skillListRows: SkillExplorerListRow[] = skillRows.map((row) => ({
        kind: "skill",
        row,
      }));
      const candidateRows: SkillExplorerListRow[] = resolvedFolderId
        ? (grayByFolder.get(resolvedFolderId) ?? []).map((candidate) => ({
            kind: "candidate",
            candidate,
          }))
        : [];
      return {
        rows: [...folderRows, ...skillListRows, ...candidateRows],
        skillRows,
        emptyMessage:
          resolvedFolderId && folderRows.length + skillRows.length + candidateRows.length === 0
            ? tPkg(($) => $.tree.empty_folder)
            : null,
      };
    },
    [
      treeLoading,
      isFlatView,
      placementsBySkill,
      pathLabels,
      explorerFolders,
      resolvedFolderId,
      skillFolderById,
      entryCounts,
      grayByFolder,
      tPkg,
    ],
  );

  const renderRow = useCallback(
    (row: SkillExplorerAuxRow): ReactNode => {
      if (row.kind === "candidate") {
        return <UnimportedSkillRow key={`candidate-${row.candidate.packageId}-${row.candidate.path}`} candidate={row.candidate} />;
      }
      const folder = row.folder;
      const pkg =
        treeReady && folderTree && isPackageRootFolder(folder)
          ? packageForRootFolder(folderTree, folder.id)
          : null;
      const canManagePackage =
        pkg !== null &&
        (isAdmin || (currentUserId !== null && pkg.created_by === currentUserId));
      return (
        <FolderExplorerRow
          key={`folder-${folder.id}`}
          name={folder.name}
          typeLabel={folder.package_id !== null ? tPkg(($) => $.tree.package_label) : undefined}
          countLabel={tPkg(($) => $.tree.folder_skill_count, { count: row.entryCount })}
          openLabel={tPkg(($) => $.tree.open_folder, { name: folder.name })}
          onOpen={() => navigateFolder(folder.id)}
          leading={<ListGridCell className="px-0" />}
          trailing={<SkillGridTrailingCells />}
          actions={
            <SkillFolderRowMenu
              folder={folder}
              pkg={pkg}
              canManagePackage={canManagePackage}
              onRename={() => setFolderForm({ mode: "rename", folder })}
              onMove={() => setFolderMove(folder)}
              onDelete={() => setFolderDelete(folder)}
              onRescan={() => { if (pkg) setRescanPkg(pkg); }}
              onRemove={(mode) => { if (pkg) setRemove({ pkg, mode }); }}
            />
          }
        />
      );
    },
    [treeReady, folderTree, isAdmin, currentUserId, tPkg, navigateFolder],
  );

  const currentPath = resolvedFolderId ? folderPath(explorerFolders, resolvedFolderId) : [];
  const currentFolder = resolvedFolderId ? skillFolderById.get(resolvedFolderId) : undefined;
  const managedLocation = treeReady && isManagedLocation(explorerFolders, resolvedFolderId);
  const navigationBar = (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-6 py-1.5">
      {flatRequested ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-caption text-muted-foreground">
          <Layers aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{tPkg(($) => $.tree.flat_results)}</span>
        </div>
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <FolderExplorerBreadcrumbs
              ariaLabel={tPkg(($) => $.tree.breadcrumb_aria)}
              rootLabel={t(($) => $.page.title)}
              path={treeReady ? currentPath : []}
              onNavigate={navigateFolder}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!treeReady || !currentFolder}
            onClick={() => navigateFolder(currentFolder?.parent_id ?? null)}
          >
            <ArrowUp aria-hidden="true" className="size-3.5" />
            {tPkg(($) => $.tree.up)}
          </Button>
          <NewFolderButton
            label={tPkg(($) => $.tree.new_folder)}
            disabled={!treeReady || managedLocation}
            disabledReason={managedLocation ? tPkg(($) => $.tree.managed_new_folder) : undefined}
            onClick={() => setFolderForm({ mode: "create", parentId: resolvedFolderId })}
          />
        </>
      )}
    </div>
  );

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
        <SkillFolderFormDialog wsId={wsId} state={folderForm} onClose={() => setFolderForm(null)} />
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
          onDeleted={() => {
            if (resolvedFolderId === folderDelete.id) {
              navigateFolder(folderDelete.parent_id, "replace");
            }
          }}
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
    openImport: () => setImportOpen(true),
    navigationBar,
    notice,
    dialogs,
    organizeRows,
    renderRow,
    countLabel: (visible, total) =>
      isFlatView ? undefined : tPkg(($) => $.tree.folder_count, { visible, total }),
    countTitle: () => (isFlatView ? undefined : tPkg(($) => $.tree.folder_count_title)),
    withCurrentFolder: (path) => folderLocationPath(path, new URLSearchParams(), resolvedFolderId),
    treeLoading,
    treeReady,
    hasFolders: (folderTree?.folders.length ?? 0) > 0,
  };
}

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
