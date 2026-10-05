"use client";
import { lazy, Suspense, useCallback, useEffect, useMemo } from "react";
import { hashKey } from "@tanstack/react-query";
import { AlertTriangle, FilterX, Loader2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import type { IssueGraph } from "@multica/core/api";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useViewBaseline } from "../surface/view-baseline-context";
import { useStableByContent } from "../surface/use-stable-by-content";
import { once } from "../surface/once";
import { useDagLayout, type DagLayoutRunner } from "./use-dag-layout";
import { dagLayoutInputs } from "./dag-layout-inputs";
import { selectCanvasSnapshot } from "./dag-canvas-snapshot";
import { useDagFoldState } from "./use-dag-fold-state";
import { useDagRevealRequests } from "./use-dag-reveal-requests";
import { useDagExpandAll } from "./use-dag-expand-all";
import { DagToolbar } from "./dag-toolbar";
import { DagErrorState, graphErrorPolicy } from "./dag-error-state";

const loadDagCanvas = once(() => import("./dag-canvas"));
const DagCanvas = lazy(loadDagCanvas);

export interface DagGraphQueryState {
  data: IssueGraph | undefined;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

export interface DagViewProps {
  graphQuery: DagGraphQueryState;
  hasActiveFilters: boolean;
  /** Test seam: replaces the Web Worker layout runner. */
  layoutRunnerFactory?: () => DagLayoutRunner;
}

export function DagView({
  graphQuery,
  hasActiveFilters,
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
  const baseline = useViewBaseline();
  useEffect(() => {
    void loadDagCanvas().catch(() => undefined);
  }, []);
  const graph = graphQuery.data;
  const fold = useDagFoldState(graph);
  const { projection } = fold;
  const content = useMemo(() => {
    const inputs = dagLayoutInputs(projection);
    return { inputs, key: hashKey([inputs]) };
  }, [projection]);
  const inputs = useStableByContent(content.inputs, content.key);
  const layoutKey = useMemo(() => `${direction}:${content.key}`, [direction, content.key]);
  const snapshot = useMemo(() => ({ key: layoutKey, graph, projection }), [layoutKey, graph, projection]);
  const layout = useDagLayout(
    inputs.nodes,
    inputs.edges,
    inputs.groups,
    direction,
    layoutRunnerFactory,
    snapshot,
  );
  const canvasSnapshot = useMemo(
    () => selectCanvasSnapshot(snapshot, layout.snapshot),
    [snapshot, layout.snapshot],
  );
  const expansion = useDagExpandAll(layout, layoutKey, fold.lineIds);
  const reveal = useDagRevealRequests(
    graph,
    projection,
    fold.collapsedIds,
    layout,
    layoutKey,
  );
  const onOpenIssue = useCallback(
    (issueId: string) => navigation.push(paths.issueDetail(issueId)),
    [navigation, paths],
  );
  const clearFilters = useCallback(() => {
    const state = storeApi.getState();
    if (baseline) state.resetFiltersTo(baseline.raw);
    else state.clearFilters();
  }, [baseline, storeApi]);

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

  if (
    graphQuery.isError &&
    (!graph || graphErrorPolicy(graphQuery.error).hideGraph)
  ) {
    return (
      <DagErrorState error={graphQuery.error} onRetry={graphQuery.refetch} />
    );
  }

  if (!graph || !projection) return null;

  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FilterX className="h-10 w-10 text-faint-foreground" />
        <p className="text-body">
          {hasActiveFilters
            ? tDag(($) => $.empty_title)
            : tDag(($) => $.empty_title_unfiltered)}
        </p>
        <p className="text-caption">
          {hasActiveFilters
            ? tDag(($) => $.empty_hint)
            : tDag(($) => $.empty_hint_unfiltered)}
        </p>
        {hasActiveFilters && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={clearFilters}
          >
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
      <DagToolbar
        graph={graph}
        pending={layout.pending}
        collapsedIds={fold.collapsedIds}
        expandedIds={fold.expandedIds}
        {...expansion}
      />

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
            focusRequest={reveal.focusRequest}
            onOpenIssue={onOpenIssue}
            onToggleCollapsed={fold.onToggleCollapsed}
            onRevealIssues={reveal.onRevealIssues}
            onFocusGroup={reveal.onFocusGroup}
          />
        </Suspense>
      )}
    </div>
  );
}
