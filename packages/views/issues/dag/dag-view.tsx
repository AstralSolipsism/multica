"use client";

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hashKey } from "@tanstack/react-query";
import { AlertTriangle, Expand, FilterX, ListTree, Loader2, Shrink } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { ApiError, type IssueGraph } from "@multica/core/api";
import {
  computeDagProjection,
  DAG_INDEPENDENT_GROUP,
  defaultDagCollapsedIds,
  pruneDagCollapsedIds,
  repsToRevealIssues,
} from "./dag-projection";
import type { DagLayoutNodeInput, DagLayoutGroupInput, DagLayoutEdgeInput } from "./dag-layout";
import { dagNodeSize } from "./dag-constants";
import {
  EMPTY_LAYOUT_EDGES,
  EMPTY_LAYOUT_GROUPS,
  EMPTY_LAYOUT_NODES,
  useDagLayout,
  type DagLayoutRunner,
} from "./use-dag-layout";
import { useViewStore, useViewStoreApi } from "@multica/core/issues/stores/view-store-context";
import { useViewBaseline } from "../surface/view-baseline-context";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useNavigation } from "../../navigation";
import { useWorkspacePaths } from "@multica/core/paths";
import { useT } from "../../i18n";

// The canvas chunk owns `@xyflow/react`; it only downloads when a surface
// actually renders DAG mode.
let canvasModule: Promise<typeof import("./dag-canvas")> | undefined;
const loadDagCanvas = () => (canvasModule ??= import("./dag-canvas").catch((error) => {
  canvasModule = undefined;
  throw error;
}));
const DagCanvas = lazy(loadDagCanvas);

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
  /** Test seam: replaces the Web Worker layout runner. */
  layoutRunnerFactory?: () => DagLayoutRunner;
}

const EXPAND_ALL_CANCEL_AFTER_MS = 5000;

export function DagView({
  graphQuery,
  hasActiveFilters,
  membershipComplete,
  layoutRunnerFactory,
}: DagViewProps) {
  const { t } = useT("issues");
  const { t: tDag } = useT("dag");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const catalog = useIssueStatuses(wsId);
  const storeApi = useViewStoreApi();
  const direction = useViewStore((s) => s.dagDirection);
  const independentExpanded = useViewStore((s) => s.dagIndependentExpanded);
  const storedCollapsedIds = useViewStore((s) => s.dagCollapsedIds);
  const baseline = useViewBaseline();

  // Download the renderer while the graph and layout engine load.
  useEffect(() => { void loadDagCanvas().catch(() => undefined); }, []);

  const graph = graphQuery.data;

  // Initialize personal task-line folds once; independent expansion has its own preference.
  const defaultCollapsed = useMemo(() => (graph ? defaultDagCollapsedIds(graph) : []), [graph]);
  const collapsedIds = storedCollapsedIds ?? defaultCollapsed;
  useEffect(() => {
    if (graph && storedCollapsedIds === null) {
      storeApi.getState().setDagCollapsedIds(defaultCollapsed);
    }
  }, [defaultCollapsed, graph, storeApi, storedCollapsedIds]);

  const projection = useMemo(
    () => (graph ? computeDagProjection(graph, collapsedIds, independentExpanded) : null),
    [graph, collapsedIds, independentExpanded],
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
  // refreshes keep the topology id and must not re-run ELK. The ref gate
  // keeps the last inputs when the key is unchanged even though a fresh graph
  // snapshot produced a new projection object.
  const layoutKey = hashKey([
    graph?.topologyId,
    collapsedIds,
    independentExpanded,
    direction,
    projection?.nodes.map((n) => [n.id, n.groupId, n.issue?.stage]),
    projection?.groups.map((g) => [g.id, g.parentId, g.collapsed]),
  ]);
  const layoutInputRef = useRef<{
    key: string;
    nodes: DagLayoutNodeInput[];
    edges: DagLayoutEdgeInput[];
    groups: DagLayoutGroupInput[];
  } | null>(null);
  if (projection && layoutInputRef.current?.key !== layoutKey) {
    layoutInputRef.current = {
      key: layoutKey,
      nodes: projection.nodes.map((node) => ({
        id: node.id,
        ...dagNodeSize(node.kind),
        parentIssueId: node.issue?.parentIssueId ?? null,
        groupId: node.groupId,
        stage: node.issue?.stage ?? null,
      })),
      groups: projection.groups.map(({ id, parentId, collapsed, independent }) => ({
        id,
        parentId,
        collapsed,
        independent,
      })),
      edges: projection.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    };
  }
  const layout = useDagLayout(
    layoutInputRef.current?.nodes ?? EMPTY_LAYOUT_NODES,
    layoutInputRef.current?.edges ?? EMPTY_LAYOUT_EDGES,
    layoutInputRef.current?.groups ?? EMPTY_LAYOUT_GROUPS,
    direction,
    layoutRunnerFactory,
    { key: layoutKey, graph, projection },
  );
  // Commit a complete canvas: a fold must never combine new endpoint IDs
  // with old routes. Fresh content can reuse matching geometry; a changed
  // server graph waits for its own layout rather than exposing removed data.
  const canvasSnapshot =
    layout.snapshot?.key === layoutKey
      ? { graph, projection }
      : layout.snapshot?.graph === graph
        ? layout.snapshot
        : null;

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
    groupId?: string;
  } | null>(null);
  const pendingRevealRef = useRef<string[] | null>(null);
  const pendingGroupRef = useRef<string | null>(null);

  // Reveal completes once the post-unfold layout settled: the canvas can only
  // center ids that have positions.
  useEffect(() => {
    const pending = pendingRevealRef.current;
    const groupId = pendingGroupRef.current;
    if ((!pending && !groupId) || layout.pending || layout.error || layout.snapshot?.key !== layoutKey) return;
    pendingGroupRef.current = null;
    pendingRevealRef.current = null;
    setFocusRequest((current) => ({
      issueIds: pending ?? [],
      groupId: groupId ?? undefined,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }, [layout.pending, layout.positions, layout.error, layout.snapshot?.key, layoutKey]);

  const onOpenIssue = useCallback(
    (issueId: string) => {
      navigation.push(paths.issueDetail(issueId));
    },
    [navigation, paths],
  );

  const onToggleCollapsed = useCallback(
    (representativeId: string) => {
      if (representativeId === DAG_INDEPENDENT_GROUP) {
        const state = storeApi.getState();
        state.setDagIndependentExpanded(!state.dagIndependentExpanded);
      } else storeApi.getState().toggleDagCollapsed(representativeId, defaultCollapsed);
    },
    [defaultCollapsed, storeApi],
  );

  const onFocusGroup = useCallback(
    (id: string) => {
      const group = projection?.groups.find((g) => g.id === id);
      if (!group) return;
      if (!group.collapsed) {
        setFocusRequest((current) => ({
          issueIds: [],
          groupId: id,
          nonce: (current?.nonce ?? 0) + 1,
        }));
        return;
      }
      pendingGroupRef.current = id;
      if (group.independent) storeApi.getState().setDagIndependentExpanded(true);
      else storeApi.getState().setDagCollapsedIds(collapsedIds.filter((item) => item !== id));
    },
    [projection, collapsedIds, storeApi],
  );

  const onRevealIssues = useCallback(
    (issueIds: string[]) => {
      if (!graph) return;
      const reps = repsToRevealIssues(graph, collapsedIds, issueIds);
      const revealIndependent =
        !independentExpanded &&
        projection?.groups.some(
          (g) => g.independent && g.memberIds.some((id) => issueIds.includes(id)),
        );
      if (revealIndependent) storeApi.getState().setDagIndependentExpanded(true);
      if (reps.length === 0 && !revealIndependent) {
        // Already visible — focus immediately.
        setFocusRequest((current) => ({
          issueIds,
          nonce: (current?.nonce ?? 0) + 1,
        }));
        return;
      }
      pendingRevealRef.current = issueIds;
      const removal = new Set(reps);
      storeApi.getState().setDagCollapsedIds(collapsedIds.filter((repId) => !removal.has(repId)));
    },
    [collapsedIds, graph, independentExpanded, projection, storeApi],
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
  const errorStatus = graphQuery.error instanceof ApiError ? graphQuery.error.status : null;
  const mustHideGraph =
    graphQuery.isError &&
    (errorStatus === 403 || errorStatus === 404 || errorStatus === 405 || errorStatus === 422);

  if (graphQuery.isPending) {
    return (
      <div
        className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground"
        role="status"
      >
        <Loader2 className="h-6 w-6 animate-spin text-faint-foreground" />
        <p className="text-body">{tDag(($) => $.loading)}</p>
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
          {hasActiveFilters ? tDag(($) => $.empty_title) : tDag(($) => $.empty_title_unfiltered)}
        </p>
        <p className="text-caption">
          {hasActiveFilters ? tDag(($) => $.empty_hint) : tDag(($) => $.empty_hint_unfiltered)}
        </p>
        {hasActiveFilters && (
          <Button variant="outline" size="sm" className="mt-1" onClick={clearFilters}>
            {t(($) => $.filtered_empty.clear_button)}
          </Button>
        )}
      </div>
    );
  }

  const firstLayoutPending = layout.positions === null || !canvasSnapshot;
  if (layout.error && firstLayoutPending) {
    return (
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
      >
        <p>{tDag(($) => $.layout_error)}</p>
        <Button variant="outline" size="sm" onClick={layout.retry}>
          {tDag(($) => $.error_retry)}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Summary + fold controls bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-caption text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <ListTree className="size-3.5" />
          <span className="tabular-nums">
            {tDag(($) => $.summary_matches, { count: graph.matchedCount })}
          </span>
          {graph.contextCount > 0 && (
            <span className="tabular-nums">
              {tDag(($) => $.summary_context, { count: graph.contextCount })}
            </span>
          )}
          <span className="tabular-nums">
            {tDag(($) => $.summary_edges, { count: graph.edges.length })}
          </span>
        </span>
        {graph.hasRestrictedContext && (
          <span className="inline-flex items-center gap-1 text-warning">
            <AlertTriangle className="size-3" />
            {tDag(($) => $.restricted_context_hint)}
          </span>
        )}
        {graph.matchedCount === 0 && graph.contextCount > 0 && (
          <span>{tDag(($) => $.context_only_hint)}</span>
        )}
        <span className="inline-flex items-center gap-3 text-micro">
          <span>{tDag(($) => $.stage_legend)}</span>
          <span>{tDag(($) => $.dependency_legend)}</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          {layout.pending && (
            <span className="inline-flex items-center gap-1.5" role="status">
              <Loader2 className="size-3 animate-spin" />
              {tDag(($) => $.layout_pending)}
              {layoutPendingLong && (
                <Button size="sm" variant="ghost" onClick={cancelPendingLayout}>
                  {tDag(($) => $.layout_cancel)}
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
            {tDag(($) => $.expand_all)}
          </Button>
          <Button size="sm" variant="ghost" onClick={collapseAll} disabled={isDefaultFold}>
            <Shrink className="size-3.5" />
            {tDag(($) => $.collapse_all)}
          </Button>
        </span>
      </div>

      {layout.error && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b px-3 py-2 text-caption text-warning"
        >
          <span>{tDag(($) => $.layout_error)}</span>
          <Button size="sm" variant="ghost" onClick={layout.retry}>
            {tDag(($) => $.error_retry)}
          </Button>
        </div>
      )}
      {graphQuery.isError && (
        <div
          className="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-caption text-warning"
          role="alert"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {tDag(($) => $.stale_banner, { time: graph.capturedAt })}
          </span>
          <Button size="sm" variant="ghost" onClick={graphQuery.refetch}>
            {tDag(($) => $.error_retry)}
          </Button>
        </div>
      )}

      {firstLayoutPending ? (
        <div className="flex flex-1 min-h-0 flex-col gap-3 p-4" role="status">
          <span className="sr-only">{tDag(($) => $.layout_pending)}</span>
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
              <span className="sr-only">{tDag(($) => $.loading)}</span>
            </div>
          }
        >
          <DagCanvas
            graph={canvasSnapshot!.graph!}
            projection={canvasSnapshot!.projection!}
            positions={layout.positions!}
            geometry={layout.result!}
            direction={layout.direction}
            statusColorOf={catalog.colorOf}
            focusRequest={focusRequest}
            onOpenIssue={onOpenIssue}
            onToggleCollapsed={onToggleCollapsed}
            onRevealIssues={onRevealIssues}
            onFocusGroup={onFocusGroup}
          />
        </Suspense>
      )}
    </div>
  );
}

function DagErrorState({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const { t } = useT("dag");
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
      <p className="text-body">{t(($) => $.error_title)}</p>
      <p className="text-caption">
        {messageKey ? t(($) => $[messageKey]) : (error?.message ?? t(($) => $.error_title))}
      </p>
      {status !== 403 && status !== 404 && status !== 405 && (
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
          {t(($) => $.error_retry)}
        </Button>
      )}
    </div>
  );
}
