"use client";

// EngineeringBaselineWiki: the three-column baseline wiki shell (OL-1329).
// Left: page tree (engineering-baseline-tree). Center: reader with breadcrumb,
// meta line, WikiMarkdown body, page/section editing, history view, and the
// silent footer (backlinks + related issues). Right: On this page outline.
// Breakpoints are container queries on the shell; under 1024px the side
// columns become overlay drawers with a mask (Esc/mask/navigation close).
// All writes carry base revision numbers taken from the current tree; a 409
// optimistic-lock rejection refetches the tree and surfaces a conflict toast
// (the editor additionally shows the three-path panel).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, ChevronRight, History, LoaderCircle, Menu, Pencil, PanelRightClose, MessageSquare,
} from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { ApiError, api, errorCode, WikiConflictSchema, type WikiTreePage } from "@multica/core/api";
import { issueIdentifierOptions, issueKeys } from "@multica/core/issues/queries";
import { projectWikiPageOptions, projectWikiTreeOptions } from "@multica/core/projects/queries";
import { buildWikiLinkIndex } from "@multica/core/projects/wikilink-resolution";
import {
  useArchiveWikiPage, useCreateWikiPage, useMoveWikiPage, useRenameWikiPage, useRestoreWikiPage,
  useRollbackWikiPage, useWriteWikiPage,
} from "@multica/core/projects/mutations";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { useFormatRelativeDate } from "./labels";
import type { WikiEditorConflictInfo, WikiSaveOutcome } from "./engineering-baseline-editor";
import { WikiEditor } from "./engineering-baseline-editor";
import { WikiHistoryView } from "./engineering-baseline-history";
import { WikiMarkdown, type WikiLinkTarget } from "./engineering-baseline-markdown";
import { WikiSearchPalette } from "./engineering-baseline-search";
import { useNavigation } from "../../navigation";
import { type WikiMoveIntent, WikiTreePanel } from "./engineering-baseline-tree";
import { splitCommentSections } from "@multica/core/projects/queries";
import { wikiThreadsOptions } from "@multica/core/projects/queries";
import type { WikiCommentAnchor, WikiThread } from "@multica/core/api";
import { WikiCommentsPanel, type WikiDiscussion } from "./engineering-baseline-comments";
import { WikiReadingHighlights } from "./engineering-baseline-reading-highlights";

const EMPTY_THREADS: WikiThread[] = [];


const FLASH_MS = 1600;

const GUIDE_SLUGS = ["overview", "domain_rules", "architecture", "exclusions_and_risks"] as const;

export interface EngineeringBaselineWikiProps {
  workspaceSlug: string;
  workspaceId: string;
  projectId: string;
  projectTitle: string;
}

/** First prose paragraph of a page body, for link hover preview cards. */
function firstParagraph(markdown: string): string {
  let inFence = false;
  const lines: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed || trimmed.startsWith("#")) {
      if (lines.length) break;
      continue;
    }
    lines.push(trimmed);
  }
  const text = lines.join(" ");
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function conflictFromError(cause: unknown): WikiEditorConflictInfo | null {
  if (!(cause instanceof ApiError) || errorCode(cause) !== "baseline_conflict") return null;
  const parsed = WikiConflictSchema.safeParse(cause.body);
  if (!parsed.success) return null;
  return {
    revisionNumber: parsed.data.current.revisionNumber,
    kind: parsed.data.current.kind,
    createdAt: parsed.data.current.createdAt,
    createdByType: parsed.data.current.createdByType,
    createdById: parsed.data.current.createdById,
    changeSummary: parsed.data.current.changeSummary,
  };
}

function SourceIssueChip({ workspaceId, issueId }: { workspaceId: string; issueId: string }) {
  const { t } = useT("engineering");
  const query = useQuery({
    queryKey: [...issueKeys.detail(workspaceId, issueId), "identifier"],
    queryFn: () => api.getIssue(issueId),
    staleTime: 5 * 60_000,
  });
  if (!query.data) return null;
  return <span className="whitespace-nowrap">· {t(($) => $.wiki.metaSourceIssue, { issue: query.data.identifier })}</span>;
}

function OutlineRail({ sections, contentKey, className }: { sections: readonly { anchor: string; title: string; level: number }[]; contentKey: string; className?: string }) {
  const { t } = useT("engineering");
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!sections.length) return;
    // Observe AFTER the content renders: contentKey (the loaded revision)
    // changes with every reader repaint, so targets are re-queried when the
    // body element is replaced, not only when the section list changes.
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "undefined") return;
    const frame = window.requestAnimationFrame(() => {
      const targets = sections
        .map((section) => document.getElementById(`s-${section.anchor}`))
        .filter((element): element is HTMLElement => element !== null);
      if (!targets.length) return;
      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (visible[0]?.target.id) setActive(visible[0].target.id.slice(2));
        },
        { rootMargin: "-64px 0px -70% 0px" },
      );
      for (const target of targets) observer.observe(target);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [sections, contentKey]);

  return (
    <nav className={cn("overflow-y-auto p-3", className)} aria-label={t(($) => $.wiki.outlineTitle)} data-wiki-outline>
      <div className="mb-2 text-caption font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.wiki.outlineTitle)}</div>
      {sections.length ? sections.map((section) => (
        <a
          key={section.anchor}
          href={`#s-${section.anchor}`}
          className={cn(
            "block truncate rounded-sm py-1 text-caption text-muted-foreground hover:text-foreground",
            section.level > 2 && "pl-3",
            active === section.anchor && "text-foreground font-medium",
          )}
          onClick={(event) => {
            event.preventDefault();
            document.getElementById(`s-${section.anchor}`)?.scrollIntoView({ behavior: "smooth" });
          }}
        >{section.title || section.anchor}</a>
      )) : <p className="text-caption text-muted-foreground">{t(($) => $.wiki.outlineEmpty)}</p>}
    </nav>
  );
}

export function EngineeringBaselineWiki(props: EngineeringBaselineWikiProps) {
  const { t } = useT("engineering");
  const queryClient = useQueryClient();
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const wsId = props.workspaceId;

  const treeQuery = useQuery(projectWikiTreeOptions(wsId, props.projectId, true));
  const pages = useMemo(() => (treeQuery.data?.pages ?? []).filter((page) => page.archivedAt === null), [treeQuery.data]);
  const archived = useMemo(() => (treeQuery.data?.pages ?? []).filter((page) => page.archivedAt !== null), [treeQuery.data]);
  const wikiLinkIndex = useMemo(() => buildWikiLinkIndex((treeQuery.data?.pages ?? []).map((page) => ({
    slug: page.slug,
    title: page.title,
    sections: page.sections,
    archived: page.archivedAt !== null,
  }))), [treeQuery.data?.pages]);

  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [discussion, setDiscussion] = useState<WikiDiscussion>({ mode: "outline" });
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [guidePending, setGuidePending] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ scope: "page" | "section"; anchor?: string; title?: string } | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<{ slug: string; anchor?: string } | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const shell = rightPanelRef.current?.parentElement;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setNarrow(shell.clientWidth < 1024));
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel || !rightOpen || !narrow) return;
    const previous = document.activeElement as HTMLElement | null;
    const siblings = [...(panel.parentElement?.children ?? [])].filter((node): node is HTMLElement => node instanceof HTMLElement && (node.tagName === "MAIN" || node.hasAttribute("data-wiki-tree-column")));
    siblings.forEach((node) => { node.inert = true; });
    panel.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex="0"]')].filter((node) => node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    panel.addEventListener("keydown", trap);
    return () => { siblings.forEach((node) => { node.inert = false; }); panel.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
  }, [rightOpen, narrow]);

  const navigation = useNavigation();
  const urlPage = navigation.searchParams.get("page");
  const urlSection = navigation.searchParams.get("section");
  const urlThread = navigation.searchParams.get("thread");
  const selected = useMemo(() => pages.find((page) => page.slug === urlPage) ?? pages[0] ?? null, [pages, urlPage]);
  const selectedTreePage = selected;
  const threadQuery = useQuery(wikiThreadsOptions(wsId, props.projectId, selected?.id ?? ""));
  const threads = threadQuery.data?.threads ?? EMPTY_THREADS;

  const pageQuery = useQuery({
    ...projectWikiPageOptions(wsId, props.projectId, selected?.slug ?? "", { with: ["links", "backlinks", "related_issues"] }),
    enabled: !!selected,
  });

  // Section editor needs its slice; fetch only while that scope is open.
  const sectionQuery = useQuery({
    ...projectWikiPageOptions(wsId, props.projectId, selected?.slug ?? "", { section: editor?.scope === "section" ? editor.anchor : "" }),
    enabled: !!selected && editor?.scope === "section",
  });

  useEffect(() => {
    setEditor(null);
    setHistoryOpen(false);
    setLeftOpen(false);
    setRightOpen(!!urlThread);
    setDiscussion(urlThread ? { mode: "thread", id: urlThread } : { mode: "outline" });
  }, [selected?.id, urlThread]);

  useEffect(() => { if (editor || historyOpen) { setDiscussion({ mode: "outline" }); setRightOpen(false); } }, [editor, historyOpen]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(!searchOpen);
      }
      if (event.key === "Escape" && (leftOpen || rightOpen || discussion.mode !== "outline")) {
        setDiscussion({ mode: "outline" });
        setLeftOpen(false);
        setRightOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen, leftOpen, rightOpen, discussion.mode]);

  const flashSection = useCallback((anchor: string | undefined) => {
    if (!anchor) return;
    const element = document.getElementById(`s-${anchor}`);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    element.classList.add("wiki-flash");
    window.setTimeout(() => element.classList.remove("wiki-flash"), FLASH_MS);
  }, []);

  const openDiscussion = useCallback((next: WikiDiscussion) => {
    setDiscussion(next);
    setRightOpen(next.mode !== "outline");
    const anchor = next.mode === "compose" ? next.anchor.sectionAnchor : next.mode === "thread" ? threads.find((thread) => thread.id === next.id)?.location.sectionAnchor : undefined;
    if (anchor) flashSection(anchor);
  }, [threads, flashSection]);
  const openThread = useCallback((id: string, siblings: string[]) => openDiscussion({ mode: "thread", id, siblings }), [openDiscussion]);
  const composeComment = useCallback((anchor: WikiCommentAnchor) => openDiscussion({ mode: "compose", anchor }), [openDiscussion]);
  useEffect(() => {
    if (urlThread && pageQuery.data) {
      const thread = threads.find((thread) => thread.id === urlThread);
      if (thread) flashSection(thread.location.sectionAnchor);
    }
  }, [urlThread, threads, pageQuery.data, flashSection]);

  // Deep-linked section (?section=) flashes once the page body is rendered.
  const flashedRef = useRef(false);
  useEffect(() => {
    if (flashedRef.current || !urlSection || pageQuery.isLoading) return;
    flashedRef.current = true;
    const timer = window.setTimeout(() => flashSection(urlSection), 300);
    return () => window.clearTimeout(timer);
  }, [urlSection, pageQuery.isLoading, flashSection]);
  const doNavigate = useCallback((slug: string, anchor?: string) => {
    const params = new URLSearchParams(navigation.searchParams);
    params.set("page", slug);
    params.delete("thread");
    if (anchor) params.set("section", anchor);
    else params.delete("section");
    const query = params.toString();
    navigation.replace(`${navigation.pathname}${query ? `?${query}` : ""}`);
    if (anchor) window.setTimeout(() => flashSection(anchor), 300);
    setLeftOpen(false);
    setRightOpen(false);
  }, [flashSection, navigation]);

  // Switching pages while a draft is dirty gets the same guard as cancel:
  // confirm, then discard (close the editor) and navigate.
  const navigateToPage = useCallback((slug: string, anchor?: string) => {
    if (editor && editorDirty) {
      setPendingLeave({ slug, anchor });
      return;
    }
    doNavigate(slug, anchor);
  }, [editor, editorDirty, doNavigate]);
  const onWikiLinkNavigate = useCallback((target: WikiLinkTarget) => {
    navigateToPage(target.slug, target.anchor);
  }, [navigateToPage]);

  const leaveAndDiscard = useCallback(() => {
    const target = pendingLeave;
    setPendingLeave(null);
    setEditor(null);
    setEditorDirty(false);
    if (target) doNavigate(target.slug, target.anchor);
  }, [pendingLeave, doNavigate]);

  const createPage = useCreateWikiPage();
  const writePage = useWriteWikiPage();
  const renamePage = useRenameWikiPage();
  const movePage = useMoveWikiPage();
  const archivePage = useArchiveWikiPage();
  const restorePage = useRestoreWikiPage();
  const rollbackPage = useRollbackWikiPage();
  const writingPending = writePage.isPending;

  const handleTreeError = useCallback((cause: unknown, fallbackKey: "treeWriteError" | "archiveError" | "restoreError" | "moveError" | "renameError") => {
    if (errorCode(cause) === "baseline_conflict") {
      toast.error(t(($) => $.wiki.conflictTreeToast, { number: conflictFromError(cause)?.revisionNumber ?? 0 }));
    } else {
      toast.error(t(($) => $.wiki[fallbackKey]));
    }
    void treeQuery.refetch();
  }, [t, treeQuery]);

  const handleCreateChild = async (parent: WikiTreePage) => {
    try {
      const result = await createPage.mutateAsync({
        projectId: props.projectId,
        title: t(($) => $.wiki.untitled),
        parent: parent.slug,
      });
      if (!result) throw new Error("Unconfirmed create response");
      setRenameTargetId(result.page.id);
      navigateToPage(result.page.slug);
    } catch (cause) {
      handleTreeError(cause, "treeWriteError");
    }
  };

  const handleCreateRootPage = async () => {
    try {
      const result = await createPage.mutateAsync({
        projectId: props.projectId,
        title: t(($) => $.wiki.untitled),
        parent: "root",
      });
      if (!result) throw new Error("Unconfirmed create response");
      setRenameTargetId(result.page.id);
      navigateToPage(result.page.slug);
    } catch (cause) {
      handleTreeError(cause, "treeWriteError");
    }
  };

  const handleCreateMissing = useCallback(async (title: string) => {
    try {
      const result = await createPage.mutateAsync({ projectId: props.projectId, title });
      if (!result) throw new Error("Unconfirmed create response");
      toast.success(t(($) => $.wiki.linkCreated));
      navigateToPage(result.page.slug);
    } catch (cause) {
      handleTreeError(cause, "treeWriteError");
    }
  }, [createPage, navigateToPage, t, handleTreeError, props.projectId]);

  const handleCreateGuide = async () => {
    // One button creates all four guide pages sequentially; 409 slug-taken
    // just means the page already exists, so the flow is re-runnable.
    setGuidePending("guide");
    try {
      for (const slug of GUIDE_SLUGS) {
        const title = t(($) => $.chapters[slug]);
        try {
          await createPage.mutateAsync({
            projectId: props.projectId,
            title,
            slug,
            parent: "root",
            contentMarkdown: t(($) => $.wiki.guideTemplate, { title }),
          });
        } catch (cause) {
          if (errorCode(cause) !== "baseline_slug_taken") throw cause;
        }
      }
      toast.success(t(($) => $.wiki.guideBootstrapDone));
    } catch (cause) {
      toast.error(t(($) => $.wiki.guideError, { title: t(($) => $.wiki.guideBootstrap) }));
    } finally {
      setGuidePending(null);
    }
  };

  const handleRename = async (page: WikiTreePage, title: string) => {
    try {
      await renamePage.mutateAsync({ projectId: props.projectId, page: page.slug, baseRevisionNumber: page.currentRevisionNumber, title });
    } catch (cause) {
      handleTreeError(cause, "renameError");
    } finally {
      // Clear the auto-rename target so the effect cannot reopen the input.
      setRenameTargetId(null);
    }
  };

  const handleMove = async (intent: WikiMoveIntent) => {
    try {
      await movePage.mutateAsync({
        projectId: props.projectId,
        page: intent.page.slug,
        baseRevisionNumber: intent.page.currentRevisionNumber,
        parent: intent.parent ?? "root",
        after: intent.after,
      });
    } catch (cause) {
      handleTreeError(cause, "moveError");
    }
  };

  const handleArchive = async (page: WikiTreePage, recursive: boolean) => {
    try {
      const result = await archivePage.mutateAsync({ projectId: props.projectId, page: page.slug, baseRevisionNumber: page.currentRevisionNumber, recursive });
      if (!result) throw new Error("Unconfirmed archive response");
      const archivedRevision = result.pages[0]?.page.currentRevisionNumber ?? page.currentRevisionNumber + 1;
      const wasSelected = selected?.id === page.id;
      toast(t(($) => $.wiki.deleteDone, { title: page.title }), {
        duration: 7000,
        action: {
          label: t(($) => $.wiki.deleteUndo),
          onClick: () => {
            void restorePage.mutateAsync({ projectId: props.projectId, page: page.slug, baseRevisionNumber: archivedRevision, recursive })
              .catch((cause) => handleTreeError(cause, "restoreError"));
          },
        },
      });
      if (wasSelected) {
        const parentId = page.parentId;
        const fallback = pages.find((item) => item.id === parentId) ?? pages.find((item) => item.id !== page.id);
        if (fallback) navigateToPage(fallback.slug);
        setHistoryOpen(false);
        setEditor(null);
      }
    } catch (cause) {
      handleTreeError(cause, "archiveError");
    }
  };

  const handleRestore = async (page: WikiTreePage) => {
    try {
      await restorePage.mutateAsync({ projectId: props.projectId, page: page.slug, baseRevisionNumber: page.currentRevisionNumber });
      toast.success(t(($) => $.wiki.restoreDone, { title: page.title }));
    } catch (cause) {
      handleTreeError(cause, "restoreError");
    }
  };

  const resolveIssueId = async (identifier: string): Promise<string | undefined> => {
    if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier)) return undefined;
    const issue = await queryClient.fetchQuery({ ...issueIdentifierOptions(wsId, identifier.toUpperCase()), staleTime: 60_000 });
    return issue?.id;
  };

  const handleSave = async (input: { markdown: string; changeSummary: string; sourceIssue: string; baseRevisionNumber: number }): Promise<WikiSaveOutcome> => {
    if (!selected) return { status: "error" };
    try {
      const sourceIssueId = input.sourceIssue ? await resolveIssueId(input.sourceIssue) : undefined;
      if (input.sourceIssue && !sourceIssueId) {
        toast.error(t(($) => $.wiki.editorIssueInvalid, { issue: input.sourceIssue }));
        return { status: "error" };
      }
      await writePage.mutateAsync({
        projectId: props.projectId,
        page: selected.slug,
        baseRevisionNumber: input.baseRevisionNumber,
        ...(editor?.scope === "section"
          ? { section: editor.anchor, contentMarkdown: input.markdown }
          : { contentMarkdown: input.markdown }),
        changeSummary: input.changeSummary,
        ...(sourceIssueId ? { sourceIssueId } : {}),
      });
      toast.success(t(($) => $.wiki.savePublished, { number: input.baseRevisionNumber + 1 }));
      setEditor(null);
      return { status: "saved" };
    } catch (cause) {
      const conflict = conflictFromError(cause);
      if (conflict) return { status: "conflict", conflict };
      toast.error(t(($) => $.wiki.saveError));
      void treeQuery.refetch();
      return { status: "error" };
    }
  };

  const fetchCurrentContent = async (): Promise<string | null> => {
    if (!selected) return null;
    try {
      const read = await api.getProjectWikiPage(wsId, props.projectId, selected.slug, editor?.scope === "section" ? { section: editor.anchor } : {});
      if (!read) return null;
      if (editor?.scope === "section") return read.sections[0]?.contentMarkdown ?? null;
      return read.contentMarkdown;
    } catch {
      return null;
    }
  };

  const breadcrumb = useMemo(() => {
    if (!selected) return [];
    const chain: WikiTreePage[] = [];
    const byId = new Map(pages.map((page) => [page.id, page]));
    let cursor: WikiTreePage | undefined = selected;
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return chain;
  }, [pages, selected]);

  const read = pageQuery.data;
  const editing = !!editor;

  // Preview-card metadata: the TARGET page's breadcrumb path built from tree
  // parents, plus a first-paragraph snippet from a prefetched page read.
  const linkedSlugs = useMemo(() => {
    const slugs = new Set<string>();
    for (const link of read?.links ?? []) {
      if (link.state === "resolved" && link.targetSlug && link.targetSlug !== selected?.slug) slugs.add(link.targetSlug);
    }
    return [...slugs];
  }, [read, selected?.slug]);

  const previewQueries = useQueries({
    queries: linkedSlugs.map((slug) => ({ ...projectWikiPageOptions(wsId, props.projectId, slug, {}), staleTime: 60_000 })),
  });

  const pageMetaMap = useMemo(() => {
    const byId = new Map(pages.map((page) => [page.id, page]));
    const snippets = new Map<string, string>();
    linkedSlugs.forEach((slug, index) => {
      const content = previewQueries[index]?.data?.contentMarkdown;
      if (content) snippets.set(slug, firstParagraph(content));
    });
    const entries = pages.map((page) => {
      const chain: string[] = [];
      let cursor: WikiTreePage | undefined = page;
      while (cursor) {
        chain.unshift(cursor.title);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
      const snippet = snippets.get(page.slug);
      return [page.slug, {
        title: page.title,
        path: chain.join(" / "),
        version: page.current?.number ?? page.currentRevisionNumber,
        updatedAt: page.updatedAt,
        ...(snippet ? { snippet } : {}),
      }] as const;
    });
    return new Map(entries);
  }, [pages, linkedSlugs, previewQueries]);

  const sectionReader = useMemo(() => {
    if (!read?.contentMarkdown?.trim() || !selected) return null;
    const unmatched = [...selected.sections];
    const segments = splitCommentSections(read.contentMarkdown).map((segment) => {
      const index = unmatched.findIndex((section) => section.title === segment.title && section.level === segment.level);
      const serverSection = index >= 0 ? unmatched.splice(index, 1)[0] : undefined;
      return serverSection ? { ...segment, anchor: serverSection.anchor } : segment;
    });
    const shared = { links: read.links, pageMeta: pageMetaMap, onNavigate: onWikiLinkNavigate, onCreateMissing: (title: string) => void handleCreateMissing(title) };
    return segments.map((segment) => (
      <div key={segment.anchor} data-wiki-comment-section={segment.anchor} data-section-title={segment.title} className="group/sec relative -mx-2 mt-6 rounded-sm px-2 first:mt-0 hover:bg-muted/20">
        {segment.level > 0 ? <button type="button" data-comment-ignore
          className="absolute -right-1 top-1.5 rounded-sm border bg-page-canvas px-1.5 py-0.5 text-micro text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/sec:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={() => setEditor({ scope: "section", anchor: segment.anchor, title: segment.title })}
          data-wiki-edit-section={segment.anchor}
        >{t(($) => $.wiki.editSection)}</button> : null}
        <WikiMarkdown markdown={segment.markdown} sections={segment.level ? [{ anchor: segment.anchor, title: segment.title, level: segment.level }] : []} {...shared} />
      </div>
    ));
  }, [read, selected, pageMetaMap, onWikiLinkNavigate, t, handleCreateMissing]);

  const suggestPages = useMemo(() => pages.map((page) => ({ slug: page.slug, title: page.title })), [pages]);

  // Refetch before editing so the editor's body and base revision both come
  // from the SAME fresh read — a realtime invalidation can never leave a v6
  // body next to a "基于 v7" footer.
  const openPageEditor = useCallback(async () => {
    await pageQuery.refetch();
    setEditor({ scope: "page" });
  }, [pageQuery]);

  const maskOpen = leftOpen || rightOpen;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-page-canvas @container" data-wiki-shell>
      {/* Left column: static ≥1024px, overlay drawer below. */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-[min(320px,88%)] shrink-0 -translate-x-full border-r bg-page-canvas transition-transform duration-200 @[1024px]:static @[1024px]:z-auto @[1024px]:w-[272px] @[1280px]:w-[272px] @[1024px]:translate-x-0 @[1024px]:transition-none",
          leftOpen && "translate-x-0",
        )}
        data-wiki-tree-column
        aria-label={t(($) => $.wiki.treeLabel)}
      >
        <WikiTreePanel
          wsId={wsId}
          projectId={props.projectId}
          pages={pages}
          archived={archived}
          selectedId={selected?.id ?? null}
          loading={treeQuery.isLoading}
          error={treeQuery.isError}
          renameTargetId={renameTargetId}
          onRenameEnd={() => setRenameTargetId(null)}
          onRetry={() => void treeQuery.refetch()}
          onSelect={(page) => navigateToPage(page.slug)}
          onCreateChild={(page) => void handleCreateChild(page)}
          onCreateRootPage={() => void handleCreateRootPage()}
          onRename={(page, title) => void handleRename(page, title)}
          onMove={(intent) => void handleMove(intent)}
          onArchive={(page, recursive) => void handleArchive(page, recursive)}
          onRestore={(page) => void handleRestore(page)}
          onCreateGuide={() => void handleCreateGuide()}
          guidePending={guidePending}
        />
      </aside>
      {maskOpen ? <div className="absolute inset-0 z-30 bg-foreground/30 @[1024px]:hidden" onClick={() => { setLeftOpen(false); setRightOpen(false); setDiscussion({ mode: "outline" }); }} data-wiki-drawer-mask /> : null}

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1.5 border-b px-3">
          <button type="button" className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:text-foreground @[1024px]:hidden" aria-label={t(($) => $.wiki.openTreeDrawer)} onClick={() => setLeftOpen(true)}><Menu className="size-4" aria-hidden="true" /></button>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-caption text-muted-foreground" aria-label={t(($) => $.wiki.breadcrumbLabel)}>
            <span className="truncate">{props.projectTitle}</span>
            {breadcrumb.map((page, index) => (
              <span key={page.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
                <button
                  type="button"
                  className={cn("truncate hover:text-foreground", index === breadcrumb.length - 1 && "font-medium text-foreground")}
                  onClick={() => navigateToPage(page.slug)}
                >{page.title || t(($) => $.wiki.untitled)}</button>
              </span>
            ))}
            {historyOpen ? (
              <>
                <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate font-medium text-foreground">{t(($) => $.wiki.historyTabTitle)}</span>
              </>
            ) : null}
          </nav>
          <button type="button" className="hidden size-7 place-items-center rounded-sm text-muted-foreground hover:text-foreground @[520px]:grid" aria-label={t(($) => $.wiki.searchPlaceholder)} onClick={() => setSearchOpen(true)}>
            <span className="text-caption">{t(($) => $.wiki.searchShortcut)}</span>
          </button>
          {selected && !editor && !historyOpen ? <Button type="button" size="sm" variant="ghost" data-wiki-open-comments onClick={() => openDiscussion(discussion.mode === "outline" ? { mode: "list" } : { mode: "outline" })}><MessageSquare className="size-3.5" />{t(($) => $.wikiComments.count, { count: threads.filter((thread) => !thread.resolvedAt).length })}</Button> : null}
          <button type="button" className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:text-foreground @[1024px]:hidden" aria-label={t(($) => $.wiki.openOutlineDrawer)} onClick={() => setRightOpen(true)}><PanelRightClose className="size-4" aria-hidden="true" /></button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto" ref={readerRef} data-wiki-reader>
          {historyOpen && selected ? (
            <WikiHistoryView
              wsId={wsId}
              projectId={props.projectId}
              page={selectedTreePage!}
              linkIndex={wikiLinkIndex}
              onNavigate={onWikiLinkNavigate}
              saving={rollbackPage.isPending}
              onRollback={async ({ revisionNumber, baseRevisionNumber, contentOnly }) => {
                try {
                  await rollbackPage.mutateAsync({ projectId: props.projectId, page: selected.slug, revisionNumber, baseRevisionNumber, contentOnly });
                  void treeQuery.refetch();
                  return true;
                } catch (cause) {
                  handleTreeError(cause, "treeWriteError");
                  return false;
                }
              }}
              onBack={() => setHistoryOpen(false)}
            />
          ) : !selected ? (
            treeQuery.isLoading ? <div className="space-y-3 p-6"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40 w-full" /></div>
              : treeQuery.isError ? (
                <div className="p-6 text-caption text-destructive" data-wiki-load-error>
                  <p className="flex items-center gap-1.5"><AlertCircle className="size-4" aria-hidden="true" />{t(($) => $.wiki.treeLoadError)}</p>
                  <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void treeQuery.refetch()}>{t(($) => $.actions.retry)}</Button>
                </div>
              ) : null
          ) : (
            <article className="mx-auto w-full max-w-[812px] px-[28px] py-6 @[700px]:px-[40px] @[1024px]:px-[56px]">
              <div className="mb-1 flex items-start gap-2">
                <h1 className="min-w-0 flex-1 text-h2 font-semibold" data-wiki-page-title>{selected.title || t(($) => $.wiki.untitled)}</h1>
                {!editing ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t(($) => $.wiki.historyOpen)} onClick={() => setHistoryOpen(true)} data-wiki-open-history>
                      <History className="size-4" aria-hidden="true" />
                    </Button>
                    <Button type="button" size="sm" onClick={() => void openPageEditor()} data-testid="wiki-edit-page">
                      <Pencil className="size-3.5" aria-hidden="true" />
                      <span className="hidden @[520px]:inline">{t(($) => $.wiki.editPage)}</span>
                    </Button>
                  </div>
                ) : null}
              </div>
              <p className="mb-4 flex flex-wrap items-center gap-x-1 text-caption text-muted-foreground" data-wiki-page-meta>
                {selected.current ? (
                  <>
                    <span>{t(($) => $.wiki.metaUpdatedBy, {
                      name: `${getActorName(selected.current.createdByType, selected.current.createdById)}${selected.current.createdByType === "agent" ? t(($) => $.wiki.actorAgentBadge) : ""}`,
                    })}</span>
                    <span>· <time dateTime={selected.current.createdAt}>{formatRelativeDate(selected.current.createdAt)}</time></span>
                    {selected.current.sourceIssueId ? <SourceIssueChip workspaceId={wsId} issueId={selected.current.sourceIssueId} /> : null}
                    <span>·</span>
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => setHistoryOpen(true)} data-wiki-history-button>
                      {t(($) => $.wiki.historyVersions, { count: selected.revisionCount })}
                    </button>
                  </>
                ) : null}
              </p>

              {editing ? (
                editor.scope === "section" ? (
                  sectionQuery.isLoading || !sectionQuery.data?.sections[0] ? <div className="space-y-2"><Skeleton className="h-40 w-full" /></div> : (
                    <WikiEditor
                      scope="section"
                      sectionTitle={editor.title ?? sectionQuery.data.sections[0]!.title}
                      baseRevisionNumber={sectionQuery.data.revision.revisionNumber}
                      latestRevisionNumber={sectionQuery.data.revision.revisionNumber}
                      initialMarkdown={sectionQuery.data.sections[0]!.contentMarkdown}
                      suggestPages={suggestPages}
                      saving={writingPending}
                      actorName={getActorName}
                      onSave={handleSave}
                      onDirtyChange={setEditorDirty}
                      fetchCurrentContent={fetchCurrentContent}
                      linkIndex={wikiLinkIndex}
                      pageSlug={selected.slug}
                      onNavigate={onWikiLinkNavigate}
                      onCancel={() => setEditor(null)}
                    />
                  )
                ) : (
                  // Base and body come from the SAME page read; the editor
                  // mounts only once that read has resolved (never from "").
                  !read ? <div className="space-y-2"><Skeleton className="h-40 w-full" /></div> : (
                    <WikiEditor
                      scope="page"
                      baseRevisionNumber={read.revision.revisionNumber}
                      latestRevisionNumber={read.revision.revisionNumber}
                      initialMarkdown={read.contentMarkdown ?? ""}
                      suggestPages={suggestPages}
                      saving={writingPending}
                      actorName={getActorName}
                      onSave={handleSave}
                      onDirtyChange={setEditorDirty}
                      fetchCurrentContent={fetchCurrentContent}
                      linkIndex={wikiLinkIndex}
                      pageSlug={selected.slug}
                      onNavigate={onWikiLinkNavigate}
                      onCancel={() => setEditor(null)}
                    />
                  )
                )
              ) : pageQuery.isLoading ? <div className="space-y-2"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-40 w-full" /></div>
                : pageQuery.isError ? <p className="text-caption text-destructive">{t(($) => $.wiki.pageLoadError)}</p>
                : read?.contentMarkdown?.trim() ? sectionReader
                : (
                  <div className="rounded-md border border-dashed p-8 text-center">
                    <p className="text-body text-muted-foreground">{t(($) => $.wiki.pageEmpty)}</p>
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void openPageEditor()}>{t(($) => $.wiki.pageStartWriting)}</Button>
                  </div>
                )}

              {!editing && read ? (
                <footer className="mt-10 border-t pt-4 text-caption" data-wiki-page-footer>
                  <section className="mb-4">
                    <h2 className="mb-2 text-caption font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.wiki.backlinksTitle)}</h2>
                    {read.backlinks.length ? (
                      <div className="grid gap-2">
                        {read.backlinks.map((backlink) => (
                          <button key={`${backlink.slug}-${backlink.sectionAnchor}`} type="button" className="rounded-md border p-2 text-left hover:bg-muted/50" onClick={() => navigateToPage(backlink.slug, backlink.sectionAnchor || undefined)}>
                            <span className="block font-medium">{backlink.title || backlink.slug}</span>
                            {backlink.snippet ? <span className="mt-0.5 block truncate text-muted-foreground">{backlink.snippet}</span> : null}
                          </button>
                        ))}
                      </div>
                    ) : <p className="text-muted-foreground">{t(($) => $.wiki.backlinksEmpty)}</p>}
                  </section>
                  <section>
                    <h2 className="mb-2 text-caption font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.wiki.relatedIssuesTitle)}</h2>
                    {read.relatedIssues.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {read.relatedIssues.map((issue) => (
                          <span key={issue.id} className="rounded-full border px-2 py-0.5 text-micro" title={issue.title}>{issue.identifier}</span>
                        ))}
                      </div>
                    ) : <p className="text-muted-foreground">{t(($) => $.wiki.relatedIssuesEmpty)}</p>}
                  </section>
                </footer>
              ) : null}
            </article>
          )}
          {!editor && !historyOpen && read ? <WikiReadingHighlights readerRef={readerRef} threads={threads} contentKey={read.revision.id} revisionNumber={read.revision.revisionNumber} activeThreadId={discussion.mode === "thread" ? discussion.id : undefined} pendingAnchor={discussion.mode === "compose" ? discussion.anchor : undefined} onThread={openThread} onCompose={composeComment} /> : null}
        </div>
      </main>

      {/* Right column: outline rail, drawer under 1024px. */}
      <aside
        className={cn(
          "absolute inset-y-0 right-0 z-40 w-[min(320px,88%)] shrink-0 translate-x-full border-l bg-page-canvas transition-transform duration-200 @[1024px]:static @[1024px]:z-auto @[1024px]:w-[264px] @[1280px]:w-[296px] @[1024px]:translate-x-0 @[1024px]:transition-none",
          rightOpen && "translate-x-0",
        )}
        ref={rightPanelRef}
        tabIndex={-1}
        role={narrow && rightOpen ? "dialog" : undefined}
        aria-modal={narrow && rightOpen ? true : undefined}
        aria-label={discussion.mode === "outline" ? t(($) => $.wikiComments.outline) : t(($) => $.wikiComments.all)}
        data-wiki-outline-column
      >
        {discussion.mode !== "outline" && !editor && !historyOpen && selected ? <WikiCommentsPanel key={selected.id} workspaceId={wsId} projectId={props.projectId} pageId={selected.id} pageSlug={selected.slug} threads={threads} discussion={discussion} onDiscussion={openDiscussion} loading={threadQuery.isLoading} loadError={threadQuery.isError || threadQuery.data === null} /> : <OutlineRail sections={selected?.sections ?? []} contentKey={read?.revision.id ?? selected?.id ?? ""} />}
      </aside>

      <WikiSearchPalette
        wsId={wsId}
        projectId={props.projectId}
        pages={pages}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onJump={(target) => navigateToPage(target.slug, target.anchor)}
      />

      <Dialog open={!!pendingLeave} onOpenChange={(open) => { if (!open) setPendingLeave(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.wiki.leaveDialogTitle)}</DialogTitle>
            <DialogDescription>{t(($) => $.wiki.leaveDialogDescription)}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPendingLeave(null)}>{t(($) => $.wiki.leaveDialogCancel)}</Button>
            <Button type="button" variant="destructive" size="sm" onClick={leaveAndDiscard} data-testid="wiki-leave-discard">{t(($) => $.wiki.leaveDialogConfirm)}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <style>{`
        .wiki-flash { animation: wiki-flash-soft 1.6s ease-out; }
        @keyframes wiki-flash-soft { 0%, 60% { background-color: color-mix(in srgb, var(--brand) 18%, transparent); } 100% { background-color: transparent; } }
      `}</style>
      {(createPage.isPending || movePage.isPending || renamePage.isPending) ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-1 opacity-70" aria-hidden="true"><LoaderCircle className="size-4 animate-spin text-muted-foreground" /></div>
      ) : null}
    </div>
  );
}

