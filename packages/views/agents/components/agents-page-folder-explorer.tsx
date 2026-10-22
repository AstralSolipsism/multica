"use client";

// Labrastro fork (OL-1030): folder explorer for the agents page. Custom
// folders come from the OL-1028 tree; squad folders are derived (squad id =
// folder id, managed). Mirrors the skills page's explorer hook; upstream
// `agents-page.tsx` only mounts navigationBar / notice / dialogs,
// organizeRows, renderRow, withCurrentFolder and treeActions.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ExternalLink,
  Folder,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { AgentSquadFolder } from "@multica/core/api/schemas";
import type { Agent } from "@multica/core/types";
import type { AgentListFilters } from "@multica/core/agents/stores";
import { agentFolderTreeOptions } from "@multica/core/agents/folder-queries";
import { useWorkspacePaths } from "@multica/core/paths";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import { Button } from "@multica/ui/components/ui/button";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { ListGridCell } from "@multica/ui/components/ui/list-grid";
import {
  FolderExplorerBreadcrumbs,
  FolderExplorerRow,
  NewFolderButton,
  directChildFolders,
  directEntries,
  entryPathHints,
  folderEntryCounts,
  folderLocationPath,
  folderPath,
  isManagedLocation,
  resolveFolderLocation,
  type FolderExplorerEntry,
  type FolderExplorerFolder,
} from "../../common/folder-explorer";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import {
  agentEntryFolderIds,
  agentMoveDestinations,
  explorerFolders,
  folderMoveDestinations,
  placementFolderByAgentId,
  squadById,
  squadIdsByAgentId,
  squadMoveDestinations,
} from "../lib/agent-folder-tree";
import {
  AgentFolderDeleteDialog,
  AgentFolderFormDialog,
  AgentFolderMoveDialog,
  MoveAgentsDialog,
  type AgentFolderFormState,
} from "./agent-folder-dialogs";
import type { AgentTreeActions } from "./agent-tree-actions";
import type { AgentListRow } from "./agents-page";
import type { AgentsScope } from "@multica/core/agents/stores";

export type AgentExplorerListRow =
  | {
      kind: "agent";
      row: AgentListRow;
      /** Flat view: every folder path this agent appears at (sorted). */
      pathHints?: string[];
      /** Set when the row is the leader of the squad folder being viewed. */
      leaderLabel?: string;
    }
  | { kind: "folder"; folder: FolderExplorerFolder; entryCount: number };

export type AgentExplorerAuxRow = Exclude<
  AgentExplorerListRow,
  { kind: "agent" }
>;

export interface AgentsPageListModel {
  rows: AgentExplorerListRow[];
  agentRows: AgentListRow[];
  emptyMessage: string | null;
}

export interface AgentsPageFolderExplorer {
  treeActions: AgentTreeActions | undefined;
  navigationBar: ReactNode;
  notice: ReactNode;
  dialogs: ReactNode;
  organizeRows: (rows: AgentListRow[]) => AgentsPageListModel;
  renderRow: (row: AgentExplorerAuxRow) => ReactNode;
  withCurrentFolder: (path: string) => string;
  treeLoading: boolean;
  treeReady: boolean;
  hasFolders: boolean;
}

// Placeholder cells so folder rows land on the same subgrid tracks as agent
// rows: status stays visible on narrow containers, the rest are wide-only.
function AgentGridTrailingCells() {
  return (
    <>
      <ListGridCell className="px-0" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
      <ListGridCell className="hidden px-0 @2xl:flex" />
    </>
  );
}

function AgentFolderRowMenu({
  folder,
  squad,
  canManageSquadFolder,
  onOpenSquad,
  onRename,
  onMove,
  onDelete,
}: {
  folder: FolderExplorerFolder;
  squad: AgentSquadFolder | null;
  canManageSquadFolder: boolean;
  onOpenSquad: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const { t } = useT("agent-folders");
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
      <DropdownMenuContent align="end" className="w-56">
        {squad ? (
          <>
            <DropdownMenuItem onClick={onOpenSquad}>
              <ExternalLink />
              {t(($) => $.tree.open_squad)}
            </DropdownMenuItem>
            {canManageSquadFolder ? (
              <DropdownMenuItem onClick={onMove}>
                <FolderInput />
                {t(($) => $.tree.move_to_folder)}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <FolderInput />
                <span className="flex min-w-0 flex-col">
                  <span>{t(($) => $.tree.move_to_folder)}</span>
                  <span className="whitespace-normal text-caption text-muted-foreground">
                    {t(($) => $.tree.squad_move_forbidden)}
                  </span>
                </span>
              </DropdownMenuItem>
            )}
          </>
        ) : (
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function useAgentsPageFolderExplorer({
  wsId,
  currentUserId,
  isAdmin,
  scope,
  search,
  filters,
  onMoved,
}: {
  wsId: string;
  currentUserId: string | null;
  /** Workspace owner/admin — may move any agent and any squad folder. */
  isAdmin: boolean;
  scope: AgentsScope;
  search: string;
  filters: AgentListFilters;
  onMoved: () => void;
}): AgentsPageFolderExplorer {
  const { t } = useT("agents");
  const { t: tFolder } = useT("agent-folders");
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const {
    data: folderTree,
    error: folderTreeError,
    failureCount: folderTreeFailures,
    refetch: refetchFolderTree,
  } = useQuery(agentFolderTreeOptions(wsId));
  const [moveAgents, setMoveAgents] = useState<{
    agents: Agent[];
    variant: "move" | "place";
  } | null>(null);
  const [folderForm, setFolderForm] = useState<AgentFolderFormState | null>(
    null,
  );
  const [folderMove, setFolderMove] = useState<FolderExplorerFolder | null>(
    null,
  );
  const [folderDelete, setFolderDelete] =
    useState<FolderExplorerFolder | null>(null);
  const previousFoldersRef = useRef<readonly FolderExplorerFolder[]>([]);

  // Never hide entries behind an unreachable tree: after the first failed
  // attempt (even with the retry still pending) or 5s without any data, fall
  // back to the flat list with a notice. Late data restores the hierarchy.
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
    folderTreeFailures > 0 ||
    treeWaitExpired;
  const treeLoading = !treeReady && !treeUnavailable;
  const flatRequested =
    search.trim().length > 0 ||
    Object.values(filters).some((values) => values.length > 0);
  // The archived scope is always a flat list; switching scope never enters
  // or leaves the hierarchy by itself.
  const isFlatView = treeUnavailable || flatRequested || scope === "archived";

  const folders = useMemo<FolderExplorerFolder[]>(
    () => (folderTree ? explorerFolders(folderTree) : []),
    [folderTree],
  );
  const squads = useMemo(
    () => (folderTree ? squadById(folderTree) : new Map<string, AgentSquadFolder>()),
    [folderTree],
  );

  const rawFolderId = navigation.searchParams.get("folder");
  const requestedFolderId = rawFolderId ? rawFolderId : null;
  const resolvedFolderId = useMemo(
    () =>
      treeReady
        ? resolveFolderLocation(
            requestedFolderId,
            folders,
            previousFoldersRef.current,
          )
        : requestedFolderId,
    [treeReady, requestedFolderId, folders],
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
    if (treeReady) previousFoldersRef.current = folders;
  }, [treeReady, folders]);

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

  const placements = useMemo(
    () => (treeReady && folderTree ? placementFolderByAgentId(folderTree) : null),
    [treeReady, folderTree],
  );
  const squadMemberships = useMemo(
    () => (treeReady && folderTree ? squadIdsByAgentId(folderTree) : null),
    [treeReady, folderTree],
  );

  const currentPath = useMemo(
    () => (resolvedFolderId ? folderPath(folders, resolvedFolderId) : []),
    [folders, resolvedFolderId],
  );
  const currentFolder = resolvedFolderId
    ? (folders.find((folder) => folder.id === resolvedFolderId) ?? null)
    : null;
  const currentSquad = resolvedFolderId
    ? (squads.get(resolvedFolderId) ?? null)
    : null;
  const managedLocation =
    treeReady && isManagedLocation(folders, resolvedFolderId);

  const entryFolderIdsFor = useCallback(
    (agentId: string): string[] =>
      agentEntryFolderIds(agentId, placements ?? new Map(), squadMemberships ?? new Map()),
    [placements, squadMemberships],
  );

  const organizeRows = useCallback(
    (rows: AgentListRow[]): AgentsPageListModel => {
      if (treeLoading) return { rows: [], agentRows: [], emptyMessage: null };

      const entries: FolderExplorerEntry[] = rows.map((row) => ({
        id: row.agent.id,
        folderIds: entryFolderIdsFor(row.agent.id),
      }));

      if (isFlatView) {
        return {
          rows: rows.map((row, index) => {
            const hints = entryPathHints(folders, entries[index]!);
            return {
              kind: "agent" as const,
              row,
              pathHints: hints.length > 0 ? hints : undefined,
            };
          }),
          agentRows: rows,
          emptyMessage: null,
        };
      }

      const directIds = new Set(
        directEntries(entries, resolvedFolderId, folders).map(
          (entry) => entry.id,
        ),
      );
      const agentRows = rows.filter((row) => directIds.has(row.agent.id));
      const counts = folderEntryCounts(folders, entries);
      const folderRows: AgentExplorerListRow[] = directChildFolders(
        folders,
        resolvedFolderId,
      ).map((folder) => ({
        kind: "folder",
        folder,
        entryCount: counts.get(folder.id) ?? 0,
      }));
      const leaderLabel = tFolder(($) => $.tree.leader_label);
      const agentListRows: AgentExplorerListRow[] = agentRows.map((row) => ({
        kind: "agent",
        row,
        leaderLabel:
          currentSquad && row.agent.id === currentSquad.leaderId
            ? leaderLabel
            : undefined,
      }));
      return {
        rows: [...folderRows, ...agentListRows],
        agentRows,
        emptyMessage:
          resolvedFolderId && folderRows.length + agentListRows.length === 0
            ? tFolder(($) => $.tree.empty_folder)
            : null,
      };
    },
    [
      treeLoading,
      isFlatView,
      entryFolderIdsFor,
      folders,
      resolvedFolderId,
      currentSquad,
      tFolder,
    ],
  );

  const renderRow = useCallback(
    (row: AgentExplorerAuxRow): ReactNode => {
      const { folder } = row;
      const squad = squads.get(folder.id) ?? null;
      const canManageSquadFolder =
        squad !== null &&
        (isAdmin ||
          (currentUserId !== null && squad.creatorId === currentUserId));
      return (
        <FolderExplorerRow
          key={`folder-${folder.id}`}
          className="h-16"
          name={folder.name}
          typeLabel={squad ? tFolder(($) => $.tree.squad_label) : undefined}
          countLabel={tFolder(($) => $.tree.folder_agent_count, {
            count: row.entryCount,
          })}
          openLabel={tFolder(($) => $.tree.open_folder, { name: folder.name })}
          onOpen={() => navigateFolder(folder.id)}
          icon={
            squad ? (
              <ActorAvatar
                name={squad.name}
                initials={squad.name.slice(0, 2).toUpperCase()}
                avatarUrl={resolvePublicFileUrl(squad.avatarUrl)}
                isSquad
                size="sm"
                className="shrink-0"
              />
            ) : undefined
          }
          leading={
            <ListGridCell className="hidden justify-center px-0 @2xl:flex" />
          }
          trailing={<AgentGridTrailingCells />}
          actions={
            <AgentFolderRowMenu
              folder={folder}
              squad={squad}
              canManageSquadFolder={canManageSquadFolder}
              onOpenSquad={() => {
                if (squad) navigation.push(paths.squadDetail(squad.squadId));
              }}
              onRename={() =>
                setFolderForm({ mode: "rename", folder })
              }
              onMove={() => setFolderMove(folder)}
              onDelete={() => setFolderDelete(folder)}
            />
          }
        />
      );
    },
    [squads, isAdmin, currentUserId, tFolder, navigateFolder, navigation, paths],
  );

  const treeActions: AgentTreeActions | undefined =
    treeReady && placements && squadMemberships
      ? {
          // "Also place" applies only inside a squad folder in the hierarchy
          // view: the member never leaves the squad folder, it only gains a
          // custom placement. Flat search/filter results and other locations
          // keep the plain "move" wording.
          defaultVariant: !isFlatView && currentSquad ? "place" : "move",
          onMove: (agents, variant) => setMoveAgents({ agents, variant }),
        }
      : undefined;

  const navigationBar = (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-6 py-1.5">
      {flatRequested || scope === "archived" ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-caption text-muted-foreground">
          <Folder aria-hidden="true" className="size-3.5 shrink-0" />
          <span>
            {flatRequested
              ? tFolder(($) => $.tree.flat_results)
              : tFolder(($) => $.tree.flat_archived)}
          </span>
        </div>
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <FolderExplorerBreadcrumbs
              ariaLabel={tFolder(($) => $.tree.breadcrumb_aria)}
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
            onClick={() => navigateFolder(currentFolder?.parentId ?? null)}
          >
            <ArrowUp aria-hidden="true" className="size-3.5" />
            {tFolder(($) => $.tree.up)}
          </Button>
          <NewFolderButton
            label={tFolder(($) => $.tree.new_folder)}
            disabled={!treeReady || managedLocation}
            disabledReason={
              managedLocation
                ? tFolder(($) => $.tree.squad_new_folder_hint)
                : undefined
            }
            onClick={() =>
              setFolderForm({ mode: "create", parentId: resolvedFolderId })
            }
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
      <span className="min-w-0 flex-1">
        {tFolder(($) => $.tree.unavailable)}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => refetchFolderTree()}
      >
        {tFolder(($) => $.tree.retry)}
      </Button>
    </div>
  ) : null;

  const dialogs = (
    <>
      {moveAgents && treeReady && (
        <MoveAgentsDialog
          wsId={wsId}
          folders={folders}
          destinations={agentMoveDestinations(folders)}
          agents={moveAgents.agents}
          hasSquadMembers={moveAgents.agents.some((agent) =>
            squadMemberships?.has(agent.id),
          )}
          variant={moveAgents.variant}
          open
          onOpenChange={(open) => {
            if (!open) setMoveAgents(null);
          }}
          onMoved={onMoved}
        />
      )}
      {folderForm && (
        <AgentFolderFormDialog
          wsId={wsId}
          state={folderForm}
          onClose={() => setFolderForm(null)}
        />
      )}
      {folderMove && treeReady && (
        <AgentFolderMoveDialog
          wsId={wsId}
          folders={folders}
          destinations={
            folderMove.managed
              ? squadMoveDestinations(folders)
              : folderMoveDestinations(folders, folderMove.id)
          }
          folder={folderMove}
          onClose={() => setFolderMove(null)}
        />
      )}
      {folderDelete && (
        <AgentFolderDeleteDialog
          wsId={wsId}
          folder={folderDelete}
          onDeleted={() => {
            if (resolvedFolderId === folderDelete.id) {
              navigateFolder(folderDelete.parentId, "replace");
            }
          }}
          onClose={() => setFolderDelete(null)}
        />
      )}
    </>
  );

  return {
    treeActions,
    navigationBar,
    notice,
    dialogs,
    organizeRows,
    renderRow,
    withCurrentFolder: (path) =>
      folderLocationPath(path, new URLSearchParams(), resolvedFolderId),
    treeLoading,
    treeReady,
    hasFolders: (folderTree?.folders.length ?? 0) + (folderTree?.squads.length ?? 0) > 0,
  };
}
