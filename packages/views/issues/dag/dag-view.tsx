"use client";

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { hashKey } from "@tanstack/react-query";
import {
  AlertTriangle,
  Expand,
  FilterX,
  ListTree,
  Loader2,
  Shrink,
} from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { ApiError, type IssueGraph } from "@multica/core/api";
import {
  computeDagProjection,
  defaultDagCollapsedIds,
  pruneDagCollapsedIds,
  repsToRevealIssues,
} from "./dag-projection";
import { dagNodeSize } from "./dag-constants";
import {
  EMPTY_LAYOUT_EDGES,
  EMPTY_LAYOUT_NODES,
  useDagLayout,
  type DagLayoutRunner,
} from "./use-dag-layout";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import { useViewBaseline } from "../surface/view-baseline-context";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useNavigation } from "../../navigation";
import { useWorkspacePaths } from "@multica/core/paths";
import { useT } from "../../i18n";

// The canvas chunk owns `@xyflow/react`; it only downloads when a surface
// actually renders DAG mode.
const DagCanvas = lazy(() => import("./dag-canvas"));

export interface DagGraphQueryState {
  data: IssueGraph | undefined;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  isFetching: boolean;
  /** False only for a fresh, settled snapshot: an invalidated cache that is
   *  still refetching (or failed and was retained) must not license pruning. */
  isStale: boolean;
  refetch: () => void;
}

export interface DagViewProps {
  graphQuery: DagGraphQueryState;
  hasActiveFilters: boolean;
  /** The graph request covered the full authorized membership (no filters,
   *  no search, sub-issues included). Fold pruning stays off otherwise —
   *  combined with `!graph.hasRestrictedContext` inside the view. */
  membershipComplete: boolean;
  /** OL-44 shared node-action contract. `onEditDependencies` /
   *  `onAssignIssue` default to opening the existing issue detail until the
   *  shared relation/assign form ships; the detail page keeps one
   *  implementation of each flow. */
  onEditDependencies?: (issueId: string) => void;
  onAssignIssue?: (issueId: string) => void;
  /** Test seam: replaces the Web Worker layout runner. */
  layoutRunnerFactory?: () => DagLayoutRunner;
}

const EXPAND_ALL_CANCEL_AFTER_MS = 5000;

export function DagView({
  graphQuery,
  hasActiveFilters,
  membershipComplete,
  onEditDependencies,
  onAssignIssue,
  layoutRunnerFactory,
}: DagViewProps) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const catalog = useIssueStatuses(wsId);
  const storeApi = useViewStoreApi();
  const direction = useViewStore((s) => s.dagDirection);
  const grouping = useViewStore((s) => s.dagGrouping);
  const storedCollapsedIds = useViewStore((s) => s.dagCollapsedIds);
  const baseline = useViewBaseline();

  const graph = graphQuery.data;

  // First-paint default collapse: an uninitialized surface (null) folds every
  // project rep (project grouping) and every feature, so the initial canvas
  // is the group level. The default writes back once so later graph growth
  // keeps the user's explicit fold choices instead of re-defaulting.
  const defaultCollapsed = useMemo(
    () => (graph ? defaultDagCollapsedIds(graph, grouping) : []),
    [graph, grouping],
  );
  const collapsedIds = storedCollapsedIds ?? defaultCollapsed;
  useEffect(() => {
    if (graph && storedCollapsedIds === null) {
      storeApi.getState().setDagCollapsedIds(defaultCollapsed);
    }
  }, [defaultCollapsed, graph, storeApi, storedCollapsedIds]);

  const projection = useMemo(
    () => (graph ? computeDagProjection(graph, grouping, collapsedIds) : null),
    [graph, grouping, collapsedIds],
  );

  // Stale-fold cleanup: only a PROVABLY inert fold loses its entry, and
  // nothing is provable under a filtered/searched/narrowed or restricted
  // graph — a todo filter hiding a done child is not the child being gone.
  // Freshness is part of the proof too: an invalidated snapshot still
  // refetching (or retained after a failed refresh) predates folds the user
  // made against a newer filtered graph, so pruning waits for a settled,
  // fresh, complete read and re-evaluates when one lands.
  const pruneAllowed =
    membershipComplete &&
    !graph?.hasRestrictedContext &&
    !graphQuery.isStale &&
    !graphQuery.isFetching &&
    !graphQuery.isError;
  useEffect(() => {
    if (!graph || storedCollapsedIds === null || !pruneAllowed) return;
    const pruned = pruneDagCollapsedIds(storedCollapsedIds, graph, true);
    if (pruned.length !== storedCollapsedIds.length) {
      storeApi.getState().setDagCollapsedIds(pruned);
    }
  }, [graph, pruneAllowed, storeApi, storedCollapsedIds]);

  // Layout inputs track topologyId, not the graph object: status/title/run
  // refreshes keep the topology id and must not re-run Dagre. The ref gate
  // keeps the last inputs when the key is unchanged even though a fresh graph
  // snapshot produced a new projection object.
  const layoutKey = hashKey([graph?.topologyId, grouping, collapsedIds, direction]);
  const layoutInputRef = useRef<{
    key: string;
    nodes: { id: string; width: number; height: number }[];
    edges: { source: string; target: string }[];
  } | null>(null);
  if (projection && layoutInputRef.current?.key !== layoutKey) {
    layoutInputRef.current = {
      key: layoutKey,
      nodes: projection.nodes.map((node) => ({ id: node.id, ...dagNodeSize(node.kind) })),
      edges: projection.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
      })),
    };
  }
  const layout = useDagLayout(
    layoutInputRef.current?.nodes ?? EMPTY_LAYOUT_NODES,
    layoutInputRef.current?.edges ?? EMPTY_LAYOUT_EDGES,
    direction,
    layoutRunnerFactory,
  );

  // Expand-all cancel path: folding is restored and the stalled worker is
  // terminated; the restored fold issues a fresh layout on a new worker.
  const expandAllBackup = useRef<string[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!layout.pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [layout.pending]);
  const layoutPendingLong =
    layout.pending &&
    layout.pendingSince !== null &&
    now - layout.pendingSince > EXPAND_ALL_CANCEL_AFTER_MS;

  const [focusRequest, setFocusRequest] = useState<{
    issueIds: string[];
    nonce: number;
  } | null>(null);
  const pendingRevealRef = useRef<string[] | null>(null);

  // Reveal completes once the post-unfold layout settled: the canvas can only
  // center ids that have positions.
  useEffect(() => {
    const pending = pendingRevealRef.current;
    if (!pending || layout.pending) return;
    pendingRevealRef.current = null;
    setFocusRequest((current) => ({
      issueIds: pending,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }, [layout.pending, layout.positions]);

  const onOpenIssue = useCallback(
    (issueId: string) => {
      navigation.push(paths.issueDetail(issueId));
    },
    [navigation, paths],
  );

  const onToggleCollapsed = useCallback(
    (representativeId: string) => {
      storeApi.getState().toggleDagCollapsed(representativeId, defaultCollapsed);
    },
    [defaultCollapsed, storeApi],
  );

  const onRevealIssues = useCallback(
    (issueIds: string[]) => {
      if (!graph) return;
      const reps = repsToRevealIssues(graph, grouping, collapsedIds, issueIds);
      if (reps.length === 0) {
        // Already visible — focus immediately.
        setFocusRequest((current) => ({
          issueIds,
          nonce: (current?.nonce ?? 0) + 1,
        }));
        return;
      }
      pendingRevealRef.current = issueIds;
      const removal = new Set(reps);
      storeApi
        .getState()
        .setDagCollapsedIds(collapsedIds.filter((repId) => !removal.has(repId)));
    },
    [collapsedIds, graph, grouping, storeApi],
  );

  const expandAll = useCallback(() => {
    expandAllBackup.current = [...collapsedIds];
    storeApi.getState().setDagCollapsedIds([]);
  }, [collapsedIds, storeApi]);
  const collapseAll = useCallback(() => {
    expandAllBackup.current = null;
    storeApi.getState().setDagCollapsedIds(defaultCollapsed);
  }, [defaultCollapsed, storeApi]);
  const cancelPendingLayout = useCallback(() => {
    layout.cancel();
    if (expandAllBackup.current) {
      storeApi.getState().setDagCollapsedIds(expandAllBackup.current);
      expandAllBackup.current = null;
    }
  }, [layout, storeApi]);

  const clearFilters = useCallback(() => {
    const state = storeApi.getState();
    if (baseline) state.resetFiltersTo(baseline.raw);
    else state.clearFilters();
  }, [baseline, storeApi]);

  const isDefaultFold =
    collapsedIds.length === defaultCollapsed.length &&
    collapsedIds.every((id) => defaultCollapsed.includes(id));

  // ---------- states ----------

  // Access loss (403/404/405) and unverified dependency data (422) hide any
  // cached graph outright — the contract forbids rendering the old snapshot
  // once authorization or integrity is gone. Only transient failures keep
  // the stale snapshot (with the banner below).
  const errorStatus =
    graphQuery.error instanceof ApiError ? graphQuery.error.status : null;
  const mustHideGraph =
    graphQuery.isError &&
    (errorStatus === 403 ||
      errorStatus === 404 ||
      errorStatus === 405 ||
      errorStatus === 422);

  if (graphQuery.isPending) {
    return (
      <div
        className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground"
        role="status"
      >
        <Loader2 className="h-6 w-6 animate-spin text-faint-foreground" />
        <p className="text-body">{t(($) => $.dag.loading)}</p>
      </div>
    );
  }

  if (graphQuery.isError && (!graph || mustHideGraph)) {
    return <DagErrorState error={graphQuery.error} onRetry={graphQuery.refetch} />;
  }

  if (!graph || !projection) return null;

  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FilterX className="h-10 w-10 text-faint-foreground" />
        <p className="text-body">
          {hasActiveFilters
            ? t(($) => $.dag.empty_title)
            : t(($) => $.dag.empty_title_unfiltered)}
        </p>
        <p className="text-caption">
          {hasActiveFilters
            ? t(($) => $.dag.empty_hint)
            : t(($) => $.dag.empty_hint_unfiltered)}
        </p>
        {hasActiveFilters && (
          <Button variant="outline" size="sm" className="mt-1" onClick={clearFilters}>
            {t(($) => $.filtered_empty.clear_button)}
          </Button>
        )}
      </div>
    );
  }

  const firstLayoutPending = layout.positions === null;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Summary + fold controls bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-caption text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <ListTree className="size-3.5" />
          <span className="tabular-nums">
            {t(($) => $.dag.summary_matches, { count: graph.matchedCount })}
          </span>
          {graph.contextCount > 0 && (
            <span className="tabular-nums">
              {t(($) => $.dag.summary_context, { count: graph.contextCount })}
            </span>
          )}
          <span className="tabular-nums">
            {t(($) => $.dag.summary_edges, { count: graph.edges.length })}
          </span>
        </span>
        {graph.hasRestrictedContext && (
          <span className="inline-flex items-center gap-1 text-warning">
            <AlertTriangle className="size-3" />
            {t(($) => $.dag.restricted_context_hint)}
          </span>
        )}
        {graph.matchedCount === 0 && graph.contextCount > 0 && (
          <span>{t(($) => $.dag.context_only_hint)}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {layout.pending && (
            <span className="inline-flex items-center gap-1.5" role="status">
              <Loader2 className="size-3 animate-spin" />
              {t(($) => $.dag.layout_pending)}
              {layoutPendingLong && (
                <Button size="sm" variant="ghost" onClick={cancelPendingLayout}>
                  {t(($) => $.dag.layout_cancel)}
                </Button>
              )}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={expandAll}
            disabled={collapsedIds.length === 0}
          >
            <Expand className="size-3.5" />
            {t(($) => $.dag.expand_all)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={collapseAll}
            disabled={isDefaultFold}
          >
            <Shrink className="size-3.5" />
            {t(($) => $.dag.collapse_all)}
          </Button>
        </span>
      </div>

      {graphQuery.isError && (
        <div
          className="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-caption text-warning"
          role="alert"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {t(($) => $.dag.stale_banner, { time: graph.capturedAt })}
          </span>
          <Button size="sm" variant="ghost" onClick={graphQuery.refetch}>
            {t(($) => $.dag.error_retry)}
          </Button>
        </div>
      )}

      {firstLayoutPending ? (
        <div className="flex flex-1 min-h-0 flex-col gap-3 p-4" role="status">
          <span className="sr-only">{t(($) => $.dag.layout_pending)}</span>
          <Skeleton className="h-20 w-56 rounded-lg" />
          <div className="flex gap-8">
            <Skeleton className="h-20 w-56 rounded-lg" />
            <Skeleton className="h-20 w-56 rounded-lg" />
          </div>
          <Skeleton className="h-20 w-56 rounded-lg" />
        </div>
      ) : (
        <Suspense
          fallback={
            <div
              className="flex flex-1 min-h-0 items-center justify-center text-muted-foreground"
              role="status"
            >
              <Loader2 className="h-6 w-6 animate-spin text-faint-foreground" />
              <span className="sr-only">{t(($) => $.dag.loading)}</span>
            </div>
          }
        >
          <DagCanvas
            graph={graph}
            projection={projection}
            positions={layout.positions!}
            direction={direction}
            statusColorOf={catalog.colorOf}
            focusRequest={focusRequest}
            onOpenIssue={onOpenIssue}
            onEditDependencies={onEditDependencies ?? onOpenIssue}
            onAssignIssue={onAssignIssue ?? onOpenIssue}
            onToggleCollapsed={onToggleCollapsed}
            onRevealIssues={onRevealIssues}
          />
        </Suspense>
      )}
    </div>
  );
}

function DagErrorState({
  error,
  onRetry,
}: {
  error: Error | null;
  onRetry: () => void;
}) {
  const { t } = useT("issues");
  const status = error instanceof ApiError ? error.status : null;
  const messageKey =
    status === 404 || status === 405
      ? ("error_unavailable" as const)
      : status === 403
        ? ("error_forbidden" as const)
        : status === 422
          ? ("error_unverified" as const)
          : status === 504
            ? ("error_timeout" as const)
            : null;
  return (
    <div
      className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground"
      role="alert"
    >
      <AlertTriangle className="h-10 w-10 text-faint-foreground" />
      <p className="text-body">{t(($) => $.dag.error_title)}</p>
      <p className="text-caption">
        {messageKey
          ? t(($) => $.dag[messageKey])
          : (error?.message ?? t(($) => $.dag.error_title))}
      </p>
      {status !== 403 && status !== 404 && status !== 405 && (
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
          {t(($) => $.dag.error_retry)}
        </Button>
      )}
    </div>
  );
}
