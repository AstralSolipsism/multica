"use client";

// Engineering overview (OL-1329 §8). Two tabs: 总览 | 基线 Wiki. The overview
// keeps stage progress, the 待拍板决策卡, skills and settings, and replaces
// the retired approval queue with a baseline-wiki summary card plus a recent
// wiki activity feed (rows deep-link into the wiki page). The wiki tab mounts
// the three-column EngineeringBaselineWiki.

import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { AlertCircle, FileText, LoaderCircle, Settings2 } from "@multica/ui/icons";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@multica/ui/components/ui/alert";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { errorCode, type EngineeringStage as EngineeringStageConfig, type WikiActivityItem } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useDagGraph } from "@multica/core/issues/dag/use-dag-data";
import { issueTimelineOptions } from "@multica/core/issues/queries";
import { paths } from "@multica/core/paths";
import { projectDetailOptions, projectEngineeringDecisionIssuesOptions, projectEngineeringOptions, projectWikiActivityOptions, projectWikiTreeOptions } from "@multica/core/projects/queries";
import { useUpdateProjectEngineering } from "@multica/core/projects/mutations";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import { useActorName } from "@multica/core/workspace/hooks";
import type { Issue, IssueTableQuerySpec } from "@multica/core/types";
import { useT } from "../../i18n";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { CollectionPageState } from "../../layout/collection-page";
import { useNavigation } from "../../navigation";
import { EngineeringBaselineWiki } from "./engineering-baseline";
import { EngineeringDecisions, type EngineeringDecisionTimeline } from "./engineering-decisions";
import { useFormatRelativeDate } from "./labels";
import { EngineeringSettings } from "./engineering-settings";
import { EngineeringSkills } from "./engineering-skills";
import { EngineeringStage } from "./engineering-stage";
import { buildEngineeringRoadmap, engineeringPermissions, selectEngineeringComment, strixnovaSkillBindings, wikiActivityKindKey } from "./engineering-utils";

interface EngineeringOverviewProps {
  workspaceSlug: string;
  projectId: string;
}

type EngineeringView = "overview" | "wiki";
type ConfigUpdate = {
  enabled?: boolean;
  currentStage?: number;
  modeSummary?: string;
  deciderMemberIds?: string[];
  stages?: EngineeringStageConfig[];
};
function WikiActivityFeed({ items, workspaceSlug, projectId, onOpenWiki }: {
  items: readonly WikiActivityItem[];
  workspaceSlug: string;
  projectId: string;
  /** Switches the tab to the wiki AND navigates (?page=). */
  onOpenWiki: () => void;
}) {
  const { t } = useT("engineering");
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const navigation = useNavigation();
  if (!items.length) {
    return <p className="py-4 text-caption text-muted-foreground" data-testid="wiki-activity-empty">{t(($) => $.wiki.activityEmpty)}</p>;
  }
  return (
    <div data-testid="wiki-activity">
      {items.map((item) => (
        <button
          key={`${item.pageId}-${item.number}`}
          type="button"
          className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b py-2.5 text-left last:border-b-0 hover:bg-muted/40"
          onClick={() => {
            // State AND URL: switch to the wiki tab and deep-link the page.
            onOpenWiki();
            navigation.replace(paths.workspace(workspaceSlug).projectEngineering(projectId, { page: item.slug }));
          }}
          data-testid={item.slug}
        >
          <span className={cn("grid size-6 shrink-0 place-items-center rounded-xs text-micro", item.createdByType === "agent" ? "bg-brand/15 text-brand" : "bg-muted text-muted-foreground")}>
            {item.createdByType === "agent" ? "AI" : getActorName(item.createdByType, item.createdById).slice(0, 1)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-body">
              {getActorName(item.createdByType, item.createdById)}
              {item.createdByType === "agent" ? t(($) => $.wiki.actorAgentBadge) : ""}
              {" · "}
              {t(($) => $.wiki.activityKind[wikiActivityKindKey(item.kind)])}
              {" · "}
              <span className="font-medium">{item.title || item.slug}</span>
            </span>
            <span className="block truncate text-caption text-muted-foreground">
              {item.changeSummary || t(($) => $.wiki.activityNoSummary)}
              {item.sourceIssueId ? " · OL" : ""}
              {" · v"}{item.number} · <time dateTime={item.createdAt}>{formatRelativeDate(item.createdAt)}</time>
            </span>
          </span>
          <span className="text-caption text-muted-foreground">{t(($) => $.wiki.versionPill, { number: item.number })}</span>
        </button>
      ))}
    </div>
  );
}

export function EngineeringOverview({ workspaceSlug, projectId }: EngineeringOverviewProps) {
  const { t } = useT("engineering");
  const { t: tProjects } = useT("projects");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const userId = useAuthStore((state) => state.user?.id);
  const [activeView, setActiveView] = useState<EngineeringView>(navigation.searchParams.get("page") ? "wiki" : "overview");
  const [selectedStage, setSelectedStage] = useState(1);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [configError, setConfigError] = useState(false);

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
    if (currentStage) setSelectedStage(currentStage);
  }, [currentStage]);

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

  const wikiTreeQuery = useQuery({ ...projectWikiTreeOptions(wsId, projectId, false), enabled });
  const wikiActivityQuery = useQuery({ ...projectWikiActivityOptions(wsId, projectId, { limit: 12 }), enabled });
  const livePages = useMemo(() => (wikiTreeQuery.data?.pages ?? []).filter((page) => page.archivedAt === null), [wikiTreeQuery.data]);

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
          {(["overview", "wiki"] as const).map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-label={t(($) => $.views[view])}
              aria-selected={activeView === view}
              disabled={view === "wiki" && !enabled}
              className={cn("relative -mb-px border-b-2 px-1 text-body disabled:opacity-50", activeView === view ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
              onClick={() => setActiveView(view)}
            >
              {t(($) => $.views[view])}
            </button>
          ))}
        </div>
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
      reviewStage={permissions.isDecider && currentSummary?.status === "review" ? config.currentStage : null}
      onOpenWiki={() => setActiveView("wiki")}
      onReview={() => {
        setSelectedStage(config.currentStage);
        setReviewOpen(true);
      }}
    />
  );

  return (
    <div className={shellClass} data-engineering-shell>
      {topChrome}
      {activeView === "wiki" ? (
        <main className="min-h-0 flex-1">
          <EngineeringBaselineWiki
            workspaceSlug={workspaceSlug}
            workspaceId={wsId}
            projectId={projectId}
            projectTitle={projectQuery.data?.title ?? ""}
          />
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl p-4 mt-1 md:p-6 space-y-8">
            {configError ? <Alert variant="destructive"><AlertCircle /><AlertTitle>{t(($) => $.errors.configTitle)}</AlertTitle><AlertDescription>{t(($) => $.errors.config)}</AlertDescription></Alert> : null}
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
                onStageChange={async (changedStage) => saveConfig({ currentStage: changedStage })}
                onStagesChange={async (stages) => saveConfig({ stages })}
                onSummarySave={async (modeSummary) => saveConfig({ modeSummary })}
                waiting={waiting}
              />
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-md border p-4" data-testid="wiki-summary-card">
                <h2 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.wiki.summaryTitle)}</h2>
                <p className="mt-2 text-h3 font-semibold" data-wiki-page-count>{t(($) => $.wiki.summaryPageCount, { count: livePages.length })}</p>
                <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.wiki.summaryHint)}</p>
                <Button type="button" size="sm" className="mt-3" onClick={() => setActiveView("wiki")} data-testid="wiki-enter">
                  <FileText aria-hidden="true" />{t(($) => $.wiki.enter)}
                </Button>
              </section>
              <section className="rounded-md border p-4" data-testid="wiki-activity-card">
                <h2 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.wiki.activityTitle)}</h2>
                {wikiActivityQuery.isLoading ? <Skeleton className="mt-2 h-24 w-full" /> : wikiActivityQuery.isError ? (
                  <p className="mt-2 text-caption text-destructive">{t(($) => $.wiki.activityError)}</p>
                ) : (
                  <WikiActivityFeed items={wikiActivityQuery.data?.items ?? []} workspaceSlug={workspaceSlug} projectId={projectId} onOpenWiki={() => setActiveView("wiki")} />
                )}
              </section>
            </div>
            <EngineeringSkills bindings={skillBindings} loading={agentsQuery.isLoading} error={agentsQuery.isError} />
            {permissions.isAdmin ? <EngineeringSettings config={config} members={membersQuery.data ?? []} pending={updateEngineering.isPending} onChange={(data) => void saveConfig(data)} /> : null}
            <div className="text-caption text-muted-foreground">{t(($) => $.messages.serverAuthoritative)}</div>
          </div>
        </main>
      )}
    </div>
  );
}