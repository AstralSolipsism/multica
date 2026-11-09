"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, History as FileClock, LoaderCircle, MessageSquarePlus, Pencil, Plus, Search, X, XCircle } from "@multica/ui/icons";
import { Alert, AlertDescription, AlertTitle } from "@multica/ui/components/ui/alert";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import type { BaselineChapter, BaselineHistory, BaselineRevision, ChapterState, IssueGraphNode } from "@multica/core/api";
import { matchLocale } from "@multica/core/i18n";
import { paths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { CollectionPageState } from "../../layout/collection-page";
import { AppLink, useNavigation } from "../../navigation";
import { useEngineeringChapterLabel, useFormatRelativeDate } from "./labels";
import {
  baselineModuleSlug,
  canEditBaselineSection,
  isBaselineModuleSlug,
  latestBaselineSectionRevision,
  mergeBaselineSections,
  orderedBaselineChapters,
  parseBaselineChapter,
  plainBaselineText,
  scanBaselineReferences,
  type BaselineDisplayChapter,
  type BaselineDisplaySection,
  type BaselineReference,
  type BaselineSection,
} from "./engineering-baseline-utils";
import {
  BaselineMarkdown,
  BaselineWikiProvider,
  type BaselineLens,
  type BaselineSectionRelations,
} from "./engineering-baseline-markdown";
import type { EngineeringRoadmap } from "./engineering-utils";
import {
  activeBaselineBatch,
  buildBaselineAnnotationThreads,
  isBatchRelatedToCandidate,
  reviewDraftItems,
  type BaselineAnnotationData,
  type BaselineComposerAnchor,
  type BaselineReviewOutcome,
} from "./engineering-baseline-annotation-model";
import { BaselineSourceDiff, baselineSourceDisplaySections } from "./engineering-baseline-source-diff";
import { BaselineReviewDialog } from "./engineering-baseline-review-dialog";
import { BaselineBatchDialog, BaselineReviewBar, type BaselineCompareView, type BaselineDecisionAction, type BaselineReviewMode } from "./engineering-baseline-review-bar";
import {
  BaselineAnnotateSectionButton,
  BaselineStandaloneThreads,
  captureBaselineTextAnchor,
} from "./engineering-baseline-reading-annotations";
import { baselineReadingEntries } from "./engineering-baseline-reading-card";
import { BaselineReadingRail } from "./engineering-baseline-reading-rail";
import { BaselineReadingHighlights } from "./engineering-baseline-reading-highlights";
import { baselineTextAnnotationAtPoint } from "./engineering-baseline-text-annotations";
import { CommentSelectionBubble } from "../../issues/components/comment-selection-bubble";
import { useBaselineAnnotationDrafts } from "./use-baseline-annotation-drafts";

type DecisionAction = "adopt" | "reject";
type BaselineSaveError = "save" | "decision";

const BASELINE_MODULE_PREFIX = "module:";

export interface BaselineSaveDraft {
  chapter: BaselineChapter;
  contentMarkdown: string;
  changeSummary: string;
  section?: string;
  chapterTitle?: string;
}

export interface BaselineSaveResult {
  revision: BaselineRevision | null;
  error?: BaselineSaveError;
}

export interface BaselineWikiPosition {
  chapter: BaselineChapter;
  readerScrollTop: number;
  tocScrollTop: number;
}

export interface BaselineWikiRestorePosition extends BaselineWikiPosition {
  version: number;
}

interface EngineeringBaselineProps {
  workspaceSlug: string;
  workspaceId: string;
  projectId: string;
  projectTitle: string;
  chapters: readonly ChapterState[];
  selectedChapter: BaselineChapter;
  onChapterChange: (chapter: BaselineChapter) => void;
  revision: BaselineRevision | null;
  currentCandidate: boolean;
  candidateLoading: boolean;
  candidateNotFound: boolean;
  canDecide: boolean;
  decisionPending: boolean;
  decisionError: boolean;
  decisionErrorMessage: string;
  onRetryDecision?: () => Promise<void>;
  onClearDecisionError: () => void;
  onDecision: (action: DecisionAction, revision: BaselineRevision, annotationBatchAction?: "close" | "keep") => Promise<boolean>;
  annotations: BaselineAnnotationData;
  savePending: boolean;
  onSave: (draft: BaselineSaveDraft, adopt: boolean) => Promise<BaselineSaveResult>;
  history: BaselineHistory | null | undefined;
  historyLoading: boolean;
  historyError: boolean;
  onHistoryMore: () => void;
  chapterRevisions: Partial<Record<BaselineChapter, readonly BaselineRevision[]>>;
  roadmap: EngineeringRoadmap;
  reviewRequested: boolean;
  pendingCandidates: readonly BaselineRevision[];
  batchIds: readonly string[];
  processedRevisionIds: ReadonlySet<string>;
  processedCount: number;
  returnLabel: string;
  onReturnFromReview: () => void;
  onSelectCandidate: (candidateId: string) => void;
  onOpenProcessed: () => void;
  onReviewCandidate: (candidateId: string, position: BaselineWikiPosition) => void;
  restorePosition: BaselineWikiRestorePosition | null;
  lens: BaselineLens;
  onOpenStage: (stage: number) => void;
}

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, value); } catch { /* Keep the in-memory preference when storage is unavailable. */ }
}

function sectionDomId(key: string): string {
  return `baseline-section-${encodeURIComponent(key)}`;
}

function scrollToElement(reader: HTMLDivElement | null, element: HTMLElement | null) {
  if (!reader || !element) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const top = element.getBoundingClientRect().top - reader.getBoundingClientRect().top + reader.scrollTop - 52;
  reader.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? "auto" : "smooth" });
}

function scrollToKey(reader: HTMLDivElement | null, key: string) {
  scrollToElement(reader, document.getElementById(sectionDomId(key)));
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark className="rounded-sm bg-accent px-0.5 text-accent-foreground">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

function BaselineEditorForm({ idPrefix, content, summary, pending, canDecide, error, section, onContentChange, onSummaryChange, onCancel, onSave }: {
  idPrefix: string;
  content: string;
  summary: string;
  pending: boolean;
  canDecide: boolean;
  error: BaselineSaveError | null;
  section?: boolean;
  onContentChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onCancel: () => void;
  onSave: (adopt: boolean) => Promise<void>;
}) {
  const { t } = useT("engineering");
  const incomplete = !content.trim() || !summary.trim();
  return (
    <form className="mt-4 space-y-4 rounded-md border p-4" data-baseline-editor data-baseline-section-editor={section ? "" : undefined} onSubmit={(event) => { event.preventDefault(); void onSave(false); }}>
      {error ? <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t(($) => error === "decision" ? $.errors.decisionTitle : $.errors.baselineSaveTitle)}</AlertTitle><AlertDescription>{t(($) => error === "decision" ? $.errors.decision : $.errors.baselineSave)}</AlertDescription></Alert> : null}
      <div className="space-y-2">
        <label className="text-caption font-medium" htmlFor={`${idPrefix}-markdown`}>{t(($) => $.baseline.editorMarkdown)}</label>
        <Textarea id={`${idPrefix}-markdown`} value={content} onChange={(event) => onContentChange(event.target.value)} disabled={pending} required className="min-h-64 font-mono text-caption" />
      </div>
      <div className="space-y-2">
        <label className="text-caption font-medium" htmlFor={`${idPrefix}-summary`}>{t(($) => $.baseline.editorSummary)}</label>
        <Input id={`${idPrefix}-summary`} value={summary} onChange={(event) => onSummaryChange(event.target.value)} placeholder={t(($) => $.baseline.editorSummaryPlaceholder)} disabled={pending} required />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>{t(($) => $.actions.cancel)}</Button>
        {canDecide ? (
          <>
            <Button type="button" variant="outline" disabled={pending || incomplete} onClick={() => void onSave(false)}>{t(($) => $.actions.submitForReview)}</Button>
            <Button type="button" disabled={pending || incomplete} aria-busy={pending} onClick={() => void onSave(true)}>
              {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.actions.saveAndAdopt)}
            </Button>
          </>
        ) : (
          <Button type="submit" disabled={pending || incomplete} aria-busy={pending}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.actions.submitRevisionCandidate)}
          </Button>
        )}
      </div>
    </form>
  );
}

function BaselineModuleDialog({ chapter, chapters, canDecide, pending, onClose, onSave }: {
  chapter: BaselineChapter | null;
  chapters: readonly ChapterState[];
  canDecide: boolean;
  pending: boolean;
  onClose: () => void;
  onSave: (draft: BaselineSaveDraft, adopt: boolean) => Promise<BaselineSaveResult>;
}) {
  const { t, i18n } = useT("engineering");
  const locale = matchLocale([i18n.resolvedLanguage ?? i18n.language]);
  const isNew = chapter === null;
  const state = chapters.find((item) => item.chapter === chapter);
  const [title, setTitle] = useState(state?.title || chapter?.slice(7) || "");
  const [slug, setSlug] = useState(chapter?.slice(7) ?? "");
  const [slugCustomized, setSlugCustomized] = useState(!isNew);
  const [content, setContent] = useState(state?.candidate?.contentMarkdown ?? state?.adopted?.contentMarkdown ?? "");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<BaselineSaveError | null>(null);
  const normalizedSlug = slug.trim();
  const invalidSlug = isNew && !isBaselineModuleSlug(normalizedSlug);
  const duplicateSlug = isNew && chapters.some((item) => item.chapter === `module:${normalizedSlug}`);
  const incomplete = !title.trim() || !summary.trim() || invalidSlug || duplicateSlug || (isNew && !content.trim());
  const save = async (adopt: boolean) => {
    if (incomplete || pending || (adopt && state?.candidate)) return;
    setError(null);
    try {
      const result = await onSave({
        chapter: chapter ?? `module:${normalizedSlug}`,
        chapterTitle: title.trim(),
        contentMarkdown: content,
        changeSummary: summary.trim(),
      }, adopt);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (!result.revision) {
        setError("save");
        return;
      }
      onClose();
    } catch {
      setError("save");
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={(event) => { event.preventDefault(); void save(false); }}>
          <DialogHeader>
            <DialogTitle>{t(($) => isNew ? $.baseline.createModule : $.baseline.renameModule)}</DialogTitle>
            <DialogDescription>{t(($) => isNew ? $.baseline.createModuleDescription : $.baseline.renameModuleDescription)}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            {error ? <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t(($) => error === "decision" ? $.errors.decisionTitle : $.errors.baselineSaveTitle)}</AlertTitle><AlertDescription>{t(($) => error === "decision" ? $.errors.decision : $.errors.baselineSave)}</AlertDescription></Alert> : null}
            <div className="space-y-2">
              <label className="text-caption font-medium" htmlFor="baseline-module-title">{t(($) => $.baseline.moduleName)}</label>
              <Input id="baseline-module-title" value={title} autoFocus disabled={pending} required onChange={(event) => {
                const value = event.target.value;
                setTitle(value);
                if (!slugCustomized) setSlug(baselineModuleSlug(value, locale));
              }} />
            </div>
            {isNew ? (
              <div className="space-y-2">
                <label className="text-caption font-medium" htmlFor="baseline-module-slug">{t(($) => $.baseline.moduleSlug)}</label>
                <div className="flex items-center rounded-md border focus-within:ring-2 focus-within:ring-ring">
                  <span className="pl-3 font-mono text-caption text-muted-foreground">{BASELINE_MODULE_PREFIX}</span>
                  <Input id="baseline-module-slug" value={slug} disabled={pending} required aria-invalid={!!normalizedSlug && (invalidSlug || duplicateSlug)} aria-describedby={normalizedSlug && (invalidSlug || duplicateSlug) ? "baseline-module-slug-error" : undefined} placeholder={t(($) => $.baseline.moduleSlugPlaceholder)} className="border-0 focus-visible:ring-0" onChange={(event) => { setSlugCustomized(true); setSlug(event.target.value); }} />
                </div>
                {normalizedSlug && (invalidSlug || duplicateSlug) ? <p id="baseline-module-slug-error" className="text-caption text-destructive">{t(($) => duplicateSlug ? $.errors.moduleSlugDuplicate : $.errors.moduleSlug)}</p> : null}
              </div>
            ) : null}
            {isNew ? (
              <div className="space-y-2">
                <label className="text-caption font-medium" htmlFor="baseline-module-content">{t(($) => $.baseline.editorMarkdown)}</label>
                <Textarea id="baseline-module-content" value={content} disabled={pending} required className="min-h-48 font-mono text-caption" onChange={(event) => setContent(event.target.value)} />
              </div>
            ) : null}
            <div className="space-y-2">
              <label className="text-caption font-medium" htmlFor="baseline-module-summary">{t(($) => $.baseline.editorSummary)}</label>
              <Input id="baseline-module-summary" value={summary} disabled={pending} required placeholder={t(($) => $.baseline.editorSummaryPlaceholder)} onChange={(event) => setSummary(event.target.value)} />
            </div>
          </div>
          <DialogFooter className="mt-5">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t(($) => $.actions.cancel)}</Button>
            {canDecide ? (
              <>
                <Button type="button" variant="outline" disabled={pending || incomplete} onClick={() => void save(false)}>{t(($) => $.actions.submitForReview)}</Button>
                {state?.candidate ? null : <Button type="button" disabled={pending || incomplete} aria-busy={pending} onClick={() => void save(true)}>{pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.actions.saveAndAdopt)}</Button>}
              </>
            ) : <Button type="submit" disabled={pending || incomplete} aria-busy={pending}>{pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.actions.submitRevisionCandidate)}</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BaselineHistoryList({ history, loading, error, onMore }: { history: BaselineHistory | null | undefined; loading: boolean; error: boolean; onMore: () => void }) {
  const { t } = useT("engineering");
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  return (
    <div className="space-y-3">
      {error ? <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t(($) => $.errors.title)}</AlertTitle><AlertDescription>{t(($) => $.errors.history)}</AlertDescription></Alert> : null}
      {loading && !history ? <Skeleton className="h-24 w-full" /> : null}
      {history && history.revisions.length === 0 ? <div className="text-caption text-muted-foreground">{t(($) => $.history.empty)}</div> : null}
      <ul className="divide-y">
        {history?.revisions.map((revision) => (
          <li key={revision.id} className="grid gap-1 py-3 text-caption sm:grid-cols-[5rem_7rem_minmax(0,1fr)]">
            <span className="font-mono">{t(($) => $.baseline.revisionWaiting, { number: revision.revisionNumber })}</span>
            <span className="text-muted-foreground">{revision.decidedAt ? <time dateTime={revision.decidedAt}>{formatRelativeDate(revision.decidedAt)}</time> : t(($) => $.status[revision.status] ?? $.status.unknown)}</span>
            <div>
              <div>{revision.changeSummary || t(($) => $.recent.noSummary)}</div>
              <div className="mt-1 flex flex-wrap gap-2 text-muted-foreground">
                <Badge variant="outline">{t(($) => $.status[revision.status] ?? $.status.unknown)}</Badge>
                {revision.decisionCredential ? <Badge variant="secondary">{t(($) => $.credentials[revision.decisionCredential!] ?? $.credentials.unknown)}</Badge> : null}
                {revision.decidedByType && revision.decidedById ? <span>{getActorName(revision.decidedByType, revision.decidedById)}</span> : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {history?.hasMore ? <Button variant="outline" size="sm" onClick={onMore} disabled={loading}>{loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.history.more)}</Button> : null}
    </div>
  );
}

function SectionRelations({ section, relations, lens, onConcept }: {
  section: BaselineDisplaySection;
  relations: BaselineSectionRelations | undefined;
  lens: BaselineLens;
  onConcept: (section: BaselineSection) => void;
}) {
  const { t } = useT("engineering");
  if (!relations || section.change === "removed") return null;
  if (lens === "understand") {
    if (!relations.relatedConcepts.length) return null;
    return (
      <div className="mt-2 text-caption text-muted-foreground" data-section-relations="concepts">
        <span className="mr-2">{t(($) => $.wiki.relatedConcepts)}</span>
        {relations.relatedConcepts.map((concept) => <button key={concept.key} type="button" className="mr-3 underline decoration-dotted underline-offset-2 hover:text-foreground" onClick={() => onConcept(concept)}>{concept.title}</button>)}
      </div>
    );
  }
  if (!relations.backlinks.length && !relations.issues.length && !relations.latestRevision) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground" data-section-relations="management">
      {relations.backlinks.length ? <span>{t(($) => $.wiki.backlinks)} {relations.backlinks.map((concept) => <button key={concept.key} type="button" className="ml-1 underline decoration-dotted underline-offset-2 hover:text-foreground" onClick={() => onConcept(concept)}>{concept.title}</button>)}</span> : null}
      {relations.issues.length ? <span>{t(($) => $.wiki.linkedIssues)} <span className="ml-1">{relations.issues.map((issue) => issue.identifier).join(", ")}</span></span> : null}
      {relations.latestRevision ? <span>{t(($) => $.wiki.latestRevision, { number: relations.latestRevision.revisionNumber })}</span> : null}
    </div>
  );
}

export function EngineeringBaseline(props: EngineeringBaselineProps) {
  const chapterLabel = useEngineeringChapterLabel(props.chapters);
  const selectedChapter = props.selectedChapter;
  const onChapterChange = props.onChapterChange;
  const reviewRequested = props.reviewRequested;
  const restorePosition = props.restorePosition;
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const { t } = useT("engineering");
  const navigation = useNavigation();
  const articleRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLElement>(null);
  const pendingScrollKeyRef = useRef<string | null>(null);
  const pendingPositionRef = useRef<BaselineWikiPosition | null>(null);
  const previousChapterRef = useRef(selectedChapter);
  const consumedRestoreVersionRef = useRef(0);
  const readKey = `multica.engineering-baseline.read.${props.projectId}`;
  const lens = props.lens;
  const [mode, setMode] = useState<BaselineReviewMode>(reviewRequested ? "compare" : "base");
  const previousReviewRequestedRef = useRef(reviewRequested);
  const [compareView, setCompareView] = useState<BaselineCompareView>("source");
  const [readingComposer, setReadingComposer] = useState<{ sectionKey: string; anchor: BaselineComposerAnchor } | null>(null);
  const [readingSelection, setReadingSelection] = useState<{ sectionKey: string; anchor: BaselineComposerAnchor; range: Range; root: HTMLElement } | null>(null);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [annotationDrawerOpen, setAnnotationDrawerOpen] = useState(false);
  const [readerProgress, setReaderProgress] = useState(0);
  const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null);
  const [hoveredAnnotation, setHoveredAnnotation] = useState<string | null>(null);
  const [reviewDialog, setReviewDialog] = useState<{ initialOutcome: BaselineReviewOutcome | null; candidateMode: boolean } | null>(null);
  const [decisionAction, setDecisionAction] = useState<BaselineDecisionAction | null>(null);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [editingChapter, setEditingChapter] = useState<BaselineChapter | null>(null);
  const [editingSection, setEditingSection] = useState<{ chapter: BaselineChapter; key: string; query: string } | null>(null);
  const [moduleEditor, setModuleEditor] = useState<{ chapter: BaselineChapter | null } | null>(null);
  const moduleTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [saveError, setSaveError] = useState<BaselineSaveError | null>(null);
  const [query, setQuery] = useState("");
  const [readIds, setReadIds] = useState<readonly string[]>(() => {
    try {
      const value = JSON.parse(readStorage(readKey) ?? "[]");
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  });
  const readIdsRef = useRef(readIds);
  const [back, setBack] = useState<BaselineWikiPosition & { key: string; label: string } | null>(null);
  const [changeCursor, setChangeCursor] = useState(0);
  const revision = props.revision;
  const selectedState = props.chapters.find((chapter) => chapter.chapter === selectedChapter);
  const selectedAdopted = selectedState?.adopted ?? null;
  const selectedCandidate = selectedState?.candidate ?? null;
  const annotationDrafts = useBaselineAnnotationDrafts({
    projectId: props.projectId,
    chapter: selectedChapter,
    ownerId: props.annotations.actions.ownerId,
    canDecide: props.canDecide,
  });
  const activeBatch = activeBaselineBatch(props.annotations.batches, selectedChapter);
  const activeDetail = props.annotations.details.find((detail) => detail.batch.id === activeBatch?.id);
  const activeRootIds = useMemo(() => new Set(activeDetail?.annotations.map((annotation) => annotation.id) ?? []), [activeDetail]);
  const currentTargetIds = useMemo(() => {
    if (mode === "compare" && revision?.chapter === selectedChapter) {
      return new Set([revision.id, revision.baseRevisionId ?? selectedAdopted?.id].filter((id): id is string => !!id));
    }
    return new Set(selectedAdopted ? [selectedAdopted.id] : []);
  }, [mode, revision, selectedChapter, selectedAdopted]);
  const currentPendingItems = useMemo(
    () => reviewDraftItems(annotationDrafts.items, currentTargetIds, activeRootIds),
    [annotationDrafts.items, currentTargetIds, activeRootIds],
  );
  const annotationThreads = useMemo(
    () => buildBaselineAnnotationThreads(props.annotations.details.filter((detail) => detail.batch.chapter === selectedChapter), currentPendingItems),
    [props.annotations.details, currentPendingItems, selectedChapter],
  );
  const resolveAnnotation = useCallback(async (annotationId: string, resolved: boolean) => {
    try {
      return !!(await props.annotations.actions.onResolveAnnotations([annotationId], resolved));
    } catch {
      return false;
    }
  }, [props.annotations.actions]);

  useEffect(() => {
    if (reviewRequested && revision) setMode("compare");
    else if (!revision || previousReviewRequestedRef.current) setMode("base");
    previousReviewRequestedRef.current = reviewRequested;
  }, [reviewRequested, revision]);
  useEffect(() => {
    setCompareView("source");
    setReadingComposer(null);
    setReadingSelection(null);
    setHoveredAnnotation(null);
    setAnnotationDrawerOpen(false);
  }, [revision?.id, selectedChapter]);
  useEffect(() => {
    if (!showAnnotations) {
      setReadingComposer(null);
      setReadingSelection(null);
      setHoveredAnnotation(null);
      setAnnotationDrawerOpen(false);
    }
  }, [showAnnotations]);
  useEffect(() => {
    if (!readingSelection) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest("[data-baseline-selection-action]") && !readingSelection.root.contains(event.target)) setReadingSelection(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReadingSelection(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [readingSelection]);
  useEffect(() => setBack(null), [lens]);
  useEffect(() => setSaveError(null), [selectedChapter]);

  const openModuleEditor = (chapter: BaselineChapter | null, trigger: HTMLButtonElement) => {
    moduleTriggerRef.current = trigger;
    setModuleEditor({ chapter });
  };
  const closeModuleEditor = () => {
    setModuleEditor(null);
    const trigger = moduleTriggerRef.current;
    if (trigger) window.requestAnimationFrame(() => trigger.focus());
  };
  const openChapterEditor = (chapter: BaselineChapter) => {
    const state = props.chapters.find((item) => item.chapter === chapter);
    onChapterChange(chapter);
    setDraftContent(state?.candidate?.contentMarkdown ?? state?.adopted?.contentMarkdown ?? "");
    setChangeSummary("");
    setSaveError(null);
    setEditingSection(null);
    setEditingChapter(chapter);
  };
  const openSectionEditor = (section: BaselineSection) => {
    setDraftContent(section.markdown);
    setChangeSummary("");
    setSaveError(null);
    setEditingChapter(null);
    setEditingSection({ chapter: section.chapter, key: section.key, query: section.anchor });
  };
  const saveDraft = async (adopt: boolean) => {
    const chapter = editingChapter ?? editingSection?.chapter;
    if (!chapter || props.savePending || !draftContent.trim() || !changeSummary.trim()) return;
    setSaveError(null);
    try {
      const result = await props.onSave({
        chapter,
        contentMarkdown: draftContent,
        changeSummary: changeSummary.trim(),
        ...(editingSection ? { section: editingSection.query } : {}),
      }, adopt);
      if (result.error) {
        setSaveError(result.error);
        return;
      }
      if (!result.revision) {
        setSaveError("save");
        return;
      }
      setMode("compare");
      setEditingChapter(null);
      setEditingSection(null);
      setChangeSummary("");
    } catch {
      setSaveError("save");
    }
  };
  const saveModule = async (draft: BaselineSaveDraft, adopt: boolean) => {
    const result = await props.onSave(draft, adopt);
    if (result.revision && !result.error) setMode("compare");
    return result;
  };

  const nodes = useMemo(() => [
    ...props.roadmap.stages.flatMap((stage) => stage.tasks),
    ...props.roadmap.outside,
  ], [props.roadmap]);
  const displayChapters = useMemo<BaselineDisplayChapter[]>(() => {
    const chapters = orderedBaselineChapters(props.chapters);
    if (revision && !chapters.includes(revision.chapter)) chapters.push(revision.chapter);
    return chapters.map((chapter) => {
      const adopted = props.chapters.find((item) => item.chapter === chapter)?.adopted?.contentMarkdown ?? "";
      const chapterRevision = revision?.chapter === chapter ? revision : null;
      return {
        chapter,
        sections: chapterRevision && mode === "compare" && compareView === "source"
          ? baselineSourceDisplaySections(chapter, adopted, chapterRevision.contentMarkdown)
          : mergeBaselineSections(chapter, adopted, chapterRevision, mode === "compare" && !!chapterRevision),
      };
    });
  }, [props.chapters, revision, mode, compareView]);
  const visibleChapter = displayChapters.find((chapter) => chapter.chapter === selectedChapter) ?? displayChapters[0];
  const readingSections = useMemo(() => visibleChapter?.sections.filter((section) => section.change !== "removed") ?? [], [visibleChapter]);
  const readingSectionAnchors = useMemo(() => new Set(readingSections.map((section) => section.anchor)), [readingSections]);
  const readingThreads = useMemo(() => annotationThreads.filter((thread) => readingSectionAnchors.has(thread.root.sectionAnchor)), [annotationThreads, readingSectionAnchors]);
  const readingPendingItems = useMemo(() => currentPendingItems.filter((item) => readingSectionAnchors.has(item.sectionAnchor)), [currentPendingItems, readingSectionAnchors]);
  const readingComposerAnchor = readingComposer && readingSections.some((section) => section.key === readingComposer.sectionKey) ? readingComposer.anchor : null;
  const readingEntries = useMemo(
    () => baselineReadingEntries(readingThreads, readingPendingItems, readingComposerAnchor),
    [readingThreads, readingPendingItems, readingComposerAnchor],
  );
  const readingMode = mode === "base" && !!selectedAdopted;
  const readingAnnotationsVisible = readingMode && showAnnotations;
  const showReadingRail = readingAnnotationsVisible;
  const readingAnnotationCount = readingEntries.filter((entry) => entry.kind !== "composer" && (entry.kind !== "thread" || entry.thread.root.state !== "resolved")).length;
  useEffect(() => {
    if (!readingAnnotationsVisible) return;
    let frame = 0;
    let pending: MouseEvent | null = null;
    const move = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[data-reading-annotations]")) {
        pending = null;
        return;
      }
      pending = event;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const current = pending;
        pending = null;
        if (!current || !(current.target instanceof Element) || !current.target.isConnected) return;
        const root = current.target.closest<HTMLElement>("[data-baseline-markdown]");
        if (!root) {
          if (current.target.closest("[data-baseline-section-key]")) setHoveredAnnotation(null);
          return;
        }
        const article = root.closest<HTMLElement>("[data-baseline-section-key]");
        const section = readingSections.find((item) => item.key === article?.dataset.baselineSectionKey);
        if (!section) return;
        const candidates = readingEntries.filter((entry) => entry.anchor.anchorKind === "text" && entry.anchor.sectionAnchor === section.anchor)
          .map((entry) => ({ ...entry.anchor, id: entry.id }));
        setHoveredAnnotation(baselineTextAnnotationAtPoint(root, current.clientX, current.clientY, candidates));
      });
    };
    document.addEventListener("mousemove", move);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener("mousemove", move);
    };
  }, [readingAnnotationsVisible, readingEntries, readingSections]);
  const sectionEditTargets = useMemo(() => {
    const targets = new Map<string, BaselineSection>();
    for (const state of props.chapters) {
      if (!state.adopted || state.candidate) continue;
      const chapterRevision = revision?.chapter === state.chapter ? revision : null;
      if (chapterRevision && chapterRevision.id !== state.adopted.id) continue;
      const sections = parseBaselineChapter(state.chapter, state.adopted.contentMarkdown).sections;
      for (const section of sections) {
        if (canEditBaselineSection(section, sections)) targets.set(section.key, section);
      }
    }
    return targets;
  }, [props.chapters, revision]);
  const activeSections = useMemo(() => displayChapters.flatMap((chapter) => chapter.sections).filter((section) => section.change !== "removed"), [displayChapters]);
  const changedSections = useMemo(() => visibleChapter?.sections.filter((section) => section.change !== "same") ?? [], [visibleChapter]);
  const referencesBySection = useMemo(() => new Map(activeSections.map((section) => [
    section.key,
    scanBaselineReferences(section, activeSections, nodes, props.roadmap.stages),
  ])), [activeSections, nodes, props.roadmap.stages]);
  const relations = useMemo(() => new Map<string, BaselineSectionRelations>(activeSections.map((section) => {
    const outgoing = referencesBySection.get(section.key) ?? [];
    const related = new Map<string, BaselineSection>();
    for (const reference of outgoing) if (reference.kind === "concept") related.set(reference.section.key, reference.section);
    const backlinks = activeSections.filter((candidate) => candidate.key !== section.key && (referencesBySection.get(candidate.key) ?? []).some((reference) => reference.kind === "concept" && reference.section.key === section.key));
    for (const backlink of backlinks) if (!related.has(backlink.key)) related.set(backlink.key, backlink);
    const issues = new Map<string, IssueGraphNode>();
    for (const reference of outgoing) if (reference.kind === "issue") issues.set(reference.node.id, reference.node);
    return [section.key, {
      relatedConcepts: [...related.values()],
      backlinks,
      issues: [...issues.values()],
      latestRevision: latestBaselineSectionRevision(section, props.chapterRevisions[section.chapter] ?? []),
    }];
  })), [activeSections, referencesBySection, props.chapterRevisions]);
  const referenceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const references of referencesBySection.values()) {
      const unique = new Set(references.map((reference) => `${reference.kind}:${reference.key}`));
      for (const key of unique) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [referencesBySection]);

  const markRead = useCallback((key: string) => {
    if (readIdsRef.current.includes(key)) return;
    const next = [...readIdsRef.current, key];
    readIdsRef.current = next;
    setReadIds(next);
    writeStorage(readKey, JSON.stringify(next));
  }, [readKey]);

  useEffect(() => {
    if (lens !== "understand" || typeof IntersectionObserver === "undefined" || !articleRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const key = (entry.target as HTMLElement).dataset.baselineSectionKey;
        if (key) markRead(key);
      }
    }, { root: readerRef.current, rootMargin: "0px 0px -35% 0px", threshold: 0.1 });
    articleRef.current.querySelectorAll("[data-baseline-section-key]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [visibleChapter, lens, markRead]);

  const onConcept = useCallback((section: BaselineSection, recordBack = true) => {
    if (recordBack && articleRef.current) {
      const source = [...articleRef.current.querySelectorAll<HTMLElement>("[data-baseline-section-key]")]
        .filter((element) => element.getBoundingClientRect().top < 180)
        .at(-1);
      if (source && source.dataset.baselineSectionKey !== section.key) {
        setBack({
          key: source.dataset.baselineSectionKey!,
          label: source.dataset.baselineSectionTitle ?? "",
          chapter: selectedChapter,
          readerScrollTop: readerRef.current?.scrollTop ?? 0,
          tocScrollTop: tocRef.current?.scrollTop ?? 0,
        });
      }
    }
    if (section.chapter !== selectedChapter) {
      pendingScrollKeyRef.current = section.key;
      onChapterChange(section.chapter);
    } else {
      scrollToKey(readerRef.current, section.key);
    }
    if (lens === "understand") markRead(section.key);
  }, [lens, markRead, selectedChapter, onChapterChange]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;
    const chapterChanged = previousChapterRef.current !== selectedChapter;
    previousChapterRef.current = selectedChapter;
    const restore = restorePosition;
    if (restore && restore.chapter === selectedChapter && consumedRestoreVersionRef.current !== restore.version) {
      consumedRestoreVersionRef.current = restore.version;
      pendingScrollKeyRef.current = null;
      pendingPositionRef.current = null;
      reader.scrollTo({ top: restore.readerScrollTop, behavior: "instant" });
      tocRef.current?.scrollTo({ top: restore.tocScrollTop, behavior: "instant" });
      setActiveSectionKey(readingSections[0]?.key ?? null);
      return;
    }
    const pendingPosition = pendingPositionRef.current;
    if (pendingPosition?.chapter === selectedChapter) {
      pendingPositionRef.current = null;
      pendingScrollKeyRef.current = null;
      reader.scrollTo({ top: pendingPosition.readerScrollTop, behavior: "instant" });
      tocRef.current?.scrollTo({ top: pendingPosition.tocScrollTop, behavior: "instant" });
      return;
    }
    const key = pendingScrollKeyRef.current;
    if (key) {
      pendingScrollKeyRef.current = null;
      setActiveSectionKey(key);
      scrollToKey(reader, key);
      return;
    }
    if (chapterChanged) {
      reader.scrollTo({ top: 0, behavior: "instant" });
      setReaderProgress(0);
      setActiveSectionKey(readingSections[0]?.key ?? null);
    }
  }, [selectedChapter, restorePosition, visibleChapter, readingSections]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === "Escape" && annotationDrawerOpen && !reviewRequested) {
        event.preventDefault();
        setAnnotationDrawerOpen(false);
        return;
      }
      if (reviewRequested || (event.key !== "[" && event.key !== "]")) return;
      const index = displayChapters.findIndex((chapter) => chapter.chapter === selectedChapter);
      const next = displayChapters[index + (event.key === "]" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      onChapterChange(next.chapter);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [displayChapters, selectedChapter, reviewRequested, onChapterChange, annotationDrawerOpen]);

  const updateReaderPosition = () => {
    const reader = readerRef.current;
    if (!reader) return;
    const available = reader.scrollHeight - reader.clientHeight;
    setReaderProgress(available > 0 ? Math.min(100, Math.max(0, Math.round(reader.scrollTop / available * 100))) : 100);
    const readerTop = reader.getBoundingClientRect().top;
    const current = readingSections.filter((section) => {
      const element = document.getElementById(sectionDomId(section.key));
      return element && element.getBoundingClientRect().top <= readerTop + 96;
    }).at(-1) ?? readingSections[0];
    setActiveSectionKey(current?.key ?? null);
  };
  const { workspaceSlug, onOpenStage } = props;
  const onNavigate = useCallback((reference: BaselineReference) => {
    if (reference.kind === "concept") onConcept(reference.section);
    else if (reference.kind === "issue") navigation.push(paths.workspace(workspaceSlug).issueDetail(reference.node.id));
    else onOpenStage(reference.stage.stage);
  }, [onConcept, navigation, workspaceSlug, onOpenStage]);

  // Stable across search input, hover and read tracking, so reference links
  // in every rendered section are not re-rendered by local state changes.
  const wikiContext = useMemo(() => ({
    lens,
    workspaceId: props.workspaceId,
    chapters: props.chapters,
    sections: activeSections,
    nodes,
    stages: props.roadmap.stages,
    relations,
    referenceCounts,
    onNavigate,
  }), [lens, props.workspaceId, props.chapters, activeSections, nodes, props.roadmap.stages, relations, referenceCounts, onNavigate]);

  const jumpChange = useCallback((index: number) => {
    if (!changedSections.length) return;
    const next = (index + changedSections.length) % changedSections.length;
    setChangeCursor(next);
    scrollToKey(readerRef.current, changedSections[next]!.key);
  }, [changedSections]);
  useEffect(() => {
    setChangeCursor(0);
    if (mode !== "compare" || !changedSections.length) return;
    const timeout = window.setTimeout(() => scrollToKey(readerRef.current, changedSections[0]!.key), 0);
    return () => window.clearTimeout(timeout);
  }, [mode, revision?.id, changedSections]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return activeSections.flatMap((section) => {
      const body = plainBaselineText(section.body);
      const haystack = `${section.title}\n${body}`.toLocaleLowerCase();
      const index = haystack.indexOf(normalized);
      if (index < 0) return [];
      const bodyIndex = body.toLocaleLowerCase().indexOf(normalized);
      const start = Math.max(0, bodyIndex - 24);
      const snippet = bodyIndex >= 0 ? `${start > 0 ? "…" : ""}${body.slice(start, bodyIndex + query.length + 48)}${bodyIndex + query.length + 48 < body.length ? "…" : ""}` : body.slice(0, 72);
      return [{ section, snippet }];
    });
  }, [activeSections, query]);
  const readCount = activeSections.filter((section) => readIds.includes(section.key)).length;
  const nextUnread = activeSections.find((section) => !readIds.includes(section.key));
  const sourceIssue = revision?.sourceIssueId ? nodes.find((node) => node.id === revision.sourceIssueId) : undefined;
  const adoptedRevision = revision ? props.chapters.find((chapter) => chapter.chapter === revision.chapter)?.adopted : null;
  const changeCount = revision
    ? mode === "compare" && compareView === "source"
      ? changedSections.length
      : revision.anchorsDiff.added.length + revision.anchorsDiff.modified.length + revision.anchorsDiff.removed.length
    : 0;
  const globalChapters = displayChapters.filter((chapter) => !chapter.chapter.startsWith("module:"));
  const moduleChapters = displayChapters.filter((chapter) => chapter.chapter.startsWith("module:"));
  const selectedChapterHasCandidate = props.chapters.some((chapter) => chapter.chapter === selectedChapter && chapter.candidate);
  const selectedPendingCandidate = props.pendingCandidates.find((candidate) => candidate.chapter === selectedChapter) ?? null;
  const visibleChapterIndex = displayChapters.findIndex((chapter) => chapter.chapter === selectedChapter);
  const previousChapter = visibleChapterIndex > 0 ? displayChapters[visibleChapterIndex - 1] : undefined;
  const nextChapter = visibleChapterIndex >= 0 ? displayChapters[visibleChapterIndex + 1] : undefined;
  const dialogTargetIds = new Set(
    reviewDialog?.candidateMode && revision
      ? [revision.id, revision.baseRevisionId ?? selectedAdopted?.id].filter((id): id is string => !!id)
      : selectedAdopted ? [selectedAdopted.id] : [],
  );
  const dialogPendingItems = reviewDraftItems(annotationDrafts.items, dialogTargetIds, activeRootIds);
  const captureReadingSelection = (article: HTMLElement, section: BaselineDisplaySection) => {
    if (!selectedAdopted || !props.canDecide || !readingAnnotationsVisible || selectedChapter !== section.chapter) {
      setReadingSelection(null);
      return;
    }
    const captured = captureBaselineTextAnchor(article, section, selectedAdopted, t(($) => $.baseline.baseMode, { number: selectedAdopted.revisionNumber }));
    setReadingSelection(captured ? { sectionKey: section.key, ...captured } : null);
  };
  const changeReviewMode = (next: BaselineReviewMode) => {
    setMode(next);
    setReadingSelection(null);
    setReadingComposer(null);
    setHoveredAnnotation(null);
  };
  const decideCandidate = (action: BaselineDecisionAction) => {
    if (!revision || props.decisionPending) return;
    if (action === "changes") {
      setReviewDialog({ initialOutcome: "changes", candidateMode: true });
      return;
    }
    const relatedBatch = activeBatch && isBatchRelatedToCandidate(activeBatch, revision, props.annotations.details);
    if (currentPendingItems.length || relatedBatch) {
      setReviewDialog({ initialOutcome: action, candidateMode: true });
      return;
    }
    setDecisionAction(action);
    void props.onDecision(action, revision).finally(() => setDecisionAction(null));
  };
  const renderChapterNavigation = (chapter: BaselineDisplayChapter) => {
    const selected = chapter.chapter === selectedChapter;
    const pending = props.pendingCandidates.some((candidate) => candidate.chapter === chapter.chapter);
    return (
      <div key={chapter.chapter} className="mb-3">
        <div className="flex items-center gap-1">
          <button type="button" aria-current={selected ? "page" : undefined} className={cn("block min-w-0 flex-1 truncate py-1 text-left text-caption font-medium hover:underline", selected ? "text-foreground" : "text-muted-foreground")} onClick={() => onChapterChange(chapter.chapter)}>{chapterLabel(chapter.chapter)}</button>
          {pending ? <Badge variant="secondary" className="bg-warning/10 text-warning">{t(($) => $.wiki.pendingReview)}</Badge> : null}
        </div>
        {selected ? chapter.sections.filter((section) => mode !== "compare" || compareView !== "source" || revision?.chapter !== chapter.chapter || section.change !== "same").map((section) => {
          const active = section.key === (activeSectionKey ?? readingSections[0]?.key);
          return (
            <button key={section.key} type="button" aria-current={active ? "location" : undefined} className={cn("flex w-full items-center gap-1 border-l py-1 pl-2 text-left text-caption", active || (readIds.includes(section.key) && lens === "understand") ? "border-foreground text-foreground" : "text-muted-foreground hover:text-foreground")} onClick={() => onConcept(section, false)}>
              <span className={cn("min-w-0 flex-1", section.change === "removed" && "line-through")}>{section.title || t(($) => $.wiki.untitled)}</span>
              {section.change !== "same" ? <span className="size-1.5 rounded-full bg-destructive" aria-label={t(($) => section.change === "added" ? $.baseline.added : section.change === "removed" ? $.baseline.removed : $.baseline.modified)} /> : null}
              {readIds.includes(section.key) && lens === "understand" ? <CheckCircle2 className="size-3 text-success" aria-label={t(($) => $.wiki.read)} /> : null}
            </button>
          );
        }) : null}
      </div>
    );
  };
  const readingRail = selectedAdopted ? (
    <BaselineReadingRail
      sections={readingSections}
      entries={readingEntries}
      adopted={selectedAdopted}
      candidate={selectedCandidate ?? selectedAdopted}
      canDecide={props.canDecide}
      limitReached={annotationDrafts.limitReached}
      hoveredId={hoveredAnnotation}
      onHover={setHoveredAnnotation}
      onAddAnnotation={annotationDrafts.addAnnotation}
      onCancelComposer={() => setReadingComposer(null)}
      onAddReply={(thread, note) => annotationDrafts.addReply(thread.root, note)}
      onUpdatePending={annotationDrafts.update}
      onDeletePending={annotationDrafts.remove}
      onResolve={resolveAnnotation}
    />
  ) : null;

  return (
    <BaselineWikiProvider value={wikiContext}>
          <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden @container" data-engineering-region="baseline">
            {!props.candidateLoading && reviewRequested ? (
              <BaselineReviewBar
                workspaceSlug={props.workspaceSlug}
                workspaceId={props.workspaceId}
                chapters={props.chapters}
                chapter={selectedChapter}
                revision={revision}
                adopted={adoptedRevision ?? selectedAdopted}
                currentCandidate={props.currentCandidate}
                canDecide={props.canDecide}
                decisionPending={props.decisionPending}
                mode={mode}
                changeCount={changeCount}
                activeBatch={activeBatch}
                sourceIssueIdentifier={sourceIssue?.identifier}
                queue={props.pendingCandidates}
                batchIds={props.batchIds}
                processedIds={props.processedRevisionIds}
                processedCount={props.processedCount}
                returnLabel={props.returnLabel}
                decisionAction={decisionAction}
                onReturn={props.onReturnFromReview}
                onSelectCandidate={props.onSelectCandidate}
                onOpenProcessed={props.onOpenProcessed}
                onDecide={decideCandidate}
                onModeChange={changeReviewMode}
                onOpenBatch={() => setBatchDialogOpen(true)}
              />
            ) : null}
            {!props.candidateLoading && props.decisionError ? <Alert className="shrink-0 border-x-0 border-t-0" variant="destructive" role="alert"><AlertTriangle /><AlertTitle>{t(($) => $.errors.decisionTitle)}</AlertTitle><AlertDescription><p>{props.decisionErrorMessage || t(($) => $.errors.decision)}</p><div className="mt-2 flex gap-2">{props.onRetryDecision ? <Button type="button" size="sm" variant="outline" disabled={props.decisionPending} onClick={() => void props.onRetryDecision?.()}>{t(($) => $.actions.retry)}</Button> : null}<Button type="button" size="sm" variant="ghost" onClick={props.onClearDecisionError}>{t(($) => $.actions.close)}</Button></div></AlertDescription></Alert> : null}
            {props.annotations.loading ? <Skeleton className="mx-4 mt-3 h-10 shrink-0" /> : null}
            {props.annotations.error ? <Alert className="mx-4 mt-3 shrink-0" variant="destructive"><AlertTriangle /><AlertDescription>{t(($) => $.annotations.loadError)}</AlertDescription></Alert> : null}

            <div className="relative min-h-0 flex-1 overflow-hidden">
              <div className={cn("grid h-full min-h-0", reviewRequested ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[160px_minmax(0,1fr)] @min-[720px]:grid-cols-[232px_minmax(0,1fr)]", showReadingRail && !reviewRequested && "@min-[960px]:grid-cols-[232px_minmax(0,1fr)_260px]")}>
                <aside ref={tocRef} className={cn("min-h-0 overflow-y-auto border-r bg-canvas/30 p-3", reviewRequested && "hidden")} aria-label={t(($) => $.wiki.tocLabel)} data-baseline-toc>
                  <label className="relative block">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                    <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(($) => $.wiki.searchPlaceholder)} aria-label={t(($) => $.wiki.searchPlaceholder)} className="pl-8" />
                  </label>
                  {query.trim() ? (
                    <div className="mt-3" data-search-results>
                      <div className="mb-2 text-caption text-muted-foreground">{t(($) => $.wiki.searchCount, { count: searchResults.length })}</div>
                      {searchResults.length ? searchResults.map(({ section, snippet }) => (
                        <button key={section.key} type="button" className="block w-full border-b py-2 text-left" onClick={() => onConcept(section)}>
                          <span className="block text-caption font-medium"><Highlight text={section.title || t(($) => $.wiki.untitled)} query={query.trim()} /></span>
                          <span className="line-clamp-2 text-micro text-muted-foreground"><Highlight text={snippet} query={query.trim()} /></span>
                          <span className="block text-micro text-muted-foreground">{chapterLabel(section.chapter)}</span>
                        </button>
                      )) : <p className="text-caption text-muted-foreground">{t(($) => $.wiki.searchEmpty, { query: query.trim() })}</p>}
                    </div>
                  ) : (
                    <div className="mt-4">
                      {lens === "understand" ? (
                        <div className="mb-4" data-read-progress>
                          <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-foreground transition-[width]" style={{ width: `${activeSections.length ? Math.round(readCount / activeSections.length * 100) : 0}%` }} /></div>
                          <div className="mt-1 text-caption text-muted-foreground">{t(($) => $.wiki.readProgress, { read: readCount, total: activeSections.length })}</div>
                          {nextUnread ? <button type="button" className="mt-1 text-left text-caption font-medium hover:underline" onClick={() => onConcept(nextUnread)}>{readCount ? t(($) => $.wiki.continueReading) : t(($) => $.wiki.startReading)}: {nextUnread.title || t(($) => $.wiki.untitled)} →</button> : <div className="mt-1 text-caption text-success">{t(($) => $.wiki.allRead)}</div>}
                        </div>
                      ) : null}
                      <nav>
                        <section aria-label={t(($) => $.wiki.globalChapters)}>
                          <h3 className="mb-1 text-micro font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.wiki.globalChapters)}</h3>
                          {globalChapters.map(renderChapterNavigation)}
                        </section>
                        <section className="mt-5" aria-label={t(($) => $.wiki.moduleChapters)}>
                          <h3 className="mb-1 text-micro font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.wiki.moduleChapters)}</h3>
                          {moduleChapters.map(renderChapterNavigation)}
                          <Button type="button" variant="ghost" size="sm" className="w-full justify-start px-0" disabled={props.savePending || !!editingChapter || !!editingSection} onClick={(event) => openModuleEditor(null, event.currentTarget)}>
                            <Plus aria-hidden="true" />{t(($) => $.actions.addModule)}
                          </Button>
                        </section>
                        <button type="button" className="block w-full py-1 text-left text-caption font-medium hover:underline" onClick={() => scrollToElement(readerRef.current, document.getElementById("baseline-history"))}>{t(($) => $.history.title)}</button>
                      </nav>
                    </div>
                  )}
                </aside>

                <section className="relative min-h-0 min-w-0" aria-label={t(($) => $.baseline.title)}>
                  {!reviewRequested ? <div className="absolute inset-x-0 top-0 z-10 h-0.5 bg-muted" aria-hidden="true"><div className="h-full bg-brand transition-[width]" style={{ width: `${readerProgress}%` }} data-reader-progress /></div> : null}
                  <div ref={readerRef} onScroll={updateReaderPosition} className="h-full min-h-0 overflow-y-auto overscroll-contain" data-baseline-reader>
                    <div ref={articleRef} className={cn("mx-auto min-w-0 p-4 md:p-6", reviewRequested ? "max-w-none" : "max-w-[720px]")}>
                      {props.candidateLoading ? <Skeleton className="h-24 w-full" /> : null}
                      {!props.candidateLoading && props.candidateNotFound ? <CollectionPageState icon={XCircle} tone="warning" title={t(($) => $.baseline.candidateMissing)} description={t(($) => $.baseline.candidateMissingDescription)} /> : null}
                      {!reviewRequested ? (
                        <header>
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="text-caption text-muted-foreground">{t(($) => $.views.baseline)}</div>
                              <h1 className="mt-1 text-title-lg font-semibold">{props.projectTitle} · {t(($) => $.baseline.title)}</h1>
                              <div className="mt-1 text-caption text-muted-foreground">{t(($) => $.wiki.meta, { chapters: displayChapters.length, sections: activeSections.length })}</div>
                            </div>
                            <div className="flex items-center gap-2">
                              {selectedAdopted ? (
                                <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={t(($) => $.wiki.readingMode)}>
                                  <button type="button" role="tab" aria-selected={!readingAnnotationsVisible} className={cn("rounded-sm px-3 py-1.5 text-caption", !readingAnnotationsVisible ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => setShowAnnotations(false)}>{t(($) => $.wiki.readingTab)}</button>
                                  <button type="button" role="tab" aria-selected={readingAnnotationsVisible} className={cn("rounded-sm px-3 py-1.5 text-caption", readingAnnotationsVisible ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => { setShowAnnotations(true); setAnnotationDrawerOpen(true); }}>{t(($) => $.wiki.annotationsTab, { count: readingAnnotationCount })}</button>
                                </div>
                              ) : null}
                              {currentPendingItems.length ? <Button type="button" size="sm" onClick={() => setReviewDialog({ initialOutcome: "changes", candidateMode: mode === "compare" && !!revision })}>{t(($) => $.annotations.finishReview)}</Button> : null}
                            </div>
                          </div>
                        </header>
                      ) : null}

                      {(reviewRequested || mode === "compare") && revision ? (
                        <div className="mt-4 flex flex-wrap items-start justify-between gap-3 border-b pb-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2"><p className="text-body font-medium">{revision.changeSummary || t(($) => $.recent.noSummary)}</p><Badge variant="outline">{t(($) => $.status[revision.status] ?? $.status.unknown)}</Badge></div>
                            <div className="mt-1 flex flex-wrap gap-x-2 text-caption text-muted-foreground">
                              <span>{getActorName(revision.createdByType, revision.createdById)}</span>
                              <time dateTime={revision.createdAt}>{formatRelativeDate(revision.createdAt)}</time>
                              {revision.sourceIssueId ? <AppLink className="underline underline-offset-2" href={paths.workspace(props.workspaceSlug).issueDetail(revision.sourceIssueId)}>{sourceIssue?.identifier ?? t(($) => $.baseline.sourceIssue)}</AppLink> : null}
                            </div>
                            {!props.currentCandidate ? <p className="mt-2 text-caption text-muted-foreground">{t(($) => $.baseline.readOnlyRevision)}</p> : null}
                          </div>
                          {mode === "compare" ? (
                            <div className="flex items-center gap-2">
                              <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={t(($) => $.annotations.compareViewLabel)}>
                                <button type="button" role="tab" aria-selected={compareView === "render"} className={cn("rounded-sm px-3 py-1 text-caption", compareView === "render" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => setCompareView("render")}>{t(($) => $.annotations.renderedView)}</button>
                                <button type="button" role="tab" aria-selected={compareView === "source"} className={cn("rounded-sm px-3 py-1 text-caption", compareView === "source" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => setCompareView("source")}>{t(($) => $.annotations.sourceDiff)}</button>
                              </div>
                              {compareView === "render" && changedSections.length ? (
                                <div className="flex items-center gap-1 text-caption">
                                  <Button variant="outline" size="icon-sm" aria-label={t(($) => $.baseline.previousChange)} onClick={() => jumpChange(changeCursor - 1)}><ChevronUp aria-hidden="true" /></Button>
                                  <span className="min-w-10 text-center tabular-nums" data-change-cursor>{changeCursor + 1}/{changedSections.length}</span>
                                  <Button variant="outline" size="icon-sm" aria-label={t(($) => $.baseline.nextChange)} onClick={() => jumpChange(changeCursor + 1)}><ChevronDown aria-hidden="true" /></Button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {!reviewRequested && selectedPendingCandidate ? (
                        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2" data-chapter-pending>
                          <span className="min-w-0 flex-1 text-caption">{t(($) => $.wiki.pendingNotice, { count: 1, source: nodes.find((node) => node.id === selectedPendingCandidate.sourceIssueId)?.identifier ?? selectedPendingCandidate.sourceIssueId ?? t(($) => $.baseline.sourceIssue), changes: selectedPendingCandidate.anchorsDiff.added.length + selectedPendingCandidate.anchorsDiff.modified.length + selectedPendingCandidate.anchorsDiff.removed.length })}</span>
                          <Button type="button" size="sm" variant="outline" onClick={() => props.onReviewCandidate(selectedPendingCandidate.id, { chapter: selectedChapter, readerScrollTop: readerRef.current?.scrollTop ?? 0, tocScrollTop: tocRef.current?.scrollTop ?? 0 })}>{t(($) => $.wiki.compareCandidate)}</Button>
                        </div>
                      ) : null}

                      <BaselineReadingHighlights
                        articleRef={articleRef}
                        sections={readingSections}
                        entries={readingEntries}
                        enabled={readingAnnotationsVisible}
                        hoveredId={hoveredAnnotation}
                        contentKey={`${selectedChapter}:${selectedAdopted?.id ?? ""}`}
                      />

                      {visibleChapter ? (
                        <section key={visibleChapter.chapter} id={`baseline-chapter-${visibleChapter.chapter}`} data-baseline-chapter={visibleChapter.chapter}>
                          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-b pb-2">
                            <h2 className="text-title font-semibold"><span className="mr-3 font-normal text-muted-foreground">{visibleChapterIndex + 1}</span>{chapterLabel(visibleChapter.chapter)}</h2>
                            {!editingChapter && !editingSection ? (
                              <div className="flex flex-wrap gap-2">
                                {visibleChapter.chapter.startsWith("module:") ? (
                                  <Button type="button" variant="ghost" size="sm" disabled={props.savePending} onClick={(event) => openModuleEditor(visibleChapter.chapter, event.currentTarget)}>
                                    <Pencil aria-hidden="true" />{t(($) => $.actions.editModuleTitle)}
                                  </Button>
                                ) : null}
                                <Button type="button" variant="outline" size="sm" disabled={props.savePending} onClick={() => openChapterEditor(visibleChapter.chapter)}>
                                  {t(($) => props.chapters.some((item) => item.chapter === visibleChapter.chapter && (item.adopted || item.candidate)) ? $.actions.editChapter : $.actions.initializeChapter)}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                          {selectedChapterHasCandidate && !editingChapter ? <p className="mt-2 text-caption text-muted-foreground" data-section-edit-hint>{t(($) => $.baseline.pendingCandidateSectionEdit)}</p> : null}
                          {editingChapter === visibleChapter.chapter ? (
                            <BaselineEditorForm
                              idPrefix={`baseline-chapter-${visibleChapter.chapter}`}
                              content={draftContent}
                              summary={changeSummary}
                              pending={props.savePending}
                              canDecide={props.canDecide}
                              error={saveError}
                              onContentChange={setDraftContent}
                              onSummaryChange={setChangeSummary}
                              onCancel={() => { setEditingChapter(null); setSaveError(null); }}
                              onSave={saveDraft}
                            />
                          ) : null}
                          {mode === "compare" && compareView === "source" && revision?.chapter === visibleChapter.chapter ? (
                            <BaselineSourceDiff
                              chapter={visibleChapter.chapter}
                              sections={visibleChapter.sections}
                              beforeContent={selectedAdopted?.contentMarkdown ?? ""}
                              afterContent={revision.contentMarkdown}
                              candidate={revision}
                              adopted={selectedAdopted}
                              threads={annotationThreads}
                              pendingItems={currentPendingItems}
                              canDecide={props.canDecide && props.currentCandidate}
                              limitReached={annotationDrafts.limitReached}
                              onAddAnnotation={annotationDrafts.addAnnotation}
                              onUpdatePending={annotationDrafts.update}
                              onDeletePending={annotationDrafts.remove}
                              onResolve={resolveAnnotation}
                              onAddReply={(thread, note) => annotationDrafts.addReply(thread.root, note)}
                            />
                          ) : visibleChapter.sections.length ? visibleChapter.sections.map((section, sectionIndex) => (
                            <article
                              key={section.key}
                              id={sectionDomId(section.key)}
                              data-baseline-section-key={section.key}
                              data-baseline-section-title={section.title}
                              data-change={section.change !== "same" ? "" : undefined}
                              data-diff-kind={section.change !== "same" ? section.change : undefined}
                              className={cn("group/section mt-5 border-l-2 py-1 pl-4", section.change === "same" ? "border-transparent" : section.change === "added" ? "border-success bg-success/5" : section.change === "modified" ? "border-accent bg-accent/30" : "border-destructive bg-destructive/5")}
                              onMouseUp={(event) => {
                                if (event.target instanceof Element && event.target.closest("button, input, textarea, [data-reading-annotations]")) return;
                                captureReadingSelection(event.currentTarget, section);
                              }}
                              onKeyUp={(event) => {
                                if (event.shiftKey && event.key.startsWith("Arrow")) captureReadingSelection(event.currentTarget, section);
                              }}
                            >
                              <h3 className="flex flex-wrap items-center gap-2 text-title-sm font-medium">
                                <span className="font-mono text-caption font-normal text-muted-foreground">{section.change === "removed" ? "—" : `${visibleChapterIndex + 1}.${sectionIndex + 1}`}</span>
                                <span className={section.change === "removed" ? "line-through opacity-70" : undefined}>{section.title || t(($) => $.wiki.untitled)}</span>
                                {section.change !== "same" ? <Badge variant={section.change === "removed" ? "destructive" : "secondary"}>{t(($) => section.change === "added" ? $.baseline.added : section.change === "removed" ? $.baseline.removed : $.baseline.modified)}</Badge> : null}
                                {sectionEditTargets.has(section.key) && section.change !== "removed" && !editingChapter && !editingSection ? (
                                  <Button type="button" variant="ghost" size="xs" disabled={props.savePending} onClick={() => {
                                    const target = sectionEditTargets.get(section.key);
                                    if (target) openSectionEditor(target);
                                  }}><Pencil aria-hidden="true" />{t(($) => $.actions.editSection)}</Button>
                                ) : null}
                                {props.canDecide && readingAnnotationsVisible && selectedAdopted && !editingChapter && !editingSection ? (
                                  <BaselineAnnotateSectionButton onClick={() => {
                                    setReadingSelection(null);
                                    setAnnotationDrawerOpen(true);
                                    setReadingComposer({
                                      sectionKey: section.key,
                                      anchor: {
                                        anchorKind: "section",
                                        targetRevisionId: selectedAdopted.id,
                                        sectionAnchor: section.anchor,
                                        sectionTitle: section.title,
                                        targetLabel: t(($) => $.baseline.baseMode, { number: selectedAdopted.revisionNumber }),
                                      },
                                    });
                                  }} />
                                ) : null}
                              </h3>
                              {editingSection?.key === section.key ? (
                                <BaselineEditorForm
                                  idPrefix={`baseline-section-${encodeURIComponent(section.key)}`}
                                  content={draftContent}
                                  summary={changeSummary}
                                  pending={props.savePending}
                                  canDecide={props.canDecide}
                                  error={saveError}
                                  section
                                  onContentChange={setDraftContent}
                                  onSummaryChange={setChangeSummary}
                                  onCancel={() => { setEditingSection(null); setSaveError(null); }}
                                  onSave={saveDraft}
                                />
                              ) : (
                                <>
                                  {section.change === "modified" && section.beforeBody ? (
                                    <div className="mt-3 space-y-3">
                                      <div className="rounded-md bg-destructive/5 px-3 py-1 text-muted-foreground line-through decoration-destructive/60" data-diff-before>
                                        <BaselineMarkdown content={section.beforeBody} currentSection={section} />
                                      </div>
                                      <div className="rounded-md bg-success/5 px-3 py-1" data-diff-after>
                                        <BaselineMarkdown content={section.body} currentSection={section} />
                                      </div>
                                    </div>
                                  ) : (
                                    <div className={cn(section.change === "removed" && "line-through opacity-70")}>
                                      <BaselineMarkdown content={section.body} currentSection={section} />
                                    </div>
                                  )}
                                  {section.change === "removed" ? <p className="text-caption text-muted-foreground">{t(($) => $.baseline.removedSection)}</p> : null}
                                  {lens === "understand" && (section.why || section.example) && section.change !== "removed" ? (
                                    <details className="mt-2" data-section-why>
                                      <summary className="cursor-pointer text-caption text-muted-foreground hover:text-foreground">{t(($) => $.wiki.whyLabel)}</summary>
                                      {section.why ? <p className="mt-1 whitespace-pre-wrap text-body text-muted-foreground">{plainBaselineText(section.why)}</p> : null}
                                      {section.example ? <p className="mt-1 whitespace-pre-wrap text-body text-muted-foreground"><span className="mr-2 font-medium text-foreground">{t(($) => $.wiki.exampleShort)}</span>{plainBaselineText(section.example)}</p> : null}
                                    </details>
                                  ) : null}
                                  <SectionRelations section={section} relations={relations.get(section.key)} lens={lens} onConcept={onConcept} />
                                </>
                              )}
                            </article>
                          )) : <p className="mt-4 text-body text-muted-foreground">{t(($) => $.wiki.emptyChapter)}</p>}
                          {readingAnnotationsVisible ? (
                            <BaselineStandaloneThreads
                              title={t(($) => $.annotations.outdatedThreads)}
                              threads={annotationThreads.filter((thread) => !visibleChapter.sections.some((section) => section.anchor === thread.root.sectionAnchor))}
                              baseRevisionId={selectedAdopted?.id ?? null}
                              candidate={selectedCandidate ?? selectedAdopted}
                              canDecide={props.canDecide}
                              limitReached={annotationDrafts.limitReached}
                              onAddReply={(thread, note) => annotationDrafts.addReply(thread.root, note)}
                              onUpdatePending={annotationDrafts.update}
                              onDeletePending={annotationDrafts.remove}
                              onResolve={resolveAnnotation}
                            />
                          ) : null}
                        </section>
                      ) : null}

                      {!reviewRequested ? (
                        <>
                          <div className="mt-8 grid grid-cols-2 gap-3">
                            <Button type="button" variant="outline" disabled={!previousChapter} onClick={() => previousChapter && onChapterChange(previousChapter.chapter)} className="justify-start">
                              <ArrowLeft aria-hidden="true" /><span className="min-w-0 truncate">{t(($) => $.wiki.previousChapter)}{previousChapter ? `: ${chapterLabel(previousChapter.chapter)}` : ""}</span>
                            </Button>
                            <Button type="button" variant="outline" disabled={!nextChapter} onClick={() => nextChapter && onChapterChange(nextChapter.chapter)} className="justify-end">
                              <span className="min-w-0 truncate">{t(($) => $.wiki.nextChapter)}{nextChapter ? `: ${chapterLabel(nextChapter.chapter)}` : ""}</span><ArrowLeft className="rotate-180" aria-hidden="true" />
                            </Button>
                          </div>
                          <section id="baseline-history" className="mt-8 border-t pt-5" data-baseline-history>
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <h2 className="flex items-center gap-2 text-title-sm font-medium"><FileClock className="size-4" aria-hidden="true" />{t(($) => $.history.title)}</h2>
                              <div className="flex flex-wrap gap-1" role="tablist" aria-label={t(($) => $.baseline.chaptersLabel)}>
                                {displayChapters.map(({ chapter }) => <Button key={chapter} type="button" role="tab" aria-selected={selectedChapter === chapter} size="sm" variant={selectedChapter === chapter ? "brand" : "ghost"} onClick={() => onChapterChange(chapter)}>{chapterLabel(chapter)}</Button>)}
                              </div>
                            </div>
                            <div className="mt-3"><BaselineHistoryList history={props.history} loading={props.historyLoading} error={props.historyError} onMore={props.onHistoryMore} /></div>
                          </section>
                        </>
                      ) : null}
                    </div>
                  </div>
                </section>

                {showReadingRail && !reviewRequested ? (
                  <div
                    className={cn(
                      "min-h-0",
                      annotationDrawerOpen ? "absolute inset-0 z-30" : "hidden",
                      "@min-[960px]:relative @min-[960px]:inset-auto @min-[960px]:z-auto @min-[960px]:block",
                    )}
                    data-annotation-drawer={annotationDrawerOpen ? "" : undefined}
                  >
                    {annotationDrawerOpen ? <button type="button" className="absolute inset-0 bg-black/35 @min-[960px]:hidden" aria-label={t(($) => $.actions.close)} onClick={() => setAnnotationDrawerOpen(false)} /> : null}
                    <div className={cn(
                      "flex h-full min-h-0 flex-col border-l bg-background",
                      annotationDrawerOpen && "absolute inset-y-0 right-0 w-[300px] max-w-[86%] shadow-xl",
                      "@min-[960px]:relative @min-[960px]:inset-auto @min-[960px]:w-auto @min-[960px]:max-w-none @min-[960px]:shadow-none",
                    )}>
                      <div className={cn("h-11 shrink-0 items-center justify-between border-b px-3", annotationDrawerOpen ? "flex" : "hidden", "@min-[960px]:hidden")}>
                        <span className="text-caption font-medium">{t(($) => $.annotations.annotationRail)}</span>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(($) => $.actions.close)} onClick={() => setAnnotationDrawerOpen(false)}><X aria-hidden="true" /></Button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-y-auto p-3">{readingRail}</div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {readingSelection && readingAnnotationsVisible ? (
              <CommentSelectionBubble range={readingSelection.range} source={readingSelection.root} owner={`baseline-${props.projectId}`}>
                <div className="bubble-menu" data-baseline-selection-action>
                  <Button type="button" variant="ghost" size="sm" onMouseDown={(event) => event.preventDefault()} onClick={() => {
                    setReadingComposer({ sectionKey: readingSelection.sectionKey, anchor: readingSelection.anchor });
                    setAnnotationDrawerOpen(true);
                    setReadingSelection(null);
                    window.getSelection()?.removeAllRanges();
                  }}><MessageSquarePlus aria-hidden="true" />{t(($) => $.annotations.annotate)}</Button>
                </div>
              </CommentSelectionBubble>
            ) : null}

            {moduleEditor ? (
              <BaselineModuleDialog
                key={moduleEditor.chapter ?? "new"}
                chapter={moduleEditor.chapter}
                chapters={props.chapters}
                canDecide={props.canDecide}
                pending={props.savePending}
                onClose={closeModuleEditor}
                onSave={saveModule}
              />
            ) : null}

            {reviewDialog ? (
              <BaselineReviewDialog
                key={`${reviewDialog.candidateMode}-${revision?.id ?? selectedAdopted?.id ?? selectedChapter}`}
                workspaceSlug={props.workspaceSlug}
                chapter={selectedChapter}
                remainingCount={props.pendingCandidates.length}
                candidateMode={reviewDialog.candidateMode}
                candidate={reviewDialog.candidateMode ? revision : null}
                sourceIssueIdentifier={sourceIssue?.identifier}
                chapterCandidate={selectedCandidate}
                adopted={selectedAdopted}
                batches={props.annotations.batches}
                details={props.annotations.details}
                pendingItems={dialogPendingItems}
                initialOutcome={reviewDialog.initialOutcome}
                actions={props.annotations.actions}
                onDecision={props.onDecision}
                onClearPending={annotationDrafts.clear}
                onReviewCandidate={() => { changeReviewMode("compare"); setCompareView("source"); }}
                onClose={() => setReviewDialog(null)}
              />
            ) : null}
            {batchDialogOpen && activeBatch ? (
              <BaselineBatchDialog
                batch={activeBatch}
                workspaceSlug={props.workspaceSlug}
                canDecide={props.canDecide}
                onCloseBatch={props.annotations.actions.onCloseBatch}
                onClose={() => setBatchDialogOpen(false)}
              />
            ) : null}

            {back ? (
              <div className="absolute bottom-5 left-5 z-40 flex items-center rounded-md bg-foreground text-background shadow-lg" data-back-to-section>
                <button type="button" className="flex items-center gap-2 px-3 py-2 text-caption" onClick={() => {
                  const target = back;
                  setBack(null);
                  if (target.chapter !== selectedChapter) {
                    pendingPositionRef.current = target;
                    onChapterChange(target.chapter);
                  } else {
                    readerRef.current?.scrollTo({ top: target.readerScrollTop, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
                    tocRef.current?.scrollTo({ top: target.tocScrollTop, behavior: "instant" });
                  }
                }}><ArrowLeft className="size-3.5" aria-hidden="true" />{t(($) => $.wiki.backTo, { title: back.label })}</button>
                <button type="button" className="border-l border-background/30 px-2 py-2" aria-label={t(($) => $.actions.close)} onClick={() => setBack(null)}><X className="size-3.5" aria-hidden="true" /></button>
              </div>
            ) : null}
          </div>
        </BaselineWikiProvider>
  );
}
