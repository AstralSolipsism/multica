"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Layers,
  Loader2,
  MoreHorizontal,
  Package,
  Pencil,
  Trash2,
} from "lucide-react";
import type {
  SkillFolder,
  SkillFolderTree,
  SkillPackage,
} from "@multica/core/api/schemas";
import { api } from "@multica/core/api";
import { invalidateSkillPackageQueries } from "@multica/core/skills/package-queries";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import {
  buildFolderNodes,
  folderMoveDestinations,
  grayCandidates,
  isCustomFolder,
  isPackageRootFolder,
  packageForRootFolder,
  type FolderSelection,
  type FolderTreeNode,
  type GrayCandidate,
} from "../lib/skill-folder-tree";
import { PackageRemoveDialog } from "./package-remove-dialog";
import { RescanPackageDialog } from "./package-rescan-dialog";

// ---------------------------------------------------------------------------
// Folder create / rename
// ---------------------------------------------------------------------------

type FolderFormState =
  | { mode: "create"; parentId: string | null }
  | { mode: "rename"; folder: SkillFolder };

function FolderFormDialog({
  wsId,
  state,
  onClose,
}: {
  wsId: string;
  state: FolderFormState;
  onClose: () => void;
}) {
  const { t } = useT("skill-packages");
  const qc = useQueryClient();
  const [name, setName] = useState(state.mode === "rename" ? state.folder.name : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const saved =
        state.mode === "create"
          ? await api.createSkillFolder(wsId, { name: trimmed, parent_id: state.parentId ?? "" })
          : await api.updateSkillFolder(wsId, state.folder.id, { name: trimmed });
      if (saved === null) {
        setError(t(($) => $.folder_form.failed));
        setSaving(false);
        return;
      }
      await invalidateSkillPackageQueries(qc, wsId);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.folder_form.failed),
      );
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {state.mode === "create"
              ? t(($) => $.folder_form.create_title)
              : t(($) => $.folder_form.rename_title)}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="skill-folder-name" className="text-caption text-muted-foreground">
            {t(($) => $.folder_form.name_label)}
          </Label>
          <Input
            id="skill-folder-name"
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            placeholder={t(($) => $.folder_form.name_placeholder)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          {error && (
            <p role="alert" className="text-caption text-destructive">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t(($) => $.folder_form.cancel)}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!name.trim() || saving}
            aria-busy={saving}
          >
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                {t(($) => $.folder_form.saving)}
              </>
            ) : state.mode === "create" ? (
              t(($) => $.folder_form.create)
            ) : (
              t(($) => $.folder_form.save)
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Folder move
// ---------------------------------------------------------------------------

function FolderMoveDialog({
  wsId,
  tree,
  folder,
  onClose,
}: {
  wsId: string;
  tree: SkillFolderTree;
  folder: SkillFolder;
  onClose: () => void;
}) {
  const { t } = useT("skill-packages");
  const qc = useQueryClient();
  // Roots may move into custom folders; custom folders move within the
  // custom tree. Managed internals never move (no menu entry reaches here).
  const destinations = useMemo(
    () => folderMoveDestinations(tree.folders, folder.id),
    [tree.folders, folder.id],
  );
  const [target, setTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (moving) return;
    setMoving(true);
    setError("");
    try {
      const moved = await api.updateSkillFolder(wsId, folder.id, {
        parent_id: target ?? "",
      });
      if (moved === null) {
        setError(t(($) => $.folder_move.failed));
        setMoving(false);
        return;
      }
      await invalidateSkillPackageQueries(qc, wsId);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.folder_move.failed),
      );
      setMoving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !moving) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t(($) => $.folder_move.title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.folder_move.description, { name: folder.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border bg-card p-1.5">
          <button
            type="button"
            aria-pressed={target === null}
            onClick={() => setTarget(null)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-body transition-colors",
              target === null ? "bg-accent" : "hover:bg-accent/50",
            )}
          >
            <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {t(($) => $.folder_move.root_option)}
          </button>
          {destinations.map((dest) => (
            <button
              key={dest.id}
              type="button"
              aria-pressed={target === dest.id}
              onClick={() => setTarget(dest.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-body transition-colors",
                target === dest.id ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{dest.name}</span>
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-caption text-destructive">{error}</p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={moving}>
            {t(($) => $.folder_move.cancel)}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={moving} aria-busy={moving}>
            {moving ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                {t(($) => $.folder_move.moving)}
              </>
            ) : (
              t(($) => $.folder_move.confirm)
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Folder delete
// ---------------------------------------------------------------------------

function FolderDeleteDialog({
  wsId,
  folder,
  onDeleted,
  onClose,
}: {
  wsId: string;
  folder: SkillFolder;
  /** Lets the panel fix up the selection when the deleted folder was it. */
  onDeleted: () => void;
  onClose: () => void;
}) {
  const { t } = useT("skill-packages");
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (deleting) return;
    setDeleting(true);
    setError("");
    try {
      const result = await api.deleteSkillFolder(wsId, folder.id);
      if (result === null) {
        setError(t(($) => $.folder_delete.failed));
        setDeleting(false);
        return;
      }
      await invalidateSkillPackageQueries(qc, wsId);
      onDeleted();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.folder_delete.failed),
      );
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(v) => { if (!v && !deleting) onClose(); }}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.folder_delete.title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(($) => $.folder_delete.description, { name: folder.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-caption text-destructive">{error}</p>
        )}
        <AlertDialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={deleting}>
            {t(($) => $.folder_delete.cancel)}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void submit()}
            disabled={deleting}
            aria-busy={deleting}
          >
            {deleting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                {t(($) => $.folder_delete.deleting)}
              </>
            ) : (
              t(($) => $.folder_delete.confirm)
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function SelectionRow({
  icon: Icon,
  label,
  selected,
  onClick,
}: {
  icon: typeof Layers;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      style={{ paddingLeft: 10 }}
      className={cn(
        "flex h-8 w-full items-center gap-1.5 rounded-md pr-2.5 text-left text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "bg-surface-selected font-medium text-surface-selected-foreground"
          : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function GrayCandidateRow({ candidate, depth }: { candidate: GrayCandidate; depth: number }) {
  const { t } = useT("skill-packages");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-disabled="true"
            style={{ paddingLeft: `${depth * 12 + 22}px` }}
            className="flex h-8 w-full cursor-default items-center gap-1.5 rounded-md pr-2.5 text-caption text-faint-foreground"
          >
            <Package className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
            <span className="shrink-0 rounded-xs bg-muted px-1 py-0.5 text-caption">
              {t(($) => $.tree.not_imported)}
            </span>
          </div>
        }
      />
      <TooltipContent side="right">{t(($) => $.tree.gray_hint)}</TooltipContent>
    </Tooltip>
  );
}

interface PanelActions {
  onCreateSubfolder: (parentId: string) => void;
  onRename: (folder: SkillFolder) => void;
  onMove: (folder: SkillFolder) => void;
  onDelete: (folder: SkillFolder) => void;
  onRescan: (pkg: SkillPackage) => void;
  onRemove: (pkg: SkillPackage, mode: "dissolve" | "delete") => void;
}

/**
 * One folder row. `pkg` is set on package roots (drives the package menu and
 * badge); managed internal folders get neither menu nor package actions.
 */
function FolderNodeRow({
  node,
  depth,
  gray,
  selection,
  onSelect,
  collapsed,
  onToggleCollapse,
  pkg,
  canManagePackage,
  actions,
  renderNode,
}: {
  node: FolderTreeNode;
  depth: number;
  gray: readonly GrayCandidate[];
  selection: FolderSelection;
  onSelect: (sel: FolderSelection) => void;
  collapsed: ReadonlySet<string>;
  onToggleCollapse: (folderId: string) => void;
  pkg: SkillPackage | null;
  canManagePackage: boolean;
  actions: PanelActions;
  renderNode: (node: FolderTreeNode, depth: number) => React.ReactNode;
}) {
  const { t } = useT("skill-packages");
  const folder = node.folder;
  const isCollapsed = collapsed.has(folder.id);
  const isSelected = selection.kind === "folder" && selection.folderId === folder.id;
  const hasChildren = node.children.length > 0 || gray.length > 0;
  const FolderIcon = isCollapsed ? Folder : FolderOpen;
  const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;
  const custom = isCustomFolder(folder);
  const hasMenu = custom || pkg !== null;

  return (
    <div>
      <div
        className={cn(
          "group/row flex items-center rounded-md",
          isSelected ? "bg-surface-selected" : "hover:bg-surface-hover",
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={t(($) =>
              isCollapsed
                ? $.tree.expand_folder
                : $.tree.collapse_folder, { name: folder.name })}
            aria-expanded={!isCollapsed}
            onClick={() => onToggleCollapse(folder.id)}
            className="ml-1 shrink-0 rounded-xs p-0.5 text-faint-foreground hover:text-foreground"
          >
            <ChevronIcon className="h-3 w-3" />
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          aria-pressed={isSelected}
          onClick={() => onSelect({ kind: "folder", folderId: folder.id })}
          style={{ paddingLeft: `${depth * 12 + 2}px` }}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md pr-2 text-left text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isSelected
              ? "font-medium text-surface-selected-foreground"
              : "text-muted-foreground group-hover/row:text-foreground",
          )}
        >
          <FolderIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{folder.name}</span>
          {pkg && (
            <span className="shrink-0 rounded-xs bg-muted px-1 py-0.5 text-caption text-muted-foreground">
              {t(($) => $.tree.package_label)}
            </span>
          )}
        </button>
        {hasMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t(($) => $.tree.folder_actions, { name: folder.name })}
                  onClick={(e) => e.stopPropagation()}
                  className="relative mr-1 shrink-0 rounded-xs p-0.5 text-faint-foreground opacity-0 transition-opacity after:absolute after:-inset-1 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 aria-expanded:opacity-100"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="w-44">
              {custom && (
                <>
                  <DropdownMenuItem onClick={() => actions.onCreateSubfolder(folder.id)}>
                    <FolderPlus />
                    {t(($) => $.tree.new_subfolder)}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => actions.onRename(folder)}>
                    <Pencil />
                    {t(($) => $.tree.rename_folder)}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => actions.onMove(folder)}>
                    <Folder />
                    {t(($) => $.tree.move_folder)}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => actions.onDelete(folder)}>
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
                  <DropdownMenuItem
                    disabled={!canManagePackage}
                    onClick={() => actions.onRescan(pkg)}
                  >
                    <Package />
                    {t(($) => $.tree.rescan_package)}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canManagePackage}
                    onClick={() => actions.onRename(folder)}
                  >
                    <Pencil />
                    {t(($) => $.tree.rename_folder)}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canManagePackage}
                    onClick={() => actions.onMove(folder)}
                  >
                    <Folder />
                    {t(($) => $.tree.move_folder)}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!canManagePackage}
                    onClick={() => actions.onRemove(pkg, "dissolve")}
                  >
                    <Inbox />
                    {t(($) => $.tree.dissolve_package)}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!canManagePackage}
                    onClick={() => actions.onRemove(pkg, "delete")}
                  >
                    <Trash2 />
                    {t(($) => $.tree.delete_package)}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!isCollapsed && hasChildren && (
        <div>
          {node.children.map((child) => renderNode(child, depth + 1))}
          {gray.map((candidate) => (
            <GrayCandidateRow
              key={`${candidate.packageId} ${candidate.path}`}
              candidate={candidate}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function SkillFolderTreePanel({
  wsId,
  tree,
  treeError,
  onRetryTree,
  selection,
  onSelect,
  currentUserId,
  isAdmin,
  className,
}: {
  wsId: string;
  /** undefined = still loading; null = unreadable (indeterminate). */
  tree: SkillFolderTree | null | undefined;
  treeError: boolean;
  onRetryTree: () => void;
  selection: FolderSelection;
  onSelect: (sel: FolderSelection) => void;
  currentUserId: string | null;
  isAdmin: boolean;
  className?: string;
}) {
  const { t } = useT("skill-packages");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [folderForm, setFolderForm] = useState<FolderFormState | null>(null);
  const [folderMove, setFolderMove] = useState<SkillFolder | null>(null);
  const [folderDelete, setFolderDelete] = useState<SkillFolder | null>(null);
  const [rescanPkg, setRescanPkg] = useState<SkillPackage | null>(null);
  const [remove, setRemove] = useState<{ pkg: SkillPackage; mode: "dissolve" | "delete" } | null>(null);

  const nodes = useMemo(() => (tree ? buildFolderNodes(tree.folders) : []), [tree]);
  const grayByFolder = useMemo(() => {
    const map = new Map<string, GrayCandidate[]>();
    if (!tree) return map;
    for (const candidate of grayCandidates(tree)) {
      const list = map.get(candidate.folderId) ?? [];
      list.push(candidate);
      map.set(candidate.folderId, list);
    }
    return map;
  }, [tree]);

  const toggleCollapse = (folderId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const actions: PanelActions = {
    onCreateSubfolder: (parentId) => setFolderForm({ mode: "create", parentId }),
    onRename: (folder) => setFolderForm({ mode: "rename", folder }),
    onMove: (folder) => setFolderMove(folder),
    onDelete: (folder) => setFolderDelete(folder),
    onRescan: (pkg) => setRescanPkg(pkg),
    onRemove: (pkg, mode) => setRemove({ pkg, mode }),
  };

  const renderNode = (node: FolderTreeNode, depth: number): React.ReactNode => {
    const pkg =
      tree && isPackageRootFolder(node.folder)
        ? packageForRootFolder(tree, node.folder.id)
        : null;
    const canManagePackage =
      pkg !== null && (isAdmin || (currentUserId !== null && pkg.created_by === currentUserId));
    return (
      <FolderNodeRow
        key={node.folder.id}
        node={node}
        depth={depth}
        gray={grayByFolder.get(node.folder.id) ?? []}
        selection={selection}
        onSelect={onSelect}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        pkg={pkg}
        canManagePackage={canManagePackage}
        actions={actions}
        renderNode={renderNode}
      />
    );
  };

  return (
    <aside className={cn("flex w-56 shrink-0 flex-col border-r", className)}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <span className="text-caption font-medium text-muted-foreground">
          {t(($) => $.tree.title)}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t(($) => $.tree.new_folder)}
                onClick={() => setFolderForm({ mode: "create", parentId: null })}
                className="rounded-xs p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            }
          />
          <TooltipContent side="bottom">{t(($) => $.tree.new_folder)}</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
        <SelectionRow
          icon={Layers}
          label={t(($) => $.tree.all_skills)}
          selected={selection.kind === "all"}
          onClick={() => onSelect({ kind: "all" })}
        />
        <SelectionRow
          icon={Inbox}
          label={t(($) => $.tree.uncategorized)}
          selected={selection.kind === "uncategorized"}
          onClick={() => onSelect({ kind: "uncategorized" })}
        />

        {tree === undefined ? (
          <div className="space-y-1 px-1 pt-1">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-5/6" />
            <Skeleton className="h-6 w-4/6" />
          </div>
        ) : tree === null || treeError ? (
          <div className="space-y-2 px-2 py-3">
            <p role="status" className="text-caption text-muted-foreground">
              {t(($) => $.tree.indeterminate)}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onRetryTree}>
              {t(($) => $.tree.retry)}
            </Button>
          </div>
        ) : (
          <>
            {nodes.map((node) => renderNode(node, 0))}
            {nodes.length === 0 && (
              <p className="px-2 py-3 text-caption text-muted-foreground">
                {t(($) => $.tree.empty)}
              </p>
            )}
          </>
        )}
      </div>

      {folderForm && (
        <FolderFormDialog wsId={wsId} state={folderForm} onClose={() => setFolderForm(null)} />
      )}
      {folderMove && tree && (
        <FolderMoveDialog
          wsId={wsId}
          tree={tree}
          folder={folderMove}
          onClose={() => setFolderMove(null)}
        />
      )}
      {folderDelete && (
        <FolderDeleteDialog
          wsId={wsId}
          folder={folderDelete}
          onDeleted={() => {
            if (selection.kind === "folder" && selection.folderId === folderDelete.id) {
              onSelect(folderDelete.parent_id
                ? { kind: "folder", folderId: folderDelete.parent_id }
                : { kind: "all" });
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
          onOpenChange={(v) => { if (!v) setRescanPkg(null); }}
        />
      )}
      {remove && (
        <PackageRemoveDialog
          wsId={wsId}
          pkg={remove.pkg}
          mode={remove.mode}
          open
          onOpenChange={(v) => { if (!v) setRemove(null); }}
        />
      )}
    </aside>
  );
}
