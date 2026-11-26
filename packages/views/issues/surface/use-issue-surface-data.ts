"use client";

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue, Project } from "@multica/core/types";
import { projectListOptions } from "@multica/core/projects/queries";
import { childIssueProgressOptions } from "@multica/core/issues/queries";
import { issueSurfaceGanttOptions } from "@multica/core/issues/surface/repository";
import type { IssueSurfaceQueryPlan } from "@multica/core/issues/surface/query-plan";
import type { IssueStatusCatalog } from "@multica/core/issue-statuses/queries";
import type { IssueStatus, ProjectStatus, PropertyFilterValue } from "@multica/core/types";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import {
  advancedFilterUsesField,
  statusColumnFilter,
  type AdvancedFilterGroup,
  type DueDateFilter,
} from "@multica/core/issues/stores/filter-tree";
import { useColumnWorkflow, workflowColumns } from "../utils/workflow-columns";
import { issueBehavesAsAny, statusColumnKeys, visibleStatusKeys } from "@multica/core/issues";
import type {
  IssueRelationFilter,
  NegatableFilterDimension,
} from "@multica/core/issues/stores/view-store";
import {
  applyIssueFilters,
  type IssueFilterState,
  type IssueFilters,
  type IssueRelationContext,
} from "../utils/filter";
import type { ChildProgress } from "../components/list-row";
import type {
  IssueStatusBranches,
  IssueStatusPagination,
} from "./use-issue-status-branches";
import type { IssueGroupBranches } from "./use-issue-group-branches";

/**
 * Data a filter needs besides the rows themselves: the viewer's subscriptions,
 * agents or unread list, the running-task projection, the project list, the
 * status catalog. A TanStack Query result fits as is.
 */
export interface FilterDependencySource {
  /** `undefined` until the data arrives. Data kept behind a failed refetch has
   *  arrived: the filter keeps answering from it. */
  data: unknown;
  isError: boolean;
  refetch: () => unknown;
}

export interface FilterDependencyState {
  /** Hold the loading state. */
  pending: boolean;
  /** Show a retryable error. */
  error: boolean;
  /** `pending || error`: the filter has no answer yet. Gate every fetch keyed
   *  by it and every "no results" claim on this. */
  unresolved: boolean;
  /** Re-runs each source that failed. */
  retry: () => void;
}

export const RESOLVED_FILTER_DEPENDENCY: FilterDependencyState = {
  pending: false,
  error: false,
  unresolved: false,
  retry: () => {},
};

/**
 * Whether a filter that reads `sources` can be evaluated.
 *
 * Until every source an active filter reads has data, the filter has no
 * answer: it is pending, or an error once a source has failed. It is never
 * "no filter" (unfiltered rows under an active chip) and never "matches
 * nothing" (an empty list, or a loading state that never ends).
 *
 * `active` is whether this surface applies the filter at all; a `false` entry
 * in `sources` is a source the active filter does not read, so one value of a
 * dimension does not wait on another value's data.
 *
 * Adding a filter dimension that reads extra data means declaring its sources
 * here and gating on `unresolved`, plus three controller regressions: loading
 * while a source is pending, a retryable error when it fails, and correctly
 * filtered rows after a successful retry. A source backed by a new endpoint
 * must reject on a malformed response rather than resolve to an empty list
 * (see `listSubscribedIssueIds`): an empty list is an answer, and the filter
 * would apply it.
 */
export function filterDependencyState(
  active: boolean,
  sources: readonly (FilterDependencySource | false)[],
): FilterDependencyState {
  if (!active) return RESOLVED_FILTER_DEPENDENCY;
  const unresolved = sources.filter(
    (source): source is FilterDependencySource => source !== false && source.data === undefined,
  );
  if (unresolved.length === 0) return RESOLVED_FILTER_DEPENDENCY;
  const failed = unresolved.filter((source) => source.isError);
  return {
    pending: failed.length === 0,
    error: failed.length > 0,
    unresolved: true,
    retry: () => {
      for (const source of failed) void source.refetch();
    },
  };
}

/** Several dependencies behind one loading state and one retry. A failure
 *  anywhere wins over pending elsewhere, and retry re-runs every failure. */
export function combineFilterDependencies(
  ...states: readonly FilterDependencyState[]
): FilterDependencyState {
  const failed = states.filter((state) => state.error);
  const unresolved = states.some((state) => state.unresolved);
  if (!unresolved) return RESOLVED_FILTER_DEPENDENCY;
  return {
    pending: failed.length === 0,
    error: failed.length > 0,
    unresolved: true,
    retry: () => {
      for (const state of failed) state.retry();
    },
  };
}

/** The status catalog as a filter dependency. */
export function statusCatalogSource(
  catalog: Pick<IssueStatusCatalog, "isLoaded" | "statuses" | "isError" | "retry">,
): FilterDependencySource {
  return {
    data: catalog.isLoaded ? catalog.statuses : undefined,
    isError: catalog.isError,
    refetch: catalog.retry,
  };
}

const EMPTY_ISSUES: Issue[] = [];
const EMPTY_CHILD_PROGRESS = new Map<string, ChildProgress>();
const EMPTY_PROJECTS: Project[] = [];

/**
 * The rows the gantt canvas actually draws, on top of the shared filters.
 *
 * The canvas adds two rules of its own: a row needs a date to be placed, and
 * completed work is hidden unless the user asks for it. The data source only
 * delivers scheduled issues (server-side `scheduled=true`), but a row can
 * still arrive without a date — e.g. a WS-driven optimistic patch that just
 * cleared start_date / due_date and is waiting for the cache to refetch — so
 * the date check stays defensive.
 *
 * These rules live HERE rather than privately inside GanttView so the header
 * chip can narrow the same set the canvas draws. A view that filters its own
 * rows in secret is exactly how the chip's count drifted from the list in the
 * first place (MUL-4884); duplicating the rules in both places would just
 * reintroduce the drift with extra steps.
 */
function ganttCanvasRows(issues: Issue[], showCompleted: boolean): Issue[] {
  const dated = issues.filter((i) => i.start_date || i.due_date);
  if (showCompleted) return dated;
  // By CATEGORY: a custom status in done/cancelled is completed work, and
  // "show completed" has to hide it too. (MUL-6243)
  return dated.filter((i) => !issueBehavesAsAny(i, ["done", "closed"]));
}

export interface IssueSurfaceData {
  surfaceIssues: Issue[];
  projectIssues: Issue[];
  issues: Issue[];
  swimlaneIssues: Issue[];
  /** Gantt only: the canvas rows the agents-working filter would leave on
   *  screen. `undefined` on every other view mode, where the header chip
   *  sources its count from the `working_agents` server facet instead. */
  ganttWorkingScopeIssues: Issue[] | undefined;
  filteredGanttIssues: Issue[];
  ganttIssues: Issue[];
  visibleStatuses: IssueStatus[];
  columnStatuses: IssueStatus[];
  statusPagination: IssueStatusPagination;
  activeFilters: Omit<IssueFilters, "statusFilters">;
  childProgressMap: Map<string, ChildProgress>;
  projectMap: Map<string, Project>;
  resolveTableExportLookups: (needs: {
    projects: boolean;
    childProgress: boolean;
  }) => Promise<{
    projectMap: Map<string, Project>;
    childProgressMap: Map<string, ChildProgress>;
  }>;
  isLoading: boolean;
  /** The project list behind a project-status filter this surface applies
   *  itself. */
  projectCatalogDependency: FilterDependencyState;
  /** The viewer's subscriptions / agents behind a relation filter this
   *  surface applies itself. */
  relationDependency: FilterDependencyState;
  /** The window's data is being revalidated while the previous snapshot is
   *  shown as a placeholder (sort/date change, or any grouped-board filter
   *  change). Drives the header's deferred refresh indicator — content stays
   *  put, so this is NOT a loading state. */
  isRefreshing: boolean;
  isEmpty: boolean;
}

export function useIssueSurfaceData({
  wsId,
  queryPlan,
  projectId,
  usesGantt,
  usesTable,
  usesDag,
  serverStatusBranches,
  serverGroupBranches,
  ganttShowCompleted,
  statusFilters,
  hiddenStatusKeys,
  statusDependency,
  priorityFilters,
  assigneeFilters,
  includeNoAssignee,
  agentRunningFilter,
  agentIdleFilter,
  activeIssueIDs,
  unreadFilter,
  creatorFilters,
  projectFilters,
  includeNoProject,
  projectStatusFilters,
  labelFilters,
  relationFilters,
  relationContext,
  relationSources,
  dueDateFilters,
  advancedFilter,
  today,
  negatedFilters,
  propertyFilters,
  workingIssueIDs,
  unreadIssueIDs,
  showSubIssues,
  loadProjects,
}: {
  wsId: string;
  queryPlan: IssueSurfaceQueryPlan;
  projectId?: string;
  usesGantt: boolean;
  usesTable: boolean;
  /** DAG owns its loading/empty/error states against the complete graph —
   *  the branch-based window projections below never apply to it. */
  usesDag: boolean;
  serverStatusBranches: IssueStatusBranches;
  serverGroupBranches: IssueGroupBranches;
  /** Gantt's "show completed" display toggle. The canvas hides done/cancelled
   *  rows without it, so the working scope has to honour it too. */
  ganttShowCompleted: boolean;
  statusFilters: IssueStatus[];
  hiddenStatusKeys: IssueStatus[];
  /** The status catalog the columns and a custom status filter route through. */
  statusDependency: FilterDependencyState;
  priorityFilters: IssueFilterState["priorityFilters"];
  assigneeFilters: IssueFilterState["assigneeFilters"];
  includeNoAssignee: boolean;
  agentRunningFilter: boolean;
  agentIdleFilter: boolean;
  activeIssueIDs: ReadonlySet<string> | undefined;
  unreadFilter: boolean;
  creatorFilters: IssueFilterState["creatorFilters"];
  projectFilters: string[];
  includeNoProject: boolean;
  projectStatusFilters: ProjectStatus[];
  labelFilters: string[];
  relationFilters: IssueRelationFilter[];
  relationContext: IssueRelationContext | undefined;
  /** What the active relation values read: the viewer's agents and squads
   *  for "my_agents", their subscriptions for "subscribed". */
  relationSources: readonly (FilterDependencySource | false)[];
  dueDateFilters: DueDateFilter[];
  /** The scoped, pruned rule tree. */
  advancedFilter: AdvancedFilterGroup | null;
  /** Set when due-date buckets are in play. */
  today: string | undefined;
  /** Negations that change the result (`effectiveNegatedFilters`). */
  negatedFilters: NegatableFilterDimension[];
  propertyFilters: Record<string, PropertyFilterValue[]>;
  /** Distinct running-task issue ids projected by `/api/working-agents`. */
  workingIssueIDs: ReadonlySet<string>;
  /** The viewer's unread issue ids, plus those kept on screen after reading. */
  unreadIssueIDs: ReadonlySet<string>;
  showSubIssues: boolean;
  loadProjects: boolean;
}): IssueSurfaceData {
  const ganttIssuesQuery = useQuery({
    ...issueSurfaceGanttOptions(wsId, projectId ?? "", queryPlan),
    enabled: usesGantt,
  });
  const projectsQuery = useQuery({
    ...projectListOptions(wsId),
    enabled: loadProjects,
  });
  const { data: projectData, refetch: refetchProjects } = projectsQuery;
  const projects = projectData ?? EMPTY_PROJECTS;
  const projectMap = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  // Keyed off `projectData`, NOT `projects`: the latter falls back to
  // EMPTY_PROJECTS while the query is loading or failed, which would build a
  // defined-but-empty map. `applyIssueFilters` treats a defined map as
  // authoritative, so that map would drop every issue and blank the board.
  // `undefined` is the honest answer until the catalog actually arrives, and
  // it makes the predicate a no-op.
  const projectStatusById = useMemo(
    () =>
      projectData
        ? new Map(projectData.map((project) => [project.id, project.status]))
        : undefined,
    [projectData],
  );
  // Only where this surface applies a predicate itself does it wait on that
  // predicate's data. Table and the server-status branches filter server-side.
  const usesClientPredicates = !usesTable && (usesGantt || !serverStatusBranches.enabled);
  const projectCatalogDependency = filterDependencyState(
    usesClientPredicates &&
      (projectStatusFilters.length > 0 || advancedFilterUsesField(advancedFilter, "projectStatus")),
    [projectsQuery],
  );
  const relationDependency = filterDependencyState(usesClientPredicates, relationSources);

  const workingFilterContext = useMemo(
    () => ({
      runningIssueIds: workingIssueIDs,
      activeIssueIds: activeIssueIDs,
      unreadIssueIds: unreadIssueIDs,
      projectStatusById,
      relation: relationContext,
      today,
    }),
    [activeIssueIDs, projectStatusById, relationContext, today, unreadIssueIDs, workingIssueIDs],
  );
  const bucketedIssues = serverStatusBranches.enabled
    ? serverStatusBranches.issues
    : serverGroupBranches.enabled
      ? serverGroupBranches.issues
      : EMPTY_ISSUES;

  // Status branches already reflect the visible category set chosen by the
  // controller. Cancelled is hidden for a new view, but remains a first-class
  // branch once the user restores it or selects it explicitly in a status
  // filter; no client-only exclusion happens here.
  const ganttIssues = ganttIssuesQuery.data ?? EMPTY_ISSUES;
  const surfaceIssues = usesGantt
    ? ganttIssues
    : usesTable
      ? EMPTY_ISSUES
      : bucketedIssues;

  const baseFilterState = useMemo<IssueFilterState>(
    () => ({
      statusFilters,
      priorityFilters,
      assigneeFilters,
      includeNoAssignee,
      creatorFilters,
      projectFilters,
      includeNoProject,
      projectStatusFilters,
      labelFilters,
      relationFilters,
      dueDateFilters,
      advancedFilter,
      negatedFilters,
      propertyFilters,
      workingOnly: agentRunningFilter,
      idleOnly: agentIdleFilter,
      unreadOnly: unreadFilter,
      showSubIssues,
    }),
    [
      advancedFilter,
      assigneeFilters,
      agentRunningFilter,
      agentIdleFilter,
      unreadFilter,
      creatorFilters,
      dueDateFilters,
      includeNoAssignee,
      includeNoProject,
      labelFilters,
      negatedFilters,
      priorityFilters,
      projectFilters,
      projectStatusFilters,
      propertyFilters,
      relationFilters,
      showSubIssues,
      statusFilters,
    ],
  );

  const issues = useMemo(
    () =>
      serverStatusBranches.enabled
        ? surfaceIssues
        : applyIssueFilters(
            surfaceIssues,
            baseFilterState,
            workingFilterContext,
          ),
    [
      baseFilterState,
      serverStatusBranches.enabled,
      surfaceIssues,
      workingFilterContext,
    ],
  );

  const statuslessFilterState = useMemo<IssueFilterState>(
    () => ({
      ...baseFilterState,
      statusFilters: [],
    }),
    [baseFilterState],
  );

  const swimlaneIssues = useMemo(
    () =>
      applyIssueFilters(
        surfaceIssues,
        statuslessFilterState,
        workingFilterContext,
      ),
    [statuslessFilterState, surfaceIssues, workingFilterContext],
  );

  const filteredGanttIssues = useMemo(
    () =>
      ganttCanvasRows(
        applyIssueFilters(ganttIssues, baseFilterState, workingFilterContext),
        ganttShowCompleted,
      ),
    [
      baseFilterState,
      ganttIssues,
      ganttShowCompleted,
      workingFilterContext,
    ],
  );

  const workingFilterState = useMemo<IssueFilterState>(
    () => ({
      ...baseFilterState,
      workingOnly: true,
      idleOnly: false,
    }),
    [baseFilterState],
  );

  // The Gantt canvas rows the agents-working filter would leave on screen —
  // i.e. exactly what you get when you click the header chip in Gantt.
  //
  // Gantt is the one surface whose membership is NOT server-owned: it draws
  // from a fully materialized scheduled-issue window, and its canvas
  // projection (scheduled + dated + showCompleted) cannot be expressed in the
  // Table query spec. So the header chip cannot source its count from the
  // `working_agents` server facet here, and derives it from this set instead.
  //
  // Every other view mode (list / board / swimlane / table) resolves the same
  // question through that facet, against the identical scope + filters the
  // rows come from. Rebuilding a second complete issue window client-side to
  // decorate the chip is what the server facet exists to avoid.
  const ganttWorkingScopeIssues = useMemo(() => {
    if (!usesGantt) return undefined;
    return ganttCanvasRows(
      applyIssueFilters(ganttIssues, workingFilterState, workingFilterContext),
      ganttShowCompleted,
    );
  }, [
    ganttIssues,
    ganttShowCompleted,
    usesGantt,
    workingFilterState,
    workingFilterContext,
  ]);

  const {
    data: childProgressData,
    refetch: refetchChildProgress,
  } = useQuery(childIssueProgressOptions(wsId));
  const childProgressMap = childProgressData ?? EMPTY_CHILD_PROGRESS;
  const resolveTableExportLookups = useCallback(
    async (needs: { projects: boolean; childProgress: boolean }) => {
      const [projectResult, progressResult] = await Promise.all([
        needs.projects ? refetchProjects() : Promise.resolve(null),
        needs.childProgress
          ? refetchChildProgress()
          : Promise.resolve(null),
      ]);
      if (projectResult?.error) throw projectResult.error;
      if (progressResult?.error) throw progressResult.error;
      if (needs.projects && !projectResult?.data) {
        throw new Error("Failed to load project data for export");
      }
      if (needs.childProgress && !progressResult?.data) {
        throw new Error("Failed to load child progress for export");
      }
      const resolvedProjects = projectResult?.data ?? projects;
      return {
        projectMap: new Map(
          resolvedProjects.map((project) => [project.id, project]),
        ),
        childProgressMap: progressResult?.data ?? childProgressMap,
      };
    },
    [
      childProgressMap,
      projects,
      refetchChildProgress,
      refetchProjects,
    ],
  );

  const catalog = useIssueStatuses(wsId);
  // Columns follow the project's workflow, or Default outside a project.
  // (MUL-7420)
  const statusNegated = negatedFilters.includes("status");
  const columnStatus = useMemo(
    () => statusColumnFilter(statusFilters, statusNegated, advancedFilter, hiddenStatusKeys),
    [advancedFilter, hiddenStatusKeys, statusFilters, statusNegated],
  );
  const { workflow: projectWorkflow } = useColumnWorkflow(
    wsId,
    projectId,
    columnStatus.statuses.length > 0 && !columnStatus.negated,
  );
  const { workflow: scopeWorkflow } = useColumnWorkflow(wsId, projectId, false);

  const visibleStatuses = useMemo<IssueStatus[]>(() => {
    // An explicit exact-key filter wins over hidden column preferences.
    return workflowColumns(
      visibleStatusKeys(
        columnStatus.statuses,
        columnStatus.hiddenStatuses,
        catalog,
        columnStatus.negated,
      ),
      projectWorkflow,
    );
  }, [columnStatus, catalog, projectWorkflow]);

  // The columns Display can show or hide: this surface's workflow steps, or
  // the whole catalog without a workflow. A status filter does not change
  // them, since it overrides hidden columns rather than replacing them.
  const columnStatuses = useMemo<IssueStatus[]>(
    () => workflowColumns(statusColumnKeys(catalog), scopeWorkflow),
    [catalog, scopeWorkflow],
  );

  const activeFilters = useMemo(
    () => ({
      priorityFilters,
      assigneeFilters,
      includeNoAssignee,
      agentRunningFilter,
      runningIssueIds: workingIssueIDs,
      agentIdleFilter,
      activeIssueIds: activeIssueIDs,
      unreadFilter,
      unreadIssueIds: unreadIssueIDs,
      creatorFilters,
      projectFilters,
      includeNoProject,
      projectStatusFilters,
      projectStatusById,
      labelFilters,
      relationFilters,
      relationContext,
      dueDateFilters,
      advancedFilter,
      today,
      negatedFilters,
      propertyFilters,
      showSubIssues,
    }),
    [
      advancedFilter,
      assigneeFilters,
      agentRunningFilter,
      creatorFilters,
      agentIdleFilter,
      activeIssueIDs,
      dueDateFilters,
      includeNoAssignee,
      includeNoProject,
      labelFilters,
      negatedFilters,
      propertyFilters,
      priorityFilters,
      projectFilters,
      projectStatusById,
      projectStatusFilters,
      relationContext,
      relationFilters,
      showSubIssues,
      today,
      unreadFilter,
      unreadIssueIDs,
      workingIssueIDs,
    ],
  );

  const isLoading =
    statusDependency.pending ||
    projectCatalogDependency.pending ||
    relationDependency.pending ||
    (serverGroupBranches.enabled
      ? serverGroupBranches.isLoading
      : usesGantt
        ? ganttIssuesQuery.isLoading
        : serverStatusBranches.enabled
          ? serverStatusBranches.isLoading
          : false);

  // Placeholder-backed revalidation of the ACTIVE query only. First loads are
  // isLoading (no previous data to place-hold); gantt has no placeholder
  // phase (its key carries no sort/filter).
  const isRefreshing = serverGroupBranches.enabled
    ? serverGroupBranches.isRefreshing
    : serverStatusBranches.enabled
      ? serverStatusBranches.isRefreshing
      : false;

  return {
    surfaceIssues,
    projectIssues: surfaceIssues,
    issues,
    swimlaneIssues,
    ganttWorkingScopeIssues,
    filteredGanttIssues,
    ganttIssues,
    visibleStatuses,
    columnStatuses,
    statusPagination: serverStatusBranches.pagination,
    activeFilters,
    childProgressMap,
    projectMap,
    resolveTableExportLookups,
    isLoading,
    isRefreshing,
    // isEmpty asserts "this window has no issues". The board/list/swimlane
    // data IS the full window, so an empty result proves it. The gantt query
    // is a scheduled-only PROJECTION — an empty subset cannot prove the
    // window is empty, so never claim it (same "uncertain → don't assert"
    // rule as surface membership). GanttView renders its own accurate
    // "no scheduled issues" empty state instead of the generic create-issue
    // one. Table owns its own branch-level loading, empty and retry states,
    // so this shared legacy surface projection never asserts Table empty.
    // DAG owns its states against the complete graph the same way.
    isEmpty:
      !isLoading &&
      !statusDependency.error &&
      !projectCatalogDependency.error &&
      !relationDependency.error &&
      !usesGantt &&
      !usesTable &&
      !usesDag &&
      (serverStatusBranches.enabled
        ? serverStatusBranches.isTotalKnown &&
          serverStatusBranches.total === 0
        : serverGroupBranches.enabled &&
          !serverGroupBranches.isError &&
          serverGroupBranches.total === 0),
    projectCatalogDependency,
    relationDependency,
  };
}
