"use client";

// Four-view engineering shell: Dashboard, Stages, Baseline Wiki and Activity.
// URL search parameters are the shareable navigation contract; each view owns
// its own scrolling so the Dashboard can remain a one-screen cockpit.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { AlertCircle, LoaderCircle, Settings, Settings2 } from "@multica/ui/icons";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@multica/ui/components/ui/alert";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { errorCode, type EngineeringStage as EngineeringStageConfig } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useDagGraph } from "@multica/core/issues/dag/use-dag-data";
import { issueTimelineOptions } from "@multica/core/issues/queries";
import { paths } from "@multica/core/paths";
import { projectDetailOptions, projectEngineeringDecisionIssuesOptions, projectEngineeringOptions, projectWikiActivityInfiniteOptions, projectWikiTreeOptions } from "@multica/core/projects/queries";
import { useUpdateProjectEngineering } from "@multica/core/projects/mutations";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import type { Issue, IssueTableQuerySpec } from "@multica/core/types";
import { useT } from "../../i18n";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { CollectionPageState } from "../../layout/collection-page";
import { useNavigation } from "../../navigation";
import { IssuePeekHost } from "../../issues/components/issue-peek";
import { EngineeringActivity } from "./engineering-activity";
import { EngineeringBaselineWiki } from "./engineering-baseline";
import { EngineeringBoard } from "./engineering-board";
import { EngineeringColdStart } from "./engineering-cold-start";
import type { EngineeringDecisionTimeline } from "./engineering-decisions";
import { EngineeringSettings } from "./engineering-settings";
import { EngineeringStage } from "./engineering-stage";
import type { EngineeringTaskGroup } from "./engineering-progress";
import { buildEngineeringRoadmap, engineeringDecisionKind, engineeringPermissions, engineeringViewFromSearch, selectEngineeringComment, strixnovaSkillBindings, type EngineeringView } from "./engineering-utils";

interface EngineeringOverviewProps {
  workspaceSlug: string;
  projectId: string;
}

type ConfigUpdate = {
  enabled?: boolean;
  currentStage?: number;
  modeSummary?: string;
  deciderMemberIds?: string[];
  stages?: EngineeringStageConfig[];
};
export function EngineeringOverview({ workspaceSlug, projectId }: EngineeringOverviewProps) {
  const { t } = useT("engineering");
  const { t: tProjects } = useT("projects");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const userId = useAuthStore((state) => state.user?.id);
  const requestedView = engineeringViewFromSearch(navigation.searchParams);
  const stageParam = navigation.searchParams.get("stage");
  const stageNumberParam = stageParam && /^[1-9]\d*$/.test(stageParam) ? Number(stageParam) : null;
  const requestedStage = stageParam === "unstaged" ? "unstaged" : stageNumberParam;
  const groupParam = navigation.searchParams.get("group");
  const highlightGroup = groupParam === "blocked" || groupParam === "in_review" || groupParam === "in_progress" || groupParam === "todo" || groupParam === "completed" ? groupParam : undefined;
  const [activeView, setActiveView] = useState<EngineeringView>(requestedView);
  const [selectedStage, setSelectedStage] = useState<number | "unstaged">(requestedStage ?? 1);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [coldSession, setColdSession] = useState<"active" | "skipped" | null>(null);
  const [consumedCommentIds, setConsumedCommentIds] = useState<ReadonlySet<string>>(() => new Set());
  const [configError, setConfigError] = useState(false);
  useEffect(() => setActiveView(requestedView), [requestedView]);

  const projectQuery = useQuery(projectDetailOptions(wsId, projectId));
  const overviewQuery = useQuery(projectEngineeringOptions(wsId, projectId));
  const membersQuery = useQuery(memberListOptions(wsId));
  const overview = overviewQuery.data;
  const config = overview?.engineering;
  const enabled = config?.enabled === true;
  const permissions = useMemo(
    () => config ? engineeringPermissions(userId, membersQuery.data ?? [], projectQuery.data, config) : null,
    [config, userId, membersQuery.data, projectQuery.data],
  );
  const agentsQuery = useQuery({ ...agentListOptions(wsId), enabled });
  const skillBindings = useMemo(() => strixnovaSkillBindings(agentsQuery.data ?? []), [agentsQuery.data]);

  const currentStage = config?.currentStage;
  useEffect(() => {
    if (requestedStage) setSelectedStage(requestedStage);
    else if (currentStage) setSelectedStage(currentStage);
  }, [currentStage, requestedStage]);

  const decisionIssuesQuery = useQuery({
    ...projectEngineeringDecisionIssuesOptions(wsId, projectId),
    enabled,
  });
  const blockedIssues = useMemo(() => decisionIssuesQuery.data ?? [], [decisionIssuesQuery.data]);
  const timelineQueries = useQueries({
    queries: blockedIssues.map((issue) => ({ ...issueTimelineOptions(issue.id), enabled })),
  });
  const timelines = useMemo(() => Object.fromEntries(blockedIssues.map((issue, index) => {
    const query = timelineQueries[index];
    const timeline: EngineeringDecisionTimeline = {
      comment: query?.data ? selectEngineeringComment(query.data, permissions?.deciderIds, consumedCommentIds) : null,
      loading: !!query?.isLoading,
      error: !!query?.isError,
      retry: query ? () => void query.refetch() : undefined,
    };
    return [issue.id, timeline];
  })), [blockedIssues, consumedCommentIds, timelineQueries, permissions?.deciderIds]);
  const decisionIssues = useMemo(() => {
    const deciderIds = new Set(permissions?.deciderIds);
    const priority = (issue: Issue) => {
      const kind = engineeringDecisionKind(timelines[issue.id]?.comment ?? null, permissions?.deciderIds);
      if (kind === "card") return 0;
      if (kind === "mention") return 1;
      return 2;
    };
    return blockedIssues.filter((issue) => {
      const timeline = timelines[issue.id];
      const commentId = timeline?.comment?.id;
      if (commentId && consumedCommentIds.has(commentId)) return false;
      const kind = engineeringDecisionKind(timeline?.comment ?? null, permissions?.deciderIds);
      const directlyAssigned = issue.assignee_type === "member" && issue.assignee_id !== null && deciderIds.has(issue.assignee_id);
      return timeline?.loading || timeline?.error || kind !== null || directlyAssigned;
    }).sort((a, b) => priority(a) - priority(b) || a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
  }, [blockedIssues, consumedCommentIds, permissions?.deciderIds, timelines]);
  const decisionLoading = decisionIssuesQuery.isLoading;
  const consumeDecision = useCallback((commentId: string) => {
    setConsumedCommentIds((current) => new Set(current).add(commentId));
  }, []);

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

  const wikiTreeQuery = useQuery({ ...projectWikiTreeOptions(wsId, projectId, false), enabled });
  const allWikiPages = useMemo(() => wikiTreeQuery.data?.pages ?? [], [wikiTreeQuery.data]);
  const wikiActivityQuery = useInfiniteQuery({ ...projectWikiActivityInfiniteOptions(wsId, projectId, 50), enabled });
  const activityItems = useMemo(() => {
    const seen = new Set<string>();
    return (wikiActivityQuery.data?.pages ?? []).flatMap((page) => (page?.items ?? []).filter((item) => {
      const key = `${item.pageId}:${item.number}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
  }, [wikiActivityQuery.data]);
  const livePages = useMemo(() => allWikiPages.filter((page) => page.archivedAt === null), [allWikiPages]);
  const hasStages = !!config && (config.stages.length > 0 || projectNodes.some((node) => node.stage !== null));
  useEffect(() => {
    if (coldSession !== null || !enabled || !config || hasStages || graphQuery.isError || wikiTreeQuery.isError) return;
    if (!graphQuery.isLoading && wikiTreeQuery.data && livePages.length === 0) setColdSession("active");
  }, [coldSession, config, enabled, graphQuery.isError, graphQuery.isLoading, hasStages, livePages.length, wikiTreeQuery.data, wikiTreeQuery.isError]);
  const coldActive = coldSession === "active";
  const coldResolving = coldSession === null && enabled && !!config && !hasStages && !graphQuery.isLoading && !graphQuery.isError && !wikiTreeQuery.data && !wikiTreeQuery.isError;

  const updateEngineering = useUpdateProjectEngineering();
  const saveConfig = async (data: ConfigUpdate): Promise<boolean> => {
    setConfigError(false);
    try {
      const result = await updateEngineering.mutateAsync({ projectId, ...data });
      if (!result) throw new Error("Invalid engineering response");
      toast.success(t(($) => $.messages.configSaved));
      return true;
    } catch (cause) {
      if (errorCode(cause) === "engineering_not_decider") toast.error(t(($) => $.errors.notDecider));
      setConfigError(true);
      return false;
    }
  };

  const openView = (view: EngineeringView) => {
    setActiveView(view);
    navigation.push(paths.workspace(workspaceSlug).projectEngineering(projectId, { tab: view }));
  };
  const openStages = (stage: number | "unstaged", group?: EngineeringTaskGroup) => {
    setActiveView("stages");
    setSelectedStage(stage);
    navigation.push(paths.workspace(workspaceSlug).projectEngineering(projectId, { tab: "stages", stage, group }));
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
  const skillsMissing = agentsQuery.isSuccess && skillBindings.length === 0;
  const settingsTooltip = skillsMissing ? `${t(($) => $.settings.title)} · ${t(($) => $.skills.missingShort)}` : t(($) => $.settings.title);
  const topChrome = (
    <div className="shrink-0 bg-canvas" data-engineering-top-chrome>
      {header}
      {enabled ? <nav className="flex h-10 shrink-0 items-center justify-between gap-5 border-b px-4 md:px-6">
        <div className="flex h-full gap-5" role="tablist" aria-label={t(($) => $.views.label)}>
          {(["board", "stages", "wiki", "activity"] as const).map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-label={t(($) => $.views[view])}
              aria-selected={activeView === view}
              className={cn("relative -mb-px flex items-center gap-1.5 border-b px-1 text-label", activeView === view ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
              onClick={() => openView(view)}
            >
              {t(($) => $.views[view])}
              {view === "board" && decisionIssues.length ? <span className="size-1.5 rounded-full bg-destructive" aria-hidden="true" /> : null}
              {view === "stages" ? <span className="text-micro text-muted-foreground tabular-nums">{config?.stages.length ?? 0}</span> : null}
              {view === "wiki" ? <span className="text-micro text-muted-foreground tabular-nums" data-wiki-tab-count>{livePages.length}</span> : null}
            </button>
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="relative shrink-0" aria-label={settingsTooltip} onClick={() => setSettingsOpen(true)}><Settings aria-hidden="true" />{skillsMissing ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-warning" data-skill-warning /> : null}</Button>} />
          <TooltipContent side="bottom">{settingsTooltip}</TooltipContent>
        </Tooltip>
      </nav> : null}
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

  return (
    <IssuePeekHost>
      <div className={shellClass} data-engineering-shell>
        {topChrome}
        {configError ? <Alert variant="destructive" className="m-3 shrink-0"><AlertCircle /><AlertTitle>{t(($) => $.errors.configTitle)}</AlertTitle><AlertDescription>{t(($) => $.errors.config)}</AlertDescription></Alert> : null}
        {activeView === "board" && wikiTreeQuery.isError ? <Alert variant="destructive" className="m-3 flex items-center justify-between gap-3"><AlertCircle /><AlertDescription className="flex-1">{t(($) => $.wiki.treeLoadError)}</AlertDescription><Button type="button" variant="outline" size="sm" onClick={() => void wikiTreeQuery.refetch()}>{t(($) => $.actions.retry)}</Button></Alert> : null}
        {activeView === "wiki" ? (
          <main className="min-h-0 flex-1">
            <EngineeringBaselineWiki workspaceSlug={workspaceSlug} workspaceId={wsId} projectId={projectId} />
          </main>
        ) : activeView === "activity" ? (
          <EngineeringActivity workspaceSlug={workspaceSlug} workspaceId={wsId} projectId={projectId} items={activityItems} pages={allWikiPages} loading={wikiActivityQuery.isLoading} error={wikiActivityQuery.isError && activityItems.length === 0} loadMoreError={wikiActivityQuery.isFetchNextPageError} onRetry={() => void wikiActivityQuery.refetch()} hasMore={!!wikiActivityQuery.hasNextPage} loadingMore={wikiActivityQuery.isFetchingNextPage} onLoadMore={() => void wikiActivityQuery.fetchNextPage()} />
        ) : activeView === "board" && coldResolving ? (
          <main className="min-h-0 flex-1 p-6"><Skeleton className="h-72 w-full" /></main>
        ) : activeView === "board" && coldActive ? (
          <EngineeringColdStart projectId={projectId} saving={updateEngineering.isPending} onSaveStrategy={(data) => saveConfig(data)} onOpenSettings={() => setSettingsOpen(true)} onSkip={() => setColdSession("skipped")} />
        ) : graphQuery.isLoading ? (
          <main className="min-h-0 flex-1 space-y-4 p-6"><Skeleton className="h-12 w-full" /><Skeleton className="h-full w-full" /></main>
        ) : graphQuery.isError ? (
          <main className="flex min-h-0 flex-1 items-center justify-center"><Alert variant="destructive" className="max-w-lg"><AlertCircle /><AlertTitle>{t(($) => $.errors.title)}</AlertTitle><AlertDescription>{t(($) => $.errors.graph)}</AlertDescription><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void graphQuery.refetch()}>{t(($) => $.actions.retry)}</Button></Alert></main>
        ) : activeView === "board" ? (
          <EngineeringBoard
            workspaceSlug={workspaceSlug}
            workspaceId={wsId}
            projectId={projectId}
            roadmap={roadmap}
            currentStage={config.currentStage}
            modeSummary={config.modeSummary}
            canDecide={permissions.isDecider}
            saving={updateEngineering.isPending}
            onSummarySave={async (modeSummary) => saveConfig({ modeSummary })}
            issues={decisionIssues}
            timelines={timelines}
            reviewStage={permissions.isDecider && currentSummary?.status === "review" ? config.currentStage : null}
            decisionLoading={decisionLoading}
            decisionError={decisionIssuesQuery.isError}
            onRetryDecisions={() => void decisionIssuesQuery.refetch()}
            onDecisionSubmitted={consumeDecision}
            wikiPageCount={livePages.length}
            latestActivity={activityItems[0] ?? null}
            activityLoading={wikiActivityQuery.isLoading}
            onReview={() => { openStages(config.currentStage); setReviewOpen(true); }}
            onOpenStages={openStages}
            onOpenWiki={() => openView("wiki")}
            onOpenActivity={() => openView("activity")}
          />
        ) : (
          <EngineeringStage
            workspaceSlug={workspaceSlug}
            workspaceId={wsId}
            roadmap={roadmap}
            configuredStages={config.stages}
            currentStage={config.currentStage}
            selectedStage={selectedStage}
            highlightGroup={highlightGroup}
            canDecide={permissions.isDecider}
            pending={updateEngineering.isPending}
            reviewOpen={reviewOpen}
            onReviewOpenChange={setReviewOpen}
            onSelectStage={openStages}
            onStageChange={async (changedStage) => {
              const saved = await saveConfig({ currentStage: changedStage });
              if (saved) openStages(changedStage);
              return saved;
            }}
            onStagesChange={async (stages) => saveConfig({ stages })}
          />
        )}
        <EngineeringSettings
          config={config}
          members={membersQuery.data ?? []}
          pending={updateEngineering.isPending}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          skillBindings={skillBindings}
          skillsLoading={agentsQuery.isLoading}
          skillsError={agentsQuery.isError}
          onSkillsRetry={() => void agentsQuery.refetch()}
          canEdit={permissions.isAdmin}
          onChange={(data) => void saveConfig(data)}
        />
      </div>
    </IssuePeekHost>
  );
}