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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, ChevronRight, History, LoaderCircle, Menu, Pencil, PanelRightClose,
} from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { ApiError, api, errorCode, WikiConflictSchema, type WikiTreePage } from "@multica/core/api";
import { issueIdentifierOptions, issueKeys } from "@multica/core/issues/queries";
import { projectWikiPageOptions, projectWikiTreeOptions } from "@multica/core/projects/queries";
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
import { WikiMarkdown } from "./engineering-baseline-markdown";
import { WikiSearchPalette } from "./engineering-baseline-search";
import { useNavigation } from "../../navigation";
import { type WikiMoveIntent, WikiTreePanel } from "./engineering-baseline-tree";

const FLASH_MS = 1600;

export interface EngineeringBaselineWikiProps {
  workspaceSlug: string;
  workspaceId: string;
  projectId: string;
  projectTitle: string;
}

/** Split page markdown into the pre-first-H2 intro and each H2 section. */
function splitByH2(markdown: string): { intro: string; sections: { title: string; body: string }[] } {
  const lines = markdown.split(/\r?\n/);
  const intro: string[] = [];
  const sections: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      current = { title: line.replace(/^##\s+/, ""), body: [line] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      intro.push(line);
    }
  }
  return { intro: intro.join("\n"), sections: sections.map((section) => ({ title: section.title, body: section.body.join("\n") })) };
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

function OutlineRail({ sections, className }: { sections: readonly { anchor: string; title: string; level: number }[]; className?: string }) {
  const { t } = useT("engineering");
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!sections.length) return;
    const targets = sections
      .map((section) => document.getElementById(`s-${section.anchor}`))
      .filter((element): element is HTMLElement => element !== null);
    if (!targets.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id.slice(2));
      },
      { rootMargin: "-64px 0px -70% 0px" },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [sections]);

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

  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [guidePending, setGuidePending] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ scope: "page" | "section"; anchor?: string; title?: string } | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);

  const navigation = useNavigation();
  const urlPage = navigation.searchParams.get("page");
  const urlSection = navigation.searchParams.get("section");
  const selected = useMemo(() => pages.find((page) => page.slug === urlPage) ?? pages[0] ?? null, [pages, urlPage]);
  const selectedTreePage = selected;

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
    setRightOpen(false);
  }, [selected?.id]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(!searchOpen);
      }
      if (event.key === "Escape" && (leftOpen || rightOpen)) {
        setLeftOpen(false);
        setRightOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen, leftOpen, rightOpen]);

  const flashSection = useCallback((anchor: string | undefined) => {
    if (!anchor) return;
    const element = document.getElementById(`s-${anchor}`);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    element.classList.add("wiki-flash");
    window.setTimeout(() => element.classList.remove("wiki-flash"), FLASH_MS);
  }, []);

  // Deep-linked section (?section=) flashes once the page body is rendered.
  const flashedRef = useRef(false);
  useEffect(() => {
    if (flashedRef.current || !urlSection || pageQuery.isLoading) return;
    flashedRef.current = true;
    const timer = window.setTimeout(() => flashSection(urlSection), 300);
    return () => window.clearTimeout(timer);
  }, [urlSection, pageQuery.isLoading, flashSection]);
  const navigateToPage = useCallback((slug: string, anchor?: string) => {
    const params = new URLSearchParams(navigation.searchParams);
    params.set("page", slug);
    if (anchor) params.set("section", anchor);
    else params.delete("section");
    const query = params.toString();
    navigation.replace(`${navigation.pathname}${query ? `?${query}` : ""}`);
    if (anchor) window.setTimeout(() => flashSection(anchor), 300);
    setLeftOpen(false);
    setRightOpen(false);
  }, [flashSection, navigation]);

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

  const handleCreateGuide = async (slug: string, title: string) => {
    setGuidePending(slug);
    try {
      await createPage.mutateAsync({
        projectId: props.projectId,
        title,
        slug,
        parent: "root",
        contentMarkdown: t(($) => $.wiki.guideTemplate, { title }),
      });
      toast.success(t(($) => $.wiki.guideCreated, { title }));
    } catch (cause) {
      // Someone created it concurrently: 409 slug-taken just means done.
      if (errorCode(cause) !== "baseline_slug_taken") toast.error(t(($) => $.wiki.guideError, { title }));
    } finally {
      setGuidePending(null);
    }
  };

  const handleRename = async (page: WikiTreePage, title: string) => {
    try {
      await renamePage.mutateAsync({ projectId: props.projectId, page: page.slug, baseRevisionNumber: page.currentRevisionNumber, title });
    } catch (cause) {
      handleTreeError(cause, "renameError");
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
            void restorePage.mutateAsync({ projectId: props.projectId, page: page.slug, baseRevisionNumber: archivedRevision })
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

  const pageMetaMap = useMemo(() => new Map(pages.map((page) => [page.slug, {
    title: page.title,
    path: breadcrumb.length ? breadcrumb.map((item) => item.title).join(" / ") : page.title,
    version: page.current?.number ?? page.currentRevisionNumber,
    updatedAt: page.updatedAt,
  }])), [pages, breadcrumb]);

  // Reader body split at H2 boundaries so each section carries its own hover
  // 编辑本节 affordance; anchors come from the tree section list in order.
  const sectionReader = useMemo(() => {
    if (!read || !read.contentMarkdown?.trim() || !selected) return null;
    const split = splitByH2(read.contentMarkdown);
    const sections = selected.sections;
    const h2List = sections.filter((section) => section.level === 2);
    const groupFor = (index: number) => {
      const start = sections.indexOf(h2List[index]!);
      if (start === -1) return [];
      const end = index + 1 < h2List.length ? sections.indexOf(h2List[index + 1]!) : sections.length;
      return sections.slice(start, end);
    };
    const introSections = h2List.length ? sections.slice(0, sections.indexOf(h2List[0]!)) : sections;
    const shared = {
      links: read.links,
      pageMeta: pageMetaMap,
      onNavigate: (target: { slug: string; anchor?: string }) => navigateToPage(target.slug, target.anchor),
      onCreateMissing: (title: string) => void handleCreateMissing(title),
    };
    return (
      <>
        {split.intro.trim() ? <WikiMarkdown markdown={split.intro} sections={introSections} {...shared} /> : null}
        {split.sections.map((segment, index) => {
          const anchor = h2List[index]?.anchor;
          return (
            <div key={anchor ?? index} className="group/sec relative -mx-2 rounded-sm px-2 hover:bg-muted/20">
              <button
                type="button"
                className="absolute -right-1 top-1.5 rounded-sm border bg-canvas px-1.5 py-0.5 text-micro text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/sec:opacity-100 [@media(hover:none)]:opacity-100"
                onClick={() => setEditor({ scope: "section", anchor, title: segment.title })}
                data-wiki-edit-section={anchor ?? segment.title}
              >{t(($) => $.wiki.editSection)}</button>
              <WikiMarkdown markdown={segment.body} sections={groupFor(index)} {...shared} />
            </div>
          );
        })}
      </>
    );
  }, [read, selected, pageMetaMap, navigateToPage, t, handleCreateMissing]);

  const maskOpen = leftOpen || rightOpen;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-canvas @container" data-wiki-shell>
      {/* Left column: static ≥1024px, overlay drawer below. */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-[min(320px,88%)] shrink-0 -translate-x-full border-r bg-canvas transition-transform duration-200 @[1024px]:static @[1024px]:z-auto @[1024px]:w-[272px] @[1280px]:w-[272px] @[1024px]:translate-x-0 @[1024px]:transition-none",
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
          onRetry={() => void treeQuery.refetch()}
          onSelect={(page) => navigateToPage(page.slug)}
          onCreateChild={(page) => void handleCreateChild(page)}
          onRename={(page, title) => void handleRename(page, title)}
          onMove={(intent) => void handleMove(intent)}
          onArchive={(page, recursive) => void handleArchive(page, recursive)}
          onRestore={(page) => void handleRestore(page)}
          onCreateGuide={(slug, title) => void handleCreateGuide(slug, title)}
          guidePending={guidePending}
        />
      </aside>
      {maskOpen ? <div className="fixed inset-0 z-30 bg-foreground/30 @[1024px]:hidden" onClick={() => { setLeftOpen(false); setRightOpen(false); }} data-wiki-drawer-mask /> : null}

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
          <button type="button" className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:text-foreground @[1024px]:hidden" aria-label={t(($) => $.wiki.openOutlineDrawer)} onClick={() => setRightOpen(true)}><PanelRightClose className="size-4" aria-hidden="true" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" ref={readerRef} data-wiki-reader>
          {historyOpen && selected ? (
            <WikiHistoryView
              wsId={wsId}
              projectId={props.projectId}
              page={selectedTreePage!}
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
                    <Button type="button" size="sm" onClick={() => setEditor({ scope: "page" })} data-testid="wiki-edit-page">
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
                      baseRevisionNumber={selected.currentRevisionNumber}
                      latestRevisionNumber={selected.currentRevisionNumber}
                      initialMarkdown={sectionQuery.data.sections[0]!.contentMarkdown}
                      saving={writingPending}
                      actorName={getActorName}
                      onSave={handleSave}
                      fetchCurrentContent={fetchCurrentContent}
                      onCancel={() => setEditor(null)}
                    />
                  )
                ) : (
                  <WikiEditor
                    scope="page"
                    baseRevisionNumber={selected.currentRevisionNumber}
                    latestRevisionNumber={selected.currentRevisionNumber}
                    initialMarkdown={read?.contentMarkdown ?? ""}
                    saving={writingPending}
                    actorName={getActorName}
                    onSave={handleSave}
                    fetchCurrentContent={fetchCurrentContent}
                    onCancel={() => setEditor(null)}
                  />
                )
              ) : pageQuery.isLoading ? <div className="space-y-2"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-40 w-full" /></div>
                : pageQuery.isError ? <p className="text-caption text-destructive">{t(($) => $.wiki.pageLoadError)}</p>
                : read?.contentMarkdown?.trim() ? sectionReader
                : (
                  <div className="rounded-md border border-dashed p-8 text-center">
                    <p className="text-body text-muted-foreground">{t(($) => $.wiki.pageEmpty)}</p>
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setEditor({ scope: "page" })}>{t(($) => $.wiki.pageStartWriting)}</Button>
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
        </div>
      </main>

      {/* Right column: outline rail, drawer under 1024px. */}
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-40 w-[min(320px,88%)] shrink-0 translate-x-full border-l bg-canvas transition-transform duration-200 @[1024px]:static @[1024px]:z-auto @[1024px]:w-[264px] @[1280px]:w-[296px] @[1024px]:translate-x-0 @[1024px]:transition-none",
          rightOpen && "translate-x-0",
        )}
        data-wiki-outline-column
      >
        <OutlineRail sections={selected?.sections ?? []} />
      </aside>

      <WikiSearchPalette
        wsId={wsId}
        projectId={props.projectId}
        pages={pages}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onJump={(target) => navigateToPage(target.slug, target.anchor)}
      />

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

