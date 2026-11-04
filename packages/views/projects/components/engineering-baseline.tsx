"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, History as FileClock, LoaderCircle, Pencil, Plus, Search, X, XCircle } from "@multica/ui/icons";
import { Alert, AlertDescription, AlertTitle } from "@multica/ui/components/ui/alert";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import type { BaselineChapter, BaselineDecision, BaselineHistory, BaselineRevision, ChapterState, IssueGraphNode, OpenIssue } from "@multica/core/api";
import { paths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { CollectionPageState } from "../../layout/collection-page";
import { AppLink, useNavigation } from "../../navigation";
import { useStatusLabel } from "../../issues/utils/status-label";
import { useEngineeringChapterLabel, useFormatRelativeDate } from "./labels";
import {
  baselineModuleSlug,
  isBaselineModuleSlug,
  latestBaselineSectionRevision,
  mergeBaselineSections,
  orderedBaselineChapters,
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

type DecisionAction = "adopt" | "reject";
type ReviewMode = "base" | "compare";
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
  decisionResult: BaselineDecision | null;
  onDecision: (action: DecisionAction, revision: BaselineRevision) => void;
  savePending: boolean;
  onSave: (draft: BaselineSaveDraft, adopt: boolean) => Promise<BaselineSaveResult>;
  history: BaselineHistory | null | undefined;
  historyLoading: boolean;
  historyError: boolean;
  onHistoryMore: () => void;
  chapterRevisions: Partial<Record<BaselineChapter, readonly BaselineRevision[]>>;
  roadmap: EngineeringRoadmap;
  reviewRequested: boolean;
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

function scrollToKey(key: string) {
  const element = document.getElementById(sectionDomId(key));
  element?.scrollIntoView?.({ behavior: "smooth", block: "start" });
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
  const { t } = useT("engineering");
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
    if (incomplete || pending) return;
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
                if (!slugCustomized) setSlug(baselineModuleSlug(value));
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
                <Button type="button" disabled={pending || incomplete} aria-busy={pending} onClick={() => void save(true)}>{pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.actions.saveAndAdopt)}</Button>
              </>
            ) : <Button type="submit" disabled={pending || incomplete} aria-busy={pending}>{pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.actions.submitRevisionCandidate)}</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OpenIssueGroup({ title, issues, workspaceId }: { title: string; issues: readonly OpenIssue[]; workspaceId: string }) {
  const statusLabel = useStatusLabel(workspaceId);
  return (
    <div>
      <h4 className="mb-1 text-caption font-medium">{title}</h4>
      {issues.length ? <ul className="space-y-1 text-caption">{issues.map((issue) => <li key={issue.id} className="flex gap-2"><span className="text-muted-foreground">{issue.identifier}</span><span className="min-w-0 flex-1">{issue.title}</span><span className="text-muted-foreground">{statusLabel(issue.status)}</span></li>)}</ul> : <span className="text-caption text-muted-foreground">—</span>}
    </div>
  );
}

function DecisionOpenIssues({ result, workspaceId }: { result: BaselineDecision; workspaceId: string }) {
  const { t } = useT("engineering");
  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-success/5 p-3" data-open-issues>
      <div className="flex items-center gap-2 text-caption font-medium text-success"><CheckCircle2 className="size-4" aria-hidden="true" />{t(($) => $.baseline.openIssuesTitle)}</div>
      <OpenIssueGroup title={t(($) => $.baseline.inFlight)} issues={result.openIssues.inFlight} workspaceId={workspaceId} />
      <OpenIssueGroup title={t(($) => $.baseline.queued)} issues={result.openIssues.queued} workspaceId={workspaceId} />
      {result.openIssues.truncated ? <div className="text-caption text-muted-foreground">{t(($) => $.baseline.openIssuesTruncated)}</div> : null}
    </div>
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
  const { t } = useT("engineering");
  const navigation = useNavigation();
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const articleRef = useRef<HTMLDivElement>(null);
  const readKey = `multica.engineering-baseline.read.${props.projectId}`;
  const lens = props.lens;
  const [mode, setMode] = useState<ReviewMode>(props.reviewRequested ? "compare" : "base");
  const [editingChapter, setEditingChapter] = useState<BaselineChapter | null>(null);
  const [editingSection, setEditingSection] = useState<{ chapter: BaselineChapter; key: string; query: string } | null>(null);
  const [moduleEditor, setModuleEditor] = useState<{ chapter: BaselineChapter | null } | null>(null);
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
  const [back, setBack] = useState<{ key: string; label: string; y: number } | null>(null);
  const [changeCursor, setChangeCursor] = useState(0);
  const revision = props.revision;

  useEffect(() => {
    if (props.reviewRequested && revision) setMode("compare");
    else if (!revision) setMode("base");
  }, [props.reviewRequested, revision]);
  useEffect(() => setBack(null), [lens]);
  useEffect(() => setSaveError(null), [props.selectedChapter]);

  const openChapterEditor = (chapter: BaselineChapter) => {
    const state = props.chapters.find((item) => item.chapter === chapter);
    props.onChapterChange(chapter);
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
        sections: mergeBaselineSections(chapter, adopted, chapterRevision, mode === "compare" && !!chapterRevision),
      };
    });
  }, [props.chapters, revision, mode]);
  const activeSections = useMemo(() => displayChapters.flatMap((chapter) => chapter.sections).filter((section) => section.change !== "removed"), [displayChapters]);
  const changedSections = useMemo(() => displayChapters.flatMap((chapter) => chapter.sections).filter((section) => section.change !== "same"), [displayChapters]);
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
    }, { rootMargin: "0px 0px -35% 0px", threshold: 0.1 });
    articleRef.current.querySelectorAll("[data-baseline-section-key]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [displayChapters, lens, markRead]);

  const onConcept = useCallback((section: BaselineSection, recordBack = true) => {
    if (recordBack && articleRef.current) {
      const source = [...articleRef.current.querySelectorAll<HTMLElement>("[data-baseline-section-key]")]
        .filter((element) => element.getBoundingClientRect().top < 180)
        .at(-1);
      if (source && source.dataset.baselineSectionKey !== section.key) {
        setBack({ key: source.dataset.baselineSectionKey!, label: source.dataset.baselineSectionTitle ?? "", y: window.scrollY });
      }
    }
    scrollToKey(section.key);
    if (lens === "understand") markRead(section.key);
  }, [lens, markRead]);
  const { workspaceSlug, onOpenStage } = props;
  const onNavigate = useCallback((reference: BaselineReference) => {
    if (reference.kind === "concept") onConcept(reference.section);
    else if (reference.kind === "issue") navigation.push(paths.workspace(workspaceSlug).issueDetail(reference.node.id));
    else onOpenStage(reference.stage.stage);
  }, [onConcept, navigation, workspaceSlug, onOpenStage]);

  const jumpChange = useCallback((index: number) => {
    if (!changedSections.length) return;
    const next = (index + changedSections.length) % changedSections.length;
    setChangeCursor(next);
    scrollToKey(changedSections[next]!.key);
  }, [changedSections]);
  useEffect(() => {
    setChangeCursor(0);
    if (mode !== "compare" || !changedSections.length) return;
    const timeout = window.setTimeout(() => scrollToKey(changedSections[0]!.key), 0);
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
  const changeCount = revision ? revision.anchorsDiff.added.length + revision.anchorsDiff.modified.length + revision.anchorsDiff.removed.length : 0;
  const globalChapters = displayChapters.filter((chapter) => !chapter.chapter.startsWith("module:"));
  const moduleChapters = displayChapters.filter((chapter) => chapter.chapter.startsWith("module:"));
  const renderChapterNavigation = (chapter: BaselineDisplayChapter) => (
    <div key={chapter.chapter} className="mb-3">
      <button type="button" className="block w-full py-1 text-left text-caption font-medium hover:underline" onClick={() => {
        props.onChapterChange(chapter.chapter);
        document.getElementById(`baseline-chapter-${chapter.chapter}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      }}>{chapterLabel(chapter.chapter)}</button>
      {chapter.sections.map((section) => (
        <button key={section.key} type="button" className={cn("flex w-full items-center gap-1 border-l py-1 pl-2 text-left text-caption", readIds.includes(section.key) && lens === "understand" ? "border-foreground text-foreground" : "text-muted-foreground hover:text-foreground")} onClick={() => onConcept(section, false)}>
          <span className={cn("min-w-0 flex-1", section.change === "removed" && "line-through")}>{section.title || t(($) => $.wiki.untitled)}</span>
          {section.change !== "same" ? <span className="size-1.5 rounded-full bg-destructive" aria-label={t(($) => section.change === "added" ? $.baseline.added : section.change === "removed" ? $.baseline.removed : $.baseline.modified)} /> : null}
          {readIds.includes(section.key) && lens === "understand" ? <CheckCircle2 className="size-3 text-success" aria-label={t(($) => $.wiki.read)} /> : null}
        </button>
      ))}
    </div>
  );

  return (
    <BaselineWikiProvider value={{
      lens,
      workspaceId: props.workspaceId,
      chapters: props.chapters,
      sections: activeSections,
      nodes,
      stages: props.roadmap.stages,
      relations,
      referenceCounts,
      onNavigate,
    }}>
      <div className="mt-5" data-engineering-region="baseline">
        <header>
          <div className="text-caption text-muted-foreground">{t(($) => $.views.baseline)}</div>
          <h1 className="mt-1 text-title-lg font-semibold">{props.projectTitle} · {t(($) => $.baseline.title)}</h1>
          <div className="mt-1 text-caption text-muted-foreground">{t(($) => $.wiki.meta, { chapters: displayChapters.length, sections: activeSections.length })}</div>
        </header>

        {props.candidateLoading ? <Skeleton className="mt-5 h-24 w-full" /> : null}
        {!props.candidateLoading && props.candidateNotFound ? <div className="mt-5"><CollectionPageState icon={XCircle} tone="warning" title={t(($) => $.baseline.candidateMissing)} description={t(($) => $.baseline.candidateMissingDescription)} /></div> : null}
        {!props.candidateLoading && props.decisionError ? <Alert className="mt-5" variant="destructive"><AlertTriangle /><AlertTitle>{t(($) => $.errors.decisionTitle)}</AlertTitle><AlertDescription>{t(($) => $.errors.decision)}</AlertDescription></Alert> : null}
        {!props.candidateLoading && revision ? (
          <section className="sticky top-0 z-20 mt-5 border-y bg-background py-3" aria-label={t(($) => $.baseline.reviewLabel)} data-baseline-revision-status={revision.status}>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <div className="min-w-60 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="font-medium">{t(($) => $.baseline.revisionWaiting, { number: revision.revisionNumber })}</h2>
                  <span className="text-caption text-muted-foreground">{getActorName(revision.createdByType, revision.createdById)} · <time dateTime={revision.createdAt}>{formatRelativeDate(revision.createdAt)}</time> · {t(($) => $.baseline.changeCount, { count: changeCount })}</span>
                  <Badge variant={revision.status === "candidate" ? "default" : "secondary"}>{t(($) => $.status[revision.status] ?? $.status.unknown)}</Badge>
                </div>
                <p className="mt-1 text-body text-muted-foreground">{revision.changeSummary || t(($) => $.recent.noSummary)}</p>
                {revision.sourceIssueId ? <AppLink className="mt-1 inline-block text-caption underline underline-offset-2" href={paths.workspace(props.workspaceSlug).issueDetail(revision.sourceIssueId)}>{sourceIssue?.identifier ?? t(($) => $.baseline.sourceIssue)}</AppLink> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={t(($) => $.baseline.reviewModeLabel)}>
                  <button type="button" role="tab" aria-selected={mode === "base"} className={cn("rounded-sm px-3 py-1 text-caption", mode === "base" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => setMode("base")}>{t(($) => $.baseline.baseMode, { number: adoptedRevision?.revisionNumber ?? 0 })}</button>
                  <button type="button" role="tab" aria-selected={mode === "compare"} className={cn("rounded-sm px-3 py-1 text-caption", mode === "compare" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => setMode("compare")}>{t(($) => $.baseline.compareMode, { number: revision.revisionNumber })}</button>
                </div>
                {mode === "compare" && changedSections.length ? (
                  <div className="flex items-center gap-1 text-caption">
                    <Button variant="outline" size="icon-sm" aria-label={t(($) => $.baseline.previousChange)} onClick={() => jumpChange(changeCursor - 1)}><ChevronUp aria-hidden="true" /></Button>
                    <span className="min-w-10 text-center tabular-nums" data-change-cursor>{changeCursor + 1}/{changedSections.length}</span>
                    <Button variant="outline" size="icon-sm" aria-label={t(($) => $.baseline.nextChange)} onClick={() => jumpChange(changeCursor + 1)}><ChevronDown aria-hidden="true" /></Button>
                  </div>
                ) : null}
                {props.currentCandidate && props.canDecide ? (
                  <>
                    <Button variant="outline" size="sm" disabled={props.decisionPending} onClick={() => props.onDecision("reject", revision)}>{t(($) => $.actions.reject)}</Button>
                    <Button size="sm" disabled={props.decisionPending} aria-busy={props.decisionPending} onClick={() => props.onDecision("adopt", revision)}>{props.decisionPending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.actions.adopt)}</Button>
                  </>
                ) : null}
              </div>
            </div>
            {!props.currentCandidate ? <div className="mt-2 text-caption text-muted-foreground">{t(($) => $.baseline.readOnlyRevision)}</div> : null}
            {mode === "compare" && !changedSections.length ? <div className="mt-2 text-caption text-muted-foreground">{t(($) => $.baseline.noChanges)}</div> : null}
            {props.decisionResult ? <DecisionOpenIssues result={props.decisionResult} workspaceId={props.workspaceId} /> : null}
          </section>
        ) : null}

        <div className="mt-7 grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)] xl:gap-12">
          <aside className="top-24 max-h-none overflow-y-auto lg:sticky lg:max-h-[calc(100vh-7rem)]" aria-label={t(($) => $.wiki.tocLabel)}>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(($) => $.wiki.searchPlaceholder)} aria-label={t(($) => $.wiki.searchPlaceholder)} className="pl-8" />
            </label>
            {query.trim() ? (
              <div className="mt-3" data-search-results>
                <div className="mb-2 text-caption text-muted-foreground">{t(($) => $.wiki.searchCount, { count: searchResults.length })}</div>
                {searchResults.length ? searchResults.map(({ section, snippet }) => (
                  <button key={section.key} type="button" className="block w-full border-b py-2 text-left" onClick={() => onConcept(section, false)}>
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
                    {nextUnread ? <button type="button" className="mt-1 text-left text-caption font-medium hover:underline" onClick={() => onConcept(nextUnread, false)}>{readCount ? t(($) => $.wiki.continueReading) : t(($) => $.wiki.startReading)}: {nextUnread.title || t(($) => $.wiki.untitled)} →</button> : <div className="mt-1 text-caption text-success">{t(($) => $.wiki.allRead)}</div>}
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
                    <Button type="button" variant="ghost" size="sm" className="w-full justify-start px-0" disabled={props.savePending || !!editingChapter || !!editingSection} onClick={() => setModuleEditor({ chapter: null })}>
                      <Plus aria-hidden="true" />{t(($) => $.actions.addModule)}
                    </Button>
                  </section>
                  <button type="button" className="block w-full py-1 text-left text-caption font-medium hover:underline" onClick={() => document.getElementById("baseline-history")?.scrollIntoView?.({ behavior: "smooth", block: "start" })}>{t(($) => $.history.title)}</button>
                </nav>
              </div>
            )}
          </aside>

          <div ref={articleRef} className="min-w-0 max-w-3xl">
            {displayChapters.map((chapter, chapterIndex) => (
              <section key={chapter.chapter} id={`baseline-chapter-${chapter.chapter}`} className="mb-10 scroll-mt-28" data-baseline-chapter={chapter.chapter}>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-2">
                  <h2 className="text-title font-semibold"><span className="mr-3 font-normal text-muted-foreground">{chapterIndex + 1}</span>{chapterLabel(chapter.chapter)}</h2>
                  {props.selectedChapter === chapter.chapter && !editingChapter && !editingSection ? (
                    <div className="flex flex-wrap gap-2">
                      {chapter.chapter.startsWith("module:") ? (
                        <Button type="button" variant="ghost" size="sm" disabled={props.savePending} onClick={() => setModuleEditor({ chapter: chapter.chapter })}>
                          <Pencil aria-hidden="true" />{t(($) => $.actions.editModuleTitle)}
                        </Button>
                      ) : null}
                      <Button type="button" variant="outline" size="sm" disabled={props.savePending} onClick={() => openChapterEditor(chapter.chapter)}>
                        {t(($) => props.chapters.some((item) => item.chapter === chapter.chapter && (item.adopted || item.candidate)) ? $.actions.editChapter : $.actions.initializeChapter)}
                      </Button>
                    </div>
                  ) : null}
                </div>
                {editingChapter === chapter.chapter ? (
                  <BaselineEditorForm
                    idPrefix={`baseline-chapter-${chapter.chapter}`}
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
                {chapter.sections.length ? chapter.sections.map((section, sectionIndex) => (
                  <article
                    key={section.key}
                    id={sectionDomId(section.key)}
                    data-baseline-section-key={section.key}
                    data-baseline-section-title={section.title}
                    data-change={section.change !== "same" ? "" : undefined}
                    data-diff-kind={section.change !== "same" ? section.change : undefined}
                    className={cn("mt-5 scroll-mt-32 border-l-2 py-1 pl-4", section.change === "same" ? "border-transparent" : section.change === "added" ? "border-success bg-success/5" : section.change === "modified" ? "border-accent bg-accent/30" : "border-destructive bg-destructive/5")}
                  >
                    <h3 className="flex flex-wrap items-center gap-2 text-title-sm font-medium">
                      <span className="font-mono text-caption font-normal text-muted-foreground">{section.change === "removed" ? "—" : `${chapterIndex + 1}.${sectionIndex + 1}`}</span>
                      <span className={section.change === "removed" ? "line-through opacity-70" : undefined}>{section.title || t(($) => $.wiki.untitled)}</span>
                      {section.change !== "same" ? <Badge variant={section.change === "removed" ? "destructive" : "secondary"}>{t(($) => section.change === "added" ? $.baseline.added : section.change === "removed" ? $.baseline.removed : $.baseline.modified)}</Badge> : null}
                      {props.selectedChapter === chapter.chapter && section.level > 0 && section.change !== "removed" && !editingChapter && !editingSection ? (
                        <Button type="button" variant="ghost" size="xs" disabled={props.savePending} onClick={() => openSectionEditor(section)}><Pencil aria-hidden="true" />{t(($) => $.actions.editSection)}</Button>
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
              </section>
            ))}

            <section id="baseline-history" className="scroll-mt-28 border-t pt-5" data-baseline-history>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-title-sm font-medium"><FileClock className="size-4" aria-hidden="true" />{t(($) => $.history.title)}</h2>
                <div className="flex flex-wrap gap-1" role="tablist" aria-label={t(($) => $.baseline.chaptersLabel)}>
                  {displayChapters.map(({ chapter }) => <Button key={chapter} type="button" role="tab" aria-selected={props.selectedChapter === chapter} size="sm" variant={props.selectedChapter === chapter ? "brand" : "ghost"} onClick={() => props.onChapterChange(chapter)}>{chapterLabel(chapter)}</Button>)}
                </div>
              </div>
              <div className="mt-3"><BaselineHistoryList history={props.history} loading={props.historyLoading} error={props.historyError} onMore={props.onHistoryMore} /></div>
            </section>
          </div>
        </div>

        {moduleEditor ? (
          <BaselineModuleDialog
            key={moduleEditor.chapter ?? "new"}
            chapter={moduleEditor.chapter}
            chapters={props.chapters}
            canDecide={props.canDecide}
            pending={props.savePending}
            onClose={() => setModuleEditor(null)}
            onSave={saveModule}
          />
        ) : null}

        {back ? (
          <div className="fixed bottom-5 left-5 z-30 flex items-center rounded-md bg-foreground text-background shadow-lg" data-back-to-section>
            <button type="button" className="flex items-center gap-2 px-3 py-2 text-caption" onClick={() => {
              const target = back;
              setBack(null);
              scrollToKey(target.key);
              window.scrollTo?.({ top: target.y, behavior: "smooth" });
            }}><ArrowLeft className="size-3.5" aria-hidden="true" />{t(($) => $.wiki.backTo, { title: back.label })}</button>
            <button type="button" className="border-l border-background/30 px-2 py-2" aria-label={t(($) => $.actions.close)} onClick={() => setBack(null)}><X className="size-3.5" aria-hidden="true" /></button>
          </div>
        ) : null}
      </div>
    </BaselineWikiProvider>
  );
}
