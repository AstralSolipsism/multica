"use client";

// Left-column page tree for the baseline wiki (OL-1329 §2). Renders the
// server-ordered tree with local expand/collapse (ancestors of the current
// page auto-expand), hover actions, a context menu with keyboard-reachable
// reorder/move/delete, HTML5 drag & drop with three drop zones, an archived
// footer with one-click restore, and the one-click guide bootstrap on an empty
// wiki. All writes carry base revision numbers supplied by the parent.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ArchiveRestore, ChevronRight, Ellipsis, FileText, GripVertical, LoaderCircle, Plus, Trash2,
} from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Input } from "@multica/ui/components/ui/input";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { api, type WikiTreePage } from "@multica/core/api";
import { projectKeys } from "@multica/core/projects/queries";
import { useT } from "../../i18n";

export interface WikiMoveIntent {
  page: WikiTreePage;
  parent: string | null;
  after: string | "first";
}

export interface WikiTreePanelProps {
  wsId: string;
  projectId: string;
  pages: readonly WikiTreePage[];
  archived: readonly WikiTreePage[];
  selectedId: string | null;
  loading: boolean;
  error: boolean;
  renameTargetId: string | null;
  onRetry: () => void;
  onSelect: (page: WikiTreePage) => void;
  onCreateChild: (parent: WikiTreePage) => void;
  onRename: (page: WikiTreePage, title: string) => void;
  onMove: (intent: WikiMoveIntent) => void;
  onArchive: (page: WikiTreePage, recursive: boolean) => void;
  onRestore: (page: WikiTreePage) => void;
  onCreateGuide: (slug: string, title: string) => void;
  guidePending: string | null;
}

type DropZone = "before" | "after" | "child";

const GUIDE_SLUGS = ["overview", "domain_rules", "architecture", "exclusions_and_risks"] as const;

export function buildPageIndex(pages: readonly WikiTreePage[]) {
  const byId = new Map<string, WikiTreePage>();
  for (const page of pages) byId.set(page.id, page);
  const childrenOf = new Map<string | null, WikiTreePage[]>();
  for (const page of pages) {
    const key = page.parentId;
    const list = childrenOf.get(key) ?? [];
    list.push(page);
    childrenOf.set(key, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.position - b.position);
  return { byId, childrenOf };
}

function subtreeIds(root: WikiTreePage, byId: Map<string, WikiTreePage>): Set<string> {
  const ids = new Set<string>([root.id]);
  const walk = (id: string | null) => {
    for (const page of byId.values()) {
      if (page.parentId === id && !ids.has(page.id)) {
        ids.add(page.id);
        walk(page.id);
      }
    }
  };
  walk(root.id);
  return ids;
}

export function WikiTreePanel(props: WikiTreePanelProps) {
  const { t } = useT("engineering");
  const { byId, childrenOf } = useMemo(() => buildPageIndex(props.pages), [props.pages]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<WikiTreePage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WikiTreePage | null>(null);
  const [deleteRecursive, setDeleteRecursive] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; zone: DropZone } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Ancestors of the selected page always expand.
  useEffect(() => {
    if (!props.selectedId) return;
    setExpanded((current) => {
      let changed = false;
      const next = new Set(current);
      let cursor = byId.get(props.selectedId!)?.parentId ?? null;
      while (cursor) {
        if (!next.has(cursor)) {
          next.add(cursor);
          changed = true;
        }
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      return changed ? next : current;
    });
  }, [props.selectedId, byId]);

  useEffect(() => {
    if (props.renameTargetId && props.renameTargetId !== renamingId) {
      setRenamingId(props.renameTargetId);
      setRenameValue(byId.get(props.renameTargetId)?.title ?? "");
    }
  }, [props.renameTargetId, renamingId, byId]);

  const backlinksQuery = useQuery({
    queryKey: [...projectKeys.wikiRoot(props.wsId, props.projectId), "backlinks", deleteTarget?.id ?? ""],
    queryFn: () => api.getProjectWikiBacklinks(props.wsId, props.projectId, deleteTarget!.slug),
    enabled: !!deleteTarget,
  });
  const backlinks = backlinksQuery.data?.backlinks ?? [];
  const deleteDescendants = deleteTarget ? props.pages.filter((page) => subtreeIds(deleteTarget, byId).has(page.id)).length - 1 : 0;

  const siblingsOf = (page: WikiTreePage) => childrenOf.get(page.parentId) ?? [];
  const parentSlug = (page: WikiTreePage) => (page.parentId ? byId.get(page.parentId)?.slug ?? "root" : "root");

  const submitRename = (page: WikiTreePage) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (title && title !== page.title) props.onRename(page, title);
  };

  const moveRelative = (page: WikiTreePage, intent: "up" | "down" | "promote" | "demote") => {
    const siblings = siblingsOf(page);
    const index = siblings.findIndex((item) => item.id === page.id);
    if (intent === "up" && index > 0) {
      const after = index >= 2 ? siblings[index - 2]! : null;
      props.onMove({ page, parent: page.parentId ? parentSlug(page) : null, after: after?.slug ?? "first" });
    } else if (intent === "down" && index < siblings.length - 1) {
      props.onMove({ page, parent: page.parentId ? parentSlug(page) : null, after: siblings[index + 1]!.slug });
    } else if (intent === "promote" && page.parentId) {
      const parent = byId.get(page.parentId);
      if (parent) props.onMove({ page, parent: parent.parentId ? parentSlug(parent) : null, after: parent.slug });
    } else if (intent === "demote" && index > 0) {
      props.onMove({ page, parent: page.slug, after: "first" });
    }
  };

  const handleDrop = (event: React.DragEvent, target: WikiTreePage) => {
    event.preventDefault();
    setDropHint(null);
    const source = dragId ? byId.get(dragId) : null;
    setDragId(null);
    if (!source || !dropHint || dropHint.id !== target.id) return;
    if (subtreeIds(source, byId).has(target.id)) return;
    const siblings = siblingsOf(target);
    const index = siblings.findIndex((item) => item.id === target.id);
    if (dropHint.zone === "child") {
      const children = childrenOf.get(target.id) ?? [];
      props.onMove({ page: source, parent: target.slug, after: children.length ? children[children.length - 1]!.slug : "first" });
    } else if (dropHint.zone === "before") {
      props.onMove({ page: source, parent: target.parentId ? parentSlug(target) : null, after: index >= 1 ? siblings[index - 1]!.slug : "first" });
    } else {
      props.onMove({ page: source, parent: target.parentId ? parentSlug(target) : null, after: target.slug });
    }
  };

  // Rows render flat (no DOM nesting): a nested row would inherit the parent
  // row's 30px height and drag opacity.
  const visibleRows = useMemo(() => {
    const rows: { page: WikiTreePage; depth: number }[] = [];
    const walk = (pages: readonly WikiTreePage[], depth: number) => {
      for (const page of pages) {
        rows.push({ page, depth });
        if (expanded.has(page.id)) walk(childrenOf.get(page.id) ?? [], depth + 1);
      }
    };
    walk(childrenOf.get(null) ?? [], 1);
    return rows;
  }, [childrenOf, expanded]);

  const renderRow = (page: WikiTreePage, depth: number) => {
    const children = childrenOf.get(page.id) ?? [];
    const hasChildren = children.length > 0;
    const isExpanded = expanded.has(page.id);
    const selected = props.selectedId === page.id;
    const renaming = renamingId === page.id;
    const siblings = siblingsOf(page);
    const index = siblings.findIndex((item) => item.id === page.id);
    const isFirstChild = index === 0;
    const isLastChild = index === siblings.length - 1;
    const isTopLevel = page.parentId === null;
    const dropActive = dropHint?.id === page.id;
    return (
      <div
        key={page.id}
        className={cn(
          "group relative flex h-[30px] items-center gap-1 pr-1",
          selected && "bg-[var(--surface-selected)] font-medium",
          !selected && "hover:bg-[var(--sidebar-accent)] focus-within:bg-[var(--sidebar-accent)]",
          menuId === page.id && !selected && "bg-[var(--sidebar-accent)]",
          dragId === page.id && "opacity-40",
        )}
        style={{ paddingLeft: `${(depth - 1) * 14}px` }}
        data-wiki-tree-page={page.slug}
        draggable={!renaming}
        onDragStart={(event) => {
          setDragId(page.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          setDragId(null);
          setDropHint(null);
        }}
        onDragOver={(event) => {
          if (!dragId || dragId === page.id) return;
          if (subtreeIds(byId.get(dragId)!, byId).has(page.id)) {
            event.dataTransfer.dropEffect = "none";
            return;
          }
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientY - rect.top) / rect.height;
          const zone: DropZone = ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : "child";
          setDropHint({ id: page.id, zone });
        }}
        onDragLeave={() => setDropHint((hint) => hint?.id === page.id ? null : hint)}
        onDrop={(event) => handleDrop(event, page)}
      >
        {dropActive ? (
          dropHint!.zone === "before" ? <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 bg-brand" aria-hidden="true" /> : null
        ) : null}
        {dropActive ? (
          dropHint!.zone === "after" ? <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 bg-brand" aria-hidden="true" /> : null
        ) : null}
        <button
          type="button"
          className={cn("grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground", !hasChildren && "invisible")}
          aria-expanded={hasChildren ? isExpanded : undefined}
          aria-label={t(($) => $.wiki.treeExpand, { title: page.title })}
          tabIndex={hasChildren ? 0 : -1}
          onClick={() => setExpanded((current) => {
            const next = new Set(current);
            if (next.has(page.id)) next.delete(page.id);
            else next.add(page.id);
            return next;
          })}
          onKeyDown={(event) => {
            if (event.key === "F2" && !renaming) {
              setRenamingId(page.id);
              setRenameValue(page.title);
            }
          }}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")} aria-hidden="true" />
        </button>
        <GripVertical className="size-3 shrink-0 cursor-grab text-border opacity-0 group-hover:opacity-100" aria-hidden="true" />
        <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {renaming ? (
          <Input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onFocus={(event) => event.target.select()}
            className="h-6 flex-1 text-body"
            aria-label={t(($) => $.wiki.treeRenameLabel)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitRename(page);
              if (event.key === "Escape") setRenamingId(null);
            }}
            onBlur={() => submitRename(page)}
            data-wiki-tree-rename
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-body"
            title={page.title}
            onClick={() => props.onSelect(page)}
          >
            {page.title || t(($) => $.wiki.untitled)}
          </button>
        )}
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100" style={{ display: selected ? "inline-flex" : undefined }}>
          <button
            type="button"
            className="grid size-5 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
            aria-label={t(($) => $.wiki.treeNewChild)}
            onClick={() => props.onCreateChild(page)}
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </button>
          <DropdownMenu open={menuId === page.id} onOpenChange={(open) => setMenuId(open ? page.id : null)}>
            <DropdownMenuTrigger
              className="grid size-5 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
              aria-label={t(($) => $.wiki.treeMenuLabel, { title: page.title })}
            >
              <Ellipsis className="size-3.5" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => { setRenamingId(page.id); setRenameValue(page.title); }}>{t(($) => $.wiki.treeRename)} <span className="ml-auto text-micro text-muted-foreground">{t(($) => $.wiki.treeRenameShortcut)}</span></DropdownMenuItem>
              <DropdownMenuItem onSelect={() => props.onCreateChild(page)}>{t(($) => $.wiki.treeNewChild)}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={isFirstChild} onSelect={() => moveRelative(page, "up")}>{t(($) => $.wiki.treeMoveUp)}</DropdownMenuItem>
              <DropdownMenuItem disabled={isLastChild} onSelect={() => moveRelative(page, "down")}>{t(($) => $.wiki.treeMoveDown)}</DropdownMenuItem>
              <DropdownMenuItem disabled={isTopLevel} onSelect={() => moveRelative(page, "promote")}>{t(($) => $.wiki.treePromote)}</DropdownMenuItem>
              <DropdownMenuItem disabled={isFirstChild} onSelect={() => moveRelative(page, "demote")}>{t(($) => $.wiki.treeDemote)}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMoveTarget(page)}>{t(($) => $.wiki.treeMoveTo)}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => { setDeleteTarget(page); setDeleteRecursive(false); }}>
                <Trash2 aria-hidden="true" />{t(($) => $.wiki.treeDelete)}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        {dropActive && dropHint!.zone === "child" ? <span className="pointer-events-none absolute inset-0 rounded-xs border-2 border-brand" aria-hidden="true" /> : null}
      </div>
    );
  };

  if (props.loading) {
    return (
      <div className="space-y-2 p-3" data-wiki-tree-loading>
        <Skeleton className="h-5 w-3/4" /><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" />
      </div>
    );
  }
  if (props.error) {
    return (
      <div className="p-3 text-caption text-destructive" data-wiki-tree-error>
        <p className="flex items-center gap-1.5"><AlertCircle className="size-4" aria-hidden="true" />{t(($) => $.wiki.treeLoadError)}</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={props.onRetry}>{t(($) => $.actions.retry)}</Button>
      </div>
    );
  }

  const roots = childrenOf.get(null) ?? [];
  const moveForbidden = moveTarget ? subtreeIds(moveTarget, byId) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" ref={listRef} data-wiki-tree>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {roots.length ? visibleRows.map(({ page, depth }) => renderRow(page, depth)) : (
          <div className="px-3 py-6 text-center" data-wiki-tree-empty>
            <p className="text-body text-muted-foreground">{t(($) => $.wiki.treeEmptyTitle)}</p>
            <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.wiki.treeEmptyHint)}</p>
            <div className="mt-3 grid gap-1.5 text-left">
              {GUIDE_SLUGS.map((slug) => (
                <Button
                  key={slug}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!!props.guidePending}
                  onClick={() => props.onCreateGuide(slug, t(($) => $.chapters[slug]))}
                  data-wiki-guide-create={slug}
                >
                  {props.guidePending === slug ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                  {t(($) => $.chapters[slug])}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
      {props.archived.length ? (
        <div className="border-t" data-wiki-tree-archived>
          <button
            type="button"
            className="flex w-full items-center gap-1 px-3 py-1.5 text-caption text-muted-foreground hover:text-foreground"
            aria-expanded={archivedOpen}
            onClick={() => setArchivedOpen(!archivedOpen)}
          >
            <ChevronRight className={cn("size-3 transition-transform", archivedOpen && "rotate-90")} aria-hidden="true" />
            {t(($) => $.wiki.treeArchived, { count: props.archived.length })}
          </button>
          {archivedOpen ? props.archived.map((page) => (
            <div key={page.id} className="flex h-[30px] items-center gap-1 px-3 opacity-70" data-wiki-tree-archived-page={page.slug}>
              <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-body">{page.title || t(($) => $.wiki.untitled)}</span>
              <button
                type="button"
                className="grid size-5 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
                aria-label={t(($) => $.wiki.treeRestore, { title: page.title })}
                onClick={() => props.onRestore(page)}
              >
                <ArchiveRestore className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          )) : null}
        </div>
      ) : null}

      {moveTarget ? (
        <Dialog open onOpenChange={(open) => !open && setMoveTarget(null)}>
          <DialogContent className="max-h-96 overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t(($) => $.wiki.moveDialogTitle, { title: moveTarget.title })}</DialogTitle>
              <DialogDescription>{t(($) => $.wiki.moveDialogDescription)}</DialogDescription>
            </DialogHeader>
            <div className="space-y-0.5">
              <button
                type="button"
                className="block w-full rounded-sm px-2 py-1.5 text-left text-body hover:bg-muted"
                onClick={() => {
                  props.onMove({ page: moveTarget, parent: null, after: "first" });
                  setMoveTarget(null);
                }}
              >{t(($) => $.wiki.moveRoot)}</button>
              {props.pages.map((page) => {
                const forbidden = moveForbidden?.has(page.id) ?? false;
                return (
                  <button
                    key={page.id}
                    type="button"
                    disabled={forbidden}
                    title={forbidden ? t(($) => $.wiki.moveForbidden) : undefined}
                    className="block w-full rounded-sm px-2 py-1.5 text-left text-body hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ paddingLeft: `${page.depth * 14 + 8}px` }}
                    onClick={() => {
                      props.onMove({ page: moveTarget, parent: page.slug, after: "first" });
                      setMoveTarget(null);
                    }}
                    data-wiki-move-target={page.slug}
                  >
                    {page.title || t(($) => $.wiki.untitled)}
                  </button>
                );
              })}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <Dialog open onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(($) => $.wiki.deleteTitle, { title: deleteTarget.title })}</DialogTitle>
              <DialogDescription>
                {deleteDescendants > 0
                  ? t(($) => $.wiki.deleteWithChildren, { count: deleteDescendants })
                  : t(($) => $.wiki.deleteDescription)}
                {backlinks.length > 0 ? ` ${t(($) => $.wiki.deleteBacklinks, { count: backlinks.length, pages: backlinks.slice(0, 3).map((item) => item.title || item.slug).join("、") })}` : ""}
              </DialogDescription>
            </DialogHeader>
            {deleteDescendants > 0 ? (
              <label className="flex items-center gap-2 text-caption">
                <Checkbox checked={deleteRecursive} onCheckedChange={(checked) => setDeleteRecursive(checked === true)} />
                {t(($) => $.wiki.deleteRecursive, { count: deleteDescendants })}
              </label>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>{t(($) => $.actions.cancel)}</Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={deleteDescendants > 0 && !deleteRecursive}
                data-wiki-delete-confirm
                onClick={() => {
                  props.onArchive(deleteTarget, deleteRecursive);
                  setDeleteTarget(null);
                }}
              >{t(($) => $.wiki.deleteConfirm)}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
