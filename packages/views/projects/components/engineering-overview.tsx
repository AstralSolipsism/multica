"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { AlertCircle, LoaderCircle, Settings2, X } from "@multica/ui/icons";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@multica/ui/components/ui/alert";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { api, errorCode, type BaselineChapter, type BaselineRevision, type EngineeringStage as EngineeringStageConfig, type SubmitProjectBaselineReviewInput } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useDagGraph } from "@multica/core/issues/dag/use-dag-data";
import { issueTimelineOptions } from "@multica/core/issues/queries";
import { paths } from "@multica/core/paths";
import { projectBaselineAnnotationBatchOptions, projectBaselineAnnotationBatchesOptions, projectBaselineHistoryOptions, projectDetailOptions, projectEngineeringDecisionIssuesOptions, projectEngineeringOptions, projectKeys } from "@multica/core/projects/queries";
import { useAdoptProjectBaseline, useCloseProjectBaselineAnnotationBatch, useProposeProjectBaseline, useRejectProjectBaseline, useResolveProjectBaselineAnnotations, useSubmitProjectBaselineReview, useUpdateProjectEngineering } from "@multica/core/projects/mutations";
import { engineeringCandidateOptions } from "@multica/core/projects/engineering-candidate";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import type { Issue, IssueTableQuerySpec } from "@multica/core/types";
import { useT } from "../../i18n";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { CollectionPageState } from "../../layout/collection-page";
import { useNavigation } from "../../navigation";
import { EngineeringBaseline, type BaselineSaveDraft, type BaselineSaveResult, type BaselineWikiPosition, type BaselineWikiRestorePosition } from "./engineering-baseline";
import type { BaselineLens } from "./engineering-baseline-markdown";
import { orderedBaselineChapters } from "./engineering-baseline-utils";
import { EngineeringDecisions, type EngineeringDecisionTimeline } from "./engineering-decisions";
import { BaselineProcessedRecords, type BaselineProcessedRecord } from "./engineering-baseline-processed";
import { useEngineeringChapterLabel } from "./labels";
import { EngineeringSettings } from "./engineering-settings";
import { EngineeringSkills } from "./engineering-skills";
import { EngineeringStage } from "./engineering-stage";
import { buildEngineeringRoadmap, engineeringPermissions, selectEngineeringComment, strixnovaSkillBindings } from "./engineering-utils";

interface EngineeringOverviewProps {
  workspaceSlug: string;
  projectId: string;
}

type EngineeringView = "overview" | "baseline";
type ConfigUpdate = {
  enabled?: boolean;
  currentStage?: number;
  modeSummary?: string;
  deciderMemberIds?: string[];
  stages?: EngineeringStageConfig[];
};

type FailedReview =
  | { kind: "decision"; action: "adopt" | "reject"; target: BaselineRevision; annotationBatchAction?: "close" | "keep" }
  | { kind: "changes"; input: SubmitProjectBaselineReviewInput; target: BaselineRevision };

interface ReviewSummary {
  adopted: number;
  rejected: number;
  changes: number;
}

const emptyReviewSummary: ReviewSummary = { adopted: 0, rejected: 0, changes: 0 };

function reviewErrorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : errorCode(cause) ?? "Unknown review error";
}

export function EngineeringOverview({ workspaceSlug, projectId }: EngineeringOverviewProps) {
  const { t } = useT("engineering");
  const { t: tProjects } = useT("projects");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const userId = useAuthStore((state) => state.user?.id);
  const candidateId = navigation.searchParams.get("candidate") ?? "";
  const [activeView, setActiveView] = useState<EngineeringView>(candidateId ? "baseline" : "overview");
  const [manualCandidateId, setManualCandidateId] = useState("");
  const [selectedChapter, setSelectedChapter] = useState<BaselineChapter>("overview");
  const [selectedStage, setSelectedStage] = useState(1);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sessionRecords, setSessionRecords] = useState<readonly BaselineProcessedRecord[]>([]);
  const [reviewBatchIds, setReviewBatchIds] = useState<readonly string[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary>(emptyReviewSummary);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<{ id: number; action: "adopted" | "rejected" | "changes"; chapter: BaselineChapter; remaining: number } | null>(null);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [selectedRecordKey, setSelectedRecordKey] = useState<string | null>(null);
  const [reviewEntry, setReviewEntry] = useState<BaselineWikiPosition | null>(null);
  const [restorePosition, setRestorePosition] = useState<BaselineWikiRestorePosition | null>(null);
  const [failedReview, setFailedReview] = useState<FailedReview | null>(null);
  const [decisionErrorMessage, setDecisionErrorMessage] = useState("");
  const baselineLensKey = `multica.engineering-baseline.lens.${projectId}`;
  const [baselineLensPreference, setBaselineLensPreference] = useState<BaselineLens | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const value = window.localStorage.getItem(baselineLensKey);
      return value === "manage" || value === "understand" ? value : null;
    } catch { return null; }
  });
  const projectQuery = useQuery(projectDetailOptions(wsId, projectId));
  const overviewQuery = useQuery(projectEngineeringOptions(wsId, projectId));
  const membersQuery = useQuery(memberListOptions(wsId));
  const overview = overviewQuery.data;
  const chapterLabel = useEngineeringChapterLabel(overview?.chapters ?? []);
  useEffect(() => {
    if (!reviewNotice) return;
    const timeout = window.setTimeout(() => setReviewNotice(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [reviewNotice]);
  const config = overview?.engineering;
  const enabled = config?.enabled === true;
  const permissions = useMemo(
    () => config ? engineeringPermissions(userId, membersQuery.data ?? [], projectQuery.data, config) : null,
    [config, userId, membersQuery.data, projectQuery.data],
  );
  const agentsQuery = useQuery({ ...agentListOptions(wsId), enabled });
  const skillBindings = useMemo(() => strixnovaSkillBindings(agentsQuery.data ?? []), [agentsQuery.data]);

  useEffect(() => {
    if (candidateId) {
      setActiveView("baseline");
      setManualCandidateId("");
    }
  }, [candidateId]);
  const currentStage = config?.currentStage;
  useEffect(() => {
    if (currentStage) setSelectedStage(currentStage);
  }, [currentStage]);

  const candidateQuery = useQuery({
    ...engineeringCandidateOptions(wsId, projectId, candidateId),
    enabled: enabled && !!candidateId,
  });
  useEffect(() => {
    if (candidateQuery.data) setSelectedChapter(candidateQuery.data.chapter);
  }, [candidateQuery.data]);

  const decisionQueries = useQueries({
    queries: (permissions?.deciderIds ?? []).map((deciderId) => ({
      ...projectEngineeringDecisionIssuesOptions(wsId, projectId, deciderId),
      enabled,
    })),
  });
  const decisionIssues = useMemo(() => {
    const byId = new Map<string, Issue>();
    for (const query of decisionQueries) for (const issue of query.data ?? []) byId.set(issue.id, issue);
    return [...byId.values()].sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
  }, [decisionQueries]);
  const timelineQueries = useQueries({
    queries: decisionIssues.map((issue) => ({ ...issueTimelineOptions(issue.id), enabled })),
  });
  const timelines = useMemo(() => Object.fromEntries(decisionIssues.map((issue, index) => {
    const query = timelineQueries[index];
    const timeline: EngineeringDecisionTimeline = {
      comment: query?.data ? selectEngineeringComment(query.data, permissions?.deciderIds) : null,
      loading: !!query?.isLoading,
      error: !!query?.isError,
    };
    return [issue.id, timeline];
  })), [decisionIssues, timelineQueries, permissions?.deciderIds]);

  const graphSpec = useMemo<IssueTableQuerySpec>(() => ({
    scope: { kind: "project", project_id: projectId },
    filters: {},
    sort: { field: "position", direction: "asc" },
  }), [projectId]);
  const graphQuery = useDagGraph(wsId, graphSpec, enabled);
  const projectNodes = useMemo(() => graphQuery.data?.nodes.filter((node) => node.projectId === projectId) ?? [], [graphQuery.data, projectId]);
  const roadmap = useMemo(
    () => buildEngineeringRoadmap(projectNodes, config?.stages ?? [], config?.currentStage ?? 1),
    [projectNodes, config?.stages, config?.currentStage],
  );
  const allCandidates = useMemo(() => (overview?.chapters ?? []).flatMap((chapter) => chapter.candidate ? [chapter.candidate] : []), [overview?.chapters]);

  const chapterState = overview?.chapters.find((chapter) => chapter.chapter === selectedChapter);
  const [conflictRevision, setConflictRevision] = useState<BaselineRevision | null>(null);
  const [localRevision, setLocalRevision] = useState<BaselineRevision | null>(null);
  const savedRevisionRef = useRef<BaselineRevision | null>(null);
  const deepLinkChapter = candidateQuery.data?.chapter ?? "overview";
  const showDeepLinkedRevision = !manualCandidateId && !!candidateId && selectedChapter === deepLinkChapter;
  const manualRevision = manualCandidateId
    ? overview?.chapters.map((chapter) => chapter.candidate).find((candidate) => candidate?.id === manualCandidateId) ?? null
    : null;
  const queriedRevision: BaselineRevision | null = manualCandidateId
    ? manualRevision
    : showDeepLinkedRevision ? candidateQuery.data?.revision ?? null : chapterState?.candidate ?? null;
  const revision = conflictRevision ?? localRevision ?? queriedRevision;
  const [decisionError, setDecisionError] = useState(false);
  useEffect(() => {
    const saved = savedRevisionRef.current;
    const selectedRevisionId = manualCandidateId || candidateId;
    if (saved?.chapter === selectedChapter && (!selectedRevisionId || saved.id === selectedRevisionId)) return;
    savedRevisionRef.current = null;
    setDecisionError(false);
    setDecisionErrorMessage("");
    setFailedReview(null);
    setConflictRevision(null);
    setLocalRevision(null);
  }, [candidateId, manualCandidateId, selectedChapter]);

  const historyQuery = useInfiniteQuery({
    queryKey: [...projectKeys.engineeringHistoryAll(wsId, projectId), selectedChapter, "infinite"] as const,
    queryFn: ({ pageParam }) => api.getProjectBaselineHistory(wsId, projectId, selectedChapter, { limit: 50, before: pageParam, withContent: false }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage?.hasMore ? lastPage.nextBefore : undefined,
    enabled: enabled && activeView === "baseline",
  });
  const history = useMemo(() => {
    if (!historyQuery.data) return historyQuery.data;
    const pages = historyQuery.data.pages.filter((page) => page !== null);
    const last = pages.at(-1);
    return { revisions: pages.flatMap((page) => page.revisions), hasMore: last?.hasMore ?? false, nextBefore: last?.nextBefore ?? null };
  }, [historyQuery.data]);
  const baselineChapters = useMemo(() => orderedBaselineChapters(overview?.chapters ?? []), [overview?.chapters]);
  const recentQueries = useQueries({
    queries: baselineChapters.map((chapter) => ({
      ...projectBaselineHistoryOptions(wsId, projectId, chapter, { limit: 50, withContent: false }),
      enabled,
    })),
  });
  const chapterRevisions = useMemo<Partial<Record<BaselineChapter, readonly BaselineRevision[]>>>(() => Object.fromEntries(
    baselineChapters.map((chapter, index) => [chapter, recentQueries[index]?.data?.revisions ?? []]),
  ), [baselineChapters, recentQueries]);
  const annotationBatchesQuery = useQuery({
    ...projectBaselineAnnotationBatchesOptions(wsId, projectId, { state: "all" }),
    enabled,
  });
  const annotationBatches = useMemo(() => annotationBatchesQuery.data?.batches ?? [], [annotationBatchesQuery.data]);
  const annotationDetailQueries = useQueries({
    queries: annotationBatches.map((batch) => ({
      ...projectBaselineAnnotationBatchOptions(wsId, projectId, batch.id, { state: "all", withSections: false }),
      enabled,
    })),
  });
  const annotationDetails = useMemo(() => annotationDetailQueries.flatMap((query) => query.data ? [query.data] : []), [annotationDetailQueries]);
  const annotationsLoading = annotationBatchesQuery.isLoading || annotationDetailQueries.some((query) => query.isLoading);
  const annotationsError = annotationBatchesQuery.isError || annotationBatchesQuery.data === null || annotationDetailQueries.some((query) => query.isError || query.data === null);
  const reviewedCandidateIds = useMemo(() => new Set(annotationDetails.flatMap((detail) => detail.reviews.map((review) => review.reviewedRevisionId))), [annotationDetails]);
  const pendingCandidates = useMemo(() => allCandidates.filter((candidate) =>
    !reviewedCandidateIds.has(candidate.id) && !sessionRecords.some((record) => record.revision.id === candidate.id)
  ), [allCandidates, reviewedCandidateIds, sessionRecords]);
  const currentCandidate = !conflictRevision && revision?.status === "candidate" && chapterState?.candidate?.id === revision.id
    && !reviewedCandidateIds.has(revision.id) && !sessionRecords.some((record) => record.revision.id === revision.id)
    && (manualCandidateId ? true : !showDeepLinkedRevision || candidateQuery.data?.current === true);
  const sourceLabels = useMemo<Record<string, string>>(() => Object.fromEntries([
    ...roadmap.stages.flatMap((stage) => stage.tasks),
    ...roadmap.outside,
  ].map((node) => [node.id, node.identifier])), [roadmap]);
  const processedRecords = useMemo<readonly BaselineProcessedRecord[]>(() => {
    const records = new Map<string, BaselineProcessedRecord>();
    const revisions = new Map<string, BaselineRevision>();
    for (const candidate of allCandidates) revisions.set(candidate.id, candidate);
    for (const state of overview?.chapters ?? []) {
      if (state.adopted) revisions.set(state.adopted.id, state.adopted);
    }
    for (const history of Object.values(chapterRevisions)) {
      for (const item of history ?? []) revisions.set(item.id, item);
    }
    const add = (revision: BaselineRevision, decision: BaselineProcessedRecord["decision"], decidedAt: string, summary?: string) => {
      const key = `${revision.id}:${decision}`;
      records.set(key, {
        key,
        revision,
        decision,
        decidedAt,
        ...(summary ? { summary } : {}),
        ...(revision.sourceIssueId ? { sourceLabel: sourceLabels[revision.sourceIssueId] } : {}),
      });
    };
    for (const revision of revisions.values()) {
      if (revision.status === "adopted" || revision.status === "rejected") {
        add(revision, revision.status, revision.decidedAt ?? revision.createdAt);
      }
    }
    for (const detail of annotationDetails) {
      for (const review of detail.reviews) {
        const reviewed = revisions.get(review.reviewedRevisionId);
        const existing = records.get(`${review.reviewedRevisionId}:changes`);
        if (reviewed && (!existing || existing.decidedAt < review.createdAt)) add(reviewed, "changes", review.createdAt, review.summary);
      }
    }
    for (const record of sessionRecords) records.set(`${record.revision.id}:${record.decision}`, record);
    return [...records.values()].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  }, [allCandidates, overview?.chapters, chapterRevisions, annotationDetails, sessionRecords, sourceLabels]);
  const selectedRecord = selectedRecordKey ? processedRecords.find((record) => record.key === selectedRecordKey) ?? null : null;
  const recordDetailQuery = useQuery({
    ...projectBaselineHistoryOptions(wsId, projectId, selectedRecord?.revision.chapter ?? selectedChapter, { limit: 50, withContent: true }),
    enabled: enabled && recordsOpen && !!selectedRecord,
  });
  const detailRevision = selectedRecord
    ? selectedRecord.revision.contentMarkdown
      ? selectedRecord.revision
      : recordDetailQuery.data?.revisions.find((item) => item.id === selectedRecord.revision.id) ?? null
    : null;
  const detailBaseRevision = selectedRecord
    ? recordDetailQuery.data?.revisions.find((item) => item.id === selectedRecord.revision.baseRevisionId)
      ?? (overview?.chapters.find((chapter) => chapter.chapter === selectedRecord.revision.chapter)?.adopted?.id === selectedRecord.revision.baseRevisionId
        ? overview.chapters.find((chapter) => chapter.chapter === selectedRecord.revision.chapter)?.adopted ?? null
        : null)
    : null;
  const recordsLoading = recentQueries.some((query) => query.isLoading) || annotationsLoading;
  const recordsError = recentQueries.some((query) => query.isError) || annotationsError;
  const processedRevisionIds = useMemo(() => new Set(processedRecords.map((record) => record.revision.id)), [processedRecords]);

  const updateEngineering = useUpdateProjectEngineering();
  const proposeBaseline = useProposeProjectBaseline();
  const adoptBaseline = useAdoptProjectBaseline();
  const rejectBaseline = useRejectProjectBaseline();
  const submitBaselineReview = useSubmitProjectBaselineReview();
  const resolveBaselineAnnotations = useResolveProjectBaselineAnnotations();
  const closeBaselineAnnotationBatch = useCloseProjectBaselineAnnotationBatch();
  const [configError, setConfigError] = useState(false);
  const saveConfig = async (data: ConfigUpdate): Promise<boolean> => {
    setConfigError(false);
    try {
      const result = await updateEngineering.mutateAsync({ projectId, ...data });
      if (!result) throw new Error("Invalid engineering response");
      toast.success(t(($) => $.messages.configSaved));
      return true;
    } catch {
      setConfigError(true);
      return false;
    }
  };
  const recordDecision = (target: BaselineRevision, action: BaselineProcessedRecord["decision"], summary?: string) => {
    const decidedAt = new Date().toISOString();
    const key = `${target.id}:${action}`;
    setSessionRecords((current) => [
      ...current.filter((record) => record.key !== key),
      {
        key,
        revision: target,
        decision: action,
        decidedAt,
        ...(summary?.trim() ? { summary: summary.trim() } : {}),
        ...(target.sourceIssueId ? { sourceLabel: sourceLabels[target.sourceIssueId] } : {}),
      },
    ]);
    setReviewSummary((current) => ({ ...current, [action]: current[action] + 1 }));
    const remaining = pendingCandidates.filter((candidate) => candidate.id !== target.id);
    setReviewNotice({ id: Date.now(), action, chapter: target.chapter, remaining: remaining.length });
    setFailedReview(null);
    setDecisionError(false);
    setDecisionErrorMessage("");
    setLocalRevision(null);
    setConflictRevision(null);
    if (!remaining.length) {
      setManualCandidateId("");
      setActiveView("overview");
      setCompletionOpen(true);
      setRecordsOpen(false);
      setReviewEntry(null);
      setRestorePosition(null);
      clearCandidateParam();
      return;
    }
    const currentIndex = allCandidates.findIndex((candidate) => candidate.id === target.id);
    const next = remaining.find((candidate) => allCandidates.findIndex((item) => item.id === candidate.id) > currentIndex) ?? remaining[0]!;
    clearCandidateParam();
    setManualCandidateId(next.id);
    setSelectedChapter(next.chapter);
    setActiveView("baseline");
  };
  const submitReview = async (input: SubmitProjectBaselineReviewInput) => {
    const target = allCandidates.find((candidate) => candidate.id === input.reviewedRevisionId)
      ?? (revision?.id === input.reviewedRevisionId ? revision : null)
      ?? overview?.chapters.map((chapter) => chapter.adopted).find((adopted) => adopted?.id === input.reviewedRevisionId) ?? null;
    if (!target) throw new Error("The reviewed candidate is no longer available");
    setFailedReview(null);
    setDecisionError(false);
    setDecisionErrorMessage("");
    try {
      const result = await submitBaselineReview.mutateAsync({ projectId, ...input });
      if (!result) throw new Error("Invalid review response");
      if (target.status === "candidate") recordDecision(target, "changes", input.summary);
      return result;
    } catch (cause) {
      setFailedReview({ kind: "changes", input, target });
      setDecisionError(true);
      setDecisionErrorMessage(reviewErrorMessage(cause));
      throw cause;
    }
  };
  const decide = async (action: "adopt" | "reject", target: BaselineRevision, annotationBatchAction?: "close" | "keep"): Promise<boolean> => {
    setDecisionError(false);
    setDecisionErrorMessage("");
    setFailedReview(null);
    setConflictRevision(null);
    setLocalRevision(null);
    const input = {
      projectId,
      revisions: [{ revisionId: target.id, expectedAdoptedRevisionId: target.baseRevisionId }],
      ...(annotationBatchAction ? { annotationBatchAction } : {}),
    };
    try {
      const result = await (action === "adopt" ? adoptBaseline.mutateAsync(input) : rejectBaseline.mutateAsync(input));
      if (!result) throw new Error("Invalid decision response");
      recordDecision(target, action === "adopt" ? "adopted" : "rejected");
      return true;
    } catch (cause) {
      setFailedReview({ kind: "decision", action, target, ...(annotationBatchAction ? { annotationBatchAction } : {}) });
      setDecisionError(true);
      setDecisionErrorMessage(reviewErrorMessage(cause));
      return false;
    }
  };
  const retryFailedReview = async () => {
    if (!failedReview) return;
    if (failedReview.kind === "changes") await submitReview(failedReview.input);
    else await decide(failedReview.action, failedReview.target, failedReview.annotationBatchAction);
  };
  const saveBaseline = async (
    draft: BaselineSaveDraft,
    adopt: boolean,
  ): Promise<BaselineSaveResult> => {
    setDecisionError(false);
    setConflictRevision(null);
    setLocalRevision(null);
    savedRevisionRef.current = null;
    const current = overview?.chapters.find((chapter) => chapter.chapter === draft.chapter);
    let candidate: BaselineRevision;
    try {
      const proposed = await proposeBaseline.mutateAsync({
        projectId,
        ...draft,
        baseRevisionId: current?.adopted?.id ?? null,
        replacesCandidateId: current?.candidate?.id,
      });
      if (!proposed) throw new Error("Invalid baseline candidate response");
      candidate = proposed;
    } catch {
      return { revision: null, error: "save" };
    }
    savedRevisionRef.current = candidate;
    setLocalRevision(candidate);
    setSelectedChapter(draft.chapter);
    if (candidateId || manualCandidateId) setManualCandidateId(candidate.id);
    clearCandidateParam();
    if (!adopt) {
      toast.success(t(($) => $.messages.candidateSubmitted));
      return { revision: candidate };
    }
    try {
      const result = await adoptBaseline.mutateAsync({
        projectId,
        revisions: [{ revisionId: candidate.id, expectedAdoptedRevisionId: candidate.baseRevisionId }],
      });
      if (!result) throw new Error("Invalid decision response");
      const adopted = { ...candidate, status: "adopted" as const };
      savedRevisionRef.current = adopted;
      setLocalRevision(adopted);
      toast.success(t(($) => $.messages.adopted));
      return { revision: adopted };
    } catch {
      return { revision: candidate, error: "decision" };
    }
  };

  const clearCandidateParam = () => {
    if (!candidateId) return;
    const params = new URLSearchParams(navigation.searchParams);
    params.delete("candidate");
    const query = params.toString();
    navigation.replace(`${navigation.pathname}${query ? `?${query}` : ""}`);
  };
  const changeChapter = (chapter: BaselineChapter) => {
    setManualCandidateId("");
    setSelectedChapter(chapter);
  };
  const openOverview = () => {
    setManualCandidateId("");
    setActiveView("overview");
    setRecordsOpen(false);
    setSelectedRecordKey(null);
    setReviewEntry(null);
    setRestorePosition(null);
    clearCandidateParam();
  };
  const openBaseline = (id?: string) => {
    setReviewEntry(null);
    setRestorePosition(null);
    if (id) {
      const chapter = overview?.chapters.find((item) => item.candidate?.id === id);
      if (chapter) setSelectedChapter(chapter.chapter);
      setManualCandidateId(id);
      setReviewBatchIds(allCandidates.map((candidate) => candidate.id));
      setReviewSummary(emptyReviewSummary);
      setCompletionOpen(false);
      setReviewNotice(null);
    } else {
      setManualCandidateId("");
      const selectedCandidate = pendingCandidates.find((candidate) => candidate.chapter === selectedChapter);
      const firstCandidate = selectedCandidate ?? pendingCandidates[0];
      if (firstCandidate) setSelectedChapter(firstCandidate.chapter);
    }
    setRecordsOpen(false);
    setSelectedRecordKey(null);
    setActiveView("baseline");
  };
  const openWikiReview = (id: string, position: BaselineWikiPosition) => {
    openBaseline(id);
    setReviewEntry(position);
  };
  const returnFromReview = () => {
    if (!reviewEntry) {
      openOverview();
      return;
    }
    const entry = reviewEntry;
    setManualCandidateId("");
    setSelectedChapter(entry.chapter);
    setActiveView("baseline");
    setRecordsOpen(false);
    setSelectedRecordKey(null);
    setRestorePosition({ ...entry, version: Date.now() });
    setReviewEntry(null);
    clearCandidateParam();
  };
  const openProcessed = () => {
    setRecordsOpen(true);
    setSelectedRecordKey(null);
  };
  const backFromProcessed = () => {
    if (selectedRecordKey) setSelectedRecordKey(null);
    else setRecordsOpen(false);
  };
  const openOverviewStage = (stage: number) => {
    setSelectedStage(stage);
    openOverview();
  };

  const reviewRequested = !!manualCandidateId || !!candidateId;
  const baselineLens = baselineLensPreference ?? (reviewRequested ? "manage" : "understand");
  const changeBaselineLens = (value: BaselineLens) => {
    setBaselineLensPreference(value);
    try { window.localStorage.setItem(baselineLensKey, value); } catch { /* Keep the in-memory preference when storage is unavailable. */ }
  };
  const header = (
    <BreadcrumbHeader
      segments={[
        { href: paths.workspace(workspaceSlug).projects(), label: tProjects(($) => $.page.title) },
        { href: paths.workspace(workspaceSlug).projectDetail(projectId), label: projectQuery.data?.title ?? "…", className: "flex min-w-0 max-w-72 items-center truncate" },
      ]}
      leaf={<span className="truncate font-medium">{t(($) => $.title)}</span>}
    />
  );
  const topChrome = (
    <div className="shrink-0 bg-canvas" data-engineering-top-chrome>
      {header}
      <nav className="flex h-11 shrink-0 items-center gap-5 border-b px-4 md:px-6">
        <div className="flex h-full gap-5" role="tablist" aria-label={t(($) => $.views.label)}>
          {(["overview", "baseline"] as const).map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-label={t(($) => $.views[view])}
              aria-selected={activeView === view}
              disabled={view === "baseline" && !enabled}
              className={cn("relative -mb-px border-b-2 px-1 text-body disabled:opacity-50", activeView === view ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
              onClick={() => view === "overview" ? openOverview() : openBaseline()}
            >
              {t(($) => $.views[view])}
              {view === "baseline" && pendingCandidates.length ? <span className="absolute -right-2 top-2 size-1.5 rounded-full bg-destructive" aria-label={t(($) => $.views.pending)} /> : null}
            </button>
          ))}
        </div>
        {activeView === "baseline" && enabled ? (
          <div className="ml-auto inline-flex rounded-md border p-0.5" role="tablist" aria-label={t(($) => $.wiki.lensLabel)}>
            {(["understand", "manage"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={baselineLens === value}
                className={cn("rounded-sm px-3 py-1.5 text-caption", baselineLens === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
                onClick={() => changeBaselineLens(value)}
              >{t(($) => $.wiki.lens[value])}</button>
            ))}
          </div>
        ) : null}
      </nav>
    </div>
  );
  const shellClass = "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden @container";
  if (projectQuery.isLoading || overviewQuery.isLoading || membersQuery.isLoading) {
    return <div className={shellClass} data-engineering-shell>{topChrome}<main className="min-h-0 flex-1 overflow-y-auto"><div className="space-y-4 p-6"><Skeleton className="h-28 w-full" /><Skeleton className="h-72 w-full" /></div></main></div>;
  }
  if (projectQuery.isError || overviewQuery.isError || !overview || !config || !permissions) {
    return <div className={shellClass} data-engineering-shell>{topChrome}<main className="min-h-0 flex-1 overflow-y-auto"><CollectionPageState icon={AlertCircle} tone="destructive" title={t(($) => $.errors.title)} description={t(($) => $.errors.overview)} /></main></div>;
  }
  if (!enabled) {
    return (
      <div className={shellClass} data-engineering-shell>{topChrome}<main className="min-h-0 flex-1 overflow-y-auto"><CollectionPageState
        icon={Settings2}
        title={t(($) => $.disabled.title)}
        description={permissions.isAdmin ? t(($) => $.disabled.adminDescription) : t(($) => $.disabled.description)}
        actions={permissions.isAdmin ? <Button disabled={updateEngineering.isPending} onClick={() => void saveConfig({ enabled: true })}>{updateEngineering.isPending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.actions.enable)}</Button> : undefined}
      />{configError ? <div className="p-4"><Alert variant="destructive"><AlertCircle /><AlertTitle>{t(($) => $.errors.configTitle)}</AlertTitle></Alert></div> : null}</main></div>
    );
  }

  const currentSummary = roadmap.stages.find((stage) => stage.stage === config.currentStage);
  const waiting = (
    <EngineeringDecisions
      workspaceSlug={workspaceSlug}
      issues={decisionIssues}
      timelines={timelines}
      chapters={overview.chapters}
      candidates={pendingCandidates}
      processedCount={processedRecords.length}
      sourceLabels={sourceLabels}
      reviewStage={permissions.isDecider && currentSummary?.status === "review" ? config.currentStage : null}
      onOpenCandidate={openBaseline}
      onOpenProcessed={openProcessed}
      onOpenWiki={() => openBaseline()}
      onReview={() => {
        setSelectedStage(config.currentStage);
        setReviewOpen(true);
      }}
    />
  );
  const reviewEntryNumber = reviewEntry ? baselineChapters.indexOf(reviewEntry.chapter) + 1 : 0;
  const reviewReturnLabel = reviewEntry
    ? t(($) => $.reviewQueue.backChapter, { number: String(reviewEntryNumber).padStart(2, "0") })
    : t(($) => $.reviewQueue.backOverview);
  return (
    <div className={shellClass} data-engineering-shell>
      {topChrome}
      <main className={cn("min-h-0 flex-1", !recordsOpen && activeView === "overview" ? "overflow-y-auto" : "overflow-hidden")}>
        <div className={cn(recordsOpen ? "h-full" : activeView === "overview" ? "mx-auto w-full max-w-5xl p-4 md:p-6" : "h-full")}>
        {configError ? <Alert className="m-4" variant="destructive"><AlertCircle /><AlertTitle>{t(($) => $.errors.configTitle)}</AlertTitle><AlertDescription>{t(($) => $.errors.config)}</AlertDescription></Alert> : null}
        {recordsOpen ? (
          <BaselineProcessedRecords
            chapters={overview.chapters}
            records={processedRecords}
            selectedRecord={selectedRecord}
            detailRevision={detailRevision}
            baseRevision={detailBaseRevision}
            loading={recordsLoading}
            error={recordsError}
            detailLoading={!!selectedRecord && !detailRevision && recordDetailQuery.isLoading}
            detailError={!detailRevision && (recordDetailQuery.isError || recordDetailQuery.data === null)}
            onSelect={(record) => setSelectedRecordKey(record.key)}
            onBack={backFromProcessed}
            onRetry={() => {
              for (const query of recentQueries) void query.refetch();
              void annotationBatchesQuery.refetch();
              for (const query of annotationDetailQueries) void query.refetch();
              if (selectedRecord) void recordDetailQuery.refetch();
            }}
          />
        ) : activeView === "overview" ? (
          <div className="mt-5 space-y-8">
            {completionOpen ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-success/30 bg-success/5 px-4 py-3" role="status" data-review-complete>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-success">{t(($) => $.completion.title)}</div>
                  <div className="mt-1 text-caption text-muted-foreground">{t(($) => $.completion.summary, { adopted: reviewSummary.adopted, rejected: reviewSummary.rejected, changes: reviewSummary.changes })}</div>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={openProcessed}>{t(($) => $.completion.viewRecords)}</Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t(($) => $.actions.close)} onClick={() => setCompletionOpen(false)}><X aria-hidden="true" /></Button>
              </div>
            ) : null}
            {decisionQueries.some((query) => query.isError) ? <Alert variant="destructive"><AlertCircle /><AlertTitle>{t(($) => $.errors.title)}</AlertTitle><AlertDescription>{t(($) => $.errors.decisionIssues)}</AlertDescription></Alert> : null}
            {graphQuery.isLoading ? <><Skeleton className="h-32 w-full" /><Skeleton className="h-72 w-full" /></> : graphQuery.isError ? (
              <Alert variant="destructive"><AlertCircle /><AlertTitle>{t(($) => $.errors.title)}</AlertTitle><AlertDescription>{t(($) => $.errors.graph)}</AlertDescription></Alert>
            ) : (
              <EngineeringStage
                workspaceSlug={workspaceSlug}
                workspaceId={wsId}
                roadmap={roadmap}
                configuredStages={config.stages}
                currentStage={config.currentStage}
                selectedStage={selectedStage}
                modeSummary={config.modeSummary}
                canDecide={permissions.isDecider}
                pending={updateEngineering.isPending}
                reviewOpen={reviewOpen}
                onReviewOpenChange={setReviewOpen}
                onSelectStage={setSelectedStage}
                onStageChange={async (currentStage) => saveConfig({ currentStage })}
                onStagesChange={async (stages) => saveConfig({ stages })}
                onSummarySave={async (modeSummary) => saveConfig({ modeSummary })}
                waiting={waiting}
              />
            )}
            <EngineeringSkills bindings={skillBindings} loading={agentsQuery.isLoading} error={agentsQuery.isError} />
            {permissions.isAdmin ? <EngineeringSettings config={config} members={membersQuery.data ?? []} pending={updateEngineering.isPending} onChange={(data) => void saveConfig(data)} /> : null}
            <div className="text-caption text-muted-foreground">{t(($) => $.messages.serverAuthoritative)}</div>
          </div>
        ) : (
          <EngineeringBaseline
            workspaceSlug={workspaceSlug}
            workspaceId={wsId}
            projectId={projectId}
            projectTitle={projectQuery.data?.title ?? ""}
            chapters={overview.chapters}
            selectedChapter={selectedChapter}
            onChapterChange={changeChapter}
            revision={revision}
            currentCandidate={currentCandidate}
            candidateLoading={showDeepLinkedRevision && candidateQuery.isLoading}
            candidateNotFound={(showDeepLinkedRevision || !!manualCandidateId) && !candidateQuery.isLoading && !candidateQuery.isError && !revision}
            canDecide={permissions.isDecider}
            decisionPending={proposeBaseline.isPending || adoptBaseline.isPending || rejectBaseline.isPending || submitBaselineReview.isPending}
            decisionError={decisionError || (showDeepLinkedRevision && candidateQuery.isError)}
            decisionErrorMessage={decisionErrorMessage}
            onRetryDecision={failedReview ? retryFailedReview : undefined}
            onClearDecisionError={() => {
              setDecisionError(false);
              setDecisionErrorMessage("");
              setFailedReview(null);
            }}
            onDecision={decide}
            annotations={{
              batches: annotationBatches,
              details: annotationDetails,
              loading: annotationsLoading,
              error: annotationsError,
              actions: {
                ownerId: userId ?? "",
                agents: agentsQuery.data ?? [],
                onSubmitReview: submitReview,
                onResolveAnnotations: (annotationIds, resolved) => resolveBaselineAnnotations.mutateAsync({ projectId, annotationIds, resolved }),
                onCloseBatch: (batchId) => closeBaselineAnnotationBatch.mutateAsync({ projectId, batchId }),
              },
            }}
            savePending={proposeBaseline.isPending || adoptBaseline.isPending}
            onSave={saveBaseline}
            history={history}
            historyLoading={historyQuery.isLoading || historyQuery.isFetchingNextPage}
            historyError={historyQuery.isError}
            onHistoryMore={() => historyQuery.fetchNextPage()}
            chapterRevisions={chapterRevisions}
            roadmap={roadmap}
            reviewRequested={reviewRequested}
            pendingCandidates={pendingCandidates}
            batchIds={reviewBatchIds.length ? reviewBatchIds : allCandidates.map((candidate) => candidate.id)}
            processedRevisionIds={processedRevisionIds}
            processedCount={processedRecords.length}
            returnLabel={reviewReturnLabel}
            onReturnFromReview={returnFromReview}
            onSelectCandidate={(id) => {
              const candidate = pendingCandidates.find((item) => item.id === id);
              if (!candidate) return;
              setManualCandidateId(id);
              setSelectedChapter(candidate.chapter);
            }}
            onOpenProcessed={openProcessed}
            onReviewCandidate={openWikiReview}
            restorePosition={restorePosition}
            lens={baselineLens}
            onOpenStage={openOverviewStage}
          />
        )}
        </div>
      </main>
      {reviewNotice ? (
        <div className="absolute bottom-4 left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-[10px] bg-foreground px-3 py-2 text-caption text-background shadow-lg" role="status" data-review-notice>
          <span className="truncate">{t(($) => $.reviewNotice[reviewNotice.action], { chapter: chapterLabel(reviewNotice.chapter) })} · {t(($) => reviewNotice.remaining ? $.reviewNotice.remaining : $.reviewNotice.complete, { count: reviewNotice.remaining })}</span>
          <button type="button" className="shrink-0 underline underline-offset-2" onClick={openProcessed}>{t(($) => $.decisions.processed, { count: processedRecords.length })}</button>
          <button type="button" className="shrink-0 rounded-sm p-1" aria-label={t(($) => $.actions.close)} onClick={() => setReviewNotice(null)}><X className="size-3.5" aria-hidden="true" /></button>
        </div>
      ) : null}
    </div>
  );
}
